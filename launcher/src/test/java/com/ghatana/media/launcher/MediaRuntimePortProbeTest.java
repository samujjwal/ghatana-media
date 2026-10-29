package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * W2-R01 port-probe coverage: truthful child readiness, effect-free source-rights
 * resolution, and conditional multimodal production eligibility bound at composition.
 */
class MediaRuntimePortProbeTest {

    @Test
    void processingReadyReflectsUsableProviderPerJobType() throws Exception {
        var root = Files.createTempDirectory("media-probe-ready-");
        var runtime = runtime(root, "local", List.of(provider("stt", Set.of(JobType.SPEECH_TO_TEXT), false)), null);
        try {
            assertThat(runtime.processingReady(JobType.SPEECH_TO_TEXT)).isTrue();
            assertThat(runtime.processingReady(JobType.VISION)).isFalse();
            assertThat(runtime.processingReady(JobType.MULTIMODAL)).isFalse();
        } finally {
            runtime.close();
        }
        assertThat(runtime.processingReady(JobType.SPEECH_TO_TEXT)).isFalse();
    }

    @Test
    void resolveSourceAuthorizationWithoutAuthorityIsUnavailable() throws Exception {
        var root = Files.createTempDirectory("media-probe-noauth-");
        var runtime = runtime(root, "local", List.of(provider("mm", Set.of(JobType.MULTIMODAL), false)), null);
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            var decision = runtime.resolveSourceAuthorization(
                    "tenant-a", "principal-a", source.artifactId(), source.version(),
                    JobType.MULTIMODAL, "mm-observe", authenticated("tenant-a", "principal-a"));
            assertThat(decision.status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
            assertThat(decision.evidence()).isNull();
        } finally {
            runtime.close();
        }
    }

