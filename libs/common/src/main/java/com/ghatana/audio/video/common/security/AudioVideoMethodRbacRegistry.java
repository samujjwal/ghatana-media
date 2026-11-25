package com.ghatana.audio.video.common.security;

import java.util.HashSet;
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

    /** A method's disposition in the application-role registry, before domain checks. */
    enum MethodDisposition {
        /** An exact role grant exists; verified identity and domain authorization are still required. */
        ROLE_GRANT,
        /** The method is known but remains denied while method-specific owner policy is unresolved. */
        EXPLICIT_DENY,
        /** No source method disposition exists; callers must fail closed. */
        UNMAPPED,
        /** Exact standard gRPC health methods are outside application method RBAC. */
        STANDARD_HEALTH_EXEMPT
    }

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

    /**
     * Current application RPCs with no approved application-role grant. These remain denied
     * until their exact method policy is source-bound; listing them does not authorize access.
     */
    private static final Set<String> EXPLICIT_DENIED_METHODS = Set.of(
        "com.ghatana.audio.video.stt.grpc.STTService/GetStatus",
        "com.ghatana.audio.video.stt.grpc.STTService/HealthCheck",
        "com.ghatana.audio.video.tts.grpc.TTSService/GetStatus",
        "com.ghatana.audio.video.tts.grpc.TTSService/GetMetrics",
        "com.ghatana.audio.video.tts.grpc.TTSService/GetVoices",
        "com.ghatana.audio.video.tts.grpc.TTSService/LoadVoice",
        "com.ghatana.audio.video.tts.grpc.TTSService/CreateProfile",
        "com.ghatana.audio.video.tts.grpc.TTSService/GetProfile",
        "com.ghatana.audio.video.tts.grpc.TTSService/UpdateProfile",
        "com.ghatana.audio.video.tts.grpc.TTSService/CloneVoice",
        "com.ghatana.audio.video.tts.grpc.TTSService/SubmitFeedback",
        "com.ghatana.audio.video.vision.grpc.VisionService/ClassifyImage",
        "com.ghatana.audio.video.vision.grpc.VisionService/RecognizeSceneText",
        "com.ghatana.audio.video.vision.grpc.VisionService/ResolveSourceFrame",
        "com.ghatana.audio.video.vision.grpc.VisionService/ProcessVideo",
        "com.ghatana.audio.video.vision.grpc.VisionService/LoadModel",
        "com.ghatana.audio.video.vision.grpc.VisionService/UnloadModel",
        "com.ghatana.audio.video.vision.grpc.VisionService/ListModels",
        "com.ghatana.audio.video.vision.grpc.VisionService/GetStatus",
        "com.ghatana.audio.video.vision.grpc.VisionService/HealthCheck",
        "com.ghatana.audio.video.multimodal.grpc.MultimodalService/AnalyzeVideoWithAudio",
        "com.ghatana.audio.video.multimodal.grpc.MultimodalService/GenerateDescription",
        "com.ghatana.audio.video.multimodal.grpc.MultimodalService/AnalyzeCrossModal",
        "com.ghatana.audio.video.multimodal.grpc.MultimodalService/GetInsights",
        "com.ghatana.audio.video.multimodal.grpc.MultimodalService/LoadModel",
        "com.ghatana.audio.video.multimodal.grpc.MultimodalService/UnloadModel",
        "com.ghatana.audio.video.multimodal.grpc.MultimodalService/ListModels",
        "com.ghatana.audio.video.multimodal.grpc.MultimodalService/GetStatus",
        "com.ghatana.audio.video.multimodal.grpc.MultimodalService/HealthCheck"
    );

    private static final Set<String> EXPLICITLY_DISPOSITIONED_METHODS;

    static {
        Set<String> overlap = new HashSet<>(METHOD_ROLES.keySet());
        overlap.retainAll(EXPLICIT_DENIED_METHODS);
        if (!overlap.isEmpty()) {
            throw new ExceptionInInitializerError("gRPC methods have both grant and deny dispositions");
        }
        Set<String> methods = new HashSet<>(METHOD_ROLES.keySet());
        methods.addAll(EXPLICIT_DENIED_METHODS);
        EXPLICITLY_DISPOSITIONED_METHODS = Set.copyOf(methods);
    }

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
        MethodDisposition disposition = methodDisposition(fullMethodName);
        if (disposition == MethodDisposition.STANDARD_HEALTH_EXEMPT) {
            return true;
        }
        if (disposition != MethodDisposition.ROLE_GRANT) return false;
        Set<String> required = METHOD_ROLES.get(normalizeFullMethod(fullMethodName));
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
        MethodDisposition disposition = methodDisposition(fullMethodName);
        if (disposition == MethodDisposition.STANDARD_HEALTH_EXEMPT) {
            return true;
        }
        if (disposition != MethodDisposition.ROLE_GRANT) return false;
        Set<String> required = METHOD_ROLES.get(normalizeFullMethod(fullMethodName));
        if (roles == null || roles.isEmpty()) {
            return false;
        }
        return roles.stream()
                .filter(Objects::nonNull)
                .anyMatch(role -> required.contains(role) || required.contains(role.toLowerCase(Locale.ROOT)));
    }

    /**
     * Returns the exact registry disposition without granting access. A configured role grant
     * still requires verified transport identity and the service's domain-specific checks.
     */
    static MethodDisposition methodDisposition(String fullMethodName) {
        if (isExempt(fullMethodName)) return MethodDisposition.STANDARD_HEALTH_EXEMPT;
        String method = normalizeFullMethod(fullMethodName);
        if (METHOD_ROLES.containsKey(method)) return MethodDisposition.ROLE_GRANT;
        if (EXPLICIT_DENIED_METHODS.contains(method)) return MethodDisposition.EXPLICIT_DENY;
        return MethodDisposition.UNMAPPED;
    }

    /**
     * Returns the immutable exact application RPC identities with an explicit role grant or
     * deny disposition. Standard gRPC health exemptions and future unmapped methods are excluded.
     */
    static Set<String> explicitlyDispositionedMethods() {
        return EXPLICITLY_DISPOSITIONED_METHODS;
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
