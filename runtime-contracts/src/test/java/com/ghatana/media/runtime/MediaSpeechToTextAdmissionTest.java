package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.LanguageMode;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaSpeechToTextAdmissionTest {
    private static final String VERSION = "sha256:" + "a".repeat(64);
    private static final String CONFIG_DIGEST = "sha256:" + "b".repeat(64);

    @Test
    void missingOrStaleExactSourceVersionNeverAdmits() {
        var artifact = artifact(Map.of());
        var missing = MediaSpeechToTextAdmission.evaluate(
                request("", LanguageMode.EXPLICIT, "en-US"), artifact, null, true, true, true);
        assertThat(missing.disposition()).isEqualTo(MediaSpeechToTextAdmission.Disposition.NOT_ADMITTED);
        assertThat(missing.reasons()).contains(MediaSpeechToTextAdmission.Reason.EXACT_SOURCE_VERSION_REQUIRED);

        var stale = MediaSpeechToTextAdmission.evaluate(
                request("sha256:" + "c".repeat(64), LanguageMode.EXPLICIT, "en-US"),
                artifact, null, true, true, true);
        assertThat(stale.reasons()).contains(MediaSpeechToTextAdmission.Reason.SOURCE_VERSION_STALE_OR_NOT_FOUND);
    }

    @Test
    void absentAndUnqualifiedProfilesCannotEstablishLanguageTimingOrClock() {
        var artifact = artifact(Map.of());
        var absent = MediaSpeechToTextAdmission.evaluate(
                request(VERSION, LanguageMode.EXPLICIT, "en-US"), artifact, null, true, true, false);
        assertThat(absent.reasons()).contains(
                MediaSpeechToTextAdmission.Reason.PROFILE_ABSENT,
                MediaSpeechToTextAdmission.Reason.LANGUAGE_SUPPORT_UNVERIFIED,
                MediaSpeechToTextAdmission.Reason.TIMING_NOT_QUALIFIED,
                MediaSpeechToTextAdmission.Reason.SOURCE_CLOCK_NOT_QUALIFIED);

        var unqualified = MediaSpeechToTextAdmission.evaluate(
                request(VERSION, LanguageMode.EXPLICIT, "fr-FR"), artifact,
                profile(MediaSpeechToTextAdmission.ProfileQualification.NOT_QUALIFIED,
                        Set.of("en-US"), false,
                        MediaSpeechToTextAdmission.TimingDisposition.PROVIDER_TIME_UNQUALIFIED),
                true, true, false);
        assertThat(unqualified.disposition()).isEqualTo(MediaSpeechToTextAdmission.Disposition.NOT_ADMITTED);
        assertThat(unqualified.reasons()).contains(
                MediaSpeechToTextAdmission.Reason.PROFILE_NOT_QUALIFIED,
                MediaSpeechToTextAdmission.Reason.LANGUAGE_SUPPORT_UNVERIFIED,
                MediaSpeechToTextAdmission.Reason.TIMING_NOT_QUALIFIED,
                MediaSpeechToTextAdmission.Reason.SOURCE_CLOCK_NOT_QUALIFIED);
    }

    @Test
    void implicitLanguageUnsupportedLanguageAndMissingClockRemainExplicitBlockers() {
        var artifact = artifact(Map.of());
        var profile = profile(MediaSpeechToTextAdmission.ProfileQualification.NOT_QUALIFIED,
                Set.of("en-US"), false, MediaSpeechToTextAdmission.TimingDisposition.PROVIDER_TIME_UNQUALIFIED);

        var implicit = MediaSpeechToTextAdmission.evaluate(
                request(VERSION, null, ""), artifact, profile, true, true, false);
        assertThat(implicit.reasons()).contains(MediaSpeechToTextAdmission.Reason.LANGUAGE_INTENT_REQUIRED,
                MediaSpeechToTextAdmission.Reason.SOURCE_CLOCK_NOT_QUALIFIED);

        var unsupported = MediaSpeechToTextAdmission.evaluate(
                request(VERSION, LanguageMode.EXPLICIT, "fr-FR"), artifact, profile, true, true, false);
        assertThat(unsupported.reasons()).contains(MediaSpeechToTextAdmission.Reason.LANGUAGE_SUPPORT_UNVERIFIED,
                MediaSpeechToTextAdmission.Reason.SOURCE_CLOCK_NOT_QUALIFIED);

        var clockMissing = MediaSpeechToTextAdmission.evaluate(
                request(VERSION, LanguageMode.AUTO_REQUESTED, ""), artifact, profile, true, true, false);
        assertThat(clockMissing.reasons()).contains(MediaSpeechToTextAdmission.Reason.SOURCE_CLOCK_NOT_QUALIFIED);
    }

    @Test
    void consentDenialRightsGapAndMissingTranscriptStoreCannotAdmit() {
        var artifact = artifact(Map.of());
        var decision = MediaSpeechToTextAdmission.evaluate(
                request(VERSION, LanguageMode.EXPLICIT, "en-US"), artifact,
                profile(MediaSpeechToTextAdmission.ProfileQualification.NOT_QUALIFIED,
                        Set.of("en-US"), false,
                        MediaSpeechToTextAdmission.TimingDisposition.NOT_SUPPLIED),
                false, false, false);
        assertThat(decision.disposition()).isEqualTo(MediaSpeechToTextAdmission.Disposition.NOT_ADMITTED);
        assertThat(decision.reasons()).contains(
                MediaSpeechToTextAdmission.Reason.CONSENT_NOT_ADMITTED,
                MediaSpeechToTextAdmission.Reason.RIGHTS_AUTHORITY_UNAVAILABLE,
                MediaSpeechToTextAdmission.Reason.TRANSCRIPT_VERSION_STORE_NOT_ADMITTED);
    }

    @Test
    void requestAndProfileIdentityScalarsArePreservedExactly() {
        var artifact = artifact(Map.of());
        String wrappedProfileId = " profile-a ";
        String wrappedProfileVersion = " v1 ";
        String wrappedDigest = " " + CONFIG_DIGEST + " ";
        var wrappedRequest = new MediaSpeechToTextAdmission.Request(
                VERSION, wrappedProfileId, wrappedProfileVersion, wrappedDigest,
                LanguageMode.EXPLICIT, " en-US ");
        assertThat(wrappedRequest.profileId()).isEqualTo(wrappedProfileId);
        assertThat(wrappedRequest.profileVersion()).isEqualTo(wrappedProfileVersion);
        assertThat(wrappedRequest.profileConfigurationDigest()).isEqualTo(wrappedDigest);
        assertThat(wrappedRequest.languageTag()).isEqualTo(" en-US ");

        var canonicalProfile = profile(MediaSpeechToTextAdmission.ProfileQualification.NOT_QUALIFIED,
                Set.of("en-US"), false, MediaSpeechToTextAdmission.TimingDisposition.PROVIDER_TIME_UNQUALIFIED);
        var mismatch = MediaSpeechToTextAdmission.evaluate(
                wrappedRequest, artifact, canonicalProfile, false, false, false);
        assertThat(mismatch.reasons()).contains(MediaSpeechToTextAdmission.Reason.PROFILE_IDENTITY_MISMATCH);

        var whitespaceProfile = new MediaSpeechToTextAdmission.Profile(
                " candidate-provider ", " candidate-v1 ", wrappedProfileId, wrappedProfileVersion,
                CONFIG_DIGEST, MediaSpeechToTextAdmission.ProfileQualification.NOT_QUALIFIED,
                Set.of("en-US"), false, MediaSpeechToTextAdmission.TimingDisposition.PROVIDER_TIME_UNQUALIFIED, "");
        assertThat(whitespaceProfile.providerId()).isEqualTo(" candidate-provider ");
        assertThat(whitespaceProfile.providerVersion()).isEqualTo(" candidate-v1 ");
        assertThat(whitespaceProfile.profileId()).isEqualTo(wrappedProfileId);
        assertThat(whitespaceProfile.profileVersion()).isEqualTo(wrappedProfileVersion);

        var canonicalRequest = request(VERSION, LanguageMode.EXPLICIT, "en-US");
        var profileMismatch = MediaSpeechToTextAdmission.evaluate(
                canonicalRequest, artifact, whitespaceProfile, false, false, false);
        assertThat(profileMismatch.reasons()).contains(MediaSpeechToTextAdmission.Reason.PROFILE_IDENTITY_MISMATCH);
    }

    @Test
    void requiredProfileScalarsRejectWhitespaceAndDigestDoesNotNormalize() {
        assertThatThrownBy(() -> new MediaSpeechToTextAdmission.Profile(
                "   ", "candidate-v1", "profile-a", "v1", CONFIG_DIGEST,
                MediaSpeechToTextAdmission.ProfileQualification.NOT_QUALIFIED,
                Set.of("en-US"), false, MediaSpeechToTextAdmission.TimingDisposition.NOT_SUPPLIED, ""))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("providerId is required");
        assertThatThrownBy(() -> new MediaSpeechToTextAdmission.Profile(
                "candidate-provider", "candidate-v1", "profile-a", "v1", " " + CONFIG_DIGEST + " ",
                MediaSpeechToTextAdmission.ProfileQualification.NOT_QUALIFIED,
                Set.of("en-US"), false, MediaSpeechToTextAdmission.TimingDisposition.NOT_SUPPLIED, ""))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("configurationDigest must be sha256:");
    }

    @Test
    void completeTrustedPrerequisitesRequireARealVersionedWriterForPositiveAdmission() {
        var qualifiedProfile = new MediaSpeechToTextAdmission.Profile(
                "admitted-reference-provider", "v1", "profile-a", "v1",
                CONFIG_DIGEST, MediaSpeechToTextAdmission.ProfileQualification.QUALIFIED,
                Set.of("en-US"), false,
                MediaSpeechToTextAdmission.TimingDisposition.SOURCE_CLOCK_BOUND,
                "urn:ghatana:media-qualification:reference-profile-v1");
        var qualifiedRequest = request(VERSION, LanguageMode.EXPLICIT, "en-US");
        var exactArtifact = artifact(Map.of());

        // Legacy callers do not have an authoritative transcript store witness.
        var legacy = MediaSpeechToTextAdmission.evaluate(
                qualifiedRequest, exactArtifact, qualifiedProfile, true, true, true);
        assertThat(legacy.disposition()).isEqualTo(MediaSpeechToTextAdmission.Disposition.NOT_ADMITTED);
        assertThat(legacy.reasons()).containsExactly(
                MediaSpeechToTextAdmission.Reason.TRANSCRIPT_VERSION_STORE_NOT_ADMITTED);

        // The new runtime-only admission path remains closed until every source
        // fact is verified; only the complete combination can be ADMITTED.
        var noStore = MediaSpeechToTextAdmission.evaluate(
                qualifiedRequest, exactArtifact, qualifiedProfile, true, true, true, false);
        assertThat(noStore.disposition()).isEqualTo(MediaSpeechToTextAdmission.Disposition.NOT_ADMITTED);
        var noRights = MediaSpeechToTextAdmission.evaluate(
                qualifiedRequest, exactArtifact, qualifiedProfile, true, false, true, true);
        assertThat(noRights.reasons()).contains(MediaSpeechToTextAdmission.Reason.RIGHTS_AUTHORITY_UNAVAILABLE);
        var noConsent = MediaSpeechToTextAdmission.evaluate(
                qualifiedRequest, exactArtifact, qualifiedProfile, false, true, true, true);
        assertThat(noConsent.reasons()).contains(MediaSpeechToTextAdmission.Reason.CONSENT_NOT_ADMITTED);
        var noClock = MediaSpeechToTextAdmission.evaluate(
                qualifiedRequest, exactArtifact, qualifiedProfile, true, true, false, true);
        assertThat(noClock.reasons()).contains(MediaSpeechToTextAdmission.Reason.SOURCE_CLOCK_NOT_QUALIFIED);

        var expiredArtifact = new MediaArtifact(
                "tenant-a", "principal-a", "artifact-a", "source.wav", "audio/wav", 1,
                "a".repeat(64), "local://source", "CONFIDENTIAL",
                Instant.now().minusSeconds(120), Instant.now().minusSeconds(1), Map.of());
        var expired = MediaSpeechToTextAdmission.evaluate(
                qualifiedRequest, expiredArtifact, qualifiedProfile, true, true, true, true);
        assertThat(expired.disposition()).isEqualTo(MediaSpeechToTextAdmission.Disposition.NOT_ADMITTED);
        assertThat(expired.reasons()).contains(
                MediaSpeechToTextAdmission.Reason.SOURCE_VERSION_STALE_OR_NOT_FOUND);

        var admitted = MediaSpeechToTextAdmission.evaluate(
                qualifiedRequest, exactArtifact, qualifiedProfile, true, true, true, true);
        assertThat(admitted.disposition()).isEqualTo(MediaSpeechToTextAdmission.Disposition.ADMITTED);
        assertThat(admitted.reasons()).isEmpty();
        assertThatThrownBy(() -> new MediaSpeechToTextAdmission.NotAdmittedException(admitted))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaSpeechToTextAdmission.Decision(
                MediaSpeechToTextAdmission.Disposition.ADMITTED,
                java.util.List.of(MediaSpeechToTextAdmission.Reason.PROFILE_ABSENT)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static MediaSpeechToTextAdmission.Request request(
            String version, MediaSpeechToTextAdmission.LanguageMode mode, String languageTag) {
        return new MediaSpeechToTextAdmission.Request(
                version, "profile-a", "v1", CONFIG_DIGEST, mode, languageTag);
    }

    private static MediaSpeechToTextAdmission.Profile profile(
            MediaSpeechToTextAdmission.ProfileQualification qualification,
            Set<String> languages,
            boolean autoDetection,
            MediaSpeechToTextAdmission.TimingDisposition timing) {
        return new MediaSpeechToTextAdmission.Profile(
                "contract-test-candidate", "candidate-v1", "profile-a", "v1", CONFIG_DIGEST,
                qualification, languages, autoDetection, timing,
                "");
    }

    private static MediaArtifact artifact(Map<String, Object> metadata) {
        return new MediaArtifact("tenant-a", "principal-a", "artifact-a", "source.wav", "audio/wav", 1,
                "a".repeat(64), "local://source", "CONFIDENTIAL", Instant.now(),
                Instant.now().plusSeconds(60), metadata);
    }
}
