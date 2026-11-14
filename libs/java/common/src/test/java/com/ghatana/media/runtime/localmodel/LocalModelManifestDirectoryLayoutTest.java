package com.ghatana.media.runtime.localmodel;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.localmodel.LocalModelManifest.FileRole;
import com.ghatana.media.runtime.localmodel.LocalModelManifest.Modality;
import com.ghatana.media.runtime.localmodel.LocalModelManifest.Status;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.FileTime;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HexFormat;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

/** The vision / multimodal directory layout is parsed into the same record and gets the same enforcement. */
class LocalModelManifestDirectoryLayoutTest {
    @TempDir Path dir;

    private static String sha(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private Path install(String role, String spdx, String quote) throws Exception {
        byte[] weights = "synthetic-vision-weights".getBytes(StandardCharsets.UTF_8);
        byte[] licence = "synthetic licence".getBytes(StandardCharsets.UTF_8);
        byte[] config = "{}".getBytes(StandardCharsets.UTF_8);
        for (String name : new String[]{"model.safetensors", "LICENSE", "config.json"}) {
            byte[] content = name.equals("LICENSE") ? licence : name.equals("config.json") ? config : weights;
            Files.write(dir.resolve(name), content);
            Files.setLastModifiedTime(dir.resolve(name), FileTime.from(Instant.now().minusSeconds(3600)));
        }
        String json = """
                {"schemaVersion":"ghatana.media.local-model-manifest.v1","modelId":"fixture/vision","role":"%s",
                 "sourceUrl":"https://example.invalid/v","revision":"%s","spdxLicense":"%s",
                 "licenseFile":{"path":"LICENSE","sha256":"%s","source":"fixture"},
                 "files":[{"path":"LICENSE","sha256":"%s","sizeBytes":%d},
                          {"path":"config.json","sha256":"%s","sizeBytes":%d},
                          {"path":"model.safetensors","sha256":"%s","sizeBytes":%d}],
                 "fileSetSha256":"%s","runtime":{"kind":"transformers","quantization":"fp16"},
                 "ownerDecision":{"quote":"%s","decidedOn":"2026-11-14","channel":"user chat","licenseNote":"%s"},
                 "attribution":"fixture"}
                """.formatted(role, "a".repeat(40), spdx, sha(licence), sha(licence), licence.length, sha(config),
                config.length, sha(weights), weights.length, "b".repeat(64), quote.replace("\"", "\\\""),
                LocalModelManifest.OWNER_LICENSE_STATEMENT);
        Files.writeString(dir.resolve(LocalModelManifest.DIRECTORY_MANIFEST_FILE), json);
        return dir;
    }

    @Test
    void parsesIntoTheSharedRecordAndVerifiesUnderTheSameRules() throws Exception {
        install("VISION", "MIT", LocalModelManifest.OWNER_DECISION_QUOTE);
        LocalModelManifest manifest = LocalModelManifest.readDirectory(dir);
        assertThat(manifest.modality()).isEqualTo(Modality.VISION);
        assertThat(manifest.license().spdx()).isEqualTo("MIT");
        assertThat(manifest.source().revision()).isEqualTo("a".repeat(40));
        assertThat(manifest.fileSetSha256()).isEqualTo("b".repeat(64));
        assertThat(manifest.first(FileRole.WEIGHTS).path()).isEqualTo("model.safetensors");
        assertThat(manifest.first(FileRole.LICENSE).path()).isEqualTo("LICENSE");
        assertThat(manifest.admission().productionEligible()).isFalse();
        assertThat(manifest.verify(dir, "m").status()).isEqualTo(Status.VERIFIED);
    }

    @Test
    void secondVerificationReusesDigestsAndAChangeWithdrawsIt() throws Exception {
        install("MULTIMODAL_QA", "Apache-2.0", LocalModelManifest.OWNER_DECISION_QUOTE);
        LocalModelManifest manifest = LocalModelManifest.readDirectory(dir);
        FileDigestCache cache = FileDigestCache.shared();
        assertThat(manifest.verify(dir, "m").verified()).isTrue();
        long hashedBefore = cache.hashedCount();
        assertThat(manifest.verify(dir, "m").verified()).isTrue();
        assertThat(cache.hashedCount()).as("unchanged files must not be rehashed").isEqualTo(hashedBefore);

        // Same length, different bytes, later modification time: only a fresh hash can catch it.
        Files.write(dir.resolve("model.safetensors"), "synthetic-vision-weightz".getBytes(StandardCharsets.UTF_8));
        Files.setLastModifiedTime(dir.resolve("model.safetensors"), FileTime.from(Instant.now().minusSeconds(60)));
        assertThat(manifest.verify(dir, "m").status()).isEqualTo(Status.DIGEST_MISMATCH);
    }

    @Test
    void ownerDecisionAndSpdxAreEnforcedForTheDirectoryLayoutToo() throws Exception {
        install("VISION", "MIT", "some other decision text");
        assertThat(LocalModelManifest.readDirectory(dir).verify(dir, "m").status())
                .isEqualTo(Status.OWNER_DECISION_MISMATCH);
        install("VISION", "Apache-2.0", LocalModelManifest.OWNER_DECISION_QUOTE);
        assertThat(LocalModelManifest.readDirectory(dir).verify(dir, "m").status())
                .isEqualTo(Status.LICENSE_NOT_ALLOWED);
    }

    @Test
    void malformedDirectoryManifestsAreRejectedStrictly() throws Exception {
        assertThatThrownBy(() -> LocalModelManifest.parseDirectoryManifest("{".getBytes()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> LocalModelManifest.parseDirectoryManifest(
                "{\"schemaVersion\":\"other\"}".getBytes())).isInstanceOf(IllegalArgumentException.class);
        install("VISION", "MIT", LocalModelManifest.OWNER_DECISION_QUOTE);
        String valid = Files.readString(dir.resolve(LocalModelManifest.DIRECTORY_MANIFEST_FILE));
        assertThatThrownBy(() -> LocalModelManifest.parseDirectoryManifest(
                valid.replace("\"role\":\"VISION\"", "\"role\":\"SPEECH\"").getBytes()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> LocalModelManifest.parseDirectoryManifest(
                valid.replace("\"path\":\"model.safetensors\"", "\"path\":\"../model.safetensors\"").getBytes()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> LocalModelManifest.parseDirectoryManifest(
                valid.replace("\"revision\":\"" + "a".repeat(40) + "\"", "\"revision\":\"short\"").getBytes()))
                .isInstanceOf(IllegalArgumentException.class);
        // a duplicate key is ambiguous and refused
        assertThatThrownBy(() -> LocalModelManifest.parseDirectoryManifest(
                valid.replaceFirst("\\{", "{\"role\":\"VISION\",").getBytes()))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
