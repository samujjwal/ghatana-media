package com.ghatana.audio.video.vision.local;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Manifest parsing and digest-bound qualification: QUALIFIED only when disk equals the manifest. */
class LocalModelAdmissionTest {

    @TempDir Path temp;

    @Test
    void matchingDigestsAndLicenceAreQualified() throws Exception {
        Path dir = LocalVisionTestFixtures.modelDir(temp, "florence", LocalVisionEngine.FLORENCE_MODEL_ID, "VISION", "MIT");
        var admission = LocalVisionTestFixtures.florence(dir).evaluate();
        assertThat(admission.state()).isEqualTo(LocalModelAdmission.State.QUALIFIED);
        assertThat(admission.manifest().modelId()).isEqualTo(LocalVisionEngine.FLORENCE_MODEL_ID);
        assertThat(admission.manifest().spdxLicense()).isEqualTo("MIT");
    }

    @Test
    void missingDirectoryOrManifestIsNotAdmitted() {
        var admission = LocalVisionTestFixtures.florence(temp.resolve("absent")).evaluate();
        assertThat(admission.state()).isEqualTo(LocalModelAdmission.State.NOT_ADMITTED);
        assertThat(admission.reasonCode()).isEqualTo(LocalModelAdmission.NOT_ADMITTED_MANIFEST_MISSING);
    }

    @Test
    void tamperedWeightsAreNotAdmittedEvenWithTheSameSize() throws Exception {
        Path dir = LocalVisionTestFixtures.modelDir(temp, "tampered", LocalVisionEngine.FLORENCE_MODEL_ID, "VISION", "MIT");
        var admission = LocalVisionTestFixtures.florence(dir);
        assertThat(admission.evaluate().qualified()).isTrue();
        byte[] bytes = Files.readAllBytes(dir.resolve("model.safetensors"));
        bytes[0] ^= 0x01;
        Files.write(dir.resolve("model.safetensors"), bytes);
        Files.setLastModifiedTime(dir.resolve("model.safetensors"),
                java.nio.file.attribute.FileTime.fromMillis(System.currentTimeMillis() + 5_000));
        var after = admission.evaluate();
        assertThat(after.state()).isEqualTo(LocalModelAdmission.State.NOT_ADMITTED);
        assertThat(after.reasonCode()).isEqualTo(LocalModelAdmission.NOT_ADMITTED_DIGEST);
    }

    @Test
    void missingWeightFileIsNotAdmitted() throws Exception {
        Path dir = LocalVisionTestFixtures.modelDir(temp, "gone", LocalVisionEngine.FLORENCE_MODEL_ID, "VISION", "MIT");
        Files.delete(dir.resolve("model.safetensors"));
        var admission = LocalVisionTestFixtures.florence(dir).evaluate();
        assertThat(admission.reasonCode()).isEqualTo(LocalModelAdmission.NOT_ADMITTED_FILE_MISSING);
    }

    @Test
    void wrongLicenceOrIdentityIsNotAdmitted() throws Exception {
        Path gpl = LocalVisionTestFixtures.modelDir(temp, "wrong-license", LocalVisionEngine.QWEN_MODEL_ID,
                "MULTIMODAL_QA", "MIT");
        assertThat(LocalVisionTestFixtures.qwen(gpl).evaluate().reasonCode())
                .isEqualTo(LocalModelAdmission.NOT_ADMITTED_LICENSE);
        Path other = LocalVisionTestFixtures.modelDir(temp, "other-model", "someone/else", "VISION", "MIT");
        assertThat(LocalVisionTestFixtures.florence(other).evaluate().reasonCode())
                .isEqualTo(LocalModelAdmission.NOT_ADMITTED_IDENTITY);
    }

    @Test
    void symlinkedWeightsAreNotAdmitted() throws Exception {
        Path dir = LocalVisionTestFixtures.modelDir(temp, "link", LocalVisionEngine.FLORENCE_MODEL_ID, "VISION", "MIT");
        Path real = temp.resolve("elsewhere.bin");
        Files.move(dir.resolve("model.safetensors"), real);
        Files.createSymbolicLink(dir.resolve("model.safetensors"), real);
        assertThat(LocalVisionTestFixtures.florence(dir).evaluate().state())
                .isEqualTo(LocalModelAdmission.State.NOT_ADMITTED);
    }

    @Test
    void malformedManifestsAreRejected() {
        assertThatThrownBy(() -> LocalModelManifest.parse("{"))
                .isInstanceOf(LocalModelManifest.InvalidManifestException.class);
        assertThatThrownBy(() -> LocalModelManifest.parse("{\"schemaVersion\":\"other\"}"))
                .isInstanceOf(LocalModelManifest.InvalidManifestException.class);
        assertThatThrownBy(() -> LocalModelManifest.parse(
                "{\"schemaVersion\":\"ghatana.media.local-model-manifest.v1\",\"revision\":\"short\"}"))
                .isInstanceOf(LocalModelManifest.InvalidManifestException.class);
    }

    @Test
    void pathTraversalInManifestIsRejected() throws Exception {
        Path dir = LocalVisionTestFixtures.modelDir(temp, "traversal", LocalVisionEngine.FLORENCE_MODEL_ID, "VISION", "MIT");
        String manifest = Files.readString(dir.resolve(LocalModelManifest.MANIFEST_FILE))
                .replace("\"path\":\"model.safetensors\"", "\"path\":\"../model.safetensors\"");
        assertThatThrownBy(() -> LocalModelManifest.parse(manifest))
                .isInstanceOf(LocalModelManifest.InvalidManifestException.class);
    }
}
