package com.ghatana.media.examples.referenceguideddraft;

import com.ghatana.media.production.timeline.ReferenceGuidedScenePlanner;
import com.ghatana.media.production.timeline.ReferenceGuidedScenePlanner.BoundSource;
import com.ghatana.media.production.timeline.ReferenceGuidedScenePlanner.ContinuityFact;
import com.ghatana.media.production.timeline.ReferenceGuidedScenePlanner.ContinuitySnapshot;
import com.ghatana.media.production.timeline.ReferenceGuidedScenePlanner.Prompt;
import com.ghatana.media.production.timeline.ReferenceGuidedScenePlanner.Request;
import com.ghatana.media.production.timeline.ReferenceGuidedScenePlanner.Template;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceVersion;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.SerializationFeature;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.CharBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/** Runnable source-bound, authored-template candidate consumer. It never dispatches a model. */
public final class ReferenceGuidedDraftCommand {
    private static final int MAX_INPUT_BYTES = 1_048_576;
    private static final String PURPOSE = "source-conditioned-scene";
    private static final String SAMPLE_TENANT = "tenant-local";
    private static final String SAMPLE_PRINCIPAL = "creator-local";
    private static final String SAMPLE_PROJECT = "project-local";
    private static final String SAMPLE_SCENE = "scene-candidate";
    private static final String SAMPLE_REVISION = "revision-local";
    private static final String SAMPLE_PROMPT = "A quiet harbor at dawn, authored for this local fixture.";
    private static final String SAMPLE_TEMPLATE_ID = "template-harbor";
    private static final String SAMPLE_TEMPLATE_VERSION = "fixture-v1";
    private static final String SAMPLE_TEMPLATE_SCENE = "Open on a calm harbor; hold the blue sail in frame.";
    private static final String SAMPLE_CONTINUITY_STATE = "continuity-harbor";
    private static final String SAMPLE_CONTINUITY_VERSION = "fixture-v1";
    private static final String SAMPLE_REFERENCE_ID = "synthetic-reference-video-01";
    private static final String SAMPLE_REFERENCE_VERSION = "fixture-v1";
    private static final String SAMPLE_REFERENCE_SHA256 = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    private static final String SAMPLE_SOURCE_VERSION = "fixture-v1";
    private static final List<ContinuityFact> SAMPLE_FACTS = List.of(new ContinuityFact("sailColor", "blue"));
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build())
            .enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS)
            .build();

    private ReferenceGuidedDraftCommand() { }

    public static void main(String[] args) {
        if (args.length != 1) {
            System.err.println("Usage: reference-guided-draft <request.json>");
            System.exit(2);
        }
        try (InputStream input = java.nio.file.Files.newInputStream(java.nio.file.Path.of(args[0]))) {
            System.out.println(render(readBoundedUtf8(input)));
        } catch (ReferenceGuidedScenePlanner.SourceRightsDeniedException denied) {
            System.err.println("Reference-guided draft denied: exact sample source is not eligible.");
            System.exit(3);
        } catch (ReferenceGuidedScenePlanner.SourceAuthorityUnavailableException unavailable) {
            System.err.println("Reference-guided draft unavailable: source authority is unknown.");
            System.exit(3);
        } catch (Exception invalid) {
            System.err.println("Reference-guided draft rejected: " + invalid.getClass().getSimpleName());
            System.exit(2);
        }
    }

    /** Produces stable JSON only for the exact bundled fixture references. */
    public static String render(String inputJson) throws IOException {
        return render(inputJson, sampleAuthority(), unadmittedModel());
    }

    /** Test seam for adversarial local authority/model ports; not exposed by the CLI. */
    static String render(String inputJson, ReferenceGuidedScenePlanner.CurrentSourceAuthority authority,
                         ReferenceGuidedScenePlanner.ModelProvider modelProvider) throws IOException {
        Request request = parseRequest(inputJson);
        JsonNode root = parseRoot(inputJson);
        Actor actor = new Actor(text(root, "tenantId"), text(root, "principalId"));
        ReferenceGuidedScenePlanner planner = new ReferenceGuidedScenePlanner(authority, modelProvider);
        ReferenceGuidedScenePlanner.Candidate candidate = planner.prepare(actor, request);
        ReferenceGuidedScenePlanner.ModelResult modelResult = planner.generateWithModel(candidate);
        if (!(modelResult instanceof ReferenceGuidedScenePlanner.ModelUnavailable unavailable)
                || !"NO_ADMITTED_PROVIDER".equals(unavailable.reason())) {
            throw new IllegalStateException("local draft consumer unexpectedly observed an admitted model provider");
        }
        return renderCandidate(candidate);
    }

    static Request parseRequest(String inputJson) throws IOException {
        validateUtf8Size(inputJson);
        JsonNode root = parseRoot(inputJson);
        object(root, "input");
        fields(root, Set.of("tenantId", "principalId", "projectId", "sceneId", "expectedProjectRevisionId",
                "seedInput", "prompt", "references", "template", "continuity"), "input");
        String tenant = text(root, "tenantId");
        String principal = text(root, "principalId");
        String purpose = PURPOSE;
        String project = text(root, "projectId");
        String scene = text(root, "sceneId");
        String revision = text(root, "expectedProjectRevisionId");
        long seed = longInteger(root, "seedInput", "input");

        JsonNode promptNode = required(root, "prompt", "input");
        object(promptNode, "prompt");
        fields(promptNode, Set.of("text", "source"), "prompt");
        String promptText = text(promptNode, "text");
        BoundSource promptSource = source(required(promptNode, "source", "prompt"), "prompt.source");
        if (!promptSource.role().equals("authored-prompt") || !promptSource.sha256().equals(sha256(promptText))) {
            throw invalid("prompt source digest must bind the exact authored prompt text");
        }

        JsonNode referenceNodes = required(root, "references", "input");
        if (!referenceNodes.isArray() || referenceNodes.isEmpty()) throw invalid("references must contain at least one exact source");
        List<BoundSource> references = new ArrayList<>();
        for (int i = 0; i < referenceNodes.size(); i++) {
            references.add(source(referenceNodes.get(i), "references[" + i + "]"));
        }

        JsonNode templateNode = required(root, "template", "input");
        object(templateNode, "template");
        fields(templateNode, Set.of("templateId", "version", "authoredScene", "continuityFacts", "source"), "template");
        String templateId = text(templateNode, "templateId");
        String templateVersion = text(templateNode, "version");
        String authoredScene = text(templateNode, "authoredScene");
        List<ContinuityFact> templateFacts = facts(required(templateNode, "continuityFacts", "template"), "template.continuityFacts");
        BoundSource templateSource = source(required(templateNode, "source", "template"), "template.source");
        if (!templateSource.role().equals("authored-template")
                || !templateSource.sha256().equals(templateDigest(templateId, templateVersion, authoredScene, templateFacts))) {
            throw invalid("template source digest must bind the exact authored template");
        }

        JsonNode continuityNode = required(root, "continuity", "input");
        object(continuityNode, "continuity");
        fields(continuityNode, Set.of("stateId", "semanticVersion", "facts", "source"), "continuity");
        String continuityState = text(continuityNode, "stateId");
        String continuityVersion = text(continuityNode, "semanticVersion");
        List<ContinuityFact> continuityFacts = facts(required(continuityNode, "facts", "continuity"), "continuity.facts");
        BoundSource continuitySource = source(required(continuityNode, "source", "continuity"), "continuity.source");
        if (!continuitySource.role().equals("prior-continuity")
                || !continuitySource.sha256().equals(continuityDigest(continuityState, continuityVersion, continuityFacts))) {
            throw invalid("continuity source digest must bind the exact prior continuity snapshot");
        }

        return new Request(project, scene, revision, purpose, seed,
                new Prompt(promptText, promptSource), references,
                new Template(templateId, templateVersion, authoredScene, templateFacts, List.of(templateSource)),
                new ContinuitySnapshot(continuityState, continuityVersion, continuityFacts, List.of(continuitySource)));
    }

    private static JsonNode parseRoot(String inputJson) throws IOException {
        return JSON.reader(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).readTree(inputJson);
    }

    private static String renderCandidate(ReferenceGuidedScenePlanner.Candidate candidate) throws IOException {
        Map<String, Object> output = new LinkedHashMap<>();
        output.put("kind", "LOCAL_REFERENCE_GUIDED_SCENE_CANDIDATE");
        output.put("preparation", candidate.preparation().name());
        output.put("scope", Map.of("tenantId", candidate.tenantId(), "principalId", candidate.ownerPrincipalId(),
                "projectId", candidate.projectId(), "sceneId", candidate.sceneId(),
                "expectedProjectRevisionId", candidate.expectedProjectRevisionId()));
        output.put("purpose", candidate.purpose());
        output.put("authoredPrompt", candidate.authoredPrompt());
        output.put("template", Map.of("templateId", candidate.templateId(), "version", candidate.templateVersion(),
                "authoredScene", candidate.authoredScene(), "continuityFacts", factJson(candidate.continuityFacts())));
        output.put("priorContinuity", Map.of("stateId", candidate.priorContinuity().stateId(),
                "semanticVersion", candidate.priorContinuity().semanticVersion(),
                "facts", factJson(candidate.priorContinuity().facts())));
        output.put("deterministicSeed", candidate.deterministicSeed());
        output.put("provenance", candidate.provenance().stream().map(source -> Map.of(
                "role", source.role(), "artifactId", source.source().artifactId(),
                "artifactVersionId", source.source().artifactVersionId(), "sha256", source.sha256())).toList());
        output.put("renderable", false);
        output.put("persistence", "NOT_PERFORMED");
        output.put("modelAvailability", "NO_ADMITTED_PROVIDER");
        output.put("modelDispatch", "NOT_PERFORMED");
        output.put("disclosure", "Authored template candidate only. Synthetic local references are fixture data; no model ran, no media was generated, and no project revision was written.");
        return JSON.writerWithDefaultPrettyPrinter().writeValueAsString(output);
    }

    private static List<Map<String, String>> factJson(List<ContinuityFact> facts) {
        return facts.stream().map(fact -> Map.of("key", fact.key(), "value", fact.value())).toList();
    }

    private static List<ContinuityFact> facts(JsonNode node, String path) {
        if (!node.isArray()) throw invalid(path + " must be an array");
        List<ContinuityFact> facts = new ArrayList<>();
        for (int i = 0; i < node.size(); i++) {
            JsonNode fact = node.get(i);
            object(fact, path + "[" + i + "]");
            fields(fact, Set.of("key", "value"), path + "[" + i + "]");
            facts.add(new ContinuityFact(text(fact, "key"), text(fact, "value")));
        }
        return List.copyOf(facts);
    }

    private static BoundSource source(JsonNode node, String path) {
        object(node, path);
        fields(node, Set.of("role", "artifactId", "artifactVersionId", "sha256"), path);
        return new BoundSource(text(node, "role"),
                new SourceVersion(text(node, "artifactId"), text(node, "artifactVersionId")), text(node, "sha256"));
    }

    private static ReferenceGuidedScenePlanner.CurrentSourceAuthority sampleAuthority() {
        return new ExactFixtureAuthority(SAMPLE_TENANT, SAMPLE_PRINCIPAL, PURPOSE, Set.of(
                new SourceKey("authored-prompt-01", SAMPLE_SOURCE_VERSION, sha256(SAMPLE_PROMPT)),
                new SourceKey(SAMPLE_REFERENCE_ID, SAMPLE_REFERENCE_VERSION, SAMPLE_REFERENCE_SHA256),
                new SourceKey("authored-template-01", SAMPLE_TEMPLATE_VERSION,
                        templateDigest(SAMPLE_TEMPLATE_ID, SAMPLE_TEMPLATE_VERSION, SAMPLE_TEMPLATE_SCENE, SAMPLE_FACTS)),
                new SourceKey("prior-continuity-01", SAMPLE_CONTINUITY_VERSION,
                        continuityDigest(SAMPLE_CONTINUITY_STATE, SAMPLE_CONTINUITY_VERSION, SAMPLE_FACTS))));
    }

    private static ReferenceGuidedScenePlanner.ModelProvider unadmittedModel() {
        return new ReferenceGuidedScenePlanner.ModelProvider() {
            @Override public boolean admitted() { return false; }
            @Override public ReferenceGuidedScenePlanner.ModelResult generate(
                    ReferenceGuidedScenePlanner.Candidate candidate) {
                throw new AssertionError("unadmitted fixture model must never be called");
            }
        };
    }

    static final class ExactFixtureAuthority implements ReferenceGuidedScenePlanner.CurrentSourceAuthority {
        private final String tenantId;
        private final String principalId;
        private final String purpose;
        private final Set<SourceKey> allowlist;
        private final Map<SourceKey, ReferenceGuidedScenePlanner.Decision> decisions;
        final List<SourceKey> observations = new ArrayList<>();

        ExactFixtureAuthority(String tenantId, String principalId, String purpose, Set<SourceKey> allowlist) {
            this(tenantId, principalId, purpose, allowlist, Map.of());
        }

        ExactFixtureAuthority(String tenantId, String principalId, String purpose, Set<SourceKey> allowlist,
                              Map<SourceKey, ReferenceGuidedScenePlanner.Decision> decisions) {
            this.tenantId = tenantId;
            this.principalId = principalId;
            this.purpose = purpose;
            this.allowlist = Set.copyOf(allowlist);
            this.decisions = Map.copyOf(decisions);
        }

        @Override public ReferenceGuidedScenePlanner.Decision inspect(
                Actor actor, BoundSource source, String actualPurpose) {
            SourceKey key = SourceKey.of(source);
            observations.add(key);
            if (!tenantId.equals(actor.tenantId()) || !principalId.equals(actor.principalId())
                    || !purpose.equals(actualPurpose) || !allowlist.contains(key)) {
                return ReferenceGuidedScenePlanner.Decision.DENIED;
            }
            return decisions.getOrDefault(key, ReferenceGuidedScenePlanner.Decision.ELIGIBLE);
        }
    }

    record SourceKey(String artifactId, String versionId, String sha256) {
        static SourceKey of(BoundSource source) {
            return new SourceKey(source.source().artifactId(), source.source().artifactVersionId(), source.sha256());
        }
    }

    static String templateDigest(String id, String version, String scene, List<ContinuityFact> facts) {
        return sha256(material("template", id, "version", version, "scene", scene, "facts", factsMaterial(facts)));
    }

    static String continuityDigest(String state, String version, List<ContinuityFact> facts) {
        return sha256(material("state", state, "version", version, "facts", factsMaterial(facts)));
    }

    static String sha256(String value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }

    private static String factsMaterial(List<ContinuityFact> facts) {
        StringBuilder material = new StringBuilder();
        facts.stream().sorted(Comparator.comparing(ContinuityFact::key)).forEach(fact -> {
            append(material, "factKey", fact.key());
            append(material, "factValue", fact.value());
        });
        return material.toString();
    }

    private static String material(String... fields) {
        StringBuilder value = new StringBuilder();
        for (int i = 0; i < fields.length; i += 2) append(value, fields[i], fields[i + 1]);
        return value.toString();
    }

    private static void append(StringBuilder target, String name, String value) {
        target.append(name.length()).append(':').append(name).append(value.length()).append(':').append(value);
    }

    static String readBoundedUtf8(InputStream input) throws IOException {
        byte[] bytes = input.readNBytes(MAX_INPUT_BYTES + 1);
        if (bytes.length == 0 || bytes.length > MAX_INPUT_BYTES) {
            throw invalid("input must contain between 1 and 1048576 UTF-8 bytes");
        }
        try {
            return StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException malformed) {
            throw invalid("input must be valid UTF-8");
        }
    }

    private static void validateUtf8Size(String input) {
        ByteBuffer buffer = ByteBuffer.allocate(MAX_INPUT_BYTES + 1);
        var encoder = StandardCharsets.UTF_8.newEncoder().onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT);
        try {
            var result = encoder.encode(CharBuffer.wrap(input), buffer, true);
            if (result.isOverflow()) throw invalid("input exceeds 1048576 UTF-8 bytes");
            if (result.isError()) result.throwException();
            result = encoder.flush(buffer);
            if (result.isOverflow()) throw invalid("input exceeds 1048576 UTF-8 bytes");
            if (result.isError()) result.throwException();
        } catch (CharacterCodingException malformed) {
            throw invalid("input must be valid Unicode encodable as UTF-8");
        }
        if (buffer.position() == 0 || buffer.position() > MAX_INPUT_BYTES) throw invalid("invalid UTF-8 input size");
    }

    private static String text(JsonNode node, String name) {
        JsonNode value = required(node, name, "object");
        if (!value.isString() || value.asString().isBlank()) throw invalid(name + " must be a non-blank string");
        return value.asString();
    }

    private static long longInteger(JsonNode node, String name, String path) {
        JsonNode value = required(node, name, path);
        if (!value.isIntegralNumber() || !value.canConvertToLong()) throw invalid(path + "." + name + " must be an integer");
        return value.longValue();
    }

    private static JsonNode required(JsonNode node, String name, String path) {
        JsonNode value = node.get(name);
        if (value == null || value.isNull()) throw invalid(path + "." + name + " is required");
        return value;
    }

    private static void object(JsonNode node, String path) {
        if (node == null || !node.isObject()) throw invalid(path + " must be an object");
    }

    private static void fields(JsonNode node, Set<String> allowed, String path) {
        node.propertyNames().forEach(name -> {
            if (!allowed.contains(name)) throw invalid(path + " contains unsupported field '" + name + "'");
        });
    }

    private static IllegalArgumentException invalid(String message) { return new IllegalArgumentException(message); }
}
