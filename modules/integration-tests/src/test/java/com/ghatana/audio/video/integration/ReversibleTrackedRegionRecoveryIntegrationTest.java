package com.ghatana.audio.video.integration;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import static com.ghatana.media.runtime.MediaProjectTimelineContracts.RevisionConflictException;
import static com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceVersion;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.production.timeline.ReversibleRegionEditEngine;
import com.ghatana.media.runtime.MediaTimebase;
import com.ghatana.media.runtime.MediaTimebase.ClockDomain;
import com.ghatana.media.runtime.MediaVisualContracts.NormalizedBox;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Deterministic test-only J-11 conflict and recovery scenario.
 *
 * <p>Source bindings: PDP-0 journey-catalog.yaml#journeys/@id=J-11; PDP-3
 * journey-contracts/edit-tracked-media-region-with-undo.yaml#/steps/1;
 * step-version-binding-contracts.yaml#media.step-version-binding.j-11-02.v1;
 * local-step-effect-contracts.yaml#media.local-step-effect.j-11.step-02. The authored fixture
 * exercises the existing local engine and its typed rights/store ports; it is not a tracking
 * provider, canonical project CAS, rendered output, or evidence that the journey is complete.
 */
class ReversibleTrackedRegionRecoveryIntegrationTest {
    private static final Actor EDITOR = new Actor("tenant-j11", "editor-j11");
    private static final SourceVersion EXACT_SOURCE = new SourceVersion("artifact-j11", "version-9");
    private static final String SOURCE_SHA256 = "c".repeat(64);
    private static final String PROJECT_ID = "project-j11";
    private static final String REGION_ID = "roi-17";
    private static final String PURPOSE = "local-region-edit";
    private static final MediaTimebase SOURCE_PTS_TIMEBASE = MediaTimebase.MPEG_TS_90KHZ;

    @Test
    void staleRevisionAndRevokedOrUnknownRightsHaveZeroEffectThenUndoRestoresExactState() {
        TestPorts ports = new TestPorts();
        ReversibleRegionEditEngine.TrackingEvidence evidence = exactEvidence();
        ReversibleRegionEditEngine.RegionEditPlan firstPlan = ports.prepare(evidence);
        ReversibleRegionEditEngine.RegionEditPlan stalePlan = ports.prepare(evidence);

        assertThat(firstPlan.source()).isEqualTo(EXACT_SOURCE);
        assertThat(firstPlan.sourceSha256()).isEqualTo(SOURCE_SHA256);
        assertThat(firstPlan.evidence().samples()).extracting(sample -> sample.sourcePts().ticks())
                .containsExactly(0L, 40_000L, 108_000L);
        assertThat(firstPlan.evidence().samples()).allSatisfy(sample -> {
            assertThat(sample.sourcePts().domain()).isEqualTo(ClockDomain.SOURCE);
            assertThat(sample.sourcePts().timebase()).isEqualTo(SOURCE_PTS_TIMEBASE);
        });

        ReversibleRegionEditEngine.EditRevision initial = ports.store.head(EDITOR, PROJECT_ID);
        ports.rights = ReversibleRegionEditEngine.RightsDecision.REVOKED;
        assertThatThrownBy(() -> ports.engine.apply(EDITOR, firstPlan, "r0", "j11-revoked", editedState()))
                .isInstanceOf(ReversibleRegionEditEngine.RegionRightsDeniedException.class);
        assertUnchanged(initial, ports.store.head(EDITOR, PROJECT_ID));

        ports.rights = ReversibleRegionEditEngine.RightsDecision.UNKNOWN;
        assertThatThrownBy(() -> ports.engine.apply(EDITOR, firstPlan, "r0", "j11-rights-unknown", editedState()))
                .isInstanceOf(ReversibleRegionEditEngine.RightsAuthorityUnavailableException.class);
        assertUnchanged(initial, ports.store.head(EDITOR, PROJECT_ID));

        ports.rights = ReversibleRegionEditEngine.RightsDecision.ELIGIBLE;
        ReversibleRegionEditEngine.EditRevision edit = ports.engine.apply(
                EDITOR, firstPlan, "r0", "j11-edit", editedState());
        assertThat(edit.parentRevisionId()).isEqualTo("r0");
        assertThat(edit.source()).isEqualTo(EXACT_SOURCE);
        assertThat(edit.evidence().samples()).extracting(sample -> sample.sourcePts().ticks())
                .containsExactly(0L, 40_000L, 108_000L);

        assertThatThrownBy(() -> ports.engine.apply(EDITOR, stalePlan, "r0", "j11-stale-edit", editedState()))
                .isInstanceOf(RevisionConflictException.class);
        assertThat(ports.store.head(EDITOR, PROJECT_ID)).isEqualTo(edit);

        assertThatThrownBy(() -> ports.engine.undo(
                EDITOR, PROJECT_ID, edit.revisionId(), "r0", "j11-stale-undo"))
                .isInstanceOf(RevisionConflictException.class);
        assertUnchanged(edit, ports.store.head(EDITOR, PROJECT_ID));

        ReversibleRegionEditEngine.EditRevision undone = ports.engine.undo(
                EDITOR, PROJECT_ID, edit.revisionId(), edit.revisionId(), "j11-undo");
        assertThat(undone.revisionId()).isNotEqualTo("r0");
        assertThat(undone.restoresRevisionId()).isEqualTo(edit.revisionId());
        assertThat(undone.snapshot().bytes()).containsExactly((byte) 0, (byte) 0xff, (byte) 3, (byte) 0);
        assertThat(undone.snapshot().metadata()).containsExactlyInAnyOrderEntriesOf(
                Map.of("region", "original", "selection", "ROI-A", "framePts", "108000"));
        assertThat(ports.store.head(EDITOR, PROJECT_ID)).isEqualTo(undone);
    }

