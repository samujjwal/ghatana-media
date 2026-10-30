package com.ghatana.video.streaming;

import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Qualified video transport profiles, bounded codec plans and owned immutable
 * captured-artifact versions.
 *
 * <p>VS-05: only transports and codecs with a real implementation are
 * qualified. The module's own in-process transport is qualified — it is the
 * same wire encode/decode path proven by tests. WebRTC, adaptive-HTTP, HLS
 * and DASH are declared but {@link Qualification#UNQUALIFIED}; an unqualified
 * transport or an unpinned codec resolves to {@code UNAVAILABLE}, never to a
 * fabricated accessible stream or a spawned process from a raw caller string.
 *
 * <p>Captured frames seal into an immutable {@link CapturedMediaArtifact}
 * carrying its exact version, SHA-256 over the captured payloads, source
 * transport and provenance — the artifact is owned by this module and cannot
 * be mutated after sealing.
 *
 * @doc.type class
 * @doc.purpose Transport qualification + bounded codec + immutable capture
 * @doc.layer product
 * @doc.pattern Value Objects
 */
public final class VideoCaptureProfile {

    private VideoCaptureProfile() {
    }

    /** Declared transport profiles; declaration is not qualification. */
    public enum TransportKind {
        /** The module's own qualified in-process wire transport. */
        IN_PROCESS,
        WEBRTC,
        ADAPTIVE_HTTP,
        HLS,
        DASH
    }

    /** Whether a transport or codec has a real implementation behind it. */
    public enum Qualification {
        /** Real implementation exists and is exercised by tests. */
        QUALIFIED,
        /** Declared only — no qualified implementation; resolves UNAVAILABLE. */
        UNQUALIFIED
    }

    /**
     * Exact transport qualification. Only {@link TransportKind#IN_PROCESS} is
     * qualified; every external transport remains unqualified until a real,
     * eligible public transport is integrated.
     */
    private static final Map<TransportKind, Qualification> TRANSPORTS = Map.of(
            TransportKind.IN_PROCESS, Qualification.QUALIFIED,
            TransportKind.WEBRTC, Qualification.UNQUALIFIED,
            TransportKind.ADAPTIVE_HTTP, Qualification.UNQUALIFIED,
            TransportKind.HLS, Qualification.UNQUALIFIED,
            TransportKind.DASH, Qualification.UNQUALIFIED);

    /** The only codec pinned to a real implementation: the module wire codec. */
    private static final Set<String> PINNED_CODECS = Set.of("media-wire-v1");

    /** Absolute bounds for any codec plan — enforced before a plan exists. */
    public static final int MAX_CODEC_FRAMES = 10_000;
    public static final long MAX_CODEC_INPUT_BYTES = 1L << 30; // 1 GiB
    public static final long MAX_CODEC_DURATION_MS = 10 * 60_000L;

    /** Transport qualification lookup — unqualified never resolves as usable. */
    public static Qualification transportQualification(TransportKind kind) {
        return TRANSPORTS.get(Objects.requireNonNull(kind, "kind"));
    }

    /** True only when the transport has a real implementation behind it. */
    public static boolean isTransportUsable(TransportKind kind) {
        return transportQualification(kind) == Qualification.QUALIFIED;
    }

    /**
     * Typed, bounded codec plan — the only way to request a codec transform.
     * The codec ID must be from the pinned set; frame, byte and duration
     * bounds are enforced at construction. There is deliberately no API that
     * accepts a raw command string or free-form argument list.
     */
    public record BoundedCodecPlan(
            String codecId,
            int maxFrames,
            long maxInputBytes,
            long maxDurationMillis) {
        public BoundedCodecPlan {
            Objects.requireNonNull(codecId, "codecId");
            if (maxFrames < 1 || maxFrames > MAX_CODEC_FRAMES) {
                throw new IllegalArgumentException(
                        "codec plan frames outside bound 1.." + MAX_CODEC_FRAMES);
            }
            if (maxInputBytes < 1 || maxInputBytes > MAX_CODEC_INPUT_BYTES) {
                throw new IllegalArgumentException(
                        "codec plan input bytes outside bound 1.." + MAX_CODEC_INPUT_BYTES);
            }
            if (maxDurationMillis < 1 || maxDurationMillis > MAX_CODEC_DURATION_MS) {
                throw new IllegalArgumentException(
                        "codec plan duration outside bound 1.." + MAX_CODEC_DURATION_MS);
            }
        }

        /** Whether the pinned codec is available — unpinned is UNAVAILABLE. */
        public boolean codecAvailable() {
            return PINNED_CODECS.contains(codecId);
        }
    }

    /** Codec eligibility: a plan is usable only when its codec is pinned. */
    public enum CodecEligibility { AVAILABLE, UNAVAILABLE }

    public static CodecEligibility codecEligibility(BoundedCodecPlan plan) {
        return plan.codecAvailable() ? CodecEligibility.AVAILABLE : CodecEligibility.UNAVAILABLE;
    }

    /**
     * An owned, immutable captured-media artifact. Sealed at construction:
     * the version, frame count and SHA-256 over all captured payloads are
     * fixed; the source transport and provenance references are recorded
     * verbatim.
     */
    public record CapturedMediaArtifact(
            String artifactId,
            String artifactVersion,
            TransportKind sourceTransport,
            int frameCount,
            long capturedBytes,
            String sha256,
            String provenanceRef) {
        public CapturedMediaArtifact {
            Objects.requireNonNull(artifactId, "artifactId");
            Objects.requireNonNull(artifactVersion, "artifactVersion");
            Objects.requireNonNull(sourceTransport, "sourceTransport");
            Objects.requireNonNull(sha256, "sha256");
            Objects.requireNonNull(provenanceRef, "provenanceRef");
            if (!sha256.matches("[a-f0-9]{64}")) {
                throw new IllegalArgumentException("captured artifact digest must be SHA-256 hex");
            }
            if (frameCount < 0 || capturedBytes < 0) {
                throw new IllegalArgumentException("captured artifact counters must be >= 0");
            }
        }
    }

    /**
     * Seals captured frames into an immutable artifact whose digest is the
     * SHA-256 over the exact captured payloads in sequence order.
     */
    public static CapturedMediaArtifact seal(
            String artifactId,
            String artifactVersion,
            TransportKind sourceTransport,
            Iterable<VideoStreamSession.DecodedFrame> frames,
            String provenanceRef) {
        MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
        int count = 0;
        long bytes = 0;
        for (VideoStreamSession.DecodedFrame frame : frames) {
            digest.update(frame.payload());
            count++;
            bytes += frame.payload().length;
        }
        return new CapturedMediaArtifact(
                artifactId, artifactVersion, sourceTransport,
                count, bytes, HexFormat.of().formatHex(digest.digest()), provenanceRef);
    }
}
