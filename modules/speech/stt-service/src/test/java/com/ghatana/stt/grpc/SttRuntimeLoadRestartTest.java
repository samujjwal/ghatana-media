package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioData;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.stt.api.TranscriptionOptions;
import com.ghatana.media.stt.api.TranscriptionResult;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.google.protobuf.ByteString;
import io.grpc.ClientInterceptor;
import io.grpc.ManagedChannel;
import io.grpc.Metadata;
import io.grpc.Server;
import io.grpc.inprocess.InProcessChannelBuilder;
import io.grpc.inprocess.InProcessServerBuilder;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.times;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/**
 * Fixture-only transport load exercise. The injected engine is a deterministic Mockito fixture,
 * not an ASR implementation; its text and timings must never be treated as model evidence.
 * Provider RTF, model memory/quality, production restart, persisted tenant isolation, and real SLO
 * measurements are deliberately unavailable in this test.
 */
@DisplayName("STT fixture-only gRPC load and ephemeral restart")
class SttRuntimeLoadRestartTest {
    private static final String TEST_SECRET = "stt-fixture-test-secret-do-not-use-outside-tests";
    private static final String FIXTURE_TEXT = "FIXTURE_ONLY_NOT_ASR_OUTPUT";
    private static final String FIXTURE_MODEL = "FIXTURE_ONLY_NOT_A_MODEL";
    private static final String FIXTURE_UNAVAILABLE = "NOT_AVAILABLE";
    private String previousSecret;
    private String previousGatewayUrl;

    @AfterEach
    void restoreAuthenticationProperties() {
        restoreProperty("AV_JWT_SECRET", previousSecret);
        restoreProperty("AUTH_GATEWAY_URL", previousGatewayUrl);
    }

    @Test
    @DisplayName("authenticated fixture batches of 16 and 64 survive ephemeral service restart")
    void fixtureLoadBatchesAndRestartAreTransportOnly() throws Exception {
        configureTestJwt();

        Measurement batch16 = runBatchAfterFreshStart(16);
        Measurement batch64 = runBatchAfterFreshStart(64);

        assertThat(batch16.requestCount()).isEqualTo(16);
        assertThat(batch64.requestCount()).isEqualTo(64);
        assertThat(batch16.serverName()).isNotEqualTo(batch64.serverName());
        assertThat(batch16.latencyMillis()).hasSize(16).allMatch(value -> value >= 0.0);
        assertThat(batch64.latencyMillis()).hasSize(64).allMatch(value -> value >= 0.0);
        assertThat(batch16.throughputRequestsPerSecond()).isPositive();
        assertThat(batch64.throughputRequestsPerSecond()).isPositive();

        // These are explicit evidence gaps, not zero measurements inferred from a fixture engine.
        assertThat(batch16.notAvailableMeasurements()).containsExactly(
                "provider_rtf=" + FIXTURE_UNAVAILABLE,
                "model_memory=" + FIXTURE_UNAVAILABLE,
                "model_quality_wer_cer_der=" + FIXTURE_UNAVAILABLE,
                "production_restart=" + FIXTURE_UNAVAILABLE,
                "persisted_cross_tenant_isolation=" + FIXTURE_UNAVAILABLE,
                "real_slo=" + FIXTURE_UNAVAILABLE);
        assertThat(batch64.notAvailableMeasurements()).isEqualTo(batch16.notAvailableMeasurements());

        report(batch16);
        report(batch64);
    }

