package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.Disposition;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.LanguageMode;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.Reason;
import com.ghatana.media.runtime.MediaSttLanguageQualification.Entry;
import com.ghatana.media.runtime.MediaSttLanguageQualification.Registry;
import com.ghatana.media.runtime.MediaSttLanguageQualification.Status;
import org.junit.jupiter.api.Test;

import java.time.Clock;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * MED-07: English and Nepali are admitted separately, only with their own current evidence-backed
 * entry; revoked/stale rights, expiry and restart re-evaluation each re-close admission. Synthetic
 * fixtures prove the gate logic only; they are not model or corpus quality evidence.
 */
class MediaSttLanguageAdmissionTest {
    private static final String CONFIG = "sha256:" + "b".repeat(64);
    private static final String VERSION = "sha256:" + "a".repeat(64);
    private static final Instant NOW = Instant.now().plusSeconds(1);
    private static final Clock CLOCK = Clock.fixed(NOW, ZoneOffset.UTC);

    private static final MediaSpeechToTextAdmission.Profile PROFILE = new MediaSpeechToTextAdmission.Profile(
            "reference-provider", "v1", "profile-a", "v1", CONFIG,
            MediaSpeechToTextAdmission.ProfileQualification.QUALIFIED, Set.of("en-US", "ne"), true,
            MediaSpeechToTextAdmission.TimingDisposition.SOURCE_CLOCK_BOUND, "urn:test:profile-evidence");

    private static Entry entry(String tag, Status status, Instant until) {
        return new Entry(tag, status, "profile-a", "v1", CONFIG,
                status == Status.QUALIFIED ? "urn:test:language-evidence:" + tag : "", NOW.minusSeconds(60), until);
    }

    private static MediaArtifact artifact() {
        return new MediaArtifact("tenant-a", "principal-a", "artifact-a", "source.wav", "audio/wav", 1,
                "a".repeat(64), "local://source", "CONFIDENTIAL", Instant.now(), Instant.now().plusSeconds(60),
                Map.of("sourceClockId", "clock", "sourceClockMappingEvidenceRef", "ref",
                        "sourceClockTicksPerSecond", 1, "sourceDurationTicks", 1));
    }

    private static MediaSourceAuthorizationContracts.Request authRequest(MediaArtifact a) {
        return new MediaSourceAuthorizationContracts.Request(a.tenantId(), a.principalId(), a.artifactId(),
                a.version(), a.sha256(), "SPEECH_TO_TEXT", "speech-transcription", PROFILE.providerId(),
                PROFILE.providerVersion(), ProcessingBoundary.LOCAL, "us", ProviderDataRetention.NONE);
    }

    private static MediaSourceAuthorizationContracts.Decision allowed(MediaArtifact a) {
        return new MediaSourceAuthorizationContracts.Decision(MediaSourceAuthorizationContracts.Status.ALLOWED,
                new MediaSourceAuthorizationContracts.Evidence(
                        "authority", "decision-1", a.tenantId(), a.principalId(), a.principalId(), a.artifactId(),
                        a.version(), a.sha256(), "SPEECH_TO_TEXT", "speech-transcription", PROFILE.providerId(),
                        PROFILE.providerVersion(), ProcessingBoundary.LOCAL, "us", ProviderDataRetention.NONE,
                        Set.of("speech_to_text"), Set.of("us"), Set.of(ProviderDataRetention.NONE), "rights-1",
                        "policy-1", "policy-v1", MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                        MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                        "", "clock-evidence", 0, NOW.minusSeconds(1), NOW.plusSeconds(30)));
    }

    private static MediaSpeechToTextAdmission.Decision evaluate(
            LanguageMode mode, String tag, MediaSourceAuthorizationContracts.Decision auth, Registry registry,
            Clock clock) {
        MediaArtifact a = artifact();
        var request = new MediaSpeechToTextAdmission.Request(VERSION, "profile-a", "v1", CONFIG, mode, tag);
        return MediaSpeechToTextAdmission.evaluate(request, a, PROFILE, null, authRequest(a), auth, true, true,
                clock, registry);
    }

    @Test
    void emptyRegistryAdmitsNoLanguageEvenWithEveryOtherGateOpen() {
        var d = evaluate(LanguageMode.EXPLICIT, "en-US", allowed(artifact()), Registry.empty(), CLOCK);
        assertThat(d.disposition()).isEqualTo(Disposition.NOT_ADMITTED);
        assertThat(d.reasons()).containsExactly(Reason.LANGUAGE_NOT_INDIVIDUALLY_QUALIFIED);
        assertThat(evaluate(LanguageMode.EXPLICIT, "ne", allowed(artifact()), null, CLOCK).reasons())
                .contains(Reason.LANGUAGE_NOT_INDIVIDUALLY_QUALIFIED);
    }