    @Test
    void foreignPrincipalAndTenantCannotReadOrAppendToTheProjectRevision() {
        TestPorts ports = new TestPorts();
        ReversibleRegionEditEngine.EditRevision initial = ports.store.head(EDITOR, PROJECT_ID);
        ReversibleRegionEditEngine.RegionEditPlan plan = ports.prepare(exactEvidence());
        Actor wrongPrincipal = new Actor(EDITOR.tenantId(), "other-editor-j11");
        Actor wrongTenant = new Actor("other-tenant-j11", EDITOR.principalId());

        assertThatThrownBy(() -> ports.store.revision(wrongPrincipal, PROJECT_ID, "r0"))
                .isInstanceOf(ReversibleRegionEditEngine.EditRevisionNotFoundException.class);
        assertThatThrownBy(() -> ports.store.revision(wrongTenant, PROJECT_ID, "r0"))
                .isInstanceOf(ReversibleRegionEditEngine.EditRevisionNotFoundException.class);
        assertThatThrownBy(() -> ports.store.commit(
                wrongPrincipal, plan, "r0", "j11-foreign-principal", editedState()))
                .isInstanceOf(ReversibleRegionEditEngine.EditRevisionNotFoundException.class);
        assertThatThrownBy(() -> ports.store.commit(
                wrongTenant, plan, "r0", "j11-foreign-tenant", editedState()))
                .isInstanceOf(ReversibleRegionEditEngine.EditRevisionNotFoundException.class);

        assertUnchanged(initial, ports.store.head(EDITOR, PROJECT_ID));
    }

    private static ReversibleRegionEditEngine.TrackingEvidence exactEvidence() {
        return new ReversibleRegionEditEngine.TrackingEvidence("j11-authored-tracking-observation",
                EXACT_SOURCE, SOURCE_SHA256, REGION_ID, List.of(sample(0), sample(40_000), sample(108_000)));
    }

    private static ReversibleRegionEditEngine.TrackedSample sample(long pts) {
        NormalizedBox box = new NormalizedBox(.10, .12, .20, .18);
        return new ReversibleRegionEditEngine.TrackedSample(
                SOURCE_PTS_TIMEBASE.timestamp(pts, ClockDomain.SOURCE),
                "source-frame-coordinates-v1", "source-frame-coordinates-v1",
                new ReversibleRegionEditEngine.BoxShape(box), new ReversibleRegionEditEngine.BoxShape(box),
                ReversibleRegionEditEngine.AffineTransform.identity());
    }

    private static ReversibleRegionEditEngine.EditSnapshot originalState() {
        return new ReversibleRegionEditEngine.EditSnapshot(
                new byte[] {0, (byte) 0xff, 3, 0},
                Map.of("region", "original", "selection", "ROI-A", "framePts", "108000"));
    }

    private static ReversibleRegionEditEngine.EditSnapshot editedState() {
        return new ReversibleRegionEditEngine.EditSnapshot(
                new byte[] {9, 8, 7, 6, 5},
                Map.of("region", "edited", "selection", "ROI-B", "framePts", "108000"));
    }

    private static void assertUnchanged(ReversibleRegionEditEngine.EditRevision before,
                                        ReversibleRegionEditEngine.EditRevision after) {
        assertThat(after).isEqualTo(before);
        assertThat(after.snapshot().bytes()).containsExactly(before.snapshot().bytes());
        assertThat(after.snapshot().metadata()).isEqualTo(before.snapshot().metadata());
    }

    /** Test-only in-memory implementation of the engine's typed authority and local-store ports. */
    private static final class TestPorts {
        final MemoryStore store = new MemoryStore();
        final ReversibleRegionEditEngine engine = new ReversibleRegionEditEngine(store, this::inspectRights);
        ReversibleRegionEditEngine.RightsDecision rights = ReversibleRegionEditEngine.RightsDecision.ELIGIBLE;

        TestPorts() {
            store.seed(EDITOR, PROJECT_ID, "r0", EXACT_SOURCE, SOURCE_SHA256, PURPOSE, REGION_ID,
                    exactEvidence(), originalState());
        }

        ReversibleRegionEditEngine.RightsDecision inspectRights(
                Actor actor, SourceVersion source, String digest, String purpose, String regionId,
                List<ReversibleRegionEditEngine.TrackedSample> samples) {
            if (!actor.equals(EDITOR) || !source.equals(EXACT_SOURCE) || !digest.equals(SOURCE_SHA256)
                    || !purpose.equals(PURPOSE) || !regionId.equals(REGION_ID)
                    || !samples.equals(exactEvidence().samples())) {
                return ReversibleRegionEditEngine.RightsDecision.UNKNOWN;
            }
            return rights;
        }

