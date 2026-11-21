package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaProjectTimelineContracts;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Created;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.IdempotencyConflictException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectAccessDeniedException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectNotFoundException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Revision;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.RevisionConflictException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Scene;
import com.ghatana.media.production.timeline.ProjectTimelineEngine;
import com.ghatana.media.production.timeline.ProjectTimelineEngine.AddScene;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.parallel.ResourceLock;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicInteger;
import java.sql.DriverManager;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@Testcontainers(disabledWithoutDocker = true)
@ResourceLock("MediaAwsPostgresqlRuntimeState")
class PostgresqlProjectTimelineStoreTest {
    private static final int MAX_CONTAINER_CPUS = 4;
    private static final Pattern CPU_SET_ENTRY = Pattern.compile("^([0-9]+)(?:-([0-9]+))?$");
    private static final String CONTAINER_CPU_SET = configuredContainerCpuSet();

    @Container static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(
            DockerImageName.parse("postgres:16-alpine"))
            .withCreateContainerCmdModifier(command -> command.withCpusetCpus(CONTAINER_CPU_SET));
    @Container static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices("s3")
            .withCreateContainerCmdModifier(command -> command.withCpusetCpus(CONTAINER_CPU_SET));

    private static String configuredContainerCpuSet() {
        String configured = System.getenv("GHATANA_CPUSET");
        return validatedContainerCpuSet(configured == null || configured.isBlank() ? "0-3" : configured.trim());
    }

    private static String validatedContainerCpuSet(String cpuSet) {
        int selectedCpuCount = 0;
        for (String entry : cpuSet.split(",", -1)) {
            Matcher matcher = CPU_SET_ENTRY.matcher(entry);
            if (!matcher.matches()) {
                throw new IllegalArgumentException("Invalid CPU selection in GHATANA_CPUSET: " + entry);
            }
            long first;
            long last;
            try {
                first = Long.parseLong(matcher.group(1));
                last = matcher.group(2) == null ? first : Long.parseLong(matcher.group(2));
            } catch (NumberFormatException invalidCpuId) {
                throw new IllegalArgumentException("Invalid CPU selection in GHATANA_CPUSET: " + entry,
                        invalidCpuId);
            }
            if (first > last) {
                throw new IllegalArgumentException("Invalid CPU range in GHATANA_CPUSET: " + entry);
            }
            long rangeDifference = last - first;
            if (rangeDifference >= MAX_CONTAINER_CPUS - selectedCpuCount) {
                throw new IllegalArgumentException("GHATANA_CPUSET may select at most " + MAX_CONTAINER_CPUS
                        + " CPUs for PostgreSQL and LocalStack containers");
            }
            selectedCpuCount += (int) (rangeDifference + 1);
        }
        return cpuSet;
    }

