package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.infrastructure.persistence.service.TranscriptionService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.stt.core.grpc.proto.*;
import com.ghatana.stt.service.PersistentSttService;
import io.grpc.Context;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.util.Objects;
import java.util.UUID;

/**
 * @doc.type class
 * @doc.purpose gRPC service for STT with persistence integration.
 *              Extends base STT functionality with database persistence.
 * @doc.layer product
 * @doc.pattern Service
 */
public class PersistentSttGrpcService extends STTServiceGrpc.STTServiceImplBase {

    private static final Logger LOG = LoggerFactory.getLogger(PersistentSttGrpcService.class);

    private final PersistentSttService persistentSttService;

    public PersistentSttGrpcService(
            AudioVideoLibrary library,
            AudioFileService audioFileService,
            TranscriptionService transcriptionService,
            MeterRegistry metrics) {
        this.persistentSttService = new PersistentSttService(
            library, audioFileService, transcriptionService, metrics);
    }

    /**
     * Package-private constructor for unit testing — supply a pre-built service.
     */
    PersistentSttGrpcService(PersistentSttService persistentSttService) {
        this.persistentSttService = Objects.requireNonNull(persistentSttService);
    }

    @Override
    public void transcribe(TranscribeRequest request, StreamObserver<TranscribeResponse> responseObserver) {
        String cid = cid();
        String tenantId = getTenantId();
        String userIdStr = getUserId();

        if (tenantId == null || tenantId.isEmpty()) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant ID")
                .asRuntimeException());
            return;
        }

        UUID userId = userIdStr != null ? UUID.fromString(userIdStr) : UUID.randomUUID();

        try {
            MDC.put("tenantId", tenantId);
            MDC.put("userId", userIdStr);
            MDC.put("cid", cid);

            byte[] audioBytes = request.getAudioData().toByteArray();
            if (audioBytes.length == 0) {
                responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Audio data cannot be empty")
                    .asRuntimeException());
                return;
            }

            int sampleRate = request.getSampleRate() > 0 ? request.getSampleRate() : 16000;
            String fileName = "audio.wav";
            String language = request.getLanguage();

            // Perform transcription with persistence
            persistentSttService.transcribeAndPersist(
                tenantId, userId, audioBytes, fileName,
                AudioFormat.WAV, language, sampleRate
            ).whenResult(result -> {
                responseObserver.onNext(TranscribeResponse.newBuilder()
                    .setText(result.text())
                    .setConfidence((float) result.confidence())
                    .setProcessingTimeMs(result.processingTime().toMillis())
                    .setModelUsed(result.modelId() != null ? result.modelId() : "")
                    .build());
                responseObserver.onCompleted();
            }).whenException(e -> {
                // AV-P1-004: Map exception types to appropriate gRPC status codes
                io.grpc.Status grpcStatus = toGrpcStatus(cid, e);
                responseObserver.onError(grpcStatus.asRuntimeException());
            });

        } catch (IllegalArgumentException e) {
            // AV-P1-004: Validation threw synchronously (before Promise was returned)
            LOG.warn("[{}] Validation error: {}", cid, e.getMessage());
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription(e.getMessage()).asRuntimeException());
        } catch (Exception e) {
            LOG.error("[{}] Unexpected error: {}", cid, e.getMessage(), e);
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Internal error").asRuntimeException());
        } finally {
            MDC.clear();
        }
    }

    private String getTenantId() {
        String tenantId = JwtServerInterceptor.CTX_TENANT.get();
        return tenantId != null && !tenantId.isBlank() ? tenantId : null;
    }

    private String getUserId() {
        return JwtServerInterceptor.CTX_SUBJECT.get();
    }

    private String cid() {
        return java.util.UUID.randomUUID().toString().substring(0, 8);
    }

    /**
     * AV-P1-004: Map exception types to canonical gRPC status codes.
     */
    private io.grpc.Status toGrpcStatus(String cid, Throwable e) {
        if (e instanceof IllegalArgumentException) {
            LOG.warn("[{}] Validation error: {}", cid, e.getMessage());
            return io.grpc.Status.INVALID_ARGUMENT.withDescription(e.getMessage());
        }
        if (e instanceof java.util.concurrent.TimeoutException) {
            LOG.warn("[{}] Transcription timed out: {}", cid, e.getMessage());
            return io.grpc.Status.DEADLINE_EXCEEDED.withDescription(e.getMessage());
        }
        if (e instanceof com.ghatana.media.common.InferenceError ie && !ie.isRetryable()) {
            LOG.error("[{}] Non-retryable inference error: {}", cid, e.getMessage());
            return io.grpc.Status.INTERNAL.withDescription("Inference failed: " + e.getMessage());
        }
        if (e instanceof com.ghatana.media.common.InferenceError) {
            LOG.warn("[{}] Retryable inference error: {}", cid, e.getMessage());
            return io.grpc.Status.UNAVAILABLE.withDescription("Transcription temporarily unavailable");
        }
        LOG.error("[{}] Unexpected async error: {}", cid, e.getMessage(), e);
        return io.grpc.Status.INTERNAL.withDescription("Transcription failed");
    }

}
