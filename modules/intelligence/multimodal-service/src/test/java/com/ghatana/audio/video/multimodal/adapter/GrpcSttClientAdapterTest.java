/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.adapter;

import com.ghatana.audio.video.multimodal.engine.AudioResult;
import com.ghatana.stt.core.grpc.proto.ConfidenceCalibration;
import com.ghatana.stt.core.grpc.proto.STTServiceGrpc;
import com.ghatana.stt.core.grpc.proto.TranscribeResponse;
import io.grpc.Server;
import io.grpc.ServerBuilder;
import io.grpc.Status;
import io.grpc.stub.StreamObserver;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Integration tests for {@link GrpcSttClientAdapter}.
 *
 * <p>Full live-service assertions run in the STT gRPC integration suite. These focused tests prove
 * that provider outages fail explicitly and can never fall through to a text-model transcription.
 *
 * @doc.type class
 * @doc.purpose Integration tests for grounded STT modes and provider failure behavior
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("GrpcSttClientAdapter Integration Tests")
@Tag("integration")
class GrpcSttClientAdapterTest {

    @Test
    @DisplayName("NOP mode returns explicit empty disabled result")
    void nopModeReturnsEmptyResult() {
        try (GrpcSttClientAdapter adapter = new GrpcSttClientAdapter(
                "localhost",
                50051,
                GrpcSttClientAdapter.SttMode.NOP)) {
            AudioResult result = adapter.transcribe(new byte[1024]);

            assertThat(result).isNotNull();
            assertThat(result.isError()).isFalse();
            assertThat(result.getTranscription()).isEmpty();
            assertThat(result.hasConfidence()).isFalse();
            assertThat(result.getConfidenceCalibration()).isEqualTo(AudioResult.ConfidenceCalibration.UNKNOWN);
            assertThat(adapter.getCurrentMode()).isEqualTo(GrpcSttClientAdapter.SttMode.NOP);
        }
    }

    @Test
    @DisplayName("GRPC mode reports provider outage instead of fabricating transcription")
    void grpcModeFailsClosedWhenEndpointUnavailable() {
        try (GrpcSttClientAdapter adapter = new GrpcSttClientAdapter(
                "localhost",
                1,
                GrpcSttClientAdapter.SttMode.GRPC)) {
            AudioResult result = adapter.transcribe(new byte[1024]);

            assertThat(result).isNotNull();
            assertThat(result.isError()).isTrue();
            assertThat(result.getTranscription()).isEmpty();
            assertThat(result.getError()).contains("STT provider unavailable");
            assertThat(adapter.getCurrentMode()).isEqualTo(GrpcSttClientAdapter.SttMode.GRPC);
        }
    }

    @Test
    @DisplayName("Empty audio is rejected before provider invocation")
    void emptyAudioFailsClosed() {
        try (GrpcSttClientAdapter adapter = new GrpcSttClientAdapter(
                "localhost", 50051, GrpcSttClientAdapter.SttMode.GRPC)) {
            AudioResult result = adapter.transcribe(new byte[0]);

            assertThat(result.isError()).isTrue();
            assertThat(result.getError()).contains("must not be empty");
        }
    }

    @Test
    @DisplayName("Default constructor uses grounded GRPC mode")
    void defaultConstructorUsesGrpcMode() {
        try (GrpcSttClientAdapter adapter = new GrpcSttClientAdapter("localhost", 1)) {
            AudioResult result = adapter.transcribe(new byte[1024]);

            assertThat(result.isError()).isTrue();
            assertThat(adapter.getCurrentMode()).isEqualTo(GrpcSttClientAdapter.SttMode.GRPC);
        }
    }