    @Test
    void directStoreMatchesOwnerWireSchemaRequestIdGrammar() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-request-id", "principal-request-id");
            for (String invalid : List.of("", ":bad", "a".repeat(129), "å", "_first")) {
                assertThatThrownBy(() -> fixture.store.create(actor, "workspace", "Title", invalid,
                        "project-" + invalid.hashCode(), "revision"))
                        .isInstanceOf(IllegalArgumentException.class);
            }
            String maximum = "A" + "._~-".repeat(31) + "._~";
            assertThat(maximum).hasSize(128);
            assertThat(fixture.store.create(actor, "workspace", "Title", maximum,
                    "project-valid", "revision-valid").createdNow()).isTrue();
            assertThat(fixture.store.create(actor, "workspace", "Title", "a:b.c_d~e-f",
                    "project-colon", "revision-colon").createdNow()).isTrue();
        }
    }

    @Test
    void directStoreRejectsInvalidTitleBeforePersistingProjectOrCreateReceipt() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-title-boundary", "principal-title-boundary");
            for (String invalid : List.of("", "  ", "😀".repeat(201))) {
                assertThatThrownBy(() -> fixture.store.create(actor, "workspace-title", invalid,
                        "request-title-boundary", "project-invalid-title", "revision-invalid-title"))
                        .isInstanceOf(IllegalArgumentException.class);
                assertThatThrownBy(() -> fixture.store.project(actor, "project-invalid-title"))
                        .isInstanceOf(ProjectNotFoundException.class);
            }

            var created = fixture.store.create(actor, "workspace-title", "Valid title", "request-title-boundary",
                    "project-valid-title", "revision-valid-title");
            assertThat(created.createdNow()).isTrue();
            assertThat(created.project().title()).isEqualTo("Valid title");
        }
    }

    @Test
    void directStoreEnforcesOpaqueProjectAndRevisionIdsBeforePersistenceEffects() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-opaque-id", "principal-opaque-id");
            for (String invalid : List.of(" padded", "slash/id", "_leading", "x".repeat(129))) {
                assertThatThrownBy(() -> fixture.store.create(actor, "workspace-opaque", "Title",
                        "request-opaque", invalid, "revision-opaque"))
                        .isInstanceOf(IllegalArgumentException.class);
                assertThatThrownBy(() -> fixture.store.create(actor, "workspace-opaque", "Title",
                        "request-opaque", "project-opaque", invalid))
                        .isInstanceOf(IllegalArgumentException.class);
            }

            var created = fixture.store.create(actor, "workspace-opaque", "Title", "request-opaque",
                    "project-opaque", "revision-opaque-1");
            assertThat(created.createdNow()).isTrue();
            for (String invalid : List.of(" padded", "slash/id", "_leading", "x".repeat(129))) {
                assertThatThrownBy(() -> fixture.store.project(actor, invalid))
                        .isInstanceOf(IllegalArgumentException.class);
                assertThatThrownBy(() -> fixture.store.revision(actor, "project-opaque", invalid))
                        .isInstanceOf(IllegalArgumentException.class);
                assertThatThrownBy(() -> fixture.store.commit(actor, "project-opaque", invalid,
                        "revision-opaque-2", List.of()))
                        .isInstanceOf(IllegalArgumentException.class);
                assertThatThrownBy(() -> fixture.store.commit(actor, "project-opaque", "revision-opaque-1",
                        invalid, List.of()))
                        .isInstanceOf(IllegalArgumentException.class);
            }
            assertThat(fixture.store.project(actor, "project-opaque").headRevisionId())
                    .isEqualTo("revision-opaque-1");
        }
    }

    @Test
    void restartReadbackPreservesCreateReceiptAndImmutableTimelineSnapshots() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-a", "principal-a");
            var created = fixture.store.create(actor, "workspace-a", "My project", "request-1",
                    "project-1", "revision-1");
            // Hold the isolated test runtime while replacing only the store adapter instance.
            MediaAwsPostgresqlRuntimeState heldState = MediaAwsPostgresqlRuntimeState.acquire();
            try {
                fixture.store.close();
                try (PostgresqlProjectTimelineStore restarted = new PostgresqlProjectTimelineStore()) {
                    assertThat(restarted.project(actor, "project-1")).isEqualTo(created.project());
                    assertThat(restarted.revision(actor, "project-1", "revision-1")).isEqualTo(created.initialRevision());
                    var replay = restarted.create(actor, "workspace-a", "My project", "request-1",
                            "ignored-project", "ignored-revision");
                    assertThat(replay.createdNow()).isFalse();
                    assertThat(replay.project()).isEqualTo(created.project());
                    assertThat(replay.initialRevision()).isEqualTo(created.initialRevision());
                }
            } finally { heldState.release(); }
        }
    }

    @Test
    void timelineCommandReceiptReplaysAfterRestartAndRejectsChangedPayload() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-command-replay", "principal-command-replay");
            AtomicInteger ids = new AtomicInteger();
            ProjectTimelineEngine engine = new ProjectTimelineEngine(fixture.store,
                    () -> "command-replay-id-" + ids.incrementAndGet());
            Created created = engine.createProject(actor, "workspace-command-replay", "Cut", "project-command-replay");
            Revision timeline = engine.createTimeline(actor, created.project().projectId(),
                    created.initialRevision().revisionId(), "timeline-replay", "timeline-create-replay");
            List<ProjectTimelineEngine.Edit> edit = List.of(new AddScene(new Scene("scene-replay", 0)));
            Revision edited = engine.edit(actor, created.project().projectId(), "timeline-replay",
                    timeline.revisionId(), edit, "timeline-edit-replay");

            MediaAwsPostgresqlRuntimeState heldState = MediaAwsPostgresqlRuntimeState.acquire();
            try {
                fixture.store.close();
                try (PostgresqlProjectTimelineStore restarted = new PostgresqlProjectTimelineStore()) {
                    ProjectTimelineEngine restartedEngine = new ProjectTimelineEngine(restarted,
                            () -> "must-not-be-used-for-replay");
                    assertThat(restartedEngine.createTimeline(actor, created.project().projectId(),
                            created.initialRevision().revisionId(), "timeline-replay", "timeline-create-replay"))
                            .isEqualTo(timeline);
                    assertThat(restartedEngine.edit(actor, created.project().projectId(), "timeline-replay",
                            timeline.revisionId(), edit, "timeline-edit-replay")).isEqualTo(edited);
                    assertThatThrownBy(() -> restartedEngine.edit(actor, created.project().projectId(), "timeline-replay",
                            timeline.revisionId(), List.of(new AddScene(new Scene("different-scene", 0))), "timeline-edit-replay"))
                            .isInstanceOf(MediaProjectTimelineContracts.IdempotencyConflictException.class);
                    assertThat(restarted.project(actor, created.project().projectId()).headRevisionId())
                            .isEqualTo(edited.revisionId());
                }
            } finally { heldState.release(); }
        }
    }

    @Test
    void concurrentIdenticalTimelineCommandReturnsOneCommittedReceipt() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-command-race", "principal-command-race");
            AtomicInteger ids = new AtomicInteger();
            ProjectTimelineEngine engine = new ProjectTimelineEngine(fixture.store,
                    () -> "command-race-id-" + ids.incrementAndGet());
            Created created = engine.createProject(actor, "workspace-command-race", "Cut", "project-command-race");
            Revision timeline = engine.createTimeline(actor, created.project().projectId(),
                    created.initialRevision().revisionId(), "timeline-race", "timeline-create-race");
            List<ProjectTimelineEngine.Edit> edits = List.of(new AddScene(new Scene("scene-race", 0)));
            var ready = new CountDownLatch(2);
            var start = new CountDownLatch(1);

            try (var pool = Executors.newFixedThreadPool(2)) {
                var first = pool.submit(() -> raceEdit(engine, created.project().projectId(),
                        timeline.revisionId(), edits, ready, start));
                var second = pool.submit(() -> raceEdit(engine, created.project().projectId(),
                        timeline.revisionId(), edits, ready, start));
                assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
                start.countDown();

                Revision firstReceipt = first.get(20, TimeUnit.SECONDS);
                Revision secondReceipt = second.get(20, TimeUnit.SECONDS);
                assertThat(secondReceipt).isEqualTo(firstReceipt);
                assertThat(fixture.store.project(actor, created.project().projectId()).headRevisionId())
                        .isEqualTo(firstReceipt.revisionId());
                assertThat(fixture.store.revision(actor, created.project().projectId(), firstReceipt.revisionId()))
                        .isEqualTo(firstReceipt);
            }

            try (var connection = DriverManager.getConnection(scopedJdbcUrl(fixture.schema()),
                    POSTGRES.getUsername(), POSTGRES.getPassword());
                 var query = connection.prepareStatement("""
                         SELECT count(*) FROM media_timeline_revisions
                         WHERE tenant_id=? AND project_id=? AND parent_revision_id=?
                         """)) {
                query.setString(1, actor.tenantId());
                query.setString(2, created.project().projectId());
                query.setString(3, timeline.revisionId());
                try (var rows = query.executeQuery()) {
                    assertThat(rows.next()).isTrue();
                    assertThat(rows.getInt(1)).isEqualTo(1);
                }
            }
        }
    }

    @Test
    void concurrentDistinctTimelineEditsHaveOneWinnerAndRestartReadsThatWinner() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-distinct-edit-race", "principal-distinct-edit-race");
            AtomicInteger ids = new AtomicInteger();
            ProjectTimelineEngine engine = new ProjectTimelineEngine(fixture.store,
                    () -> "distinct-edit-race-id-" + ids.incrementAndGet());
            Created created = engine.createProject(actor, "workspace-distinct-edit-race", "Cut",
                    "project-distinct-edit-race");
            Revision timeline = engine.createTimeline(actor, created.project().projectId(),
                    created.initialRevision().revisionId(), "timeline-distinct-race", "timeline-create-distinct-race");
            CountDownLatch ready = new CountDownLatch(2);
            CountDownLatch start = new CountDownLatch(1);

            EditAttempt first;
            EditAttempt second;
            try (var pool = Executors.newFixedThreadPool(2)) {
                var a = pool.submit(() -> raceDistinctEdit(engine, actor, created.project().projectId(),
                        timeline.revisionId(), "scene-race-a", "timeline-edit-race-a", ready, start));
                var b = pool.submit(() -> raceDistinctEdit(engine, actor, created.project().projectId(),
                        timeline.revisionId(), "scene-race-b", "timeline-edit-race-b", ready, start));
                assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
                start.countDown();
                first = a.get(20, TimeUnit.SECONDS);
                second = b.get(20, TimeUnit.SECONDS);
            }

            List<EditAttempt> outcomes = List.of(first, second);
            assertThat(outcomes.stream().filter(attempt -> !attempt.conflict()).toList()).hasSize(1);
            assertThat(outcomes.stream().filter(EditAttempt::conflict).toList()).hasSize(1);
            Revision winner = first.conflict() ? second.revision() : first.revision();
            assertThat(winner).isNotNull();
            assertThat(winner.parentRevisionId()).isEqualTo(timeline.revisionId());
            assertThat(winner.timelines().getFirst().graph().scenes()).hasSize(1);
            assertThat(winner.timelines().getFirst().graph().scenes().getFirst().sceneId())
                    .isIn("scene-race-a", "scene-race-b");
            assertThat(fixture.store.project(actor, created.project().projectId()).headRevisionId())
                    .isEqualTo(winner.revisionId());

            MediaAwsPostgresqlRuntimeState heldState = MediaAwsPostgresqlRuntimeState.acquire();
            try {
                fixture.store.close();
                try (PostgresqlProjectTimelineStore restarted = new PostgresqlProjectTimelineStore()) {
                    ProjectTimelineEngine restartedEngine = new ProjectTimelineEngine(restarted,
                            () -> "must-not-be-used-for-readback");
                    assertThat(restartedEngine.currentRevision(actor, created.project().projectId()))
                            .isEqualTo(winner);
                    assertThat(restarted.revision(actor, created.project().projectId(), timeline.revisionId()))
                            .isEqualTo(timeline);
                }
            } finally { heldState.release(); }
        }
    }

    @Test
    void createReplayIsIdempotentAndChangedPayloadConflicts() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-a", "principal-a");
            var first = fixture.store.create(actor, "workspace-a", "Title", "request-1",
                    "project-1", "revision-1");
            var replay = fixture.store.create(actor, "workspace-a", "Title", "request-1",
                    "project-ignored", "revision-ignored");
            assertThat(replay.createdNow()).isFalse();
            assertThat(replay.project()).isEqualTo(first.project());
            fixture.store.commit(actor, "project-1", "revision-1", "revision-2", List.of());
            var afterCommitReplay = fixture.store.create(actor, "workspace-a", "Title", "request-1",
                    "project-replacement", "revision-replacement");
            assertThat(afterCommitReplay).isEqualTo(replay);
            assertThat(fixture.store.project(actor, "project-1").headRevisionId()).isEqualTo("revision-2");
            assertThatThrownBy(() -> fixture.store.create(actor, "workspace-a", "Changed", "request-1",
                    "project-2", "revision-2"))
                    .isInstanceOf(MediaProjectTimelineContracts.IdempotencyConflictException.class);
        }
    }

    @Test
    void concurrentCreateWithSameKeyAndDifferentTitleConflictsWithoutOrphanProject() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-create-race", "principal-create-race");
            String requestId = "request-create-race";
            var ready = new CountDownLatch(2);
            var start = new CountDownLatch(1);
            try (var pool = Executors.newFixedThreadPool(2)) {
                var first = pool.submit(() -> raceCreate(fixture.store, actor, "First title", "project-race-first",
                        "revision-race-first", requestId, ready, start));
                var second = pool.submit(() -> raceCreate(fixture.store, actor, "Different title",
                        "project-race-second", "revision-race-second", requestId, ready, start));
                assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
                start.countDown();

                List<CreateAttempt> outcomes = List.of(first.get(20, TimeUnit.SECONDS), second.get(20, TimeUnit.SECONDS));
                assertThat(outcomes.stream().filter(CreateAttempt::conflict)).hasSize(1);
                assertThat(outcomes.stream().filter(attempt -> attempt.created() != null)).hasSize(1);

                Created winner = outcomes.stream().map(CreateAttempt::created).filter(java.util.Objects::nonNull)
                        .findFirst().orElseThrow();
                assertThat(winner.createdNow()).isTrue();
                assertThat(fixture.store.project(actor, winner.project().projectId())).isEqualTo(winner.project());
                assertThat(fixture.store.revision(actor, winner.project().projectId(),
                        winner.initialRevision().revisionId())).isEqualTo(winner.initialRevision());
                assertThat(winner.project().headRevisionId()).isEqualTo(winner.initialRevision().revisionId());

                String loserProjectId = winner.project().projectId().equals("project-race-first")
                        ? "project-race-second" : "project-race-first";
                String loserRevisionId = winner.initialRevision().revisionId().equals("revision-race-first")
                        ? "revision-race-second" : "revision-race-first";
                assertThatThrownBy(() -> fixture.store.project(actor, loserProjectId))
                        .isInstanceOf(ProjectNotFoundException.class);
                assertThatThrownBy(() -> fixture.store.revision(actor, loserProjectId, loserRevisionId))
                        .isInstanceOf(ProjectNotFoundException.class);
                String conflictingTitle = winner.project().title().equals("First title")
                        ? "Different title" : "First title";
                assertThatThrownBy(() -> fixture.store.create(actor, "workspace-a", conflictingTitle, requestId,
                        "project-race-retry", "revision-race-retry"))
                        .isInstanceOf(IdempotencyConflictException.class);
            }
        }
    }

    @Test
    void closedStoreAndBlankProjectIdentityFailBeforePersistenceAccess() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-a", "principal-a");
            assertThatThrownBy(() -> fixture.store.project(actor, " "))
                    .isInstanceOf(IllegalArgumentException.class);
            fixture.store.close();
            assertThatThrownBy(() -> fixture.store.project(actor, "project-1"))
                    .isInstanceOf(IllegalStateException.class).hasMessage("project timeline store is closed");
        }
    }

    @Test
    void projectAndRevisionReadsAreTenantScoped() throws Exception {
        try (Fixture fixture = openFixture()) {
            fixture.store.create(new Actor("tenant-a", "principal-a"), "workspace-a", "Title", "request-1",
                    "project-1", "revision-1");
            Actor otherTenant = new Actor("tenant-b", "principal-a");
            assertThatThrownBy(() -> fixture.store.project(otherTenant, "project-1"))
                    .isInstanceOf(ProjectNotFoundException.class);
            assertThatThrownBy(() -> fixture.store.revision(otherTenant, "project-1", "revision-1"))
                    .isInstanceOf(ProjectNotFoundException.class);
            Actor otherPrincipal = new Actor("tenant-a", "principal-b");
            assertThatThrownBy(() -> fixture.store.project(otherPrincipal, "project-1"))
                    .isInstanceOf(ProjectAccessDeniedException.class);
            assertThatThrownBy(() -> fixture.store.revision(otherPrincipal, "project-1", "revision-1"))
                    .isInstanceOf(ProjectAccessDeniedException.class);
        }
    }

    @Test
    void staleCasHasNoMutation() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-a", "principal-a");
            fixture.store.create(actor, "workspace-a", "Title", "request-1",
                    "project-1", "revision-1");
            List<MediaProjectTimelineContracts.TimelineSnapshot> graph = List.of();
            fixture.store.commit(actor, "project-1", "revision-1", "revision-2", graph);
            assertThatThrownBy(() -> fixture.store.commit(actor, "project-1", "revision-1", "revision-3", graph))
                    .isInstanceOf(RevisionConflictException.class);
            assertThat(fixture.store.project(actor, "project-1").headRevisionId()).isEqualTo("revision-2");
            assertThatThrownBy(() -> fixture.store.revision(actor, "project-1", "revision-3"))
                    .isInstanceOf(ProjectNotFoundException.class);
        }
    }

    @Test
    void failedRevisionInsertRollsBackHeadCas() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-atomic-commit", "principal-atomic-commit");
            fixture.store.create(actor, "workspace-atomic", "Title", "request-atomic",
                    "project-atomic", "revision-atomic-1");
            fixture.store.commit(actor, "project-atomic", "revision-atomic-1", "revision-atomic-2",
                    List.of());
            try (var connection = DriverManager.getConnection(scopedJdbcUrl(fixture.schema()),
                    POSTGRES.getUsername(), POSTGRES.getPassword());
                 var statement = connection.createStatement()) {
                statement.execute("""
                        CREATE FUNCTION media_test_reject_timeline_revision() RETURNS trigger AS $$
                        BEGIN
                            IF NEW.revision_id = 'revision-atomic-rejected' THEN
                                RAISE EXCEPTION 'injected revision insert failure' USING ERRCODE = '23514';
                            END IF;
                            RETURN NEW;
                        END;
                        $$ LANGUAGE plpgsql
                        """);
                statement.execute("""
                        CREATE TRIGGER media_test_reject_timeline_revision
                        BEFORE INSERT ON media_timeline_revisions
                        FOR EACH ROW EXECUTE FUNCTION media_test_reject_timeline_revision()
                        """);
            }

            // Fail after the head UPDATE, at the revision insert, without choosing any graph semantics.
            assertThatThrownBy(() -> fixture.store.commit(actor, "project-atomic", "revision-atomic-2",
                    "revision-atomic-rejected", List.of()))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessage("project revision commit failed");

            assertThat(fixture.store.project(actor, "project-atomic").headRevisionId())
                    .isEqualTo("revision-atomic-2");
            assertThat(fixture.store.revision(actor, "project-atomic", "revision-atomic-2").parentRevisionId())
                    .isEqualTo("revision-atomic-1");
            assertThatThrownBy(() -> fixture.store.revision(actor, "project-atomic", "revision-atomic-rejected"))
                    .isInstanceOf(ProjectNotFoundException.class);
        }
    }

    @Test
    void concurrentCasHasExactlyOneWinner() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor actor = new Actor("tenant-a", "principal-a");
            fixture.store.create(actor, "workspace-a", "Title", "request-1",
                    "project-1", "revision-1");
            var ready = new CountDownLatch(2);
            var start = new CountDownLatch(1);
            try (var pool = Executors.newFixedThreadPool(2)) {
                var a = pool.submit(() -> raceCommit(fixture.store, actor, "revision-2", ready, start));
                var b = pool.submit(() -> raceCommit(fixture.store, actor, "revision-3", ready, start));
                assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
                start.countDown();
                List<Boolean> outcomes = List.of(a.get(20, TimeUnit.SECONDS), b.get(20, TimeUnit.SECONDS));
                assertThat(outcomes).containsExactlyInAnyOrder(true, false);
            }
            String head = fixture.store.project(actor, "project-1").headRevisionId();
            assertThat(head).isIn("revision-2", "revision-3");
            assertThat(fixture.store.revision(actor, "project-1", head).parentRevisionId()).isEqualTo("revision-1");
        }
    }

    /** Test-only V030 integration with a fixture Actor; this is not Shared sign-in or production runtime admission. */
    @Test
    void engineReplayEditStaleCasAndRestartReadbackUseDurableStore() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor fixtureActor = new Actor("tenant-j01-fixture", "creator-j01-fixture");
            AtomicInteger ids = new AtomicInteger();
            ProjectTimelineEngine engine = new ProjectTimelineEngine(fixture.store,
                    () -> "j01-engine-id-" + ids.incrementAndGet());

            var created = engine.createProject(fixtureActor, "workspace-j01-fixture", "J-01 test project",
                    "j01-create-request-1");
            var replay = engine.createProject(fixtureActor, "workspace-j01-fixture", "J-01 test project",
                    "j01-create-request-1");
            assertThat(created.createdNow()).isTrue();
            assertThat(replay.createdNow()).isFalse();
            assertThat(replay.project()).isEqualTo(created.project());
            assertThat(replay.initialRevision()).isEqualTo(created.initialRevision());
            assertThat(created.initialRevision().timelines()).isEmpty();

            String projectId = created.project().projectId();
            String initialRevisionId = created.initialRevision().revisionId();
            var timelineCreated = engine.createTimeline(fixtureActor, projectId, initialRevisionId, "timeline-j01");
            assertThat(timelineCreated.timelines()).hasSize(1);
            assertThat(timelineCreated.timelines().getFirst().graph().scenes()).isEmpty();
            var child = engine.edit(fixtureActor, projectId, "timeline-j01", timelineCreated.revisionId(),
                    List.of(new AddScene(new Scene("scene-j01-authored", 0))));
            assertThat(child.parentRevisionId()).isEqualTo(timelineCreated.revisionId());
            assertThat(child.timelines().getFirst().graph().scenes()).containsExactly(new Scene("scene-j01-authored", 0));
            assertThat(engine.project(fixtureActor, projectId).headRevisionId()).isEqualTo(child.revisionId());
            assertThat(fixture.store.revision(fixtureActor, projectId, initialRevisionId).timelines()).isEmpty();

            MediaAwsPostgresqlRuntimeState heldState = MediaAwsPostgresqlRuntimeState.acquire();
            try {
                fixture.store.close();
                try (PostgresqlProjectTimelineStore restartedStore = new PostgresqlProjectTimelineStore()) {
                    AtomicInteger restartIds = new AtomicInteger();
                    ProjectTimelineEngine restartedEngine = new ProjectTimelineEngine(restartedStore,
                            () -> "j01-restarted-id-" + restartIds.incrementAndGet());

                    assertThat(restartedEngine.project(fixtureActor, projectId).headRevisionId())
                            .isEqualTo(child.revisionId());
                    assertThat(restartedStore.revision(fixtureActor, projectId, child.revisionId()))
                            .isEqualTo(child);
                    assertThat(restartedStore.commit(fixtureActor, projectId, timelineCreated.revisionId(),
                            child.revisionId(), child.timelines())).isEqualTo(child);
                    assertThat(restartedEngine.project(fixtureActor, projectId).headRevisionId())
                            .isEqualTo(child.revisionId());
                    assertThatThrownBy(() -> restartedStore.commit(fixtureActor, projectId,
                            timelineCreated.revisionId(), child.revisionId(), List.of()))
                            .isInstanceOf(IllegalStateException.class)
                            .hasMessage("revision identity was replayed with a different payload");
                    assertThat(restartedStore.revision(fixtureActor, projectId, initialRevisionId).timelines()).isEmpty();

                    var restartReplay = restartedEngine.createProject(fixtureActor, "workspace-j01-fixture",
                            "J-01 test project", "j01-create-request-1");
                    assertThat(restartReplay.createdNow()).isFalse();
                    assertThat(restartReplay.project()).isEqualTo(created.project());
                    assertThat(restartReplay.initialRevision()).isEqualTo(created.initialRevision());

                    assertThatThrownBy(() -> restartedEngine.edit(fixtureActor, projectId, "timeline-j01", initialRevisionId,
                            List.of(new AddScene(new Scene("scene-j01-stale", 1)))))
                            .isInstanceOf(RevisionConflictException.class);
                    assertThat(restartedEngine.project(fixtureActor, projectId).headRevisionId())
                            .isEqualTo(child.revisionId());
                    assertThat(restartedStore.revision(fixtureActor, projectId, child.revisionId()).timelines()
                            .getFirst().graph().scenes()).containsExactly(new Scene("scene-j01-authored", 0));

                    assertThatThrownBy(() -> restartedStore.commit(fixtureActor, projectId, initialRevisionId,
                            "j01-stale-store-revision", created.initialRevision().timelines()))
                            .isInstanceOf(RevisionConflictException.class);
                    assertThat(restartedEngine.project(fixtureActor, projectId).headRevisionId())
                            .isEqualTo(child.revisionId());
                    assertThatThrownBy(() -> restartedStore.revision(fixtureActor, projectId,
                            "j01-stale-store-revision")).isInstanceOf(ProjectNotFoundException.class);
                }
            } finally {
                heldState.release();
            }
        }
    }

    /** Durable J-01 authorization boundary; actors are fixtures, not Shared sign-in evidence. */
    @Test
    void engineDeniesWrongTenantAndPrincipalWithoutChangingDurableProject() throws Exception {
        try (Fixture fixture = openFixture()) {
            Actor creator = new Actor("tenant-j01-durable", "creator-j01-durable");
            ProjectTimelineEngine engine = new ProjectTimelineEngine(fixture.store,
                    () -> "j01-durable-id");
            var created = engine.createProject(creator, "workspace-j01-durable", "J-01 durable project",
                    "j01-durable-create-1");
            String projectId = created.project().projectId();
            String initialRevisionId = created.initialRevision().revisionId();

            assertThatThrownBy(() -> engine.project(new Actor("tenant-j01-other", creator.principalId()), projectId))
                    .isInstanceOf(ProjectNotFoundException.class);
            assertThatThrownBy(() -> engine.project(new Actor(creator.tenantId(), "principal-j01-other"), projectId))
                    .isInstanceOf(ProjectAccessDeniedException.class);

            var observed = engine.project(creator, projectId);
            assertThat(observed.headRevisionId()).isEqualTo(initialRevisionId);
            assertThat(created.initialRevision().timelines()).isEmpty();
            assertThat(fixture.store.revision(creator, projectId, initialRevisionId).timelines()).isEmpty();
        }
    }

    private static boolean raceCommit(PostgresqlProjectTimelineStore store, Actor actor, String revision,
                                      CountDownLatch ready, CountDownLatch start) throws Exception {
        ready.countDown();
        if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("start latch timed out");
        try { store.commit(actor, "project-1", "revision-1", revision, List.of()); return true; }
        catch (RevisionConflictException expected) { return false; }
    }

    private static Revision raceEdit(ProjectTimelineEngine engine, String projectId, String expectedHead,
                                     List<ProjectTimelineEngine.Edit> edits, CountDownLatch ready,
                                     CountDownLatch start) throws Exception {
        ready.countDown();
        if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("start latch timed out");
        return engine.edit(new Actor("tenant-command-race", "principal-command-race"), projectId,
                "timeline-race", expectedHead, edits, "timeline-edit-race");
    }

    private static EditAttempt raceDistinctEdit(ProjectTimelineEngine engine, Actor actor, String projectId,
                                                String expectedHead, String sceneId, String requestId,
                                                CountDownLatch ready, CountDownLatch start) throws Exception {
        ready.countDown();
        if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("start latch timed out");
        try {
            Revision revision = engine.edit(actor, projectId, "timeline-distinct-race", expectedHead,
                    List.of(new AddScene(new Scene(sceneId, 0))), requestId);
            return new EditAttempt(revision, false);
        } catch (RevisionConflictException expected) {
            return new EditAttempt(null, true);
        }
    }

    private record EditAttempt(Revision revision, boolean conflict) { }

    private static CreateAttempt raceCreate(PostgresqlProjectTimelineStore store, Actor actor, String title,
                                            String projectId, String revisionId, String requestId,
                                            CountDownLatch ready, CountDownLatch start) throws Exception {
        ready.countDown();
        if (!start.await(10, TimeUnit.SECONDS)) throw new IllegalStateException("start latch timed out");
        try {
            return new CreateAttempt(store.create(actor, "workspace-a", title, requestId,
                    projectId, revisionId), false);
        } catch (IdempotencyConflictException expected) {
            return new CreateAttempt(null, true);
        }
    }

    private record CreateAttempt(Created created, boolean conflict) { }

    private static Fixture openFixture() throws Exception {
        String bucket = "media-timeline-" + UUID.randomUUID().toString().replace("-", "");
        String schema = "media_timeline_" + UUID.randomUUID().toString().replace("-", "");
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var create = connection.createStatement()) {
            create.execute("CREATE SCHEMA " + schema);
        }
        try (S3Client client = S3Client.builder().endpointOverride(LOCALSTACK.getEndpoint())
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
        AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket, schema));
        try {
            // Test-only V030 is an isolated projection migration; allow its test schema after current V031.
            Flyway.configure().dataSource(scopedJdbcUrl(schema), POSTGRES.getUsername(), POSTGRES.getPassword())
                    .locations("classpath:db/media-runtime", MediaRuntimeMigrations.vendorLocation(MediaRuntimeMigrations.POSTGRESQL), "classpath:db/media-project-timeline")
                    .outOfOrder(true)
                    .load().migrate();
            return new Fixture(installed, new PostgresqlProjectTimelineStore(), schema);
        } catch (RuntimeException failure) {
            installed.close();
            dropSchema(schema);
            throw failure;
        }
    }

    private record Fixture(AutoCloseable installed, PostgresqlProjectTimelineStore store,
                           String schema) implements AutoCloseable {
        @Override public void close() throws Exception {
            try { store.close(); } finally {
                try { installed.close(); } finally { dropSchema(schema); }
            }
        }
    }

    private static Map<String, String> environment(String bucket, String schema) {
        Map<String, String> env = new HashMap<>();
        env.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        env.put("MEDIA_POSTGRES_JDBC_URL", scopedJdbcUrl(schema));
        env.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        env.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_TIMELINE_DB_PASSWORD");
        env.put("MEDIA_TIMELINE_DB_PASSWORD", POSTGRES.getPassword());
        env.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        env.put("MEDIA_S3_BUCKET", bucket);
        env.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        env.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpoint().toString());
        env.put("MEDIA_S3_PATH_STYLE", "true");
        env.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_TIMELINE_ACCESS");
        env.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_TIMELINE_SECRET");
        env.put("MEDIA_TIMELINE_ACCESS", LOCALSTACK.getAccessKey());
        env.put("MEDIA_TIMELINE_SECRET", LOCALSTACK.getSecretKey());
        return env;
    }

    private static String scopedJdbcUrl(String schema) {
        String base = POSTGRES.getJdbcUrl();
        return base + (base.contains("?") ? "&" : "?") + "currentSchema=" + schema;
    }

    private static void dropSchema(String schema) throws Exception {
        try (var connection = DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
             var drop = connection.createStatement()) {
            drop.execute("DROP SCHEMA IF EXISTS " + schema + " CASCADE");
        }
    }
}
