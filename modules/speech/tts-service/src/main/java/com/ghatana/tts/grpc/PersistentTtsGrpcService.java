package com.ghatana.tts.grpc;

import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.infrastructure.persistence.service.AudioFileService;
import com.ghatana.media.AudioVideoLibrary;
import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.common.AudioData;
import com.ghatana.tts.core.grpc.proto.*;
import com.ghatana.tts.service.PersistentTtsService;
import com.ghatana.tts.engine.PcmAudioValidator;
import com.ghatana.tts.engine.TtsSynthesisEngine;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.MeterRegistry;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

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
        String tenantId = getTenantId();
        String userIdStr = getUserId();

        if (tenantId == null || tenantId.isEmpty()) {
            responseObserver.onError(io.grpc.Status.UNAUTHENTICATED
                .withDescription("Missing tenant ID")
                .asRuntimeException());
            return;
        }

        if (userIdStr == null || userIdStr.isBlank()) {
            responseObserver.onError(Status.UNAUTHENTICATED
                .withDescription("Missing authenticated subject")
                .asRuntimeException());
            return;
        }
        UUID userId;
        try {
            userId = UUID.fromString(userIdStr);
        } catch (IllegalArgumentException exception) {
            responseObserver.onError(Status.UNAUTHENTICATED
                .withDescription("Authenticated subject is not a supported principal identifier")
                .asRuntimeException());
            return;
        }

        if (!request.getVoiceId().isBlank() || !request.getProfileId().isBlank()) {
            responseObserver.onError(Status.UNIMPLEMENTED
                .withDescription("Voice/profile selection is NOT_ADMITTED without an authoritative owner, rights and consent decision")
                .asRuntimeException());
            return;
        }

        try {
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

            SynthesisControlPolicy.rejectUnqualifiedSsml(text);

            var controls = SynthesisControlPolicy.resolve(request, AudioFormat.PCM);
            Optional<String> voiceId = request.getVoiceId().isEmpty()
                ? Optional.empty()
                : Optional.of(request.getVoiceId());

            float speed = (float) controls.speed();
            float pitch = (float) controls.pitch();
            String language = request.getOptions().getLanguage().isEmpty()
                ? null
                : request.getOptions().getLanguage();

            // Perform synthesis with persistence
            persistentTtsService.synthesizeAndPersist(
                tenantId, userId, text, voiceId, speed, pitch, language
            ).whenResult(result -> {
                try {
                    validatePersistentResult(result);
                } catch (RuntimeException invalidResult) {
                    responseObserver.onError(Status.FAILED_PRECONDITION
                            .withDescription("Persistent TTS result failed audio validation")
                            .asRuntimeException());
                    return;
                }
                responseObserver.onNext(SynthesizeResponse.newBuilder()
                    .setAudioData(com.google.protobuf.ByteString.copyFrom(result.audioData()))
                    .setSampleRate(result.sampleRate())
                    .setDurationMs(result.durationMillis())
                    .setProcessingTimeMs(result.processingTimeMs())
                    .setVoiceUsed(voiceId.orElse(""))
                    .build());
                responseObserver.onCompleted();
            }).whenException(e -> {
                LOG.error("TTS synthesis failed (type={})", rootCause(e).getClass().getSimpleName());
                responseObserver.onError(toGrpcStatus(e).asRuntimeException());
            });

        } catch (IllegalArgumentException e) {
            LOG.warn("TTS validation failed (type={})", e.getClass().getSimpleName());
            responseObserver.onError(Status.INVALID_ARGUMENT
                .withDescription("Invalid TTS synthesis request")
                .asRuntimeException());
        } catch (UnsupportedOperationException e) {
            responseObserver.onError(Status.UNIMPLEMENTED
                .withDescription("Requested TTS capability is not implemented")
                .asRuntimeException());
        } catch (Exception e) {
            LOG.error("TTS synthesis failed (type={})", e.getClass().getSimpleName());
            responseObserver.onError(io.grpc.Status.INTERNAL
                .withDescription("TTS synthesis failed")
                .asRuntimeException());
        }
    }

    private static void validatePersistentResult(PersistentTtsService.SynthesisResult result) {
        if (result == null || !"PCM_S16LE".equals(result.format())
                || result.durationMillis() <= 0 || result.sampleRate() != 22_050) {
            throw new IllegalStateException("Persistent TTS result has unsupported format metadata");
        }
        var audio = new AudioData(
                result.audioData(), result.sampleRate(), result.channels(), result.bitsPerSample(),
                java.time.Duration.ofMillis(result.durationMillis()), AudioFormat.PCM);
        var facts = PcmAudioValidator.validate(audio, 22_050, 1);
        if (facts.duration().toMillis() != result.durationMillis()) {
            throw new IllegalStateException("Persistent TTS result duration does not match its PCM frames");
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

        streamingDelegate.streamSynthesize(request, responseObserver);
    }

    private String getTenantId() {
        String tenantId = JwtServerInterceptor.CTX_TENANT.get();
        return tenantId != null && !tenantId.isBlank() ? tenantId : null;
    }

    private String getUserId() {
        return JwtServerInterceptor.CTX_SUBJECT.get();
    }

    private Status toGrpcStatus(Throwable e) {
        Throwable cause = rootCause(e);
        if (cause instanceof TtsSynthesisEngine.SynthesisException synthesis
                && synthesis.reason() == TtsSynthesisEngine.FailureReason.NOT_ADMITTED) {
            return Status.UNAVAILABLE.withDescription("TTS_NOT_ADMITTED: synthesis provider or capability is unavailable");
        }
        if (cause instanceof UnsupportedOperationException) {
            return Status.UNIMPLEMENTED.withDescription("Requested TTS capability is not implemented");
        }
        if (cause instanceof IllegalArgumentException) {
            return Status.INVALID_ARGUMENT.withDescription("Invalid TTS synthesis request");
        }
        if (cause instanceof TimeoutException) {
            LOG.warn("TTS synthesis timed out");
            return Status.DEADLINE_EXCEEDED.withDescription("TTS synthesis timed out");
        }
        return Status.INTERNAL.withDescription("TTS synthesis failed");
    }

    private static Throwable rootCause(Throwable error) {
        Throwable cause = error;
        while (cause.getCause() != null && cause.getCause() != cause) cause = cause.getCause();
        return cause;
    }
}
