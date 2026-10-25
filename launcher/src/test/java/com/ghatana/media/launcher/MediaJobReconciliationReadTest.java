package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.sun.net.httpserver.Headers;
import com.sun.net.httpserver.HttpExchange;
import org.junit.jupiter.api.Test;
import org.mockito.Mockito;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.net.URI;
import java.nio.file.Files;
import java.time.Duration;
import java.time.Instant;
import java.util.Map;
import java.util.List;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyInt;
import static org.mockito.ArgumentMatchers.anyLong;
import static org.mockito.Mockito.doAnswer;
import static org.mockito.Mockito.when;

/** Verifies exact request identity matching on the tenant/principal-scoped job read path. */
class MediaJobReconciliationReadTest {

    @Test
    void exactRequestIdMatchesAndDifferentRequestIdFailsClosed() {
        ProcessingJob unknown = new ProcessingJob(
                "job-1", "request-1", "tenant-a", "principal-a", "artifact-1", JobType.VISION,
                "provider-1", JobStatus.OUTCOME_UNKNOWN, Instant.EPOCH, Instant.EPOCH, Instant.EPOCH,
                Map.of("providerOutcome", "UNKNOWN"), "PROCESSING_OUTCOME_UNKNOWN", 3);

        assertThat(MediaHttpHandler.matchesRequestIdentity(unknown, "request-1")).isTrue();
        assertThat(MediaHttpHandler.matchesRequestIdentity(unknown, "request-2")).isFalse();
        assertThat(MediaHttpHandler.matchesRequestIdentity(unknown, null)).isTrue();
    }

