package com.ghatana.media.runtime.localmodel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.localmodel.LocalModelManifest.Modality;
import com.ghatana.media.runtime.localmodel.LocalModelManifest.Status;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.util.HexFormat;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Synthetic fixture files only: proves digest/licence/owner-decision enforcement, not any real model. */
class LocalModelManifestTest {
    @TempDir Path dir;

    static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    /** Writes weights + licence files and a manifest; returns the manifest path. */
    static Path install(Path dir, String modelKey, Modality modality, String spdx, String quote) throws Exception {
        byte[] weights = "synthetic-weights-bytes".getBytes(StandardCharsets.UTF_8);
        byte[] licence = "synthetic licence text".getBytes(StandardCharsets.UTF_8);
        Files.write(dir.resolve("weights.bin"), weights);
        Files.write(dir.resolve("LICENSE.txt"), licence);
        String json = """
                {"schema":"ghatana.media.local-model-manifest.v1","modelKey":"%s","modality":"%s",
                 "modelId":"fixture/model","source":{"url":"https://example.invalid/m","revision":"rev-1"},
                 "files":[{"role":"WEIGHTS","path":"weights.bin","sha256":"%s","sizeBytes":%d},
                          {"role":"LICENSE","path":"LICENSE.txt","sha256":"%s","sizeBytes":%d}],
                 "license":{"spdx":"%s","licenseSourceUrl":"https://example.invalid/l","verifiedOn":"2026-11-14"},
                 "ownerDecision":{"date":"2026-11-14","quote":"%s","licenseStatement":"%s"},
                 "attribution":{"noticeRequired":true,"notice":"fixture notice"},
                 "admission":{"scope":"ARTIFACT_IDENTITY_AND_LICENSE_ONLY","productionEligible":false},
                 "verifiedLanguages":["en"],
                 "runtime":{"name":"fixture","version":"1"}}
                """.formatted(modelKey, modality, sha(weights), weights.length, sha(licence), licence.length, spdx,
                quote.replace("\"", "\\\""), LocalModelManifest.OWNER_LICENSE_STATEMENT);
        Path manifest = dir.resolve("manifest.json");
        Files.writeString(manifest, json);
        return manifest;
    }

    @Test
    void verifiesWhenEveryDigestMatchesAndLicenceIsTheOwnerApprovedOne() throws Exception {
        install(dir, "fixture-stt", Modality.SPEECH_TO_TEXT, "MIT", LocalModelManifest.OWNER_DECISION_QUOTE);
        LocalModelInstall install = LocalModelInstall.inspect(dir, "fixture-stt", Modality.SPEECH_TO_TEXT);
        assertThat(install.state()).isEqualTo(LocalModelInstall.State.VERIFIED);
        assertThat(install.usable()).isTrue();
        assertThat(install.manifestSha256()).matches("[0-9a-f]{64}");
        assertThat(install.manifest().admission().productionEligible()).isFalse();
        assertThat(install.verification().path("weights.bin")).exists();
        assertThat(install.stillCurrent()).isTrue();
    }

    @Test
    void alteredWeightsAreRejectedWithTypedDigestMismatch() throws Exception {
        install(dir, "fixture-stt", Modality.SPEECH_TO_TEXT, "MIT", LocalModelManifest.OWNER_DECISION_QUOTE);
        // Same length, different content: size matches so only the digest can catch it.
        Files.write(dir.resolve("weights.bin"), "synthetic-weights-bytez".getBytes(StandardCharsets.UTF_8));
        LocalModelInstall install = LocalModelInstall.inspect(dir, "fixture-stt", Modality.SPEECH_TO_TEXT);
        assertThat(install.usable()).isFalse();
        assertThat(install.state()).isEqualTo(LocalModelInstall.State.REJECTED);
        assertThat(install.verificationStatus()).isEqualTo(Status.DIGEST_MISMATCH);
        assertThatThrownBy(install::verification).isInstanceOf(IllegalStateException.class);
    }

    @Test
    void truncatedMissingAndTamperedLicenceFilesAreRejected() throws Exception {
        install(dir, "fixture-stt", Modality.SPEECH_TO_TEXT, "MIT", LocalModelManifest.OWNER_DECISION_QUOTE);
        Files.writeString(dir.resolve("weights.bin"), "short");
        assertThat(LocalModelInstall.inspect(dir, "fixture-stt", Modality.SPEECH_TO_TEXT).verificationStatus())
                .isEqualTo(Status.SIZE_MISMATCH);
        install(dir, "fixture-stt", Modality.SPEECH_TO_TEXT, "MIT", LocalModelManifest.OWNER_DECISION_QUOTE);
        Files.write(dir.resolve("LICENSE.txt"), "synthetic licence texX".getBytes(StandardCharsets.UTF_8));
        assertThat(LocalModelInstall.inspect(dir, "fixture-stt", Modality.SPEECH_TO_TEXT).verificationStatus())
                .isEqualTo(Status.DIGEST_MISMATCH);
        Files.delete(dir.resolve("LICENSE.txt"));
        assertThat(LocalModelInstall.inspect(dir, "fixture-stt", Modality.SPEECH_TO_TEXT).verificationStatus())
                .isEqualTo(Status.FILE_MISSING);
    }

