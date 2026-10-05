package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaLifecyclePublisherTest {

    @Test
    void publishesNeutralIdempotentEventPlaneContractWithoutRawMedia() throws Exception {
        AtomicReference<String> body = new AtomicReference<>();
        AtomicReference<String> idempotencyKey = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/streams/media-lifecycle/events", exchange -> {
            try (exchange) {
                body.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                idempotencyKey.set(exchange.getRequestHeaders().getFirst("Idempotency-Key"));
                exchange.sendResponseHeaders(201, -1);
            }
        });
        server.start();
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:" + server.getAddress().getPort()), false)) {
            publisher.publish(new MediaLifecycleEvent(
                    "media:media.job.completed:job-1:3", "media.job.completed",
                    "tenant-a", "principal-a", "correlation-a", "request-a",
                    "job", "job-1", 3, "CONFIDENTIAL", Instant.now(),
                    Map.of("artifactId", "artifact-1", "status", "COMPLETED")));
        } finally {
            server.stop(0);
        }

        assertThat(idempotencyKey).hasValue("media:media.job.completed:job-1:3");
        assertThat(body.get())
                .contains("\"source\":\"media\"")
                .contains("\"aggregateId\":\"job-1\"")
                .doesNotContain("rawMedia", "payloadBase64", "transcript");
    }

    @Test
    void productionRequiresConfiguredHttpsEventPlaneBoundary() {
        assertThatThrownBy(() -> MediaLifecyclePublisher.compose(Map.of(), true))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("MEDIA_EVENT_PLANE_URL");
        assertThatThrownBy(() -> MediaLifecyclePublisher.compose(
                Map.of("MEDIA_EVENT_PLANE_URL", "http://event-plane.example"), true))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("HTTPS");
    }
}
