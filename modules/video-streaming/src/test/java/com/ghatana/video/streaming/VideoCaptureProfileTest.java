package com.ghatana.video.streaming;

import com.ghatana.video.streaming.VideoCaptureProfile.BoundedCodecPlan;
import com.ghatana.video.streaming.VideoCaptureProfile.CodecEligibility;
import com.ghatana.video.streaming.VideoCaptureProfile.Qualification;
import com.ghatana.video.streaming.VideoCaptureProfile.TransportKind;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * VS-05: real qualified-transport smoke with decoded frame readback;
 * unqualified transports and unpinned codecs resolve unavailable; captured
 * artifacts are immutable versions with exact provenance and digest.
 */
@DisplayName("VideoCaptureProfile + InProcessVideoTransport")
class VideoCaptureProfileTest {

    private static VideoStreamSession.DecodedFrame frame(int seq, boolean key, byte fill) {
        return new VideoStreamSession.DecodedFrame(seq, key, seq * 33L, new byte[]{fill, fill});
    }

    @Test
    @DisplayName("the one qualified transport smokes a real encode→transfer→decode readback")
    void qualifiedTransportReadback() {
        assertThat(VideoCaptureProfile.isTransportUsable(TransportKind.IN_PROCESS)).isTrue();
        InProcessVideoTransport transport = new InProcessVideoTransport();
        List<VideoStreamSession.DecodedFrame> sent = List.of(
                frame(0, true, (byte) 0x11), frame(1, false, (byte) 0x22), frame(2, false, (byte) 0x33));
        for (var f : sent) {
            assertThat(transport.send(f)).isTrue();
        }
        List<VideoStreamSession.DecodedFrame> read = new ArrayList<>();
        transport.drainInto(read);
        // Exact readback: sequence, keyframe flag, PTS and payload bytes preserved.
        assertThat(read).hasSameSizeAs(sent);
        for (int i = 0; i < sent.size(); i++) {
            assertThat(read.get(i).sequenceNumber()).isEqualTo(sent.get(i).sequenceNumber());
            assertThat(read.get(i).keyFrame()).isEqualTo(sent.get(i).keyFrame());
            assertThat(read.get(i).timestampMillis()).isEqualTo(sent.get(i).timestampMillis());
            assertThat(read.get(i).payload()).isEqualTo(sent.get(i).payload());
        }
    }

    @Test
    @DisplayName("WebRTC/adaptive-HTTP/HLS/DASH are unqualified — no fabricated accessible stream")
    void externalTransportsUnqualified() {
        for (TransportKind kind : new TransportKind[]{
                TransportKind.WEBRTC, TransportKind.ADAPTIVE_HTTP,
                TransportKind.HLS, TransportKind.DASH}) {
            assertThat(VideoCaptureProfile.transportQualification(kind))
                    .as(kind.name()).isEqualTo(Qualification.UNQUALIFIED);
            assertThat(VideoCaptureProfile.isTransportUsable(kind)).as(kind.name()).isFalse();
        }
    }

    @Test
    @DisplayName("unpinned codec and out-of-bound plans are unavailable or rejected")
    void codecEligibilityBounded() {
        BoundedCodecPlan pinned = new BoundedCodecPlan("media-wire-v1", 100, 1_000_000, 60_000);
        assertThat(VideoCaptureProfile.codecEligibility(pinned))
                .isEqualTo(CodecEligibility.AVAILABLE);
        BoundedCodecPlan unpinned = new BoundedCodecPlan("ffmpeg-h264", 100, 1_000_000, 60_000);
        assertThat(VideoCaptureProfile.codecEligibility(unpinned))
                .isEqualTo(CodecEligibility.UNAVAILABLE);
        assertThatThrownBy(() -> new BoundedCodecPlan("media-wire-v1", 0, 1, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new BoundedCodecPlan(
                "media-wire-v1", VideoCaptureProfile.MAX_CODEC_FRAMES + 1, 1, 1))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new BoundedCodecPlan(
                "media-wire-v1", 1, VideoCaptureProfile.MAX_CODEC_INPUT_BYTES + 1, 1))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    @DisplayName("captured frames seal into an immutable artifact with exact digest and provenance")
    void sealedArtifactImmutable() throws Exception {
        InProcessVideoTransport transport = new InProcessVideoTransport();
        List<VideoStreamSession.DecodedFrame> sent = List.of(
                frame(0, true, (byte) 0xAA), frame(1, false, (byte) 0xBB));
        sent.forEach(transport::send);
        List<VideoStreamSession.DecodedFrame> captured = new ArrayList<>();
        transport.drainInto(captured);

        var artifact = VideoCaptureProfile.seal(
                "artifact-1", "v1", TransportKind.IN_PROCESS, captured, "run-7/job-3");
        MessageDigest expected = MessageDigest.getInstance("SHA-256");
        for (var f : sent) {
            expected.update(f.payload());
        }
        assertThat(artifact.sha256())
                .isEqualTo(HexFormat.of().formatHex(expected.digest()));
        assertThat(artifact.frameCount()).isEqualTo(2);
        assertThat(artifact.capturedBytes()).isEqualTo(4);
        assertThat(artifact.sourceTransport()).isEqualTo(TransportKind.IN_PROCESS);
        assertThat(artifact.provenanceRef()).isEqualTo("run-7/job-3");
    }

    @Test
    @DisplayName("transport backpressure rejects beyond the bounded in-flight queue")
    void boundedInFlight() {
        InProcessVideoTransport transport = new InProcessVideoTransport();
        for (int i = 0; i < InProcessVideoTransport.MAX_IN_FLIGHT; i++) {
            assertThat(transport.send(frame(i, i == 0, (byte) 1))).isTrue();
        }
        assertThat(transport.send(frame(InProcessVideoTransport.MAX_IN_FLIGHT, false, (byte) 1)))
                .isFalse();
        assertThat(transport.inFlightCount()).isEqualTo(InProcessVideoTransport.MAX_IN_FLIGHT);
    }
}
