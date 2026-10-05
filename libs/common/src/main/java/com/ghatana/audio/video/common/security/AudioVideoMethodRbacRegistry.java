package com.ghatana.audio.video.common.security;

import java.util.Map;
import java.util.Set;

/**
 * Method-level RBAC registry for audio-video gRPC services.
 *
 * <p>Maps fully-qualified gRPC method names to the set of roles that are permitted
 * to invoke them. An empty required-roles set means the method is open to all
 * authenticated callers (any role, but still requires a valid JWT).
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
     * <p>Keys are gRPC method simple names (the part after the last {@code /}).
     * The convention is to match on method name only, not service prefix, so the
     * same registry covers STT, TTS, Vision, and Multimodal services consistently.
     * An empty set means any authenticated role may call the method.
     *
     * <ul>
     *   <li>{@code transcribe}, {@code Transcribe}, {@code synthesize}, {@code Synthesize},
     *       {@code analyze}, {@code process} — require at minimum {@code av:user}</li>
     *   <li>{@code loadModel}, {@code unloadModel}, {@code adaptModel} — require {@code av:admin}</li>
     *   <li>{@code healthCheck}, {@code getStatus} — open (any authenticated user)</li>
     * </ul>
     */
    private static final Map<String, Set<String>> METHOD_ROLES = Map.ofEntries(
        // STT
        Map.entry("Transcribe",       Set.of("av:user", "av:admin")),
        Map.entry("transcribe",       Set.of("av:user", "av:admin")),
        Map.entry("StreamTranscribe", Set.of("av:user", "av:admin")),
        Map.entry("streamTranscribe", Set.of("av:user", "av:admin")),
        Map.entry("LoadModel",        Set.of("av:admin")),
        Map.entry("loadModel",        Set.of("av:admin")),
        Map.entry("UnloadModel",      Set.of("av:admin")),
        Map.entry("unloadModel",      Set.of("av:admin")),
        Map.entry("AdaptModel",       Set.of("av:admin")),
        Map.entry("adaptModel",       Set.of("av:admin")),
        Map.entry("ListModels",       Set.of("av:user", "av:admin")),
        Map.entry("listModels",       Set.of("av:user", "av:admin")),
        Map.entry("CreateProfile",    Set.of("av:user", "av:admin")),
        Map.entry("createProfile",    Set.of("av:user", "av:admin")),
        Map.entry("GetProfile",       Set.of("av:user", "av:admin")),
        Map.entry("getProfile",       Set.of("av:user", "av:admin")),
        Map.entry("UpdateProfile",    Set.of("av:user", "av:admin")),
        Map.entry("updateProfile",    Set.of("av:user", "av:admin")),
        Map.entry("SubmitCorrection", Set.of("av:user", "av:admin")),
        Map.entry("submitCorrection", Set.of("av:user", "av:admin")),
        // TTS
        Map.entry("Synthesize",       Set.of("av:user", "av:admin")),
        Map.entry("synthesize",       Set.of("av:user", "av:admin")),
        Map.entry("StreamSynthesize", Set.of("av:user", "av:admin")),
        Map.entry("streamSynthesize", Set.of("av:user", "av:admin")),
        // Vision
        Map.entry("Analyze",          Set.of("av:user", "av:admin")),
        Map.entry("analyze",          Set.of("av:user", "av:admin")),
        Map.entry("AnalyzeVideo",     Set.of("av:user", "av:admin")),
        Map.entry("analyzeVideo",     Set.of("av:user", "av:admin")),
        // Multimodal
        Map.entry("Process",          Set.of("av:user", "av:admin")),
        Map.entry("process",          Set.of("av:user", "av:admin"))
    );

    /** Methods exempt from role check — health checks are open. */
    private static final Set<String> EXEMPT_METHODS = Set.of(
        "/grpc.health.v1.Health/Check",
        "/grpc.health.v1.Health/Watch",
        "GetStatus",
        "getStatus",
        "HealthCheck",
        "healthCheck"
    );

    private AudioVideoMethodRbacRegistry() {}

    /**
     * Checks whether a caller with the given role is allowed to invoke {@code fullMethodName}.
     *
     * @param fullMethodName fully-qualified gRPC method (e.g. {@code stt.v1.STTService/Transcribe})
     * @param role           caller's role (from JWT or metadata)
     * @return {@code true} if the role grants access
     */
    public static boolean isAllowed(String fullMethodName, String role) {
        if (isExempt(fullMethodName)) {
            return true;
        }
        String methodSimple = extractSimpleName(fullMethodName);
        Set<String> required = METHOD_ROLES.getOrDefault(methodSimple, Set.of());
        if (required.isEmpty()) {
            // Open to any authenticated caller
            return true;
        }
        if (role == null || role.isBlank()) {
            return false;
        }
        return required.contains(role.toLowerCase()) || required.contains(role);
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
        String methodSimple = extractSimpleName(fullMethodName);
        Set<String> required = METHOD_ROLES.getOrDefault(methodSimple, Set.of());
        if (required.isEmpty()) {
            return true;
        }
        if (roles == null || roles.isEmpty()) {
            return false;
        }
        return roles.stream().anyMatch(r -> required.contains(r) || required.contains(r.toLowerCase()));
    }

    /**
     * Returns whether the method is exempt from RBAC (health endpoints).
     *
     * @param fullMethodName fully-qualified gRPC method
     * @return {@code true} if the method is exempt
     */
    public static boolean isExempt(String fullMethodName) {
        if (EXEMPT_METHODS.contains(fullMethodName)) {
            return true;
        }
        String simple = extractSimpleName(fullMethodName);
        return EXEMPT_METHODS.contains(simple);
    }

    /**
     * Extracts the simple method name from a fully-qualified gRPC method name.
     * E.g. {@code "stt.v1.STTService/Transcribe"} → {@code "Transcribe"}.
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
}
