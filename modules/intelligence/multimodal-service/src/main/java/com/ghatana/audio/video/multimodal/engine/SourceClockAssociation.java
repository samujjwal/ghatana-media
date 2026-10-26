package com.ghatana.audio.video.multimodal.engine;

import com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.ClockDomain;
import com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.Status;
import java.math.BigInteger;
import java.util.Objects;

/**
 * Package-local candidate mapping for audio and video clocks belonging to one immutable source version.
 *
 * <p>This records source timeline comparability only. It does not measure acoustic/visual sync,
 * authorize the source, or establish that a caller-provided mapping is trustworthy. It remains
 * package-local until the owning source-metadata authority can supply the mapping; absent that
 * authority, production paths must preserve {@code SYNC_UNDETERMINED}.
 */
record SourceClockAssociation(
        String sourceArtifactId,
        String sourceVersionId,
        StreamClock audioClock,
        StreamClock videoClock,
        MappingProvenance provenance,
        long uncertaintyNanos) {

    private static final long MAX_UNCERTAINTY_NANOS = 60_000_000_000L;

    public SourceClockAssociation {
        sourceArtifactId = requireId(sourceArtifactId, "sourceArtifactId");
        sourceVersionId = requireId(sourceVersionId, "sourceVersionId");
        Objects.requireNonNull(audioClock, "audioClock");
        Objects.requireNonNull(videoClock, "videoClock");
        Objects.requireNonNull(provenance, "provenance");
        if (uncertaintyNanos < 0 || uncertaintyNanos > MAX_UNCERTAINTY_NANOS) {
            throw new IllegalArgumentException("Source clock uncertainty is outside the supported bound");
        }
        if (audioClock.discontinuityEpoch() != videoClock.discontinuityEpoch()) {
            throw new IllegalArgumentException("Audio and video clocks must belong to the same discontinuity epoch");
        }
        if (!audioClock.originRef().equals(videoClock.originRef())) {
            throw new IllegalArgumentException("Audio and video clocks must share an identified source origin");
        }
    }

    /** Map an audio sample and video PTS to one exact rational source timeline. */
    public Association associateAudioSampleWithVideoPts(
            String requestedArtifactId,
            String requestedVersionId,
            long requestedDiscontinuityEpoch,
            long audioSampleIndex,
            long videoPts) {
        if (provenance == MappingProvenance.UNAVAILABLE) {
            return Association.undetermined("SOURCE_CLOCK_MAPPING_NOT_ADMITTED");
        }
        if (!sourceArtifactId.equals(requestedArtifactId) || !sourceVersionId.equals(requestedVersionId)) {
            return Association.undetermined("SOURCE_ARTIFACT_VERSION_MISMATCH");
        }
        if (requestedDiscontinuityEpoch != audioClock.discontinuityEpoch()) {
            return Association.undetermined("SOURCE_CLOCK_DISCONTINUITY");
        }
        if (audioSampleIndex < 0) return Association.undetermined("AUDIO_SAMPLE_INDEX_INVALID");

        String timelineClockId = sourceArtifactId + ":" + sourceVersionId + ":source-timeline";
        MediaClockTimestamp audioTime = audioClock.toSourceTimestamp(audioSampleIndex, timelineClockId);
        MediaClockTimestamp videoTime = videoClock.toSourceTimestamp(videoPts, timelineClockId);
        if (!audioTime.isKnown() || !videoTime.isKnown()) {
            return Association.undetermined("MAPPED_TIMESTAMP_OUT_OF_RANGE");
        }
        RationalNanos audioNanos = audioClock.toSourceNanos(audioSampleIndex);
        RationalNanos videoNanos = videoClock.toSourceNanos(videoPts);
        return new Association(
                AssociationStatus.TIMESTAMP_ALIGNED,
                audioTime,
                videoTime,
                audioNanos.subtract(videoNanos),
                uncertaintyNanos,
                provenance,
                null);
    }

    private static String requireId(String value, String label) {
        if (value == null || value.isBlank() || value.length() > 256) {
            throw new IllegalArgumentException(label + " must be a bounded non-empty identifier");
        }
        return value;
    }

    /** One stream's rational clock and source-timeline origin. */
    public record StreamClock(
            String streamId,
            String clockId,
            String originRef,
            long timeBaseNumerator,
            long timeBaseDenominator,
            long sourceOriginNanosNumerator,
            long sourceOriginNanosDenominator,
            long discontinuityEpoch) {

        public StreamClock {
            streamId = requireId(streamId, "streamId");
            clockId = requireId(clockId, "clockId");
            originRef = requireId(originRef, "originRef");
            if (timeBaseNumerator <= 0 || timeBaseDenominator <= 0
                    || timeBaseNumerator > 1_000_000_000L || timeBaseDenominator > 1_000_000_000L
                    || sourceOriginNanosDenominator <= 0 || sourceOriginNanosDenominator > 1_000_000_000L) {
                throw new IllegalArgumentException("Stream clock rational values are outside supported bounds");
            }
        }

        RationalNanos toSourceNanos(long ticks) {
            BigInteger tickNumerator = BigInteger.valueOf(ticks)
                    .multiply(BigInteger.valueOf(timeBaseNumerator))
                    .multiply(BigInteger.valueOf(1_000_000_000L));
            BigInteger originNumerator = BigInteger.valueOf(sourceOriginNanosNumerator);
            BigInteger originDenominator = BigInteger.valueOf(sourceOriginNanosDenominator);
            BigInteger ticksDenominator = BigInteger.valueOf(timeBaseDenominator);
            return new RationalNanos(
                    tickNumerator.multiply(originDenominator)
                            .add(originNumerator.multiply(ticksDenominator)),
                    ticksDenominator.multiply(originDenominator));
        }

        MediaClockTimestamp toSourceTimestamp(long ticks, String commonClockId) {
            RationalNanos time = toSourceNanos(ticks);
            BigInteger secondsNumerator = time.numerator();
            BigInteger secondsDenominator = time.denominator()
                    .multiply(BigInteger.valueOf(1_000_000_000L));
            BigInteger secondsGcd = secondsNumerator.gcd(secondsDenominator);
            secondsNumerator = secondsNumerator.divide(secondsGcd);
            secondsDenominator = secondsDenominator.divide(secondsGcd);
            try {
                return new MediaClockTimestamp(Status.KNOWN,
                        secondsNumerator.longValueExact(), 1L, secondsDenominator.longValueExact(),
                        ClockDomain.SOURCE, commonClockId, null);
            } catch (ArithmeticException overflow) {
                return MediaClockTimestamp.unknown("MAPPED_TIMESTAMP_OUT_OF_RANGE");
            }
        }
    }

    /** Exact rational nanoseconds; negative video PTS values remain representable. */
    public record RationalNanos(BigInteger numerator, BigInteger denominator) {
        public RationalNanos {
            Objects.requireNonNull(numerator, "numerator");
            Objects.requireNonNull(denominator, "denominator");
            if (denominator.signum() <= 0) throw new IllegalArgumentException("denominator must be positive");
            BigInteger gcd = numerator.gcd(denominator);
            numerator = numerator.divide(gcd);
            denominator = denominator.divide(gcd);
        }

        public RationalNanos subtract(RationalNanos other) {
            Objects.requireNonNull(other, "other");
            return new RationalNanos(numerator.multiply(other.denominator)
                    .subtract(other.numerator.multiply(denominator)), denominator.multiply(other.denominator));
        }
    }

    public record Association(
            AssociationStatus status,
            MediaClockTimestamp audioSourceTime,
            MediaClockTimestamp videoSourceTime,
            RationalNanos audioMinusVideoNanos,
            long uncertaintyNanos,
            MappingProvenance provenance,
            String reason) {

        public Association {
            Objects.requireNonNull(status, "status");
            if (status == AssociationStatus.TIMESTAMP_ALIGNED) {
                Objects.requireNonNull(audioSourceTime, "audioSourceTime");
                Objects.requireNonNull(videoSourceTime, "videoSourceTime");
                Objects.requireNonNull(audioMinusVideoNanos, "audioMinusVideoNanos");
                Objects.requireNonNull(provenance, "provenance");
                if (!audioSourceTime.sharesClock(videoSourceTime)
                        || audioSourceTime.domain() != ClockDomain.SOURCE
                        || provenance == MappingProvenance.UNAVAILABLE || reason != null) {
                    throw new IllegalArgumentException("Aligned timestamps require admitted mapping provenance");
                }
            } else if (audioSourceTime != null || videoSourceTime != null || audioMinusVideoNanos != null
                    || provenance != null || reason == null || reason.isBlank()) {
                throw new IllegalArgumentException("Undetermined association must omit mapped clock values and state a reason");
            }
            if (uncertaintyNanos < 0 || uncertaintyNanos > MAX_UNCERTAINTY_NANOS) {
                throw new IllegalArgumentException("Source clock uncertainty is outside the supported bound");
            }
        }

        public static Association undetermined(String reason) {
            return new Association(AssociationStatus.SYNC_UNDETERMINED, null, null, null, 0,
                    null, Objects.requireNonNull(reason, "reason"));
        }
    }

    public enum AssociationStatus { TIMESTAMP_ALIGNED, SYNC_UNDETERMINED }

    public enum MappingProvenance {
        TRUSTED_CONTAINER_EDIT_METADATA,
        OWNER_VERIFIED_SOURCE_MAPPING,
        UNAVAILABLE
    }
}
