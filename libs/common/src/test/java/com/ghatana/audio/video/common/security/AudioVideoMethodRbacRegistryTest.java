package com.ghatana.audio.video.common.security;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.HashSet;
import java.util.Locale;
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
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("com.ghatana.audio.video.stt.grpc.STTService/Transcribe", "av:user")).isTrue();
    }

    @Test
    @DisplayName("av:admin can transcribe")
    void adminCanTranscribe() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("com.ghatana.audio.video.stt.grpc.STTService/Transcribe", "av:admin")).isTrue();
    }

    @Test
    @DisplayName("av:readonly cannot transcribe")
    void readonlyCannotTranscribe() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("com.ghatana.audio.video.stt.grpc.STTService/Transcribe", "av:readonly")).isFalse();
    }

    @Test
    @DisplayName("av:user cannot load model")
    void userCannotLoadModel() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("com.ghatana.audio.video.stt.grpc.STTService/LoadModel", "av:user")).isFalse();
    }

    @Test
    @DisplayName("av:admin can load model")
    void adminCanLoadModel() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("com.ghatana.audio.video.stt.grpc.STTService/LoadModel", "av:admin")).isTrue();
    }

    @Test
    @DisplayName("health check is always exempt")
    void healthCheckIsExempt() {
        assertThat(AudioVideoMethodRbacRegistry.isExempt("/grpc.health.v1.Health/Check")).isTrue();
        assertThat(AudioVideoMethodRbacRegistry.isExempt("grpc.health.v1.Health/Check")).isTrue();
        assertThat(AudioVideoMethodRbacRegistry.isExempt("grpc.health.v1.Health/Watch")).isTrue();
        assertThat(AudioVideoMethodRbacRegistry.isExempt("evil.v1.AdminService/HealthCheck")).isFalse();
        assertThat(AudioVideoMethodRbacRegistry.isExempt("evil.v1.AdminService/GetStatus")).isFalse();
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("evil.v1.AdminService/GetStatus", "av:user")).isFalse();
    }

    @Test
    @DisplayName("isAllowedAny with multiple roles — at least one must match")
    void allowedAnyWithMultipleRoles() {
        Set<String> roles = Set.of("viewer", "av:user");
        assertThat(AudioVideoMethodRbacRegistry.isAllowedAny("com.ghatana.audio.video.stt.grpc.STTService/Transcribe", roles)).isTrue();
    }

    @Test
    @DisplayName("isAllowedAny with no matching roles returns false")
    void deniedAnyWithNoMatchingRoles() {
        Set<String> roles = Set.of("viewer", "readonly");
        assertThat(AudioVideoMethodRbacRegistry.isAllowedAny("com.ghatana.audio.video.stt.grpc.STTService/LoadModel", roles)).isFalse();
    }

    @Test
    @DisplayName("role matching is independent of the default locale")
    void roleMatchingIsIndependentOfDefaultLocale() {
        Locale originalLocale = Locale.getDefault();
        try {
            Locale.setDefault(Locale.forLanguageTag("tr-TR"));
            String method = "com.ghatana.audio.video.stt.grpc.STTService/Transcribe";
            assertThat(AudioVideoMethodRbacRegistry.isAllowed(method, "AV:USER")).isTrue();
            assertThat(AudioVideoMethodRbacRegistry.isAllowedAny(method, Set.of("AV:USER"))).isTrue();
        } finally {
            Locale.setDefault(originalLocale);
        }
    }

    @Test
    @DisplayName("isAllowedAny ignores null role members")
    void allowedAnyIgnoresNullRoleMembers() {
        String method = "com.ghatana.audio.video.stt.grpc.STTService/Transcribe";
        Set<String> roles = new HashSet<>();
        roles.add(null);
        assertThat(AudioVideoMethodRbacRegistry.isAllowedAny(method, roles)).isFalse();

        roles.add("av:user");
        assertThat(AudioVideoMethodRbacRegistry.isAllowedAny(method, roles)).isTrue();
    }

    @Test
    @DisplayName("null role returns false for protected method")
    void nullRoleReturnsFalse() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("com.ghatana.audio.video.stt.grpc.STTService/Transcribe", null)).isFalse();
    }

    @Test
    @DisplayName("unregistered methods are denied instead of defaulting to any authenticated role")
    void unregisteredMethodIsDenied() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("com.ghatana.audio.video.stt.grpc.STTService/DeleteAll", "av:admin")).isFalse();
        assertThat(AudioVideoMethodRbacRegistry.isAllowedAny("com.ghatana.audio.video.stt.grpc.STTService/DeleteAll",
                Set.of("av:user", "av:admin"))).isFalse();
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("evil.v1.AdminService/Transcribe", "av:user")).isFalse();
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("Transcribe", "av:user")).isFalse();
    }

    @Test
    @DisplayName("extractSimpleName strips service prefix")
    void extractSimpleName() {
        assertThat(AudioVideoMethodRbacRegistry.extractSimpleName("com.ghatana.audio.video.stt.grpc.STTService/Transcribe"))
            .isEqualTo("Transcribe");
        assertThat(AudioVideoMethodRbacRegistry.extractSimpleName("Transcribe"))
            .isEqualTo("Transcribe");
        assertThat(AudioVideoMethodRbacRegistry.extractSimpleName(null))
            .isEmpty();
    }

    @Test
    @DisplayName("TTS synthesize is allowed for av:user")
    void ttsSynthesizeAllowed() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("com.ghatana.audio.video.tts.grpc.TTSService/Synthesize", "av:user")).isTrue();
    }

    @Test
    @DisplayName("Vision analyze is allowed for av:user")
    void visionAnalyzeAllowed() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("com.ghatana.audio.video.vision.grpc.VisionService/AnalyzeImage", "av:user")).isTrue();
    }

    @Test
    @DisplayName("Multimodal process is allowed for av:user")
    void multimodalProcessAllowed() {
        assertThat(AudioVideoMethodRbacRegistry.isAllowed("com.ghatana.audio.video.multimodal.grpc.MultimodalService/ProcessMultimodal", "av:user")).isTrue();
    }
}
