package com.ghatana.media.production.rendering;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;

import java.util.List;
import org.junit.jupiter.api.Test;

class MultitrackRenderPlannerTest {
    private static final String SHA = "a".repeat(64);

    @Test
    void retainsVariableFrameTimestampsAndBuildsStableExactManifestDigest() {
        var graph = new MultitrackRenderPlanner.Graph(
                List.of(new MultitrackRenderPlanner.Clip("video-1", MultitrackRenderPlanner.Modality.VIDEO,
                        "artifact-video-1", "v1", SHA, new MultitrackRenderPlanner.Time(2, 1),
                        new MultitrackRenderPlanner.Time(5, 1), new MultitrackRenderPlanner.Time(10, 1),
                        List.of(new MultitrackRenderPlanner.Time(5, 1), new MultitrackRenderPlanner.Time(11, 2),
                                new MultitrackRenderPlanner.Time(7, 1)))),
                List.of(new MultitrackRenderPlanner.Caption("cap-1", new MultitrackRenderPlanner.Time(3, 1),
                        new MultitrackRenderPlanner.Time(4, 1), "A caption")),
                List.of(), 10_000);

        var first = MultitrackRenderPlanner.plan(graph).plan();
        var second = MultitrackRenderPlanner.plan(graph).plan();

        assertThat(first.frameMap()).extracting(MultitrackRenderPlanner.MappedFrame::sourcePts)
                .containsExactly(new MultitrackRenderPlanner.Time(5, 1), new MultitrackRenderPlanner.Time(11, 2),
                        new MultitrackRenderPlanner.Time(7, 1));
        assertThat(first.frameMap()).extracting(MultitrackRenderPlanner.MappedFrame::timelinePts)
                .containsExactly(new MultitrackRenderPlanner.Time(2, 1), new MultitrackRenderPlanner.Time(5, 2),
                        new MultitrackRenderPlanner.Time(4, 1));
        assertThat(first.canonicalManifest()).contains("caption=cap-1|3/1|4/1|");
        assertThat(first.manifestSha256()).hasSize(64).isEqualTo(second.manifestSha256());
    }

    @Test
    void rejectsNonMonotonicOrOutOfClipVfrTimestamps() {
        assertThatIllegalArgumentException().isThrownBy(() -> video("v", new MultitrackRenderPlanner.Time(0, 1),
                List.of(new MultitrackRenderPlanner.Time(0, 1), new MultitrackRenderPlanner.Time(1, 2),
                        new MultitrackRenderPlanner.Time(1, 2))));
        assertThatIllegalArgumentException().isThrownBy(() -> video("v", new MultitrackRenderPlanner.Time(0, 1),
                List.of(new MultitrackRenderPlanner.Time(0, 1), new MultitrackRenderPlanner.Time(11, 1))));
    }

    @Test
    void rejectsCaptionOutsideGraphAndTransitionWithoutSharedCoverage() {
        var clip = video("v", new MultitrackRenderPlanner.Time(0, 1), List.of(new MultitrackRenderPlanner.Time(0, 1)));
        var outsideCaption = new MultitrackRenderPlanner.Graph(List.of(clip),
                List.of(new MultitrackRenderPlanner.Caption("c", new MultitrackRenderPlanner.Time(11, 1),
                        new MultitrackRenderPlanner.Time(12, 1), "late")), List.of(), 1_000);
        assertThatIllegalArgumentException().isThrownBy(() -> MultitrackRenderPlanner.plan(outsideCaption));
        var duplicateCaptions = new MultitrackRenderPlanner.Graph(List.of(clip),
                List.of(new MultitrackRenderPlanner.Caption("same", new MultitrackRenderPlanner.Time(1, 1),
                                new MultitrackRenderPlanner.Time(2, 1), "first"),
                        new MultitrackRenderPlanner.Caption("same", new MultitrackRenderPlanner.Time(2, 1),
                                new MultitrackRenderPlanner.Time(3, 1), "second")), List.of(), 1_000);
        assertThatIllegalArgumentException().isThrownBy(() -> MultitrackRenderPlanner.plan(duplicateCaptions));

        var left = video("left", new MultitrackRenderPlanner.Time(0, 1), List.of(new MultitrackRenderPlanner.Time(0, 1)));
        var right = video("right", new MultitrackRenderPlanner.Time(2, 1), List.of(new MultitrackRenderPlanner.Time(0, 1)));
        var invalidTransition = new MultitrackRenderPlanner.Transition("x", "left", "right",
                MultitrackRenderPlanner.TransitionKind.CROSSFADE, new MultitrackRenderPlanner.Time(1, 2),
                new MultitrackRenderPlanner.Time(1, 1));
        var graph = new MultitrackRenderPlanner.Graph(List.of(left, right), List.of(), List.of(invalidTransition), 1_000);
        assertThatIllegalArgumentException().isThrownBy(() -> MultitrackRenderPlanner.plan(graph));
    }

