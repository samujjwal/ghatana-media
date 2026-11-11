package com.ghatana.audio.video.integration;

import com.ghatana.media.production.animation.AnimationRenderer;
import com.ghatana.media.production.timeline.NotAdmittedProjectTimelineStore;
import com.ghatana.media.production.timeline.ProjectTimelineEngine;
import com.ghatana.media.production.timeline.InMemoryProjectTimelineStore;
import com.ghatana.media.production.AnimationSpecCompiler.AnimationSpec;
import com.ghatana.media.production.AnimationSpecCompiler.PositiveRational;
import com.ghatana.media.production.AnimationSpecCompiler.StoryTime;
import com.ghatana.media.runtime.MediaCapabilityNotAdmittedException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Clock;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.RationalTime;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.RevisionConflictException;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.io.ByteArrayInputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.Iterator;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * J-12 fixture-only scenario integration. The local renderer creates decodable
 * pixels; no authenticated editor session, canonical job, rights authority,
 * durable project CAS, or terminal journey receipt is inferred.
 *
 * <p>Source bindings: J-12 steps 0-2 in
 * {@code .product-experience/pdp-3-product-experience/journey-contracts/animate-vector-or-procedural-scenes.yaml},
 * step 0's local-only draft effect in
 * {@code .product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml},
 * and the explicit unseeded J-12 fixture disposition in
 * {@code .product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml}.
 * IDs and source digest below are test-owned synthetic fixture values.
 */
class AnimationJ12ScenarioIntegrationTest {
    private static final String TENANT = "tenant-j12-fixture";
    private static final String WORKSPACE = "workspace-j12-fixture";
    private static final String PROJECT = "project-j12-fixture";
    private static final String ACTOR = "creator-j12-fixture";
    private static final String SESSION = "session-j12-fixture";

    /** Test-owned local observation states; these are not Media job states. */
    private enum FixtureRenderState { NOT_STARTED, CANCELLED, OUTCOME_UNKNOWN }

    /** Shared only by recreated in-memory test sessions; no durable runtime is implied. */
    private static final class FixtureRenderObservation {
        private FixtureRenderState state = FixtureRenderState.NOT_STARTED;
        private int localRenderInvocations;
        private byte[] observedResult;
    }

    /**
     * Models the unseeded J-12 render boundary without adding a runtime API:
     * cancellation before invocation, and a lost local observation after
     * deterministic fixture rendering. A recreated session can inspect the
     * same in-memory observation but cannot replay it.
     */
    private static final class FixtureRenderSession {
        private final FixtureRenderObservation observation;

        private FixtureRenderSession(FixtureRenderObservation observation) {
            this.observation = observation;
        }

        private void cancelBeforeRender() {
            if (observation.state == FixtureRenderState.NOT_STARTED) {
                observation.state = FixtureRenderState.CANCELLED;
            }
        }

        private void renderWithLostObservation() {
            if (observation.state != FixtureRenderState.NOT_STARTED) {
                return;
            }
            observation.localRenderInvocations++;
            new AnimationRenderer().render(spec(), scene(), new AnimationRenderer.Profile(10, 1, 3));
            // The fixture simulates losing the observation after local work;
            // no result is recorded as terminal or made available to callers.
            observation.state = FixtureRenderState.OUTCOME_UNKNOWN;
        }

        private FixtureRenderState state() {
            return observation.state;
        }

        private int localRenderInvocations() {
            return observation.localRenderInvocations;
        }

        private Optional<byte[]> observedResult() {
            return Optional.ofNullable(observation.observedResult)
                    .map(bytes -> bytes.clone());
        }
    }

    private record FixtureBinding(String tenantId, String workspaceId, String projectId,
            String actorId, String sessionId, String sourceDigest, String jobId, String rightsScope) { }

