package com.ghatana.media.runtime;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertDoesNotThrow;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Arrays;
import java.util.List;
import java.util.TreeSet;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

/**
 * Cross-language domain-contract oracle: every golden vector in
 * {@code contracts/domain-parity/v1/golden-vectors.v1.json} carries a
 * per-language expected verdict so genuine divergences are recorded
 * truthfully instead of passing silently.
 */
class MediaDomainParityGoldenVectorTest {

    private static final ObjectMapper JSON = new ObjectMapper();

    private static JsonNode vectors() throws Exception {
        for (Path candidate : List.of(
                Path.of("contracts", "domain-parity", "v1", "golden-vectors.v1.json"),
                Path.of("..", "contracts", "domain-parity", "v1", "golden-vectors.v1.json"))) {
            if (Files.exists(candidate)) {
                return JSON.readTree(Files.readString(candidate));
            }
        }
        throw new IllegalStateException("golden vector file not found relative to " + Path.of("").toAbsolutePath());
    }

    @Test
    void canonicalJobStatesMatchTypeScriptVocabularyExactly() throws Exception {
        JsonNode group = vectors().path("sharedEnums").path("canonicalJobStates");
        List<String> javaStates = Arrays.stream(MediaLifecycleProjection.LogicalJobStatus.values()).map(Enum::name).toList();
        List<String> expected = new java.util.ArrayList<>();
        group.path("accept").forEach(node -> expected.add(node.asText()));
        assertEquals(new TreeSet<>(expected), new TreeSet<>(javaStates),
            "LogicalJobStatus must equal the canonical PDP-1 job vocabulary shared with TypeScript");
        for (JsonNode state : group.path("reject")) {
            assertThrows(IllegalArgumentException.class,
                () -> MediaLifecycleProjection.LogicalJobStatus.valueOf(state.asText()),
                "rejected job state " + state.asText());
        }
    }

    @Test
    void canonicalAttemptStatesMatchTypeScriptVocabularyExactly() throws Exception {
        JsonNode group = vectors().path("sharedEnums").path("canonicalAttemptStates");
        List<String> javaStates = Arrays.stream(MediaLifecycleProjection.LogicalAttemptStatus.values()).map(Enum::name).toList();
        List<String> expected = new java.util.ArrayList<>();
        group.path("accept").forEach(node -> expected.add(node.asText()));
        assertEquals(new TreeSet<>(expected), new TreeSet<>(javaStates),
            "LogicalAttemptStatus must equal the canonical PDP-1 attempt vocabulary shared with TypeScript");
        for (JsonNode state : group.path("reject")) {
            assertThrows(IllegalArgumentException.class,
                () -> MediaLifecycleProjection.LogicalAttemptStatus.valueOf(state.asText()),
                "rejected attempt state " + state.asText());
        }
    }

