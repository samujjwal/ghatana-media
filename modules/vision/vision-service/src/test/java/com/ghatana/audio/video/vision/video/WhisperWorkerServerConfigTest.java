package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class WhisperWorkerServerConfigTest {
    private static final String IMAGE = "worker@sha256:" + "a".repeat(64);
    private static final Set<String> IMAGES = Set.of(IMAGE);
    private static final Map<String, byte[]> ASSETS = Map.of(
            "encoder_model_quantized.onnx", "server-pinned-encoder".getBytes(StandardCharsets.UTF_8),
            "decoder_model_merged_quantized.onnx", "server-pinned-decoder".getBytes(StandardCharsets.UTF_8),
            "mel_filters.npz", "mel-filters".getBytes(StandardCharsets.UTF_8),
            "multilingual.tiktoken", "tokenizer".getBytes(StandardCharsets.UTF_8));

    @TempDir Path temp;

    private Path privateDirectory(String name) throws Exception {
        Path directory = temp.resolve(name);
        Files.createDirectory(directory);
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        return directory;
    }

    private Path modelRoot(String name) throws Exception {
        Path model = privateDirectory(name);
        for (var asset : ASSETS.entrySet()) Files.write(model.resolve(asset.getKey()), asset.getValue());
        return model;
    }

    private Map<String, String> environment(Path model, Path journal) throws Exception {
        String modelDigest = digest(ASSETS.get("encoder_model_quantized.onnx"));
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_OCI_BROKER_WHISPER_PROFILE_ID", "whisper.reference.v1");
        environment.put("MEDIA_OCI_BROKER_WHISPER_IMAGE", IMAGE);
        environment.put("MEDIA_OCI_BROKER_WHISPER_MODEL_SHA256", modelDigest);
        environment.put("MEDIA_OCI_BROKER_WHISPER_MODEL_BUNDLE_SHA256",
                WhisperWorkerServerConfig.bundleSha256(model));
        environment.put("MEDIA_OCI_BROKER_WHISPER_MODEL_REVISION", "reference-r1");
        environment.put("MEDIA_OCI_BROKER_WHISPER_MODEL_ROOT", model.toString());
        environment.put("MEDIA_OCI_BROKER_WHISPER_LOCALES", "en,en-US");
        environment.put("MEDIA_OCI_BROKER_WHISPER_JOURNAL_DIR", journal.toString());
        return environment;
    }

    @Test
    void loaderRequiresImageModelBundleRevisionAndPrivateJournalPins() throws Exception {
        Path model = modelRoot("model-valid");
        Path journal = privateDirectory("journal-valid");
        Map<String, String> environment = environment(model, journal);
        var loaded = WhisperWorkerServerConfig.load(environment, IMAGES);
        assertThat(loaded).isPresent().get().satisfies(config -> {
            assertThat(config.profileId()).isEqualTo("whisper.reference.v1");
            assertThat(config.imageDigest()).isEqualTo(IMAGE);
            assertThat(config.modelRoot()).isEqualTo(model.toRealPath());
            assertThat(config.modelRevision()).isEqualTo("reference-r1");
            assertThat(config.locales()).containsExactlyInAnyOrder("en", "en-US");
            assertThat(config.journalDirectory()).isEqualTo(journal.toRealPath());
        });

        for (String required : new String[] {"IMAGE", "MODEL_SHA256", "MODEL_BUNDLE_SHA256",
                "MODEL_REVISION", "MODEL_ROOT", "JOURNAL_DIR"}) {
            Map<String, String> missing = new HashMap<>(environment);
            missing.remove("MEDIA_OCI_BROKER_WHISPER_" + required);
            assertThat(WhisperWorkerServerConfig.load(missing, IMAGES))
                    .as("%s pin is required", required).isEmpty();
        }
        assertThat(WhisperWorkerServerConfig.load(environment, Set.of())).isEmpty();
    }

    @Test
    void modelBundleRejectsHashDriftExtraFilesAndSymlinkAssets() throws Exception {
        Path model = modelRoot("model-tamper");
        Path journal = privateDirectory("journal-tamper");
        Map<String, String> environment = environment(model, journal);
        Files.writeString(model.resolve("mel_filters.npz"), "tampered");
        assertThat(WhisperWorkerServerConfig.load(environment, IMAGES)).isEmpty();

        Path extraModel = modelRoot("model-extra");
        Files.writeString(extraModel.resolve("unexpected.bin"), "extra");
        assertThatThrownBy(() -> WhisperWorkerServerConfig.bundleSha256(extraModel))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("file set");
        Map<String, String> extraEnv = new HashMap<>(environment(model, journal));
        extraEnv.put("MEDIA_OCI_BROKER_WHISPER_MODEL_ROOT", extraModel.toString());
        assertThat(WhisperWorkerServerConfig.load(extraEnv, IMAGES)).isEmpty();

        Path symlinkModel = privateDirectory("model-symlink");
        for (var asset : ASSETS.entrySet()) {
            Path target = temp.resolve("asset-" + asset.getKey());
            Files.write(target, asset.getValue());
            Files.createSymbolicLink(symlinkModel.resolve(asset.getKey()), target);
        }
        assertThatThrownBy(() -> WhisperWorkerServerConfig.bundleSha256(symlinkModel))
                .isInstanceOf(java.io.IOException.class).hasMessageContaining("non-symlink");
    }

    @Test
    void mountPathsAndJournalPermissionsMustBeSafe() throws Exception {
        Path model = modelRoot("model-path");
        Path journal = privateDirectory("journal-perms");
        Map<String, String> environment = environment(model, journal);
        Files.setPosixFilePermissions(journal, PosixFilePermissions.fromString("rwxr-x---"));
        assertThat(WhisperWorkerServerConfig.load(environment, IMAGES)).isEmpty();

        Path unsafeJournal = privateDirectory("journal,unsafe");
        assertThat(WhisperWorkerServerConfig.load(environment(model, unsafeJournal), IMAGES)).isEmpty();
    }

    private static String digest(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
