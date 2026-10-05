package com.ghatana.tts.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.tts.core.grpc.proto.*;
import com.ghatana.tts.service.PersistentTtsService;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;

import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.TimeoutException;

/**
 * @doc.type class
 * @doc.purpose gRPC service for TTS with persistence integration.
 *              Extends base TTS functionality with database persistence.
 * @doc.layer product
 * @doc.pattern Service
 */
public class PersistentTtsGrpcService extends TTSServiceGrpc.TTSServiceImplBase {

    private static final Logger LOG = LoggerFactory.getLogger(PersistentTtsGrpcService.class);

    private final PersistentTtsService persistentTtsService;
    private final TtsGrpcService streamingDelegate;

    public PersistentTtsGrpcService(
            AudioVideoLibrary library,
            AudioFileService audioFileService,
            MeterRegistry metrics) {
        this.persistentTtsService = new PersistentTtsService(library, audioFileService, metrics);
        this.streamingDelegate = new TtsGrpcService(library, metrics);
    }

    /** Package-private constructor for unit testing — supply a pre-wired PersistentTtsService. */
    PersistentTtsGrpcService(PersistentTtsService persistentTtsService) {
        this.persistentTtsService = Objects.requireNonNull(persistentTtsService);
        this.streamingDelegate = null; // streaming not under test via this path
    }

    @Override
    public void synthesize(SynthesizeRequest request, StreamObserver<SynthesizeResponse> responseObserver) {
        String cid = cid();
        String tenantId = getTenantId();
        String userIdStr = getUserId();

        if (tenantId == null || tenantId.isEmpty()) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant ID")
                .asRuntimeException());
            return;
        }

        UUID userId = parseUserId(userIdStr);

        try {
            MDC.put("tenantId", tenantId);
            MDC.put("userId", userIdStr);
            MDC.put("cid", cid);

            String text = request.getText();
            if (text == null || text.isEmpty()) {
                responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Text cannot be empty")
                    .asRuntimeException());
                return;
            }

            if (text.length() > 5000) {
                responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Text exceeds 5000 characters")
                    .asRuntimeException());
                return;
            }

            Optional<String> voiceId = request.getVoiceId().isEmpty()
                ? Optional.empty()
                : Optional.of(request.getVoiceId());

            float speed = request.getOptions().getSpeed() > 0 ? request.getOptions().getSpeed() : 1.0f;
            float pitch = request.getOptions().getPitch() > 0 ? request.getOptions().getPitch() : 1.0f;
            String language = request.getOptions().getLanguage().isEmpty()
                ? null
                : request.getOptions().getLanguage();

            // Perform synthesis with persistence
            persistentTtsService.synthesizeAndPersist(
                tenantId, userId, text, voiceId, speed, pitch, language
            ).whenResult(result -> {
                responseObserver.onNext(SynthesizeResponse.newBuilder()
                    .setAudioData(com.google.protobuf.ByteString.copyFrom(result.audioData()))
                    .setSampleRate(result.sampleRate())
                    .setDurationMs(0L)
                    .setProcessingTimeMs(result.processingTimeMs())
                    .setVoiceUsed(voiceId.orElse(""))
                    .build());
                responseObserver.onCompleted();
            }).whenException(e -> {
                LOG.error("[{}] TTS synthesis failed: {}", cid, e.getMessage(), e);
                responseObserver.onError(toGrpcStatus(cid, e).asRuntimeException());
            });

        } catch (IllegalArgumentException e) {
            LOG.warn("[{}] TTS validation error: {}", cid, e.getMessage());
            responseObserver.onError(Status.INVALID_ARGUMENT
                .withDescription(e.getMessage())
                .asRuntimeException());
        } catch (Exception e) {
            LOG.error("[{}] Unexpected error: {}", cid, e.getMessage(), e);
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Internal error")
                .asRuntimeException());
        } finally {
            MDC.clear();
        }
    }

    @Override
    public void streamSynthesize(SynthesizeRequest request, StreamObserver<AudioChunk> responseObserver) {
        String tenantId = getTenantId();
        if (tenantId == null || tenantId.isEmpty()) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant ID")
                .asRuntimeException());
            return;
        }

        String userIdStr = getUserId();
        String cid = cid();
        try {
            MDC.put("tenantId", tenantId);
            MDC.put("userId", userIdStr);
            MDC.put("cid", cid);
            streamingDelegate.streamSynthesize(request, responseObserver);
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

    private static UUID parseUserId(String userIdStr) {
        if (userIdStr == null) return UUID.randomUUID();
        try {
            return UUID.fromString(userIdStr);
        } catch (IllegalArgumentException e) {
            // Subject is not UUID-formatted (e.g. opaque token ID) — generate a stable random UUID.
            return UUID.randomUUID();
        }
    }

    private Status toGrpcStatus(String cid, Throwable e) {
        if (e instanceof IllegalArgumentException) {
            return Status.INVALID_ARGUMENT.withDescription(e.getMessage());
        }
        if (e instanceof TimeoutException) {
            LOG.warn("[{}] TTS synthesis timed out", cid);
            return Status.DEADLINE_EXCEEDED.withDescription("TTS synthesis timed out");
        }
        return Status.INTERNAL.withDescription("TTS synthesis failed");
    }

    private String cid() {
        return UUID.randomUUID().toString().substring(0, 8);
    }
}
