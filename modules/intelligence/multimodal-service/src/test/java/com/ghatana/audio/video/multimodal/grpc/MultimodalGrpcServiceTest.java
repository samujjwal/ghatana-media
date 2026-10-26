package com.ghatana.audio.video.multimodal.grpc;

import com.ghatana.audio.video.common.observability.MediaProcessingMetrics;
import com.ghatana.audio.video.common.security.JwtServerInterceptor;
import com.ghatana.audio.video.multimodal.engine.AudioResult;
import com.ghatana.audio.video.multimodal.engine.MultimodalAnalysisEngine;
import com.ghatana.audio.video.multimodal.engine.MultimodalMediaGateway;
import com.ghatana.audio.video.multimodal.engine.PlatformMultimodalAdapter;
import com.ghatana.audio.video.multimodal.engine.VisualResult;
import com.ghatana.audio.video.multimodal.grpc.proto.*;
import com.google.protobuf.ByteString;
import io.grpc.Context;
import io.grpc.Status;
import io.grpc.StatusRuntimeException;
import io.grpc.stub.StreamObserver;
import io.micrometer.core.instrument.Metrics;
import io.micrometer.core.instrument.Timer;
import io.micrometer.core.instrument.simple.SimpleMeterRegistry;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.mockito.Mock;
import org.mockito.junit.jupiter.MockitoExtension;

import java.util.List;
import java.util.Set;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.Mockito.lenient;
import static org.mockito.Mockito.verifyNoInteractions;

/**
 * Unit tests for {@link MultimodalGrpcService}.
 *
 * <p>Uses Mockito to avoid native-library and file-system dependencies.
 *
 * @doc.type class
 * @doc.purpose Unit tests for the multimodal gRPC service layer — covers AV-004 methods
 * @doc.layer product
 * @doc.pattern TestCase
 */
@ExtendWith(MockitoExtension.class) 
@DisplayName("MultimodalGrpcService")
class MultimodalGrpcServiceTest {

    private static final String TENANT_ID = "tenant-multimodal-test";
    private static final String SUBJECT_ID = "d7fe98ce-75d3-4a2a-8a04-bb54e23a2f15";

    @Mock
    private MultimodalAnalysisEngine mockEngine;

    @Mock
    private PlatformMultimodalAdapter mockAdapter;

    private MultimodalGrpcService service;
    private SimpleMeterRegistry meterRegistry;

    @BeforeEach
    void setUp() { 
        meterRegistry = new SimpleMeterRegistry();
        Metrics.addRegistry(meterRegistry);
        service = new MultimodalGrpcService(mockEngine, mockAdapter, MediaProcessingMetrics.noop(),
                // Test fixture only: production constructors retain unavailable authorization.
                request -> SourceAuthorization.Decision.ADMITTED);
        lenient().when(mockAdapter.backendName()).thenReturn("test-backend");
        lenient().when(mockAdapter.metricsEnabled()).thenReturn(false); 
    }

    @AfterEach
    void tearDown() {
        Metrics.removeRegistry(meterRegistry);
        meterRegistry.close();
    }

    @Test
    @DisplayName("frame serialization preserves known source PTS when milliseconds cannot be represented")
    void frameTimestampSerializationHandlesUnrepresentableMilliseconds() {
        var timestamp = new com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp(
                com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.Status.KNOWN,
                Long.MAX_VALUE,
                Long.MAX_VALUE,
                1L,
                com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.ClockDomain.SOURCE,
                "video-clock-1",
                null);
        var frame = new com.ghatana.audio.video.multimodal.engine.FrameResult(7, timestamp, List.of());

        FrameAnalysis serialized = MultimodalGrpcService.toFrameAnalysis(frame);

        assertThat(serialized.getTimestampStatus()).isEqualTo(FrameAnalysis.TimestampStatus.TIMESTAMP_STATUS_KNOWN);
        assertThat(serialized.hasTimestampMs()).isFalse();
        assertThat(serialized.hasSourcePts()).isTrue();
        assertThat(serialized.getSourcePts()).isEqualTo(Long.MAX_VALUE);
        assertThat(serialized.getTimeBaseNumerator()).isEqualTo(Long.MAX_VALUE);
        assertThat(serialized.getTimeBaseDenominator()).isEqualTo(1L);
        assertThat(serialized.getDescription()).contains("millisecond projection unavailable");
    }