    @Test
    @DisplayName("Adapter rejects invalid provider coordinates")
    void adapterRejectsInvalidProviderCoordinates() {
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> new GrpcSttClientAdapter(" ", 50051))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("host");
        org.assertj.core.api.Assertions.assertThatThrownBy(
                        () -> new GrpcSttClientAdapter("localhost", 0))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("port");
    }

    @Test
    @DisplayName("Adapter can be closed")
    void adapterCanBeClosed() {
        try (GrpcSttClientAdapter ignored = new GrpcSttClientAdapter("localhost", 50051)) {
            // Auto-close via try-with-resources.
        }
    }

    @Test
    @DisplayName("Preserves STT confidence availability and calibration over gRPC")
    void preservesConfidenceCalibrationOverGrpc() throws Exception {
        for (ConfidenceCalibration wireCalibration : ConfidenceCalibration.values()) {
            if (wireCalibration == ConfidenceCalibration.UNRECOGNIZED) continue;
            float score = wireCalibration == ConfidenceCalibration.CONFIDENCE_CALIBRATION_UNKNOWN
                    ? 0.0f : 0.73f;
            Server server = ServerBuilder.forPort(0)
                    .addService(new STTServiceGrpc.STTServiceImplBase() {
                        @Override
                        public void transcribe(
                                com.ghatana.stt.core.grpc.proto.TranscribeRequest request,
                                StreamObserver<TranscribeResponse> observer) {
                            observer.onNext(TranscribeResponse.newBuilder().setText("recognized")
                                    .setConfidence(score).setConfidenceCalibration(wireCalibration).build());
                            observer.onCompleted();
                        }
                    }).build().start();
            try (GrpcSttClientAdapter adapter = GrpcSttClientAdapter.forLocalTesting(
                    "localhost", server.getPort(), GrpcSttClientAdapter.SttMode.GRPC)) {
                AudioResult result = adapter.transcribe(new byte[] {1});
                switch (wireCalibration) {
                    case CONFIDENCE_CALIBRATION_UNKNOWN -> {
                        assertThat(result.hasConfidence()).isFalse();
                        assertThat(result.getConfidence()).isNull();
                        assertThat(result.getConfidenceCalibration()).isEqualTo(AudioResult.ConfidenceCalibration.UNKNOWN);
                    }
                    case CONFIDENCE_CALIBRATION_UNCALIBRATED -> {
                        assertThat(result.getConfidence()).isCloseTo(0.73, org.assertj.core.data.Offset.offset(0.00001));
                        assertThat(result.getConfidenceCalibration()).isEqualTo(AudioResult.ConfidenceCalibration.UNCALIBRATED);
                    }
                    case CONFIDENCE_CALIBRATION_CALIBRATED -> {
                        assertThat(result.getConfidence()).isCloseTo(0.73, org.assertj.core.data.Offset.offset(0.00001));
                        assertThat(result.getConfidenceCalibration()).isEqualTo(AudioResult.ConfidenceCalibration.CALIBRATED);
                    }
                    default -> throw new AssertionError("Unexpected calibration " + wireCalibration);
                }
            } finally {
                server.shutdownNow();
            }
        }
    }

    @Test
    @DisplayName("Rejects invalid available scores and retains unknown default as absent")
    void validatesAvailableConfidence() {
        assertThatThrownBy(() -> AudioResult.builder().confidence(Double.NaN))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> AudioResult.builder().confidence(1.01))
                .isInstanceOf(IllegalArgumentException.class);
        AudioResult absent = AudioResult.builder().build();
        assertThat(absent.hasConfidence()).isFalse();
        assertThat(absent.getConfidenceCalibration()).isEqualTo(AudioResult.ConfidenceCalibration.UNKNOWN);
    }

    @Test
    @DisplayName("Deadline and cancellation statuses propagate as ambiguous outcomes")
    void propagatesDeadlineAndCancellation() throws Exception {
        for (Status status : new Status[] {Status.DEADLINE_EXCEEDED, Status.CANCELLED}) {
            Server server = ServerBuilder.forPort(0)
                    .addService(new STTServiceGrpc.STTServiceImplBase() {
                        @Override
                        public void transcribe(
                                com.ghatana.stt.core.grpc.proto.TranscribeRequest request,
                                StreamObserver<TranscribeResponse> observer) {
                            observer.onError(status.asRuntimeException());
                        }
                    }).build().start();
            try (GrpcSttClientAdapter adapter = GrpcSttClientAdapter.forLocalTesting(
                    "localhost", server.getPort(), GrpcSttClientAdapter.SttMode.GRPC)) {
                assertThatThrownBy(() -> adapter.transcribe(new byte[] {1}))
                        .isInstanceOf(io.grpc.StatusRuntimeException.class)
                        .satisfies(failure -> assertThat(((io.grpc.StatusRuntimeException) failure)
                                .getStatus().getCode()).isEqualTo(status.getCode()));
            } finally {
                server.shutdownNow();
            }
        }
    }
}
