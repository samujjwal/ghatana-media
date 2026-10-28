package com.ghatana.audio.video.multimodal.adapter;

import com.ghatana.audio.video.common.observability.TracingClientInterceptor;
import com.ghatana.audio.video.multimodal.engine.AudioResult;
import com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp;
import com.ghatana.audio.video.multimodal.engine.SttClientAdapter;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.TranscribeRequest;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import com.ghatana.stt.core.grpc.proto.ConfidenceCalibration;
import com.ghatana.stt.core.grpc.proto.TimestampTimebase;
import com.ghatana.stt.core.grpc.proto.TranscriptionOptions;
import com.google.common.util.concurrent.ListenableFuture;
import com.google.protobuf.ByteString;
import io.grpc.ManagedChannel;
import io.grpc.StatusRuntimeException;
import io.grpc.netty.shaded.io.grpc.netty.GrpcSslContexts;
import io.grpc.netty.shaded.io.grpc.netty.NettyChannelBuilder;
import io.grpc.netty.shaded.io.netty.handler.ssl.SslContextBuilder;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.io.File;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CancellationException;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;

/**
 * @doc.type class
 * @doc.purpose STT client adapter backed by the typed, securely transported STT gRPC service.
 * @doc.layer product
 * @doc.pattern Service
 *
 * <p>Only modality-grounded transcription is permitted. Raw audio is sent to the typed STT
 * service as bytes. Provider failure is represented as an explicit error result; this adapter
 * never converts binary audio into a text prompt or asks a generic text model to invent a
 * transcription.
 *
 * <p>Transport security is explicit and fail closed. TLS is the default. Production-like
 * profiles require explicit trust material; mTLS additionally requires client certificate and
 * private-key material. Plaintext is available only through explicit local/test configuration.
 */
public final class GrpcSttClientAdapter implements SttClientAdapter, AutoCloseable {

    private static final int SUBMITTED_SAMPLE_RATE_HZ = 16_000;
    private static final Logger LOG = LoggerFactory.getLogger(GrpcSttClientAdapter.class);
    private static final long CALL_DEADLINE_SECONDS = 30L;

    public enum SttMode {
        GRPC,
        NOP
    }

    private final ManagedChannel channel;
    private final SttMode configuredMode;
    private final SttGrpcTransportSecurity transportSecurity;
    private SttMode currentMode;

    /**
     * Creates a new gRPC STT client adapter using environment-derived secure transport policy.
     * TLS is the default transport; plaintext must be selected explicitly for local/test use.
     */
    public GrpcSttClientAdapter(String host, int port, SttMode sttMode) {
        this(host, port, sttMode, SttGrpcTransportSecurity.fromEnvironment(System.getenv()));
    }

    /** Creates an adapter using the typed gRPC provider path by default. */
    public GrpcSttClientAdapter(String host, int port) {
        this(host, port, SttMode.GRPC);
    }

    /**
     * Creates an adapter with explicit typed transport security.
     */
    public GrpcSttClientAdapter(
            String host,
            int port,
            SttMode sttMode,
            SttGrpcTransportSecurity transportSecurity) {
        String providerHost = requireHost(host);
        if (port < 1 || port > 65_535) {
            throw new IllegalArgumentException("STT gRPC port must be between 1 and 65535");
        }
        this.configuredMode = Objects.requireNonNull(sttMode, "sttMode");
        this.currentMode = sttMode;
        this.transportSecurity = Objects.requireNonNull(transportSecurity, "transportSecurity");
        this.channel = buildChannel(providerHost, port, this.transportSecurity);
        LOG.info(
                "STT client configured host={} port={} mode={} transport={}",
                providerHost,
                port,
                this.configuredMode,
                this.transportSecurity.mode());
    }

    /** Explicit local/test-only factory for plaintext test providers. */
    public static GrpcSttClientAdapter forLocalTesting(String host, int port, SttMode sttMode) {
        return new GrpcSttClientAdapter(
                host,
                port,
                sttMode,
                SttGrpcTransportSecurity.localPlaintext());
    }

