package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.AutomationRisk;
import com.ghatana.media.runtime.MediaRuntimeContracts.BiometricSensitivity;
import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
import com.ghatana.media.runtime.MediaRuntimeContracts.ConsentDecision;
import com.ghatana.media.runtime.MediaRuntimeContracts.DataClassification;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.sun.net.httpserver.HttpExchange;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.net.InetSocketAddress;
import java.time.Instant;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CancellationException;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Proves request-scoped cancellation linearization for the production Media HTTP adapter. */
class HttpMediaProcessingCancellationFenceTest {
    private HttpServer server;
    private ExecutorService executor;

    @AfterEach
    void stopServer() {
        if (server != null) server.stop(0);
        if (executor != null) executor.shutdownNow();
    }

    @Test
    void cancellationThatWinsPreventsLaterProcessingDispatch() throws Exception {
        AtomicInteger processCalls = new AtomicInteger();
        AtomicInteger cancelCalls = new AtomicInteger();
        startServer(processCalls, cancelCalls, null, null);
        HttpMediaProcessingProvider provider = provider();

        assertThat(provider.cancel("tenant-a", "principal-a", "request-a", "job-a"))
                .isEqualTo(CancellationOutcome.CONFIRMED);

        assertThatThrownBy(() -> provider.process(context("request-a")).join())
                .satisfies(failure -> assertThat(root(failure))
                        .isInstanceOf(CancellationException.class));
        assertThat(processCalls).hasValue(0);
        assertThat(cancelCalls).hasValue(1);
    }

    @Test
    void activeProcessingIsCancelledWhenCancellationArrivesAfterDispatch() throws Exception {
        AtomicInteger processCalls = new AtomicInteger();
        AtomicInteger cancelCalls = new AtomicInteger();
        CountDownLatch processStarted = new CountDownLatch(1);
        CountDownLatch releaseProcess = new CountDownLatch(1);
        startServer(processCalls, cancelCalls, processStarted, releaseProcess);
        HttpMediaProcessingProvider provider = provider();

        CompletableFuture<Map<String, Object>> future = provider.process(context("request-b"));
        assertThat(processStarted.await(2, TimeUnit.SECONDS)).isTrue();

        assertThat(provider.cancel("tenant-a", "principal-a", "request-b", "job-b"))
                .isEqualTo(CancellationOutcome.CONFIRMED);
        releaseProcess.countDown();

        assertThatThrownBy(future::join)
                .satisfies(failure -> assertThat(root(failure))
                        .isInstanceOf(CancellationException.class));
        assertThat(processCalls).hasValue(1);
        assertThat(cancelCalls).hasValue(1);
    }

    @Test
    void ambiguousRemoteFailuresAreNotAutomaticallyEligibleForFallback() {
        HttpMediaProcessingProvider provider = new HttpMediaProcessingProvider(Map.of());

        assertThat(provider.fallbackEligible(new TimeoutException("timed out"))).isFalse();
        assertThat(provider.fallbackEligible(new IOException("connection reset"))).isFalse();
    }

    private HttpMediaProcessingProvider provider() {
        return new HttpMediaProcessingProvider(Map.of(
                "MEDIA_HTTP_PROVIDER_ENDPOINT", endpoint(),
                "MEDIA_HTTP_PROVIDER_REGION", "us-west-2",
                "MEDIA_HTTP_PROVIDER_DATA_RETENTION", "NONE",
                "MEDIA_HTTP_PROVIDER_TIMEOUT_MS", "2000",
                "MEDIA_HTTP_PROVIDER_MAX_RESPONSE_BYTES", "4096"));
    }

    private ProcessingContext context(String requestId) {
        Instant now = Instant.now();
        MediaGovernanceContext governance = new MediaGovernanceContext(
                "consent-a",
                "analysis",
                DataClassification.CONFIDENTIAL,
                "us",
                Set.of("us-west-2"),
                true,
                "delete-after-processing",
                false,
                false,
                "",
                BiometricSensitivity.NONE,
                AutomationRisk.ASSISTIVE);
        ProcessingJobRequest request = new ProcessingJobRequest(
                requestId,
                "tenant-a",
                "principal-a",
                "correlation-a",
                "artifact-a",
                JobType.VISION,
                "",
                Map.of(),
                governance);
        MediaArtifact artifact = new MediaArtifact(
                "tenant-a",
                "principal-a",
                "artifact-a",
                "image.png",
                "image/png",
                128,
                "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
                "s3://media-test/artifact-a",
                "CONFIDENTIAL",
                now,
                now.plusSeconds(3600),
                Map.of());
        ConsentDecision consent = new ConsentDecision(
                true,
                "consent-authority",
                "consent-a",
                now,
                now.plusSeconds(3600),
                Set.of("analysis"),
                Set.of("us-west-2"),
                true,
                false);
        return new ProcessingContext(request, artifact, new Cancellation(), consent);
    }

    private void startServer(
            AtomicInteger processCalls,
            AtomicInteger cancelCalls,
            CountDownLatch processStarted,
            CountDownLatch releaseProcess) throws IOException {
        server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
        executor = Executors.newCachedThreadPool();
        server.setExecutor(executor);
        server.createContext("/v1/process", exchange -> {
            processCalls.incrementAndGet();
            if (processStarted != null) processStarted.countDown();
            if (releaseProcess != null) {
                try {
                    releaseProcess.await(2, TimeUnit.SECONDS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                }
            }
            respond(exchange, 200, "{}");
        });
        server.createContext("/v1/jobs/job-a/cancel", exchange -> {
            cancelCalls.incrementAndGet();
            respond(exchange, 204, "");
        });
        server.createContext("/v1/jobs/job-b/cancel", exchange -> {
            cancelCalls.incrementAndGet();
            respond(exchange, 204, "");
        });
        server.start();
    }

    private String endpoint() {
        return "http://127.0.0.1:" + server.getAddress().getPort() + "/";
    }

    private static void respond(HttpExchange exchange, int status, String body) throws IOException {
        byte[] bytes = body.getBytes(java.nio.charset.StandardCharsets.UTF_8);
        long responseLength = status == 204 ? -1L : bytes.length;
        exchange.sendResponseHeaders(status, responseLength);
        if (responseLength < 0) {
            exchange.close();
            return;
        }
        try (var output = exchange.getResponseBody()) {
            if (bytes.length > 0) output.write(bytes);
        } catch (IOException ignored) {
            // The processing request may be cancelled while the test server is writing its response.
        }
    }

    private static Throwable root(Throwable failure) {
        Throwable current = failure;
        while (current.getCause() != null) {
            Throwable cause = current.getCause();
            if (cause.equals(current)) {
                break;
            }
            current = cause;
        }
        return current;
    }
}
