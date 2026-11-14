package com.ghatana.stt.local;

import com.ghatana.media.runtime.localmodel.LocalModelManifest;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.HexFormat;

/** Synthetic fixtures: a fake whisper-cli shell script and a synthetic verified manifest. Not a real model. */
public final class LocalSpeechTestSupport {
    private LocalSpeechTestSupport() { }

    public static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    /** Fake CLI: writes the given JSON to "<-of value>.json" and exits with the given code. */
    public static Path fakeCli(Path dir, String json, int exitCode, String preamble) throws Exception {
        Path script = dir.resolve("fake-whisper-cli");
        String body = """
                #!/bin/bash
                %s
                base=""
                while [ $# -gt 0 ]; do if [ "$1" = "-of" ]; then base="$2"; fi; shift; done
                cat > "$base.json" <<'JSON'
                %s
                JSON
                exit %d
                """.formatted(preamble, json, exitCode);
        Files.writeString(script, body);
        Files.setPosixFilePermissions(script, PosixFilePermissions.fromString("rwxr-xr-x"));
        return script;
    }

    /** Writes weights/licence + manifest naming the whisper.cpp runtime; returns the model directory. */
    public static Path syntheticWhisperInstall(Path dir, Path executable, boolean pinExecutable) throws Exception {
        Path modelDir = Files.createDirectories(dir.resolve("whisper-large-v3-turbo"));
        byte[] weights = "synthetic-whisper-weights".getBytes(StandardCharsets.UTF_8);
        byte[] licence = "synthetic MIT licence".getBytes(StandardCharsets.UTF_8);
        Files.write(modelDir.resolve("weights.bin"), weights);
        Files.write(modelDir.resolve("LICENSE.txt"), licence);
        String exeDigest = pinExecutable ? ",\"executableSha256\":\"" + LocalModelManifest.sha256(executable) + "\"" : "";
        String json = """
                {"schema":"ghatana.media.local-model-manifest.v1","modelKey":"whisper-large-v3-turbo",
                 "modality":"SPEECH_TO_TEXT","modelId":"fixture/whisper","source":{"url":"https://example.invalid/w","revision":"rev-1"},
                 "files":[{"role":"WEIGHTS","path":"weights.bin","sha256":"%s","sizeBytes":%d},
                          {"role":"LICENSE","path":"LICENSE.txt","sha256":"%s","sizeBytes":%d}],
                 "license":{"spdx":"MIT","licenseSourceUrl":"https://example.invalid/l","verifiedOn":"2026-11-14"},
                 "ownerDecision":{"date":"2026-11-14","quote":"%s","licenseStatement":"%s"},
                 "attribution":{"noticeRequired":true,"notice":"fixture"},
                 "admission":{"scope":"ARTIFACT_IDENTITY_AND_LICENSE_ONLY","productionEligible":false},
                 "verifiedLanguages":["en"],
                 "runtime":{"name":"whisper.cpp","version":"v-fixture"%s}}
                """.formatted(sha(weights), weights.length, sha(licence), licence.length,
                LocalModelManifest.OWNER_DECISION_QUOTE, LocalModelManifest.OWNER_LICENSE_STATEMENT, exeDigest);
        Files.writeString(modelDir.resolve("manifest.json"), json);
        return modelDir;
    }

    /** One-second 16 kHz mono PCM16 WAV of a quiet tone. */
    public static byte[] tinyWav16k() {
        int rate = 16_000;
        short[] samples = new short[rate];
        for (int i = 0; i < samples.length; i++) samples[i] = (short) (1000 * Math.sin(2 * Math.PI * 440 * i / rate));
        return PcmWav.encode(new PcmWav.Pcm(samples, rate));
    }
}