    @Test
    void resolveSourceAuthorizationDeniesCredentialAndOwnershipMismatch() throws Exception {
        var root = Files.createTempDirectory("media-probe-mismatch-");
        var runtime = runtime(root, "local",
                List.of(provider("mm", Set.of(JobType.MULTIMODAL), false)), allowAllAuthority());
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            // Authenticated principal that does not match the lookup identity.
            assertThat(runtime.resolveSourceAuthorization(
                    "tenant-a", "principal-a", source.artifactId(), source.version(),
                    JobType.MULTIMODAL, "mm-observe",
                    authenticated("tenant-a", "intruder")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
            // Artifact owned by a different principal than the caller's.
            assertThat(runtime.resolveSourceAuthorization(
                    "tenant-a", "principal-b", source.artifactId(), source.version(),
                    JobType.MULTIMODAL, "mm-observe",
                    authenticated("tenant-a", "principal-b")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
            // A source that does not exist at all.
            assertThat(runtime.resolveSourceAuthorization(
                    "tenant-a", "principal-a", "missing-artifact", source.version(),
                    JobType.MULTIMODAL, "mm-observe",
                    authenticated("tenant-a", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
        } finally {
            runtime.close();
        }
    }

    @Test
    void resolveSourceAuthorizationStaleForWrongVersion() throws Exception {
        var root = Files.createTempDirectory("media-probe-stale-");
        var runtime = runtime(root, "local",
                List.of(provider("mm", Set.of(JobType.MULTIMODAL), false)), allowAllAuthority());
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            var wrongVersion = new ArtifactVersion("sha256:" + "f".repeat(64));
            assertThat(runtime.resolveSourceAuthorization(
                    "tenant-a", "principal-a", source.artifactId(), wrongVersion,
                    JobType.MULTIMODAL, "mm-observe",
                    authenticated("tenant-a", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.STALE);
        } finally {
            runtime.close();
        }
    }

    @Test
    void resolveSourceAuthorizationUnavailableWithoutUsableProvider() throws Exception {
        var root = Files.createTempDirectory("media-probe-noprovider-");
        var runtime = runtime(root, "local",
                List.of(provider("stt", Set.of(JobType.SPEECH_TO_TEXT), false)), allowAllAuthority());
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            assertThat(runtime.resolveSourceAuthorization(
                    "tenant-a", "principal-a", source.artifactId(), source.version(),
                    JobType.VISION, "mm-observe",
                    authenticated("tenant-a", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
        } finally {
            runtime.close();
        }
    }

    @Test
    void resolveSourceAuthorizationAllowedCarriesAuthorityEvidence() throws Exception {
        var root = Files.createTempDirectory("media-probe-allow-");
        var runtime = runtime(root, "local",
                List.of(provider("mm", Set.of(JobType.MULTIMODAL), false)), allowAllAuthority());
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            var decision = runtime.resolveSourceAuthorization(
                    "tenant-a", "principal-a", source.artifactId(), source.version(),
                    JobType.MULTIMODAL, "mm-observe", authenticated("tenant-a", "principal-a"));
            assertThat(decision.status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.ALLOWED);
            assertThat(decision.evidence()).isNotNull();
            assertThat(decision.evidence().artifactId()).isEqualTo(source.artifactId());
            assertThat(decision.evidence().operation()).isEqualTo("MULTIMODAL");
        } finally {
            runtime.close();
        }
    }

    @Test
    void resolveSourceAuthorizationDeniedByAuthority() throws Exception {
        var root = Files.createTempDirectory("media-probe-deny-");
        var runtime = runtime(root, "local",
                List.of(provider("mm", Set.of(JobType.MULTIMODAL), false)), denyAuthority());
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            assertThat(runtime.resolveSourceAuthorization(
                    "tenant-a", "principal-a", source.artifactId(), source.version(),
                    JobType.MULTIMODAL, "mm-observe",
                    authenticated("tenant-a", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.DENIED);
        } finally {
            runtime.close();
        }
    }

    @Test
    void productionAuthorityIneligibilityKeepsProbeUnavailable() throws Exception {
        var root = Files.createTempDirectory("media-probe-prod-auth-");
        var runtime = runtime(root, "production",
                List.of(provider("mm", Set.of(JobType.MULTIMODAL), true)), allowAllAuthority());
        try {
            var source = artifact(runtime, "tenant-a", "principal-a");
            // The fixture authority resolves but is not production-eligible; in a
            // production profile the probe must not treat its answer as authority.
            assertThat(runtime.resolveSourceAuthorization(
                    "tenant-a", "principal-a", source.artifactId(), source.version(),
                    JobType.MULTIMODAL, "mm-observe",
                    authenticated("tenant-a", "principal-a")).status())
                    .isEqualTo(MediaSourceAuthorizationContracts.Status.UNAVAILABLE);
        } finally {
            runtime.close();
        }
    }

    @Test
    void delegatingProviderBindsUsableChildCapabilitiesAtComposition() throws Exception {
        var root = Files.createTempDirectory("media-probe-bind-");
        var multimodal = new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider();
        var runtime = runtime(root, "production", List.of(
                multimodal,
                provider("stt", Set.of(JobType.SPEECH_TO_TEXT), true),
                provider("vision", Set.of(JobType.VISION), true)),
                allowAllAuthority());
        try {
            // Qualified usable children make the orchestrator production-eligible.
            assertThat(multimodal.productionEligible()).isTrue();
            assertThat(runtime.processingReady(JobType.MULTIMODAL)).isTrue();
        } finally {
            runtime.close();
        }
        assertThat(multimodal.productionEligible()).isFalse();
    }

    @Test
    void delegatingProviderStaysIneligibleWithoutEveryDelegatedChild() throws Exception {
        var root = Files.createTempDirectory("media-probe-bind-partial-");
        var multimodal = new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider();
        var runtime = runtime(root, "production", List.of(
                multimodal,
                provider("stt", Set.of(JobType.SPEECH_TO_TEXT), true)),
                allowAllAuthority());
        try {
            // Vision has no usable provider; the orchestrator must remain ineligible.
            assertThat(multimodal.productionEligible()).isFalse();
            assertThat(runtime.processingReady(JobType.MULTIMODAL)).isFalse();
        } finally {
            runtime.close();
        }
    }

    @Test
    void delegatingProviderStaysIneligibleWithUnqualifiedChildren() throws Exception {
        var root = Files.createTempDirectory("media-probe-bind-dev-");
        var multimodal = new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider();
        var runtime = runtime(root, "production", List.of(
                multimodal,
                provider("stt", Set.of(JobType.SPEECH_TO_TEXT), false),
                provider("vision", Set.of(JobType.VISION), false)),
                allowAllAuthority());
        try {
            assertThat(multimodal.productionEligible()).isFalse();
        } finally {
            runtime.close();
        }
    }

    @Test
    void unboundDelegatingProviderIsNeverProductionEligible() {
        var provider = new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider();
        try {
            assertThat(provider.productionEligible()).isFalse();
        } finally {
            provider.close();
        }
    }

    // ── Fixtures ────────────────────────────────────────────────────────────

    private static MediaRuntime runtime(
            java.nio.file.Path root, String profile, List<MediaProcessingProvider> providers,
            MediaSourceAuthorizationContracts.Authority authority) {
        boolean production = "production".equals(profile);
        return new MediaRuntime(
                new MediaRuntimeConfig(true, profile, 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(10), 8,
                        production ? "artifact-store" : "", production ? "job-store" : "",
                        false, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(10)),
                MediaLifecyclePublisher.disabled(),
                providers,
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()),
                List.of(), authority, null, Clock.systemUTC());
    }

    private static MediaProcessingProvider provider(
            String id, Set<JobType> capabilities, boolean productionEligible) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "test-" + id; }
            @Override public String providerVersion() { return "v1"; }
            @Override public Set<JobType> capabilities() { return capabilities; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return productionEligible; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public String processingRegion() { return "local"; }
            @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.NONE; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.completedFuture(Map.of());
            }
            @Override public void close() { }
        };
    }

    private static MediaSourceAuthorizationContracts.Authority allowAllAuthority() {
        return new MediaSourceAuthorizationContracts.Authority() {
            @Override public String authorityId() { return "fixture-authority"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public MediaSourceAuthorizationContracts.Decision resolve(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                if (!authenticated.tenantId().equals(request.tenantId())
                        || !authenticated.principalId().equals(request.principalId())) {
                    return new MediaSourceAuthorizationContracts.Decision(
                            MediaSourceAuthorizationContracts.Status.DENIED, null);
                }
                Instant now = Instant.now();
                var evidence = new MediaSourceAuthorizationContracts.Evidence(
                        authorityId(), "decision-" + request.artifactId(),
                        request.tenantId(), request.principalId(), "fixture-owner",
                        request.artifactId(), request.sourceVersion(), request.sourceSha256(),
                        request.operation(), request.purpose(), request.providerId(),
                        request.providerVersion(), request.processingBoundary(),
                        request.processingRegion(), request.providerRetention(),
                        Set.of(request.operation().toLowerCase(java.util.Locale.ROOT)),
                        Set.of(request.processingRegion()), Set.of(request.providerRetention()),
                        "rights-1", "policy-1", "policy-v1",
                        MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                        MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                        "", "fixture-clock", 0, now.minusSeconds(1), now.plusSeconds(300));
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.ALLOWED, evidence);
            }
            @Override public MediaSourceAuthorizationContracts.Decision revalidate(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.Evidence expectedEvidence,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.ALLOWED, expectedEvidence);
            }
        };
    }

    private static MediaSourceAuthorizationContracts.Authority denyAuthority() {
        return new MediaSourceAuthorizationContracts.Authority() {
            @Override public String authorityId() { return "fixture-authority"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public MediaSourceAuthorizationContracts.Decision resolve(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.DENIED, null);
            }
            @Override public MediaSourceAuthorizationContracts.Decision revalidate(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.Evidence expectedEvidence,
                    MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated) {
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.DENIED, null);
            }
        };
    }

    private static MediaSourceAuthorizationContracts.AuthenticatedPrincipal authenticated(
            String tenantId, String principalId) {
        return new MediaSourceAuthorizationContracts.AuthenticatedPrincipal(
                tenantId, principalId, Instant.now());
    }

    private static MediaArtifact artifact(
            MediaRuntime runtime, String tenantId, String principalId) throws Exception {
        byte[] bytes = ("probe-source-" + java.util.UUID.randomUUID()).getBytes(StandardCharsets.UTF_8);
        var upload = runtime.beginUpload(new com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest(
                tenantId, principalId, "source.wav", "audio/wav", bytes.length,
                HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)),
                "CONFIDENTIAL", Duration.ofMinutes(10), Map.of()),
                "probe-upload-" + java.util.UUID.randomUUID());
        runtime.appendChunk(tenantId, principalId, upload.uploadId(), 0, bytes);
        return runtime.completeUpload(tenantId, principalId, upload.uploadId());
    }
}
