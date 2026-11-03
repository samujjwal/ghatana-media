package com.ghatana.audio.streaming;

import com.ghatana.audio.streaming.BoundedAudioFrameDecoder.Codec;
import com.ghatana.audio.streaming.BoundedAudioFrameDecoder.DecodeVerdict;
import com.ghatana.audio.streaming.BoundedAudioFrameDecoder.SessionBudget;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** AS-04: declared codec/timebase only, exact rational positions, bounded budget. */
@DisplayName("BoundedAudioFrameDecoder")
class BoundedAudioFrameDecoderTest {

    private static SessionBudget budget(int frames, long bytes) {
        return new SessionBudget(frames, bytes);
    }

    @Test
    @DisplayName("PCM decodes whole 16-bit samples under its declared timebase")
    void pcmDecodesWithinTimebase() {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declare(
                "pcm_s16le", 1, 48000, budget(10, 1_000_000));
        var result = dec.decode(new byte[960], 4800, false);
        assertThat(result.verdict()).isEqualTo(DecodeVerdict.DECODED);
        assertThat(result.frame().position().numerator()).isEqualTo(4800);
        assertThat(result.frame().position().denominator()).isEqualTo(48000);
        assertThat(result.frame().codec()).isEqualTo(Codec.PCM_S16LE);
    }

    @Test
    @DisplayName("non-unit seconds-per-tick numerator is preserved in exact media time")
    void nonUnitTimebaseNumeratorIsApplied() {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declare(
                "pcm_s16le", 1001, 24000, budget(10, 1_000_000));
        var result = dec.decode(new byte[4], 24, false);

        assertThat(result.verdict()).isEqualTo(DecodeVerdict.DECODED);
        assertThat(result.frame().position().numerator()).isEqualTo(24_024);
        assertThat(result.frame().position().denominator()).isEqualTo(24_000);
        assertThat(dec.timebase().numerator()).isEqualTo(1001);
        assertThat(dec.timebase().denominator()).isEqualTo(24_000);
    }

    @Test
    @DisplayName("an undeclared codec is UNAVAILABLE, never guessed")
    void undeclaredCodecUnavailable() {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declare(
                "aac-latm", 1, 48000, budget(10, 1_000_000));
        var result = dec.decode(new byte[4], 0, false);
        assertThat(result.verdict()).isEqualTo(DecodeVerdict.UNAVAILABLE);
        assertThat(result.frame()).isNull();
    }

    @Test
    @DisplayName("missing source timebase stays unavailable instead of inventing a sample clock")
    void missingTimebaseUnavailable() {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declareWithoutTimebase(
                "pcm_s16le", budget(10, 1_000_000));

        var result = dec.decode(new byte[4], 0, false);

        assertThat(result.verdict()).isEqualTo(DecodeVerdict.UNAVAILABLE);
        assertThat(result.frame()).isNull();
        assertThat(result.reason()).contains("timebase is not declared");
        assertThat(dec.timebase()).isNull();
        assertThat(dec.framesDecoded()).isZero();
        assertThat(dec.bytesDecoded()).isZero();
    }

    @Test
    @DisplayName("missing timebase does not hide malformed PCM or exhausted byte budgets")
    void missingTimebasePreservesInputAndBudgetVerdicts() {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declareWithoutTimebase(
                "pcm_s16le", budget(10, 2));

        assertThat(dec.decode(null, 0, false).verdict()).isEqualTo(DecodeVerdict.MALFORMED);
        assertThat(dec.decode(new byte[0], 0, false).verdict()).isEqualTo(DecodeVerdict.MALFORMED);
        assertThat(dec.decode(new byte[3], 0, false).verdict()).isEqualTo(DecodeVerdict.MALFORMED);
        assertThat(dec.decode(new byte[2], -1, false).verdict()).isEqualTo(DecodeVerdict.MALFORMED);
        assertThat(dec.decode(new byte[AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES + 2], 0, false)
                .verdict()).isEqualTo(DecodeVerdict.BUDGET_EXCEEDED);
        assertThat(dec.decode(new byte[2], 0, false).verdict()).isEqualTo(DecodeVerdict.UNAVAILABLE);
        assertThat(dec.decode(new byte[4], 0, false).verdict()).isEqualTo(DecodeVerdict.BUDGET_EXCEEDED);
        assertThat(dec.framesDecoded()).isZero();
        assertThat(dec.bytesDecoded()).isZero();
    }

