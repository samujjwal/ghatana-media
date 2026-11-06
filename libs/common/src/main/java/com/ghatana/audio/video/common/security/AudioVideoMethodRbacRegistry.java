package com.ghatana.audio.video.common.security;

import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Method-level RBAC registry for audio-video gRPC services.
 *
 * <p>Maps fully-qualified gRPC method names to the set of roles that are permitted
 * to invoke them. Methods not explicitly registered are denied; health checks
 * are the only explicit exemptions.
 *
 * <p>Call {@link #requiresRole(String, String)} to check whether a caller with a
 * specific role is authorised for a given gRPC method.
 *
 * <p>Role names are case-insensitive in the check; they are normalised to lower-case
 * internally.
 *
 * @doc.type class
 * @doc.purpose RBAC method-to-role registry for audio-video gRPC services
 * @doc.layer product
 * @doc.pattern Configuration
 */
public final class AudioVideoMethodRbacRegistry {

    /**
     * Default RBAC policy for audio-video gRPC methods.
     *
     * <p>Keys are exact fully-qualified gRPC method names from the Media service
     * descriptors. Unknown services and methods are denied.
     *
     * <p>Existing policy grants are bound to exact operation names below. Operations
     * without an explicit source-backed grant remain denied.
     */
    private static final Map<String, Set<String>> METHOD_ROLES = Map.ofEntries(
        Map.entry("com.ghatana.audio.video.stt.grpc.STTService/Transcribe",
                Set.of("av:user", "av:admin")),
        Map.entry("com.ghatana.audio.video.stt.grpc.STTService/StreamTranscribe",
                Set.of("av:user", "av:admin")),
        Map.entry("com.ghatana.audio.video.stt.grpc.STTService/LoadModel", Set.of("av:admin")),
        Map.entry("com.ghatana.audio.video.stt.grpc.STTService/UnloadModel", Set.of("av:admin")),
        Map.entry("com.ghatana.audio.video.stt.grpc.STTService/AdaptModel", Set.of("av:admin")),
        Map.entry("com.ghatana.audio.video.stt.grpc.STTService/ListModels", Set.of("av:user", "av:admin")),
        Map.entry("com.ghatana.audio.video.stt.grpc.STTService/CreateProfile", Set.of("av:user", "av:admin")),
        Map.entry("com.ghatana.audio.video.stt.grpc.STTService/GetProfile", Set.of("av:user", "av:admin")),
        Map.entry("com.ghatana.audio.video.stt.grpc.STTService/UpdateProfile", Set.of("av:user", "av:admin")),
        Map.entry("com.ghatana.audio.video.stt.grpc.STTService/SubmitCorrection", Set.of("av:user", "av:admin")),
        Map.entry("com.ghatana.audio.video.tts.grpc.TTSService/Synthesize", Set.of("av:user", "av:admin")),
        Map.entry("com.ghatana.audio.video.tts.grpc.TTSService/StreamSynthesize",
                Set.of("av:user", "av:admin")),
        Map.entry("com.ghatana.audio.video.vision.grpc.VisionService/AnalyzeImage",
                Set.of("av:user", "av:admin")),
        Map.entry("com.ghatana.audio.video.vision.grpc.VisionService/DetectObjects",
                Set.of("av:user", "av:admin")),
        Map.entry("com.ghatana.audio.video.vision.grpc.VisionService/AnalyzeVideoFile",
                Set.of("av:user", "av:admin")),
        Map.entry("com.ghatana.audio.video.multimodal.grpc.MultimodalService/ProcessMultimodal",
                Set.of("av:user", "av:admin"))
    );

    /** Fully qualified standard gRPC health methods exempt from application RBAC. */
    private static final Set<String> EXEMPT_METHODS = Set.of(
        "/grpc.health.v1.Health/Check",
        "/grpc.health.v1.Health/Watch"
    );

    private AudioVideoMethodRbacRegistry() {}

    /**
     * Checks whether a caller with the given role is allowed to invoke {@code fullMethodName}.
     *
     * @param fullMethodName fully-qualified gRPC method from its service descriptor
     * @param role           caller's role from the verified signed-token snapshot
     * @return {@code true} if the role grants access
     */
    public static boolean isAllowed(String fullMethodName, String role) {
        if (isExempt(fullMethodName)) {
            return true;
        }
        Set<String> required = METHOD_ROLES.get(normalizeFullMethod(fullMethodName));
        if (required == null) return false;
        if (role == null || role.isBlank()) {
            return false;
        }
        return required.contains(role.toLowerCase(Locale.ROOT)) || required.contains(role);
    }

    /**
     * Checks whether a caller with ANY of the given roles is allowed to invoke the method.
     *
     * @param fullMethodName fully-qualified gRPC method
     * @param roles          set of roles from the caller's token
     * @return {@code true} if at least one role grants access
     */
    public static boolean isAllowedAny(String fullMethodName, Set<String> roles) {
        if (isExempt(fullMethodName)) {
            return true;
        }
        Set<String> required = METHOD_ROLES.get(normalizeFullMethod(fullMethodName));
        if (required == null) return false;
        if (roles == null || roles.isEmpty()) {
            return false;
        }
        return roles.stream()
                .filter(Objects::nonNull)
                .anyMatch(role -> required.contains(role) || required.contains(role.toLowerCase(Locale.ROOT)));
    }

    /**
     * Returns whether the method is exempt from RBAC (health endpoints).
     *
     * @param fullMethodName fully-qualified gRPC method
     * @return {@code true} if the method is exempt
     */
    public static boolean isExempt(String fullMethodName) {
        if (fullMethodName == null) return false;
        String fullMethodPath = fullMethodName.startsWith("/") ? fullMethodName : "/" + fullMethodName;
        return EXEMPT_METHODS.contains(fullMethodPath);
    }

    /**
     * Extracts the simple method name from a fully-qualified gRPC method name.
     * This is diagnostic only; authorization uses exact service/method names.
     *
     * @param fullMethodName fully-qualified name
     * @return simple method name after the last {@code /}
     */
    static String extractSimpleName(String fullMethodName) {
        if (fullMethodName == null) {
            return "";
        }
        int slash = fullMethodName.lastIndexOf('/');
        return slash >= 0 ? fullMethodName.substring(slash + 1) : fullMethodName;
    }

    private static String normalizeFullMethod(String fullMethodName) {
        if (fullMethodName == null) return "";
        return fullMethodName.startsWith("/") ? fullMethodName.substring(1) : fullMethodName;
    }
}
