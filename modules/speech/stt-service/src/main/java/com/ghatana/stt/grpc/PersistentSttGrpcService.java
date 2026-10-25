package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.infrastructure.persistence.service.TranscriptionService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.stt.core.grpc.proto.*;
import com.ghatana.stt.service.PersistentSttService;
import com.ghatana.stt.service.SttAudioInputDecoder;
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

    @Override
    public void createProfile(CreateProfileRequest request, StreamObserver<ProfileResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipal(responseObserver)) return;
        speakerProfileNotAdmitted(responseObserver);
    }

    @Override
    public void getProfile(GetProfileRequest request, StreamObserver<ProfileResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipal(responseObserver)) return;
        speakerProfileNotAdmitted(responseObserver);
    }

    @Override
    public void updateProfile(UpdateProfileRequest request, StreamObserver<ProfileResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipal(responseObserver)) return;
        speakerProfileNotAdmitted(responseObserver);
    }

    private static boolean requireAuthenticatedTenantPrincipal(StreamObserver<?> observer) {
        String tenantId = JwtServerInterceptor.CTX_TENANT.get();
        String principalId = JwtServerInterceptor.CTX_SUBJECT.get();
        if (tenantId == null || tenantId.isBlank() || principalId == null || principalId.isBlank()) {
            observer.onError(io.grpc.Status.UNAUTHENTICATED
                    .withDescription("STT_IDENTITY_REQUIRED: authenticated tenant and subject are required")
                    .asRuntimeException());
            return false;
        }
        try {
            UUID.fromString(principalId);
        } catch (IllegalArgumentException invalidPrincipal) {
            observer.onError(io.grpc.Status.UNAUTHENTICATED
                    .withDescription("STT_IDENTITY_INVALID: authenticated subject is not a supported principal identifier")
                    .asRuntimeException());
            return false;
        }
        return true;
    }

    private static void speakerProfileNotAdmitted(StreamObserver<ProfileResponse> responseObserver) {
        responseObserver.onError(io.grpc.Status.FAILED_PRECONDITION
                .withDescription("STT_SPEAKER_PROFILE_NOT_ADMITTED: trusted rights, purpose, consent, embedding and tenant-scoped persistence admission are unavailable")
                .asRuntimeException());
    }

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

        if (tenantId == null || tenantId.isBlank()) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant ID")
                .asRuntimeException());
            return;
        }

        if (userIdStr == null || userIdStr.isBlank()) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing authenticated subject")
                .asRuntimeException());
            return;
        }

        final UUID userId;
        try {
            userId = UUID.fromString(userIdStr);
        } catch (IllegalArgumentException invalidSubject) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Authenticated subject is not a supported principal identifier")
                .asRuntimeException());
            return;
        }

        if (!transcriptVersioningAdmitted()) {
            // This RPC accepts mutable uploaded bytes, while the admitted transcript store requires
            // a governed source artifact/version, provider result and rights/consent provenance.
            // Do not reach the legacy mutable transcription entity until that path is composed.
            responseObserver.onError(io.grpc.Status.FAILED_PRECONDITION
                    .withDescription("STT_TRANSCRIPT_VERSION_NOT_ADMITTED: governed source artifact, admitted provider, rights provenance and immutable transcript store are unavailable")
                    .asRuntimeException());
            return;
        }

        try {
            MDC.put("tenantId", tenantId);
            MDC.put("userId", userIdStr);
            MDC.put("cid", cid);

            SttAudioInputDecoder.requireInputSize(request.getAudioData().size());
            byte[] audioBytes = request.getAudioData().toByteArray();
            if (audioBytes.length == 0) {
                responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                    .withDescription("Audio data cannot be empty")
                    .asRuntimeException());
                return;
            }

            int sampleRate = request.getSampleRate() > 0 ? request.getSampleRate() : 16000;
            java.time.Duration audioDuration = SttAudioInputDecoder.inspectWavDuration(audioBytes, sampleRate);
            String fileName = "audio.wav";
            String language = request.getLanguage();

            // Perform transcription with persistence
            persistentSttService.transcribeAndPersist(
                tenantId, userId, audioBytes, fileName,
                AudioFormat.WAV, language, sampleRate
            ).whenResult(result -> {
                try {
                    responseObserver.onNext(SttTranscriptionResponseMapper.toProto(result, audioDuration).build());
                    responseObserver.onCompleted();
                } catch (SttTranscriptionResponseMapper.InvalidResultException invalidResult) {
                    responseObserver.onError(io.grpc.Status.INTERNAL
                            .withDescription(invalidResult.getMessage()).asRuntimeException());
                }
            }).whenException(e -> {
                // AV-P1-004: Map exception types to appropriate gRPC status codes
                io.grpc.Status grpcStatus = toGrpcStatus(cid, e);
                responseObserver.onError(grpcStatus.asRuntimeException());
            });

        } catch (SttAudioInputDecoder.InputException e) {
            io.grpc.Status grpcStatus = switch (e.kind()) {
                case INVALID_ARGUMENT -> io.grpc.Status.INVALID_ARGUMENT;
                case RESOURCE_EXHAUSTED -> io.grpc.Status.RESOURCE_EXHAUSTED;
                case NOT_ADMITTED -> io.grpc.Status.FAILED_PRECONDITION;
            };
            responseObserver.onError(grpcStatus.withDescription(e.getMessage()).asRuntimeException());
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

    /** No provider, source-artifact resolver or immutable revision store is wired into this service. */
    private boolean transcriptVersioningAdmitted() {
        return false;
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