    @Test
    @DisplayName("odd-byte PCM payload and negative position are MALFORMED")
    void malformedShapesRejected() {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declare(
                "pcm_s16le", 1, 48000, budget(10, 1_000_000));
        assertThat(dec.decode(new byte[3], 0, false).verdict())
                .isEqualTo(DecodeVerdict.MALFORMED);
        assertThat(dec.decode(new byte[4], -1, false).verdict())
                .isEqualTo(DecodeVerdict.MALFORMED);
        assertThat(dec.decode(new byte[0], 0, false).verdict())
                .isEqualTo(DecodeVerdict.MALFORMED);
    }

    @Test
    @DisplayName("a faster-than-budget producer is bounded by frame and byte caps")
    void budgetBoundsProducer() {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declare(
                "pcm_s16le", 1, 48000, budget(2, 8));
        assertThat(dec.decode(new byte[4], 0, false).verdict()).isEqualTo(DecodeVerdict.DECODED);
        assertThat(dec.decode(new byte[4], 100, false).verdict()).isEqualTo(DecodeVerdict.DECODED);
        assertThat(dec.decode(new byte[4], 200, false).verdict())
                .isEqualTo(DecodeVerdict.BUDGET_EXCEEDED); // 3rd frame over maxFrames
        BoundedAudioFrameDecoder bytesOnly = BoundedAudioFrameDecoder.declare(
                "pcm_s16le", 1, 48000, budget(100, 8));
        bytesOnly.decode(new byte[4], 0, false);
        bytesOnly.decode(new byte[4], 1, false);
        assertThat(bytesOnly.decode(new byte[2], 2, false).verdict())
                .isEqualTo(DecodeVerdict.BUDGET_EXCEEDED); // 10 bytes > maxBytes 8
    }

