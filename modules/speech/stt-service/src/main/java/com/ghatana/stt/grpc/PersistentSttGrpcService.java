package com.ghatana.stt.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.audio.video.infrastructure.persistence.service.TranscriptionService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.stt.core.grpc.proto.*;
import com.ghatana.stt.service.PersistentSttService;
import com.ghatana.stt.service.SttAudioInputDecoder;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

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
    private final SttRequestAuthorization requestAuthorization;

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
        JwtServerInterceptor.VerifiedIdentity identity = JwtServerInterceptor.verifiedIdentity();
        String tenantId = identity == null ? null : identity.tenantId();
        String principalId = identity == null ? null : identity.subject();
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
        this(new PersistentSttService(library, audioFileService, transcriptionService, metrics),
                SttRequestAuthorization.unavailable());
    }

    /**
     * Package-private constructor for unit testing — supply a pre-built service.
     */
    PersistentSttGrpcService(PersistentSttService persistentSttService) {
        this(persistentSttService, SttRequestAuthorization.unavailable());
    }

    PersistentSttGrpcService(
            PersistentSttService persistentSttService,
            SttRequestAuthorization requestAuthorization) {
        this.persistentSttService = Objects.requireNonNull(persistentSttService);
        this.requestAuthorization = Objects.requireNonNull(requestAuthorization, "requestAuthorization");
    }

    @Override
    public void transcribe(TranscribeRequest request, StreamObserver<TranscribeResponse> responseObserver) {
        if (!requireAuthenticatedTenantPrincipal(responseObserver)) return;
        JwtServerInterceptor.VerifiedIdentity identity = JwtServerInterceptor.verifiedIdentity();
        String tenantId = identity.tenantId();
        String userIdStr = identity.subject();

        final UUID userId;
        try {
            userId = UUID.fromString(userIdStr);
        } catch (IllegalArgumentException invalidSubject) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Authenticated subject is not a supported principal identifier")
                .asRuntimeException());
            return;
        }

        if (!authorizeTranscription(responseObserver, identity, request.getArtifactId())) return;

        try {
            SttAudioInputDecoder.requireInputSize(request.getAudioData().size());
            int sampleRate = request.getSampleRate() == 0 ? 16000 : request.getSampleRate();
            SttAudioInputDecoder.requireSampleRate(sampleRate);
            String language = request.getLanguage();
            if (!PersistentSttService.isSupportedLanguage(language)) {
                throw new IllegalArgumentException("Unsupported language");
            }

            byte[] audioBytes = request.getAudioData().toByteArray();
            // Keep this compatibility boundary aligned with the canonical upload decoder:
            // sniff supported WAV containers and preserve the legacy unknown-bytes-as-mono-
            // S16LE-PCM behavior. This validates malformed/unsupported formats before the
            // transcript admission gate without enabling provider or mutable persistence work.
            java.time.Duration audioDuration = SttAudioInputDecoder
                    .inspectDuration(audioBytes, null, sampleRate, SttAudioInputDecoder.DEFAULT_MAX_AUDIO_LENGTH_SECONDS);

            if (!transcriptVersioningAdmitted()) {
                // This RPC accepts mutable uploaded bytes, while the admitted transcript store requires
                // a governed source artifact/version, provider result and rights/consent provenance.
                // Validate the request contract first, then stop before any persistence or provider work.
                responseObserver.onError(io.grpc.Status.FAILED_PRECONDITION
                        .withDescription("STT_TRANSCRIPT_VERSION_NOT_ADMITTED: governed source artifact, admitted provider, rights provenance and immutable transcript store are unavailable")
                        .asRuntimeException());
                return;
            }

            String fileName = "audio.wav";

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
                            .withDescription("Invalid transcription result").asRuntimeException());
                }
            }).whenException(e -> {
                // AV-P1-004: Map exception types to appropriate gRPC status codes
                io.grpc.Status grpcStatus = toGrpcStatus(e);
                responseObserver.onError(grpcStatus.asRuntimeException());
            });

        } catch (SttAudioInputDecoder.InputException e) {
            io.grpc.Status grpcStatus = switch (e.kind()) {
                case INVALID_ARGUMENT -> io.grpc.Status.INVALID_ARGUMENT;
                case RESOURCE_EXHAUSTED -> io.grpc.Status.RESOURCE_EXHAUSTED;
                case NOT_ADMITTED -> io.grpc.Status.FAILED_PRECONDITION;
            };
            String description = switch (e.kind()) {
                case INVALID_ARGUMENT -> "Invalid audio input";
                case RESOURCE_EXHAUSTED -> "Audio input exceeds the supported limit";
                case NOT_ADMITTED -> "Audio input is not admitted";
            };
            responseObserver.onError(grpcStatus.withDescription(description).asRuntimeException());
        } catch (IllegalArgumentException e) {
            // AV-P1-004: Validation threw synchronously (before Promise was returned)
            LOG.warn("STT transcribe validation failed failureType={}", failureType(e));
            responseObserver.onError(io.grpc.Status.INVALID_ARGUMENT
                .withDescription("Invalid transcription request").asRuntimeException());
        } catch (SecurityException e) {
            LOG.warn("STT authenticated identity rejected failureType={}", failureType(e));
            reportFailure(e, responseObserver);
        } catch (Exception e) {
            LOG.error("STT transcribe failed failureType={}", failureType(e));
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("Internal error").asRuntimeException());
        }
    }

    /** No provider, source-artifact resolver or immutable revision store is wired into this service. */
    private boolean transcriptVersioningAdmitted() {
        return false;
    }

    private boolean authorizeTranscription(
            StreamObserver<?> observer,
            JwtServerInterceptor.VerifiedIdentity identity,
            String artifactId) {
        SttRequestAuthorization.Decision decision;
        try {
            decision = requestAuthorization.authorize(new SttRequestAuthorization.Request(
                    identity, SttRequestAuthorization.Operation.TRANSCRIBE, artifactId));
        } catch (RuntimeException unavailable) {
            decision = SttRequestAuthorization.Decision.UNAVAILABLE;
        }
        if (decision == null) decision = SttRequestAuthorization.Decision.UNAVAILABLE;
        if (decision == SttRequestAuthorization.Decision.ADMITTED) return true;

        String code = switch (decision) {
            case DENIED -> "STT_RIGHTS_DENIED";
            case REVOKED -> "STT_RIGHTS_REVOKED";
            case UNAVAILABLE -> "STT_RIGHTS_NOT_ADMITTED";
            case ADMITTED -> throw new IllegalStateException("admitted decision handled above");
        };
        io.grpc.Status status = decision == SttRequestAuthorization.Decision.UNAVAILABLE
                ? io.grpc.Status.FAILED_PRECONDITION : io.grpc.Status.PERMISSION_DENIED;
        observer.onError(status.withDescription(code + (decision == SttRequestAuthorization.Decision.UNAVAILABLE
                ? ": trusted rights and ownership authority is unavailable"
                : ": trusted rights and ownership policy denied the request")).asRuntimeException());
        return false;
    }

    /**
     * AV-P1-004: Map exception types to canonical gRPC status codes.
     */
    void reportFailure(Throwable e, StreamObserver<?> responseObserver) {
        responseObserver.onError(toGrpcStatus(e).asRuntimeException());
    }

    io.grpc.Status toGrpcStatus(Throwable e) {
        if (e instanceof SecurityException) {
            LOG.warn("STT authenticated identity rejected failureType={}", failureType(e));
            return io.grpc.Status.UNAUTHENTICATED.withDescription("Authenticated identity required");
        }
        if (e instanceof IllegalArgumentException) {
            LOG.warn("STT transcribe validation failed failureType={}", failureType(e));
            return io.grpc.Status.INVALID_ARGUMENT.withDescription("Invalid transcription request");
        }
        if (e instanceof java.util.concurrent.TimeoutException) {
            LOG.warn("STT transcribe timed out failureType={}", failureType(e));
            return io.grpc.Status.DEADLINE_EXCEEDED.withDescription("Transcription timed out");
        }
        if (e instanceof com.ghatana.media.common.InferenceError ie && !ie.isRetryable()) {
            LOG.error("STT transcribe non-retryable inference failure failureType={}", failureType(e));
            return io.grpc.Status.INTERNAL.withDescription("Inference failed");
        }
        if (e instanceof com.ghatana.media.common.InferenceError) {
            LOG.warn("STT transcribe retryable inference failure failureType={}", failureType(e));
            return io.grpc.Status.UNAVAILABLE.withDescription("Transcription temporarily unavailable");
        }
        LOG.error("STT transcribe failed failureType={}", failureType(e));
        return io.grpc.Status.INTERNAL.withDescription("Transcription failed");
    }

    private static String failureType(Throwable failure) {
        String name = failure.getClass().getSimpleName();
        return name == null || name.isBlank() ? "UNKNOWN" : name;
    }

}
