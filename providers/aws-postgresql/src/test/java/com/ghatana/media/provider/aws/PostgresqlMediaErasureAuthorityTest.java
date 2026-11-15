package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaErasureContracts.ErasureOperation;
import com.ghatana.media.runtime.MediaErasureContracts.ErasurePlan;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureReceipt;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureRefusedException;
import com.ghatana.media.runtime.MediaErasureContracts.HoldState;
import com.ghatana.media.runtime.MediaErasureContracts.LegalHold;
import com.ghatana.media.runtime.MediaErasureContracts.Phase;
import com.ghatana.media.runtime.MediaErasureContracts.ReceiptItem;
import com.ghatana.media.runtime.MediaErasureContracts.TreeNode;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Erased;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Key;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.State;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;
import org.flywaydb.core.Flyway;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import software.amazon.awssdk.auth.credentials.AwsBasicCredentials;
import software.amazon.awssdk.auth.credentials.StaticCredentialsProvider;
import software.amazon.awssdk.regions.Region;
import software.amazon.awssdk.services.s3.S3Client;
import software.amazon.awssdk.services.s3.S3Configuration;
import software.amazon.awssdk.services.s3.model.CreateBucketRequest;
import software.amazon.awssdk.services.s3.model.DeleteObjectRequest;
import software.amazon.awssdk.services.s3.model.HeadObjectRequest;
import software.amazon.awssdk.services.s3.model.NoSuchKeyException;

import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.sql.Connection;
import java.sql.DriverManager;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.time.Clock;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-26 erasure authority over PostgreSQL + LocalStack S3: the lineage tree built from the metadata shapes of every
 * DEV lane is erased atomically, objects are deleted and verified absent, replay rows answer "erased", owner holds
 * block erasure until released, and a crash between the database commit and the object deletion is resumable without
 * any window in which a read can succeed.
 */
@Testcontainers(disabledWithoutDocker = true)
class PostgresqlMediaErasureAuthorityTest {
    @Container
    static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container
    static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static final String OWNER = "test-principal-owner";
    private static final String OTHER = "test-principal-other";

    @BeforeEach
    void freshSchema() throws Exception {
        try (Connection connection = jdbc(); var statement = connection.createStatement()) {
            statement.execute("DROP SCHEMA public CASCADE");
            statement.execute("CREATE SCHEMA public");
        }
        Flyway.configure().dataSource(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword())
                .locations(MediaRuntimeMigrations.locations(MediaRuntimeMigrations.POSTGRESQL))
                .validateMigrationNaming(true).load().migrate();
    }

    /** The shape of a tree built by the real lanes: source audio -> transcript, vtt -> corrected caption -> render. */
    private record Tree(MediaArtifact source, MediaArtifact transcript, MediaArtifact webvtt, MediaArtifact corrected,
                        MediaArtifact vision, MediaArtifact grounded, MediaArtifact render, MediaArtifact unrelated) { }

    private Tree buildTree(S3PostgresqlMediaArtifactStore store, String tenant, String run) {
        MediaArtifact source = register(store, tenant, OWNER, "source-" + run, Map.of());
        MediaArtifact transcript = register(store, tenant, OWNER, "transcript-" + run, Map.of(
                "speechSchema", "media.dev.speech-output.v1", "kind", "LOCAL_STT_TRANSCRIPT",
                "source", ref(source)));
        MediaArtifact webvtt = register(store, tenant, OWNER, "webvtt-" + run, Map.of(
                "speechSchema", "media.dev.speech-output.v1", "kind", "LOCAL_STT_WEBVTT_UNREVIEWED",
                "source", ref(source)));
        MediaArtifact corrected = register(store, tenant, OWNER, "corrected-" + run, Map.of(
                "captionSchema", "media.dev.caption-version.v1", "kind", "LOCAL_CAPTION_USER_CORRECTED",
                "parent", ref(webvtt), "machineVersion", ref(webvtt), "source", ref(source)));
        MediaArtifact vision = register(store, tenant, OWNER, "vision-" + run, Map.of(
                "visionSchema", "media.dev.vision-output.v1", "kind", "LOCAL_VISION_TRACKS", "source", ref(source)));
        MediaArtifact grounded = register(store, tenant, OWNER, "grounded-" + run, Map.of(
                "groundedSchema", "media.dev.grounded-answer.v1", "source", ref(source)));
        MediaArtifact render = register(store, tenant, OWNER, "render-" + run, Map.of(
                "renderSchema", "media.dev.project-render.v1",
                "sources", List.of(ref(corrected), Map.of("clipId", "c", "artifactId", "an-artifact-outside-the-tree"))));
        MediaArtifact unrelated = register(store, tenant, OWNER, "unrelated-" + run, Map.of());
        return new Tree(source, transcript, webvtt, corrected, vision, grounded, render, unrelated);
    }

