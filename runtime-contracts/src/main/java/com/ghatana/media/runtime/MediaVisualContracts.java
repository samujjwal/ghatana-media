package com.ghatana.media.runtime;

import java.math.BigDecimal;
import java.math.MathContext;
import java.math.RoundingMode;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Optional;

/** Typed, fail-closed contracts for visual analysis and scene-text mapping. */
public final class MediaVisualContracts {
    private static final MathContext TIME_CONTEXT = new MathContext(18, RoundingMode.HALF_EVEN);

    private MediaVisualContracts() { }

    public enum Admission { ADMITTED, NOT_ADMITTED }

    public enum ErrorCode {
        PROFILE_NOT_ADMITTED,
        PROVIDER_MISMATCH,
        PROFILE_MISMATCH,
        MODEL_MISMATCH,
        INVALID_INPUT,
        INVALID_RESULT,
        CONSENT_DENIED
    }

    public record CapabilityProfile(
            String profileId,
            String providerId,
            String modelVersion,
            Admission admission,
            String unavailableReason) {
        public CapabilityProfile {
            profileId = required(profileId, "profileId");
            providerId = required(providerId, "providerId");
            modelVersion = required(modelVersion, "modelVersion");
            admission = Objects.requireNonNull(admission, "admission");
            unavailableReason = unavailableReason == null ? "" : unavailableReason.trim();
            if (admission == Admission.NOT_ADMITTED && unavailableReason.isBlank()) {
                throw new IllegalArgumentException("NOT_ADMITTED profile requires an unavailable reason");
            }
            if (admission == Admission.ADMITTED && !unavailableReason.isBlank()) {
                throw new IllegalArgumentException("admitted profile cannot carry an unavailable reason");
            }
        }

        /** Local posture while the AI Inference or Document Intelligence owner adapter is absent. */
        public static CapabilityProfile disabledLive(
                String profileId, String providerId, String modelVersion, String reason) {
            return new CapabilityProfile(profileId, providerId, modelVersion, Admission.NOT_ADMITTED, reason);
        }
    }

    public record Timebase(long ticksPerSecondNumerator, long ticksPerSecondDenominator) {
        public Timebase {
            if (ticksPerSecondNumerator < 1 || ticksPerSecondDenominator < 1) {
                throw new IllegalArgumentException("timebase must be a positive rational rate");
            }
        }

        public BigDecimal seconds(long ticks) {
            if (ticks < 0) throw new IllegalArgumentException("time ticks cannot be negative");
            return BigDecimal.valueOf(ticks)
                    .multiply(BigDecimal.valueOf(ticksPerSecondDenominator))
                    .divide(BigDecimal.valueOf(ticksPerSecondNumerator), TIME_CONTEXT);
        }
    }

    public record TimelineSpan(long startTicks, long endTicks) {
        public TimelineSpan {
            if (startTicks < 0 || endTicks <= startTicks) {
                throw new IllegalArgumentException("timeline span must be non-empty and non-negative");
            }
        }
    }

    /** Coordinates are normalized to the source frame, with a half-open width/height box. */
    public record NormalizedBox(double x, double y, double width, double height) {
        public NormalizedBox {
            if (!Double.isFinite(x) || !Double.isFinite(y) || !Double.isFinite(width)
                    || !Double.isFinite(height) || x < 0 || y < 0 || width <= 0 || height <= 0
                    || x + width > 1 || y + height > 1) {
                throw new IllegalArgumentException("normalized coordinates must fit within [0,1]");
            }
        }
    }

    public record FrameIdentity(String artifactRef, String timelineId, int frameNumber, long timestampTicks) {
        public FrameIdentity {
            artifactRef = required(artifactRef, "artifactRef");
            timelineId = required(timelineId, "timelineId");
            if (frameNumber < 0 || timestampTicks < 0) {
                throw new IllegalArgumentException("frame number and timestamp must be non-negative");
            }
        }
    }

