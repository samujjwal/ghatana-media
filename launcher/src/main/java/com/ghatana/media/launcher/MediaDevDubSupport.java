package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentContracts;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Shared plumbing of the DEV_ONLY translation and dubbing lanes: exact artifact-version resolution, the PROCESSING
 * rights check over the whole derivation chain (the input version, its source transcript and the original source), idempotent
 * registration of outputs as new immutable artifacts, and reading registered outputs back for replay and readback.
 *
 * <p>Rights are never self-approved here: every artifact in the chain must carry a current ADMITTED
 * {@code Scope.PROCESSING} decision from the configured {@link RightsConsentResolver}; an unconfigured authority is
 * RIGHTS_AUTHORITY_UNAVAILABLE and nothing is read beyond the metadata needed to name the chain.</p>
 */
final class MediaDevDubSupport {
    static final ObjectMapper JSON = JsonMapper.builder().build();
    static final int MAX_DOCUMENT_BYTES = 2 * 1024 * 1024;
    private static final int MAX_CHAIN = 6;

    /** One registered output: the artifact, its lineage and whether this call replayed an earlier registration. */
    record Output(MediaArtifact artifact, Map<String, Object> lineage, boolean replayed) { }

    /** The rights decision over a derivation chain: the evidence reference and the exact artifact versions checked. */
    record Rights(String evidenceRef, List<Map<String, Object>> subjects) { }

    private final MediaRuntime runtime;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;
    private final RightsConsentResolver resolver;

    MediaDevDubSupport(MediaRuntime runtime, MediaDevProjectRenderRuntime.OutputRegistrar registrar,
                       RightsConsentResolver resolver) {
        this.runtime = java.util.Objects.requireNonNull(runtime, "runtime");
        this.registrar = java.util.Objects.requireNonNull(registrar, "registrar");
        this.resolver = resolver == null ? RightsConsentResolver.unavailable() : resolver;
    }