    private Measurement runBatchAfterFreshStart(int requestCount) throws Exception {
        String serverName = InProcessServerBuilder.generateName();
        String tenant = "fixture-tenant";
        String subject = UUID.randomUUID().toString();
        String token = signedTestJwt(tenant, subject);
        AudioVideoLibrary library = mock(AudioVideoLibrary.class);
        SttEngine fixtureEngine = mock(SttEngine.class);
        when(library.getSttEngine()).thenReturn(fixtureEngine);
        when(fixtureEngine.transcribe(any(AudioData.class), any(TranscriptionOptions.class)))
                .thenReturn(new TranscriptionResult(
                        FIXTURE_TEXT,
                        0.0,
                        Collections.emptyList(),
                        Collections.emptyList(),
                        null,
                        "fixture-only",
                        FIXTURE_MODEL));

        SttGrpcService fixtureService = SttGrpcServiceTestFixture.create(library, new SimpleMeterRegistry());
        Server server = InProcessServerBuilder.forName(serverName)
                .directExecutor()
                .addService(fixtureService)
                .intercept(new JwtServerInterceptor())
                .build()
                .start();
        ManagedChannel channel = InProcessChannelBuilder.forName(serverName)
                .directExecutor()
                .build();
        STTServiceGrpc.STTServiceBlockingStub stub = STTServiceGrpc.newBlockingStub(channel)
                .withInterceptors(authorization(token));

        try {
            Measurement measured = executeBatch(serverName, requestCount, stub);
            verify(fixtureEngine, times(requestCount)).transcribe(
                    any(AudioData.class), any(TranscriptionOptions.class));
            return measured;
        } finally {
            channel.shutdownNow();
            server.shutdownNow();
            channel.awaitTermination(5, TimeUnit.SECONDS);
            server.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    private static Measurement executeBatch(
            String serverName,
            int requestCount,
            STTServiceGrpc.STTServiceBlockingStub authenticatedStub) throws Exception {
        ExecutorService executor = Executors.newFixedThreadPool(requestCount);
        CountDownLatch ready = new CountDownLatch(requestCount);
        CountDownLatch start = new CountDownLatch(1);
        List<Callable<Double>> calls = new ArrayList<>(requestCount);
        for (int i = 0; i < requestCount; i++) {
            calls.add(() -> {
                ready.countDown();
                if (!start.await(10, TimeUnit.SECONDS)) {
                    throw new IllegalStateException("fixture batch start was not released");
                }
                long callStarted = System.nanoTime();
                TranscribeResponse response = authenticatedStub.transcribe(fixtureRequest());
                double latencyMs = (System.nanoTime() - callStarted) / 1_000_000.0;
                assertThat(response.getText()).isEqualTo(FIXTURE_TEXT);
                assertThat(response.getModelUsed()).isEqualTo(FIXTURE_MODEL);
                assertThat(response.getLanguage()).isEqualTo("fixture-only");
                return latencyMs;
            });
        }

        try {
            List<Future<Double>> futures = new ArrayList<>(requestCount);
            for (Callable<Double> call : calls) futures.add(executor.submit(call));
            assertThat(ready.await(10, TimeUnit.SECONDS)).isTrue();
            long releasedAt = System.nanoTime();
            start.countDown();
            List<Double> latency = new ArrayList<>(requestCount);
            for (Future<Double> future : futures) latency.add(future.get(30, TimeUnit.SECONDS));
            long completedAt = System.nanoTime();
            double elapsedSeconds = (completedAt - releasedAt) / 1_000_000_000.0;
            return new Measurement(
                    serverName,
                    requestCount,
                    List.copyOf(latency),
                    percentile(latency, 0.50),
                    percentile(latency, 0.95),
                    percentile(latency, 0.99),
                    requestCount / elapsedSeconds,
                    List.of(
                            "provider_rtf=" + FIXTURE_UNAVAILABLE,
                            "model_memory=" + FIXTURE_UNAVAILABLE,
                            "model_quality_wer_cer_der=" + FIXTURE_UNAVAILABLE,
                            "production_restart=" + FIXTURE_UNAVAILABLE,
                            "persisted_cross_tenant_isolation=" + FIXTURE_UNAVAILABLE,
                            "real_slo=" + FIXTURE_UNAVAILABLE));
        } finally {
            start.countDown();
            executor.shutdownNow();
            executor.awaitTermination(5, TimeUnit.SECONDS);
        }
    }

    private void configureTestJwt() {
        previousSecret = System.getProperty("AV_JWT_SECRET");
        previousGatewayUrl = System.getProperty("AUTH_GATEWAY_URL");
        String environmentSecret = System.getenv("AV_JWT_SECRET");
        // JwtServerInterceptor prefers the environment value; otherwise it accepts this test property.
        String signingSecret = environmentSecret == null || environmentSecret.isBlank()
                ? TEST_SECRET : environmentSecret;
        System.setProperty("AV_JWT_SECRET", signingSecret);
        System.setProperty("AUTH_GATEWAY_URL", "");
    }

    private static ClientInterceptor authorization(String token) {
        Metadata metadata = new Metadata();
        metadata.put(Metadata.Key.of("authorization", Metadata.ASCII_STRING_MARSHALLER), "Bearer " + token);
        return new ClientInterceptor() {
            @Override
            public <ReqT, RespT> io.grpc.ClientCall<ReqT, RespT> interceptCall(
                    io.grpc.MethodDescriptor<ReqT, RespT> method,
                    io.grpc.CallOptions callOptions,
                    io.grpc.Channel next) {
                return new io.grpc.ForwardingClientCall.SimpleForwardingClientCall<ReqT, RespT>(
                        next.newCall(method, callOptions)) {
                    @Override
                    public void start(io.grpc.ClientCall.Listener<RespT> responseListener, Metadata headers) {
                        headers.merge(metadata);
                        super.start(responseListener, headers);
                    }
                };
            }
        };
    }

    private static String signedTestJwt(String tenant, String subject) throws GeneralSecurityException {
        String environmentSecret = System.getenv("AV_JWT_SECRET");
        String signingSecret = environmentSecret == null || environmentSecret.isBlank()
                ? TEST_SECRET : environmentSecret;
        String header = base64Url("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        long expiresAt = System.currentTimeMillis() / 1_000 + 60;
        String payload = "{\"sub\":\"" + subject + "\",\"tenantId\":\"" + tenant
                + "\",\"exp\":" + expiresAt + "}";
        String encodedPayload = base64Url(payload);
        String signingInput = header + "." + encodedPayload;
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(signingSecret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        String signature = Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.UTF_8)));
        return signingInput + "." + signature;
    }

    private static String base64Url(String value) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static TranscribeRequest fixtureRequest() {
        // Bounded 100 ms mono PCM S16LE test signal; not licensed speech and not an accuracy fixture.
        return TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[3_200]))
                .setSampleRate(16_000)
                .setLanguage("en")
                .build();
    }

    private static double percentile(List<Double> values, double quantile) {
        List<Double> sorted = values.stream().sorted().toList();
        int index = (int) Math.ceil(quantile * sorted.size()) - 1;
        return sorted.get(Math.max(0, index));
    }

    private static void report(Measurement measurement) {
        System.out.printf(Locale.ROOT,
                "STT_FIXTURE_ONLY transport requests=%d p50_ms=%.3f p95_ms=%.3f p99_ms=%.3f throughput_rps=%.3f unavailable=%s%n",
                measurement.requestCount(),
                measurement.p50Millis(),
                measurement.p95Millis(),
                measurement.p99Millis(),
                measurement.throughputRequestsPerSecond(),
                String.join(",", measurement.notAvailableMeasurements()));
    }

    private static void restoreProperty(String name, String previous) {
        if (previous == null) System.clearProperty(name);
        else System.setProperty(name, previous);
    }

    private record Measurement(
            String serverName,
            int requestCount,
            List<Double> latencyMillis,
            double p50Millis,
            double p95Millis,
            double p99Millis,
            double throughputRequestsPerSecond,
            List<String> notAvailableMeasurements) {}
}