    @Test
    void jobReadReturnsUnknownOnlyForExactRequestIdAndNeverDispatchesWork() throws Exception {
        var root = Files.createTempDirectory("media-reconciliation-read-");
        var jobs = new LocalMediaRuntimeSupport.JobStore();
        var providerCalls = new AtomicInteger();
        jobs.create(new ProcessingJob(
                "job-1", "request-1", "tenant-a", "principal-a", "artifact-1", JobType.VISION,
                "provider-1", JobStatus.OUTCOME_UNKNOWN, Instant.EPOCH, Instant.EPOCH, Instant.EPOCH,
                Map.of("providerOutcome", "UNKNOWN"), "PROCESSING_OUTCOME_UNKNOWN", 3));
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                jobs,
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(processingProvider(providerCalls)),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            MediaHttpHandler handler = new MediaHttpHandler(runtime);

            ExchangeResult matching = request(handler, "/api/v1/jobs/job-1?requestId=request-1");
            assertThat(matching.status()).isEqualTo(200);
            assertThat(matching.body()).contains("OUTCOME_UNKNOWN", "PROCESSING_OUTCOME_UNKNOWN");

            ExchangeResult mismatching = request(handler, "/api/v1/jobs/job-1?requestId=request-2");
            assertThat(mismatching.status()).isEqualTo(404);
            assertThat(mismatching.body()).contains("JOB_NOT_FOUND");

            ExchangeResult duplicate = request(
                    handler, "/api/v1/jobs/job-1?requestId=request-1&requestId=request-1");
            assertThat(duplicate.status()).isEqualTo(400);
            assertThat(providerCalls).hasValue(0);

            ExchangeResult scrape = request(handler, "/metrics", "text/plain; version=0.0.4");
            assertThat(scrape.status()).isEqualTo(200);
            assertThat(scrape.contentType()).startsWith("text/plain; version=0.0.4");
            assertThat(scrape.body()).contains(
                    "media_workflow_events_total",
                    "event=\"unknown\"",
                    "media_workflow_unknown_backlog",
                    "service=\"launcher\"");
            assertThat(scrape.body()).doesNotContain("tenant-a", "job-1", "request-1", "provider-1");
            ExchangeResult legacyMetrics = request(handler, "/metrics");
            assertThat(legacyMetrics.contentType()).isEqualTo("application/json");
            assertThat(legacyMetrics.body()).contains("\"service\":\"media\"");
        } finally {
            runtime.close();
        }
    }

    @Test
    void restartPreservesUnknownProviderFinalityAndDoesNotDispatchAgain() throws Exception {
        var root = Files.createTempDirectory("media-restart-reconciliation-");
        var jobs = new LocalMediaRuntimeSupport.JobStore();
        var providerCalls = new AtomicInteger();
        jobs.create(new ProcessingJob(
                "job-restart", "request-restart", "tenant-a", "principal-a", "artifact-1", JobType.VISION,
                "provider-1", JobStatus.RUNNING, Instant.EPOCH, Instant.EPOCH, null,
                Map.of(), "", 2));
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                jobs,
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(processingProvider(providerCalls)),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            ProcessingJob reconciled = runtime.job("tenant-a", "principal-a", "job-restart").orElseThrow();
            assertThat(reconciled.status()).isEqualTo(JobStatus.OUTCOME_UNKNOWN);
            assertThat(reconciled.failureCode()).isEqualTo("PROCESSING_OUTCOME_UNKNOWN");
            assertThat(reconciled.result()).containsEntry("providerOutcome", "UNKNOWN");
            assertThat(providerCalls).hasValue(0);
        } finally {
            runtime.close();
        }
    }

    @Test
    void jobReadsExposeLogicalStatusWithoutConflatingDurableStates() throws Exception {
        var root = Files.createTempDirectory("media-logical-status-read-");
        var jobs = new LocalMediaRuntimeSupport.JobStore();
        jobs.create(new ProcessingJob(
                "job-unknown", "request-u", "tenant-a", "principal-a", "artifact-1", JobType.VISION,
                "provider-1", JobStatus.OUTCOME_UNKNOWN, Instant.EPOCH, Instant.EPOCH, Instant.EPOCH,
                Map.of("providerOutcome", "UNKNOWN"), "PROCESSING_OUTCOME_UNKNOWN", 3));
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                jobs,
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(processingProvider(new AtomicInteger())),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            MediaHttpHandler handler = new MediaHttpHandler(runtime);
            // Created after the startup reconciliation pass so the durable ACCEPTED state is
            // observed live rather than reconciled to FAILED as a restart orphan.
            jobs.create(new ProcessingJob(
                    "job-queued", "request-q", "tenant-a", "principal-a", "artifact-1", JobType.VISION,
                    "provider-1", JobStatus.ACCEPTED, Instant.EPOCH, null, null, Map.of(), "", 1));

            ExchangeResult queued = request(handler, "/api/v1/jobs/job-queued");
            assertThat(queued.status()).isEqualTo(200);
            assertThat(queued.body()).contains("\"status\":\"ACCEPTED\"");
            assertThat(queued.body()).contains("\"logicalStatus\":\"QUEUED\"");

            ExchangeResult unknown = request(handler, "/api/v1/jobs/job-unknown");
            assertThat(unknown.status()).isEqualTo(200);
            assertThat(unknown.body()).contains("\"status\":\"OUTCOME_UNKNOWN\"");
            assertThat(unknown.body()).contains("\"logicalStatus\":\"OUTCOME_UNKNOWN\"");
            // No reconciliation evidence was durably recorded, so the read must not claim
            // RECONCILING, and no retry authority exists to claim RETRY_PENDING.
            assertThat(unknown.body()).doesNotContain("RECONCILING", "RETRY_PENDING");

            ExchangeResult list = request(handler, "/api/v1/jobs");
            assertThat(list.status()).isEqualTo(200);
            assertThat(list.body()).contains("\"logicalStatus\":\"QUEUED\"");
        } finally {
            runtime.close();
        }
    }

    @Test
    void priorWireReaderToleratesAdditiveLogicalStatusField() throws Exception {
        var root = Files.createTempDirectory("media-prior-wire-");
        var jobs = new LocalMediaRuntimeSupport.JobStore();
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                jobs,
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(processingProvider(new AtomicInteger())),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            jobs.create(new ProcessingJob(
                    "job-wire", "request-wire", "tenant-a", "principal-a", "artifact-1", JobType.VISION,
                    "provider-1", JobStatus.COMPLETED, Instant.EPOCH, Instant.EPOCH, Instant.EPOCH,
                    Map.of("providerOutcome", "SUCCEEDED"), "", 4));
            MediaHttpHandler handler = new MediaHttpHandler(runtime);
            ExchangeResult read = request(handler, "/api/v1/jobs/job-wire");
            assertThat(read.status()).isEqualTo(200);
            assertThat(read.body()).contains("\"logicalStatus\":\"COMPLETED\"");

            // A prior-version reader tolerant of unknown fields still parses the view as the
            // pre-projection ProcessingJob payload: every former field name and value survives.
            tools.jackson.databind.ObjectMapper tolerant = tools.jackson.databind.json.JsonMapper
                    .builder()
                    .addModules(tools.jackson.databind.cfg.MapperBuilder.findModules())
                    .configure(tools.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false)
                    .build();
            ProcessingJob prior = tolerant.readValue(read.body(), ProcessingJob.class);
            assertThat(prior.jobId()).isEqualTo("job-wire");
            assertThat(prior.requestId()).isEqualTo("request-wire");
            assertThat(prior.tenantId()).isEqualTo("tenant-a");
            assertThat(prior.principalId()).isEqualTo("principal-a");
            assertThat(prior.artifactId()).isEqualTo("artifact-1");
            assertThat(prior.jobType()).isEqualTo(JobType.VISION);
            assertThat(prior.providerId()).isEqualTo("provider-1");
            assertThat(prior.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(prior.result()).containsEntry("providerOutcome", "SUCCEEDED");
            assertThat(prior.version()).isEqualTo(4);
        } finally {
            runtime.close();
        }
    }

    @Test
    void unknownEnumAndMalformedJobSubmitAreRejectedWithoutEffect() throws Exception {
        var root = Files.createTempDirectory("media-unknown-enum-");
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(processingProvider(new AtomicInteger())),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            String unknownEnum = "{\"requestId\":\"r1\",\"tenantId\":\"tenant-a\","
                    + "\"principalId\":\"principal-a\",\"correlationId\":\"c1\","
                    + "\"artifactId\":\"a1\",\"jobType\":\"NONSENSE\",\"parameters\":{}}";
            ExchangeResult rejected = post(runtime, "/api/v1/jobs", unknownEnum);
            assertThat(rejected.status()).isEqualTo(400);
            assertThat(rejected.body()).contains("INVALID_REQUEST");

            ExchangeResult malformed = post(runtime, "/api/v1/jobs", "{\"requestId\":");
            assertThat(malformed.status()).isEqualTo(400);
            assertThat(runtime.jobs("tenant-a", "principal-a", 10)).isEmpty();
        } finally {
            runtime.close();
        }
    }

    @Test
    void unadmittedSpeechToTextReturnsTypedZeroEffectApiError() throws Exception {
        var root = Files.createTempDirectory("media-stt-not-admitted-");
        MediaProcessingProvider visionOnly = new MediaProcessingProvider() {
            @Override public String providerId() { return "vision-only"; }
            @Override public String providerVersion() { return "test-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                throw new AssertionError("an unadmitted STT request must not call a provider");
            }
            @Override public CancellationOutcome cancel(
                    String tenantId, String principalId, String correlationId, String jobId) {
                return CancellationOutcome.UNSUPPORTED;
            }
        };
        var runtime = new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_024, 64, 1_024,
                        Duration.ofSeconds(2), 2, "", "", true, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root),
                new LocalMediaRuntimeSupport.JobStore(),
                new LocalMediaRuntimeSupport.StreamStore(),
                null,
                List.of(visionOnly),
                List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        try {
            byte[] bytes = "speech-source".getBytes(java.nio.charset.StandardCharsets.UTF_8);
            var upload = runtime.beginUpload(new com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest(
                    "tenant-a", "principal-a", "speech.wav", "audio/wav", bytes.length,
                    sha256(bytes), "RESTRICTED", Duration.ofMinutes(30), Map.of()), "stt-upload");
            runtime.appendChunk("tenant-a", "principal-a", upload.uploadId(), 0, bytes);
            var artifact = runtime.completeUpload("tenant-a", "principal-a", upload.uploadId());
            String json = "{\"requestId\":\"stt-request\",\"tenantId\":\"tenant-a\","
                    + "\"principalId\":\"principal-a\",\"correlationId\":\"stt-correlation\","
                    + "\"artifactId\":\"" + artifact.artifactId() + "\","
                    + "\"expectedArtifactVersion\":\"" + artifact.version().value() + "\","
                    + "\"jobType\":\"SPEECH_TO_TEXT\",\"parameters\":{}}";
            ExchangeResult response = post(runtime, "/api/v1/jobs", json);

            assertThat(response.status()).isEqualTo(422);
            assertThat(response.body()).contains("MEDIA_CAPABILITY_NOT_ADMITTED", "NOT_ADMITTED", "SPEECH_TO_TEXT");
            assertThat(runtime.jobs("tenant-a", "principal-a", 10)).isEmpty();
        } finally {
            runtime.close();
        }
    }

    private static MediaProcessingProvider processingProvider(AtomicInteger providerCalls) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "provider-1"; }
            @Override public String providerVersion() { return "test"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.VISION); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 0; }
            @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                providerCalls.incrementAndGet();
                return CompletableFuture.completedFuture(Map.of());
            }
            @Override public CancellationOutcome cancel(
                    String tenantId, String principalId, String correlationId, String jobId) {
                return CancellationOutcome.UNSUPPORTED;
            }
        };
    }

    private static ExchangeResult request(MediaHttpHandler handler, String pathAndQuery) throws IOException {
        return request(handler, pathAndQuery, null);
    }

    private static ExchangeResult request(MediaHttpHandler handler, String pathAndQuery, String accept)
            throws IOException {
        HttpExchange exchange = Mockito.mock(HttpExchange.class);
        Headers requestHeaders = new Headers();
        requestHeaders.set("X-Tenant-Id", "tenant-a");
        requestHeaders.set("X-Principal-Id", "principal-a");
        if (accept != null) requestHeaders.set("Accept", accept);
        Headers responseHeaders = new Headers();
        ByteArrayOutputStream responseBody = new ByteArrayOutputStream();
        AtomicInteger status = new AtomicInteger();
        when(exchange.getRequestURI()).thenReturn(URI.create("http://localhost" + pathAndQuery));
        when(exchange.getRequestMethod()).thenReturn("GET");
        when(exchange.getRequestHeaders()).thenReturn(requestHeaders);
        when(exchange.getResponseHeaders()).thenReturn(responseHeaders);
        when(exchange.getResponseBody()).thenReturn(responseBody);
        doAnswer(invocation -> {
            status.set((Integer) invocation.getArgument(0));
            return null;
        }).when(exchange).sendResponseHeaders(anyInt(), anyLong());

        handler.handle(exchange);
        return new ExchangeResult(status.get(), responseBody.toString(java.nio.charset.StandardCharsets.UTF_8),
                responseHeaders.getFirst("Content-Type"));
    }

    private static ExchangeResult post(MediaRuntime runtime, String path, String body) throws IOException {
        MediaHttpHandler handler = new MediaHttpHandler(runtime);
        HttpExchange exchange = Mockito.mock(HttpExchange.class);
        Headers requestHeaders = new Headers();
        requestHeaders.set("X-Tenant-Id", "tenant-a");
        requestHeaders.set("X-Principal-Id", "principal-a");
        Headers responseHeaders = new Headers();
        ByteArrayOutputStream responseBody = new ByteArrayOutputStream();
        AtomicInteger status = new AtomicInteger();
        when(exchange.getRequestURI()).thenReturn(URI.create("http://localhost" + path));
        when(exchange.getRequestMethod()).thenReturn("POST");
        when(exchange.getRequestHeaders()).thenReturn(requestHeaders);
        when(exchange.getRequestBody()).thenReturn(new java.io.ByteArrayInputStream(
                body.getBytes(java.nio.charset.StandardCharsets.UTF_8)));
        when(exchange.getResponseHeaders()).thenReturn(responseHeaders);
        when(exchange.getResponseBody()).thenReturn(responseBody);
        doAnswer(invocation -> {
            status.set((Integer) invocation.getArgument(0));
            return null;
        }).when(exchange).sendResponseHeaders(anyInt(), anyLong());
        handler.handle(exchange);
        return new ExchangeResult(status.get(), responseBody.toString(java.nio.charset.StandardCharsets.UTF_8),
                responseHeaders.getFirst("Content-Type"));
    }

    private static String sha256(byte[] bytes) throws Exception {
        return java.util.HexFormat.of().formatHex(
                java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
    }


    private record ExchangeResult(int status, String body, String contentType) {}

}