    @Test
    @DisplayName("frame serialization preserves negative source PTS when milliseconds overflow")
    void frameTimestampSerializationHandlesNegativeMillisecondOverflow() {
        var timestamp = new com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp(
                com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.Status.KNOWN,
                Long.MIN_VALUE,
                Long.MAX_VALUE,
                1L,
                com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.ClockDomain.SOURCE,
                "video-clock-1",
                null);
        var frame = new com.ghatana.audio.video.multimodal.engine.FrameResult(8, timestamp, List.of());

        FrameAnalysis serialized = MultimodalGrpcService.toFrameAnalysis(frame);

        assertThat(serialized.getTimestampStatus()).isEqualTo(FrameAnalysis.TimestampStatus.TIMESTAMP_STATUS_KNOWN);
        assertThat(serialized.hasTimestampMs()).isFalse();
        assertThat(serialized.hasSourcePts()).isTrue();
        assertThat(serialized.getSourcePts()).isEqualTo(Long.MIN_VALUE);
        assertThat(serialized.getTimeBaseNumerator()).isEqualTo(Long.MAX_VALUE);
        assertThat(serialized.getTimeBaseDenominator()).isEqualTo(1L);
    }

    @Test
    @DisplayName("frame serialization omits source PTS for a known media clock")
    void frameTimestampSerializationPreservesNonSourceClockDomain() {
        var frame = new com.ghatana.audio.video.multimodal.engine.FrameResult(
                9,
                com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.mediaMilliseconds(125L),
                List.of());

        FrameAnalysis serialized = MultimodalGrpcService.toFrameAnalysis(frame);

        assertThat(serialized.getTimestampStatus()).isEqualTo(FrameAnalysis.TimestampStatus.TIMESTAMP_STATUS_KNOWN);
        assertThat(serialized.hasTimestampMs()).isTrue();
        assertThat(serialized.getTimestampMs()).isEqualTo(125L);
        assertThat(serialized.hasSourcePts()).isFalse();
        assertThat(serialized.getClockDomain()).isEqualTo(FrameAnalysis.ClockDomain.MEDIA);
    }