        ReversibleRegionEditEngine.RegionEditPlan prepare(
                ReversibleRegionEditEngine.TrackingEvidence evidence) {
            return engine.prepare(EDITOR, new ReversibleRegionEditEngine.EditRequest(
                    PROJECT_ID, "j11-plan", "r0", EXACT_SOURCE, SOURCE_SHA256, PURPOSE, REGION_ID,
                    SOURCE_PTS_TIMEBASE, evidence, ReversibleRegionEditEngine.EditIntent.MOVE_OR_RESIZE_REGION));
        }
    }

    /** Deterministic append-only single-writer fixture; it does not implement canonical project persistence. */
    private static final class MemoryStore implements ReversibleRegionEditEngine.RegionEditStore {
        private final Map<String, Project> projects = new HashMap<>();
        private int nextRevision = 1;

        synchronized void seed(Actor actor, String projectId, String revisionId, SourceVersion source,
                               String digest, String purpose, String regionId,
                               ReversibleRegionEditEngine.TrackingEvidence evidence,
                               ReversibleRegionEditEngine.EditSnapshot snapshot) {
            var initial = new ReversibleRegionEditEngine.EditRevision(actor.tenantId(), actor.principalId(),
                    projectId, revisionId, null, "fixture-seed", source, digest, purpose, regionId,
                    evidence, snapshot, null);
            projects.put(key(actor, projectId), new Project(actor, initial));
        }

        @Override public synchronized ReversibleRegionEditEngine.EditRevision revision(
                Actor actor, String projectId, String revisionId) {
            Project project = owned(actor, projectId);
            var revision = project.revisions.get(revisionId);
            if (revision == null) throw new ReversibleRegionEditEngine.EditRevisionNotFoundException();
            return revision;
        }

        @Override public synchronized ReversibleRegionEditEngine.EditRevision commit(
                Actor actor, ReversibleRegionEditEngine.RegionEditPlan plan, String expectedRevisionId,
                String requestId, ReversibleRegionEditEngine.EditSnapshot afterState) {
            Project project = owned(actor, plan.projectId());
            if (!project.head.revisionId().equals(expectedRevisionId)) {
                throw new RevisionConflictException(expectedRevisionId, project.head.revisionId());
            }
            var committed = new ReversibleRegionEditEngine.EditRevision(actor.tenantId(), actor.principalId(),
                    plan.projectId(), "r" + nextRevision++, project.head.revisionId(), plan.editPlanId(),
                    plan.source(), plan.sourceSha256(), plan.purpose(), plan.regionId(), plan.evidence(),
                    afterState, null);
            project.revisions.put(committed.revisionId(), committed);
            project.head = committed;
            return committed;
        }

        @Override public synchronized ReversibleRegionEditEngine.EditRevision undo(
                Actor actor, String projectId, String targetRevisionId, String expectedCurrentRevisionId,
                String requestId) {
            Project project = owned(actor, projectId);
            if (!project.head.revisionId().equals(expectedCurrentRevisionId)
                    || !targetRevisionId.equals(project.head.revisionId())) {
                throw new RevisionConflictException(expectedCurrentRevisionId, project.head.revisionId());
            }
            var target = project.revisions.get(targetRevisionId);
            if (target == null || target.parentRevisionId() == null) {
                throw new ReversibleRegionEditEngine.EditRevisionNotFoundException();
            }
            var parent = project.revisions.get(target.parentRevisionId());
            var restored = new ReversibleRegionEditEngine.EditRevision(actor.tenantId(), actor.principalId(),
                    projectId, "r" + nextRevision++, project.head.revisionId(), target.planId(), target.source(),
                    target.sourceSha256(), target.purpose(), target.regionId(), target.evidence(), parent.snapshot(),
                    target.revisionId());
            project.revisions.put(restored.revisionId(), restored);
            project.head = restored;
            return restored;
        }

        synchronized ReversibleRegionEditEngine.EditRevision head(Actor actor, String projectId) {
            return owned(actor, projectId).head;
        }

        private Project owned(Actor actor, String projectId) {
            Project project = projects.get(key(actor, projectId));
            if (project == null) throw new ReversibleRegionEditEngine.EditRevisionNotFoundException();
            if (!project.actor.equals(actor)) throw new ReversibleRegionEditEngine.EditRevisionNotFoundException();
            return project;
        }

        private static String key(Actor actor, String projectId) {
            return actor.tenantId() + "/" + projectId;
        }

        private static final class Project {
            final Actor actor;
            final Map<String, ReversibleRegionEditEngine.EditRevision> revisions = new HashMap<>();
            ReversibleRegionEditEngine.EditRevision head;

            Project(Actor actor, ReversibleRegionEditEngine.EditRevision initial) {
                this.actor = actor;
                this.head = initial;
                revisions.put(initial.revisionId(), initial);
            }
        }
    }
}
