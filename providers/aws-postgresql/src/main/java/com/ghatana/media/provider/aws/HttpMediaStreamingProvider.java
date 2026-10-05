package com.ghatana.media.provider.aws;

import tools.jackson.databind.JsonNode;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamAck;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;

import java.net.URLEncoder;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.time.Instant;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;
import java.util.concurrent.TimeUnit;

/**
 * Remote adapter for consent-, purpose-, and residency-governed Media streaming.
 *
 * @doc.type class
 * @doc.purpose Provide Http Media Streaming Provider behavior
 * @doc.layer product
 * @doc.pattern Provider
 */
public final class HttpMediaStreamingProvider implements MediaStreamingProvider {
    private static final Duration MAX_STREAM_LEASE = Duration.ofHours(1);

    private final MediaHttpProviderClient client;
    private final Set<StreamKind> capabilities;
    private final ConcurrentMap<String, Object> sessionLocks = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, Instant> closingSessions = new ConcurrentHashMap<>();
    private final ConcurrentMap<String, Set<CompletableFuture<HttpResponse<byte[]>>>> activeFrames =
            new ConcurrentHashMap<>();

    public HttpMediaStreamingProvider() { this(System.getenv()); }

    HttpMediaStreamingProvider(Map<String, String> environment) {
        client = new MediaHttpProviderClient(environment);
        capabilities = streamKinds(environment.getOrDefault(
                "MEDIA_HTTP_PROVIDER_STREAM_KINDS", "AUDIO,VIDEO,MULTIMODAL"));
    }