    private static AnimationSpec spec() {
        return new AnimationSpec("media.declarative.value.animation-spec.v1",
                "scene/j12-fixture@v1", "animation/j12-fixture@v1", "operators/vector@v1",
                "assets/none@v1", List.of("curve/position@v1"),
                new StoryTime("story", "j12-fixture-clock", "j12-fixture-stream", "origin/j12@v1", "100",
                        new PositiveRational("1", "24")), "render/gif@v1");
    }

    private static AnimationRenderer.Scene scene() {
        return new AnimationRenderer.Scene(8, 4, 0xff101820, List.of(
                new AnimationRenderer.Shape("marker", AnimationRenderer.Primitive.RECTANGLE,
                        0, 1, 1, 1, 0, 0xffffc040, List.of(
                                new AnimationRenderer.Keyframe(0, 0, 0, 1, 1, 0, 1,
                                        AnimationRenderer.Easing.EASE_IN_OUT),
                                new AnimationRenderer.Keyframe(2, 4, 0, 1, 1, 0, 1,
                                        AnimationRenderer.Easing.LINEAR)))));
    }

    @Test
    void rendersFixtureOutputWithTenantSourceAndRightsScopeWithoutInventingAJobOrJourneySuccess() throws Exception {
        AnimationRenderer renderer = new AnimationRenderer();
        AnimationSpec spec = spec();
        AnimationRenderer.Scene scene = scene();
        AnimationRenderer.Profile profile = new AnimationRenderer.Profile(10, 1, 3);
        String sourceDigest = sha256((TENANT + "|" + WORKSPACE + "|" + PROJECT + "|" + ACTOR + "|"
                + SESSION + "|" + spec.sceneGraphRef() + "|" + spec.animationGraphRef()
                + "|marker:0,1,1,1;0->4@2;easeInOut").getBytes(StandardCharsets.UTF_8));
        FixtureBinding binding = new FixtureBinding(TENANT, WORKSPACE, PROJECT, ACTOR, SESSION,
                sourceDigest, null, "synthetic vector primitives only; no external assets or egress");

        // The authored local step is actor/session scoped. These test IDs and
        // this fixture digest are provenance labels only, not trusted context.
        assertThat(List.of(binding.tenantId(), binding.workspaceId(), binding.projectId(),
                binding.actorId(), binding.sessionId())).allMatch(value -> !value.isBlank());
        assertThat(binding.sourceDigest()).matches("[a-f0-9]{64}");
        assertThat(binding.jobId()).isNull(); // J-12's local draft result has no job identity.
        assertThat(binding.rightsScope()).contains("no external assets");
        assertThat(scene.assets()).isEmpty(); // Synthetic vector fixture; no external asset rights are asserted.

        var preview = renderer.render(spec, scene, profile);
        assertThat(preview.plan().sceneGraphRef()).isEqualTo("scene/j12-fixture@v1");
        assertThat(preview.frames()).hasSize(3);
        assertThat(AnimationRenderer.sample(scene.shapes().getFirst().keyframes(), 1).x()).isEqualTo(2.0);
        for (int index = 0; index < preview.frames().size(); index++) {
            var decoded = ImageIO.read(new ByteArrayInputStream(preview.frames().get(index).png()));
            assertThat(decoded).isNotNull();
            assertThat(decoded.getWidth()).isEqualTo(8);
            assertThat(decoded.getHeight()).isEqualTo(4);
            assertThat(decoded.getRGB(7, 3)).isEqualTo(0xff101820);
            assertThat(decoded.getRGB(index * 2, 1)).isEqualTo(0xffffc040);
        }
        assertThat(preview.frames().get(1).ptsNumerator()).isEqualTo("1");
        assertThat(preview.frames().get(1).ptsDenominator()).isEqualTo("10");
        assertThat(preview.frames().get(1).storyTicksNumerator()).isEqualTo("512");
        assertThat(preview.frames().get(1).storyTicksDenominator()).isEqualTo("5");

        var repeatedPreview = renderer.render(spec, scene, profile);
        assertThat(repeatedPreview.frames()).hasSize(preview.frames().size());
        for (int index = 0; index < preview.frames().size(); index++) {
            assertThat(repeatedPreview.frames().get(index).png())
                    .as("repeatable PNG frame %d", index)
                    .containsExactly(preview.frames().get(index).png());
        }

        var export = renderer.renderAnimated(spec, scene, profile, AnimationRenderer.AnimatedFormat.GIF);
        assertThat(export.status()).isEqualTo(AnimationRenderer.ExportStatus.ENCODED);
        var encoded = export.encoded().orElseThrow();
        assertThat(encoded.format()).isEqualTo("gif");
        assertThat(encoded.framesPerSecondNumerator()).isEqualTo(10);
        assertThat(encoded.framesPerSecondDenominator()).isEqualTo(1);
        assertThat(encoded.frameDelayCentiseconds()).isEqualTo(10);
        assertThat(encoded.frameCount()).isEqualTo(3);
        assertThat(encoded.frameTimes()).containsExactly(
                new AnimationRenderer.FrameTime(0, "0", "1", "100", "1"),
                new AnimationRenderer.FrameTime(1, "1", "10", "512", "5"),
                new AnimationRenderer.FrameTime(2, "1", "5", "524", "5"));
        assertThat(encoded.sha256()).matches("[a-f0-9]{64}");
        assertThat(encoded.sha256()).isNotEqualTo(binding.sourceDigest()); // Fixture source and output have distinct digests.
        assertThat(decodeGifFrameCount(encoded.bytes())).isEqualTo(3);
        var repeatedExport = renderer.renderAnimated(spec, scene, profile, AnimationRenderer.AnimatedFormat.GIF);
        assertThat(repeatedExport.status()).isEqualTo(AnimationRenderer.ExportStatus.ENCODED);
        assertThat(repeatedExport.encoded().orElseThrow().bytes()).containsExactly(encoded.bytes());
        assertThat(repeatedExport.encoded().orElseThrow().sha256()).isEqualTo(encoded.sha256());

        // J-12's local draft step explicitly produces no job or committed result.
        // Local preview/export bytes do not make the authenticated journey succeed.
        assertThat(binding.jobId()).isNull();
    }

