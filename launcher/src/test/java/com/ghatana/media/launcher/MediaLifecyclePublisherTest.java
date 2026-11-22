package com.ghatana.media.launcher;

import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;
import tools.jackson.core.type.TypeReference;
import com.ghatana.media.runtime.MediaLifecycleEvent;
import com.ghatana.media.runtime.MediaLifecyclePublicationReceipt;
import com.ghatana.media.runtime.MediaLifecyclePublicationOutcomeUnknownException;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;

import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Instant;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
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
        AtomicReference<String> authorizationHeader = new AtomicReference<>();
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
                authorizationHeader.set(exchange.getRequestHeaders().getFirst("Authorization"));
                method.set(exchange.getRequestMethod());
                contentType.set(exchange.getRequestHeaders().getFirst("Content-Type"));
                byte[] receipt = validReceipt().getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(201, receipt.length);
                exchange.getResponseBody().write(receipt);
            }
        });
        server.start();
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(devRelayEnvironment(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:" + server.getAddress().getPort())), false)) {
            MediaLifecyclePublicationReceipt receipt = publisher.publishWithReceipt(new MediaLifecycleEvent(
                    "media:media.job.completed:job-1:3", "media.job.completed",
                    "tenant-a", "principal-a", "correlation-a", "request-a",
                    "job", "job-1", 3, "CONFIDENTIAL", Instant.now(),
                    Map.of("artifactId", "artifact-1", "status", "COMPLETED")));
            assertThat(receipt.eventId()).isEqualTo("media:media.job.completed:job-1:3");
            assertThat(receipt.storedEventId()).isEqualTo(
                    MediaLifecyclePublicationReceipt.stableStoredEventId(receipt.eventId()));
            assertThat(receipt.streamId()).isEqualTo("media-lifecycle");
            assertThat(receipt.offset()).isEqualTo("0");
        } finally {
            server.stop(0);
        }

        assertThat(idempotencyKey).hasValue(tenantScopedIdempotencyKey(
                "tenant-a", "media:media.job.completed:job-1:3"));
        assertThat(tenantHeader).hasValue("tenant-a");
        assertThat(principalHeader).hasValue("principal-a");
        assertThat(correlationHeader).hasValue("correlation-a");
        assertThat(authorizationHeader).hasValue("Bearer dev-event-plane-token");
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
        AtomicInteger postCalls = new AtomicInteger();
        AtomicInteger lookupCalls = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/streams/media-lifecycle/events", exchange -> {
            try (exchange) {
                if ("GET".equals(exchange.getRequestMethod())) {
                    lookupCalls.incrementAndGet();
                    exchange.sendResponseHeaders(404, -1);
                } else {
                    postCalls.incrementAndGet();
                    exchange.getRequestBody().readAllBytes();
                    exchange.sendResponseHeaders(200, -1);
                }
            }
        });
        server.start();
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(devRelayEnvironment(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:" + server.getAddress().getPort())), false)) {
            assertThatThrownBy(() -> publisher.publish(event()))
                    .isInstanceOf(MediaLifecyclePublicationOutcomeUnknownException.class)
                    .hasMessageContaining("append remains unknown");
        } finally {
            server.stop(0);
        }
        assertThat(postCalls).hasValue(2);
        assertThat(lookupCalls).hasValue(2);
    }

    @Test
    void definitiveAppendRejectionDoesNotTriggerReadbackOrImmediateReplay() throws Exception {
        AtomicInteger postCalls = new AtomicInteger();
        AtomicInteger lookupCalls = new AtomicInteger();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/streams/media-lifecycle/events", exchange -> {
            try (exchange) {
                if ("GET".equals(exchange.getRequestMethod())) {
                    lookupCalls.incrementAndGet();
                    exchange.sendResponseHeaders(404, -1);
                } else {
                    postCalls.incrementAndGet();
                    exchange.getRequestBody().readAllBytes();
                    exchange.sendResponseHeaders(401, -1);
                }
            }
        });
        server.start();
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(devRelayEnvironment(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:" + server.getAddress().getPort())), false)) {
            assertThatThrownBy(() -> publisher.publishWithReceipt(event()))
                    .isInstanceOf(IllegalStateException.class)
                    .hasMessageContaining("rejected")
                    .hasMessageContaining("401");
        } finally {
            server.stop(0);
        }
        assertThat(postCalls).hasValue(1);
        assertThat(lookupCalls).hasValue(0);
    }

    @Test
    void rejectsEventPlaneIdentifierOverflowBeforeSending() throws Exception {
        AtomicReference<Boolean> called = new AtomicReference<>(false);
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/streams/media-lifecycle/events", exchange -> {
            called.set(true);
            try (exchange) {
                exchange.getRequestBody().readAllBytes();
                byte[] receipt = validReceipt().getBytes(StandardCharsets.UTF_8);
                exchange.sendResponseHeaders(201, receipt.length);
                exchange.getResponseBody().write(receipt);
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
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(devRelayEnvironment(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:" + server.getAddress().getPort())), false)) {
            publisher.publish(valid);
        } finally {
            server.stop(0);
        }
        assertThat(called).hasValue(true);
    }

    @Test
    void synchronousHttpsPublisherIsNotProductionEligibleWithoutDurableOutbox() {
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(devRelayEnvironment(Map.of(
                "MEDIA_EVENT_PLANE_URL", "https://event-plane.example")), false)) {
            assertThat(publisher.ready()).isTrue();
            assertThat(publisher.productionEligible()).isFalse();
        }
    }

    @Test
    void configuredEventPlaneDoesNotStartRelayWithoutExplicitDevOnlyHostIdentity() throws Exception {
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
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:" + server.getAddress().getPort()), false)) {
            assertThat(publisher.ready()).isFalse();
            publisher.publish(event());
        } finally {
            server.stop(0);
        }
        assertThat(called).hasValue(false);
    }

    @Test
    void devOnlyRelayRequiresAuthenticatedDestinationAndLoopbackOrHttps() {
        Map<String, String> unauthenticated = new HashMap<>(devRelayEnvironment(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:8099")));
        unauthenticated.remove("MEDIA_EVENT_PLANE_TOKEN_REFERENCE");
        unauthenticated.remove("MEDIA_EVENT_PLANE_TOKEN");
        assertThatThrownBy(() -> MediaLifecyclePublisher.compose(unauthenticated, false))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("bearer token reference is required");

        assertThatThrownBy(() -> MediaLifecyclePublisher.compose(devRelayEnvironment(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://event-plane.example")), false))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("loopback destination");

        Map<String, String> noReader = new HashMap<>(devRelayEnvironment(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:8099")));
        noReader.remove("MEDIA_EVENT_PLANE_READ_TOKEN_REFERENCE");
        noReader.remove("MEDIA_EVENT_PLANE_READ_TOKEN");
        assertThatThrownBy(() -> MediaLifecyclePublisher.compose(noReader, false))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("read bearer token reference is required");

        Map<String, String> sameReaderAndWriter = new HashMap<>(devRelayEnvironment(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:8099",
                "MEDIA_EVENT_PLANE_READ_TOKEN_REFERENCE", "secret:env:MEDIA_EVENT_PLANE_TOKEN")));
        assertThatThrownBy(() -> MediaLifecyclePublisher.compose(sameReaderAndWriter, false))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("separate secret references");
    }

    @Test
    void doesNotAcceptAppendWithoutExactEventPlaneReceipt() throws Exception {
        String callerEventId = "media:media.job.completed:job-1:3";
        String storedEventId = UUID.nameUUIDFromBytes(callerEventId.getBytes(StandardCharsets.UTF_8)).toString();
        AtomicInteger postCalls = new AtomicInteger();
        AtomicInteger lookupCalls = new AtomicInteger();
        AtomicReference<String> firstKey = new AtomicReference<>();
        AtomicReference<String> secondKey = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/streams/media-lifecycle/events", exchange -> {
            try (exchange) {
                if ("GET".equals(exchange.getRequestMethod())) {
                    lookupCalls.incrementAndGet();
                    exchange.sendResponseHeaders(404, -1);
                } else {
                    exchange.getRequestBody().readAllBytes();
                    int attempt = postCalls.incrementAndGet();
                    String key = exchange.getRequestHeaders().getFirst("Idempotency-Key");
                    if (attempt == 1) firstKey.set(key); else secondKey.set(key);
                    byte[] receipt = ("{\"eventId\":\"" + callerEventId + "\","
                            + "\"storedEventId\":\"" + storedEventId + "\","
                            + "\"idempotencyKey\":\"" + key + "\","
                            + "\"streamId\":\"media-lifecycle\",\"offset\":\"-1\"}")
                            .getBytes(StandardCharsets.UTF_8);
                    exchange.sendResponseHeaders(201, receipt.length);
                    exchange.getResponseBody().write(receipt);
                }
            }
        });
        server.start();
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(devRelayEnvironment(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:" + server.getAddress().getPort())), false)) {
            assertThatThrownBy(() -> publisher.publish(event()))
                    .isInstanceOf(MediaLifecyclePublicationOutcomeUnknownException.class)
                    .hasMessageContaining("append remains unknown");
        } finally {
            server.stop(0);
        }
        assertThat(postCalls).hasValue(2);
        assertThat(lookupCalls).hasValue(2);
        assertThat(secondKey).hasValue(firstKey.get());
    }

    @Test
    void lostAppendResponseUsesExactReadbackWithoutDuplicatePost() throws Exception {
        AtomicInteger postCalls = new AtomicInteger();
        AtomicInteger lookupCalls = new AtomicInteger();
        AtomicReference<String> idempotencyKey = new AtomicReference<>();
        AtomicReference<String> lookupAuthorization = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/streams/media-lifecycle/events", exchange -> {
            if ("GET".equals(exchange.getRequestMethod())) {
                lookupCalls.incrementAndGet();
                lookupAuthorization.set(exchange.getRequestHeaders().getFirst("Authorization"));
                byte[] record = validReadback(idempotencyKey.get(), "43").getBytes(StandardCharsets.UTF_8);
                try (exchange) {
                    exchange.sendResponseHeaders(200, record.length);
                    exchange.getResponseBody().write(record);
                }
                return;
            }
            postCalls.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            idempotencyKey.set(exchange.getRequestHeaders().getFirst("Idempotency-Key"));
            exchange.close(); // Simulate a committed append whose HTTP response was lost.
        });
        server.start();
        MediaLifecyclePublicationReceipt receipt;
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(devRelayEnvironment(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:" + server.getAddress().getPort())), false)) {
            receipt = publisher.publishWithReceipt(event());
        } finally {
            server.stop(0);
        }
        assertThat(postCalls).hasValue(1);
        assertThat(lookupCalls).hasValue(1);
        assertThat(idempotencyKey).hasValue(tenantScopedIdempotencyKey(
                "tenant-a", event().eventId()));
        assertThat(lookupAuthorization).hasValue("Bearer dev-event-plane-read-token");
        assertThat(receipt).isEqualTo(new MediaLifecyclePublicationReceipt(
                event().eventId(), MediaLifecyclePublicationReceipt.stableStoredEventId(event().eventId()),
                "media-lifecycle", "43"));
    }

    @Test
    void completeAbsenceAllowsOneReplayWithTheSameTenantScopedKey() throws Exception {
        AtomicInteger postCalls = new AtomicInteger();
        AtomicInteger lookupCalls = new AtomicInteger();
        AtomicReference<String> firstKey = new AtomicReference<>();
        AtomicReference<String> replayKey = new AtomicReference<>();
        AtomicReference<String> firstBody = new AtomicReference<>();
        AtomicReference<String> replayBody = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/streams/media-lifecycle/events", exchange -> {
            if ("GET".equals(exchange.getRequestMethod())) {
                lookupCalls.incrementAndGet();
                try (exchange) {
                    exchange.sendResponseHeaders(404, -1);
                }
                return;
            }
            String body = new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8);
            String key = exchange.getRequestHeaders().getFirst("Idempotency-Key");
            int attempt = postCalls.incrementAndGet();
            if (attempt == 1) {
                firstKey.set(key);
                firstBody.set(body);
                exchange.close();
                return;
            }
            replayKey.set(key);
            replayBody.set(body);
            byte[] receipt = validReceipt(key).getBytes(StandardCharsets.UTF_8);
            try (exchange) {
                exchange.sendResponseHeaders(201, receipt.length);
                exchange.getResponseBody().write(receipt);
            }
        });
        server.start();
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(devRelayEnvironment(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:" + server.getAddress().getPort())), false)) {
            assertThat(publisher.publishWithReceipt(event()).offset()).isEqualTo("0");
        } finally {
            server.stop(0);
        }
        assertThat(postCalls).hasValue(2);
        assertThat(lookupCalls).hasValue(1);
        assertThat(replayKey).hasValue(firstKey.get());
        assertThat(replayBody).hasValue(firstBody.get());
    }

    @Test
    void incompleteLookupNeverRepostsAmbiguousAppend() throws Exception {
        for (int lookupStatus : new int[] {422, 503}) {
            AtomicInteger postCalls = new AtomicInteger();
            AtomicInteger lookupCalls = new AtomicInteger();
            HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            server.createContext("/api/v1/streams/media-lifecycle/events", exchange -> {
                if ("GET".equals(exchange.getRequestMethod())) {
                    lookupCalls.incrementAndGet();
                    try (exchange) {
                        exchange.sendResponseHeaders(lookupStatus, -1);
                    }
                    return;
                }
                postCalls.incrementAndGet();
                exchange.getRequestBody().readAllBytes();
                exchange.close();
            });
            server.start();
            try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(devRelayEnvironment(Map.of(
                    "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:" + server.getAddress().getPort())), false)) {
                assertThatThrownBy(() -> publisher.publishWithReceipt(event()))
                        .isInstanceOf(MediaLifecyclePublicationOutcomeUnknownException.class);
            } finally {
                server.stop(0);
            }
            assertThat(postCalls).hasValue(1);
            assertThat(lookupCalls).hasValue(1);
        }
    }

    @Test
    void mismatchedExactReadbackNeverRepostsAmbiguousAppend() throws Exception {
        AtomicInteger postCalls = new AtomicInteger();
        AtomicInteger lookupCalls = new AtomicInteger();
        AtomicReference<String> idempotencyKey = new AtomicReference<>();
        HttpServer server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        server.createContext("/api/v1/streams/media-lifecycle/events", exchange -> {
            if ("GET".equals(exchange.getRequestMethod())) {
                lookupCalls.incrementAndGet();
                byte[] record = validReadback(idempotencyKey.get(), "43")
                        .replace("artifact-1", "different-artifact")
                        .getBytes(StandardCharsets.UTF_8);
                try (exchange) {
                    exchange.sendResponseHeaders(200, record.length);
                    exchange.getResponseBody().write(record);
                }
                return;
            }
            postCalls.incrementAndGet();
            exchange.getRequestBody().readAllBytes();
            idempotencyKey.set(exchange.getRequestHeaders().getFirst("Idempotency-Key"));
            exchange.close();
        });
        server.start();
        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(devRelayEnvironment(Map.of(
                "MEDIA_EVENT_PLANE_URL", "http://127.0.0.1:" + server.getAddress().getPort())), false)) {
            assertThatThrownBy(() -> publisher.publishWithReceipt(event()))
                    .isInstanceOf(MediaLifecyclePublicationOutcomeUnknownException.class)
                    .hasMessageContaining("exact lookup");
        } finally {
            server.stop(0);
        }
        assertThat(postCalls).hasValue(1);
        assertThat(lookupCalls).hasValue(1);
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

        try (MediaLifecyclePublisher publisher = MediaLifecyclePublisher.compose(Map.of(
                "MEDIA_EVENT_PLANE_URL", "https://event-plane.example",
                "MEDIA_EVENT_PLANE_TOKEN_REFERENCE", "secret:env:MEDIA_EVENT_PLANE_TOKEN",
                "MEDIA_EVENT_PLANE_TOKEN", "production-token"), true)) {
            assertThat(publisher.ready()).isFalse();
            assertThat(publisher.productionEligible()).isFalse();
        }
    }

    private static Map<String, String> devRelayEnvironment(Map<String, String> additions) {
        Map<String, String> environment = new HashMap<>(Map.of(
                "MEDIA_PROFILE", "dev",
                "MEDIA_DEV_IDENTITY_ENABLED", "true",
                "MEDIA_EVENT_PLANE_TOKEN_REFERENCE", "secret:env:MEDIA_EVENT_PLANE_TOKEN",
                "MEDIA_EVENT_PLANE_TOKEN", "dev-event-plane-token",
                "MEDIA_EVENT_PLANE_READ_TOKEN_REFERENCE", "secret:env:MEDIA_EVENT_PLANE_READ_TOKEN",
                "MEDIA_EVENT_PLANE_READ_TOKEN", "dev-event-plane-read-token"));
        environment.putAll(additions);
        return Map.copyOf(environment);
    }

    private static String validReceipt() {
        return validReceipt(tenantScopedIdempotencyKey(
                "tenant-a", "media:media.job.completed:job-1:3"));
    }

    private static String validReceipt(String idempotencyKey) {
        String callerEventId = "media:media.job.completed:job-1:3";
        String storedEventId = UUID.nameUUIDFromBytes(callerEventId.getBytes(StandardCharsets.UTF_8)).toString();
        return "{\"eventId\":\"" + callerEventId + "\",\"storedEventId\":\""
                + storedEventId + "\",\"idempotencyKey\":\"" + idempotencyKey
                + "\",\"streamId\":\"media-lifecycle\",\"offset\":\"0\"}";
    }

    private static String validReadback(String idempotencyKey, String offset) {
        MediaLifecycleEvent event = event();
        Map<String, Object> payload = new HashMap<>();
        payload.put("aggregateType", event.aggregateType());
        payload.put("aggregateId", event.aggregateId());
        payload.put("aggregateVersion", event.aggregateVersion());
        payload.put("classification", event.classification());
        payload.put("attributes", event.attributes());
        ObjectMapper mapper = JsonMapper.builder().build();
        Map<String, Object> headers = Map.of(
                "tenantId", event.tenantId(),
                "principalId", event.principalId(),
                "callerEventId", event.eventId(),
                "streamId", "media-lifecycle",
                "correlationId", event.correlationId());
        Map<String, Object> record = new HashMap<>();
        String storedEventId = MediaLifecyclePublicationReceipt.stableStoredEventId(event.eventId());
        record.put("eventId", storedEventId);
        record.put("storedEventId", storedEventId);
        record.put("callerEventId", event.eventId());
        record.put("streamId", "media-lifecycle");
        record.put("offset", offset);
        record.put("eventType", event.eventType());
        record.put("eventVersion", "1.0.0");
        record.put("timestamp", event.occurredAt().toString());
        record.put("contentType", "application/json");
        record.put("headers", headers);
        record.put("idempotencyKey", idempotencyKey);
        record.put("correlationId", event.correlationId());
        record.put("causationId", event.causationId());
        record.put("source", "media");
        record.put("userId", event.principalId());
        try {
            record.put("payload", mapper.writeValueAsString(payload));
            return mapper.writeValueAsString(record);
        } catch (Exception failure) {
            throw new IllegalStateException("Could not create the exact Event Plane readback fixture", failure);
        }
    }

    private static String tenantScopedIdempotencyKey(String tenantId, String eventId) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            digest.update(tenantId.getBytes(StandardCharsets.UTF_8));
            digest.update((byte) 0);
            digest.update(eventId.getBytes(StandardCharsets.UTF_8));
            return "media-" + java.util.HexFormat.of().formatHex(digest.digest());
        } catch (Exception failure) {
            throw new IllegalStateException(failure);
        }
    }

    private static MediaLifecycleEvent event() {
        return new MediaLifecycleEvent(
                "media:media.job.completed:job-1:3", "media.job.completed",
                "tenant-a", "principal-a", "correlation-a", "request-a",
                "job", "job-1", 3, "CONFIDENTIAL", Instant.parse("2026-10-07T00:00:00Z"),
                Map.of("artifactId", "artifact-1", "status", "COMPLETED"));
    }
}
