package com.ghatana.audio.streaming;

import com.ghatana.audio.streaming.BoundedAudioFrameDecoder.Codec;
import com.ghatana.audio.streaming.BoundedAudioFrameDecoder.DecodeVerdict;
import com.ghatana.audio.streaming.BoundedAudioFrameDecoder.SessionBudget;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

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
    @DisplayName("an undeclared codec is UNAVAILABLE, never guessed")
    void undeclaredCodecUnavailable() {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declare(
                "aac-latm", 1, 48000, budget(10, 1_000_000));
        var result = dec.decode(new byte[4], 0, false);
        assertThat(result.verdict()).isEqualTo(DecodeVerdict.UNAVAILABLE);
        assertThat(result.frame()).isNull();
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
                "opus", 1, 48000, budget(2, 8));
        assertThat(dec.decode(new byte[4], 0, false).verdict()).isEqualTo(DecodeVerdict.DECODED);
        assertThat(dec.decode(new byte[4], 100, false).verdict()).isEqualTo(DecodeVerdict.DECODED);
        assertThat(dec.decode(new byte[4], 200, false).verdict())
                .isEqualTo(DecodeVerdict.BUDGET_EXCEEDED); // 3rd frame over maxFrames
        BoundedAudioFrameDecoder bytesOnly = BoundedAudioFrameDecoder.declare(
                "opus", 1, 48000, budget(100, 8));
        bytesOnly.decode(new byte[4], 0, false);
        bytesOnly.decode(new byte[4], 1, false);
        assertThat(bytesOnly.decode(new byte[1], 2, false).verdict())
                .isEqualTo(DecodeVerdict.BUDGET_EXCEEDED); // 9 bytes > maxBytes 8
    }

    @Test
    @DisplayName("a VAD/caption partial revision is marked non-final")
    void partialRevisionMarked() {
        BoundedAudioFrameDecoder dec = BoundedAudioFrameDecoder.declare(
                "opus", 1, 48000, budget(10, 1_000_000));
        var result = dec.decode(new byte[8], 480, true);
        assertThat(result.frame().partialRevision()).isTrue();
    }
}
