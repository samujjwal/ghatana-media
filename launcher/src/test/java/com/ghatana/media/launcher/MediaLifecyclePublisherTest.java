package com.ghatana.media.launcher;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.core.type.TypeReference;
import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaLifecyclePublisherTest {
    private final ObjectMapper mapper = JsonMapper.builder().build();

    @Test
    void publishesNeutralIdempotentEventPlaneContractWithoutRawMedia() throws Exception {
        AtomicReference<String> body = new AtomicReference<>();
        AtomicReference<String> idempotencyKey = new AtomicReference<>();
        AtomicReference<String> tenantHeader = new AtomicReference<>();
        AtomicReference<String> principalHeader = new AtomicReference<>();
        AtomicReference<String> correlationHeader = new AtomicReference<>();
        AtomicReference<String> method = new AtomicReference<>();
        AtomicReference<String> contentType = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/streams/media-lifecycle/events", exchange -> {
            try (exchange) {
                body.set(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
                idempotencyKey.set(exchange.getRequestHeaders().getFirst("Idempotency-Key"));
                tenantHeader.set(exchange.getRequestHeaders().getFirst("X-Tenant-Id"));
                principalHeader.set(exchange.getRequestHeaders().getFirst("X-Principal-Id"));
                correlationHeader.set(exchange.getRequestHeaders().getFirst("X-Correlation-Id"));
                method.set(exchange.getRequestMethod());
                contentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
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
        assertThat(tenantHeader).hasValue("tenant-a");
        assertThat(principalHeader).hasValue("principal-a");
        assertThat(correlationHeader).hasValue("correlation-a");
        assertThat(method).hasValue("POST");
        assertThat(contentType).hasValue("application/json");
        Map<String, Object> request = mapper.readValue(body.get(), new TypeReference<>() { });
        assertThat(request.keySet()).containsExactlyInAnyOrderElementsOf(Set.of(
                "eventId", "eventType", "eventVersion", "timestamp", "correlationId",
                "causationId", "source", "userId", "contentType", "payload"));
        assertThat(request)
                .containsEntry("eventId", "media:media.job.completed:job-1:3")
                .containsEntry("eventType", "media.job.completed")
                .containsEntry("eventVersion", "1.0.0")
                .containsEntry("correlationId", "correlation-a")
                .containsEntry("causationId", "request-a")
                .containsEntry("source", "media")
                .containsEntry("userId", "principal-a")
                .containsEntry("contentType", "application/json");
        assertThat(request).containsKey("timestamp");
        @SuppressWarnings("unchecked")
        Map<String, Object> payload = (Map<String, Object>) request.get("payload");
        assertThat(payload)
                .containsEntry("aggregateType", "job")
                .containsEntry("aggregateId", "job-1")
                .containsEntry("aggregateVersion", 3)
                .containsEntry("classification", "CONFIDENTIAL")
                .containsEntry("attributes", Map.of("artifactId", "artifact-1", "status", "COMPLETED"));

        assertThat(body.get()).doesNotContain("rawMedia", "payloadBase64", "transcript");
    }

    @Test
    void doesNotTreatNonContractSuccessStatusAsDurableAcceptance() throws Exception {
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/streams/media-lifecycle/events", exchange -> {
            try (exchange) {
                exchange.getRequestBody().readAllBytes();
                exchange.sendResponseHeaders(200, -1);
            }
        });
        server.start();
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:" + server.getAddress().getPort()), false)) {
            assertThatThrownBy(() -> publisher.publish(event()))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("status 200");
        } finally {
            server.stop(0);
        }
    }

    @Test
    void rejectsEventPlaneIdentifierOverflowBeforeSending() throws Exception {
        AtomicReference<Boolean> called = new AtomicReference<>(false);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/streams/media-lifecycle/events", exchange -> {
            called.set(true);
            try (exchange) {
                exchange.getRequestBody().readAllBytes();
                exchange.sendResponseHeaders(201, -1);
            }
        });
        server.start();
        MediaLifecycleEvent valid = event();
        assertThatThrownBy(() -> new MediaLifecycleEvent(
                "x".repeat(256), valid.eventType(), valid.tenantId(), valid.principalId(),
                valid.correlationId(), valid.causationId(), valid.aggregateType(), valid.aggregateId(),
                valid.aggregateVersion(), valid.classification(), valid.occurredAt(), valid.attributes()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("bounded");
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:" + server.getAddress().getPort()), false)) {
            publisher.publish(valid);
        } finally {
            server.stop(0);
        }
        assertThat(called).hasValue(true);
    }

    @Test
    void synchronousHttpsPublisherIsNotProductionEligibleWithoutDurableOutbox() {
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(Map.of(
                "MEDIA_EVENT_PLANE_URL", "https://event-plane.example"), false)) {
            assertThat(publisher.ready()).isTrue();
            assertThat(publisher.productionEligible()).isFalse();
        }
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

    private static MediaLifecycleEvent event() {
        return new MediaLifecycleEvent(
                "media:media.job.completed:job-1:3", "media.job.completed",
                "tenant-a", "principal-a", "correlation-a", "request-a",
                "job", "job-1", 3, "CONFIDENTIAL", Instant.parse("2026-10-07T00:00:00Z"),
                Map.of("artifactId", "artifact-1", "status", "COMPLETED"));
    }
}
