package com.ghatana.media.production.rendering;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.AbstractList;
import java.util.List;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import org.junit.jupiter.api.Test;

class MultitrackRenderPlannerTest {
    private static final String SHA = "a".repeat(64);

    @Test
    void boundedOutputAcceptsExactCapAndExposesDigestOnlyAfterCleanClose() throws Exception {
        var destination = new ByteArrayOutputStream();
        var output = new BoundedRenderOutput(destination, 5);
        output.write("ab".getBytes(StandardCharsets.UTF_8));
        output.write("cde".getBytes(StandardCharsets.UTF_8));

        assertThat(output.bytesWritten()).isEqualTo(5);
        assertThat(output.completedSha256()).isNull();
        output.close();

        assertThat(destination.toString(StandardCharsets.UTF_8)).isEqualTo("abcde");
        assertThat(output.completedSha256()).isEqualTo(HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest("abcde".getBytes(StandardCharsets.UTF_8))));
    }

    @Test
    void boundedOutputRejectsOverCapBeforeDelegateReceivesAnyOverflowBytes() throws Exception {
        var destination = new ByteArrayOutputStream();
        var output = new BoundedRenderOutput(destination, 4);
        output.write("abc".getBytes(StandardCharsets.UTF_8));

        assertThatThrownBy(() -> output.write("de".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(IOException.class).hasMessageContaining("budget exceeded");
        assertThat(destination.toString(StandardCharsets.UTF_8)).isEqualTo("abc");
        assertThat(output.bytesWritten()).isEqualTo(3);
        output.close();
        assertThat(output.completedSha256()).isNull();
    }

    @Test
    void failedDelegateWriteInvalidatesPartialOutputAndClosesDestinationForCleanup() {
        var state = new FailingDestination();
        var output = new BoundedRenderOutput(state, 8);

        assertThatThrownBy(() -> output.write("abc".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(IOException.class).hasMessage("simulated partial write");
        assertThat(output.bytesWritten()).isZero();
        try {
            output.close();
        } catch (IOException e) {
            throw new AssertionError("cleanup close should succeed", e);
        }
        assertThat(state.partialWriteAttempted).isTrue();
        assertThat(state.closed).isTrue();
        assertThat(output.completedSha256()).isNull();
    }

    @Test
    void fatalDelegateFailureAfterPartialWriteCannotExposeACompletedDigest() {
        var state = new FatalPartialWriteDestination();
        var output = new BoundedRenderOutput(state, 8);

        assertThatThrownBy(() -> output.write("abc".getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(AssertionError.class).hasMessage("simulated fatal partial write");
        assertThat(state.emitted.toString(StandardCharsets.UTF_8)).isEqualTo("a");
        assertThat(output.bytesWritten()).isZero();
        try {
            output.close();
        } catch (IOException e) {
            throw new AssertionError("cleanup close should succeed", e);
        }
        assertThat(output.completedSha256()).isNull();
    }

    @Test
    void boundedOutputClosesAndInvalidatesAfterDestinationCloseFailure() {
        var state = new FailingDestination();
        state.failWrite = false;
        state.failClose = true;
        var output = new BoundedRenderOutput(state, 8);
        try {
            output.write(1);
        } catch (IOException e) {
            throw new AssertionError("write should succeed", e);
        }
        assertThatThrownBy(output::close).isInstanceOf(IOException.class).hasMessage("simulated close failure");
        assertThat(output.bytesWritten()).isEqualTo(1);
        assertThat(output.completedSha256()).isNull();
    }

    @Test
    void failedDestinationCloseCanBeRetriedForCleanupWithoutExposingDigest() {
        var state = new OutputStream() {
            private int closeAttempts;
            @Override public void write(int value) { }
            @Override public void close() throws IOException {
                if (++closeAttempts == 1) throw new IOException("transient close failure");
            }
        };
        var output = new BoundedRenderOutput(state, 8);

        assertThatThrownBy(output::close).isInstanceOf(IOException.class).hasMessage("transient close failure");
        assertThatThrownBy(() -> output.write(1)).isInstanceOf(IOException.class)
                .hasMessage("render output has failed");
        assertThat(output.completedSha256()).isNull();

        try {
            output.close();
        } catch (IOException e) {
            throw new AssertionError("second cleanup close should succeed", e);
        }
        assertThat(output.completedSha256()).isNull();
    }

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
        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Clip(
                "trimmed", MultitrackRenderPlanner.Modality.VIDEO, "artifact-trimmed", "v1", SHA,
                new MultitrackRenderPlanner.Time(0, 1), new MultitrackRenderPlanner.Time(5, 1),
                new MultitrackRenderPlanner.Time(10, 1), List.of(new MultitrackRenderPlanner.Time(4, 1))));
    }

    @Test
    void rejectsWhitespacePaddedSourceIdentityInsteadOfNormalizingItsVersion() {
        var zero = new MultitrackRenderPlanner.Time(0, 1);
        var end = new MultitrackRenderPlanner.Time(1, 1);

        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Clip(
                "clip", MultitrackRenderPlanner.Modality.VIDEO, "artifact", " v1", SHA,
                zero, zero, end, List.of(zero)));
        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Clip(
                "clip", MultitrackRenderPlanner.Modality.VIDEO, " artifact", "v1", SHA,
                zero, zero, end, List.of(zero)));
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
    void rejectsMalformedUnicodeBeforeCanonicalManifestEncoding() {
        var start = new MultitrackRenderPlanner.Time(0, 1);
        var end = new MultitrackRenderPlanner.Time(1, 1);

        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Caption(
                "high-surrogate", start, end, "\uD800"));
        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Caption(
                "low-surrogate", start, end, "\uDC00"));
        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Caption(
                "split-pair", start, end, "\uD83D x\uDE00"));

        var valid = new MultitrackRenderPlanner.Caption("valid-pair", start, end, "A\uD83D\uDE00");
        var graph = new MultitrackRenderPlanner.Graph(
                List.of(video("v", start, List.of(start))), List.of(valid), List.of(), 1_000);
        var plan = MultitrackRenderPlanner.plan(graph).plan();
        var encodedText = java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(
                "A\uD83D\uDE00".getBytes(StandardCharsets.UTF_8));
        assertThat(plan.canonicalManifest()).contains("caption=valid-pair|0/1|1/1|" + encodedText);
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
    void directPlanConstructorEnforcesDeclaredOutputBudgetCeiling() {
        var start = new MultitrackRenderPlanner.Time(0, 1);

        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Plan(
                MultitrackRenderPlanner.CAPABILITY_ID, "manifest", SHA, start, List.of(),
                MultitrackRenderPlanner.MAX_DECLARED_OUTPUT_BYTES + 1));
        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Plan(
                MultitrackRenderPlanner.CAPABILITY_ID, "manifest", SHA, start, List.of(), 0));
    }

    @Test
    void publicPlanFieldsMustMatchItsCanonicalManifestAndDigest() {
        var start = new MultitrackRenderPlanner.Time(0, 1);
        var graph = new MultitrackRenderPlanner.Graph(
                List.of(video("v", start, List.of(start, new MultitrackRenderPlanner.Time(1, 1)))),
                List.of(), List.of(), 1_000);
        var plan = MultitrackRenderPlanner.plan(graph).plan();

        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Plan(
                plan.capabilityId(), plan.canonicalManifest(), "0".repeat(64), plan.duration(),
                plan.frameMap(), plan.declaredOutputBudgetBytes()))
                .withMessageContaining("SHA-256");
        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Plan(
                plan.capabilityId(), plan.canonicalManifest(), plan.manifestSha256(),
                new MultitrackRenderPlanner.Time(9, 1), plan.frameMap(), plan.declaredOutputBudgetBytes()))
                .withMessageContaining("manifest header");
        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Plan(
                plan.capabilityId(), plan.canonicalManifest(), plan.manifestSha256(), plan.duration(),
                List.of(new MultitrackRenderPlanner.MappedFrame("v", 0,
                        new MultitrackRenderPlanner.Time(1, 1), new MultitrackRenderPlanner.Time(1, 1))),
                plan.declaredOutputBudgetBytes()))
                .withMessageContaining("frame map does not match");
        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Plan(
                "media.dev.other-renderer", plan.canonicalManifest(), plan.manifestSha256(), plan.duration(),
                plan.frameMap(), plan.declaredOutputBudgetBytes()))
                .withMessageContaining("capability id");
    }

    @Test
    void mappedFramesRejectInvalidIndexesAndPlansRejectNonMonotonicSourceTimes() throws Exception {
        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.MappedFrame(
                "clip", -1, new MultitrackRenderPlanner.Time(0, 1), new MultitrackRenderPlanner.Time(0, 1)))
                .withMessageContaining("frame index");
        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.MappedFrame(
                "clip", 0, new MultitrackRenderPlanner.Time(-1, 1), new MultitrackRenderPlanner.Time(0, 1)))
                .withMessageContaining("non-negative");

        var start = new MultitrackRenderPlanner.Time(0, 1);
        var end = new MultitrackRenderPlanner.Time(1, 1);
        var graph = new MultitrackRenderPlanner.Graph(
                List.of(video("v", start, List.of(start, end))), List.of(), List.of(), 1_000);
        var plan = MultitrackRenderPlanner.plan(graph).plan();
        var duplicateIndex = List.of(
                plan.frameMap().get(0),
                new MultitrackRenderPlanner.MappedFrame("v", 0, end, end));
        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Plan(
                plan.capabilityId(), plan.canonicalManifest(), plan.manifestSha256(), plan.duration(),
                duplicateIndex, plan.declaredOutputBudgetBytes()))
                .withMessageContaining("frame map does not match");

        var nonMonotonicMap = List.of(
                new MultitrackRenderPlanner.MappedFrame("v", 0, new MultitrackRenderPlanner.Time(2, 1),
                        new MultitrackRenderPlanner.Time(2, 1)),
                new MultitrackRenderPlanner.MappedFrame("v", 1, end, end));
        String manifest = "multitrack-render-manifest-v1\n"
                + "duration=10/1\n"
                + "output-budget-bytes=1000\n"
                + "clip=v|VIDEO|artifact-v|v1|" + SHA + "|0/1|0/1|10/1\n"
                + "frame=v|0|2/1|2/1\n"
                + "frame=v|1|1/1|1/1\n";
        String manifestDigest = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(manifest.getBytes(StandardCharsets.UTF_8)));
        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Plan(
                MultitrackRenderPlanner.CAPABILITY_ID, manifest, manifestDigest,
                new MultitrackRenderPlanner.Time(10, 1), nonMonotonicMap, 1_000))
                .withMessageContaining("strictly increasing");
    }

    @Test
    void publicPlanRejectsVfrFrameMapThatDoesNotFollowItsClipTimeMapping() throws Exception {
        var timelineStart = new MultitrackRenderPlanner.Time(2, 1);
        var sourcePts = new MultitrackRenderPlanner.Time(5, 1);
        var graph = new MultitrackRenderPlanner.Graph(
                List.of(video("v", timelineStart, List.of(sourcePts))), List.of(), List.of(), 1_000);
        var valid = MultitrackRenderPlanner.plan(graph).plan();
        var wrongFrame = new MultitrackRenderPlanner.MappedFrame("v", 0, sourcePts,
                new MultitrackRenderPlanner.Time(8, 1));
        String forgedManifest = valid.canonicalManifest().replace(
                "frame=v|0|5/1|7/1", "frame=v|0|5/1|8/1");
        String forgedDigest = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(forgedManifest.getBytes(StandardCharsets.UTF_8)));

        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Plan(
                valid.capabilityId(), forgedManifest, forgedDigest, valid.duration(), List.of(wrongFrame),
                valid.declaredOutputBudgetBytes()))
                .withMessageContaining("timeline PTS does not match its canonical clip time map");
    }

    @Test
    void publicPlanDurationMustCoverTheLatestClipEndEvenWithRecomputedDigest() throws Exception {
        var timelineStart = new MultitrackRenderPlanner.Time(2, 1);
        var clip = new MultitrackRenderPlanner.Clip("v", MultitrackRenderPlanner.Modality.VIDEO,
                "artifact-v", "v1", SHA, timelineStart, new MultitrackRenderPlanner.Time(5, 1),
                new MultitrackRenderPlanner.Time(10, 1), List.of(new MultitrackRenderPlanner.Time(5, 1)));
        var valid = MultitrackRenderPlanner.plan(new MultitrackRenderPlanner.Graph(
                List.of(clip), List.of(), List.of(), 1_000)).plan();
        String truncatedManifest = valid.canonicalManifest().replace("duration=7/1", "duration=1/1");
        String digest = HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                .digest(truncatedManifest.getBytes(StandardCharsets.UTF_8)));

        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Plan(
                valid.capabilityId(), truncatedManifest, digest, new MultitrackRenderPlanner.Time(1, 1),
                valid.frameMap(), valid.declaredOutputBudgetBytes()))
                .withMessageContaining("latest canonical clip end");
    }

    @Test
    void publicPlanRejectsManifestClipWithoutMappedFrames() throws Exception {
        var start = new MultitrackRenderPlanner.Time(0, 1);
        var graph = new MultitrackRenderPlanner.Graph(
                List.of(video("v", start, List.of(start))), List.of(), List.of(), 1_000);
        var valid = MultitrackRenderPlanner.plan(graph).plan();
        String ghostClip = "clip=ghost|VIDEO|artifact-ghost|v1|" + SHA + "|0/1|0/1|10/1\n";
        String forgedManifest = valid.canonicalManifest().replace(
                "frame=v|0|0/1|0/1\n", ghostClip + "frame=v|0|0/1|0/1\n");
        String forgedDigest = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(forgedManifest.getBytes(StandardCharsets.UTF_8)));

        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Plan(
                valid.capabilityId(), forgedManifest, forgedDigest, valid.duration(), valid.frameMap(),
                valid.declaredOutputBudgetBytes()))
                .withMessageContaining("clip ids must have exact frame-map coverage");
    }

    @Test
    void publicPlanRejectsUnknownManifestRecordsEvenWhenDigestMatches() throws Exception {
        var start = new MultitrackRenderPlanner.Time(0, 1);
        var valid = MultitrackRenderPlanner.plan(new MultitrackRenderPlanner.Graph(
                List.of(video("v", start, List.of(start))), List.of(), List.of(), 1_000)).plan();
        String forgedManifest = valid.canonicalManifest().replace("frame=v|0|0/1|0/1\n",
                "ignored=uninterpreted\nframe=v|0|0/1|0/1\n");
        String forgedDigest = HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(forgedManifest.getBytes(StandardCharsets.UTF_8)));

        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Plan(
                valid.capabilityId(), forgedManifest, forgedDigest, valid.duration(), valid.frameMap(),
                valid.declaredOutputBudgetBytes()))
                .withMessageContaining("unsupported record");
    }

    @Test
    void rejectsAdvertisedOversizedGraphListBeforeTraversingIt() {
        var traversals = new int[1];
        List<MultitrackRenderPlanner.Clip> oversized = new AbstractList<>() {
            @Override public MultitrackRenderPlanner.Clip get(int index) {
                traversals[0]++;
                throw new AssertionError("oversized input must be rejected before traversal");
            }

            @Override public int size() { return MultitrackRenderPlanner.MAX_CLIPS + 1; }
        };

        assertThatIllegalArgumentException().isThrownBy(() ->
                new MultitrackRenderPlanner.Graph(oversized, List.of(), List.of(), 1_000));
        assertThat(traversals[0]).isZero();
    }

    @Test
    void planFrameMapCopyStopsAtItsBoundWhenListUnderreportsSize() {
        var start = new MultitrackRenderPlanner.Time(0, 1);
        var oversized = new AbstractList<MultitrackRenderPlanner.MappedFrame>() {
            @Override public MultitrackRenderPlanner.MappedFrame get(int index) {
                throw new AssertionError("custom iterator supplies the bounded sequence");
            }

            @Override public int size() { return 0; }

            @Override public java.util.Iterator<MultitrackRenderPlanner.MappedFrame> iterator() {
                return new java.util.Iterator<>() {
                    private int index;

                    @Override public boolean hasNext() {
                        return index <= MultitrackRenderPlanner.MAX_FRAMES_PER_PLAN;
                    }

                    @Override public MultitrackRenderPlanner.MappedFrame next() {
                        index++;
                        return new MultitrackRenderPlanner.MappedFrame("clip", index, start, start);
                    }
                };
            }
        };

        assertThatIllegalArgumentException().isThrownBy(() -> new MultitrackRenderPlanner.Plan(
                MultitrackRenderPlanner.CAPABILITY_ID, "manifest", SHA, start,
                oversized, 1_000)).withMessageContaining("frame map exceeds limit");
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

    private static final class FailingDestination extends OutputStream {
        private boolean closed;
        private boolean partialWriteAttempted;
        private boolean failWrite = true;
        private boolean failClose;

        @Override public void write(int value) throws IOException {
            if (failWrite) {
                partialWriteAttempted = true;
                throw new IOException("simulated partial write");
            }
        }

        @Override public void write(byte[] bytes, int offset, int length) throws IOException {
            if (failWrite) {
                if (length > 0) write(bytes[offset]);
                throw new IOException("simulated partial write");
            }
        }

        @Override public void close() throws IOException {
            closed = true;
            if (failClose) throw new IOException("simulated close failure");
        }
    }

    private static final class FatalPartialWriteDestination extends OutputStream {
        private final ByteArrayOutputStream emitted = new ByteArrayOutputStream();

        @Override public void write(int value) {
            emitted.write(value);
            throw new AssertionError("simulated fatal partial write");
        }
    }
}