    @Override
    public AudioResult transcribe(byte[] audioData) {
        Objects.requireNonNull(audioData, "audioData");
        switch (configuredMode) {
            case NOP:
                currentMode = SttMode.NOP;
                LOG.debug("STT explicitly disabled (NOP mode)");
                return AudioResult.error("STT transcription unavailable: adapter is configured in NOP mode");
            case GRPC:
                currentMode = SttMode.GRPC;
                if (audioData.length == 0) {
                    return AudioResult.error("STT audio payload must not be empty");
                }
                try {
                    return transcribeViaGrpc(audioData);
                } catch (StatusRuntimeException failure) {
                    if (failure.getStatus().getCode() == io.grpc.Status.Code.DEADLINE_EXCEEDED
                            || failure.getStatus().getCode() == io.grpc.Status.Code.CANCELLED) {
                        throw failure;
                    }
                    LOG.warn("STT provider unavailable: status={}", failure.getStatus().getCode());
                    return AudioResult.error(
                            "STT provider unavailable: " + failure.getStatus().getCode());
                } catch (CancellationException cancelled) {
                    throw cancelled;
                } catch (RuntimeException failure) {
                    LOG.error("STT transcription failed", failure);
                    return AudioResult.error("STT transcription failed");
                }
            default:
                throw new IllegalStateException("Unsupported STT mode: " + configuredMode);
        }
    }

    public SttMode getCurrentMode() {
        return currentMode;
    }

    public SttGrpcTransportSecurity.Mode getTransportMode() {
        return transportSecurity.mode();
    }

    private AudioResult transcribeViaGrpc(byte[] audioData) {
        STTServiceGrpc.STTServiceFutureStub client =
                STTServiceGrpc.newFutureStub(channel)
                        .withDeadlineAfter(CALL_DEADLINE_SECONDS, TimeUnit.SECONDS);

        TranscribeRequest request = TranscribeRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(audioData))
                .setSampleRate(SUBMITTED_SAMPLE_RATE_HZ)
                .setLanguage("")
                .setOptions(TranscriptionOptions.newBuilder().setEnableWordTimings(true).build())
                .build();

        ListenableFuture<TranscribeResponse> call = client.transcribe(request);
        TranscribeResponse response;
        try {
            response = call.get();
        } catch (InterruptedException interrupted) {
            // Future.cancel propagates cancellation to the underlying gRPC ClientCall. This
            // matters when the parent multimodal deadline cancels its worker thread.
            call.cancel(true);
            Thread.currentThread().interrupt();
            CancellationException cancelled = new CancellationException("STT call cancelled");
            cancelled.initCause(interrupted);
            throw cancelled;
        } catch (ExecutionException failed) {
            Throwable cause = failed.getCause();
            if (cause instanceof StatusRuntimeException statusFailure) throw statusFailure;
            throw new IllegalStateException("STT gRPC call failed", cause);
        }
        String transcription = response.getText() == null ? "" : response.getText();
        AudioResult.ConfidenceCalibration calibration = switch (response.getConfidenceCalibration()) {
            case CONFIDENCE_CALIBRATION_UNCALIBRATED -> AudioResult.ConfidenceCalibration.UNCALIBRATED;
            case CONFIDENCE_CALIBRATION_CALIBRATED -> AudioResult.ConfidenceCalibration.CALIBRATED;
            case CONFIDENCE_CALIBRATION_UNKNOWN, UNRECOGNIZED -> AudioResult.ConfidenceCalibration.UNKNOWN;
        };
        Double confidence = null;
        if (calibration != AudioResult.ConfidenceCalibration.UNKNOWN) {
            float supplied = response.getConfidence();
            if (!Float.isFinite(supplied) || supplied < 0.0f || supplied > 1.0f) {
                throw new IllegalArgumentException("STT confidence must be finite and in [0, 1]");
            }
            confidence = (double) supplied;
        }