    @Test
    void absentDurableAuthorityAndUnsupportedCodecNeverProduceTerminalSuccess() {
        AnimationRenderer renderer = new AnimationRenderer();
        var unsupported = renderer.renderAnimated(spec(), scene(), new AnimationRenderer.Profile(10, 1, 3),
                AnimationRenderer.AnimatedFormat.MP4);
        assertThat(unsupported.status()).isEqualTo(AnimationRenderer.ExportStatus.UNSUPPORTED_CODEC);
        assertThat(unsupported.encoded()).isEmpty();

        // The source-backed degraded branch keeps the authored source graph
        // intact when export timing is unsupported. This is a local renderer
        // check only: it does not assert journey completion or a qualified
        // fallback export.
        AnimationSpec animationSpec = spec();
        AnimationRenderer.Scene sourceGraph = scene();
        AnimationRenderer.Profile previewProfile = new AnimationRenderer.Profile(10, 1, 3);
        var beforeUnsupportedTiming = renderer.render(animationSpec, sourceGraph, previewProfile);
        var unsupportedTiming = renderer.renderAnimated(animationSpec, sourceGraph,
                new AnimationRenderer.Profile(24, 1, 3), AnimationRenderer.AnimatedFormat.GIF);
        assertThat(unsupportedTiming.status()).isEqualTo(AnimationRenderer.ExportStatus.UNSUPPORTED_FRAME_RATE);
        assertThat(unsupportedTiming.failure())
                .contains(AnimationRenderer.ExportFailure.FRAME_RATE_NOT_EXACTLY_REPRESENTABLE);
        assertThat(unsupportedTiming.encoded()).isEmpty();

        var afterUnsupportedTiming = renderer.render(animationSpec, sourceGraph, previewProfile);
        assertThat(sourceGraph).isEqualTo(scene());
        assertThat(afterUnsupportedTiming.frames()).hasSize(beforeUnsupportedTiming.frames().size());
        for (int index = 0; index < beforeUnsupportedTiming.frames().size(); index++) {
            assertThat(afterUnsupportedTiming.frames().get(index).png())
                    .containsExactly(beforeUnsupportedTiming.frames().get(index).png());
        }

        ProjectTimelineEngine engine = new ProjectTimelineEngine(new NotAdmittedProjectTimelineStore());
        assertThatThrownBy(() -> engine.createProject(new Actor(TENANT, ACTOR), WORKSPACE,
                "J-12 fixture", "j12-fixture-create-1"))
                .isInstanceOf(MediaCapabilityNotAdmittedException.class)
                .satisfies(error -> {
                    var notAdmitted = (MediaCapabilityNotAdmittedException) error;
                    assertThat(notAdmitted.reason()).isEqualTo(MediaCapabilityNotAdmittedException.Reason.NOT_ADMITTED);
                    assertThat(notAdmitted.modality()).isEqualTo("PROJECT_TIMELINE_STORE");
                });

        // J-12 has no admitted runtime job/cancellation/UNKNOWN/restart API or
        // exact source scenario seed. Those paths remain unexecuted and cannot
        // be converted into synthetic success by this source-free scenario.
    }

