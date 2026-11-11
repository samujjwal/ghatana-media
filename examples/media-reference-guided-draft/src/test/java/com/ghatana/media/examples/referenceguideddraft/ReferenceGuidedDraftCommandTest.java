package com.ghatana.media.examples.referenceguideddraft;

import com.ghatana.media.production.timeline.ReferenceGuidedScenePlanner;
import com.ghatana.media.production.timeline.ReferenceGuidedScenePlanner.Decision;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ArrayNode;
import tools.jackson.databind.node.ObjectNode;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertFalse;
import static org.junit.jupiter.api.Assertions.assertNotEquals;
import static org.junit.jupiter.api.Assertions.assertThrows;
import static org.junit.jupiter.api.Assertions.assertTrue;

class ReferenceGuidedDraftCommandTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PURPOSE = "source-conditioned-scene";

    @Test
    void bundledRequestProducesStableCandidateWithSortedExactSyntheticProvenanceAndNoEffects() throws Exception {
        String input = exampleRequest();
        String first = ReferenceGuidedDraftCommand.render(input);
        String second = ReferenceGuidedDraftCommand.render(input);

        assertEquals(first, second);
        assertEquals(exampleResult().stripTrailing(), first, "serialized example output must remain byte-stable");
        JsonNode output = JSON.readTree(first);
        assertEquals("LOCAL_REFERENCE_GUIDED_SCENE_CANDIDATE", output.path("kind").asString());
        assertEquals("AUTHORED_TEMPLATE_CANDIDATE", output.path("preparation").asString());
        assertEquals("A quiet harbor at dawn, authored for this local fixture.", output.path("authoredPrompt").asString());
        assertEquals("Open on a calm harbor; hold the blue sail in frame.", output.path("template").path("authoredScene").asString());
        assertTrue(output.path("deterministicSeed").asString().matches("[0-9a-f]{64}"));
        assertEquals("authored-prompt-01", output.path("provenance").get(0).path("artifactId").asString());
        assertEquals("authored-template-01", output.path("provenance").get(1).path("artifactId").asString());
        assertEquals("prior-continuity-01", output.path("provenance").get(2).path("artifactId").asString());
        assertEquals("synthetic-reference-video-01", output.path("provenance").get(3).path("artifactId").asString());
        assertEquals("fixture-v1", output.path("provenance").get(3).path("artifactVersionId").asString());
        assertEquals("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                output.path("provenance").get(3).path("sha256").asString());
        assertFalse(output.path("renderable").booleanValue());
        assertEquals("NOT_PERFORMED", output.path("persistence").asString());
        assertEquals("NO_ADMITTED_PROVIDER", output.path("modelAvailability").asString());
        assertEquals("NOT_PERFORMED", output.path("modelDispatch").asString());
        assertTrue(output.path("disclosure").asString().contains("no media was generated"));
    }

    @Test
    void promptTemplateContinuityAndReferenceDigestChangesChangeSeedAndBoundProvenance() throws Exception {
        String original = exampleRequest();
        JsonNode baseline = JSON.readTree(ReferenceGuidedDraftCommand.render(original));

        JsonNode promptChanged = JSON.readTree(original);
        String prompt = "A quiet harbor at sunrise, authored for this local fixture.";
        ((ObjectNode) promptChanged.path("prompt")).put("text", prompt);
        putSourceDigest((ObjectNode) promptChanged.path("prompt").path("source"), ReferenceGuidedDraftCommand.sha256(prompt));
        JsonNode promptOutput = renderWithInput(promptChanged);
        assertSeedAndRoleDigestChanged(baseline, promptOutput, "authored-prompt");

        JsonNode templateChanged = JSON.readTree(original);
        String scene = "Open on the calm harbor; follow the red boat into frame.";
        ((ObjectNode) templateChanged.path("template")).put("authoredScene", scene);
        String templateDigest = ReferenceGuidedDraftCommand.templateDigest("template-harbor", "fixture-v1", scene,
                ReferenceGuidedDraftCommand.parseRequest(original).template().continuityFacts());
        putSourceDigest((ObjectNode) templateChanged.path("template").path("source"), templateDigest);
        JsonNode templateOutput = renderWithInput(templateChanged);
        assertSeedAndRoleDigestChanged(baseline, templateOutput, "authored-template");

        JsonNode continuityChanged = JSON.readTree(original);
        String newFact = "green";
        ((ObjectNode) continuityChanged.path("template").path("continuityFacts").get(0)).put("value", newFact);
        ((ObjectNode) continuityChanged.path("continuity").path("facts").get(0)).put("value", newFact);
        String changedTemplateDigest = ReferenceGuidedDraftCommand.templateDigest("template-harbor", "fixture-v1",
                "Open on a calm harbor; hold the blue sail in frame.",
                java.util.List.of(new ReferenceGuidedScenePlanner.ContinuityFact("sailColor", newFact)));
        String changedContinuityDigest = ReferenceGuidedDraftCommand.continuityDigest("continuity-harbor", "fixture-v1",
                java.util.List.of(new ReferenceGuidedScenePlanner.ContinuityFact("sailColor", newFact)));
        putSourceDigest((ObjectNode) continuityChanged.path("template").path("source"), changedTemplateDigest);
        putSourceDigest((ObjectNode) continuityChanged.path("continuity").path("source"), changedContinuityDigest);
        JsonNode continuityOutput = renderWithInput(continuityChanged);
        assertSeedAndRoleDigestChanged(baseline, continuityOutput, "prior-continuity");
        assertNotEquals(baseline.path("deterministicSeed").asString(), continuityOutput.path("deterministicSeed").asString());

        JsonNode referenceChanged = JSON.readTree(original);
        String newReferenceDigest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
        putSourceDigest((ObjectNode) referenceChanged.path("references").get(0), newReferenceDigest);
        JsonNode referenceOutput = renderWithInput(referenceChanged);
        assertSeedAndRoleDigestChanged(baseline, referenceOutput, "reference-video");
    }

    @Test
    void revokedDeniedMissingAndUnknownSourcesStopBeforeModelDispatch() throws Exception {
        JsonNode parsed = JSON.readTree(exampleRequest());
        ReferenceGuidedDraftCommand.SourceKey reference = referenceKey(parsed);
        for (Decision decision : Set.of(Decision.REVOKED, Decision.DENIED)) {
            AtomicInteger modelCalls = new AtomicInteger();
            ReferenceGuidedDraftCommand.ExactFixtureAuthority authority = authority(parsed, Map.of(reference, decision));
            assertThrows(ReferenceGuidedScenePlanner.SourceRightsDeniedException.class,
                    () -> ReferenceGuidedDraftCommand.render(toJson(parsed), authority, noModel(modelCalls)));
            assertEquals(0, modelCalls.get());
        }
        AtomicInteger staleModelCalls = new AtomicInteger();
        ReferenceGuidedDraftCommand.ExactFixtureAuthority staleAuthority = authority(
                parsed, Map.of(reference, Decision.STALE));
        assertThrows(ReferenceGuidedScenePlanner.StaleSourceVersionException.class,
                () -> ReferenceGuidedDraftCommand.render(toJson(parsed), staleAuthority, noModel(staleModelCalls)));
        assertEquals(0, staleModelCalls.get());

        for (Decision decision : Set.of(Decision.MISSING, Decision.UNKNOWN)) {
            AtomicInteger modelCalls = new AtomicInteger();
            ReferenceGuidedDraftCommand.ExactFixtureAuthority authority = authority(parsed, Map.of(reference, decision));
            assertThrows(ReferenceGuidedScenePlanner.SourceAuthorityUnavailableException.class,
                    () -> ReferenceGuidedDraftCommand.render(toJson(parsed), authority, noModel(modelCalls)));
            assertEquals(0, modelCalls.get());
        }
    }

    @Test
    void conflictingDigestsForOneImmutableVersionFailBeforeAuthorityRead() throws Exception {
        JsonNode parsed = JSON.readTree(exampleRequest());
        ArrayNode references = (ArrayNode) parsed.path("references");
        ObjectNode duplicate = ((ObjectNode) references.get(0)).deepCopy();
        duplicate.put("role", "duplicate-reference-role");
        putSourceDigest(duplicate, "cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc");
        references.add(duplicate);
        AtomicInteger modelCalls = new AtomicInteger();
        ReferenceGuidedDraftCommand.ExactFixtureAuthority authority = authority(parsed, Map.of());

        assertThrows(IllegalArgumentException.class,
                () -> ReferenceGuidedDraftCommand.render(toJson(parsed), authority, noModel(modelCalls)));
        assertTrue(authority.observations.isEmpty());
        assertEquals(0, modelCalls.get());
    }

    @Test
    void invalidAndOverBoundOpaqueProjectIdsFailBeforeAuthorityRead() throws Exception {
        for (String projectId : Set.of(" project-local", "x".repeat(129), "project/local")) {
            JsonNode parsed = JSON.readTree(exampleRequest());
            ((ObjectNode) parsed).put("projectId", projectId);
            ReferenceGuidedDraftCommand.ExactFixtureAuthority authority = authority(parsed, Map.of());
            AtomicInteger modelCalls = new AtomicInteger();
            assertThrows(IllegalArgumentException.class,
                    () -> ReferenceGuidedDraftCommand.render(toJson(parsed), authority, noModel(modelCalls)));
            assertTrue(authority.observations.isEmpty());
            assertEquals(0, modelCalls.get());
        }
    }

    @Test
    void sourceContentDigestMismatchAndUnsupportedFieldsFailClosed() throws Exception {
        JsonNode badDigest = JSON.readTree(exampleRequest());
        ((ObjectNode) badDigest.path("prompt")).put("text", "different prompt without new source digest");
        AtomicInteger modelCalls = new AtomicInteger();
        ReferenceGuidedDraftCommand.ExactFixtureAuthority authority = authority(badDigest, Map.of());
        assertThrows(IllegalArgumentException.class,
                () -> ReferenceGuidedDraftCommand.render(toJson(badDigest), authority, noModel(modelCalls)));
        assertTrue(authority.observations.isEmpty());

        JsonNode extra = JSON.readTree(exampleRequest());
        ((ObjectNode) extra).put("provider", "must-not-dispatch");
        assertThrows(IllegalArgumentException.class, () -> ReferenceGuidedDraftCommand.render(toJson(extra)));
        assertEquals(0, modelCalls.get());
    }

    @Test
    void jsonInputMustBeStrictUtf8BoundedAndRejectDuplicateProperties() {
        assertThrows(Exception.class, () -> ReferenceGuidedDraftCommand.readBoundedUtf8(
                new java.io.ByteArrayInputStream(new byte[] {(byte) 0xc3, (byte) 0x28})));
        assertThrows(IllegalArgumentException.class,
                () -> ReferenceGuidedDraftCommand.render(" ".repeat(1_048_577)));
        assertThrows(Exception.class, () -> ReferenceGuidedDraftCommand.render(
                exampleRequest().replace("\"tenantId\": \"tenant-local\"", "\"tenantId\": \"tenant-local\", \"tenantId\": \"tenant-local\"")));
    }

    private static JsonNode renderWithInput(JsonNode request) throws Exception {
        ReferenceGuidedDraftCommand.ExactFixtureAuthority authority = authority(request, Map.of());
        return JSON.readTree(ReferenceGuidedDraftCommand.render(toJson(request), authority, noModel(new AtomicInteger())));
    }

    private static ReferenceGuidedDraftCommand.ExactFixtureAuthority authority(
            JsonNode request, Map<ReferenceGuidedDraftCommand.SourceKey, Decision> decisions) {
        Set<ReferenceGuidedDraftCommand.SourceKey> allowlist = new HashSet<>();
        addSource(allowlist, request.path("prompt").path("source"));
        for (JsonNode reference : request.path("references")) addSource(allowlist, reference);
        addSource(allowlist, request.path("template").path("source"));
        addSource(allowlist, request.path("continuity").path("source"));
        return new ReferenceGuidedDraftCommand.ExactFixtureAuthority(
                request.path("tenantId").asString(), request.path("principalId").asString(), PURPOSE, allowlist, decisions);
    }

    private static void addSource(Set<ReferenceGuidedDraftCommand.SourceKey> target, JsonNode source) {
        target.add(new ReferenceGuidedDraftCommand.SourceKey(source.path("artifactId").asString(),
                source.path("artifactVersionId").asString(), source.path("sha256").asString()));
    }

    private static ReferenceGuidedDraftCommand.SourceKey referenceKey(JsonNode request) {
        JsonNode source = request.path("references").get(0);
        return new ReferenceGuidedDraftCommand.SourceKey(source.path("artifactId").asString(),
                source.path("artifactVersionId").asString(), source.path("sha256").asString());
    }

    private static ReferenceGuidedScenePlanner.ModelProvider noModel(AtomicInteger calls) {
        return new ReferenceGuidedScenePlanner.ModelProvider() {
            @Override public boolean admitted() { return false; }
            @Override public ReferenceGuidedScenePlanner.ModelResult generate(ReferenceGuidedScenePlanner.Candidate candidate) {
                calls.incrementAndGet();
                throw new AssertionError("unadmitted provider called");
            }
        };
    }

    private static void assertSeedAndRoleDigestChanged(JsonNode before, JsonNode after, String role) {
        assertNotEquals(before.path("deterministicSeed").asString(), after.path("deterministicSeed").asString());
        assertNotEquals(sourceDigest(before, role), sourceDigest(after, role));
    }

    private static String sourceDigest(JsonNode output, String role) {
        for (JsonNode source : output.path("provenance")) {
            if (role.equals(source.path("role").asString())) return source.path("sha256").asString();
        }
        throw new AssertionError("missing provenance role " + role);
    }

    private static void putSourceDigest(ObjectNode source, String digest) { source.put("sha256", digest); }
    private static String toJson(JsonNode value) throws Exception { return JSON.writeValueAsString(value); }
    private static String exampleRequest() throws Exception {
        try (var input = ReferenceGuidedDraftCommandTest.class.getResourceAsStream("/example-request.json")) {
            if (input == null) throw new IllegalStateException("example-request.json missing from test resources");
            return new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }

    private static String exampleResult() throws Exception {
        try (var input = ReferenceGuidedDraftCommandTest.class.getResourceAsStream("/example-result.json")) {
            if (input == null) throw new IllegalStateException("example-result.json missing from test resources");
            return new String(input.readAllBytes(), java.nio.charset.StandardCharsets.UTF_8);
        }
    }
}