        LOG.info(
                "STT gRPC transcription completed: textLength={}, confidence={}",
                transcription.length(),
                confidence);
        AudioResult.Builder result = AudioResult.builder()
                .transcription(transcription)
                .confidenceCalibration(calibration)
                .timedSegments(sourceWordTimings(response, audioData.length));
        if (confidence != null) result.confidence(confidence);
        return result.build();
    }

    /**
     * Preserve word timing only when the provider explicitly identifies sample-zero as its
     * clock origin. The ephemeral response-local clock identity prevents these relative
     * timestamps from being compared with video PTS or another request without an admitted
     * source mapping; it does not identify an artifact or establish provenance.
     */
    private static List<AudioResult.TimedSegment> sourceWordTimings(
            TranscribeResponse response, int pcmByteLength) {
        if (response.getWordTimingTimebase() != TimestampTimebase.TIMESTAMP_TIMEBASE_SOURCE_SAMPLE_ZERO
                || response.getWordTimingsCount() == 0) {
            return List.of();
        }
        // This adapter submits raw signed 16-bit mono PCM at 16 kHz. Compare against the exact
        // source sample duration instead of a rounded millisecond value so a provider cannot
        // attach a word to audio that was not part of this request.
        long submittedSamples = pcmByteLength / Short.BYTES;
        String clockId = "stt-response:" + UUID.randomUUID();
        List<AudioResult.TimedSegment> segments = new ArrayList<>(response.getWordTimingsCount());
        long previousStartMs = -1;
        long previousEndMs = -1;
        for (var timing : response.getWordTimingsList()) {
            long startMs = timing.getStartMs();
            long endMs = timing.getEndMs();
            if (startMs < 0 || endMs <= startMs
                    || startMs < previousStartMs || endMs < previousEndMs
                    || endMs * SUBMITTED_SAMPLE_RATE_HZ > submittedSamples * 1_000L) {
                throw new IllegalArgumentException(
                        "STT word timing is outside the submitted PCM or not ordered");
            }
            var start = new MediaClockTimestamp(
                    MediaClockTimestamp.Status.KNOWN,
                    startMs, 1L, 1_000L,
                    MediaClockTimestamp.ClockDomain.SOURCE, clockId, null);
            var end = new MediaClockTimestamp(
                    MediaClockTimestamp.Status.KNOWN,
                    endMs, 1L, 1_000L,
                    MediaClockTimestamp.ClockDomain.SOURCE, clockId, null);
            segments.add(new AudioResult.TimedSegment(start, end, timing.getWord()));
            previousStartMs = startMs;
            previousEndMs = endMs;
        }
        return List.copyOf(segments);
    }

    private static ManagedChannel buildChannel(
            String host,
            int port,
            SttGrpcTransportSecurity security) {
        NettyChannelBuilder builder = NettyChannelBuilder.forAddress(host, port);
        builder.intercept(new TracingClientInterceptor());
        try {
            return switch (security.mode()) {
                case PLAINTEXT -> builder.usePlaintext().build();
                case TLS -> builder.sslContext(tlsContext(security, false).build()).build();
                case MTLS -> builder.sslContext(tlsContext(security, true).build()).build();
            };
        } catch (Exception failure) {
            throw new IllegalArgumentException(
                    "Unable to initialize secure STT gRPC transport", failure);
        }
    }

    private static SslContextBuilder tlsContext(
            SttGrpcTransportSecurity security,
            boolean mutualTls) {
        SslContextBuilder ssl = GrpcSslContexts.forClient();
        if (security.trustCertificate() != null) {
            ssl.trustManager(security.trustCertificate().toFile());
        }
        if (mutualTls) {
            File cert = security.clientCertificate().toFile();
            File key = security.clientPrivateKey().toFile();
            ssl.keyManager(cert, key);
        }
        return ssl;
    }

    private static String requireHost(String host) {
        if (host == null || host.isBlank()) {
            throw new IllegalArgumentException("STT gRPC host must not be blank");
        }
        String value = host.trim();
        if (value.length() > 253 || value.contains("/") || value.contains("\\")) {
            throw new IllegalArgumentException("STT gRPC host is invalid");
        }
        return value;
    }

    @Override
    public void close() {
        channel.shutdown();
        try {
            if (!channel.awaitTermination(5, TimeUnit.SECONDS)) {
                channel.shutdownNow();
            }
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            channel.shutdownNow();
        }
    }
}