    private static Map<String, Object> ref(MediaArtifact artifact) {
        Map<String, Object> reference = new LinkedHashMap<>();
        reference.put("artifactId", artifact.artifactId());
        reference.put("artifactVersionId", artifact.version().value());
        return reference;
    }

    @Test
    void holdBlocksErasureThenReleaseAllowsAnAllCopyErasureWithAContentFreeReceipt() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-erasure-" + run;
        String bucket = "media-erasure-" + run;
        createBucket(bucket);
        Map<String, String> environment = environment(bucket);
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore();
             PostgresqlMediaErasureAuthority authority = new PostgresqlMediaErasureAuthority(
                     MediaAwsPostgresqlRuntimeState.acquire(), null, Clock.systemUTC(), false);
             PostgresqlMediaRequestLedger ledger = new PostgresqlMediaRequestLedger();
             S3Client admin = s3()) {
            Tree tree = buildTree(store, tenant, run);
            String otherTenant = "other-" + tenant;
            MediaArtifact otherTenantArtifact = register(store, otherTenant, OWNER, "other-tenant-" + run, Map.of());
            // Rows that point at the tree: a ledger row per lane, a delivery, a review case, a caption registration.
            Key sttKey = new Key(tenant, OWNER, "speech.transcribe", "req-stt");
            ledger.claim(sttKey, "a".repeat(64), "w", Duration.ofMinutes(5));
            assertThat(ledger.complete(sttKey, 1, List.of(
                    new OutputRef("transcript", tree.transcript().artifactId(), tree.transcript().version().value()),
                    new OutputRef("captions", tree.webvtt().artifactId(), tree.webvtt().version().value())))).isTrue();
            Key unrelatedKey = new Key(tenant, OWNER, "speech.transcribe", "req-unrelated");
            ledger.claim(unrelatedKey, "b".repeat(64), "w", Duration.ofMinutes(5));
            ledger.complete(unrelatedKey, 1, List.of(new OutputRef("transcript", tree.unrelated().artifactId(),
                    tree.unrelated().version().value())));
            insertDelivery(tenant, "export-1", tree.render());
            insertReviewCase(tenant, "case-1", tree.corrected());
            insertReviewCase(tenant, "case-unrelated", tree.unrelated());
            insertCaptionRegistration(tenant, "caption-req-1", tree.source());

            // Plan: the exact tree, by kind, with dependents; nothing is removed.
            ErasurePlan plan = authority.plan(tenant, OWNER, tree.source().artifactId());
            assertThat(plan.erasable()).isTrue();
            assertThat(plan.artifacts()).extracting(TreeNode::kind).containsExactlyInAnyOrder("SOURCE_ARTIFACT",
                    "TRANSCRIPT", "WEBVTT", "CAPTION_VERSION", "VISION_TRACKS", "GROUNDED_ANSWER", "RENDER");
            assertThat(plan.artifacts()).extracting(TreeNode::artifactId).doesNotContain(
                    tree.unrelated().artifactId(), otherTenantArtifact.artifactId());
            assertThat(plan.dependentRecords()).containsEntry("REQUEST_LEDGER_ROW", 1).containsEntry("DELIVERY_RECORD", 1)
                    .containsEntry("CAPTION_REGISTRATION", 1);
            assertThat(store.artifact(tenant, tree.source().artifactId())).isPresent();

            // A non-owner can neither see the tree nor hold or erase it.
            assertThatThrownBy(() -> authority.plan(tenant, OTHER, tree.source().artifactId()))
                    .isInstanceOfSatisfying(ErasureRefusedException.class, e -> assertThat(e.code()).isEqualTo("ARTIFACT_NOT_FOUND"));
            assertThatThrownBy(() -> authority.placeHold(tenant, OTHER, "hold-req-x", tree.source().artifactId(),
                    "not mine", AssuranceSource.DEV_ISSUED))
                    .isInstanceOfSatisfying(ErasureRefusedException.class, e -> assertThat(e.code()).isEqualTo("ARTIFACT_NOT_FOUND"));
            assertThatThrownBy(() -> authority.begin(tenant, OTHER, "erase-other", tree.source().artifactId(),
                    AssuranceSource.DEV_ISSUED))
                    .isInstanceOfSatisfying(ErasureRefusedException.class, e -> assertThat(e.code()).isEqualTo("ARTIFACT_NOT_FOUND"));

            // Owner hold on the SOURCE: erasure of the source is refused and nothing at all changed.
            LegalHold hold = authority.placeHold(tenant, OWNER, "hold-req-1", tree.source().artifactId(),
                    "litigation hold for test", AssuranceSource.DEV_ISSUED);
            assertThat(hold.state()).isEqualTo(HoldState.ACTIVE);
            assertThat(hold.placedBy()).isEqualTo(OWNER);
            assertThat(hold.placedAssurance()).isEqualTo(AssuranceSource.DEV_ISSUED);
            assertThat(authority.placeHold(tenant, OWNER, "hold-req-1", tree.source().artifactId(),
                    "litigation hold for test", AssuranceSource.DEV_ISSUED).replayed()).isTrue();
            assertThatThrownBy(() -> authority.placeHold(tenant, OWNER, "hold-req-1", tree.source().artifactId(),
                    "a different reason", AssuranceSource.DEV_ISSUED))
                    .isInstanceOfSatisfying(ErasureRefusedException.class, e -> assertThat(e.code()).isEqualTo("HOLD_REQUEST_REUSED"));
            assertThat(authority.plan(tenant, OWNER, tree.source().artifactId()).erasable()).isFalse();
            assertThatThrownBy(() -> authority.begin(tenant, OWNER, "erase-1", tree.source().artifactId(),
                    AssuranceSource.DEV_ISSUED))
                    .isInstanceOfSatisfying(ErasureRefusedException.class, e -> {
                        assertThat(e.code()).isEqualTo("LEGAL_HOLD_ACTIVE");
                        assertThat(e.status()).isEqualTo(409);
                    });
            // A hold on the root also covers erasing a DERIVED artifact of the held tree.
            assertThatThrownBy(() -> authority.begin(tenant, OWNER, "erase-derived", tree.render().artifactId(),
                    AssuranceSource.DEV_ISSUED)).isInstanceOfSatisfying(ErasureRefusedException.class,
                    e -> assertThat(e.code()).isEqualTo("LEGAL_HOLD_ACTIVE"));
            assertThat(store.artifact(tenant, tree.render().artifactId())).isPresent();
            assertThat(scalar("SELECT count(*) FROM media_erasure_operations WHERE tenant_id='" + tenant + "'")).isZero();
            assertThat(scalar("SELECT count(*) FROM media_artifacts WHERE legal_hold AND tenant_id='" + tenant + "'"))
                    .as("the legacy hold flag (read by expiry purge) follows the hold").isEqualTo(7);

            // Only the placing owner releases, and the release is attributed.
            assertThatThrownBy(() -> authority.releaseHold(tenant, OTHER, hold.holdId(), "nope", AssuranceSource.DEV_ISSUED))
                    .isInstanceOfSatisfying(ErasureRefusedException.class, e -> assertThat(e.code()).isEqualTo("HOLD_NOT_FOUND"));
            LegalHold released = authority.releaseHold(tenant, OWNER, hold.holdId(), "matter closed", AssuranceSource.DEV_ISSUED);
            assertThat(released.state()).isEqualTo(HoldState.RELEASED);
            assertThat(released.releasedBy()).isEqualTo(OWNER);
            assertThat(released.releaseReason()).isEqualTo("matter closed");
            assertThat(released.placedBy()).isEqualTo(OWNER);
            assertThat(scalar("SELECT count(*) FROM media_artifacts WHERE legal_hold AND tenant_id='" + tenant + "'")).isZero();

            // Erase. Phase one commits the removal of every metadata row; objects are still orphaned in S3.
            List<String> keys = objectKeys(tenant, tree.source(), tree.transcript(), tree.webvtt(), tree.corrected(),
                    tree.vision(), tree.grounded(), tree.render());
            for (String key : keys) assertThat(exists(admin, bucket, key)).isTrue();
            ErasureOperation operation = authority.begin(tenant, OWNER, "erase-1", tree.source().artifactId(),
                    AssuranceSource.DEV_ISSUED);
            assertThat(operation.phase()).isEqualTo(Phase.DB_ERASED);
            assertThat(operation.localWork().artifactIds()).hasSize(7);
            assertThat(operation.localWork().deliveries()).hasSize(1);
            for (MediaArtifact erased : List.of(tree.source(), tree.transcript(), tree.webvtt(), tree.corrected(),
                    tree.vision(), tree.grounded(), tree.render())) {
                assertThat(store.artifact(tenant, erased.artifactId())).as(erased.artifactId()).isEmpty();
                assertThat(store.copyContent(tenant, OWNER, erased.artifactId(), erased.version(),
                        new ByteArrayOutputStream(), 1 << 20)).as("no bytes after the database commit").isEmpty();
                assertThat(authority.tombstone(tenant, erased.artifactId())).isPresent();
            }
            assertThat(authority.incomplete()).extracting(ErasureOperation::erasureId).contains("erase-1");
            // The window between phase one and two is crash-safe: reads fail even though objects are not yet deleted.
            assertThat(exists(admin, bucket, keys.getFirst())).isTrue();

            // Resume (a restarted process re-runs the operation by its id): objects removed, then verified absent.
            ErasureOperation resumed = authority.begin(tenant, OWNER, "erase-1", tree.source().artifactId(),
                    AssuranceSource.DEV_ISSUED);
            assertThat(resumed.resumed()).isTrue();
            ErasureOperation afterObjects = authority.eraseObjects(resumed);
            assertThat(afterObjects.phase()).isEqualTo(Phase.OBJECTS_ERASED);
            for (String key : keys) assertThat(exists(admin, bucket, key)).as(key).isFalse();
            ErasureReceipt receipt = authority.complete(afterObjects, List.of(
                    new ReceiptItem("LOCAL_SPOOL_ENTRY", 0, List.of())));
            assertThat(receipt.phase()).isEqualTo(Phase.COMPLETED);
            assertThat(authority.eraseObjects(afterObjects).phase()).isEqualTo(Phase.COMPLETED);
            assertThat(authority.complete(afterObjects, List.of()).items()).isEqualTo(receipt.items());

            // The receipt names kinds, counts and digests - never content.
            assertThat(receipt.items()).extracting(ReceiptItem::kind).contains("TRANSCRIPT", "WEBVTT", "CAPTION_VERSION",
                    "VISION_TRACKS", "GROUNDED_ANSWER", "RENDER", "SOURCE_ARTIFACT", "S3_OBJECT", "REQUEST_LEDGER_ROW",
                    "DELIVERY_RECORD", "CAPTION_REGISTRATION", "REVIEW_RECORD", "UPLOAD_SESSION");
            ReceiptItem objectsItem = receipt.items().stream().filter(i -> i.kind().equals("S3_OBJECT")).findFirst().orElseThrow();
            assertThat(objectsItem.count()).isEqualTo(7);
            assertThat(objectsItem.digests()).contains(tree.source().sha256(), tree.render().sha256());
            ReceiptItem transcriptItem = receipt.items().stream().filter(i -> i.kind().equals("TRANSCRIPT")).findFirst().orElseThrow();
            assertThat(transcriptItem.digests()).containsExactly(tree.transcript().sha256());
            assertThat(receipt.items().stream().filter(i -> i.kind().equals("REVIEW_RECORD")).findFirst().orElseThrow().count())
                    .as("one review case and its one record").isEqualTo(2);
            assertThat(authority.receipt(tenant, OWNER, "erase-1").orElseThrow().items()).isEqualTo(receipt.items());
            assertThat(authority.receipt(tenant, OTHER, "erase-1")).isEmpty();
            assertThat(receipt.toString()).doesNotContain("source-" + run).doesNotContain("RIFF");

            // Every metadata row is gone; the ledger answers "erased" for the key, never a replay.
            for (String table : List.of("media_delivery_operations", "media_caption_registrations",
                    "media_upload_sessions")) {
                assertThat(scalar("SELECT count(*) FROM " + table + " WHERE tenant_id='" + tenant + "'"))
                        .as(table).isEqualTo(table.equals("media_upload_sessions") ? 1 : 0);
            }
            assertThat(scalar("SELECT count(*) FROM media_review_cases WHERE tenant_id='" + tenant + "'")).isEqualTo(1);
            assertThat(ledger.claim(sttKey, "a".repeat(64), "w", Duration.ofMinutes(5))).isEqualTo(new Erased());
            assertThat(ledger.claim(sttKey, "c".repeat(64), "w", Duration.ofMinutes(5)))
                    .as("even a different fingerprint is answered erased").isEqualTo(new Erased());
            assertThat(ledger.find(sttKey).orElseThrow().state()).isEqualTo(State.ERASED);
            assertThat(ledger.find(sttKey).orElseThrow().outputs()).isEmpty();
            assertThat(ledger.find(unrelatedKey).orElseThrow().state()).isEqualTo(State.COMPLETED);

            // Untouched: the unrelated artifact (and its bytes) and another tenant's artifact.
            assertThat(store.artifact(tenant, tree.unrelated().artifactId())).isPresent();
            assertThat(store.copyContent(tenant, OWNER, tree.unrelated().artifactId(), tree.unrelated().version(),
                    new ByteArrayOutputStream(), 1 << 20)).isPresent();
            assertThat(store.artifact(otherTenant, otherTenantArtifact.artifactId())).isPresent();

            // The erased ids are permanently answered as erased; a new erasure of them is refused, not repeated.
            assertThatThrownBy(() -> authority.begin(tenant, OWNER, "erase-2", tree.source().artifactId(),
                    AssuranceSource.DEV_ISSUED)).isInstanceOfSatisfying(ErasureRefusedException.class, e -> {
                assertThat(e.code()).isEqualTo("ARTIFACT_ERASED");
                assertThat(e.status()).isEqualTo(410);
            });
            assertThatThrownBy(() -> authority.begin(tenant, OWNER, "erase-1", tree.unrelated().artifactId(),
                    AssuranceSource.DEV_ISSUED)).isInstanceOfSatisfying(ErasureRefusedException.class,
                    e -> assertThat(e.code()).isEqualTo("ERASURE_ID_REUSED"));
            assertThat(authority.incomplete()).isEmpty();
            for (String key : keys) admin.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(key).build());
        } finally {
            deleteBucket(bucket);
        }
    }

    @Test
    void erasingADerivedOutputLeavesItsSourceAndRightsRevocationAloneDeletesNothing() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-erasure-derived-" + run;
        String bucket = "media-erasure-derived-" + run;
        createBucket(bucket);
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore();
             PostgresqlMediaErasureAuthority authority = new PostgresqlMediaErasureAuthority(
                     MediaAwsPostgresqlRuntimeState.acquire(), null, Clock.systemUTC(), false)) {
            Tree tree = buildTree(store, tenant, run);
            // Erase only the corrected caption: its render goes with it, its sibling outputs and its source stay.
            ErasureOperation op = authority.begin(tenant, OWNER, "erase-caption", tree.corrected().artifactId(),
                    AssuranceSource.DEV_ISSUED);
            assertThat(op.localWork().artifactIds()).containsExactlyInAnyOrder(
                    tree.corrected().artifactId(), tree.render().artifactId());
            authority.complete(authority.eraseObjects(op), List.of());
            assertThat(store.artifact(tenant, tree.source().artifactId())).isPresent();
            assertThat(store.artifact(tenant, tree.transcript().artifactId())).isPresent();
            assertThat(store.artifact(tenant, tree.webvtt().artifactId())).isPresent();
            assertThat(store.artifact(tenant, tree.corrected().artifactId())).isEmpty();
            assertThat(store.artifact(tenant, tree.render().artifactId())).isEmpty();
        } finally {
            deleteBucket(bucket);
        }
    }

    @Test
    void aProductionLikeAuthorityRefusesHoldsReleasesAndErasuresFromAnyIdentityThatIsNotOidcVerified() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-erasure-oidc-" + run;
        String bucket = "media-erasure-oidc-" + run;
        createBucket(bucket);
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment(bucket));
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore();
             PostgresqlMediaErasureAuthority authority = new PostgresqlMediaErasureAuthority(
                     MediaAwsPostgresqlRuntimeState.acquire(), null, Clock.systemUTC(), true)) {
            Tree tree = buildTree(store, tenant, run);
            for (AssuranceSource weak : List.of(AssuranceSource.DEV_ISSUED, AssuranceSource.SHARED_SECRET_JWT,
                    AssuranceSource.LOCAL_UNVERIFIED, AssuranceSource.UNSPECIFIED, AssuranceSource.BOOTSTRAP_SERVICE_KEY)) {
                assertThatThrownBy(() -> authority.placeHold(tenant, OWNER, "r-" + weak, tree.source().artifactId(),
                        "reason", weak)).isInstanceOfSatisfying(ErasureRefusedException.class,
                        e -> assertThat(e.code()).isEqualTo("IDENTITY_ASSURANCE_REQUIRED"));
                assertThatThrownBy(() -> authority.begin(tenant, OWNER, "e-" + weak, tree.source().artifactId(), weak))
                        .isInstanceOfSatisfying(ErasureRefusedException.class,
                                e -> assertThat(e.code()).isEqualTo("IDENTITY_ASSURANCE_REQUIRED"));
            }
            LegalHold hold = authority.placeHold(tenant, OWNER, "r-oidc", tree.source().artifactId(), "reason",
                    AssuranceSource.OIDC_VERIFIED);
            assertThat(hold.placedAssurance()).isEqualTo(AssuranceSource.OIDC_VERIFIED);
            assertThatThrownBy(() -> authority.releaseHold(tenant, OWNER, hold.holdId(), "r", AssuranceSource.DEV_ISSUED))
                    .isInstanceOfSatisfying(ErasureRefusedException.class,
                            e -> assertThat(e.code()).isEqualTo("IDENTITY_ASSURANCE_REQUIRED"));
            LegalHold released = authority.releaseHold(tenant, OWNER, hold.holdId(), "r", AssuranceSource.OIDC_VERIFIED);
            assertThat(released.releasedAssurance()).isEqualTo(AssuranceSource.OIDC_VERIFIED);
            assertThat(store.artifact(tenant, tree.source().artifactId())).as("nothing was erased by the refusals").isPresent();
        } finally {
            deleteBucket(bucket);
        }
    }

    @Test
    void expiryPurgeHonorsAnOwnerHoldOnAnAncestorOfAnExpiredDerivedArtifact() throws Exception {
        String run = UUID.randomUUID().toString().replace("-", "");
        String tenant = "tenant-erasure-purge-" + run;
        String bucket = "media-erasure-purge-" + run;
        createBucket(bucket);
        Map<String, String> environment = environment(bucket);
        try (AutoCloseable installed = MediaAwsPostgresqlRuntimeState.installForTesting(environment);
             S3PostgresqlMediaArtifactStore store = new S3PostgresqlMediaArtifactStore();
             PostgresqlMediaPrivacyMaintenance maintenance = new PostgresqlMediaPrivacyMaintenance(environment);
             PostgresqlMediaErasureAuthority authority = new PostgresqlMediaErasureAuthority(
                     MediaAwsPostgresqlRuntimeState.acquire(), null, Clock.systemUTC(), false)) {
            Tree tree = buildTree(store, tenant, run);
            authority.placeHold(tenant, OWNER, "purge-hold", tree.source().artifactId(), "hold", AssuranceSource.DEV_ISSUED);
            try (Connection connection = jdbc(); PreparedStatement expire = connection.prepareStatement(
                    "UPDATE media_artifacts SET expires_at=1, legal_hold=FALSE WHERE tenant_id=? AND artifact_id=?")) {
                expire.setString(1, tenant); expire.setString(2, tree.render().artifactId());
                expire.executeUpdate();
            }
            maintenance.purgeExpired(java.time.Instant.now());
            assertThat(scalar("SELECT count(*) FROM media_artifacts WHERE tenant_id='" + tenant + "' AND artifact_id='"
                    + tree.render().artifactId() + "'")).as("an expired derived artifact under a held ancestor is not purged")
                    .isEqualTo(1);
            authority.releaseHold(tenant, OWNER, authority.holds(tenant, OWNER, tree.source().artifactId()).getFirst().holdId(),
                    "released", AssuranceSource.DEV_ISSUED);
            try (Connection connection = jdbc(); PreparedStatement expire = connection.prepareStatement(
                    "UPDATE media_artifacts SET expires_at=1 WHERE tenant_id=? AND artifact_id=?")) {
                expire.setString(1, tenant); expire.setString(2, tree.render().artifactId());
                expire.executeUpdate();
            }
            maintenance.purgeExpired(java.time.Instant.now());
            assertThat(scalar("SELECT count(*) FROM media_artifacts WHERE tenant_id='" + tenant + "' AND artifact_id='"
                    + tree.render().artifactId() + "'")).as("once the hold is released the expiry purge proceeds").isZero();
        } finally {
            deleteBucket(bucket);
        }
    }

    // ------------------------------------------------------------------------------------------ fixtures

    private static MediaArtifact register(S3PostgresqlMediaArtifactStore store, String tenant, String principal,
                                          String payload, Map<String, Object> metadata) {
        byte[] bytes = wav(payload.getBytes(StandardCharsets.UTF_8));
        UploadRequest request = new UploadRequest(tenant, principal, payload + ".wav", "audio/wav", bytes.length,
                sha256(bytes), "RESTRICTED", Duration.ofDays(30), metadata);
        var upload = store.begin(request, "erasure-" + UUID.randomUUID());
        store.append(tenant, principal, upload.uploadId(), 0, bytes);
        return store.complete(tenant, principal, upload.uploadId());
    }

    private List<String> objectKeys(String tenant, MediaArtifact... artifacts) throws Exception {
        List<String> keys = new ArrayList<>();
        try (Connection connection = jdbc(); PreparedStatement select = connection.prepareStatement(
                "SELECT object_reference FROM media_artifacts WHERE tenant_id=? AND artifact_id=?")) {
            for (MediaArtifact artifact : artifacts) {
                select.setString(1, tenant); select.setString(2, artifact.artifactId());
                try (ResultSet rows = select.executeQuery()) {
                    rows.next();
                    keys.add(java.net.URI.create(rows.getString(1)).getPath().substring(1));
                }
            }
        }
        return keys;
    }

    private static boolean exists(S3Client admin, String bucket, String key) {
        try {
            admin.headObject(HeadObjectRequest.builder().bucket(bucket).key(key).build());
            return true;
        } catch (NoSuchKeyException absent) {
            return false;
        }
    }

    private void insertDelivery(String tenant, String requestId, MediaArtifact artifact) throws Exception {
        try (Connection connection = jdbc(); PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO media_delivery_operations (tenant_id,request_id,principal_id,artifact_id,version_ref,"
                        + "artifact_digest,destination_ref,request_fingerprint,status) VALUES (?,?,?,?,?,?,?,?,'QUEUED')")) {
            insert.setString(1, tenant); insert.setString(2, requestId); insert.setString(3, OWNER);
            insert.setString(4, artifact.artifactId()); insert.setString(5, artifact.version().value());
            insert.setString(6, artifact.version().value()); insert.setString(7, "local-directory");
            insert.setString(8, "d".repeat(64));
            insert.executeUpdate();
        }
    }

    private void insertReviewCase(String tenant, String caseId, MediaArtifact artifact) throws Exception {
        try (Connection connection = jdbc()) {
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO media_review_cases (tenant_id,review_case_id,exact_target_ref,subject_kind,"
                            + "subject_object_id,subject_version_id,scope_ref) VALUES (?,?,?,?,?,?,?)")) {
                insert.setString(1, tenant); insert.setString(2, caseId); insert.setString(3, "target-" + caseId);
                insert.setString(4, "ARTIFACT_VERSION"); insert.setString(5, artifact.artifactId());
                insert.setString(6, artifact.version().value()); insert.setString(7, "scope");
                insert.executeUpdate();
            }
            try (PreparedStatement insert = connection.prepareStatement(
                    "INSERT INTO media_review_records (tenant_id,review_case_id,case_revision,append_record_id,request_id,"
                            + "principal_id,request_fingerprint,operation_id,authority_version,payload_kind,"
                            + "comment_disposition,payload_text,created_at) "
                            + "VALUES (?,?,1,?,?,?,?,?,?,'COMMENT','OPEN','a review comment body',now())")) {
                insert.setString(1, tenant); insert.setString(2, caseId); insert.setString(3, "rec-" + caseId);
                insert.setString(4, "req-" + caseId); insert.setString(5, OWNER); insert.setString(6, "e".repeat(64));
                insert.setString(7, "op"); insert.setString(8, "auth");
                insert.executeUpdate();
            }
        }
    }

    private void insertCaptionRegistration(String tenant, String requestId, MediaArtifact source) throws Exception {
        try (Connection connection = jdbc(); PreparedStatement insert = connection.prepareStatement(
                "INSERT INTO media_caption_registrations (tenant_id,principal_id,request_id,request_fingerprint,"
                        + "caption_version_id,registration_receipt_id,source_artifact_id,source_artifact_version_id,"
                        + "parent_version_kind,parent_version_id,source_clock_id,ticks_per_second,source_duration_ticks,"
                        + "language_disposition,language_tag_present,purpose_present,segments_json,registered_at) "
                        + "VALUES (?,?,?,?,?,?,?,?,'MACHINE','p','clock',1000,1000,'UNKNOWN',false,false,'[]',1)")) {
            insert.setString(1, tenant); insert.setString(2, OWNER); insert.setString(3, requestId);
            insert.setString(4, "f".repeat(64)); insert.setString(5, "capv-" + UUID.randomUUID());
            insert.setString(6, "rcpt-" + UUID.randomUUID()); insert.setString(7, source.artifactId());
            insert.setString(8, source.version().value());
            insert.executeUpdate();
        }
    }

    private long scalar(String sql) throws Exception {
        try (Connection connection = jdbc(); var statement = connection.createStatement();
             ResultSet rows = statement.executeQuery(sql)) {
            rows.next();
            return rows.getLong(1);
        }
    }

    private static Connection jdbc() throws Exception {
        return DriverManager.getConnection(POSTGRES.getJdbcUrl(), POSTGRES.getUsername(), POSTGRES.getPassword());
    }

    private static Map<String, String> environment(String bucket) {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_RUNTIME_ENVIRONMENT", "test");
        environment.put("MEDIA_POSTGRES_JDBC_URL", POSTGRES.getJdbcUrl());
        environment.put("MEDIA_POSTGRES_USER", POSTGRES.getUsername());
        environment.put("MEDIA_POSTGRES_PASSWORD_REFERENCE", "secret:env:MEDIA_ERASURE_DB_PASSWORD");
        environment.put("MEDIA_ERASURE_DB_PASSWORD", POSTGRES.getPassword());
        environment.put("MEDIA_POSTGRES_DRIVER", "org.postgresql.Driver");
        environment.put("MEDIA_POSTGRES_POOL_SIZE", "4");
        environment.put("MEDIA_S3_BUCKET", bucket);
        environment.put("MEDIA_S3_PREFIX", "erasure");
        environment.put("MEDIA_S3_ENDPOINT", LOCALSTACK.getEndpointOverride(S3).toString());
        environment.put("MEDIA_S3_REGION", LOCALSTACK.getRegion());
        environment.put("MEDIA_S3_PATH_STYLE", "true");
        environment.put("MEDIA_S3_REQUEST_CHECKSUM_CALCULATION", "WHEN_REQUIRED");
        environment.put("MEDIA_S3_ACCESS_KEY_REFERENCE", "secret:env:MEDIA_ERASURE_S3_ACCESS");
        environment.put("MEDIA_S3_SECRET_KEY_REFERENCE", "secret:env:MEDIA_ERASURE_S3_SECRET");
        environment.put("MEDIA_ERASURE_S3_ACCESS", LOCALSTACK.getAccessKey());
        environment.put("MEDIA_ERASURE_S3_SECRET", LOCALSTACK.getSecretKey());
        return environment;
    }

    private static S3Client s3() {
        return S3Client.builder().endpointOverride(LOCALSTACK.getEndpointOverride(S3))
                .region(Region.of(LOCALSTACK.getRegion()))
                .credentialsProvider(StaticCredentialsProvider.create(AwsBasicCredentials.create(
                        LOCALSTACK.getAccessKey(), LOCALSTACK.getSecretKey())))
                .serviceConfiguration(S3Configuration.builder().pathStyleAccessEnabled(true).build()).build();
    }

    private static void createBucket(String bucket) {
        try (S3Client client = s3()) {
            client.createBucket(CreateBucketRequest.builder().bucket(bucket).build());
        }
    }

    private static void deleteBucket(String bucket) {
        try (S3Client client = s3()) {
            for (var object : client.listObjectsV2(b -> b.bucket(bucket)).contents()) {
                client.deleteObject(DeleteObjectRequest.builder().bucket(bucket).key(object.key()).build());
            }
            client.deleteBucket(b -> b.bucket(bucket));
        } catch (RuntimeException ignored) {
            // Disposable containers are the cleanup boundary.
        }
    }

    private static String sha256(byte[] bytes) {
        try {
            return java.util.HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }

    private static byte[] wav(byte[] payload) {
        byte[] bytes = new byte[44 + payload.length];
        bytes[0] = 'R'; bytes[1] = 'I'; bytes[2] = 'F'; bytes[3] = 'F';
        int fileSize = bytes.length - 8;
        bytes[4] = (byte) fileSize; bytes[5] = (byte) (fileSize >>> 8);
        bytes[6] = (byte) (fileSize >>> 16); bytes[7] = (byte) (fileSize >>> 24);
        bytes[8] = 'W'; bytes[9] = 'A'; bytes[10] = 'V'; bytes[11] = 'E';
        bytes[12] = 'f'; bytes[13] = 'm'; bytes[14] = 't'; bytes[15] = ' ';
        bytes[16] = 16; bytes[20] = 1; bytes[22] = 1; bytes[24] = 0x40; bytes[25] = 0x1f;
        bytes[28] = (byte) 0x80; bytes[29] = 0x3e; bytes[32] = 2; bytes[34] = 16;
        bytes[36] = 'd'; bytes[37] = 'a'; bytes[38] = 't'; bytes[39] = 'a';
        bytes[40] = (byte) payload.length; bytes[41] = (byte) (payload.length >>> 8);
        bytes[42] = (byte) (payload.length >>> 16); bytes[43] = (byte) (payload.length >>> 24);
        System.arraycopy(payload, 0, bytes, 44, payload.length);
        return bytes;
    }
}
