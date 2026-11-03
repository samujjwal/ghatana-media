package com.ghatana.audio.streaming;

import com.ghatana.audio.streaming.BoundedAudioFrameDecoder.DecodeVerdict;
import com.ghatana.audio.streaming.BoundedAudioFrameDecoder.SessionBudget;
import com.ghatana.audio.streaming.StreamFrameReconciler.Disposition;
import com.ghatana.audio.streaming.StreamFrameReconciler.SessionIdentity;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.ArrayList;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** AS-07 deterministic local composition proof; no external transport is exercised. */
@DisplayName("Synthetic PCM frame transport integration")
class AudioPcmTransportIntegrationTest {

    private static final SessionIdentity IDENTITY = new SessionIdentity(
            "as07-fixture-stream", "tenant-fixture", "principal-fixture", "purpose-fixture", 1);

    @Test
    @DisplayName("PCM sample position is checked before ordered local frames and simulated ACK-cursor resume")
    void pcmSamplePositionAndBytesAreCheckedBeforeTransportAndCursorResume() {
        // Signed 16-bit little-endian samples: 0x1234 and -2 (0xfffe).
        byte[] pcm = {(byte) 0x34, (byte) 0x12, (byte) 0xfe, (byte) 0xff};
        BoundedAudioFrameDecoder sourceDecoder = BoundedAudioFrameDecoder.declare(
                "pcm_s16le", 1, 48_000, new SessionBudget(4, 16));
        var source = sourceDecoder.decode(pcm, 4_800, false);
        assertThat(source.verdict()).isEqualTo(DecodeVerdict.DECODED);
        assertThat(source.frame().payload()).containsExactly(pcm);
        assertThat(source.frame().position().numerator()).isEqualTo(4_800);
        assertThat(source.frame().position().denominator()).isEqualTo(48_000);

        AudioStreamSession wire = new AudioStreamSession();
        byte[] frameZeroWire = wire.encodeFrame(0, 100, source.frame().payload());
        byte[] frameOneWire = wire.encodeFrame(1, 200, new byte[]{0, 0, 1, 0});
        AudioStreamSession.DecodedFrame frameZero = wire.decodeFrame(frameZeroWire);
        AudioStreamSession.DecodedFrame frameOne = wire.decodeFrame(frameOneWire);

        StreamFrameReconciler beforeRestart = StreamFrameReconciler.open(IDENTITY);
        assertThat(beforeRestart.offer(frameOne)).isEqualTo(Disposition.HELD);
        assertThat(beforeRestart.nextAck()).isEqualTo(-1);
        assertThat(beforeRestart.offer(frameZero)).isEqualTo(Disposition.DELIVERED);
        List<AudioStreamSession.DecodedFrame> delivered = new ArrayList<>();
        delivered.add(frameZero);
        delivered.add(beforeRestart.takeDelivered());
        assertThat(delivered).extracting(AudioStreamSession.DecodedFrame::sequenceNumber)
                .containsExactly(0, 1);
        assertThat(delivered.get(0).payload()).containsExactly(pcm);
        assertThat(beforeRestart.nextAck()).isEqualTo(1);

        // Model process loss after an externally persisted contiguous ACK. The storage write and
        // actual process restart are outside this fixture; resume receives the supplied cursor.
        StreamFrameReconciler afterRestart = StreamFrameReconciler.resume(IDENTITY, IDENTITY, 1);
        assertThat(afterRestart.pendingCount()).isZero();
        assertThat(afterRestart.pendingBytes()).isZero();
        assertThat(afterRestart.offer(wire.decodeFrame(frameZeroWire))).isEqualTo(Disposition.DUPLICATE);
        assertThat(afterRestart.offer(wire.decodeFrame(wire.encodeFrame(2, 300, pcm))))
                .isEqualTo(Disposition.DELIVERED);
        assertThat(afterRestart.nextAck()).isEqualTo(2);
    }

    @Test
    @DisplayName("local source decode budget reports backpressure instead of accepting more PCM")
    void producerOverBudgetIsNotAdmitted() {
        BoundedAudioFrameDecoder decoder = BoundedAudioFrameDecoder.declare(
                "pcm_s16le", 1, 48_000, new SessionBudget(1, 4));

        assertThat(decoder.decode(new byte[]{1, 0, 2, 0}, 0, false).verdict())
                .isEqualTo(DecodeVerdict.DECODED);
        assertThat(decoder.decode(new byte[]{3, 0}, 2, false).verdict())
                .isEqualTo(DecodeVerdict.BUDGET_EXCEEDED);
        assertThat(decoder.framesDecoded()).isEqualTo(1);
        assertThat(decoder.bytesDecoded()).isEqualTo(4);
    }
}
