package com.ghatana.tts.local;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.localmodel.LocalModelInstall;
import com.ghatana.media.runtime.localmodel.LocalModelManifest;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import javax.sound.sampled.AudioFileFormat;
import javax.sound.sampled.AudioFormat;
import javax.sound.sampled.AudioInputStream;
import javax.sound.sampled.AudioSystem;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** Synthetic fixtures (fake python, synthetic voice packs). Proves wiring and bounds, not voice quality. */
class LocalKokoroTest {
    @TempDir Path dir;

    private static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static byte[] wav24k(int samples) throws Exception {
        byte[] pcm = new byte[samples * 2];
        AudioFormat format = new AudioFormat(24_000, 16, 1, true, false);
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        AudioSystem.write(new AudioInputStream(new ByteArrayInputStream(pcm), format, samples),
                AudioFileFormat.Type.WAVE, out);
        return out.toByteArray();
    }

    /** Fake "python": copies a prepared WAV to the --out argument (ignores everything else). */
    private Path fakePython(Path wav, String preamble) throws Exception {
        Path script = dir.resolve("fake-python");
        Files.writeString(script, """
                #!/bin/bash
                %s
                out=""
                while [ $# -gt 0 ]; do if [ "$1" = "--out" ]; then out="$2"; fi; shift; done
                cp "%s" "$out"
                echo '{"sampleRate":24000}'
                """.formatted(preamble, wav));
        Files.setPosixFilePermissions(script, PosixFilePermissions.fromString("rwxr-xr-x"));
        return script;
    }

    private LocalModelInstall install(Path sidecar, String spdx) throws Exception {
        Path modelDir = Files.createDirectories(dir.resolve("kokoro-82m/voices"));
        modelDir = modelDir.getParent();
        byte[] weights = "synthetic-kokoro-weights".getBytes(StandardCharsets.UTF_8);
        byte[] voice = "synthetic-voice".getBytes(StandardCharsets.UTF_8);
        byte[] licence = "synthetic apache".getBytes(StandardCharsets.UTF_8);
        Files.write(modelDir.resolve("kokoro-v1_0.pth"), weights);
        Files.write(modelDir.resolve("voices/af_heart.pt"), voice);
        Files.write(modelDir.resolve("LICENSE-Apache-2.0.txt"), licence);
        String json = """
                {"schema":"ghatana.media.local-model-manifest.v1","modelKey":"kokoro-82m",
                 "modality":"TEXT_TO_SPEECH","modelId":"fixture/kokoro","source":{"url":"https://example.invalid/k","revision":"rev-k"},
                 "files":[{"role":"WEIGHTS","path":"kokoro-v1_0.pth","sha256":"%s","sizeBytes":%d},
                          {"role":"VOICE","path":"voices/af_heart.pt","sha256":"%s","sizeBytes":%d},
                          {"role":"LICENSE","path":"LICENSE-Apache-2.0.txt","sha256":"%s","sizeBytes":%d}],
                 "license":{"spdx":"%s","licenseSourceUrl":"https://example.invalid/l","verifiedOn":"2026-11-14"},
                 "ownerDecision":{"date":"2026-11-14","quote":"%s","licenseStatement":"%s"},
                 "attribution":{"noticeRequired":true,"notice":"fixture"},
                 "admission":{"scope":"ARTIFACT_IDENTITY_AND_LICENSE_ONLY","productionEligible":false},
                 "verifiedLanguages":["en"],"voiceCloning":"NOT_SUPPORTED",
                 "runtime":{"name":"kokoro","version":"fixture","executableSha256":"%s"}}
                """.formatted(sha(weights), weights.length, sha(voice), voice.length, sha(licence), licence.length,
                spdx, LocalModelManifest.OWNER_DECISION_QUOTE, LocalModelManifest.OWNER_LICENSE_STATEMENT,
                LocalModelManifest.sha256(sidecar));
        Files.writeString(modelDir.resolve("manifest.json"), json);
        return LocalModelInstall.inspect(modelDir, LocalKokoroTtsProvider.MODEL_KEY,
                LocalModelManifest.Modality.TEXT_TO_SPEECH);
    }

    private LocalKokoroSynthesizer synthesizer(String preamble) throws Exception {
        Path sidecar = Files.writeString(dir.resolve("kokoro_synth.py"), "# sidecar fixture\n");
        Path python = fakePython(Files.write(dir.resolve("clip.wav"), wav24k(2400)), preamble);
        LocalModelInstall install = install(sidecar, "Apache-2.0");
        return LocalKokoroSynthesizer.forVerified(install.manifest(), install.modelDir(), python, sidecar,
                Duration.ofSeconds(20));
    }

