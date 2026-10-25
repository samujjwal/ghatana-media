package com.ghatana.media.runtime;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaVisualContractsTest {
    private static final MediaVisualContracts.CapabilityProfile PROFILE =
            new MediaVisualContracts.CapabilityProfile(
                    "vision-profile-1", "vision-provider-1", "model-2026-01",
                    MediaVisualContracts.Admission.ADMITTED, "");
    private static final MediaVisualContracts.FrameIdentity FRAME =
            new MediaVisualContracts.FrameIdentity("sha256:source", "timeline-1", 12, 90);
    private static final MediaVisualContracts.Timebase TIMEBASE = new MediaVisualContracts.Timebase(30, 1);

    @Test
    void validatesProfileAndPreservesFrameCoordinatesTimebaseAndUncertaintyMetadata() {
        MediaVisualContracts.Request request = request(PROFILE, FRAME, TIMEBASE, true);
        MediaVisualContracts.Result result = result(PROFILE, FRAME, TIMEBASE, "en-US");

        assertThat(MediaVisualContracts.validate(request, result)).isSameAs(result);
        assertThat(TIMEBASE.seconds(90)).isEqualByComparingTo("3");
        assertThat(TIMEBASE.seconds(120)).isEqualByComparingTo("4");
        assertThat(result.observations().get(0).box())
                .isEqualTo(new MediaVisualContracts.NormalizedBox(0.1, 0.2, 0.3, 0.4));
        assertThat(result.observations().get(0).locale()).isEqualTo("en-US");
        assertThat(result.observations().get(0).uncertainty()).isEqualTo(0.12);
        assertThat(result.locale()).contains("en-US");
    }

    @Test
    void disabledLiveProfileReturnsExplicitNotAdmittedErrorWithoutPretendingToInvokeProvider() {
        MediaVisualContracts.CapabilityProfile unavailable = MediaVisualContracts.CapabilityProfile.disabledLive(
                "vision-live", "ai-inference-public-adapter", "unresolved",
                "AI Inference public adapter is unavailable");

        assertThatThrownBy(() -> MediaVisualContracts.validate(
                request(unavailable, FRAME, TIMEBASE, true), result(unavailable, FRAME, TIMEBASE, "en-US")))
                .isInstanceOf(MediaVisualContracts.ContractException.class)
                .extracting(error -> ((MediaVisualContracts.ContractException) error).code())
                .isEqualTo(MediaVisualContracts.ErrorCode.PROFILE_NOT_ADMITTED);
    }

    @Test
    void rejectsWrongProviderProfileOrModelRatherThanSilentlyAcceptingAlternate() {
        MediaVisualContracts.Request request = request(PROFILE, FRAME, TIMEBASE, true);

        assertCode(request, result("other-provider", PROFILE.profileId(), PROFILE.modelVersion(), FRAME, TIMEBASE),
                MediaVisualContracts.ErrorCode.PROVIDER_MISMATCH);
        assertCode(request, result(PROFILE.providerId(), "other-profile", PROFILE.modelVersion(), FRAME, TIMEBASE),
                MediaVisualContracts.ErrorCode.PROFILE_MISMATCH);
        assertCode(request, result(PROFILE.providerId(), PROFILE.profileId(), "other-model", FRAME, TIMEBASE),
                MediaVisualContracts.ErrorCode.MODEL_MISMATCH);
    }

    @Test
    void rejectsMismatchedTimelineFrameAndTimebaseIdentity() {
        MediaVisualContracts.Request request = request(PROFILE, FRAME, TIMEBASE, true);
        MediaVisualContracts.FrameIdentity otherTimeline =
                new MediaVisualContracts.FrameIdentity("sha256:source", "timeline-other", 12, 90);

        assertCode(request, result(PROFILE, otherTimeline, TIMEBASE, "en-US"),
                MediaVisualContracts.ErrorCode.INVALID_RESULT);
        assertCode(request, result(PROFILE, FRAME, new MediaVisualContracts.Timebase(24, 1), "en-US"),
                MediaVisualContracts.ErrorCode.INVALID_RESULT);
    }

    @Test
    void rejectsOutOfFrameCoordinatesInvalidTimeSpansAndMalformedUncertainty() {
        assertThatThrownBy(() -> new MediaVisualContracts.NormalizedBox(0.8, 0.1, 0.3, 0.2))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaVisualContracts.TimelineSpan(3, 3))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> observation(0.1, 0.2, 0.3, 0.4, 90, 120, 1.1, "en-US"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> TIMEBASE.seconds(-1)).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void requiresConsentAndValidLocaleAtRequestBoundary() {
        assertThatThrownBy(() -> request(PROFILE, FRAME, TIMEBASE, false))
                .isInstanceOf(MediaVisualContracts.ContractException.class)
                .extracting(error -> ((MediaVisualContracts.ContractException) error).code())
                .isEqualTo(MediaVisualContracts.ErrorCode.CONSENT_DENIED);
        assertThatThrownBy(() -> new MediaVisualContracts.Observation(
                "text", new MediaVisualContracts.NormalizedBox(0, 0, 1, 1),
                new MediaVisualContracts.TimelineSpan(90, 120), 0.9, 0.1, "not_a_locale"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static MediaVisualContracts.Request request(
            MediaVisualContracts.CapabilityProfile profile,
            MediaVisualContracts.FrameIdentity frame,
            MediaVisualContracts.Timebase timebase,
            boolean consent) {
        return new MediaVisualContracts.Request("request-1", profile, frame, timebase, "en-US", consent);
    }

    private static MediaVisualContracts.Result result(
            MediaVisualContracts.CapabilityProfile profile,
            MediaVisualContracts.FrameIdentity frame,
            MediaVisualContracts.Timebase timebase,
            String locale) {
        return result(profile.providerId(), profile.profileId(), profile.modelVersion(), frame, timebase, locale);
    }

    private static MediaVisualContracts.Result result(
            String provider, String profile, String model,
            MediaVisualContracts.FrameIdentity frame, MediaVisualContracts.Timebase timebase) {
        return result(provider, profile, model, frame, timebase, "en-US");
    }

    private static MediaVisualContracts.Result result(
            String provider, String profile, String model,
            MediaVisualContracts.FrameIdentity frame, MediaVisualContracts.Timebase timebase, String locale) {
        return new MediaVisualContracts.Result("request-1", provider, profile, model, frame, timebase,
                List.of(observation(0.1, 0.2, 0.3, 0.4, 90, 120, 0.12, locale)),
                Optional.of(locale), 0.12);
    }

    private static MediaVisualContracts.Observation observation(
            double x, double y, double width, double height, long start, long end,
            double uncertainty, String locale) {
        return new MediaVisualContracts.Observation("caption-text",
                new MediaVisualContracts.NormalizedBox(x, y, width, height),
                new MediaVisualContracts.TimelineSpan(start, end), 0.88, uncertainty, locale);
    }

    private static void assertCode(
            MediaVisualContracts.Request request,
            MediaVisualContracts.Result result,
            MediaVisualContracts.ErrorCode expected) {
        assertThatThrownBy(() -> MediaVisualContracts.validate(request, result))
                .isInstanceOf(MediaVisualContracts.ContractException.class)
                .extracting(error -> ((MediaVisualContracts.ContractException) error).code())
                .isEqualTo(expected);
    }
}