    @Test
    void unknownExactSourceEligibilityBlocksFixtureRenderDispatch() {
        AtomicInteger generatedId = new AtomicInteger();
        ProjectTimelineEngine timeline = new ProjectTimelineEngine(new InMemoryProjectTimelineStore(),
                () -> "j12-fixture-id-" + generatedId.incrementAndGet());
        Actor actor = new Actor(TENANT, ACTOR);
        var created = timeline.createProject(actor, WORKSPACE, "Synthetic J-12 source", "j12-create-unknown");
        var timelineHead = timeline.createTimeline(actor, created.project().projectId(),
                created.initialRevision().revisionId(), "timeline-j12");
        var source = new com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceVersion(
                "synthetic-source", "synthetic-source-v1");
        var sourceIn = new RationalTime(0, 24, 1, Clock.SOURCE_PRESENTATION);
        var sourceOut = new RationalTime(1, 24, 1, Clock.SOURCE_PRESENTATION);
        var storyStart = new RationalTime(0, 24, 1, Clock.STORY);
        var storyDuration = new RationalTime(1, 24, 1, Clock.STORY);
        var revision = timeline.edit(actor, created.project().projectId(), "timeline-j12", timelineHead.revisionId(), List.of(
                new ProjectTimelineEngine.AddScene(
                        new com.ghatana.media.runtime.MediaProjectTimelineContracts.Scene("j12-scene", 0)),
                new ProjectTimelineEngine.AddTrack(new com.ghatana.media.runtime.MediaProjectTimelineContracts.Track(
                        "j12-track", "j12-scene",
                        com.ghatana.media.runtime.MediaProjectTimelineContracts.TrackKind.OVERLAY, 0)),
                new ProjectTimelineEngine.PutClip(new com.ghatana.media.runtime.MediaProjectTimelineContracts.Clip(
                        "j12-clip", "j12-scene", "j12-track", source, sourceIn, sourceOut,
                        storyStart, storyDuration))));

        AtomicInteger authorityReads = new AtomicInteger();
        AtomicInteger renderDispatches = new AtomicInteger();
        Runnable fixtureRenderDispatch = () -> {
            timeline.requireCurrentSources(actor, created.project().projectId(), revision.revisionId(),
                    (checkedActor, checkedSource) -> {
                        assertThat(checkedActor).isEqualTo(actor);
                        assertThat(checkedSource).isEqualTo(source);
                        authorityReads.incrementAndGet();
                        return com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceEligibility.UNKNOWN;
                    });
            renderDispatches.incrementAndGet();
            new AnimationRenderer().render(spec(), scene(), new AnimationRenderer.Profile(10, 1, 3));
        };

        assertThatThrownBy(fixtureRenderDispatch::run)
                .isInstanceOf(com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceEligibilityException.class)
                .satisfies(error -> assertThat(
                        ((com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceEligibilityException) error)
                                .observed())
                        .isEqualTo(com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceEligibility.UNKNOWN));
        assertThat(authorityReads).hasValue(1);
        assertThat(renderDispatches).hasValue(0);
    }

