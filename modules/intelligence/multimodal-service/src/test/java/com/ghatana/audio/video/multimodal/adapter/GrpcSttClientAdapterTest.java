/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.multimodal.adapter;

import com.ghatana.audio.video.multimodal.engine.AudioResult;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

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
            assertThat(result.getConfidence()).isEqualTo(0.0);
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
}