    @Test
    void onlyTheOwnerApprovedSpdxPerModalityIsAccepted() throws Exception {
        install(dir, "fixture-stt", Modality.SPEECH_TO_TEXT, "Apache-2.0", LocalModelManifest.OWNER_DECISION_QUOTE);
        assertThat(LocalModelInstall.inspect(dir, "fixture-stt", Modality.SPEECH_TO_TEXT).verificationStatus())
                .isEqualTo(Status.LICENSE_NOT_ALLOWED);
        install(dir, "fixture-tts", Modality.TEXT_TO_SPEECH, "MIT", LocalModelManifest.OWNER_DECISION_QUOTE);
        assertThat(LocalModelInstall.inspect(dir, "fixture-tts", Modality.TEXT_TO_SPEECH).verificationStatus())
                .isEqualTo(Status.LICENSE_NOT_ALLOWED);
        install(dir, "fixture-tts", Modality.TEXT_TO_SPEECH, "GPL-3.0-only", LocalModelManifest.OWNER_DECISION_QUOTE);
        assertThat(LocalModelInstall.inspect(dir, "fixture-tts", Modality.TEXT_TO_SPEECH).usable()).isFalse();
        install(dir, "fixture-tts", Modality.TEXT_TO_SPEECH, "Apache-2.0", LocalModelManifest.OWNER_DECISION_QUOTE);
        assertThat(LocalModelInstall.inspect(dir, "fixture-tts", Modality.TEXT_TO_SPEECH).usable()).isTrue();
    }

    private static void rewrite(Path manifest, java.util.function.UnaryOperator<String> edit) throws Exception {
        Files.writeString(manifest, edit.apply(Files.readString(manifest)));
    }

    @Test
    void aNonEnglishVerifiedLanguageNeedsTheVerbatimOwnerAdmissionAndAnEvidenceDigest() throws Exception {
        Path manifest = install(dir, "fixture-stt", Modality.SPEECH_TO_TEXT, "MIT", LocalModelManifest.OWNER_DECISION_QUOTE);
        rewrite(manifest, json -> json.replace("\"verifiedLanguages\":[\"en\"]", "\"verifiedLanguages\":[\"en\",\"es\"]"));
        LocalModelInstall unadmitted = LocalModelInstall.inspect(dir, "fixture-stt", Modality.SPEECH_TO_TEXT);
        assertThat(unadmitted.usable()).as("es without an admission record is refused").isFalse();
        assertThat(unadmitted.verificationStatus()).isEqualTo(Status.MANIFEST_INVALID);

        String evidence = "0123456789abcdef".repeat(4);
        String admission = ",\"languageAdmissions\":[{\"language\":\"es\",\"ownerDecisionDate\":\""
                + LocalModelManifest.SPANISH_ADMISSION_DATE + "\",\"ownerDecisionQuote\":\"%s\","
                + "\"evidencePath\":\"docs/evidence/es.json\",\"evidenceSha256\":\"" + evidence + "\"}]";
        rewrite(manifest, json -> json.replace("\"runtime\"", admission.substring(1).formatted(
                "Some paraphrase of the decision") + ",\"runtime\""));
        assertThat(LocalModelInstall.inspect(dir, "fixture-stt", Modality.SPEECH_TO_TEXT).verificationStatus())
                .as("a paraphrased admission quote is refused").isEqualTo(Status.OWNER_DECISION_MISMATCH);

        install(dir, "fixture-stt", Modality.SPEECH_TO_TEXT, "MIT", LocalModelManifest.OWNER_DECISION_QUOTE);
        rewrite(manifest, json -> json.replace("\"verifiedLanguages\":[\"en\"]", "\"verifiedLanguages\":[\"en\",\"es\"]")
                .replace("\"runtime\"", admission.substring(1).formatted(LocalModelManifest.SPANISH_ADMISSION_QUOTE)
                        + ",\"runtime\""));
        LocalModelInstall admitted = LocalModelInstall.inspect(dir, "fixture-stt", Modality.SPEECH_TO_TEXT);
        assertThat(admitted.usable()).isTrue();
        assertThat(admitted.manifest().verifiedLanguages()).containsExactlyInAnyOrder("en", "es");
        assertThat(admitted.manifest().languageAdmissions()).singleElement().satisfies(entry -> {
            assertThat(entry.language()).isEqualTo("es");
            assertThat(entry.evidenceSha256()).isEqualTo(evidence);
        });
        assertThat(admitted.manifest().admission().productionEligible()).isFalse();
    }

