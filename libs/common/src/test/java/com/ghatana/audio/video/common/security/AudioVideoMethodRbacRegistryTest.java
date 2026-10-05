package com.ghatana.audio.video.common.security;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Unit tests for {@link AudioVideoMethodRbacRegistry}.
 *
 * @doc.type class
 * @doc.purpose Unit tests for the audio-video gRPC RBAC method registry
 * @doc.layer product
 * @doc.pattern TestCase
 */
@DisplayName("AudioVideoMethodRbacRegistry")
class AudioVideoMethodRbacRegistryTest {

    @Test
    @DisplayName("av:user can transcribe")
    void userCanTranscribe() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("stt.v1.STTService/Transcribe", "av:user")).isTrue();
    }

    @Test
    @DisplayName("av:admin can transcribe")
    void adminCanTranscribe() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("stt.v1.STTService/Transcribe", "av:admin")).isTrue();
    }

    @Test
    @DisplayName("av:readonly cannot transcribe")
    void readonlyCannotTranscribe() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("stt.v1.STTService/Transcribe", "av:readonly")).isFalse();
    }

    @Test
    @DisplayName("av:user cannot load model")
    void userCannotLoadModel() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("stt.v1.STTService/LoadModel", "av:user")).isFalse();
    }

    @Test
    @DisplayName("av:admin can load model")
    void adminCanLoadModel() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("stt.v1.STTService/LoadModel", "av:admin")).isTrue();
    }

    @Test
    @DisplayName("health check is always exempt")
    void healthCheckIsExempt() {
        assertThat(AudioVideoMethodRbacRegistry.isExempt("/grpc.health.v1.Health/Check")).isTrue();
        assertThat(AudioVideoMethodRbacRegistry.isExempt("HealthCheck")).isTrue();
        assertThat(AudioVideoMethodRbacRegistry.isExempt("healthCheck")).isTrue();
    }

    @Test
    @DisplayName("isAllowedAny with multiple roles — at least one must match")
    void allowedAnyWithMultipleRoles() {
        Set<String> roles = Set.of("viewer", "av:user");
        assertThat(AudioVideoMethodRbacRegistry.isAllowedAny("stt.v1.STTService/Transcribe", roles)).isTrue();
    }

    @Test
    @DisplayName("isAllowedAny with no matching roles returns false")
    void deniedAnyWithNoMatchingRoles() {
        Set<String> roles = Set.of("viewer", "readonly");
        assertThat(AudioVideoMethodRbacRegistry.isAllowedAny("stt.v1.STTService/LoadModel", roles)).isFalse();
    }

    @Test
    @DisplayName("null role returns false for protected method")
    void nullRoleReturnsFalse() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("stt.v1.STTService/Transcribe", null)).isFalse();
    }

    @Test
    @DisplayName("extractSimpleName strips service prefix")
    void extractSimpleName() {
        assertThat(AudioVideoMethodRbacRegistry.extractSimpleName("stt.v1.STTService/Transcribe"))
            .isEqualTo("Transcribe");
        assertThat(AudioVideoMethodRbacRegistry.extractSimpleName("Transcribe"))
            .isEqualTo("Transcribe");
        assertThat(AudioVideoMethodRbacRegistry.extractSimpleName(null))
            .isEmpty();
    }

    @Test
    @DisplayName("TTS synthesize is allowed for av:user")
    void ttsSynthesizeAllowed() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("tts.v1.TTSService/Synthesize", "av:user")).isTrue();
    }

    @Test
    @DisplayName("Vision analyze is allowed for av:user")
    void visionAnalyzeAllowed() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("vision.v1.VisionService/Analyze", "av:user")).isTrue();
    }

    @Test
    @DisplayName("Multimodal process is allowed for av:user")
    void multimodalProcessAllowed() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("mm.v1.MultimodalService/Process", "av:user")).isTrue();
    }
}