    @Test
    void deniedExactSourceEligibilityPreservesDraftAndBlocksFixtureRenderDispatch() {
        AtomicInteger generatedId = new AtomicInteger();
        ProjectTimelineEngine timeline = new ProjectTimelineEngine(new InMemoryProjectTimelineStore(),
                () -> "j12-denied-fixture-id-" + generatedId.incrementAndGet());
        Actor actor = new Actor(TENANT, ACTOR);
        var created = timeline.createProject(actor, WORKSPACE, "Synthetic J-12 source", "j12-create-denied");
        var timelineHead = timeline.createTimeline(actor, created.project().projectId(),
                created.initialRevision().revisionId(), "timeline-j12");
        var source = new com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceVersion(
                "synthetic-source", "synthetic-source-v1");
        var sourceIn = new RationalTime(0, 24, 1, Clock.SOURCE_PRESENTATION);
        var sourceOut = new RationalTime(1, 24, 1, Clock.SOURCE_PRESENTATION);
        var storyStart = new RationalTime(0, 24, 1, Clock.STORY);
        var storyDuration = new RationalTime(1, 24, 1, Clock.STORY);
        var revision = timeline.edit(actor, created.project().projectId(), "timeline-j12", timelineHead.revisionId(), List.of(
                new ProjectTimelineEngine.AddScene(
                        new com.ghatana.media.runtime.MediaProjectTimelineContracts.Scene("j12-scene", 0)),
                new ProjectTimelineEngine.AddTrack(new com.ghatana.media.runtime.MediaProjectTimelineContracts.Track(
                        "j12-track", "j12-scene",
                        com.ghatana.media.runtime.MediaProjectTimelineContracts.TrackKind.OVERLAY, 0)),
                new ProjectTimelineEngine.PutClip(new com.ghatana.media.runtime.MediaProjectTimelineContracts.Clip(
                        "j12-clip", "j12-scene", "j12-track", source, sourceIn, sourceOut,
                        storyStart, storyDuration))));

        AtomicInteger authorityReads = new AtomicInteger();
        AtomicInteger renderDispatches = new AtomicInteger();
        Runnable fixtureRenderDispatch = () -> {
            timeline.requireCurrentSources(actor, created.project().projectId(), revision.revisionId(),
                    (checkedActor, checkedSource) -> {
                        assertThat(checkedActor).isEqualTo(actor);
                        assertThat(checkedSource).isEqualTo(source);
                        authorityReads.incrementAndGet();
                        return com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceEligibility.REVOKED;
                    });
            renderDispatches.incrementAndGet();
            new AnimationRenderer().render(spec(), scene(), new AnimationRenderer.Profile(10, 1, 3));
        };

        assertThatThrownBy(fixtureRenderDispatch::run)
                .isInstanceOf(com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceEligibilityException.class)
                .satisfies(error -> assertThat(
                        ((com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceEligibilityException) error)
                                .observed())
                        .isEqualTo(com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceEligibility.REVOKED));
        assertThat(authorityReads).hasValue(1);
        assertThat(renderDispatches).hasValue(0);
        assertThat(timeline.project(actor, created.project().projectId()).headRevisionId())
                .isEqualTo(revision.revisionId());
        // The fixture denial preserves the committed draft and makes no renderer or production claim.
    }