    @Test
    @DisplayName("frame serialization preserves unknown reason without invented clock fields")
    void frameTimestampSerializationPreservesUnknownTimestampReason() {
        var frame = new com.ghatana.audio.video.multimodal.engine.FrameResult(
                10,
                com.ghatana.audio.video.multimodal.engine.MediaClockTimestamp.unknown("source PTS missing"),
                List.of());

        FrameAnalysis serialized = MultimodalGrpcService.toFrameAnalysis(frame);

        assertThat(serialized.getTimestampStatus()).isEqualTo(FrameAnalysis.TimestampStatus.TIMESTAMP_STATUS_UNKNOWN);
        assertThat(serialized.getTimestampUnknownReason()).isEqualTo("source PTS missing");
        assertThat(serialized.hasTimestampMs()).isFalse();
        assertThat(serialized.hasSourcePts()).isFalse();
        assertThat(serialized.hasTimeBaseNumerator()).isFalse();
        assertThat(serialized.hasTimeBaseDenominator()).isFalse();
        assertThat(serialized.getClockDomain()).isEqualTo(FrameAnalysis.ClockDomain.CLOCK_DOMAIN_UNSPECIFIED);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // processMultimodal (AV-004) 
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("processMultimodal: no tenant context → UNAUTHENTICATED")
    void processMultimodal_noTenantContext_returnsUnauthenticated() {
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        service.processMultimodal(
            MultimodalRequest.newBuilder().setAudioData(ByteString.copyFrom(new byte[]{1})).build(),
            observer);

        assertThat(observer.hasError()).isTrue();
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
            .isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: missing principal is rejected before dispatch")
    void processMultimodal_missingPrincipal_returnsUnauthenticatedWithoutDispatch() {
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        Context.current().withValue(JwtServerInterceptor.CTX_TENANT, TENANT_ID)
                .run(() -> service.processMultimodal(MultimodalRequest.newBuilder()
                        .setAudioData(ByteString.copyFrom(new byte[] {1})).build(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: malformed principal is rejected before dispatch")
    void processMultimodal_malformedPrincipal_returnsUnauthenticatedWithoutDispatch() {
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        Context.current().withValue(JwtServerInterceptor.CTX_TENANT, TENANT_ID)
                .withValue(JwtServerInterceptor.CTX_SUBJECT, "not-a-uuid")
                .run(() -> service.processMultimodal(MultimodalRequest.newBuilder()
                        .setAudioData(ByteString.copyFrom(new byte[] {1})).build(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAUTHENTICATED.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: empty modality set is invalid even when authority admits")
    void processMultimodal_emptyInputIsRejectedBeforeDispatch() {
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.processMultimodal(MultimodalRequest.getDefaultInstance(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: missing source authority is unavailable before dispatch")
    void processMultimodal_missingSourceAuthority_returnsUnavailableWithoutDispatch() {
        MultimodalGrpcService unavailable = new MultimodalGrpcService(
                mockEngine, mockAdapter, MediaProcessingMetrics.noop(),
                request -> SourceAuthorization.Decision.NOT_ADMITTED);
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> unavailable.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1}))
                .setTenantId("caller-controlled-tenant")
                .setConsentStatus("GRANTED")
                .setOperationBinding(operationBinding(
                        "media.multimodal.observe.source-grounded",
                        "media.operation.capability.media-multimodal-observe-source-grounded",
                        "source observation"))
                .build(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAVAILABLE.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: explicit source-rights denial is permission denied before dispatch")
    void processMultimodal_explicitSourceDenialReturnsPermissionDeniedWithoutDispatch() {
        MultimodalGrpcService denied = new MultimodalGrpcService(
                mockEngine, mockAdapter, MediaProcessingMetrics.noop(),
                request -> SourceAuthorization.Decision.DENIED);
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> denied.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1}))
                .setOperationBinding(operationBinding(
                        "media.multimodal.observe.source-grounded",
                        "media.operation.capability.media-multimodal-observe-source-grounded",
                        "source observation"))
                .build(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.PERMISSION_DENIED.getCode());
        assertAdmissionTimer("failure", 1);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: null source decision is UNKNOWN and fails closed")
    void processMultimodal_nullSourceDecisionRecordsUnknownAdmission() {
        MultimodalGrpcService ambiguous = new MultimodalGrpcService(
                mockEngine, mockAdapter, MediaProcessingMetrics.noop(), request -> null);
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> ambiguous.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1}))
                .setOperationBinding(operationBinding(
                        "media.multimodal.observe.source-grounded",
                        "media.operation.capability.media-multimodal-observe-source-grounded",
                        "source observation"))
                .build(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAVAILABLE.getCode());
        assertAdmissionTimer("unknown", 1);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: production constructor remains unavailable without source authority")
    void processMultimodal_defaultAuthorityIsUnavailable() {
        MultimodalGrpcService noAuthority = new MultimodalGrpcService(
                mockEngine, mockAdapter, MediaProcessingMetrics.noop());
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> noAuthority.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1}))
                .setOperationBinding(operationBinding(
                        "media.multimodal.observe.source-grounded",
                        "media.operation.capability.media-multimodal-observe-source-grounded",
                        "source observation"))
                .build(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAVAILABLE.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: authorization binds trusted identity, modalities, source, purpose and UTF-8 size")
    void processMultimodal_authorizationReceivesExactRequestBoundary() {
        AtomicReference<SourceAuthorization.AuthorizationRequest> captured = new AtomicReference<>();
        MultimodalGrpcService capturing = new MultimodalGrpcService(mockEngine, mockAdapter,
                MediaProcessingMetrics.noop(), request -> {
                    captured.set(request);
                    return SourceAuthorization.Decision.ADMITTED; // Test fixture only.
                });
        MultimodalRequest request = MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1, 2}))
                .setImageData(ByteString.copyFrom(new byte[] {3}))
                .setText("é")
                .setTenantId("caller-controlled-tenant")
                .setArtifactId("caller-source-ref")
                .setConsentStatus("GRANTED")
                .setOperationBinding(operationBinding(
                        "media.multimodal.observe.source-grounded",
                        "media.operation.capability.media-multimodal-observe-source-grounded",
                        "authorized source observation"))
                .build();
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> capturing.processMultimodal(request, observer));

        assertThat(captured.get().tenantId()).isEqualTo(TENANT_ID);
        assertThat(captured.get().principalId()).isEqualTo(java.util.UUID.fromString(SUBJECT_ID));
        assertThat(captured.get().modalities()).isEqualTo(Set.of(
                SourceAuthorization.Modality.AUDIO, SourceAuthorization.Modality.IMAGE,
                SourceAuthorization.Modality.TEXT));
        assertThat(captured.get().artifactId()).isEqualTo("caller-source-ref");
        assertThat(captured.get().artifactVersion()).isEqualTo("source-v17");
        assertThat(captured.get().consentReference()).isNull();
        assertThat(captured.get().capabilityRef()).isEqualTo("media.multimodal.observe.source-grounded");
        assertThat(captured.get().operationRef()).isEqualTo(
                "media.operation.capability.media-multimodal-observe-source-grounded");
        assertThat(captured.get().operationVersion()).isEqualTo(1);
        assertThat(captured.get().requestId()).isEqualTo("request-17");
        assertThat(captured.get().purpose()).isEqualTo("authorized source observation");
        assertThat(captured.get().correlationId()).isEqualTo("correlation-17");
        assertThat(captured.get().dimensions()).isEmpty();
        assertThat(captured.get().contentBytes()).isEqualTo(2 + 1 + 2);
        assertThat(captured.get().contentSha256()).isEqualTo(contentDigest(
                List.of(new byte[] {1, 2}, new byte[] {3}, new byte[0]), "é"));
        assertAdmissionTimer("success", 1);
        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: oversized artifact references are rejected before authorization or dispatch")
    void processMultimodal_oversizedArtifactReferenceIsRejectedBeforeAuthorization() {
        AtomicInteger authorizationCalls = new AtomicInteger();
        MultimodalGrpcService bounded = new MultimodalGrpcService(mockEngine, mockAdapter,
                MediaProcessingMetrics.noop(), request -> {
                    authorizationCalls.incrementAndGet();
                    return SourceAuthorization.Decision.ADMITTED; // Test fixture only.
                });
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        String oversizedReference = "r".repeat(257);

        withContext(TENANT_ID, () -> bounded.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1}))
                .setArtifactId(oversizedReference)
                .build(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        assertThat(authorizationCalls).hasValue(0);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: UTF-8 text byte budget is enforced before authorization")
    void processMultimodal_multibyteTextCannotExceedByteBudget() {
        AtomicInteger authorizationCalls = new AtomicInteger();
        MultimodalGrpcService bounded = new MultimodalGrpcService(mockEngine, mockAdapter,
                MediaProcessingMetrics.noop(), request -> {
                    authorizationCalls.incrementAndGet();
                    return SourceAuthorization.Decision.ADMITTED; // Test fixture only.
                });
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        String text = "😀".repeat(16_385); // 32,770 UTF-16 code units but 65,540 UTF-8 bytes.

        withContext(TENANT_ID, () -> bounded.processMultimodal(MultimodalRequest.newBuilder()
                .setText(text)
                .build(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        assertThat(authorizationCalls).hasValue(0);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: operation and legacy source mismatch are rejected before authority lookup")
    void processMultimodal_invalidCanonicalSelectionDoesNotCallAuthority() {
        AtomicInteger authorizationCalls = new AtomicInteger();
        MultimodalGrpcService bounded = new MultimodalGrpcService(mockEngine, mockAdapter,
                MediaProcessingMetrics.noop(), request -> {
                    authorizationCalls.incrementAndGet();
                    return SourceAuthorization.Decision.ADMITTED; // Test fixture only.
                });
        CanonicalOperationBinding wrongOperation = operationBinding(
                "media.multimodal.observe.source-grounded",
                "media.operation.capability.media-multimodal-describe", "source observation");
        CapturingObserver<MultimodalResponse> wrongOperationObserver = new CapturingObserver<>();
        withContext(TENANT_ID, () -> bounded.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1}))
                .setOperationBinding(wrongOperation)
                .build(), wrongOperationObserver));

        assertFamilyTransportNotAdmitted(wrongOperationObserver);
        assertThat(authorizationCalls).hasValue(0);

        CapturingObserver<MultimodalResponse> mismatchedSourceObserver = new CapturingObserver<>();
        withContext(TENANT_ID, () -> bounded.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1}))
                .setArtifactId("legacy-source-ref")
                .setOperationBinding(operationBinding(
                        "media.multimodal.observe.source-grounded",
                        "media.operation.capability.media-multimodal-observe-source-grounded",
                        "source observation"))
                .build(), mismatchedSourceObserver));

        assertFamilyTransportNotAdmitted(mismatchedSourceObserver);
        assertThat(authorizationCalls).hasValue(0);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: not-admitted or unavailable source authority stops before engine dispatch")
    void processMultimodal_notAdmittedAndUnavailableAuthorityStopBeforeDispatch() {
        for (SourceAuthorization authorization : List.<SourceAuthorization>of(
                request -> SourceAuthorization.Decision.NOT_ADMITTED,
                request -> { throw new IllegalStateException("authority unavailable"); })) {
            MultimodalGrpcService denied = new MultimodalGrpcService(mockEngine, mockAdapter,
                    MediaProcessingMetrics.noop(), authorization);
            CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
            withContext(TENANT_ID, () -> denied.processMultimodal(MultimodalRequest.newBuilder()
                    .setVideoData(ByteString.copyFrom(new byte[] {1}))
                    .setOperationBinding(operationBinding(
                            "media.multimodal.observe.source-grounded",
                            "media.operation.capability.media-multimodal-observe-source-grounded",
                            "source observation"))
                    .build(), observer));

            assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                    .isEqualTo(Status.UNAVAILABLE.getCode());
        }
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: denied mixed rights do not egress to either child gateway")
    void processMultimodal_deniedMixedRightsPreventSttAndVisionGatewayCalls() {
        AtomicInteger sttCalls = new AtomicInteger();
        AtomicInteger imageCalls = new AtomicInteger();
        AtomicInteger videoCalls = new AtomicInteger();
        AtomicReference<SourceAuthorization.AuthorizationRequest> captured = new AtomicReference<>();
        MultimodalMediaGateway gateway = new MultimodalMediaGateway() {
            @Override public AudioResult transcribe(byte[] audioData) {
                sttCalls.incrementAndGet();
                return AudioResult.builder().transcription("fixture").build();
            }
            @Override public VisualResult analyseImage(byte[] imageData) {
                imageCalls.incrementAndGet();
                return VisualResult.builder().sceneDescription("fixture").build();
            }
            @Override public VisualResult analyseVideo(byte[] videoData, int sampleFps, int maxFrames) {
                videoCalls.incrementAndGet();
                return VisualResult.builder().sceneDescription("fixture").build();
            }
            @Override public String backendName() { return "test-fixture"; }
            @Override public boolean metricsEnabled() { return false; }
            @Override public void close() { }
        };
        try (MultimodalAnalysisEngine engine = new MultimodalAnalysisEngine(gateway)) {
            MultimodalGrpcService denied = new MultimodalGrpcService(engine, mockAdapter,
                    MediaProcessingMetrics.noop(), request -> {
                        captured.set(request);
                        return SourceAuthorization.Decision.NOT_ADMITTED;
                    });
            CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
            MultimodalRequest request = MultimodalRequest.newBuilder()
                    .setAudioData(ByteString.copyFrom(new byte[] {1}))
                    .setVideoData(ByteString.copyFrom(new byte[] {2}))
                    .setTenantId("caller-controlled-tenant")
                    .setArtifactId("caller-source-ref")
                    .setConsentStatus("GRANTED")
                    .setOperationBinding(operationBinding(
                            "media.multimodal.observe.source-grounded",
                            "media.operation.capability.media-multimodal-observe-source-grounded",
                            "mixed source analysis"))
                    .build();

            withContext(TENANT_ID, () -> denied.processMultimodal(request, observer));

            assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                    .isEqualTo(Status.UNAVAILABLE.getCode());
            assertThat(captured.get().tenantId()).isEqualTo(TENANT_ID);
            assertThat(captured.get().principalId()).isEqualTo(java.util.UUID.fromString(SUBJECT_ID));
            assertThat(captured.get().modalities()).isEqualTo(Set.of(
                    SourceAuthorization.Modality.AUDIO, SourceAuthorization.Modality.VIDEO));
            assertThat(captured.get().purpose()).isEqualTo("mixed source analysis");
            assertThat(captured.get().artifactId()).isEqualTo("caller-source-ref");
            assertThat(captured.get().artifactVersion()).isEqualTo("source-v17");
            assertThat(captured.get().consentReference()).isNull();
            assertThat(sttCalls).hasValue(0);
            assertThat(imageCalls).hasValue(0);
            assertThat(videoCalls).hasValue(0);
        }
    }

    @Test
    @DisplayName("analyzeVideoWithAudio: authorization includes video source and requested audio extraction")
    void analyzeVideoWithAudio_authorizationBindsVideoAndAudioExtraction() {
        AtomicReference<SourceAuthorization.AuthorizationRequest> captured = new AtomicReference<>();
        MultimodalGrpcService capturing = new MultimodalGrpcService(mockEngine, mockAdapter,
                MediaProcessingMetrics.noop(), request -> {
                    captured.set(request);
                    return SourceAuthorization.Decision.ADMITTED; // Test fixture only.
                });
        byte[] video = {1, 2, 3, 4};
        CapturingObserver<VideoAudioResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> capturing.analyzeVideoWithAudio(VideoAudioRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(video))
                .setExtractAudio(true)
                .setAnalyzeFrames(false)
                .setOperationBinding(operationBinding(
                        "media.multimodal.relate.scene-audio",
                        "media.operation.capability.media-multimodal-relate-scene-audio",
                        "video audio relation"))
                .build(), observer));

        assertThat(captured.get().modalities()).isEqualTo(Set.of(
                SourceAuthorization.Modality.AUDIO, SourceAuthorization.Modality.VIDEO));
        assertThat(captured.get().contentBytes()).isEqualTo(video.length);
        assertThat(captured.get().purpose()).isEqualTo("video audio relation");
        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: modality-only authorization cannot admit a family response")
    void processMultimodal_familyTransportNotAdmittedAfterModalityAuthorization() {
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1}))
                .setImageData(ByteString.copyFrom(new byte[] {2})).build(), observer));

        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: family transport rejects before engine failure can occur")
    void processMultimodal_familyTransportRejectsBeforeEngineDispatch() {
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1})).build(), observer));

        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("admitted source rights still cannot dispatch without canonical job executor")
    void processMultimodalSourceAuthorizationAloneDoesNotAdmitFamilyExecution() {
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.processMultimodal(MultimodalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1}))
                .setOperationBinding(operationBinding(
                        "media.multimodal.observe.source-grounded",
                        "media.operation.capability.media-multimodal-observe-source-grounded",
                        "source observation"))
                .build(), observer));

        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: audio-only family request remains not admitted")
    void processMultimodal_audioOnlyFamilyRequestIsNotAdmitted() {
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.processMultimodal( 
            MultimodalRequest.newBuilder() 
                .setAudioData(ByteString.copyFrom(new byte[]{1})) 
                .build(), 
            observer));

        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // generateDescription
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("generateDescription: modality-only authorization cannot admit a family description")
    void generateDescription_familyTransportNotAdmittedAfterModalityAuthorization() {
        CapturingObserver<DescriptionResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.generateDescription( 
            DescriptionRequest.newBuilder() 
                .setAudioData(ByteString.copyFrom(new byte[]{1, 2})) 
                .setContext("quarterly review")
                .build(), 
            observer));

        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("generateDescription: empty input is invalid before dispatch")
    void generateDescription_emptyInputIsRejectedWithoutDispatch() {
        CapturingObserver<DescriptionResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.generateDescription(DescriptionRequest.getDefaultInstance(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("generateDescription: modality-only authorization cannot admit a family description")
    void generateDescription_familyTransportNotAdmittedBeforeProviderDispatch() {
        CapturingObserver<DescriptionResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.generateDescription(DescriptionRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1})).build(), observer));

        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("generateDescription: context-only family request remains not admitted")
    void generateDescription_contextOnlyFamilyRequestIsNotAdmitted() {
        CapturingObserver<DescriptionResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.generateDescription(DescriptionRequest.newBuilder()
                .setContext("caller supplied context").build(), observer));

        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // analyzeVideoWithAudio
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("analyzeVideoWithAudio: modality-only authorization cannot admit a family narrative")
    void analyzeVideoWithAudio_familyTransportNotAdmittedAfterModalityAuthorization() {
        CapturingObserver<VideoAudioResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.analyzeVideoWithAudio( 
            VideoAudioRequest.newBuilder() 
                .setVideoData(ByteString.copyFrom(new byte[]{9, 8, 7})) 
                .setExtractAudio(true) 
                .setAnalyzeFrames(true) 
                .build(), 
            observer));

        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("analyzeVideoWithAudio: empty video is invalid before dispatch")
    void analyzeVideoWithAudio_emptyVideoIsRejectedWithoutDispatch() {
        CapturingObserver<VideoAudioResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.analyzeVideoWithAudio(
                VideoAudioRequest.getDefaultInstance(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("analyzeVideoWithAudio: no requested operation is invalid before dispatch")
    void analyzeVideoWithAudio_noRequestedOperationIsRejected() {
        CapturingObserver<VideoAudioResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.analyzeVideoWithAudio(VideoAudioRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(new byte[] {1})).build(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("analyzeVideoWithAudio: modality-only authorization cannot admit a family narrative")
    void analyzeVideoWithAudio_familyTransportNotAdmittedBeforeProviderDispatch() {
        CapturingObserver<VideoAudioResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.analyzeVideoWithAudio(VideoAudioRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(new byte[] {1})).setExtractAudio(true).build(), observer));

        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("analyzeVideoWithAudio: unknown-Pts family request remains not admitted")
    void analyzeVideoWithAudio_unknownPtsFamilyRequestIsNotAdmitted() {
        CapturingObserver<VideoAudioResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.analyzeVideoWithAudio(VideoAudioRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(new byte[] {1})).setAnalyzeFrames(true).build(), observer));

        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("getInsights: empty modality set is invalid even when authority admits")
    void getInsights_emptyInputIsRejectedBeforeDispatch() {
        CapturingObserver<InsightsResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.getInsights(InsightsRequest.getDefaultInstance(), observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        verifyNoInteractions(mockEngine);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // analyzeCrossModal (AV-004.4) 
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("analyzeCrossModal: no audio and no video → INVALID_ARGUMENT")
    void analyzeCrossModal_noAudioNoVideo_returnsInvalidArgument() { 
        CapturingObserver<CrossModalResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.analyzeCrossModal(CrossModalRequest.getDefaultInstance(), observer)); 

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("analyzeCrossModal: modality-only authorization cannot admit a family result")
    void analyzeCrossModal_familyTransportNotAdmittedAfterModalityAuthorization() {
        CapturingObserver<CrossModalResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.analyzeCrossModal( 
            CrossModalRequest.newBuilder() 
                .setAudioData(ByteString.copyFrom(new byte[]{1, 2})) 
                .setVideoData(ByteString.copyFrom(new byte[]{3, 4})) 
                .build(), 
            observer));

        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("analyzeCrossModal: one modality is invalid before dispatch")
    void analyzeCrossModal_audioOnly_returnsInvalidArgument() {
        CapturingObserver<CrossModalResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.analyzeCrossModal( 
            CrossModalRequest.newBuilder() 
                .setAudioData(ByteString.copyFrom(new byte[]{1})) 
                .build(), 
            observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.INVALID_ARGUMENT.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("analyzeCrossModal: modality-only authorization cannot admit a family result")
    void analyzeCrossModal_familyTransportNotAdmittedBeforeProviderDispatch() {
        CapturingObserver<CrossModalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.analyzeCrossModal(CrossModalRequest.newBuilder()
                .setAudioData(ByteString.copyFrom(new byte[] {1}))
                .setVideoData(ByteString.copyFrom(new byte[] {2})).build(), observer));

        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getInsights (AV-004.5) 
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("getInsights: heuristic claims are unavailable before modality dispatch")
    void getInsights_withAudioDoesNotReturnHeuristicInsights() {
        CapturingObserver<InsightsResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.getInsights( 
            InsightsRequest.newBuilder() 
                .setAudioData(ByteString.copyFrom(new byte[] {1}))
                .setOperationBinding(operationBinding("media.multimodal.summarize",
                        "media.operation.capability.media-multimodal-summarize", "summary fixture"))
                .build(), 
            observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAVAILABLE.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("getInsights: text only is unavailable without qualified semantic provider")
    void getInsights_withTextOnly_returnsUnavailable() {
        CapturingObserver<InsightsResponse> observer = new CapturingObserver<>(); 
        withContext(TENANT_ID, () -> service.getInsights( 
            InsightsRequest.newBuilder().setText("some context")
                    .setOperationBinding(operationBinding("media.multimodal.summarize",
                            "media.operation.capability.media-multimodal-summarize", "summary fixture"))
                    .build(),
            observer));

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAVAILABLE.getCode());
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: video-only family request remains not admitted")
    void processMultimodal_videoOnlyFamilyRequestIsNotAdmitted() {
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.processMultimodal(MultimodalRequest.newBuilder()
                .setVideoData(ByteString.copyFrom(new byte[] {1})).build(), observer));

        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    @Test
    @DisplayName("processMultimodal: text-only family request remains not admitted")
    void processMultimodal_textOnlyFamilyRequestIsNotAdmitted() {
        CapturingObserver<MultimodalResponse> observer = new CapturingObserver<>();
        withContext(TENANT_ID, () -> service.processMultimodal(MultimodalRequest.newBuilder()
                .setText("private caller context").build(), observer));

        assertFamilyTransportNotAdmitted(observer);
        verifyNoInteractions(mockEngine);
    }

    // ─────────────────────────────────────────────────────────────────────────
    // loadModel (AV-004.1) 
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("loadModel: blank modelId → INVALID_ARGUMENT")
    void loadModel_blankModelId_returnsInvalidArgument() { 
        CapturingObserver<LoadModelResponse> observer = new CapturingObserver<>(); 
        service.loadModel(LoadModelRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    @Test
    @DisplayName("loadModel: valid modelId without qualified provider → UNAVAILABLE without body")
    void loadModel_validModelIdWithoutProvider_returnsUnavailable() {
        CapturingObserver<LoadModelResponse> observer = new CapturingObserver<>(); 
        service.loadModel(LoadModelRequest.newBuilder().setModelId("clip-vit-large").build(), observer);

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAVAILABLE.getCode());
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getDescription())
                .contains("Qualified multimodal model provider is unavailable");
        assertThat(observer.getValue()).isNull();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // unloadModel (AV-004.2) 
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("unloadModel: blank modelId → INVALID_ARGUMENT")
    void unloadModel_blankModelId_returnsInvalidArgument() { 
        CapturingObserver<UnloadModelResponse> observer = new CapturingObserver<>(); 
        service.unloadModel(UnloadModelRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isTrue(); 
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode()) 
            .isEqualTo(Status.INVALID_ARGUMENT.getCode()); 
    }

    @Test
    @DisplayName("unloadModel: valid modelId without qualified provider → UNAVAILABLE without body")
    void unloadModel_validModelIdWithoutProvider_returnsUnavailable() {
        CapturingObserver<UnloadModelResponse> observer = new CapturingObserver<>(); 
        service.unloadModel(UnloadModelRequest.newBuilder().setModelId("ghost-model").build(), observer);

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAVAILABLE.getCode());
        assertThat(observer.getValue()).isNull();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // listModels (AV-004.3) 
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("listModels: without qualified provider → UNAVAILABLE without registry data")
    void listModelsWithoutProvider_returnsUnavailable() {
        CapturingObserver<ListModelsResponse> observer = new CapturingObserver<>(); 
        service.listModels(ListModelsRequest.getDefaultInstance(), observer); 

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAVAILABLE.getCode());
        assertThat(observer.getValue()).isNull();
    }

    @Test
    @DisplayName("listModels: includeLoadedOnly does not expose local model entries")
    void listModelsLoadedOnlyWithoutProvider_returnsUnavailable() {
        service.loadModel(LoadModelRequest.newBuilder().setModelId("test-model").build(),
                new CapturingObserver<>());
        CapturingObserver<ListModelsResponse> observer = new CapturingObserver<>();
        service.listModels(ListModelsRequest.newBuilder().setIncludeLoadedOnly(true).build(), observer);

        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.UNAVAILABLE.getCode());
        assertThat(observer.getValue()).isNull();
    }

    // ─────────────────────────────────────────────────────────────────────────
    // getStatus
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("getStatus: does not promote a generic adapter backend to provider readiness")
    void getStatus_returnsStatus() { 
        CapturingObserver<StatusResponse> observer = new CapturingObserver<>(); 
        service.getStatus(StatusRequest.getDefaultInstance(), observer); 

        assertThat(observer.hasError()).isFalse(); 
        assertThat(observer.getValue().getStatus()).isEqualTo("NOT_ADMITTED");
        assertThat(observer.getValue().getStatus()).doesNotContain("test-backend", "healthy");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // healthCheck
    // ─────────────────────────────────────────────────────────────────────────

    @Test
    @DisplayName("healthCheck: missing qualified child providers returns not healthy")
    void healthCheck_returnsNotServingWithoutQualifiedProviders() {
        CapturingObserver<HealthCheckResponse> observer = new CapturingObserver<>();
        service.healthCheck(HealthCheckRequest.getDefaultInstance(), observer);

        assertThat(observer.hasError()).isFalse();
        assertThat(observer.getValue().getHealthy()).isFalse();
        assertThat(observer.getValue().getMessage())
                .isEqualTo("MULTIMODAL_NOT_SERVING: qualified child provider readiness unavailable");
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Test infrastructure
    // ─────────────────────────────────────────────────────────────────────────

    static class CapturingObserver<T> implements StreamObserver<T> {
        private T value;
        private Throwable error;

        @Override public void onNext(T value) { this.value = value; } 
        @Override public void onError(Throwable t) { this.error = t; } 
        @Override public void onCompleted() {} 

        T getValue() { return value; } 
        boolean hasError() { return error != null; } 
        Throwable getError() { return error; } 
    }

    private static void assertFamilyTransportNotAdmitted(CapturingObserver<?> observer) {
        assertThat(observer.hasError()).isTrue();
        assertThat(observer.getValue()).isNull();
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getCode())
                .isEqualTo(Status.FAILED_PRECONDITION.getCode());
        assertThat(((StatusRuntimeException) observer.getError()).getStatus().getDescription())
                .startsWith("MULTIMODAL_FAMILY_NOT_ADMITTED:");
    }

    private static CanonicalOperationBinding operationBinding(String capabilityRef,
                                                               String operationRef,
                                                               String purpose) {
        return CanonicalOperationBinding.newBuilder()
                .setCapabilityRef(capabilityRef)
                .setOperationRef(operationRef)
                .setOperationVersion(1)
                .setRequestId("request-17")
                .setSourceArtifactId("caller-source-ref")
                .setSourceVersionId("source-v17")
                .setPurpose(purpose)
                .setCorrelationId("correlation-17")
                .build();
    }

    private static String contentDigest(List<byte[]> parts, String text) {
        try {
            java.security.MessageDigest digest = java.security.MessageDigest.getInstance("SHA-256");
            for (byte[] part : parts) {
                digest.update(java.nio.ByteBuffer.allocate(Long.BYTES).putLong(part.length).array());
                digest.update(part);
            }
            byte[] textBytes = text.getBytes(java.nio.charset.StandardCharsets.UTF_8);
            digest.update(java.nio.ByteBuffer.allocate(Long.BYTES).putLong(textBytes.length).array());
            digest.update(textBytes);
            return java.util.HexFormat.of().formatHex(digest.digest());
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new AssertionError("SHA-256 is required by the Java runtime", impossible);
        }
    }

    private static void withContext(String tenantId, Runnable action) {
        Context.current().withValue(JwtServerInterceptor.CTX_TENANT, tenantId)
                .withValue(JwtServerInterceptor.CTX_SUBJECT, SUBJECT_ID).run(action);
    }

    private void assertAdmissionTimer(String outcome, long expectedCount) {
        Timer timer = meterRegistry.find("media.modality.boundary.duration")
                .tags("modality", "multimodal", "service", "multimodal", "boundary", "admission",
                        "execution_class", "control", "outcome", outcome, "contract_version", "v1").timer();
        assertThat(timer).isNotNull();
        assertThat(timer.count()).isEqualTo(expectedCount);
        assertThat(timer.getId().getTags()).extracting("key")
                .containsExactlyInAnyOrder("modality", "service", "boundary", "execution_class",
                        "outcome", "contract_version");
        assertThat(meterRegistry.getMeters()).allSatisfy(meter -> {
            assertThat(meter.getId().getTag("tenant")).isNull();
            assertThat(meter.getId().getTag("request")).isNull();
            assertThat(meter.getId().getTag("content")).isNull();
        });
    }
}