    @Override public String providerId() { return "http-media-streaming"; }
    @Override public Set<StreamKind> capabilities() { return Set.copyOf(capabilities); }
    @Override public boolean ready() { return client.ready() && !capabilities.isEmpty(); }
    @Override public boolean productionEligible() { return client.productionEligible() && !capabilities.isEmpty(); }
    @Override public int priority() { return client.priority(); }
    @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.EXTERNAL; }
    @Override public String processingRegion() { return client.processingRegion(); }
    @Override public ProviderDataRetention providerDataRetention() { return client.providerDataRetention(); }

    @Override
    public CompletableFuture<StreamAck> accept(StreamContext context, StreamFrame frame) {
        client.requireConfigured();
        java.util.Objects.requireNonNull(context, "context");
        java.util.Objects.requireNonNull(frame, "frame");
        context.cancellation().throwIfCancelled();
        requireActiveExternalGovernance(context);
        HttpRequest request = client.request(client.resolve(
                        "v1/streams/" + url(frame.sessionId()) + "/frames/" + frame.sequence()))
                .header("Content-Type", "application/octet-stream")
                .header("Accept", "application/json")
                .header("X-Tenant-Id", frame.tenantId())
                .header("X-Stream-Kind", context.session().streamKind().name())
                .header("X-End-Of-Stream", Boolean.toString(frame.endOfStream()))
                .header("X-Consent-Id", context.consentDecision().consentId())
                .header("X-Processing-Region", processingRegion())
                .timeout(client.timeout())
                .POST(HttpRequest.BodyPublishers.ofByteArray(frame.payload()))
                .build();
        String sessionKey = sessionKey(frame.tenantId(), frame.sessionId());
        Object lock = sessionLocks.computeIfAbsent(sessionKey, ignored -> new Object());
        CompletableFuture<HttpResponse<byte[]>> raw;
        synchronized (lock) {
            clearExpiredClose(sessionKey, Instant.now());
            if (context.cancellation().cancelled() || closingSessions.containsKey(sessionKey)) {
                return CompletableFuture.failedFuture(
                        new CancellationException("Media stream session is closing or closed"));
            }
            raw = client.send(request);
            activeFrames.computeIfAbsent(sessionKey, ignored -> ConcurrentHashMap.newKeySet())
                    .add(raw);
        }

        CompletableFuture<StreamAck> result = new CompletableFuture<>();
        raw.whenComplete((response, failure) -> {
            if (result.isDone()) return;
            if (closingSessions.containsKey(sessionKey)) {
                result.completeExceptionally(
                        new CancellationException("Media stream session was closed after frame dispatch"));
                return;
            }
            if (failure != null) {
                result.completeExceptionally(unwrap(failure));
                return;
            }
            try {
                JsonNode json = client.json(response, "Media stream frame");
                result.complete(new StreamAck(
                        json.path("acceptedSequence").asLong(frame.sequence()),
                        json.path("bufferedBytes").asLong(context.session().bufferedBytes()),
                        json.path("backpressured").asBoolean(false)));
            } catch (RuntimeException invalid) {
                result.completeExceptionally(invalid);
            }
        });
        result.whenComplete((ignored, ignoredFailure) -> {
            if (result.isCancelled()) raw.cancel(true);
            Set<CompletableFuture<HttpResponse<byte[]>>> active = activeFrames.get(sessionKey);
            if (active != null) {
                active.remove(raw);
                if (active.isEmpty()) activeFrames.remove(sessionKey, active);
            }
            if (!closingSessions.containsKey(sessionKey) && !activeFrames.containsKey(sessionKey)) {
                sessionLocks.remove(sessionKey, lock);
            }
        });
        return result;
    }

    @Override
    public void closeSession(StreamContext context) {
        if (!client.configured()) return;
        java.util.Objects.requireNonNull(context, "context");
        requireTerminationGovernance(context);
        String sessionKey = sessionKey(context.session().tenantId(), context.session().sessionId());
        Object lock = sessionLocks.computeIfAbsent(sessionKey, ignored -> new Object());
        Instant closeExpiresAt = Instant.now().plus(MAX_STREAM_LEASE).plus(client.timeout());
        synchronized (lock) {
            closingSessions.put(sessionKey, closeExpiresAt);
            Set<CompletableFuture<HttpResponse<byte[]>>> active = activeFrames.remove(sessionKey);
            if (active != null) active.forEach(future -> future.cancel(true));
            scheduleCloseCleanup(sessionKey, lock, closeExpiresAt);
            try {
                HttpRequest request = client.request(client.resolve(
                                "v1/streams/" + url(context.session().sessionId()) + "/close"))
                        .header("Content-Type", "application/json")
                        .header("X-Tenant-Id", context.session().tenantId())
                        .header("X-Consent-Id", context.consentDecision().consentId())
                        .header("X-Processing-Region", processingRegion())
                        .timeout(client.timeout())
                        .POST(HttpRequest.BodyPublishers.ofString("{}"))
                        .build();
                client.send(request).thenAccept(response ->
                        client.requireSuccess(response, "Media stream close")).join();
            } catch (java.util.concurrent.CompletionException failure) {
                throw new IllegalStateException(
                        "Unable to close Media stream provider session", failure.getCause());
            }
        }
    }

    private void scheduleCloseCleanup(String sessionKey, Object lock, Instant closeExpiresAt) {
        long delayMillis = Math.max(1L, Duration.between(Instant.now(), closeExpiresAt).toMillis());
        CompletableFuture.delayedExecutor(delayMillis, TimeUnit.MILLISECONDS).execute(() -> {
            closingSessions.remove(sessionKey, closeExpiresAt);
            if (!activeFrames.containsKey(sessionKey)) sessionLocks.remove(sessionKey, lock);
        });
    }

    private void clearExpiredClose(String sessionKey, Instant now) {
        Instant expiresAt = closingSessions.get(sessionKey);
        if (expiresAt != null && !expiresAt.isAfter(now)) closingSessions.remove(sessionKey, expiresAt);
    }

    private void requireActiveExternalGovernance(StreamContext context) {
        requireTerminationGovernance(context);
        if (!context.consentDecision().activeAt(Instant.now())) {
            throw new SecurityException("Verified active media consent is required before external streaming");
        }
    }

    /** Termination may use previously verified consent but never authorizes sending another frame. */
    private void requireTerminationGovernance(StreamContext context) {
        MediaGovernanceContext governance = context.governanceContext();
        var consent = context.consentDecision();
        if (!governance.externalProcessingAllowed()) {
            throw new SecurityException("Media stream does not permit external processing");
        }
        if (!consent.externalProcessingAllowed()) {
            throw new SecurityException("Verified media consent does not permit external streaming");
        }
        if (!governance.permitsRegion(processingRegion())) {
            throw new SecurityException("Media streaming provider region is not permitted by request governance");
        }
        if (!consent.permitsRegion(processingRegion())) {
            throw new SecurityException("Media streaming provider region is not permitted by verified consent");
        }
        if (!consent.permitsPurpose(governance.purpose())) {
            throw new SecurityException("Media streaming purpose is not permitted by verified consent");
        }
        if (!governance.providerRetentionAllowed()
                && providerDataRetention() != ProviderDataRetention.NONE) {
            throw new SecurityException(
                    "Media streaming provider retention posture is not permitted by request governance");
        }
        if (!consent.verified()) {
            throw new SecurityException("Previously verified media consent is required to terminate external streaming");
        }
        if (governance.consentId().isBlank()
                || !governance.consentId().equals(consent.consentId())) {
            throw new SecurityException("Verified media consent does not match the stream consent identity");
        }
    }

    private static Throwable unwrap(Throwable failure) {
        Throwable current = failure;
        while ((current instanceof java.util.concurrent.CompletionException
                || current instanceof java.util.concurrent.ExecutionException)
                && current.getCause() != null) {
            current = current.getCause();
        }
        return current;
    }

    private static Set<StreamKind> streamKinds(String value) {
        Set<StreamKind> result = new LinkedHashSet<>();
        for (String item : value.split(",")) if (!item.isBlank()) {
            result.add(StreamKind.valueOf(item.trim().toUpperCase(java.util.Locale.ROOT)));
        }
        return Set.copyOf(result);
    }

    private static String sessionKey(String tenantId, String sessionId) {
        if (tenantId == null || tenantId.isBlank() || sessionId == null || sessionId.isBlank()) {
            throw new IllegalArgumentException("tenantId and sessionId are required");
        }
        return tenantId.trim() + '\u0000' + sessionId.trim();
    }

    private static String url(String value) {
        return URLEncoder.encode(value, StandardCharsets.UTF_8);
    }
}