    @Test
    void oneRevokedSourceAmongMultipleClipsBlocksFixtureRenderDispatch() {
        AtomicInteger generatedId = new AtomicInteger();
        ProjectTimelineEngine timeline = new ProjectTimelineEngine(new InMemoryProjectTimelineStore(),
                () -> "j12-multisource-fixture-id-" + generatedId.incrementAndGet());
        Actor actor = new Actor(TENANT, ACTOR);
        var created = timeline.createProject(actor, WORKSPACE, "Synthetic J-12 multi-source", "j12-create-multisource");
        var timelineHead = timeline.createTimeline(actor, created.project().projectId(),
                created.initialRevision().revisionId(), "timeline-j12");
        var firstSource = new com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceVersion(
                "synthetic-source-a", "synthetic-source-a-v1");
        var secondSource = new com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceVersion(
                "synthetic-source-b", "synthetic-source-b-v1");
        var sourceIn = new RationalTime(0, 24, 1, Clock.SOURCE_PRESENTATION);
        var sourceOut = new RationalTime(1, 24, 1, Clock.SOURCE_PRESENTATION);
        var storyStart = new RationalTime(0, 24, 1, Clock.STORY);
        var storyDuration = new RationalTime(1, 24, 1, Clock.STORY);
        var revision = timeline.edit(actor, created.project().projectId(), "timeline-j12", timelineHead.revisionId(), List.of(
                new ProjectTimelineEngine.AddScene(
                        new com.ghatana.media.runtime.MediaProjectTimelineContracts.Scene("j12-scene", 0)),
                new ProjectTimelineEngine.AddTrack(new com.ghatana.media.runtime.MediaProjectTimelineContracts.Track(
                        "j12-track", "j12-scene",
                        com.ghatana.media.runtime.MediaProjectTimelineContracts.TrackKind.OVERLAY, 0)),
                new ProjectTimelineEngine.PutClip(new com.ghatana.media.runtime.MediaProjectTimelineContracts.Clip(
                        "j12-clip-a", "j12-scene", "j12-track", firstSource, sourceIn, sourceOut,
                        storyStart, storyDuration)),
                new ProjectTimelineEngine.PutClip(new com.ghatana.media.runtime.MediaProjectTimelineContracts.Clip(
                        "j12-clip-b", "j12-scene", "j12-track", secondSource, sourceIn, sourceOut,
                        storyStart, storyDuration))));

        java.util.Set<String> checkedSources = new java.util.HashSet<>();
        AtomicInteger renderDispatches = new AtomicInteger();
        Runnable fixtureRenderDispatch = () -> {
            timeline.requireCurrentSources(actor, created.project().projectId(), revision.revisionId(),
                    (checkedActor, checkedSource) -> {
                        assertThat(checkedActor).isEqualTo(actor);
                        checkedSources.add(checkedSource.artifactId());
                        return checkedSource.equals(firstSource)
                                ? com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceEligibility.ELIGIBLE
                                : com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceEligibility.REVOKED;
                    });
            renderDispatches.incrementAndGet();
            new AnimationRenderer().render(spec(), scene(), new AnimationRenderer.Profile(10, 1, 3));
        };

        assertThatThrownBy(fixtureRenderDispatch::run)
                .isInstanceOf(com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceEligibilityException.class)
                .satisfies(error -> assertThat(
                        ((com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceEligibilityException) error)
                                .observed())
                        .isEqualTo(com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceEligibility.REVOKED));
        assertThat(checkedSources).containsExactlyInAnyOrder("synthetic-source-a", "synthetic-source-b");
        assertThat(renderDispatches).hasValue(0);
        assertThat(timeline.project(actor, created.project().projectId()).headRevisionId())
                .isEqualTo(revision.revisionId());
    }