    @Test
    void aMalformedEvidenceDigestIsAnInvalidManifest() throws Exception {
        Path manifest = install(dir, "fixture-stt", Modality.SPEECH_TO_TEXT, "MIT", LocalModelManifest.OWNER_DECISION_QUOTE);
        rewrite(manifest, json -> json.replace("\"runtime\"", "\"languageAdmissions\":[{\"language\":\"es\","
                + "\"ownerDecisionDate\":\"2026-11-15\",\"ownerDecisionQuote\":\"q\",\"evidencePath\":\"p\","
                + "\"evidenceSha256\":\"nothex\"}],\"runtime\""));
        assertThat(LocalModelInstall.inspect(dir, "fixture-stt", Modality.SPEECH_TO_TEXT).usable()).isFalse();
    }

    @Test
    void aRuntimeBindingAcceptsThePinnedAndTheAdditionalWorkerDigestsOnly() {
        String pinned = "a".repeat(64);
        String additional = "b".repeat(64);
        var binding = new LocalModelManifest.RuntimeBinding("kokoro", "1", "", "", pinned, java.util.Set.of(additional));
        assertThat(binding.acceptsWorkerSha256(pinned)).isTrue();
        assertThat(binding.acceptsWorkerSha256(additional)).isTrue();
        assertThat(binding.acceptsWorkerSha256("c".repeat(64))).isFalse();
        assertThat(new LocalModelManifest.RuntimeBinding("kokoro", "1", "", "").acceptsWorkerSha256(pinned)).isFalse();
    }

    @Test
    void ownerDecisionQuoteMustBeVerbatim() throws Exception {
        install(dir, "fixture-stt", Modality.SPEECH_TO_TEXT, "MIT", "Some other paraphrased decision");
        assertThat(LocalModelInstall.inspect(dir, "fixture-stt", Modality.SPEECH_TO_TEXT).verificationStatus())
                .isEqualTo(Status.OWNER_DECISION_MISMATCH);
    }

    @Test
    void absentMalformedAndWrongModelManifestsStayFailClosed() throws Exception {
        assertThat(LocalModelInstall.inspect(dir, "fixture-stt", Modality.SPEECH_TO_TEXT).state())
                .isEqualTo(LocalModelInstall.State.NOT_INSTALLED);
        assertThat(LocalModelInstall.absent("x").usable()).isFalse();
        Files.writeString(dir.resolve("manifest.json"), "{not json");
        assertThat(LocalModelInstall.inspect(dir, "fixture-stt", Modality.SPEECH_TO_TEXT).state())
                .isEqualTo(LocalModelInstall.State.MANIFEST_INVALID);
        install(dir, "fixture-stt", Modality.SPEECH_TO_TEXT, "MIT", LocalModelManifest.OWNER_DECISION_QUOTE);
        assertThat(LocalModelInstall.inspect(dir, "other-key", Modality.SPEECH_TO_TEXT).state())
                .isEqualTo(LocalModelInstall.State.WRONG_MODEL);
        assertThat(LocalModelInstall.inspect(dir, "fixture-stt", Modality.TEXT_TO_SPEECH).state())
                .isEqualTo(LocalModelInstall.State.WRONG_MODEL);
    }

    @Test
    void pathTraversalAndBadDigestsAreRejectedAtParse() throws Exception {
        Path manifest = install(dir, "fixture-stt", Modality.SPEECH_TO_TEXT, "MIT",
                LocalModelManifest.OWNER_DECISION_QUOTE);
        String json = Files.readString(manifest);
        assertThatThrownBy(() -> LocalModelManifest.parse(
                json.replace("\"weights.bin\"", "\"../escape.bin\"").getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> LocalModelManifest.parse(
                json.replace("\"weights.bin\"", "\"/etc/passwd\"").getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> LocalModelManifest.parse(
                json.replaceFirst("[0-9a-f]{64}", "ZZ").getBytes(StandardCharsets.UTF_8)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void swapAfterVerificationIsDetectedByStillCurrent() throws Exception {
        install(dir, "fixture-stt", Modality.SPEECH_TO_TEXT, "MIT", LocalModelManifest.OWNER_DECISION_QUOTE);
        LocalModelInstall install = LocalModelInstall.inspect(dir, "fixture-stt", Modality.SPEECH_TO_TEXT);
        assertThat(install.stillCurrent()).isTrue();
        Files.write(dir.resolve("weights.bin"), "x".getBytes(StandardCharsets.UTF_8), StandardOpenOption.APPEND);
        assertThat(install.stillCurrent()).isFalse();
    }

    @Test
    void configurationDigestChangesWithEveryFileDigestAndDecodingConfiguration() throws Exception {
        Path manifest = install(dir, "fixture-stt", Modality.SPEECH_TO_TEXT, "MIT",
                LocalModelManifest.OWNER_DECISION_QUOTE);
        LocalModelManifest parsed = LocalModelManifest.read(manifest);
        assertThat(parsed.configurationDigest("a")).isNotEqualTo(parsed.configurationDigest("b"));
        assertThat(parsed.configurationDigest("a")).isEqualTo(parsed.configurationDigest("a"));
    }
}