    public record Request(
            String requestId,
            CapabilityProfile profile,
            FrameIdentity frame,
            Timebase timebase,
            String locale,
            boolean consentGranted) {
        public Request {
            requestId = required(requestId, "requestId");
            profile = Objects.requireNonNull(profile, "profile");
            frame = Objects.requireNonNull(frame, "frame");
            timebase = Objects.requireNonNull(timebase, "timebase");
            locale = normalizeLocale(locale);
            if (!consentGranted) throw new ContractException(ErrorCode.CONSENT_DENIED, "visual analysis consent denied");
        }
    }

    public record Observation(
            String label,
            NormalizedBox box,
            TimelineSpan span,
            double confidence,
            double uncertainty,
            String locale) {
        public Observation {
            label = required(label, "label");
            box = Objects.requireNonNull(box, "box");
            span = Objects.requireNonNull(span, "span");
            if (!Double.isFinite(confidence) || confidence < 0 || confidence > 1
                    || !Double.isFinite(uncertainty) || uncertainty < 0 || uncertainty > 1) {
                throw new IllegalArgumentException("confidence and uncertainty must be in [0,1]");
            }
            locale = normalizeLocale(locale);
        }
    }

    public record Result(
            String requestId,
            String providerId,
            String profileId,
            String modelVersion,
            FrameIdentity frame,
            Timebase timebase,
            List<Observation> observations,
            Optional<String> locale,
            double uncertainty) {
        public Result {
            requestId = required(requestId, "requestId");
            providerId = required(providerId, "providerId");
            profileId = required(profileId, "profileId");
            modelVersion = required(modelVersion, "modelVersion");
            frame = Objects.requireNonNull(frame, "frame");
            timebase = Objects.requireNonNull(timebase, "timebase");
            observations = List.copyOf(Objects.requireNonNull(observations, "observations"));
            locale = locale == null ? Optional.empty() : locale.map(MediaVisualContracts::normalizeLocale);
            if (!Double.isFinite(uncertainty) || uncertainty < 0 || uncertainty > 1) {
                throw new IllegalArgumentException("uncertainty must be in [0,1]");
            }
            for (Observation observation : observations) {
                if (observation.span().startTicks() < frame.timestampTicks()) {
                    throw new IllegalArgumentException("observation span precedes its source frame");
                }
                timebase.seconds(observation.span().endTicks());
            }
        }
    }

    public record ContractError(ErrorCode code, String message) {
        public ContractError {
            code = Objects.requireNonNull(code, "code");
            message = required(message, "message");
        }
    }

    /** Validates a narrow provider result against the exact selected profile and source frame. */
    public static Result validate(Request request, Result result) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(result, "result");
        CapabilityProfile profile = request.profile();
        if (profile.admission() != Admission.ADMITTED) {
            throw new ContractException(ErrorCode.PROFILE_NOT_ADMITTED,
                    "profile is NOT_ADMITTED: " + profile.unavailableReason());
        }
        if (!profile.providerId().equals(result.providerId())) {
            throw new ContractException(ErrorCode.PROVIDER_MISMATCH, "result provider does not match selected profile");
        }
        if (!profile.profileId().equals(result.profileId())) {
            throw new ContractException(ErrorCode.PROFILE_MISMATCH, "result profile does not match selected profile");
        }
        if (!profile.modelVersion().equals(result.modelVersion())) {
            throw new ContractException(ErrorCode.MODEL_MISMATCH, "result model version does not match selected profile");
        }
        if (!request.requestId().equals(result.requestId()) || !request.frame().equals(result.frame())
                || !request.timebase().equals(result.timebase())) {
            throw new ContractException(ErrorCode.INVALID_RESULT, "result identity/timebase does not match request");
        }
        return result;
    }

    private static String normalizeLocale(String value) {
        String locale = required(value, "locale");
        Locale parsed = Locale.forLanguageTag(locale);
        if (parsed.getLanguage().isBlank() || parsed.toLanguageTag().equals("und")) {
            throw new IllegalArgumentException("locale must be a valid BCP-47 language tag");
        }
        return parsed.toLanguageTag();
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value.trim();
    }

    public static final class ContractException extends IllegalArgumentException {
        private final ErrorCode code;

        public ContractException(ErrorCode code, String message) {
            super(message);
            this.code = Objects.requireNonNull(code, "code");
        }

        public ErrorCode code() { return code; }
    }
}
