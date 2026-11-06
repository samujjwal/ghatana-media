package com.ghatana.audio.video.integration;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.production.rendering.MultitrackRenderPlanner;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Clip;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Graph;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Modality;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Time;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Transition;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.TransitionKind;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import org.junit.jupiter.api.Test;

/**
 * Source-free J-18 planning scenario. All inputs are synthetic fixture identities;
 * this checks the frozen render manifest, not encoded output or production media.
 */
class MultitrackFinishedMasterScenarioTest {
    private static final long OUTPUT_BUDGET_BYTES = 1_000_000;

    @Test
    void unavailableCodecCannotTurnAValidCombinedPlanIntoAFinishedMaster() {
        var planned = MultitrackRenderPlanner.plan(fixtureGraph());
        assertThat(planned.outcome()).isEqualTo(MultitrackRenderPlanner.Outcome.PLAN_READY);

        var unavailable = MultitrackRenderPlanner.execute(planned.plan(),
                new MultitrackRenderPlanner.CodecPipeline() {
                    @Override public boolean admitted() { return true; }
                    @Override public boolean available() { return false; }
                });

        assertThat(unavailable.outcome()).isEqualTo(MultitrackRenderPlanner.Outcome.UNAVAILABLE);
        assertThat(unavailable.reason())
                .isEqualTo(MultitrackRenderPlanner.Reason.CODEC_PIPELINE_UNAVAILABLE);
        // A plan digest identifies the composition manifest, not an encoded/playable output.
        assertThat(unavailable.plan()).isNull();
    }

    @Test
    void freezesMultitrackFixtureAndKeepsMissingEncoderNotAdmitted() {
        Graph fixture = fixtureGraph();

        var first = MultitrackRenderPlanner.plan(fixture);
        var repeated = MultitrackRenderPlanner.plan(fixture);

        assertThat(first.outcome()).isEqualTo(MultitrackRenderPlanner.Outcome.PLAN_READY);
        assertThat(first.plan().capabilityId()).isEqualTo("media.dev.multitrack-composition-render");
        assertThat(first.plan().manifestSha256()).matches("[a-f0-9]{64}")
                .isEqualTo(repeated.plan().manifestSha256());
        assertThat(first.plan().canonicalManifest())
                .contains("video-fixture-1|VIDEO|synthetic-video-source-1|fixture-v1|")
                .contains("audio-fixture-1|AUDIO|synthetic-audio-source-1|fixture-v1|")
                .contains("graphic-fixture-1|GRAPHIC|synthetic-graphic-source-1|fixture-v1|")
                .contains("caption=caption-fixture-1|");

        var notAdmitted = MultitrackRenderPlanner.execute(first.plan(), null);
        assertThat(notAdmitted.outcome()).isEqualTo(MultitrackRenderPlanner.Outcome.NOT_ADMITTED);
        assertThat(notAdmitted.plan()).isNull();
        assertThat(notAdmitted.reason())
                .isEqualTo(MultitrackRenderPlanner.Reason.CODEC_PIPELINE_NOT_ADMITTED);

        var admittedButUnimplemented = MultitrackRenderPlanner.execute(first.plan(),
                new MultitrackRenderPlanner.CodecPipeline() {
                    @Override public boolean admitted() { return true; }
                    @Override public boolean available() { return true; }
                });
        assertThat(admittedButUnimplemented.outcome()).isEqualTo(MultitrackRenderPlanner.Outcome.UNAVAILABLE);
        assertThat(admittedButUnimplemented.plan()).isNull();
        assertThat(admittedButUnimplemented.reason())
                .isEqualTo(MultitrackRenderPlanner.Reason.CODEC_PIPELINE_UNAVAILABLE);

        // This digest is for the canonical plan manifest only, never an output artifact checksum.
        assertThat(sha256(first.plan().canonicalManifest())).isEqualTo(first.plan().manifestSha256());
    }

    private static Graph fixtureGraph() {
        return new Graph(
                List.of(
                        clip("video-fixture-1", Modality.VIDEO, "synthetic-video-source-1", 0, 0, 2,
                                List.of(new Time(0, 1), new Time(1, 1))),
                        clip("video-fixture-2", Modality.VIDEO, "synthetic-video-source-2", 1, 0, 2,
                                List.of(new Time(0, 1), new Time(1, 1))),
                        clip("audio-fixture-1", Modality.AUDIO, "synthetic-audio-source-1", 0, 0, 3,
                                List.of(new Time(0, 1))),
                        clip("graphic-fixture-1", Modality.GRAPHIC, "synthetic-graphic-source-1", 0, 0, 3,
                                List.of(new Time(0, 1)))),
                List.of(new MultitrackRenderPlanner.Caption("caption-fixture-1", new Time(1, 2),
                        new Time(3, 2), "Synthetic caption fixture")),
                List.of(new Transition("transition-fixture-1", "video-fixture-1", "video-fixture-2",
                        TransitionKind.CROSSFADE, new Time(1, 1), new Time(1, 1))),
                OUTPUT_BUDGET_BYTES);
    }

    private static Clip clip(String id, Modality modality, String artifactId, long timelineStart,
            long sourceStart, long sourceEnd, List<Time> pts) {
        return new Clip(id, modality, artifactId, "fixture-v1", sha256("synthetic-fixture:" + artifactId),
                new Time(timelineStart, 1), new Time(sourceStart, 1), new Time(sourceEnd, 1), pts);
    }

    private static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new AssertionError("SHA-256 is required by the JVM", impossible);
        }
    }
}
