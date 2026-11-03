package com.ghatana.media.runtime;

import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.time.Instant;
import java.util.LinkedHashMap;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaProductionSemanticSourceTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String SEMANTIC_REF = "semantic-source/rev-1";
    private static final String SPEC = "production-spec/rev-7";
    private static final String SCHEMA = "production-spec-schema/rev-1";
    private static final String COMPILER = "production-compiler-contract/v3";
    private static final String OP = "media.operation.capability.media-project-version";
    private static final String OP2 = "media.operation.capability.media-project-composition-update";
    private static final String D1 = "sha256:" + "1".repeat(64);
    private static final String D2 = "sha256:" + "2".repeat(64);
    private static final String D3 = "sha256:" + "3".repeat(64);

    private static MediaProductionSemanticSource source(List<MediaProductionSemanticSource.Node> nodes) {
        return new MediaProductionSemanticSource(MediaProductionSemanticSource.SCHEMA_VERSION,
                new MediaProductionSemanticSource.SourceBindings(SPEC, D1, SCHEMA, D2, COMPILER, D3), nodes);
    }

    private static List<MediaVersionedContractContent.ResolvedContentFingerprint> resolved() {
        return List.of(new MediaVersionedContractContent.ResolvedContentFingerprint(SPEC, D1, 10),
                new MediaVersionedContractContent.ResolvedContentFingerprint(SCHEMA, D2, 20),
                new MediaVersionedContractContent.ResolvedContentFingerprint(COMPILER, D3, 30));
    }

    private static MediaProductionSemanticSource.OperationResolutionEvidence operationEvidence() {
        return new MediaProductionSemanticSource.OperationResolutionEvidence(List.of(
                new MediaProductionSemanticSource.OperationDefinitionBinding(OP, "operation-definition/rev-1", D1)));
    }

    private static List<MediaVersionedContractContent.ResolvedContentFingerprint> resolvedWithOperation() {
        var values = new java.util.ArrayList<>(resolved());
        values.add(new MediaVersionedContractContent.ResolvedContentFingerprint(
                "operation-definition/rev-1", D1, 42));
        return List.copyOf(values);
    }

    private static MediaProductionSpecCompiler.CompilationInputs inputs() {
        return new MediaProductionSpecCompiler.CompilationInputs(SPEC, SCHEMA,
                MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION, COMPILER);
    }

    private static MediaProductionSemanticSource.Node node(String id, String kind, List<String> deps) {
        return new MediaProductionSemanticSource.Node(id, kind, OP,
                List.of("artifact/input@v1"), List.of("artifact/" + id + "@v1"), deps,
                List.of(), Optional.empty());
    }

    private static MediaProductionSemanticSource.Node boundNode(String id, List<String> deps,
            List<String> sourceScenes, Optional<MediaProductionSemanticSource.LockTarget> lock) {
        return new MediaProductionSemanticSource.Node(id, "DETERMINISTIC", OP,
                List.of("artifact/input@v1"), List.of("artifact/" + id + "@v1"), deps, sourceScenes, lock);
    }

    private static MediaProductionSpecCompiler.ProductionSpec productionSpec() {
        return new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v3"), "timeline/main@v2", "rights/standard@v1",
                List.of("profile/1080p@v4"));
    }

    private static MediaProductionAdmissionBinding.Binding binding(String changedStep, String changedDigest) {
        return binding(List.of("step-a", "step-b", "step-c"), Map.of("step-a",
                new MediaProductionSemanticSource.LockTarget("SCENE", "scene/1@v3")), changedStep, changedDigest);
    }

    private static MediaProductionAdmissionBinding.Binding binding(List<String> stepIds,
            Map<String, MediaProductionSemanticSource.LockTarget> declaredLocks,
            String changedStep, String changedDigest) {
        var engines = new LinkedHashMap<String, MediaProductionAdmissionBinding.Engine>();
        for (String id : stepIds) {
            String digest = id.equals(changedStep) ? changedDigest : D1;
            engines.put(id, new MediaProductionAdmissionBinding.Engine("ENGINE", "engine-" + id, digest));
        }
        var expires = Instant.parse("2030-01-01T00:00:00Z");
        var sourceAuthority = new MediaProductionAdmissionBinding.SceneSourceAuthority(
                "scene/1@v3", D1, "rights/standard@v1", "decision/scene@v1", expires, 1);
        var locks = new LinkedHashMap<String, MediaProductionAdmissionBinding.EditLock>();
        declaredLocks.forEach((stepId, lock) -> locks.put(stepId,
                new MediaProductionAdmissionBinding.EditLock(lock.scopeKind(), lock.targetRef(),
                        "principal-1", "lease-" + stepId, 1, expires)));
        return new MediaProductionAdmissionBinding.Binding(MediaProductionAdmissionBinding.SCHEMA_VERSION,
                "project-1", "rev-7",
                new MediaProductionAdmissionBinding.RequestIdentity("request-1", D2), engines,
                new MediaProductionAdmissionBinding.ProviderQualification("provider-1", "qualification/v1",
                        "provider-rights/v1", D3, true),
                new MediaProductionAdmissionBinding.Reservation("quote/v1", "quote/v1", "reservation-1",
                        new MediaProductionAdmissionBinding.BoundedAmount(10, "unit/cost"),
                        new MediaProductionAdmissionBinding.BoundedAmount(10, "unit/cost"),
                        new MediaProductionAdmissionBinding.BoundedAmount(10, "unit/compute"),
                        new MediaProductionAdmissionBinding.BoundedAmount(10, "unit/compute"),
                        new MediaProductionAdmissionBinding.BoundedAmount(10, "unit/time"),
                        new MediaProductionAdmissionBinding.BoundedAmount(10, "unit/time")),
                new MediaProductionAdmissionBinding.Authority("identity-context/v1", D2, 1,
                        "tenant-1", "principal-1", "delegation/v1", "workspace/v1", "purpose/v1",
                        "rights/standard@v1", "authority/source@v1", D1, "decision/global@v1", expires, 1),
                locks,
                new MediaProductionAdmissionBinding.ClockBindings("story-clock/v1", "media-clock/v1",
                        "simulation-clock/v1", "wall-clock/v1", List.of(new MediaProductionAdmissionBinding.ClockConversion(
                                "story-clock/v1", "media-clock/v1", new MediaProductionAdmissionBinding.Rational(1, 1)))),
                Map.of("scene/1@v3", sourceAuthority));
    }

    private static MediaProductionAdmissionBinding.Binding withSourceBindings(
            MediaProductionAdmissionBinding.Binding binding,
            Map<String, MediaProductionAdmissionBinding.SceneSourceAuthority> sourceBindings) {
        return new MediaProductionAdmissionBinding.Binding(binding.schemaVersion(), binding.projectId(),
                binding.expectedProjectRevision(), binding.requestIdentity(), binding.enginesByStep(),
                binding.provider(), binding.reservation(), binding.authority(), binding.editLocksByStep(),
                binding.clocks(), sourceBindings);
    }

    private record GraphFixture(MediaVersionedContractContent.ResolvedContent content,
                                MediaVersionedContractContent.ResolvedContentFingerprint fingerprint) { }

    private static GraphFixture graphFixture(MediaProductionSemanticSource source) throws Exception {
        Map<String, Object> bindings = Map.of("productionSpecRef", SPEC, "productionSpecSha256", D1,
                "productionSpecSchemaRef", SCHEMA, "productionSpecSchemaSha256", D2,
                "compilerContractRef", COMPILER, "compilerContractSha256", D3);
        List<Map<String, Object>> nodes = source.nodes().stream().map(node -> {
            Map<String, Object> value = new LinkedHashMap<>();
            value.put("stepId", node.stepId()); value.put("kind", node.kind());
            value.put("operationRef", node.operationRef());
            value.put("inputArtifactVersionRefs", node.inputArtifactVersionRefs());
            value.put("outputArtifactVersionRefs", node.outputArtifactVersionRefs());
            value.put("dependsOn", node.dependsOn()); value.put("sourceSceneRefs", node.sourceSceneRefs());
            value.put("manualLockTarget", node.manualLockTarget().<Object>map(lock ->
                    Map.of("scopeKind", lock.scopeKind(), "targetRef", lock.targetRef())).orElse(null));
            return value;
        }).toList();
        byte[] bytes = JSON.writeValueAsBytes(Map.of("schemaVersion", source.schemaVersion(),
                "sourceBindings", bindings, "nodes", nodes));
        String digest = digest(bytes);
        return new GraphFixture(new MediaVersionedContractContent.ResolvedContent(SEMANTIC_REF, bytes, digest),
                new MediaVersionedContractContent.ResolvedContentFingerprint(SEMANTIC_REF, digest, bytes.length));
    }

    private static List<MediaVersionedContractContent.ResolvedContentFingerprint> resolvedWithSemanticSource(
            GraphFixture fixture) {
        var values = new java.util.ArrayList<>(resolved());
        values.add(fixture.fingerprint());
        return List.copyOf(values);
    }

    private static List<MediaVersionedContractContent.ResolvedContentFingerprint> resolvedWithSemanticSourceAndOperation(
            GraphFixture fixture) {
        var values = new java.util.ArrayList<>(resolvedWithSemanticSource(fixture));
        values.add(new MediaVersionedContractContent.ResolvedContentFingerprint(
                "operation-definition/rev-1", D1, 42));
        return List.copyOf(values);
    }

    private static MediaProductionSemanticSource.CompilationResult compile(
            MediaProductionSpecCompiler compiler, MediaProductionSemanticSource source,
            List<MediaVersionedContractContent.ResolvedContentFingerprint> inputFingerprints,
            Map<String, Integer> operationCounts) throws Exception {
        return compile(compiler, source, inputs(), inputFingerprints, operationCounts);
    }

    private static MediaProductionSemanticSource.CompilationResult compile(
            MediaProductionSpecCompiler compiler, MediaProductionSemanticSource source,
            MediaProductionSpecCompiler.CompilationInputs expectedInputs,
            List<MediaVersionedContractContent.ResolvedContentFingerprint> inputFingerprints,
            Map<String, Integer> operationCounts) throws Exception {
        var fixture = graphFixture(source);
        var allFingerprints = new java.util.ArrayList<>(inputFingerprints);
        allFingerprints.add(fixture.fingerprint());
        return compiler.compileSemanticSource(Optional.of(fixture.content()), SEMANTIC_REF, fixture.fingerprint().sha256(),
                expectedInputs, allFingerprints, operationCounts);
    }

    private static String digest(byte[] bytes) throws NoSuchAlgorithmException {
        return "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    @Test
    void normalizesGraphAndFingerprintIndependentlyOfSourceNodeOrder() throws Exception {
        var compiler = new MediaProductionSpecCompiler();
        var a = source(List.of(node("z-step", "DETERMINISTIC", List.of("a-step")),
                node("a-step", "GENERATIVE", List.of())));
        var b = source(List.of(node("a-step", "GENERATIVE", List.of()),
                node("z-step", "DETERMINISTIC", List.of("a-step"))));

        var result = a.compileSyntaxCheckedGraphCandidate(inputs(), resolvedWithOperation(), operationEvidence());
        var repeat = b.compileSyntaxCheckedGraphCandidate(inputs(), resolvedWithOperation(), operationEvidence());
        var identicalRepeat = a.compileSyntaxCheckedGraphCandidate(inputs(), resolvedWithOperation(), operationEvidence());
        assertThat(result.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(result.nodes()).extracting(MediaProductionSemanticSource.NormalizedNode::stepId)
                .containsExactly("a-step", "z-step");
        assertThat(result.nodes()).extracting(MediaProductionSemanticSource.NormalizedNode::operationRef)
                .containsExactly(OP, OP);
        assertThat(result.nodes()).isEqualTo(repeat.nodes());
        assertThat(result.fingerprint()).isEqualTo(repeat.fingerprint()); // Node order does not affect the normalized graph.
        assertThat(result.fingerprint()).isEqualTo(identicalRepeat.fingerprint());
        assertThat(result.fingerprint()).startsWith("sha256:");
    }

    @Test
    void returnsTypedUnknownForAbsentUnknownOrUnresolvedAmbiguousInputs() throws Exception {
        var compiler = new MediaProductionSpecCompiler();
        assertResult(compiler.compileSemanticSource(Optional.empty(), null, null, inputs(), resolved(), Map.of()),
                MediaProductionSemanticSource.Disposition.UNKNOWN, MediaProductionSemanticSource.Reason.ABSENT_GRAPH);
        assertResult(compile(compiler, source(List.of(node("step", "MAYBE", List.of()))), resolved(), Map.of(OP, 1)),
                MediaProductionSemanticSource.Disposition.UNKNOWN, MediaProductionSemanticSource.Reason.UNKNOWN_NODE_KIND);
        assertResult(compile(compiler, source(List.of(node("step", "DETERMINISTIC", List.of()))), resolved(), Map.of()),
                MediaProductionSemanticSource.Disposition.UNKNOWN, MediaProductionSemanticSource.Reason.UNRESOLVED_OPERATION);
        assertResult(compile(compiler, source(List.of(node("step", "DETERMINISTIC", List.of()))), resolved(), Map.of(OP, 2)),
                MediaProductionSemanticSource.Disposition.UNKNOWN, MediaProductionSemanticSource.Reason.AMBIGUOUS_OPERATION);
        assertResult(compile(compiler, source(List.of(node("step", "DETERMINISTIC", List.of()))),
                        new MediaProductionSpecCompiler.CompilationInputs("other/spec@v1", SCHEMA,
                                MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION, COMPILER), resolved(), Map.of(OP, 1)),
                MediaProductionSemanticSource.Disposition.UNKNOWN, MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);
        assertResult(source(List.of(node("step", "DETERMINISTIC", List.of("absent"))))
                        .compileSyntaxCheckedGraphCandidate(inputs(), resolvedWithOperation(), operationEvidence()),
                MediaProductionSemanticSource.Disposition.UNKNOWN, MediaProductionSemanticSource.Reason.MISSING_DEPENDENCY);
    }

    @Test
    void operationDefinitionEvidenceIsVerifiedButDoesNotChangeStructuralGraphFingerprint() {
        var semantic = source(List.of(node("step", "DETERMINISTIC", List.of())));
        String definitionRef = "operation-definition/rev-1";
        var definitionFingerprint = new MediaVersionedContractContent.ResolvedContentFingerprint(definitionRef, D1, 42);
        var resolvedWithOperation = new java.util.ArrayList<>(resolved());
        resolvedWithOperation.add(definitionFingerprint);

        var evidence = new MediaProductionSemanticSource.OperationResolutionEvidence(List.of(
                new MediaProductionSemanticSource.OperationDefinitionBinding(OP, definitionRef, D1)));
        var candidate = semantic.compileSyntaxCheckedGraphCandidate(inputs(), resolvedWithOperation, evidence);
        assertThat(candidate.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(candidate.reason()).isEqualTo(MediaProductionSemanticSource.Reason.NONE);
        assertThat(candidate.nodes()).hasSize(1);
        assertThat(candidate.fingerprint()).startsWith("sha256:");

        var changedEvidence = new MediaProductionSemanticSource.OperationResolutionEvidence(List.of(
                new MediaProductionSemanticSource.OperationDefinitionBinding(OP, "operation-definition/rev-2", D2)));
        var resolvedWithChangedOperation = new java.util.ArrayList<>(resolvedWithOperation);
        resolvedWithChangedOperation.add(new MediaVersionedContractContent.ResolvedContentFingerprint(
                "operation-definition/rev-2", D2, 43));
        var changed = semantic.compileSyntaxCheckedGraphCandidate(inputs(), resolvedWithChangedOperation, changedEvidence);
        assertThat(changed.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(changed.fingerprint()).isEqualTo(candidate.fingerprint());

        String secondOperation = "media.operation.second";
        String secondDefinition = "operation-definition/second-v1";
        var twoOperations = source(List.of(node("step-a", "DETERMINISTIC", List.of()),
                new MediaProductionSemanticSource.Node("step-b", "GENERATIVE", secondOperation,
                        List.of(), List.of(), List.of("step-a"), List.of(), Optional.empty())));
        var twoOperationSources = new java.util.ArrayList<>(resolvedWithOperation);
        twoOperationSources.add(new MediaVersionedContractContent.ResolvedContentFingerprint(secondDefinition, D2, 44));
        var forwardEvidence = new MediaProductionSemanticSource.OperationResolutionEvidence(List.of(
                new MediaProductionSemanticSource.OperationDefinitionBinding(OP, definitionRef, D1),
                new MediaProductionSemanticSource.OperationDefinitionBinding(secondOperation, secondDefinition, D2)));
        var reverseEvidence = new MediaProductionSemanticSource.OperationResolutionEvidence(List.of(
                new MediaProductionSemanticSource.OperationDefinitionBinding(secondOperation, secondDefinition, D2),
                new MediaProductionSemanticSource.OperationDefinitionBinding(OP, definitionRef, D1)));
        var forward = twoOperations.compileSyntaxCheckedGraphCandidate(inputs(), twoOperationSources, forwardEvidence);
        var reverse = twoOperations.compileSyntaxCheckedGraphCandidate(inputs(), twoOperationSources, reverseEvidence);
        assertThat(forward.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(reverse.fingerprint()).isEqualTo(forward.fingerprint());

        var legacy = semantic.compileSyntaxCheckedGraphCandidate(inputs(), resolvedWithOperation, Map.of(OP, 1));
        assertThat(legacy.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(legacy.fingerprint()).isEqualTo(candidate.fingerprint());
    }

    @Test
    void operationDefinitionEvidenceRejectsMissingDuplicateStaleAndUnreferencedBindings() {
        var semantic = source(List.of(node("step", "DETERMINISTIC", List.of())));
        String definitionRef = "operation-definition/rev-1";
        var resolvedWithOperation = new java.util.ArrayList<>(resolved());
        resolvedWithOperation.add(new MediaVersionedContractContent.ResolvedContentFingerprint(definitionRef, D1, 42));

        assertResult(semantic.compileSyntaxCheckedGraphCandidate(inputs(), resolvedWithOperation,
                        new MediaProductionSemanticSource.OperationResolutionEvidence(List.of())),
                MediaProductionSemanticSource.Disposition.UNKNOWN, MediaProductionSemanticSource.Reason.UNRESOLVED_OPERATION);
        assertResult(semantic.compileSyntaxCheckedGraphCandidate(inputs(), resolvedWithOperation,
                        new MediaProductionSemanticSource.OperationResolutionEvidence(List.of(
                                new MediaProductionSemanticSource.OperationDefinitionBinding(OP, definitionRef, D1),
                                new MediaProductionSemanticSource.OperationDefinitionBinding(OP, definitionRef, D1)))),
                MediaProductionSemanticSource.Disposition.UNKNOWN, MediaProductionSemanticSource.Reason.AMBIGUOUS_OPERATION);
        assertResult(semantic.compileSyntaxCheckedGraphCandidate(inputs(), resolvedWithOperation,
                        new MediaProductionSemanticSource.OperationResolutionEvidence(List.of(
                                new MediaProductionSemanticSource.OperationDefinitionBinding(OP, definitionRef, D2)))),
                MediaProductionSemanticSource.Disposition.UNKNOWN, MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);
        assertResult(semantic.compileSyntaxCheckedGraphCandidate(inputs(), resolvedWithOperation,
                        new MediaProductionSemanticSource.OperationResolutionEvidence(List.of(
                                new MediaProductionSemanticSource.OperationDefinitionBinding("media.operation.other", definitionRef, D1)))),
                MediaProductionSemanticSource.Disposition.UNKNOWN, MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);
    }

    @Test
    void returnsUnknownForMismatchAndNotAdmittedForCycleOrUnboundedGraph() throws Exception {
        var compiler = new MediaProductionSpecCompiler();
        var mismatch = List.of(new MediaVersionedContractContent.ResolvedContentFingerprint(SPEC, D1, 10),
                new MediaVersionedContractContent.ResolvedContentFingerprint(SCHEMA, D2, 20),
                new MediaVersionedContractContent.ResolvedContentFingerprint(COMPILER, D1, 30));
        assertResult(compile(compiler, source(List.of(node("step", "DETERMINISTIC", List.of()))), mismatch, Map.of(OP, 1)),
                MediaProductionSemanticSource.Disposition.UNKNOWN, MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);

        var cycle = source(List.of(node("a", "DETERMINISTIC", List.of("b")), node("b", "GENERATIVE", List.of("a"))));
        assertResult(cycle.compileSyntaxCheckedGraphCandidate(inputs(), resolvedWithOperation(), operationEvidence()),
                MediaProductionSemanticSource.Disposition.NOT_ADMITTED, MediaProductionSemanticSource.Reason.CYCLIC_GRAPH);

        assertThatThrownBy(() -> source(java.util.stream.IntStream.range(0, MediaProductionSemanticSource.MAX_NODES + 1)
                .mapToObj(i -> node("step-" + i, "DETERMINISTIC", List.of())).toList()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void candidateBindingUsesExactInputThreeStepIdsWithoutLegacyFixedDagConstraint() throws Exception {
        var semantic = source(List.of(
                boundNode("step-a", List.of(), List.of("scene/1@v3"),
                        Optional.of(new MediaProductionSemanticSource.LockTarget("SCENE", "scene/1@v3"))),
                boundNode("step-b", List.of("step-a"), List.of(), Optional.empty()),
                boundNode("step-c", List.of(), List.of(), Optional.empty())));
        var compiler = new MediaProductionSpecCompiler();
        var inputs = inputs();
        var graphContent = graphFixture(semantic);
        var allFingerprints = resolvedWithSemanticSource(graphContent);
        var base = compiler.bindSemanticSourceCandidate(Optional.of(graphContent.content()), SEMANTIC_REF, graphContent.fingerprint().sha256(),
                inputs, productionSpec(), binding(null, D1), allFingerprints, Map.of(OP, 1));
        assertThat(base.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(base.reason()).isEqualTo(MediaProductionSemanticSource.Reason.NONE);
        assertThat(base.candidateFingerprint()).matches("sha256:[0-9a-f]{64}");

        var operationFingerprints = resolvedWithSemanticSourceAndOperation(graphContent);
        var typedBase = compiler.bindSemanticSourceCandidate(Optional.of(graphContent.content()), SEMANTIC_REF,
                graphContent.fingerprint().sha256(), inputs, productionSpec(), binding(null, D1),
                operationFingerprints, operationEvidence());
        assertThat(typedBase.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(typedBase.reason()).isEqualTo(MediaProductionSemanticSource.Reason.NONE);
        assertThat(typedBase.candidateFingerprint()).matches("sha256:[0-9a-f]{64}");

        var identical = compiler.bindSemanticSourceCandidate(Optional.of(graphContent.content()), SEMANTIC_REF,
                graphContent.fingerprint().sha256(), inputs, productionSpec(), binding(null, D1),
                operationFingerprints, operationEvidence());
        assertThat(identical.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(identical.candidateFingerprint()).isEqualTo(typedBase.candidateFingerprint());

        var changedEngineDigest = compiler.bindSemanticSourceCandidate(Optional.of(graphContent.content()), SEMANTIC_REF,
                graphContent.fingerprint().sha256(), inputs, productionSpec(), binding("step-b", D2),
                operationFingerprints, operationEvidence());
        assertThat(changedEngineDigest.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(changedEngineDigest.candidateFingerprint()).isNotEqualTo(typedBase.candidateFingerprint());

        var fixedPlanIds = List.of("validate-spec", "rights-review", "capture-source-0", "compose-timeline",
                "render-profile-0", "publish-review");
        var fixedPlanLocks = Map.of(
                "capture-source-0", new MediaProductionSemanticSource.LockTarget("SCENE", "scene/1@v3"),
                "render-profile-0", new MediaProductionSemanticSource.LockTarget("OUTPUT", "profile/1080p@v4"));
        var fixedPlanBinding = binding(fixedPlanIds, fixedPlanLocks, null, D1);
        var graphWithArbitraryIds = compiler.bindSemanticSourceCandidate(Optional.of(graphContent.content()),
                SEMANTIC_REF, graphContent.fingerprint().sha256(), inputs, productionSpec(), fixedPlanBinding,
                operationFingerprints, operationEvidence());
        assertThat(graphWithArbitraryIds.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.NOT_ADMITTED);
        assertThat(graphWithArbitraryIds.reason()).isEqualTo(MediaProductionSemanticSource.Reason.EXECUTION_CONTEXT_MISMATCH);
        assertThat(graphWithArbitraryIds.candidateFingerprint()).isNull();

        // Exact key equality is required; an engine selection for a different step cannot bind by kind or position.
        var mismatchedEngineKeys = binding(List.of("step-a", "step-b", "other-step"), Map.of("step-a",
                new MediaProductionSemanticSource.LockTarget("SCENE", "scene/1@v3")), null, D1);
        var mismatched = compiler.bindSemanticSourceCandidate(Optional.of(graphContent.content()), SEMANTIC_REF,
                graphContent.fingerprint().sha256(), inputs, productionSpec(), mismatchedEngineKeys,
                operationFingerprints, operationEvidence());
        assertThat(mismatched.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.NOT_ADMITTED);
        assertThat(mismatched.reason()).isEqualTo(MediaProductionSemanticSource.Reason.EXECUTION_CONTEXT_MISMATCH);
        assertThat(mismatched.candidateFingerprint()).isNull();
    }

    @Test
    void exactFixedPlanStepJoinProducesCandidateWithoutOperationCompatibilityClaim() throws Exception {
        var semantic = source(List.of(
                node("validate-spec", "DETERMINISTIC", List.of()),
                node("rights-review", "DETERMINISTIC", List.of("validate-spec")),
                new MediaProductionSemanticSource.Node("capture-source-0", "DETERMINISTIC", OP,
                        List.of(), List.of("artifact/capture@v1"), List.of("rights-review"), List.of("scene/1@v3"),
                        Optional.of(new MediaProductionSemanticSource.LockTarget("SCENE", "scene/1@v3"))),
                node("compose-timeline", "DETERMINISTIC", List.of("capture-source-0")),
                new MediaProductionSemanticSource.Node("render-profile-0", "GENERATIVE", OP,
                        List.of(), List.of("artifact/render@v1"), List.of("compose-timeline"), List.of(),
                        Optional.of(new MediaProductionSemanticSource.LockTarget("OUTPUT", "profile/1080p@v4"))),
                node("publish-review", "DETERMINISTIC", List.of("render-profile-0"))));
        var compiler = new MediaProductionSpecCompiler();
        var graphContent = graphFixture(semantic);
        var fixedPlanIds = List.of("validate-spec", "rights-review", "capture-source-0", "compose-timeline",
                "render-profile-0", "publish-review");
        var locks = Map.of(
                "capture-source-0", new MediaProductionSemanticSource.LockTarget("SCENE", "scene/1@v3"),
                "render-profile-0", new MediaProductionSemanticSource.LockTarget("OUTPUT", "profile/1080p@v4"));
        var result = compiler.bindSemanticSourceCandidate(Optional.of(graphContent.content()), SEMANTIC_REF,
                graphContent.fingerprint().sha256(), inputs(), productionSpec(), binding(fixedPlanIds, locks, null, D1),
                resolvedWithSemanticSourceAndOperation(graphContent), operationEvidence());
        var repeat = compiler.bindSemanticSourceCandidate(Optional.of(graphContent.content()), SEMANTIC_REF,
                graphContent.fingerprint().sha256(), inputs(), productionSpec(), binding(fixedPlanIds, locks, null, D1),
                resolvedWithSemanticSourceAndOperation(graphContent), operationEvidence());
        assertThat(result.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(result.reason()).isEqualTo(MediaProductionSemanticSource.Reason.NONE);
        assertThat(result.candidateFingerprint()).matches("sha256:[0-9a-f]{64}");
        assertThat(result.candidateFingerprint()).isEqualTo(repeat.candidateFingerprint());
    }

    @Test
    void candidateBindRejectsSemanticRefDigestAndExactV3MappingMismatches() throws Exception {
        var semantic = source(List.of(boundNode("step-a", List.of(), List.of("scene/1@v3"),
                Optional.of(new MediaProductionSemanticSource.LockTarget("SCENE", "scene/1@v3"))),
                boundNode("step-b", List.of("step-a"), List.of(), Optional.empty()),
                boundNode("step-c", List.of(), List.of(), Optional.empty())));
        var compiler = new MediaProductionSpecCompiler();
        var graphContent = graphFixture(semantic);
        var allFingerprints = resolvedWithSemanticSource(graphContent);
        var good = compiler.bindSemanticSourceCandidate(Optional.of(graphContent.content()), SEMANTIC_REF, graphContent.fingerprint().sha256(),
                inputs(), productionSpec(), binding(null, D1), resolvedWithSemanticSourceAndOperation(graphContent), operationEvidence());
        assertThat(good.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(good.reason()).isEqualTo(MediaProductionSemanticSource.Reason.NONE);
        assertThat(good.candidateFingerprint()).matches("sha256:[0-9a-f]{64}");

        var wrongDigest = compiler.bindSemanticSourceCandidate(Optional.of(graphContent.content()), SEMANTIC_REF, D3,
                inputs(), productionSpec(), binding(null, D1), allFingerprints, Map.of(OP, 1));
        assertThat(wrongDigest.reason()).isEqualTo(MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);
        assertThat(wrongDigest.candidateFingerprint()).isNull();

        var noLock = new MediaProductionSemanticSource.Node("step-a", "DETERMINISTIC", OP,
                List.of(), List.of("artifact/a@v1"), List.of(), List.of("scene/1@v3"), Optional.empty());
        var noLockSource = source(List.of(noLock,
                boundNode("step-b", List.of("step-a"), List.of(), Optional.empty()),
                boundNode("step-c", List.of(), List.of(), Optional.empty())));
        var noLockContent = graphFixture(noLockSource);
        var mismatch = compiler.bindSemanticSourceCandidate(Optional.of(noLockContent.content()), SEMANTIC_REF,
                noLockContent.fingerprint().sha256(), inputs(), productionSpec(), binding(null, D1),
                resolvedWithSemanticSourceAndOperation(noLockContent), operationEvidence());
        assertThat(mismatch.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.NOT_ADMITTED);
        assertThat(mismatch.reason()).isEqualTo(MediaProductionSemanticSource.Reason.EXECUTION_CONTEXT_MISMATCH);
        assertThat(mismatch.candidateFingerprint()).isNull();

        var unresolved = compiler.bindSemanticSourceCandidate(Optional.of(graphContent.content()), SEMANTIC_REF,
                graphContent.fingerprint().sha256(), inputs(), productionSpec(), binding(null, D1),
                allFingerprints, Map.of());
        assertThat(unresolved.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.UNKNOWN);
        assertThat(unresolved.reason()).isEqualTo(MediaProductionSemanticSource.Reason.UNRESOLVED_OPERATION);
        assertThat(unresolved.candidateFingerprint()).isNull();

        var ambiguous = compiler.bindSemanticSourceCandidate(Optional.of(graphContent.content()), SEMANTIC_REF,
                graphContent.fingerprint().sha256(), inputs(), productionSpec(), binding(null, D1),
                allFingerprints, Map.of(OP, 2));
        assertThat(ambiguous.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.UNKNOWN);
        assertThat(ambiguous.reason()).isEqualTo(MediaProductionSemanticSource.Reason.AMBIGUOUS_OPERATION);
        assertThat(ambiguous.candidateFingerprint()).isNull();
    }

    @Test
    void semanticCandidateBindRequiresExactMultiSceneSourceEngineAndLockMappings() throws Exception {
        var spec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7",
                "REAL_CAPTURE", "purpose/v1", List.of("scene/1@v3", "scene/2@v4"),
                "timeline/main@v2", "rights/standard@v1", List.of("profile/1080p@v4"));
        var semantic = source(List.of(
                boundNode("step-a", List.of(), List.of("scene/1@v3"),
                        Optional.of(new MediaProductionSemanticSource.LockTarget("SCENE", "scene/1@v3"))),
                boundNode("step-b", List.of("step-a"), List.of("scene/2@v4"),
                        Optional.of(new MediaProductionSemanticSource.LockTarget("SCENE", "scene/2@v4"))),
                boundNode("step-c", List.of("step-b"), List.of(), Optional.empty())));
        var graphContent = graphFixture(semantic);
        var sources = resolvedWithSemanticSourceAndOperation(graphContent);
        var compiler = new MediaProductionSpecCompiler();
        var locks = Map.of(
                "step-a", new MediaProductionSemanticSource.LockTarget("SCENE", "scene/1@v3"),
                "step-b", new MediaProductionSemanticSource.LockTarget("SCENE", "scene/2@v4"));
        var sceneSources = Map.of(
                "scene/1@v3", new MediaProductionAdmissionBinding.SceneSourceAuthority(
                        "source/1@v1", D1, "rights/1@v1", "decision/1@v1", Instant.parse("2030-01-01T00:00:00Z"), 1),
                "scene/2@v4", new MediaProductionAdmissionBinding.SceneSourceAuthority(
                        "source/2@v1", D2, "rights/2@v1", "decision/2@v1", Instant.parse("2030-01-01T00:00:00Z"), 2));

        var exact = withSourceBindings(binding(List.of("step-a", "step-b", "step-c"), locks, null, D1), sceneSources);
        var candidate = compiler.bindSemanticSourceCandidate(Optional.of(graphContent.content()), SEMANTIC_REF,
                graphContent.fingerprint().sha256(), inputs(), spec, exact, sources, operationEvidence());
        assertThat(candidate.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(candidate.reason()).isEqualTo(MediaProductionSemanticSource.Reason.NONE);
        assertThat(candidate.candidateFingerprint()).matches("sha256:[0-9a-f]{64}");

        var missingScene = withSourceBindings(exact, Map.of("scene/1@v3", sceneSources.get("scene/1@v3")));
        var extraScene = withSourceBindings(exact, Map.of(
                "scene/1@v3", sceneSources.get("scene/1@v3"),
                "scene/2@v4", sceneSources.get("scene/2@v4"),
                "scene/extra@v1", sceneSources.get("scene/2@v4")));
        var wrongScene = withSourceBindings(exact, Map.of(
                "scene/1@v3", sceneSources.get("scene/1@v3"),
                "scene/replaced@v1", sceneSources.get("scene/2@v4")));
        var mismatchedEngineKeys = withSourceBindings(
                binding(List.of("step-a", "step-c", "step-extra"), locks, null, D1), sceneSources);
        var missingLock = withSourceBindings(
                binding(List.of("step-a", "step-b", "step-c"), Map.of("step-a", locks.get("step-a")), null, D1),
                sceneSources);
        var extraLock = withSourceBindings(binding(List.of("step-a", "step-b", "step-c"), Map.of(
                "step-a", locks.get("step-a"), "step-b", locks.get("step-b"),
                "step-c", new MediaProductionSemanticSource.LockTarget("OUTPUT", "profile/1080p@v4")), null, D1),
                sceneSources);
        var wrongLockScope = withSourceBindings(binding(List.of("step-a", "step-b", "step-c"), Map.of(
                "step-a", locks.get("step-a"),
                "step-b", new MediaProductionSemanticSource.LockTarget("OUTPUT", "scene/2@v4")), null, D1),
                sceneSources);
        var wrongLockTarget = withSourceBindings(binding(List.of("step-a", "step-b", "step-c"), Map.of(
                "step-a", locks.get("step-a"),
                "step-b", new MediaProductionSemanticSource.LockTarget("SCENE", "scene/1@v3")), null, D1),
                sceneSources);

        for (var invalid : List.of(missingScene, extraScene, wrongScene, mismatchedEngineKeys,
                missingLock, extraLock, wrongLockScope, wrongLockTarget)) {
            var rejected = compiler.bindSemanticSourceCandidate(Optional.of(graphContent.content()), SEMANTIC_REF,
                    graphContent.fingerprint().sha256(), inputs(), spec, invalid, sources, operationEvidence());
            assertThat(rejected.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.NOT_ADMITTED);
            assertThat(rejected.reason()).isEqualTo(MediaProductionSemanticSource.Reason.EXECUTION_CONTEXT_MISMATCH);
            assertThat(rejected.candidateFingerprint()).isNull();
        }

        var outOfSpecSceneGraph = source(List.of(
                boundNode("step-a", List.of(), List.of("scene/1@v3"),
                        Optional.of(new MediaProductionSemanticSource.LockTarget("SCENE", "scene/1@v3"))),
                boundNode("step-b", List.of("step-a"), List.of("scene/3@v1"),
                        Optional.of(new MediaProductionSemanticSource.LockTarget("SCENE", "scene/2@v4"))),
                boundNode("step-c", List.of("step-b"), List.of(), Optional.empty())));
        var outOfSpecContent = graphFixture(outOfSpecSceneGraph);
        var outOfSpecRejected = compiler.bindSemanticSourceCandidate(Optional.of(outOfSpecContent.content()), SEMANTIC_REF,
                outOfSpecContent.fingerprint().sha256(), inputs(), spec, exact,
                resolvedWithSemanticSourceAndOperation(outOfSpecContent), operationEvidence());
        assertThat(outOfSpecRejected.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.NOT_ADMITTED);
        assertThat(outOfSpecRejected.reason()).isEqualTo(MediaProductionSemanticSource.Reason.EXECUTION_CONTEXT_MISMATCH);
        assertThat(outOfSpecRejected.candidateFingerprint()).isNull();
    }

    @Test
    void graphMustBeResolvedAtExactRefAndClosedJsonBytesBeforeCandidateCompilation() throws Exception {
        var semantic = source(List.of(node("step", "DETERMINISTIC", List.of())));
        var fixture = graphFixture(semantic);
        var compiler = new MediaProductionSpecCompiler();
        var wrongRef = compiler.compileSemanticSource(Optional.of(new MediaVersionedContractContent.ResolvedContent(
                        "semantic-source/other", fixture.content().content(), fixture.fingerprint().sha256())),
                SEMANTIC_REF, fixture.fingerprint().sha256(), inputs(), resolvedWithSemanticSource(fixture), Map.of(OP, 1));
        assertThat(wrongRef.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.UNKNOWN);
        assertThat(wrongRef.reason()).isEqualTo(MediaProductionSemanticSource.Reason.INVALID_SEMANTIC_SOURCE_CONTENT);

        String malformedJson = new String(fixture.content().content(), StandardCharsets.UTF_8)
                .replaceFirst("}$", ",\"unrecognized\":true}");
        byte[] malformedBytes = malformedJson.getBytes(StandardCharsets.UTF_8);
        String malformedDigest = digest(malformedBytes);
        var malformedContent = new MediaVersionedContractContent.ResolvedContent(SEMANTIC_REF, malformedBytes, malformedDigest);
        var malformedFingerprint = new MediaVersionedContractContent.ResolvedContentFingerprint(
                SEMANTIC_REF, malformedDigest, malformedBytes.length);
        var sourceFingerprints = new java.util.ArrayList<>(resolved());
        sourceFingerprints.add(malformedFingerprint);
        var malformed = compiler.compileSemanticSource(Optional.of(malformedContent), SEMANTIC_REF,
                malformedDigest, inputs(), sourceFingerprints, Map.of(OP, 1));
        assertThat(malformed.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.UNKNOWN);
        assertThat(malformed.reason()).isEqualTo(MediaProductionSemanticSource.Reason.INVALID_SEMANTIC_SOURCE_CONTENT);

        String validJson = new String(fixture.content().content(), StandardCharsets.UTF_8);
        List<String> strictFailures = List.of(
                validJson.replaceFirst("^\\{", "{\"schemaVersion\":\"duplicate\","),
                validJson + " {} ");
        for (String strictFailure : strictFailures) {
            byte[] strictBytes = strictFailure.getBytes(StandardCharsets.UTF_8);
            String strictDigest = digest(strictBytes);
            var strictContent = new MediaVersionedContractContent.ResolvedContent(SEMANTIC_REF, strictBytes, strictDigest);
            var strictFingerprint = new MediaVersionedContractContent.ResolvedContentFingerprint(
                    SEMANTIC_REF, strictDigest, strictBytes.length);
            var strictSources = new java.util.ArrayList<>(resolved()); strictSources.add(strictFingerprint);
            var rejected = compiler.compileSemanticSource(Optional.of(strictContent), SEMANTIC_REF,
                    strictDigest, inputs(), strictSources, Map.of(OP, 1));
            assertThat(rejected.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.UNKNOWN);
            assertThat(rejected.reason()).isEqualTo(MediaProductionSemanticSource.Reason.INVALID_SEMANTIC_SOURCE_CONTENT);
        }
    }

    @Test
    void alreadyResolvedSemanticSourceBindsExactOperationDefinitionEvidence() throws Exception {
        var fixture = graphFixture(source(List.of(node("step", "DETERMINISTIC", List.of()))));
        var compiler = new MediaProductionSpecCompiler();
        var resolvedInputs = resolvedWithSemanticSourceAndOperation(fixture);

        var typed = compiler.compileSemanticSource(Optional.of(fixture.content()), SEMANTIC_REF,
                fixture.fingerprint().sha256(), inputs(), resolvedInputs, operationEvidence());
        assertThat(typed.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(typed.fingerprint()).matches("sha256:[0-9a-f]{64}");

        var countOnly = compiler.compileSemanticSource(Optional.of(fixture.content()), SEMANTIC_REF,
                fixture.fingerprint().sha256(), inputs(), resolvedInputs, Map.of(OP, 1));
        assertThat(countOnly.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(countOnly.fingerprint()).isEqualTo(typed.fingerprint());
    }

    @Test
    void resolvedInputCandidateValidatesExactBytesAndPreservesExplicitGraphWithoutInferringSemantics() throws Exception {
        var compiler = new MediaProductionSpecCompiler();
        var spec = productionSpec();
        var inputs = inputs();
        var first = new MediaProductionSemanticSource.Node("step-z", "DETERMINISTIC", OP,
                List.of("asset/source@v1"), List.of("asset/intermediate@v1"), List.of(),
                List.of("scene/1@v3"), Optional.empty());
        var second = new MediaProductionSemanticSource.Node("step-a", "GENERATIVE", OP2,
                List.of("asset/input@v9"), List.of("asset/output@v2"), List.of("step-z"),
                List.of(), Optional.empty());

        var firstInputs = resolvedCompilerInputs(spec, inputs, compilerContract(spec, inputs, List.of(second, first)));
        var reorderedInputs = resolvedCompilerInputs(spec, inputs, compilerContract(spec, inputs, List.of(first, second)));
        var candidate = compiler.compileSemanticSourceFromResolvedInputs(spec, inputs,
                ref -> firstInputs.get(ref), Map.of(OP, 1, OP2, 1));
        var repeat = compiler.compileSemanticSourceFromResolvedInputs(spec, inputs,
                ref -> firstInputs.get(ref), Map.of(OP, 1, OP2, 1));
        var reordered = compiler.compileSemanticSourceFromResolvedInputs(spec, inputs,
                ref -> reorderedInputs.get(ref), Map.of(OP, 1, OP2, 1));

        assertThat(candidate.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(candidate.reason()).isEqualTo(MediaProductionSemanticSource.Reason.NONE);
        assertThat(candidate.nodes()).extracting(MediaProductionSemanticSource.NormalizedNode::stepId)
                .containsExactly("step-z", "step-a");
        assertThat(candidate.nodes()).extracting(MediaProductionSemanticSource.NormalizedNode::kind)
                .containsExactly(MediaProductionSemanticSource.NodeKind.DETERMINISTIC,
                        MediaProductionSemanticSource.NodeKind.GENERATIVE);
        assertThat(candidate.nodes()).extracting(MediaProductionSemanticSource.NormalizedNode::operationRef)
                .containsExactly(OP, OP2);
        assertThat(candidate.fingerprint()).isEqualTo(repeat.fingerprint());
        assertThat(reordered.nodes()).isEqualTo(candidate.nodes()); // Normalization is independent of input order.
        assertThat(reordered.fingerprint()).isNotEqualTo(candidate.fingerprint()); // Exact compiler-contract bytes stay bound.
        assertThat(candidate.fingerprint()).matches("sha256:[0-9a-f]{64}");
    }

    @Test
    void resolvedInputCandidateReturnsUnknownForMissingOrMalformedVersionedContent() throws Exception {
        var compiler = new MediaProductionSpecCompiler();
        var spec = productionSpec();
        var inputs = inputs();
        var content = resolvedCompilerInputs(spec, inputs,
                compilerContract(spec, inputs, List.of(node("step", "DETERMINISTIC", List.of()))));

        var unresolved = compiler.compileSemanticSourceFromResolvedInputs(spec, inputs, ref -> {
            if (ref.equals(inputs.compilerContractRef())) throw new IllegalStateException("unavailable");
            return content.get(ref);
        }, Map.of(OP, 1));
        assertResult(unresolved, MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.UNRESOLVED_SOURCE_BINDING);

        for (String malformed : List.of(
                "{\"schemaVersion\":\"media.production.compiler-contract.v1\",\"schemaVersion\":\"duplicate\"}",
                new String(content.get(inputs.compilerContractRef()).content(), StandardCharsets.UTF_8) + " {}",
                "{\"schemaVersion\":\"media.production.compiler-contract.v1\",\"unexpected\":true}")) {
            byte[] bytes = malformed.getBytes(StandardCharsets.UTF_8);
            var malformedContent = new MediaVersionedContractContent.ResolvedContent(
                    inputs.compilerContractRef(), bytes, digest(bytes));
            var rejected = compiler.compileSemanticSourceFromResolvedInputs(spec, inputs,
                    ref -> ref.equals(inputs.compilerContractRef()) ? malformedContent : content.get(ref), Map.of(OP, 1));
            assertResult(rejected, MediaProductionSemanticSource.Disposition.UNKNOWN,
                    MediaProductionSemanticSource.Reason.INVALID_SEMANTIC_SOURCE_CONTENT);
        }

        var wrongTarget = compilerContract(spec, inputs, List.of(node("step", "DETERMINISTIC", List.of())))
                .replace(inputs.productionSpecRef(), "production-spec/different");
        var targetMismatchContent = resolvedCompilerInputs(spec, inputs, wrongTarget);
        var mismatch = compiler.compileSemanticSourceFromResolvedInputs(spec, inputs,
                ref -> targetMismatchContent.get(ref), Map.of(OP, 1));
        assertResult(mismatch, MediaProductionSemanticSource.Disposition.UNKNOWN,
                MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);
    }

    private static Map<String, MediaVersionedContractContent.ResolvedContent> resolvedCompilerInputs(
            MediaProductionSpecCompiler.ProductionSpec spec,
            MediaProductionSpecCompiler.CompilationInputs inputs,
            String contract) throws Exception {
        var values = new LinkedHashMap<String, MediaVersionedContractContent.ResolvedContent>();
        byte[] specBytes = JSON.writeValueAsBytes(spec);
        byte[] schemaBytes = productionSpecSchema().getBytes(StandardCharsets.UTF_8);
        values.put(inputs.productionSpecRef(), resolvedContent(inputs.productionSpecRef(), specBytes));
        values.put(inputs.productionSpecSchemaRef(), resolvedContent(inputs.productionSpecSchemaRef(), schemaBytes));
        values.put(inputs.compilerContractRef(), resolvedContent(inputs.compilerContractRef(), contract.getBytes(StandardCharsets.UTF_8)));
        return Map.copyOf(values);
    }

    private static MediaVersionedContractContent.ResolvedContent resolvedContent(String ref, byte[] bytes) throws Exception {
        return new MediaVersionedContractContent.ResolvedContent(ref, bytes, digest(bytes));
    }

    private static String compilerContract(MediaProductionSpecCompiler.ProductionSpec spec,
            MediaProductionSpecCompiler.CompilationInputs inputs,
            List<MediaProductionSemanticSource.Node> steps) throws Exception {
        byte[] specBytes = JSON.writeValueAsBytes(spec);
        String specDigest = digest(specBytes);
        String schemaDigest = digest(productionSpecSchema().getBytes(StandardCharsets.UTF_8));
        List<Map<String, Object>> serializedSteps = steps.stream().<Map<String, Object>>map(step -> {
            var value = new LinkedHashMap<String, Object>();
            value.put("stepId", step.stepId()); value.put("kind", step.kind()); value.put("operationRef", step.operationRef());
            value.put("inputArtifactVersionRefs", step.inputArtifactVersionRefs());
            value.put("outputArtifactVersionRefs", step.outputArtifactVersionRefs());
            value.put("dependsOn", step.dependsOn()); value.put("sourceSceneRefs", step.sourceSceneRefs());
            value.put("manualLockTarget", step.manualLockTarget().<Object>map(lock ->
                    Map.of("scopeKind", lock.scopeKind(), "targetRef", lock.targetRef())).orElse(null));
            return value;
        }).toList();
        return JSON.writeValueAsString(Map.of("schemaVersion", MediaProductionSpecCompiler.PRODUCTION_COMPILER_CONTRACT_SCHEMA_VERSION,
                "targetProductionSpecRef", inputs.productionSpecRef(), "targetProductionSpecSha256", specDigest,
                "targetProductionSpecSchemaRef", inputs.productionSpecSchemaRef(), "targetProductionSpecSchemaSha256", schemaDigest,
                "steps", serializedSteps));
    }

    private static String productionSpecSchema() {
        try (var stream = MediaProductionSemanticSourceTest.class.getResourceAsStream(
                "/contracts/media-production-spec-v1.schema.json")) {
            if (stream == null) throw new IllegalStateException("generated PDP-1 production-spec schema resource is missing");
            return new String(stream.readAllBytes(), StandardCharsets.UTF_8);
        } catch (java.io.IOException failure) {
            throw new IllegalStateException("cannot read generated PDP-1 production-spec schema resource", failure);
        }
    }

    @Test
    void semanticFingerprintFramesUtf8BytesAndRejectsMalformedOrWhitespaceReferences() throws Exception {
        var unicodeNode = new MediaProductionSemanticSource.Node("step", "DETERMINISTIC", OP,
                List.of("artifact/café@v1"), List.of("artifact/naïve@v1"), List.of(), List.of(), Optional.empty());
        var semantic = source(List.of(unicodeNode));
        var fixture = graphFixture(semantic);
        var result = new MediaProductionSpecCompiler().compileSemanticSource(Optional.of(fixture.content()),
                SEMANTIC_REF, fixture.fingerprint().sha256(), inputs(),
                resolvedWithSemanticSourceAndOperation(fixture), operationEvidence());
        assertThat(result.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED);
        assertThat(result.fingerprint()).isEqualTo(expectedUtf8Fingerprint(semantic));

        assertThatThrownBy(() -> new MediaProductionSemanticSource.Node("step", "DETERMINISTIC", "operation/\uD800",
                List.of(), List.of(), List.of(), List.of(), Optional.empty())).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaProductionSemanticSource.Node("step", "DETERMINISTIC", OP,
                List.of("artifact/\uD800@v1"), List.of(), List.of(), List.of(), Optional.empty()))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaProductionSemanticSource.Node("step", "DETERMINISTIC", OP,
                List.of("artifact/has\u00A0space@v1"), List.of(), List.of(), List.of(), Optional.empty()))
                .isInstanceOf(IllegalArgumentException.class);
        for (String whitespace : List.of(" ", "\t", "\n", "\u001C", "\u001F",
                "\u00A0", "\u3000", "\uFEFF")) {
            assertThatThrownBy(() -> new MediaProductionSemanticSource.Node("step", "DETERMINISTIC",
                    "operation/left" + whitespace + "right", List.of(), List.of(), List.of(), List.of(), Optional.empty()))
                    .isInstanceOf(IllegalArgumentException.class);
        }
        assertThat(new MediaProductionSemanticSource.Node("step", "DETERMINISTIC",
                "operation/\u0085v1", List.of(), List.of(), List.of(), List.of(), Optional.empty()))
                .isNotNull();
        var invalidRefFixture = graphFixture(source(List.of(node("step", "DETERMINISTIC", List.of()))));
        assertThatThrownBy(() -> new MediaProductionSpecCompiler().compileSemanticSource(Optional.of(invalidRefFixture.content()),
                "semantic-source/\uD800", invalidRefFixture.fingerprint().sha256(), inputs(),
                resolvedWithSemanticSource(invalidRefFixture), Map.of(OP, 1)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaProductionSpecCompiler().compileSemanticSource(Optional.of(invalidRefFixture.content()),
                "semantic-source/\u001C", invalidRefFixture.fingerprint().sha256(), inputs(),
                resolvedWithSemanticSource(invalidRefFixture), Map.of(OP, 1)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void semanticListBoundsMatchSchemaAndDecoder() throws Exception {
        var tooMany = java.util.stream.IntStream.range(0, MediaProductionSemanticSource.MAX_REFERENCES_PER_NODE + 1)
                .mapToObj(i -> "artifact/input-" + i + "@v1").toList();
        assertThatThrownBy(() -> new MediaProductionSemanticSource.Node("step", "DETERMINISTIC", OP,
                tooMany, List.of(), List.of(), List.of(), Optional.empty())).isInstanceOf(IllegalArgumentException.class);

        Map<String, Object> sourceBindings = Map.of("productionSpecRef", SPEC, "productionSpecSha256", D1,
                "productionSpecSchemaRef", SCHEMA, "productionSpecSchemaSha256", D2,
                "compilerContractRef", COMPILER, "compilerContractSha256", D3);
        Map<String, Object> invalidNode = new LinkedHashMap<>();
        invalidNode.put("stepId", "step"); invalidNode.put("kind", "DETERMINISTIC"); invalidNode.put("operationRef", OP);
        invalidNode.put("inputArtifactVersionRefs", tooMany); invalidNode.put("outputArtifactVersionRefs", List.of());
        invalidNode.put("dependsOn", List.of()); invalidNode.put("sourceSceneRefs", List.of());
        invalidNode.put("manualLockTarget", null);
        byte[] bytes = JSON.writeValueAsBytes(Map.of("schemaVersion", MediaProductionSemanticSource.SCHEMA_VERSION,
                "sourceBindings", sourceBindings, "nodes", List.of(invalidNode)));
        String hash = digest(bytes);
        var content = new MediaVersionedContractContent.ResolvedContent(SEMANTIC_REF, bytes, hash);
        var fingerprint = new MediaVersionedContractContent.ResolvedContentFingerprint(SEMANTIC_REF, hash, bytes.length);
        var sources = new java.util.ArrayList<>(resolved()); sources.add(fingerprint);
        var result = new MediaProductionSpecCompiler().compileSemanticSource(Optional.of(content), SEMANTIC_REF,
                hash, inputs(), sources, Map.of(OP, 1));
        assertThat(result.disposition()).isEqualTo(MediaProductionSemanticSource.Disposition.UNKNOWN);
        assertThat(result.reason()).isEqualTo(MediaProductionSemanticSource.Reason.INVALID_SEMANTIC_SOURCE_CONTENT);
    }

    @Test
    void semanticVersionReferenceLengthUsesCodePointsForAstralCharacters() {
        String exactly384CodePoints = "😀".repeat(384);
        assertThat(exactly384CodePoints.codePointCount(0, exactly384CodePoints.length())).isEqualTo(384);
        assertThat(new MediaProductionSemanticSource.SourceBindings(exactly384CodePoints, D1,
                SCHEMA, D2, COMPILER, D3).productionSpecRef()).isEqualTo(exactly384CodePoints);

        String overLimit = "😀".repeat(385);
        assertThat(overLimit.codePointCount(0, overLimit.length())).isEqualTo(385);
        assertThatThrownBy(() -> new MediaProductionSemanticSource.SourceBindings(overLimit, D1,
                SCHEMA, D2, COMPILER, D3)).isInstanceOf(IllegalArgumentException.class);
    }

    private static String expectedUtf8Fingerprint(MediaProductionSemanticSource source) throws Exception {
        var b = source.sourceBindings();
        StringBuilder canonical = new StringBuilder();
        frame(canonical, MediaProductionSemanticSource.SCHEMA_VERSION);
        frame(canonical, b.productionSpecRef()); frame(canonical, b.productionSpecSha256());
        frame(canonical, b.productionSpecSchemaRef()); frame(canonical, b.productionSpecSchemaSha256());
        frame(canonical, b.compilerContractRef()); frame(canonical, b.compilerContractSha256());
        frame(canonical, "1");
        var node = source.nodes().getFirst();
        frame(canonical, node.stepId()); frame(canonical, node.kind()); frame(canonical, node.operationRef());
        frameList(canonical, node.inputArtifactVersionRefs()); frameList(canonical, node.outputArtifactVersionRefs());
        frameList(canonical, node.dependsOn()); frameList(canonical, node.sourceSceneRefs());
        frame(canonical, "NO_LOCK"); frame(canonical, "NO_LOCK");
        String graphDigest = digest(canonical.toString().getBytes(StandardCharsets.UTF_8));
        var fixture = graphFixture(source);
        StringBuilder artifactBinding = new StringBuilder();
        frame(artifactBinding, "media.production.semantic-source-artifact-binding.v1");
        frame(artifactBinding, SEMANTIC_REF); frame(artifactBinding, fixture.fingerprint().sha256());
        frame(artifactBinding, graphDigest);
        return digest(artifactBinding.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void frameList(StringBuilder target, List<String> values) {
        frame(target, Integer.toString(values.size())); values.forEach(value -> frame(target, value));
    }

    private static void frame(StringBuilder target, String value) {
        target.append(value.getBytes(StandardCharsets.UTF_8).length).append(':').append(value);
    }

    private static void assertResult(MediaProductionSemanticSource.CompilationResult result,
                                     MediaProductionSemanticSource.Disposition disposition,
                                     MediaProductionSemanticSource.Reason reason) {
        assertThat(result.disposition()).isEqualTo(disposition);
        assertThat(result.reason()).isEqualTo(reason);
        assertThat(result.nodes()).isEmpty();
        assertThat(result.fingerprint()).isNull();
    }
}
