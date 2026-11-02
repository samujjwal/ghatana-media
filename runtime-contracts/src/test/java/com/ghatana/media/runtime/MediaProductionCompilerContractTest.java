package com.ghatana.media.runtime;

import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.HexFormat;

import static org.assertj.core.api.Assertions.assertThat;

class MediaProductionCompilerContractTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SPEC_REF = "production-spec/rev-7";
    private static final String SCHEMA_REF = "production-spec-schema/rev-1";
    private static final String COMPILER_REF = "production-compiler-contract/rev-2";
    private static final String OP_A = "media.operation.capability.media-project-version";
    private static final String OP_B = "media.operation.capability.media-scene-render";
    private static final String SPEC_SCHEMA = """
            {
              "$schema":"https://json-schema.org/draft/2020-12/schema",
              "$defs":{
                "versionRef":{"type":"string","format":"opaque-versioned-reference",
                  "minLength":1,"maxLength":384,"pattern":"\\\\S"},
                "nonEmptyVersionRefList":{"type":"array","minItems":1,"uniqueItems":true,
                  "items":{"$ref":"#/$defs/versionRef"}}
              },
              "type":"object","additionalProperties":false,
              "required":["tenantId","projectId","revisionId","schemaVersion","originClass","purposeRef",
                "sceneRefs","timelineRef","rightsRef","outputProfileRefs"],
              "properties":{
                "tenantId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$"},
                "projectId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$"},
                "revisionId":{"type":"string","pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$"},
                "schemaVersion":{"const":"media.declarative.value.production-spec.v1"},
                "originClass":{"enum":["REAL_CAPTURE","DECLARATIVE_ANIMATION","MODEL_SIMULATION",
                  "GENERATIVE_MEDIA","PDP_SYNTHETIC_FIXTURE"]},
                "purposeRef":{"$ref":"#/$defs/versionRef"},
                "sceneRefs":{"$ref":"#/$defs/nonEmptyVersionRefList"},
                "timelineRef":{"$ref":"#/$defs/versionRef"},
                "rightsRef":{"$ref":"#/$defs/versionRef"},
                "outputProfileRefs":{"$ref":"#/$defs/nonEmptyVersionRefList"}
              }
            }
            """;

    private static MediaProductionSpecCompiler.ProductionSpec spec() {
        return new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v3", "scene/2@v1"), "timeline/main@v2",
                "rights/standard@v1", List.of("profile/1080p@v4"));
    }

    private record Fixture(
            MediaProductionSpecCompiler.ProductionSpec spec,
            MediaProductionSpecCompiler.CompilationInputs inputs,
            byte[] specBytes,
            byte[] schemaBytes,
            byte[] compilerBytes) { }

    private record OperationFixture(
            MediaProductionSemanticSource.OperationResolutionEvidence evidence,
            Map<String, byte[]> contents) { }

    private static Fixture fixture(List<Map<String, Object>> steps) throws Exception {
        return fixture(steps, SPEC_REF, null, null, null);
    }

    private static Fixture fixture(List<Map<String, Object>> steps, String targetSpecRef,
                                   String targetSpecSha, String targetSchemaRef, String targetSchemaSha) throws Exception {
        var typedSpec = spec();
        var inputs = new MediaProductionSpecCompiler.CompilationInputs(SPEC_REF, SCHEMA_REF,
                MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION, COMPILER_REF);
        byte[] specBytes = JSON.writeValueAsBytes(Map.of(
                "tenantId", typedSpec.tenantId(), "projectId", typedSpec.projectId(),
                "revisionId", typedSpec.revisionId(), "schemaVersion", typedSpec.schemaVersion(),
                "originClass", typedSpec.originClass(), "purposeRef", typedSpec.purposeRef(),
                "sceneRefs", typedSpec.sceneRefs(), "timelineRef", typedSpec.timelineRef(),
                "rightsRef", typedSpec.rightsRef(), "outputProfileRefs", typedSpec.outputProfileRefs()));
        byte[] schemaBytes = SPEC_SCHEMA.getBytes(StandardCharsets.UTF_8);
        String specSha = digest(specBytes);
        String schemaSha = digest(schemaBytes);
        Map<String, Object> contract = new LinkedHashMap<>();
        contract.put("schemaVersion", MediaProductionSpecCompiler.PRODUCTION_COMPILER_CONTRACT_SCHEMA_VERSION);
        contract.put("targetProductionSpecRef", targetSpecRef);
        contract.put("targetProductionSpecSha256", targetSpecSha == null ? specSha : targetSpecSha);
        contract.put("targetProductionSpecSchemaRef", targetSchemaRef == null ? SCHEMA_REF : targetSchemaRef);
        contract.put("targetProductionSpecSchemaSha256", targetSchemaSha == null ? schemaSha : targetSchemaSha);
        contract.put("steps", steps);
        return new Fixture(typedSpec, inputs, specBytes, schemaBytes, JSON.writeValueAsBytes(contract));
    }

    private static Map<String, Object> step(String id, String kind, String operationRef,
            List<String> dependencies, List<String> sourceScenes) {
        Map<String, Object> value = new LinkedHashMap<>();
        value.put("stepId", id);
        value.put("kind", kind);
        value.put("operationRef", operationRef);
        value.put("inputArtifactVersionRefs", List.of("artifact/input@v1"));
        value.put("outputArtifactVersionRefs", List.of("artifact/" + id + "@v1"));
        value.put("dependsOn", dependencies);
        value.put("sourceSceneRefs", sourceScenes);
        value.put("manualLockTarget", null);
        return value;
    }

    private static List<Map<String, Object>> steps() {
        return List.of(step("prepare", "DETERMINISTIC", OP_A, List.of(), List.of("scene/1@v3")),
                step("render", "GENERATIVE", OP_B, List.of("prepare"), List.of("scene/2@v1")));
    }

    private static MediaProductionSemanticSource.CompilationResult compile(Fixture fixture,
            Map<String, Integer> operationCounts, AtomicInteger calls) {
        Map<String, byte[]> contents = Map.of(SPEC_REF, fixture.specBytes(), SCHEMA_REF, fixture.schemaBytes(),
                COMPILER_REF, fixture.compilerBytes());
        return new MediaProductionSpecCompiler().compileSemanticSourceFromResolvedInputs(
                fixture.spec(), fixture.inputs(), ref -> {
                    calls.incrementAndGet();
                    byte[] content = contents.get(ref);
                    return content == null ? null : resolved(ref, content);
                }, operationCounts);
    }

    private static OperationFixture operationFixture(List<String> operationRefs) {
        var bindings = new java.util.ArrayList<MediaProductionSemanticSource.OperationDefinitionBinding>();
        var contents = new LinkedHashMap<String, byte[]>();
        for (String operationRef : new java.util.LinkedHashSet<>(operationRefs)) {
            String definitionRef = "operation-definition/" + operationRef;
            byte[] bytes = ("definition:" + operationRef).getBytes(StandardCharsets.UTF_8);
            bindings.add(new MediaProductionSemanticSource.OperationDefinitionBinding(
                    operationRef, definitionRef, digest(bytes)));
            contents.put(definitionRef, bytes);
        }
        return new OperationFixture(new MediaProductionSemanticSource.OperationResolutionEvidence(bindings),
                Map.copyOf(contents));
    }

    private static MediaProductionSemanticSource.CompilationResult compileWithOperationEvidence(
            Fixture fixture, List<String> operationRefs, AtomicInteger calls) {
        return compileWithOperationFixture(fixture, operationFixture(operationRefs), calls);
    }

    private static MediaProductionSemanticSource.CompilationResult compileWithOperationFixture(
            Fixture fixture, OperationFixture operationFixture, AtomicInteger calls) {
        Map<String, byte[]> contents = new LinkedHashMap<>();
        contents.put(SPEC_REF, fixture.specBytes());
        contents.put(SCHEMA_REF, fixture.schemaBytes());
        contents.put(COMPILER_REF, fixture.compilerBytes());
        contents.putAll(operationFixture.contents());
        return compileWithOperationResolver(fixture, operationFixture,
                ref -> {
                    byte[] content = contents.get(ref);
                    return content == null ? null : resolved(ref, content);
                }, calls);
    }

    private static MediaProductionSemanticSource.CompilationResult compileWithOperationResolver(
            Fixture fixture, OperationFixture operationFixture,
            MediaVersionedContractContent.Resolver resolver, AtomicInteger calls) {
        return new MediaProductionSpecCompiler().compileSemanticSourceFromResolvedInputs(
                fixture.spec(), fixture.inputs(), ref -> {
                    calls.incrementAndGet();
                    return resolver.resolve(ref);
                }, operationFixture.evidence());
    }

    @Test
    void resolvesEachExactInputOnceAndPreservesDeclaredKindsAndFingerprint() throws Exception {
        Fixture fixture = fixture(steps());
        AtomicInteger calls = new AtomicInteger();
        var operationFixture = operationFixture(List.of(OP_A, OP_B));
        var result = compileWithOperationEvidence(fixture, List.of(OP_A, OP_B), calls);

        assertThat(calls).hasValue(5);
        assertThat(result.disposition()).as("reason: " + result.reason())
                .isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(result.nodes()).extracting(MediaProductionSemanticSource.NormalizedNode::stepId)
                .containsExactly("prepare", "render");
        assertThat(result.nodes()).extracting(MediaProductionSemanticSource.NormalizedNode::kind)
                .containsExactly(MediaProductionSemanticSource.NodeKind.DETERMINISTIC,
                        MediaProductionSemanticSource.NodeKind.GENERATIVE);
        assertThat(result.nodes()).extracting(MediaProductionSemanticSource.NormalizedNode::operationRef)
                .containsExactly(OP_A, OP_B);
        assertThat(result.nodes().get(1).dependsOn()).containsExactly("prepare");
        assertThat(result.fingerprint()).matches("sha256:[0-9a-f]{64}");

        byte[] alternateDefinition = "alternate definition bytes".getBytes(StandardCharsets.UTF_8);
        String alternateDefinitionRef = "operation-definition/alternate";
        var alternateOperationEvidence = new MediaProductionSemanticSource.OperationResolutionEvidence(List.of(
                new MediaProductionSemanticSource.OperationDefinitionBinding(
                        OP_A, alternateDefinitionRef, digest(alternateDefinition)),
                new MediaProductionSemanticSource.OperationDefinitionBinding(
                        OP_B, "operation-definition/" + OP_B,
                        digest(("definition:" + OP_B).getBytes(StandardCharsets.UTF_8)))));
        var alternateContents = new LinkedHashMap<String, byte[]>(operationFixture.contents());
        alternateContents.put(alternateDefinitionRef, alternateDefinition);
        alternateContents.remove("operation-definition/" + OP_A);
        var alternate = compileWithOperationFixture(fixture,
                new OperationFixture(alternateOperationEvidence, Map.copyOf(alternateContents)), new AtomicInteger());
        assertThat(alternate.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(alternate.fingerprint()).isEqualTo(result.fingerprint());

        var specFingerprint = MediaVersionedContractContent.verifyDigestChecked(SPEC_REF,
                resolved(SPEC_REF, fixture.specBytes()));
        var schemaFingerprint = MediaVersionedContractContent.verifyDigestChecked(SCHEMA_REF,
                resolved(SCHEMA_REF, fixture.schemaBytes()));
        var compilerFingerprint = MediaVersionedContractContent.verifyDigestChecked(COMPILER_REF,
                resolved(COMPILER_REF, fixture.compilerBytes()));
        var operationFingerprints = operationFixture.evidence().definitions().stream()
                .map(definition -> MediaVersionedContractContent.verifyDigestChecked(definition.definitionRef(),
                        resolved(definition.definitionRef(), operationFixture.contents().get(definition.definitionRef()))))
                .toList();
        var graphSources = new java.util.ArrayList<>(List.of(specFingerprint, schemaFingerprint, compilerFingerprint));
        graphSources.addAll(operationFingerprints);
        var graphSource = new MediaProductionSemanticSource(MediaProductionSemanticSource.SCHEMA_VERSION,
                new MediaProductionSemanticSource.SourceBindings(SPEC_REF, specFingerprint.sha256(),
                        SCHEMA_REF, schemaFingerprint.sha256(), COMPILER_REF, compilerFingerprint.sha256()),
                semanticNodes(steps()));
        var innerGraph = graphSource.compileSyntaxCheckedGraphCandidate(fixture.inputs(),
                graphSources, operationFixture.evidence());
        assertThat(innerGraph.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(result.fingerprint()).isEqualTo(candidateFingerprintProjection(
                specFingerprint, schemaFingerprint, compilerFingerprint, innerGraph.fingerprint()));

        var repeated = compileWithOperationEvidence(fixture, List.of(OP_A, OP_B), new AtomicInteger());
        assertThat(repeated.fingerprint()).isEqualTo(result.fingerprint());

        Fixture changedContract = fixture(List.of(
                step("prepare", "DETERMINISTIC", OP_A, List.of(), List.of("scene/1@v3")),
                step("render", "DETERMINISTIC", OP_B, List.of("prepare"), List.of("scene/2@v1"))));
        assertThat(digest(changedContract.compilerBytes())).isNotEqualTo(digest(fixture.compilerBytes()));
        var changed = compileWithOperationEvidence(changedContract, List.of(OP_A, OP_B), new AtomicInteger());
        assertThat(changed.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(changed.fingerprint()).isNotEqualTo(result.fingerprint());
    }

    @Test
    void operationDefinitionResolverRejectsMissingDuplicateUnreferencedAndStaleEvidence() throws Exception {
        Fixture fixture = fixture(List.of(step("prepare", "DETERMINISTIC", OP_A, List.of(), List.of("scene/1@v3"))));
        var valid = operationFixture(List.of(OP_A));

        AtomicInteger missingCalls = new AtomicInteger();
        var missing = compileWithOperationFixture(fixture,
                new OperationFixture(new MediaProductionSemanticSource.OperationResolutionEvidence(List.of()), Map.of()),
                missingCalls);
        assertThat(missingCalls).hasValue(3);
        assertResult(missing, MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.UNRESOLVED_OPERATION);

        var validBinding = valid.evidence().definitions().getFirst();
        var duplicateEvidence = new MediaProductionSemanticSource.OperationResolutionEvidence(
                List.of(validBinding, validBinding));
        AtomicInteger duplicateCalls = new AtomicInteger();
        var duplicate = compileWithOperationFixture(fixture, new OperationFixture(duplicateEvidence, valid.contents()),
                duplicateCalls);
        assertThat(duplicateCalls).hasValue(3);
        assertResult(duplicate, MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.AMBIGUOUS_OPERATION);

        var unreferencedEvidence = new MediaProductionSemanticSource.OperationResolutionEvidence(List.of(
                new MediaProductionSemanticSource.OperationDefinitionBinding(
                        OP_B, validBinding.definitionRef(), validBinding.definitionSha256())));
        AtomicInteger unreferencedCalls = new AtomicInteger();
        var unreferenced = compileWithOperationFixture(fixture,
                new OperationFixture(unreferencedEvidence, valid.contents()), unreferencedCalls);
        assertThat(unreferencedCalls).hasValue(3);
        assertResult(unreferenced, MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);

        var staleDigestEvidence = new MediaProductionSemanticSource.OperationResolutionEvidence(List.of(
                new MediaProductionSemanticSource.OperationDefinitionBinding(
                        OP_A, validBinding.definitionRef(), "sha256:" + "0".repeat(64))));
        AtomicInteger staleCalls = new AtomicInteger();
        var stale = compileWithOperationFixture(fixture,
                new OperationFixture(staleDigestEvidence, valid.contents()), staleCalls);
        assertThat(staleCalls).hasValue(4);
        assertResult(stale, MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);

        String definitionRef = validBinding.definitionRef();
        Map<String, byte[]> withDefinition = new LinkedHashMap<>();
        withDefinition.put(SPEC_REF, fixture.specBytes());
        withDefinition.put(SCHEMA_REF, fixture.schemaBytes());
        withDefinition.put(COMPILER_REF, fixture.compilerBytes());
        withDefinition.putAll(valid.contents());

        AtomicInteger unavailableCalls = new AtomicInteger();
        var unavailable = compileWithOperationResolver(fixture, valid,
                ref -> ref.equals(definitionRef) ? null : resolved(ref, withDefinition.get(ref)), unavailableCalls);
        assertThat(unavailableCalls).hasValue(4);
        assertResult(unavailable, MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.UNRESOLVED_SOURCE_BINDING);

        AtomicInteger failedCalls = new AtomicInteger();
        var failedResolver = compileWithOperationResolver(fixture, valid, ref -> {
            if (ref.equals(definitionRef)) throw new IllegalStateException("resolver unavailable");
            return resolved(ref, withDefinition.get(ref));
        }, failedCalls);
        assertThat(failedCalls).hasValue(4);
        assertResult(failedResolver, MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.UNRESOLVED_SOURCE_BINDING);

        AtomicInteger wrongEchoCalls = new AtomicInteger();
        var wrongEcho = compileWithOperationResolver(fixture, valid, ref -> {
            byte[] content = withDefinition.get(ref);
            return ref.equals(definitionRef) ? resolved("alias/" + ref, content) : resolved(ref, content);
        }, wrongEchoCalls);
        assertThat(wrongEchoCalls).hasValue(4);
        assertResult(wrongEcho, MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);
    }

    @Test
    void rejectsStaleOptionalProjectRevisionBeforeResolvingAnyInput() throws Exception {
        Fixture fixture = fixture(steps());
        AtomicInteger calls = new AtomicInteger();
        var stale = new MediaProductionSpecCompiler().compileSemanticSourceFromResolvedInputs(
                fixture.spec(), fixture.inputs(), "rev-6", ref -> {
                    calls.incrementAndGet();
                    return null;
                }, Map.of(OP_A, 1, OP_B, 1));
        assertThat(calls).hasValue(0);
        assertResult(stale, MediaProductionSemanticSource.Disposition.NOT_ADMITTED,
                MediaProductionSemanticSource.Reason.EXECUTION_CONTEXT_MISMATCH);
    }

    @Test
    void rejectsMismatchedTargetRefsOrDigestsAndResolverEchoes() throws Exception {
        Fixture wrongRef = fixture(steps(), "production-spec/other", null, null, null);
        assertResult(compile(wrongRef, Map.of(OP_A, 1, OP_B, 1), new AtomicInteger()),
                MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);

        Fixture wrongDigest = fixture(steps(), SPEC_REF, "sha256:" + "0".repeat(64), null, null);
        assertResult(compile(wrongDigest, Map.of(OP_A, 1, OP_B, 1), new AtomicInteger()),
                MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);

        Fixture wrongSchemaRef = fixture(steps(), SPEC_REF, null, "production-spec-schema/other", null);
        assertResult(compile(wrongSchemaRef, Map.of(OP_A, 1, OP_B, 1), new AtomicInteger()),
                MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);

        Fixture wrongSchemaDigest = fixture(steps(), SPEC_REF, null, SCHEMA_REF,
                "sha256:" + "0".repeat(64));
        assertResult(compile(wrongSchemaDigest, Map.of(OP_A, 1, OP_B, 1), new AtomicInteger()),
                MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);

        Fixture fixture = fixture(steps());
        AtomicInteger calls = new AtomicInteger();
        Map<String, byte[]> contents = Map.of(SPEC_REF, fixture.specBytes(), SCHEMA_REF, fixture.schemaBytes(),
                COMPILER_REF, fixture.compilerBytes());
        var wrongEcho = new MediaProductionSpecCompiler().compileSemanticSourceFromResolvedInputs(
                fixture.spec(), fixture.inputs(), ref -> {
                    calls.incrementAndGet();
                    return resolved("alias/" + ref, contents.get(ref));
                }, Map.of(OP_A, 1, OP_B, 1));
        assertThat(calls).hasValue(3);
        assertResult(wrongEcho, MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);
    }

    @Test
    void rejectsClosedShapeUnknownSchemaKindAndOutsideSceneRefs() throws Exception {
        Fixture fixture = fixture(steps());
        String unknownField = new String(fixture.compilerBytes(), StandardCharsets.UTF_8)
                .replaceFirst("\\{", "{\"unexpected\":true,");
        var malformed = withCompiler(fixture, unknownField.getBytes(StandardCharsets.UTF_8));
        assertResult(compile(malformed, Map.of(OP_A, 1, OP_B, 1), new AtomicInteger()),
                MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.INVALID_SEMANTIC_SOURCE_CONTENT);

        String duplicateKey = new String(fixture.compilerBytes(), StandardCharsets.UTF_8)
                .replaceFirst("\\{", "{\"schemaVersion\":\"duplicate\",");
        assertResult(compile(withCompiler(fixture, duplicateKey.getBytes(StandardCharsets.UTF_8)),
                        Map.of(OP_A, 1, OP_B, 1), new AtomicInteger()),
                MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.INVALID_SEMANTIC_SOURCE_CONTENT);

        String unknownSchemaVersion = new String(fixture.compilerBytes(), StandardCharsets.UTF_8)
                .replace(MediaProductionSpecCompiler.PRODUCTION_COMPILER_CONTRACT_SCHEMA_VERSION, "compiler.v99");
        assertResult(compile(withCompiler(fixture, unknownSchemaVersion.getBytes(StandardCharsets.UTF_8)),
                        Map.of(OP_A, 1, OP_B, 1), new AtomicInteger()),
                MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.INVALID_SEMANTIC_SOURCE_CONTENT);

        Fixture unknownKind = fixture(List.of(step("prepare", "MAYBE", OP_A, List.of(), List.of())));
        assertResult(compile(unknownKind, Map.of(OP_A, 1), new AtomicInteger()),
                MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.UNKNOWN_NODE_KIND);

        Fixture outsideScene = fixture(List.of(step("prepare", "DETERMINISTIC", OP_A,
                List.of(), List.of("scene/other@v1"))));
        assertResult(compile(outsideScene, Map.of(OP_A, 1), new AtomicInteger()),
                MediaProductionSemanticSource.Disposition.NOT_ADMITTED,
                MediaProductionSemanticSource.Reason.EXECUTION_CONTEXT_MISMATCH);
    }

    @Test
    void rejectsBadDependenciesCyclesAndUnresolvedOperations() throws Exception {
        Fixture missing = fixture(List.of(step("prepare", "DETERMINISTIC", OP_A, List.of("absent"), List.of())));
        assertResult(compileWithOperationEvidence(missing, List.of(OP_A), new AtomicInteger()),
                MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.MISSING_DEPENDENCY);

        Fixture cycle = fixture(List.of(step("a", "DETERMINISTIC", OP_A, List.of("b"), List.of()),
                step("b", "GENERATIVE", OP_B, List.of("a"), List.of())));
        assertResult(compileWithOperationEvidence(cycle, List.of(OP_A, OP_B), new AtomicInteger()),
                MediaProductionSemanticSource.Disposition.NOT_ADMITTED,
                MediaProductionSemanticSource.Reason.CYCLIC_GRAPH);

        Fixture unresolved = fixture(List.of(step("prepare", "DETERMINISTIC", OP_A, List.of(), List.of())));
        assertResult(compile(unresolved, Map.of(), new AtomicInteger()), MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.UNRESOLVED_OPERATION);
        assertResult(compile(unresolved, Map.of(OP_A, 2), new AtomicInteger()), MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.AMBIGUOUS_OPERATION);
    }

    private static Fixture withCompiler(Fixture fixture, byte[] compilerBytes) {
        return new Fixture(fixture.spec(), fixture.inputs(), fixture.specBytes(), fixture.schemaBytes(), compilerBytes);
    }

    @SuppressWarnings("unchecked")
    private static List<MediaProductionSemanticSource.Node> semanticNodes(List<Map<String, Object>> steps) {
        return steps.stream().map(step -> new MediaProductionSemanticSource.Node(
                (String) step.get("stepId"), (String) step.get("kind"), (String) step.get("operationRef"),
                (List<String>) step.get("inputArtifactVersionRefs"),
                (List<String>) step.get("outputArtifactVersionRefs"),
                (List<String>) step.get("dependsOn"), (List<String>) step.get("sourceSceneRefs"),
                java.util.Optional.empty())).toList();
    }

    private static String candidateFingerprintProjection(
            MediaVersionedContractContent.ResolvedContentFingerprint spec,
            MediaVersionedContractContent.ResolvedContentFingerprint schema,
            MediaVersionedContractContent.ResolvedContentFingerprint compiler,
            String graphFingerprint) {
        StringBuilder projection = new StringBuilder();
        appendSemanticField(projection, "media.production.semantic-graph-resolved-input-candidate.v1");
        appendResolvedInput(projection, spec);
        appendResolvedInput(projection, schema);
        appendResolvedInput(projection, compiler);
        appendSemanticField(projection, graphFingerprint);
        return digest(projection.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void appendResolvedInput(StringBuilder projection,
            MediaVersionedContractContent.ResolvedContentFingerprint input) {
        appendSemanticField(projection, input.versionRef());
        appendSemanticField(projection, input.sha256());
        appendSemanticField(projection, Integer.toString(input.byteLength()));
    }

    private static void appendSemanticField(StringBuilder projection, String value) {
        projection.append(value.getBytes(StandardCharsets.UTF_8).length).append(':').append(value);
    }

    private static void assertResult(MediaProductionSemanticSource.CompilationResult result,
            MediaProductionSemanticSource.Disposition disposition, MediaProductionSemanticSource.Reason reason) {
        assertThat(result.disposition()).isEqualTo(disposition);
        assertThat(result.reason()).isEqualTo(reason);
        if (disposition != MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED) {
            assertThat(result.fingerprint()).isNull();
            assertThat(result.nodes()).isEmpty();
        }
    }

    private static MediaVersionedContractContent.ResolvedContent resolved(String ref, byte[] bytes) {
        return new MediaVersionedContractContent.ResolvedContent(ref, bytes, digest(bytes));
    }

    private static String digest(byte[] bytes) {
        try {
            return "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (Exception unavailable) {
            throw new IllegalStateException(unavailable);
        }
    }
}
