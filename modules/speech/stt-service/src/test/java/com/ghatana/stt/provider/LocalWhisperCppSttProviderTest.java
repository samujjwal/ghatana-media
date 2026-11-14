package com.ghatana.stt.provider;

import static org.assertj.core.api.Assertions.assertThat;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission;
import com.ghatana.media.runtime.MediaSpeechToTextAdmission.Reason;
import com.ghatana.media.runtime.localmodel.LocalModelInstall;
import com.ghatana.media.runtime.localmodel.LocalModelManifest;
import com.ghatana.stt.local.LocalSpeechTestSupport;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.time.Clock;
import java.time.Instant;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Synthetic install fixtures: proves profile/readiness/admission wiring, not real ASR quality. */
class LocalWhisperCppSttProviderTest {
    @TempDir Path dir;

    private static MediaArtifact artifact() {
        return new MediaArtifact("tenant-a", "principal-a", "artifact-a", "source.wav", "audio/wav", 1,
                "a".repeat(64), "local://source", "CONFIDENTIAL", Instant.now(),
                Instant.now().plusSeconds(60), Map.of());
    }

    private static MediaSpeechToTextAdmission.Request request(MediaSpeechToTextAdmission.Profile profile) {
        return new MediaSpeechToTextAdmission.Request(artifact().version().value(), profile.profileId(),
                profile.profileVersion(), profile.configurationDigest(),
                MediaSpeechToTextAdmission.LanguageMode.EXPLICIT, "en");
    }

    private LocalWhisperCppSttProvider provider(boolean pinExe) throws Exception {
        Path cli = LocalSpeechTestSupport.fakeCli(dir, "{\"transcription\":[]}", 0, "");
        Path modelDir = LocalSpeechTestSupport.syntheticWhisperInstall(dir, cli, pinExe);
        return new LocalWhisperCppSttProvider(
                LocalModelInstall.inspect(modelDir, LocalWhisperCppSttProvider.MODEL_KEY,
                        LocalModelManifest.Modality.SPEECH_TO_TEXT), cli, 1);
    }

    @Test
    void absentManifestLeavesTheProviderUnreadyWithNoProfileAndAdmissionStaysFailClosed() {
        var provider = new LocalWhisperCppSttProvider(LocalModelInstall.absent("test"), null, 1);
        assertThat(provider.ready()).isFalse();
        assertThat(provider.productionEligible()).isFalse();
        assertThat(provider.speechToTextProfile()).isEmpty();
        var fakeProfile = new MediaSpeechToTextAdmission.Request(artifact().version().value(), "p", "v",
                "sha256:" + "0".repeat(64), MediaSpeechToTextAdmission.LanguageMode.EXPLICIT, "en");
        var decision = MediaSpeechToTextAdmission.evaluate(fakeProfile, artifact(), null, null, null, null, true,
                true, Clock.systemUTC());
        assertThat(decision.reasons()).contains(Reason.PROFILE_ABSENT, Reason.RIGHTS_AUTHORITY_UNAVAILABLE);
    }

    @Test
    void verifiedManifestYieldsQualifiedProfileButRightsAndConsentStillGateAdmission() throws Exception {
        var provider = provider(true);
        assertThat(provider.ready()).isTrue();
        assertThat(provider.capabilities()).containsExactly(JobType.SPEECH_TO_TEXT);
        var profile = provider.speechToTextProfile().orElseThrow();
        assertThat(profile.qualification()).isEqualTo(MediaSpeechToTextAdmission.ProfileQualification.QUALIFIED);
        assertThat(profile.qualificationEvidenceRef()).startsWith("local-model-manifest:sha256:");
        assertThat(profile.supportedLanguageTags()).containsExactly("en");
        // Artifact identity alone is not production eligibility.
        assertThat(provider.productionEligible()).isFalse();

        var decision = MediaSpeechToTextAdmission.evaluate(request(profile), artifact(), profile, null, null, null,
                true, true, Clock.systemUTC());
        assertThat(decision.disposition()).isEqualTo(MediaSpeechToTextAdmission.Disposition.NOT_ADMITTED);
        assertThat(decision.reasons()).contains(Reason.RIGHTS_AUTHORITY_UNAVAILABLE, Reason.CONSENT_NOT_ADMITTED)
                .doesNotContain(Reason.PROFILE_ABSENT, Reason.PROFILE_NOT_QUALIFIED,
                        Reason.PROFILE_IDENTITY_MISMATCH, Reason.LANGUAGE_UNSUPPORTED);
    }

    @Test
    void unsupportedLanguageIsRefusedEvenWithAQualifiedProfile() throws Exception {
        var profile = provider(false).speechToTextProfile().orElseThrow();
        var hindi = new MediaSpeechToTextAdmission.Request(artifact().version().value(), profile.profileId(),
                profile.profileVersion(), profile.configurationDigest(),
                MediaSpeechToTextAdmission.LanguageMode.EXPLICIT, "hi");
        assertThat(MediaSpeechToTextAdmission.evaluate(hindi, artifact(), profile, null, null, null, true, true,
                Clock.systemUTC()).reasons()).contains(Reason.LANGUAGE_UNSUPPORTED);
        var auto = new MediaSpeechToTextAdmission.Request(artifact().version().value(), profile.profileId(),
                profile.profileVersion(), profile.configurationDigest(),
                MediaSpeechToTextAdmission.LanguageMode.AUTO_REQUESTED, "");
        assertThat(MediaSpeechToTextAdmission.evaluate(auto, artifact(), profile, null, null, null, true, true,
                Clock.systemUTC()).reasons()).contains(Reason.LANGUAGE_SUPPORT_UNVERIFIED);
    }

    @Test
    void weightsSwappedAfterStartupWithdrawTheProfile() throws Exception {
        var provider = provider(false);
        assertThat(provider.speechToTextProfile()).isPresent();
        Files.write(dir.resolve("whisper-large-v3-turbo/weights.bin"), "x".getBytes(),
                StandardOpenOption.APPEND);
        assertThat(provider.ready()).isFalse();
        assertThat(provider.speechToTextProfile()).isEmpty();
    }

    @Test
    void executableThatDoesNotMatchThePinnedDigestIsNotUsable() throws Exception {
        Path cli = LocalSpeechTestSupport.fakeCli(dir, "{}", 0, "");
        Path modelDir = LocalSpeechTestSupport.syntheticWhisperInstall(dir, cli, true);
        Files.writeString(cli, "#!/bin/bash\necho tampered\n");
        var provider = new LocalWhisperCppSttProvider(
                LocalModelInstall.inspect(modelDir, LocalWhisperCppSttProvider.MODEL_KEY,
                        LocalModelManifest.Modality.SPEECH_TO_TEXT), cli, 1);
        assertThat(provider.ready()).isFalse();
        assertThat(provider.speechToTextProfile()).isEmpty();
    }

    @Test
    void environmentCompositionWithoutAModelRootIsUnavailable() {
        var provider = new LocalWhisperCppSttProvider(Map.of());
        assertThat(provider.ready()).isFalse();
        assertThat(provider.providerVersion()).isEqualTo("unavailable");
        provider.close();
    }
}