    @Test
    void englishQualificationNeverAdmitsNepaliAndViceVersa() {
        Instant until = NOW.plusSeconds(3600);
        Registry englishOnly = new Registry(List.of(entry("en-US", Status.QUALIFIED, until), entry("ne", Status.NOT_QUALIFIED, until)));
        assertThat(evaluate(LanguageMode.EXPLICIT, "en-US", allowed(artifact()), englishOnly, CLOCK).disposition())
                .isEqualTo(Disposition.ADMITTED);
        var nepali = evaluate(LanguageMode.EXPLICIT, "ne", allowed(artifact()), englishOnly, CLOCK);
        assertThat(nepali.disposition()).isEqualTo(Disposition.NOT_ADMITTED);
        assertThat(nepali.reasons()).containsExactly(Reason.LANGUAGE_NOT_INDIVIDUALLY_QUALIFIED);

        Registry nepaliOnly = new Registry(List.of(entry("ne", Status.QUALIFIED, until)));
        assertThat(evaluate(LanguageMode.EXPLICIT, "ne", allowed(artifact()), nepaliOnly, CLOCK).disposition())
                .isEqualTo(Disposition.ADMITTED);
        assertThat(evaluate(LanguageMode.EXPLICIT, "en-US", allowed(artifact()), nepaliOnly, CLOCK).disposition())
                .isEqualTo(Disposition.NOT_ADMITTED);
    }

    @Test
    void noPrefixInheritanceBetweenRegionalVariants() {
        Registry r = new Registry(List.of(entry("en", Status.QUALIFIED, NOW.plusSeconds(3600))));
        assertThat(r.admits(PROFILE, "en-US", NOW)).isFalse();
        assertThat(r.admits(PROFILE, "EN", NOW)).isTrue();
    }

    @Test
    void autoDetectionRequiresEveryEmittableLanguageToBeQualified() {
        Instant until = NOW.plusSeconds(3600);
        Registry partial = new Registry(List.of(entry("en-US", Status.QUALIFIED, until)));
        assertThat(evaluate(LanguageMode.AUTO_REQUESTED, "", allowed(artifact()), partial, CLOCK).reasons())
                .contains(Reason.LANGUAGE_NOT_INDIVIDUALLY_QUALIFIED);
        Registry both = new Registry(List.of(entry("en-US", Status.QUALIFIED, until), entry("ne", Status.QUALIFIED, until)));
        assertThat(evaluate(LanguageMode.AUTO_REQUESTED, "", allowed(artifact()), both, CLOCK).disposition())
                .isEqualTo(Disposition.ADMITTED);
    }

    @Test
    void expiredEntryProfileDriftAndRestartReevaluationReclose() {
        Registry r = new Registry(List.of(entry("ne", Status.QUALIFIED, NOW.plusSeconds(100))));
        assertThat(evaluate(LanguageMode.EXPLICIT, "ne", allowed(artifact()), r, CLOCK).disposition())
                .isEqualTo(Disposition.ADMITTED);
        // Restart / retry after the qualification validity window: re-evaluation refuses.
        Clock later = Clock.fixed(NOW.plusSeconds(101), ZoneOffset.UTC);
        assertThat(evaluate(LanguageMode.EXPLICIT, "ne", allowed(artifact()), r, later).reasons())
                .contains(Reason.LANGUAGE_NOT_INDIVIDUALLY_QUALIFIED);
        // Entry bound to a different profile version or digest is not authority for this profile.
        Registry drift = new Registry(List.of(new Entry("ne", Status.QUALIFIED, "profile-a", "v2", CONFIG,
                "urn:test:e", NOW.minusSeconds(1), NOW.plusSeconds(100))));
        assertThat(drift.admits(PROFILE, "ne", NOW)).isFalse();
        Registry digestDrift = new Registry(List.of(new Entry("ne", Status.QUALIFIED, "profile-a", "v1",
                "sha256:" + "c".repeat(64), "urn:test:e", NOW.minusSeconds(1), NOW.plusSeconds(100))));
        assertThat(digestDrift.admits(PROFILE, "ne", NOW)).isFalse();
    }

    @Test
    void revokedStaleOrUnavailableRightsRecloseAdmissionEvenForAQualifiedLanguage() {
        Registry r = new Registry(List.of(entry("ne", Status.QUALIFIED, NOW.plusSeconds(3600))));
        var revoked = evaluate(LanguageMode.EXPLICIT, "ne",
                new MediaSourceAuthorizationContracts.Decision(MediaSourceAuthorizationContracts.Status.REVOKED, null), r, CLOCK);
        assertThat(revoked.reasons()).contains(Reason.RIGHTS_DECISION_REVOKED);
        var unavailable = evaluate(LanguageMode.EXPLICIT, "ne",
                new MediaSourceAuthorizationContracts.Decision(MediaSourceAuthorizationContracts.Status.UNAVAILABLE, null), r, CLOCK);
        assertThat(unavailable.reasons()).contains(Reason.RIGHTS_AUTHORITY_UNAVAILABLE);
        assertThat(evaluate(LanguageMode.EXPLICIT, "ne", null, r, CLOCK).reasons())
                .contains(Reason.RIGHTS_AUTHORITY_UNAVAILABLE);
    }

    @Test
    void qualifiedEntryRequiresEvidenceAndValidWindow() {
        assertThatThrownBy(() -> new Entry("ne", Status.QUALIFIED, "p", "v1", CONFIG, " ", NOW.minusSeconds(1), NOW))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Entry("ne", Status.NOT_QUALIFIED, "p", "v1", CONFIG, "", NOW, NOW))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Entry("ne", Status.NOT_QUALIFIED, "p", "v1", "b".repeat(64), "", NOW.minusSeconds(1), NOW))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