    @Test
    void rejectsExcessiveDurationAndOutputBudget() {
        var beyondDay = video("long", new MultitrackRenderPlanner.Time(0, 1), List.of(new MultitrackRenderPlanner.Time(0, 1)),
                new MultitrackRenderPlanner.Time(86_401, 1));
        assertThatIllegalArgumentException().isThrownBy(() -> MultitrackRenderPlanner.plan(
                new MultitrackRenderPlanner.Graph(List.of(beyondDay), List.of(), List.of(), 1_000)));
        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Graph(
                List.of(video("v", new MultitrackRenderPlanner.Time(0, 1), List.of(new MultitrackRenderPlanner.Time(0, 1)))),
                List.of(), List.of(), MultitrackRenderPlanner.MAX_DECLARED_OUTPUT_BYTES + 1));
    }

    @Test
    void codecExecutionNeverTurnsManifestIntoClaimedPlayableOutput() {
        var plan = MultitrackRenderPlanner.plan(new MultitrackRenderPlanner.Graph(
                List.of(video("v", new MultitrackRenderPlanner.Time(0, 1), List.of(new MultitrackRenderPlanner.Time(0, 1)))),
                List.of(), List.of(), 1_000)).plan();

        var noPipeline = MultitrackRenderPlanner.execute(plan, null);
        var unadmitted = MultitrackRenderPlanner.execute(plan, new Pipeline(false, true));
        var unavailable = MultitrackRenderPlanner.execute(plan, new Pipeline(true, false));
        var noImplementation = MultitrackRenderPlanner.execute(plan, new Pipeline(true, true));

        assertThat(noPipeline.outcome()).isEqualTo(MultitrackRenderPlanner.Outcome.NOT_ADMITTED);
        assertThat(unadmitted.reason()).isEqualTo(MultitrackRenderPlanner.Reason.CODEC_PIPELINE_NOT_ADMITTED);
        assertThat(unavailable.outcome()).isEqualTo(MultitrackRenderPlanner.Outcome.UNAVAILABLE);
        assertThat(noImplementation.outcome()).isEqualTo(MultitrackRenderPlanner.Outcome.UNAVAILABLE);
        assertThat(noImplementation.plan()).isNull();
    }

    private static MultitrackRenderPlanner.Clip video(String id, MultitrackRenderPlanner.Time timelineStart,
            List<MultitrackRenderPlanner.Time> pts) {
        return video(id, timelineStart, pts, new MultitrackRenderPlanner.Time(10, 1));
    }

    private static MultitrackRenderPlanner.Clip video(String id, MultitrackRenderPlanner.Time timelineStart,
            List<MultitrackRenderPlanner.Time> pts, MultitrackRenderPlanner.Time sourceEnd) {
        return new MultitrackRenderPlanner.Clip(id, MultitrackRenderPlanner.Modality.VIDEO, "artifact-" + id,
                "v1", SHA, timelineStart, new MultitrackRenderPlanner.Time(0, 1), sourceEnd, pts);
    }

    private record Pipeline(boolean admitted, boolean available) implements MultitrackRenderPlanner.CodecPipeline { }
}
