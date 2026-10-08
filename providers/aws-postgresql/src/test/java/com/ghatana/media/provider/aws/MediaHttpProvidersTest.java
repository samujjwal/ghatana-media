package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.net.http.HttpRequest;
import java.nio.charset.StandardCharsets;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Verifies fail-closed remote Media processing and streaming provider configuration and bounds. */
class MediaHttpProvidersTest {

    @Test
    void unconfiguredProvidersRemainDiscoverableButIneligible() {
        HttpMediaProcessingProvider processing = new HttpMediaProcessingProvider(Map.of());
        HttpMediaStreamingProvider streaming = new HttpMediaStreamingProvider(Map.of());

        assertThat(processing.ready()).isFalse();
        assertThat(processing.productionEligible()).isFalse();
        assertThat(processing.capabilities()).contains(JobType.TRANSCODE, JobType.VISION);
        assertThat(streaming.ready()).isFalse();
        assertThat(streaming.productionEligible()).isFalse();
        assertThat(streaming.capabilities()).contains(StreamKind.AUDIO, StreamKind.VIDEO);
    }

    @Test
    void productionProvidersRequireHttpsAndTypedCredentials() {
        assertThatThrownBy(() -> new HttpMediaProcessingProvider(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "production",
                "MEDIA_HTTP_PROVIDER_ENDPOINT", "http://processor.example",
                "MEDIA_HTTP_PROVIDER_TOKEN_REFERENCE", "secret:env:MEDIA_TOKEN",
                "MEDIA_TOKEN", "token")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("requires HTTPS");

        assertThatThrownBy(() -> new HttpMediaProcessingProvider(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", " production ",
                "MEDIA_HTTP_PROVIDER_ENDPOINT", "http://processor.example",
                "MEDIA_HTTP_PROVIDER_TOKEN_REFERENCE", "secret:env:MEDIA_TOKEN",
                "MEDIA_TOKEN", "token")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("requires HTTPS");

        assertThatThrownBy(() -> new HttpMediaStreamingProvider(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", " STAGING ",
                "MEDIA_HTTP_PROVIDER_ENDPOINT", "https://processor.example")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("reference is required");

        assertThatThrownBy(() -> new HttpMediaStreamingProvider(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "production",
                "MEDIA_HTTP_PROVIDER_ENDPOINT", "https://processor.example")))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("reference is required");

        Map<String, String> configured = Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "production",
                "MEDIA_HTTP_PROVIDER_ENDPOINT", "https://processor.example/base/",
                "MEDIA_HTTP_PROVIDER_TOKEN_REFERENCE", "secret:env:MEDIA_TOKEN",
                "MEDIA_TOKEN", "token",
                "MEDIA_HTTP_PROVIDER_REGION", "us-west-2",
                "MEDIA_HTTP_PROVIDER_DATA_RETENTION", "NONE",
                "MEDIA_HTTP_PROVIDER_JOB_TYPES", "VISION,MULTIMODAL",
                "MEDIA_HTTP_PROVIDER_STREAM_KINDS", "VIDEO,MULTIMODAL",
                "MEDIA_HTTP_PROVIDER_PRIORITY", "7");
        HttpMediaProcessingProvider processing = new HttpMediaProcessingProvider(configured);
        HttpMediaStreamingProvider streaming = new HttpMediaStreamingProvider(configured);

        assertThat(processing.productionEligible()).isTrue();
        assertThat(processing.priority()).isEqualTo(7);
        assertThat(processing.capabilities()).containsExactlyInAnyOrder(JobType.VISION, JobType.MULTIMODAL);
        assertThat(streaming.productionEligible()).isTrue();
        assertThat(streaming.priority()).isEqualTo(7);
        assertThat(streaming.capabilities()).containsExactlyInAnyOrder(StreamKind.VIDEO, StreamKind.MULTIMODAL);
    }

    @Test
    void invalidCapabilitiesAndResponseBoundsFailAtComposition() {
        assertThatThrownBy(() -> new HttpMediaProcessingProvider(Map.of(
                "MEDIA_HTTP_PROVIDER_JOB_TYPES", "UNKNOWN")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new HttpMediaStreamingProvider(Map.of(
                "MEDIA_HTTP_PROVIDER_STREAM_KINDS", "UNKNOWN")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaHttpProviderClient(Map.of(
                "MEDIA_HTTP_PROVIDER_MAX_RESPONSE_BYTES", "0")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("MEDIA_HTTP_PROVIDER_MAX_RESPONSE_BYTES");
    }

    @Test
    void declaredOversizedResponseIsRejectedBeforeMaterialization() throws Exception {
        byte[] response = "x".repeat(2048).getBytes(StandardCharsets.UTF_8);
        HttpServer server = server(exchange -> {
            exchange.sendResponseHeaders(200, response.length);
            exchange.getResponseBody().write(response);
        });
        try {
            MediaHttpProviderClient client = client(server, 1024);
            HttpRequest request = client.request(client.resolve("large"))
                    .GET().timeout(client.timeout()).build();

            assertThatThrownBy(() -> client.send(request).join())
                    .hasRootCauseInstanceOf(IllegalStateException.class)
                    .hasRootCauseMessage("Media HTTP provider response exceeds 1024 bytes (observed=2048)");
        } finally {
            server.stop(0);
        }
    }

    @Test
    void chunkedOversizedResponseIsRejectedWhileStreaming() throws Exception {
        byte[] response = "y".repeat(2048).getBytes(StandardCharsets.UTF_8);
        HttpServer server = server(exchange -> {
            exchange.sendResponseHeaders(200, 0);
            exchange.getResponseBody().write(response);
        });
        try {
            MediaHttpProviderClient client = client(server, 1024);
            HttpRequest request = client.request(client.resolve("chunked"))
                    .GET().timeout(client.timeout()).build();

            assertThatThrownBy(() -> client.send(request).join())
                    .hasRootCauseInstanceOf(IllegalStateException.class)
                    .hasRootCauseMessage("Media HTTP provider response exceeds 1024 bytes (observed=1025)");
        } finally {
            server.stop(0);
        }
    }

    private static MediaHttpProviderClient client(HttpServer server, int maximumResponseBytes) {
        return new MediaHttpProviderClient(Map.of(
                "MEDIA_RUNTIME_ENVIRONMENT", "local",
                "MEDIA_HTTP_PROVIDER_ENDPOINT",
                "http://127.0.0.1:" + server.getAddress().getPort() + "/",
                "MEDIA_HTTP_PROVIDER_MAX_RESPONSE_BYTES", Integer.toString(maximumResponseBytes),
                "MEDIA_HTTP_PROVIDER_TIMEOUT_MS", "5000"));
    }

    private static HttpServer server(ExchangeHandler handler) throws IOException {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/", exchange -> {
            try (exchange) {
                handler.handle(exchange);
            }
        });
        server.start();
        return server;
    }

    @FunctionalInterface
    private interface ExchangeHandler {
        void handle(HttpExchange exchange) throws IOException;
    }
}