    private static List<BoundedAudioFrameDecoder.Result> decodeTwoConcurrently(
            BoundedAudioFrameDecoder dec) throws Exception {
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        ExecutorService workers = Executors.newFixedThreadPool(2);

        try {
            Future<BoundedAudioFrameDecoder.Result> first = workers.submit(() -> {
                ready.countDown();
                if (!start.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("concurrent decode start timed out");
                }
                return dec.decode(new byte[2], 0, false);
            });
            Future<BoundedAudioFrameDecoder.Result> second = workers.submit(() -> {
                ready.countDown();
                if (!start.await(5, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("concurrent decode start timed out");
                }
                return dec.decode(new byte[2], 1, false);
            });

            assertThat(ready.await(5, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            return List.of(
                    first.get(5, TimeUnit.SECONDS), second.get(5, TimeUnit.SECONDS));
        } finally {
            start.countDown();
            workers.shutdownNow();
            assertThat(workers.awaitTermination(5, TimeUnit.SECONDS)).isTrue();
        }
    }

    @Test
    @DisplayName("concurrent decodes cannot oversubscribe the per-session frame budget")
    void concurrentDecodesReserveFrameBudgetAtomically() throws Exception {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declare(
                "pcm_s16le", 1, 48000, budget(1, 4));

        List<BoundedAudioFrameDecoder.Result> results = decodeTwoConcurrently(dec);

        assertThat(results).extracting(BoundedAudioFrameDecoder.Result::verdict)
                .containsExactlyInAnyOrder(DecodeVerdict.DECODED, DecodeVerdict.BUDGET_EXCEEDED);
        assertThat(dec.framesDecoded()).isEqualTo(1);
        assertThat(dec.bytesDecoded()).isEqualTo(2);
        assertThat(dec.framesDecoded()).isLessThanOrEqualTo(1);
    }

    @Test
    @DisplayName("concurrent decodes cannot oversubscribe the per-session byte budget")
    void concurrentDecodesReserveByteBudgetAtomically() throws Exception {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declare(
                "pcm_s16le", 1, 48000, budget(2, 2));

        List<BoundedAudioFrameDecoder.Result> results = decodeTwoConcurrently(dec);

        assertThat(results).extracting(BoundedAudioFrameDecoder.Result::verdict)
                .containsExactlyInAnyOrder(DecodeVerdict.DECODED, DecodeVerdict.BUDGET_EXCEEDED);
        assertThat(dec.framesDecoded()).isEqualTo(1);
        assertThat(dec.bytesDecoded()).isEqualTo(2);
        assertThat(dec.bytesDecoded()).isLessThanOrEqualTo(2);
    }

    @Test
    @DisplayName("a single PCM frame is bounded before the decoder copies it")
    void oversizedSingleFrameDoesNotAdvanceSessionBudget() {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declare(
                "pcm_s16le", 1, 48000, budget(Integer.MAX_VALUE, Long.MAX_VALUE));
        byte[] oversized = new byte[AudioStreamSession.MAX_FRAME_PAYLOAD_BYTES + 2];

        var result = dec.decode(oversized, 0, false);

        assertThat(result.verdict()).isEqualTo(DecodeVerdict.BUDGET_EXCEEDED);
        assertThat(result.frame()).isNull();
        assertThat(dec.framesDecoded()).isZero();
        assertThat(dec.bytesDecoded()).isZero();
    }

    @Test
    @DisplayName("a VAD/caption partial revision is marked non-final")
    void partialRevisionMarked() {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declare(
                "pcm_s16le", 1, 48000, budget(10, 1_000_000));
        var result = dec.decode(new byte[8], 480, true);
        assertThat(result.frame().partialRevision()).isTrue();
    }

    @Test
    @DisplayName("OPUS declaration abstains instead of labeling arbitrary bytes decoded")
    void opusWithoutDecoderIsUnavailable() {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declare(
                "opus", 1, 48000, budget(10, 1_000_000));

        var result = dec.decode(new byte[]{1, 2, 3}, 0, false);

        assertThat(result.verdict()).isEqualTo(DecodeVerdict.UNAVAILABLE);
        assertThat(result.frame()).isNull();
        assertThat(dec.framesDecoded()).isZero();
        assertThat(dec.bytesDecoded()).isZero();
    }

    @Test
    @DisplayName("timebase must have a positive seconds-per-tick numerator")
    void rejectsNonPositiveTimebaseNumerator() {
        assertThatThrownBy(() -> BoundedAudioFrameDecoder.declare(
                "pcm_s16le", 0, 48000, budget(1, 4)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("timebase numerator");
    }

    @Test
    @DisplayName("rational position multiplication overflow is malformed")
    void positionOverflowIsMalformed() {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declare(
                "pcm_s16le", Long.MAX_VALUE, 1, budget(10, 100));

        assertThat(dec.decode(new byte[2], 2, false).verdict())
                .isEqualTo(DecodeVerdict.MALFORMED);
        assertThat(dec.framesDecoded()).isZero();
        assertThat(dec.bytesDecoded()).isZero();
    }

    @Test
    @DisplayName("decoded payload is isolated from source and accessor mutation")
    void decodedPayloadIsDefensivelyCopied() {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declare(
                "pcm_s16le", 1, 48000, budget(10, 1_000_000));
        byte[] source = new byte[]{1, 2, 3, 4};

        var result = dec.decode(source, 0, false);
        source[0] = 9;
        byte[] exposed = result.frame().payload();
        exposed[1] = 8;

        assertThat(result.frame().payload()).containsExactly(1, 2, 3, 4);
        assertThat(dec.bytesDecoded()).isEqualTo(4);
        assertThat(dec.framesDecoded()).isEqualTo(1);
    }
}
