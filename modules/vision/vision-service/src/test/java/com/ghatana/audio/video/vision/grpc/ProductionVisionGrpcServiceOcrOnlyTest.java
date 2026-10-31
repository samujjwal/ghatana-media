package com.ghatana.audio.video.vision.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.vision.scenetext.MediaRuntimeSceneTextSource;
import com.ghatana.media.runtime.MediaProcessingRuntimePort;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.io.OutputStream;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** OCR_ONLY profile composition: DI-bound scene text with no detector anywhere in the path. */
class ProductionVisionGrpcServiceOcrOnlyTest {

    private HttpServer di;
    private volatile String catalogJson = catalog("ACCEPTED", true, true);

    @BeforeEach
    void start() throws IOException {
        di = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        di.createContext("/v1/providers", exchange -> {
            byte[] body = catalogJson.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("content-type", "application/json");
            exchange.sendResponseHeaders(200, body.length);
            exchange.getResponseBody().write(body);
            exchange.close();
        });
        di.start();
    }

    @AfterEach
    void stop() { di.stop(0); }

    @Test
    void ocrOnlyBindsSceneTextWithoutDetectorAndKeepsDetectorRpcsUnavailable() {
        ProductionVisionGrpcService.Composition composition = ProductionVisionGrpcService.compose(
                environment(), new FakePort());
        assertThat(composition.detector()).isNull();
        assertThat(composition.profile()).isNull();
        assertThat(composition.sceneText()).isNotNull();

        ProductionVisionGrpcService service = new ProductionVisionGrpcService(
                composition, MediaProcessingMetrics.create());
        try {
            assertThat(service.isProviderReady()).isTrue();
            assertThat(service.isInferenceProviderAdmitted()).isFalse();
        } finally {
            service.close();
        }
    }

    @Test
    void ocrOnlyReadinessTracksLiveDiCatalogNotADummyDetector() {
        ProductionVisionGrpcService service = new ProductionVisionGrpcService(
                ProductionVisionGrpcService.compose(environment(), new FakePort()),
                MediaProcessingMetrics.create());
        try {
            assertThat(service.isProviderReady()).isTrue();
            catalogJson = catalog("UNPROMOTED", true, true);
            assertThat(service.isProviderReady()).isFalse();
        } finally {
            service.close();
        }
    }

    @Test
    void ocrOnlyFailsClosedWithoutRuntimePortOrDiEndpoint() {
        Map<String, String> environment = environment();
        assertThatThrownBy(() -> ProductionVisionGrpcService.compose(environment, null))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("runtime port");
        environment.remove("DI_ENDPOINT");
        assertThatThrownBy(() -> ProductionVisionGrpcService.compose(environment, new FakePort()))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("DI_ENDPOINT");
    }

    @Test
    void unknownCapabilityProfileIsRejected() {
        Map<String, String> environment = environment();
        environment.put("VISION_CAPABILITY_PROFILE", "SOMETHING_ELSE");
        assertThatThrownBy(() -> ProductionVisionGrpcService.compose(environment, new FakePort()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("VISION_CAPABILITY_PROFILE");
    }

    private Map<String, String> environment() {
        Map<String, String> environment = new HashMap<>();
        environment.put("VISION_CAPABILITY_PROFILE", "OCR_ONLY");
        environment.put("DI_ENDPOINT", "http://127.0.0.1:" + di.getAddress().getPort());
        environment.put("DI_PROVIDER_REF", "di.ocr.en");
        environment.put("DI_PROVIDER_VERSION", "2.4.1");
        environment.put("DI_MODEL_REF", "model.scene-text.en");
        environment.put("DI_MODEL_VERSION", "2026.09.2");
        environment.put("DI_ACCEPTED_MEDIA_TYPES", "image/png");
        environment.put("DI_ACCEPTED_LANGUAGES", "en");
        return environment;
    }

    private static String catalog(String promotion, boolean loaded, boolean ready) {
        return "{\"protocolVersion\":\"document-intelligence.v1\","
                + "\"workerCapabilityVersion\":\"document-intelligence-worker.v1\","
                + "\"providers\":[{\"providerRef\":\"di.ocr.en\",\"providerVersion\":\"2.4.1\","
                + "\"modelRef\":\"model.scene-text.en\",\"modelVersion\":\"2026.09.2\","
                + "\"mediaTypes\":[\"image/png\"],\"supportedLanguages\":[\"en\"],"
                + "\"promotionStatus\":\"" + promotion + "\",\"loaded\":" + loaded + ",\"ready\":" + ready + "}]}";
    }

    private static final class FakePort implements MediaProcessingRuntimePort {
        @Override public ProcessingJob submit(ProcessingJobRequest request) {
            throw new UnsupportedOperationException();
        }

        @Override public Optional<ProcessingJob> job(String tenantId, String principalId, String jobId) {
            return Optional.empty();
        }

        @Override public Optional<MediaArtifact> artifact(String tenantId, String principalId, String artifactId) {
            return Optional.empty();
        }

        @Override public com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision resolveSourceAuthorization(
                String tenantId, String principalId, String artifactId, ArtifactVersion sourceVersion,
                JobType jobType, String purpose, AuthenticatedPrincipal authenticated) {
            return new com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Decision(
                    com.ghatana.media.runtime.MediaSourceAuthorizationContracts.Status.UNAVAILABLE, null);
        }
    }
}