    @Test
    void staleSourceRevisionCannotAdvanceDraftOrReachFixtureRenderer() {
        AtomicInteger generatedId = new AtomicInteger();
        InMemoryProjectTimelineStore store = new InMemoryProjectTimelineStore();
        ProjectTimelineEngine timeline = new ProjectTimelineEngine(store,
                () -> "j12-stale-fixture-id-" + generatedId.incrementAndGet());
        Actor actor = new Actor(TENANT, ACTOR);
        var created = timeline.createProject(actor, WORKSPACE, "Synthetic J-12 source", "j12-create-stale");
        var timelineHead = timeline.createTimeline(actor, created.project().projectId(),
                created.initialRevision().revisionId(), "timeline-j12");
        var sourceV1 = new com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceVersion(
                "synthetic-source", "synthetic-source-v1");
        var sourceV2 = new com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceVersion(
                "synthetic-source", "synthetic-source-v2");
        var sourceIn = new RationalTime(0, 24, 1, Clock.SOURCE_PRESENTATION);
        var sourceOut = new RationalTime(1, 24, 1, Clock.SOURCE_PRESENTATION);
        var storyStart = new RationalTime(0, 24, 1, Clock.STORY);
        var storyDuration = new RationalTime(1, 24, 1, Clock.STORY);
        var initialDraft = timeline.edit(actor, created.project().projectId(), "timeline-j12",
                timelineHead.revisionId(), List.of(
                        new ProjectTimelineEngine.AddScene(
                                new com.ghatana.media.runtime.MediaProjectTimelineContracts.Scene("j12-scene", 0)),
                        new ProjectTimelineEngine.AddTrack(
                                new com.ghatana.media.runtime.MediaProjectTimelineContracts.Track("j12-track", "j12-scene",
                                        com.ghatana.media.runtime.MediaProjectTimelineContracts.TrackKind.OVERLAY, 0)),
                        new ProjectTimelineEngine.PutClip(
                                new com.ghatana.media.runtime.MediaProjectTimelineContracts.Clip("j12-clip", "j12-scene",
                                        "j12-track", sourceV1, sourceIn, sourceOut, storyStart, storyDuration))));

        // A later local draft revision selects the new immutable source version.
        // This uses the process-local test store and does not claim a durable commit.
        var currentDraft = timeline.edit(actor, created.project().projectId(), "timeline-j12", initialDraft.revisionId(), List.of(
                new ProjectTimelineEngine.PutClip(
                        new com.ghatana.media.runtime.MediaProjectTimelineContracts.Clip("j12-clip", "j12-scene",
                                "j12-track", sourceV2, sourceIn, sourceOut, storyStart, storyDuration))));

        AtomicInteger renderDispatches = new AtomicInteger();
        Runnable staleDraftRender = () -> {
            // Replaying a render with the old head must fail before any renderer
            // effect, even though its old source bytes are still in the fixture.
            timeline.edit(actor, created.project().projectId(), "timeline-j12", initialDraft.revisionId(), List.of(
                    new ProjectTimelineEngine.PutClip(
                            new com.ghatana.media.runtime.MediaProjectTimelineContracts.Clip("j12-clip", "j12-scene",
                                    "j12-track", sourceV1, sourceIn, sourceOut, storyStart, storyDuration))));
            renderDispatches.incrementAndGet();
            new AnimationRenderer().render(spec(), scene(), new AnimationRenderer.Profile(10, 1, 3));
        };

        assertThatThrownBy(staleDraftRender::run)
                .isInstanceOf(RevisionConflictException.class)
                .satisfies(error -> assertThat(((RevisionConflictException) error).currentHeadRevisionId())
                        .isEqualTo(currentDraft.revisionId()));
        assertThat(renderDispatches).hasValue(0);
        assertThat(timeline.project(actor, created.project().projectId()).headRevisionId())
                .isEqualTo(currentDraft.revisionId());
        assertThat(store.revision(actor, created.project().projectId(), currentDraft.revisionId())
                .timelines().getFirst().graph().clips().getFirst().source()).isEqualTo(sourceV2);
    }