    @Test
    void identifierVectorsEnforceDocumentedPerSideVerdicts() throws Exception {
        for (JsonNode vector : vectors().path("scalarVectors").path("identifiers")) {
            String value = vector.has("value")
                ? vector.get("value").asText()
                : vector.get("repeatChar").asText().repeat(vector.get("repeatCount").asInt());
            boolean accepts = "accept".equals(vector.path("java").asText());
            // MediaCreationContracts.SourceVersion validates artifactId with required() — a pure
            // non-blank identifier probe sharing the documented Java verdict.
            Runnable probe = () -> new MediaCreationContracts.SourceVersion(value,
                "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
            if (accepts) {
                assertDoesNotThrow(probe::run, "identifier vector " + vector);
            } else {
                assertThrows(IllegalArgumentException.class, probe::run, "identifier vector " + vector);
            }
        }
    }

    @Test
    void sha256VectorsEnforceDocumentedPerSideVerdicts() throws Exception {
        for (JsonNode vector : vectors().path("scalarVectors").path("checksumSha256Hex")) {
            String value = vector.get("value").asText();
            boolean accepts = "accept".equals(vector.path("java").asText());
            Runnable probe = () -> MediaRuntimeContracts.ArtifactVersion.fromSha256(value);
            if (accepts) {
                assertDoesNotThrow(probe::run, "sha256 vector " + vector);
            } else {
                assertThrows(IllegalArgumentException.class, probe::run, "sha256 vector " + vector);
            }
        }
    }

    @Test
    void rationalTemporalVectorsEnforceDocumentedPerSideVerdicts() throws Exception {
        for (JsonNode vector : vectors().path("scalarVectors").path("rationalTemporal")) {
            long numerator = vector.get("numerator").asLong();
            long denominator = vector.get("denominator").asLong();
            boolean accepts = "accept".equals(vector.path("java").asText());
            Runnable probe = () -> new MediaTimebase(numerator, denominator);
            if (accepts) {
                assertDoesNotThrow(probe::run, "rational vector " + vector);
            } else {
                assertThrows(IllegalArgumentException.class, probe::run, "rational vector " + vector);
            }
        }
    }

    @Test
    void vocabularyComparisonsMatchDocumentedDivergentSets() throws Exception {
        JsonNode upload = vectors().path("vocabularyComparisons").path("uploadSessionStates");
        List<String> javaUpload = new java.util.ArrayList<>();
        upload.path("java").forEach(node -> javaUpload.add(node.asText()));
        assertEquals(new TreeSet<>(javaUpload),
            new TreeSet<>(Arrays.stream(MediaRuntimeContracts.UploadStatus.values()).map(Enum::name).toList()),
            "Java upload vocabulary must equal the recorded divergence, not drift silently");
        JsonNode stream = vectors().path("vocabularyComparisons").path("streamStates");
        List<String> javaStream = new java.util.ArrayList<>();
        stream.path("java").forEach(node -> javaStream.add(node.asText()));
        assertEquals(new TreeSet<>(javaStream),
            new TreeSet<>(Arrays.stream(MediaRuntimeContracts.StreamState.values()).map(Enum::name).toList()));
    }

    @Test
    void canonicalRuntimeStateProjectionsMatchTheSourceEnums() throws Exception {
        JsonNode runtime = vectors().path("runtimeProjectionContracts");
        java.util.Set<String> upload = new TreeSet<>();
        runtime.path("uploadStatus").path("java").forEach(v -> upload.add(v.asText()));
        assertEquals(upload, new TreeSet<>(Arrays.stream(MediaRuntimeContracts.UploadStatus.values())
            .map(Enum::name).toList()));
        java.util.Set<String> stream = new TreeSet<>();
        runtime.path("streamState").path("java").forEach(v -> stream.add(v.asText()));
        assertEquals(stream, new TreeSet<>(Arrays.stream(MediaRuntimeContracts.StreamState.values())
            .map(Enum::name).toList()));
    }

    @Test
    void everyDeclaredDivergenceStillDescribesCurrentJavaBehavior() throws Exception {
        for (JsonNode divergence : vectors().path("knownDivergences")) {
            String id = divergence.get("id").asText();
            switch (id) {
                case "DP-IDENT-MAXLENGTH" -> {
                    // Java required() has no 256 ceiling; the divergence record must stay honest.
                    String longId = "x".repeat(257);
                    assertDoesNotThrow(() -> new MediaCreationContracts.SourceVersion(longId,
                        "sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"), id);
                }
                case "DP-TIME-NUMERATOR-ZERO" ->
                    assertThrows(IllegalArgumentException.class, () -> new MediaTimebase(0, 1), id);
                case "DP-BYTES-SAFE-INT" ->
                    assertTrue(Long.MAX_VALUE > 9_007_199_254_740_991L, id);
                case "DP-SHA256-CASE" ->
                    assertDoesNotThrow(() -> MediaRuntimeContracts.ArtifactVersion.fromSha256(
                        "0123456789ABCDEF0123456789abcdef0123456789abcdef0123456789abcdef"), id);
                case "DP-UPLOAD-STATES" ->
                    assertEquals(5, MediaRuntimeContracts.UploadStatus.values().length, id);
                case "DP-STREAM-STATES" ->
                    assertEquals(6, MediaRuntimeContracts.StreamState.values().length, id);
                default -> throw new IllegalStateException("divergence " + id + " has no live Java oracle");
            }
        }
    }
}