    MediaArtifact exact(String tenantId, String principalId, String artifactId, String versionId) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(found -> found.version().value().equals(versionId))
                .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
    }

    byte[] read(String tenantId, String principalId, MediaArtifact artifact) {
        if (artifact.sizeBytes() > MAX_DOCUMENT_BYTES) {
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "SPEECH_LIMIT_EXCEEDED",
                    "the artifact exceeds the document byte ceiling");
        }
        ByteArrayOutputStream content = new ByteArrayOutputStream((int) artifact.sizeBytes());
        try {
            runtime.copyArtifactContent(tenantId, principalId, artifact.artifactId(), artifact.version(), content,
                    MAX_DOCUMENT_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        } catch (IOException unreadable) {
            throw new IllegalStateException("artifact content could not be read", unreadable);
        }
        return content.toByteArray();
    }

    JsonNode readDocument(String tenantId, String principalId, MediaArtifact artifact) {
        try {
            return JSON.readTree(read(tenantId, principalId, artifact));
        } catch (RuntimeException malformed) {
            if (malformed instanceof MediaDevSpeechRuntime.SpeechRefusedException refused) throw refused;
            if (malformed instanceof MediaDevProjectRenderRuntime.SourceVersionUnavailableException missing) throw missing;
            throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "SOURCE_DOCUMENT_INVALID",
                    "the artifact version is not a readable JSON document");
        }
    }

    // ---- rights ----

    /**
     * Requires an ADMITTED PROCESSING decision for the root source of {@code start} (the artifact that names no further
     * {@code source}, {@code sourceTranscript} or {@code parent} in its lineage), following the lineage transitively (at
     * most {@value #MAX_CHAIN} hops). A derived artifact needs no statement of its own, but any explicit decision on it or on
     * an intermediate version that is not ADMITTED refuses the request. A revoked original source therefore refuses every
     * derivative step, a replay included.
     */
    Rights requireProcessing(String tenantId, String principalId, MediaArtifact start) {
        List<Map<String, Object>> subjects = new ArrayList<>();
        List<String> attestations = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        List<MediaArtifact> queue = new ArrayList<>(List.of(start));
        List<String> roles = new ArrayList<>(List.of("input"));
        for (int hop = 0; hop < queue.size() && hop < MAX_CHAIN; hop++) {
            MediaArtifact artifact = queue.get(hop);
            if (!seen.add(artifact.artifactId() + "@" + artifact.version().value())) continue;
            // The artifacts this one was derived from (an unknown one is a missing source version, never skipped).
            List<MediaArtifact> parents = new ArrayList<>();
            List<String> parentRoles = new ArrayList<>();
            for (String key : List.of("sourceTranscript", "source", "parent")) {
                Object ref = artifact.metadata().get(key);
                if (ref instanceof Map<?, ?> map && map.get("artifactId") instanceof String id
                        && map.get("artifactVersionId") instanceof String version) {
                    parents.add(exact(tenantId, principalId, id, version));
                    parentRoles.add(key);
                }
            }
            boolean root = parents.isEmpty();
            Resolution resolution;
            try {
                resolution = resolver.resolve(new MediaRightsConsentContracts.ResolutionRequest(tenantId,
                        artifact.artifactId(), artifact.version().value(), artifact.sha256(),
                        MediaRightsConsentContracts.Scope.PROCESSING));
            } catch (RuntimeException unavailable) {
                resolution = null;
            }
            Map<String, Object> subject = new LinkedHashMap<>();
            subject.put("subject", roles.get(hop));
            subject.put("artifactId", artifact.artifactId());
            subject.put("artifactVersionId", artifact.version().value());
            // The DEV rights authority answers DENIED (not UNAVAILABLE) for an artifact that has no statement at all, so for
            // a derivative DENIED means "no statement of its own"; its rights come from its root source.
            boolean noStatement = resolution == null
                    || resolution.verdict() == MediaRightsConsentContracts.Verdict.UNAVAILABLE
                    || (!root && resolution.verdict() == MediaRightsConsentContracts.Verdict.DENIED);
            if (noStatement && root) {
                // The root source carries the rights statement; without it nothing derived from it is admitted.
                throw new MediaDevSpeechRuntime.SpeechRefusedException(422, "RIGHTS_AUTHORITY_UNAVAILABLE",
                        "source rights and consent cannot be established without a rights statement for the source",
                        Map.of("subject", subject, "scope", "PROCESSING"));
            }
            if (!noStatement) {
                if (resolution.verdict() != MediaRightsConsentContracts.Verdict.ADMITTED) {
                    throw new MediaDevSpeechRuntime.SpeechRefusedException(403,
                            "RIGHTS_DECISION_" + resolution.verdict().name(),
                            "source rights and consent do not admit this processing request",
                            Map.of("subject", subject, "scope", "PROCESSING"));
                }
                attestations.addAll(resolution.attestationIds());
                subjects.add(subject);
            }
            // A derivative needs no statement of its own (its rights come from its source), but an explicit decision
            // on it that is not ADMITTED (for example a revocation) is honoured above.
            queue.addAll(parents);
            roles.addAll(parentRoles);
        }
        return new Rights("rights-attestation:" + String.join(",", attestations), List.copyOf(subjects));
    }

    // ---- registration and readback ----

    Output register(String tenantId, String principalId, String classification, String lane, String requestId,
                    byte[] bytes, String contentType, String extension, String namePrefix, String purpose,
                    Map<String, Object> lineage) {
        String sha256 = MediaDevProjectRenderRuntime.sha256Hex(bytes);
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", purpose);
        UploadRequest upload = new UploadRequest(tenantId, principalId, namePrefix + "." + extension, contentType,
                bytes.length, sha256, classification, Duration.ofDays(30), metadata);
        String idempotencyKey = "dev-dub:" + lane + ":" + MediaDevProjectRenderRuntime.sha256Hex(
                (tenantId + "\u0000" + principalId + "\u0000" + requestId).getBytes(StandardCharsets.UTF_8));
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new MediaDevSpeechRuntime.SpeechRequestReusedException(conflict);
            }
            throw new MediaDevSpeechRuntime.SpeechRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new MediaDevSpeechRuntime.SpeechRegistrationFailedException(failure);
        }
        MediaArtifact artifact = registered.artifact();
        if (!artifact.sha256().equals(sha256)) {
            throw new MediaDevSpeechRuntime.SpeechRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match produced bytes"));
        }
        return new Output(artifact, lineage, registered.replayed());
    }

    /** Reopens a registered output of the given schema for its owner; anything else is absent. */
    Optional<Output> reopen(String tenantId, String principalId, String artifactId, String schemaKey,
                            String schema, List<String> lineageKeys) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(artifact -> schema.equals(artifact.metadata().get(schemaKey)))
                .map(artifact -> {
                    Map<String, Object> lineage = new LinkedHashMap<>();
                    for (String key : lineageKeys) {
                        if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
                    }
                    return new Output(artifact, lineage, true);
                });
    }

    static Map<String, Object> ref(MediaArtifact artifact) {
        Map<String, Object> ref = new LinkedHashMap<>();
        ref.put("artifactId", artifact.artifactId());
        ref.put("artifactVersionId", artifact.version().value());
        ref.put("sha256", artifact.sha256());
        return ref;
    }

    static Map<String, Object> outputView(Output output) {
        MediaArtifact artifact = output.artifact();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("outputId", artifact.artifactId());
        view.put("artifact", Map.of(
                "artifactId", artifact.artifactId(),
                "artifactVersionId", artifact.version().value(),
                "contentType", artifact.contentType(),
                "sizeBytes", artifact.sizeBytes(),
                "sha256", artifact.sha256(),
                "artifactPath", "/api/v1/artifacts/" + artifact.artifactId()));
        view.put("lineage", output.lineage());
        view.put("replayed", output.replayed());
        return view;
    }

    static byte[] json(Object value) {
        try {
            return JSON.writeValueAsBytes(value);
        } catch (RuntimeException failure) {
            throw new MediaDevSpeechRuntime.SpeechRegistrationFailedException(failure);
        }
    }

    static String safeName(String value) {
        String safe = value.replaceAll("[^A-Za-z0-9._-]", "_");
        return safe.length() > 64 ? safe.substring(0, 64) : safe;
    }

    static String boundedId(String value, String name) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException(name + " must be a 1-128 character opaque id");
        }
        return value;
    }
}