    @Test
    void cancellationAndAmbiguousLocalRenderStayNonTerminalAcrossFixtureSessionRecreation() {
        AnimationRenderer renderer = new AnimationRenderer();
        AnimationRenderer.Profile profile = new AnimationRenderer.Profile(10, 1, 3);
        var previewBefore = renderer.render(spec(), scene(), profile);

        FixtureRenderObservation cancelledObservation = new FixtureRenderObservation();
        FixtureRenderSession cancelledSession = new FixtureRenderSession(cancelledObservation);
        cancelledSession.cancelBeforeRender();
        FixtureRenderSession recreatedCancelledSession = new FixtureRenderSession(cancelledObservation);
        recreatedCancelledSession.renderWithLostObservation();

        assertThat(recreatedCancelledSession.state()).isEqualTo(FixtureRenderState.CANCELLED);
        assertThat(recreatedCancelledSession.localRenderInvocations()).isZero();
        assertThat(recreatedCancelledSession.observedResult()).isEmpty();

        FixtureRenderObservation ambiguousObservation = new FixtureRenderObservation();
        FixtureRenderSession firstSession = new FixtureRenderSession(ambiguousObservation);
        firstSession.renderWithLostObservation();
        assertThat(firstSession.state()).isEqualTo(FixtureRenderState.OUTCOME_UNKNOWN);
        assertThat(firstSession.localRenderInvocations()).isEqualTo(1);
        assertThat(firstSession.observedResult()).isEmpty();

        // A new in-memory session sees the unresolved observation and does not
        // invoke the local renderer again or expose a terminal result.
        FixtureRenderSession recreatedSession = new FixtureRenderSession(ambiguousObservation);
        recreatedSession.renderWithLostObservation();
        assertThat(recreatedSession.state()).isEqualTo(FixtureRenderState.OUTCOME_UNKNOWN);
        assertThat(recreatedSession.localRenderInvocations()).isEqualTo(1);
        assertThat(recreatedSession.observedResult()).isEmpty();

        var previewAfter = renderer.render(spec(), scene(), profile);
        assertThat(previewAfter.frames()).hasSize(previewBefore.frames().size());
        for (int index = 0; index < previewBefore.frames().size(); index++) {
            assertThat(previewAfter.frames().get(index).png())
                    .as("fixture preview remains deterministic after cancellation/ambiguity, frame %d", index)
                    .containsExactly(previewBefore.frames().get(index).png());
        }
    }

    private static int decodeGifFrameCount(byte[] bytes) throws Exception {
        Iterator<ImageReader> readers = ImageIO.getImageReadersByFormatName("gif");
        assertThat(readers.hasNext()).isTrue();
        ImageReader reader = readers.next();
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            reader.setInput(input, false, false);
            for (int index = 0; index < reader.getNumImages(true); index++) {
                var frame = reader.read(index);
                assertThat(frame.getWidth()).isEqualTo(8);
                assertThat(frame.getHeight()).isEqualTo(4);
                long markerPixels = 0;
                for (int y = 0; y < frame.getHeight(); y++) {
                    for (int x = 0; x < frame.getWidth(); x++) {
                        if (frame.getRGB(x, y) == 0xffffc040) markerPixels++;
                    }
                }
                assertThat(markerPixels).as("golden marker pixels in encoded frame %d", index).isPositive();
                assertThat(frame.getRGB(7, 3)).as("background in encoded frame %d", index)
                        .isEqualTo(0xff101820);
                frame.flush();
            }
            return reader.getNumImages(true);
        } finally {
            reader.dispose();
        }
    }

    private static String sha256(byte[] value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new AssertionError("SHA-256 is required by the JVM", impossible);
        }
    }
}