    @Test
    void synthesizesValidatesAndExposesOnlyManifestListedVoices() throws Exception {
        var synthesizer = synthesizer("");
        assertThat(synthesizer.voices()).containsExactly("af_heart");
        var result = synthesizer.synthesize("hello world", "af_heart", 1.0, Duration.ofSeconds(10),
                BoundedProcessRunner.CancellationToken.NEVER);
        assertThat(result.sampleRate()).isEqualTo(24_000);
        assertThat(result.samples()).isEqualTo(2400);
        assertThat(result.durationMillis()).isEqualTo(100);
        assertThat(result.wav()).startsWith('R', 'I', 'F', 'F');
    }

    @Test
    void unlistedVoicesBadSpeedAndHostileTextAreRefusedBeforeAnyProcessStarts() throws Exception {
        var synthesizer = synthesizer("touch " + dir.resolve("started"));
        for (String voice : new String[]{"af_bella", "../voices/af_heart", "af_heart;id", ""}) {
            assertThatThrownBy(() -> synthesizer.synthesize("hi", voice, 1.0, Duration.ofSeconds(5),
                    BoundedProcessRunner.CancellationToken.NEVER))
                    .isInstanceOfSatisfying(LocalTtsException.class,
                            e -> assertThat(e.code()).isEqualTo(LocalTtsException.Code.VOICE_NOT_ADMITTED));
        }
        for (double speed : new double[]{0.1, 5.0, Double.NaN}) {
            assertThatThrownBy(() -> synthesizer.synthesize("hi", "af_heart", speed, Duration.ofSeconds(5),
                    BoundedProcessRunner.CancellationToken.NEVER)).isInstanceOf(LocalTtsException.class);
        }
        for (String text : new String[]{"", "   ", "a".repeat(LocalKokoroSynthesizer.MAX_TEXT_CHARS + 1), "nul\0byte"}) {
            assertThatThrownBy(() -> synthesizer.synthesize(text, "af_heart", 1.0, Duration.ofSeconds(5),
                    BoundedProcessRunner.CancellationToken.NEVER))
                    .isInstanceOfSatisfying(LocalTtsException.class,
                            e -> assertThat(e.code()).isEqualTo(LocalTtsException.Code.INVALID_INPUT));
        }
        assertThat(dir.resolve("started")).doesNotExist();
    }

    @Test
    void timeoutAndGarbageOutputAreTypedFailures() throws Exception {
        assertThatThrownBy(() -> synthesizer("sleep 30").synthesize("hi", "af_heart", 1.0,
                Duration.ofMillis(400), BoundedProcessRunner.CancellationToken.NEVER))
                .isInstanceOfSatisfying(LocalTtsException.class,
                        e -> assertThat(e.code()).isEqualTo(LocalTtsException.Code.TIMEOUT));
        assertThatThrownBy(() -> LocalKokoroSynthesizer.validate("not a wav".getBytes()))
                .isInstanceOfSatisfying(LocalTtsException.class,
                        e -> assertThat(e.code()).isEqualTo(LocalTtsException.Code.OUTPUT_INVALID));
    }

    @Test
    void sidecarScriptThatDoesNotMatchThePinnedDigestIsNotUsable() throws Exception {
        Path sidecar = Files.writeString(dir.resolve("kokoro_synth.py"), "# sidecar fixture\n");
        Path python = fakePython(Files.write(dir.resolve("clip.wav"), wav24k(240)), "");
        LocalModelInstall install = install(sidecar, "Apache-2.0");
        Files.writeString(sidecar, "# tampered\n");
        assertThat(LocalKokoroSynthesizer.forVerified(install.manifest(), install.modelDir(), python, sidecar,
                Duration.ofSeconds(5))).isNull();
    }

    @Test
    void providerIsReadyOnlyForAVerifiedApacheManifestAndStaysNonProductionEligible() throws Exception {
        Path sidecar = Files.writeString(dir.resolve("kokoro_synth.py"), "# sidecar fixture\n");
        Path python = fakePython(Files.write(dir.resolve("clip.wav"), wav24k(240)), "");
        var provider = new LocalKokoroTtsProvider(install(sidecar, "Apache-2.0"), python, sidecar);
        assertThat(provider.ready()).isTrue();
        assertThat(provider.capabilities()).containsExactly(JobType.TEXT_TO_SPEECH);
        assertThat(provider.productionEligible()).isFalse();
        assertThat(provider.voices()).containsExactly("af_heart");
        provider.close();

        var wrongLicence = new LocalKokoroTtsProvider(install(sidecar, "GPL-3.0-only"), python, sidecar);
        assertThat(wrongLicence.ready()).isFalse();
        assertThat(wrongLicence.voices()).isEmpty();
        assertThat(new LocalKokoroTtsProvider(LocalModelInstall.absent("none"), python, sidecar).ready()).isFalse();
        assertThat(new LocalKokoroTtsProvider(java.util.Map.of()).ready()).isFalse();
    }
}
