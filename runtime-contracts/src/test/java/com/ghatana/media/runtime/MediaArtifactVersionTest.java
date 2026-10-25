package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaArtifactVersionTest {
    private static final String DIGEST = "a".repeat(64);

    @Test
    void derivesCanonicalVersionFromFullLowercaseSha256() {
        MediaArtifact artifact = artifact(DIGEST);

        assertThat(artifact.version()).isEqualTo(new ArtifactVersion("sha256:" + DIGEST));
        assertThat(ArtifactVersion.fromSha256(DIGEST).value()).isEqualTo("sha256:" + DIGEST);
    }

    @Test
    void rejectsNonCanonicalArtifactVersions() {
        assertThatThrownBy(() -> new ArtifactVersion("sha256:" + "A".repeat(64)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ArtifactVersion("sha256:abc"))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void omittedExpectedVersionUsesLegacyCaptureButExplicitBlankIsRejected() {
        ProcessingJobRequest legacy = new ProcessingJobRequest(
                "request-a", "tenant-a", "principal-a", "correlation-a", "artifact-a",
                JobType.VISION, "", Map.of());

        assertThat(legacy.expectedArtifactVersion()).isEmpty();
        assertThat(legacy.requestedArtifactVersion()).isEmpty();
        assertThatThrownBy(() -> new ProcessingJobRequest(
                "request-b", "tenant-a", "principal-a", "correlation-b", "artifact-a",
                "", JobType.VISION, "", Map.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("expectedArtifactVersion");
    }

    @Test
    void versionedReadReturnsOnlyTheExpectedImmutableContentVersion() {
        MediaArtifact current = artifact(DIGEST);
        MediaArtifactStore store = new ArtifactOnlyStore(current);

        assertThat(store.artifact("tenant-a", "artifact-a", current.version())).contains(current);
        assertThat(store.artifact("tenant-a", "artifact-a", ArtifactVersion.fromSha256("b".repeat(64))))
                .isEmpty();
        assertThatThrownBy(() -> store.artifact("tenant-a", "artifact-a", null))
                .isInstanceOf(NullPointerException.class)
                .hasMessageContaining("expectedVersion");
    }

    private static MediaArtifact artifact(String sha256) {
        return new MediaArtifact(
                "tenant-a", "principal-a", "artifact-a", "clip.wav", "audio/wav", 4,
                sha256, "s3://bucket/key", "confidential", Instant.EPOCH,
                Instant.parse("2030-01-01T00:00:00Z"), Map.of());
    }

    private record ArtifactOnlyStore(MediaArtifact value) implements MediaArtifactStore {
        @Override public String storeId() { return "test"; }
        @Override public UploadSession begin(UploadRequest request, String idempotencyKey) {
            throw new UnsupportedOperationException();
        }
        @Override public UploadSession append(
                String tenantId, String principalId, String uploadId, int chunkIndex, byte[] bytes) {
            throw new UnsupportedOperationException();
        }
        @Override public MediaArtifact complete(String tenantId, String principalId, String uploadId) {
            throw new UnsupportedOperationException();
        }
        @Override public Optional<UploadSession> upload(String tenantId, String uploadId) {
            return Optional.empty();
        }
        @Override public Optional<MediaArtifact> artifact(String tenantId, String artifactId) {
            return "tenant-a".equals(tenantId) && "artifact-a".equals(artifactId)
                    ? Optional.of(value) : Optional.empty();
        }
        @Override public boolean durable() { return false; }
        @Override public boolean productionEligible() { return false; }
        @Override public boolean ready() { return true; }
    }
}
