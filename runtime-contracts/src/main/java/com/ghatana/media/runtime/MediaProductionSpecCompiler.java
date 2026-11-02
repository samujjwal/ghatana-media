package com.ghatana.media.runtime;

import com.networknt.schema.InputFormat;
import com.networknt.schema.Schema;
import com.networknt.schema.SchemaRegistry;
import com.networknt.schema.SchemaRegistryConfig;
import com.networknt.schema.SpecificationVersion;
import tools.jackson.core.StreamReadConstraints;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.lang.ref.Reference;
import java.lang.ref.ReferenceQueue;
import java.lang.ref.WeakReference;
import java.io.IOException;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;

/**
 * H-02: compile a typed production spec into a deterministic DAG of Media
 * plan steps bound to one canonical project revision.
 *
 * <p>Determinism contract: identical input yields an identical plan and
 * fingerprint. Each node carries its own fingerprint over (kind, dependency
 * fingerprints, version refs), so a source change invalidates only the
 * affected descendants — unchanged ancestors keep their identity. Manual
 * gates are explicit nodes: a plan never marks a human operation as done.
 *
 * @doc.type class
 * @doc.purpose Deterministic production-spec → plan DAG compiler
 * @doc.layer product
 * @doc.pattern Compiler
 */
public final class MediaProductionSpecCompiler {

    /** Process-local misuse guard only; it does not authenticate or attest serialized plans. */
    private static final ReferenceQueue<CompiledPlan> COMPILED_PLAN_QUEUE = new ReferenceQueue<>();
    private static final Set<CompiledPlanIdentityReference> COMPILER_ISSUED_PLANS = ConcurrentHashMap.newKeySet();
    private static final Set<String> PRODUCTION_SPEC_FIELDS = Set.of(
            "tenantId", "projectId", "revisionId", "schemaVersion", "originClass", "purposeRef",
            "sceneRefs", "timelineRef", "rightsRef", "outputProfileRefs");
    private static final ObjectMapper CONTRACT_JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION)
            .streamReadConstraints(StreamReadConstraints.builder()
                    .maxNestingDepth(64)
                    .maxDocumentLength(MediaVersionedContractContent.MAX_CONTENT_BYTES)
                    .maxTokenCount(20_000)
                    .maxStringLength(MediaVersionedContractContent.MAX_CONTENT_BYTES)
                    .maxNameLength(256)
                    .build())
            .build())
            .enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS)
            .build();
    private static final class CompiledPlanIdentityReference extends WeakReference<CompiledPlan> {
        private final int identityHashCode;

        private CompiledPlanIdentityReference(CompiledPlan plan, ReferenceQueue<CompiledPlan> queue) {
            super(Objects.requireNonNull(plan, "plan"), queue);
            identityHashCode = System.identityHashCode(plan);
        }

        @Override public int hashCode() { return identityHashCode; }

        @Override
        public boolean equals(Object other) {
            if (this == other) return true;
            if (!(other instanceof CompiledPlanIdentityReference that)) return false;
            CompiledPlan plan = get();
            return plan != null && plan == that.get();
        }
    }

    private static void drainCollectedPlans() {
        Reference<? extends CompiledPlan> collected;
        while ((collected = COMPILED_PLAN_QUEUE.poll()) != null) COMPILER_ISSUED_PLANS.remove(collected);
    }

    private static void markCompilerIssued(CompiledPlan plan) {
        drainCollectedPlans();
        COMPILER_ISSUED_PLANS.add(new CompiledPlanIdentityReference(plan, COMPILED_PLAN_QUEUE));
    }

    /** Package-local identity check; value-equal caller-created records are not compiler outputs. */
    static boolean isCompilerIssued(CompiledPlan plan) {
        if (plan == null) return false;
        drainCollectedPlans();
        return COMPILER_ISSUED_PLANS.contains(new CompiledPlanIdentityReference(plan, null));
    }

    /** Bounded plan size — a spec cannot compile an unbounded DAG. */
    public static final int MAX_SCENES = 256;
    public static final int MAX_OUTPUT_PROFILES = 64;
    public static final String PRODUCTION_SPEC_SCHEMA_VERSION = "media.declarative.value.production-spec.v1";
    public static final String PRODUCTION_COMPILER_CONTRACT_SCHEMA_VERSION = "media.production.compiler-contract.v1";

    /** Typed spec — the Java mirror of media.declarative.value.production-spec.v1. */
    public record ProductionSpec(
            String tenantId,
            String projectId,
            String revisionId,
            String schemaVersion,
            String originClass,
            String purposeRef,
            List<String> sceneRefs,
            String timelineRef,
            String rightsRef,
            List<String> outputProfileRefs) {
        /**
         * Source-compatible constructor for callers already receiving the one
         * PDP-1 production-spec version; schema decoders should use the full
         * constructor so an untrusted supplied version is validated.
         */
        public ProductionSpec(
                String tenantId,
                String projectId,
                String revisionId,
                String originClass,
                String purposeRef,
                List<String> sceneRefs,
                String timelineRef,
                String rightsRef,
                List<String> outputProfileRefs) {
            this(tenantId, projectId, revisionId, PRODUCTION_SPEC_SCHEMA_VERSION, originClass,
                    purposeRef, sceneRefs, timelineRef, rightsRef, outputProfileRefs);
        }

        public ProductionSpec {
            sceneRefs = List.copyOf(Objects.requireNonNull(sceneRefs, "sceneRefs"));
            outputProfileRefs = List.copyOf(Objects.requireNonNull(outputProfileRefs, "outputProfileRefs"));
            requireIdentifier(tenantId, "tenantId");
            requireIdentifier(projectId, "projectId");
            requireIdentifier(revisionId, "revisionId");
            if (!PRODUCTION_SPEC_SCHEMA_VERSION.equals(schemaVersion)) {
                throw new IllegalArgumentException("schemaVersion must be " + PRODUCTION_SPEC_SCHEMA_VERSION);
            }
            if (originClass == null || !Set.of("REAL_CAPTURE", "DECLARATIVE_ANIMATION", "MODEL_SIMULATION",
                    "GENERATIVE_MEDIA", "PDP_SYNTHETIC_FIXTURE").contains(originClass)) {
                throw new IllegalArgumentException("unsupported originClass");
            }
            requireVersionRef(purposeRef, "purposeRef");
            requireVersionRef(timelineRef, "timelineRef");
            requireVersionRef(rightsRef, "rightsRef");
            sceneRefs.forEach(ref -> requireVersionRef(ref, "sceneRef"));
            outputProfileRefs.forEach(ref -> requireVersionRef(ref, "outputProfileRef"));
            if (sceneRefs.isEmpty() || sceneRefs.size() > MAX_SCENES) {
                throw new IllegalArgumentException("sceneRefs must contain 1.." + MAX_SCENES + " refs");
            }
            if (new TreeSet<>(sceneRefs).size() != sceneRefs.size()) {
                throw new IllegalArgumentException("sceneRefs must not contain duplicates");
            }
            if (outputProfileRefs.isEmpty() || outputProfileRefs.size() > MAX_OUTPUT_PROFILES) {
                throw new IllegalArgumentException(
                        "outputProfileRefs must contain 1.." + MAX_OUTPUT_PROFILES + " refs");
            }
            if (new TreeSet<>(outputProfileRefs).size() != outputProfileRefs.size()) {
                throw new IllegalArgumentException("outputProfileRefs must not contain duplicates");
            }
        }
    }

    /** Whether a step executes automatically or awaits a manual operation lock. */
    public enum ExecutionMode { AUTOMATIC, MANUAL_GATE }

    /** One deterministic plan node in the DAG. */
    public record PlanNode(
            String stepId,
            String kind,
            ExecutionMode mode,
            List<String> dependsOn,
            List<String> versionRefs,
            String nodeFingerprint) {
        public PlanNode {
            dependsOn = List.copyOf(dependsOn);
            versionRefs = List.copyOf(versionRefs);
        }
    }

    /** Exact references for source-spec input 1 and contract inputs 2 and 3. */
    public record CompilationInputs(
            String productionSpecRef,
            String productionSpecSchemaRef,
            String productionSpecSchemaVersion,
            String compilerContractRef) {
        public CompilationInputs {
            requireVersionRef(productionSpecRef, "productionSpecRef");
            requireVersionRef(productionSpecSchemaRef, "productionSpecSchemaRef");
            requireVersionRef(productionSpecSchemaVersion, "productionSpecSchemaVersion");
            requireVersionRef(compilerContractRef, "compilerContractRef");
        }
    }

    /** Optional migration inputs; a positive transformation is unavailable until source-defined. */
    public record SchemaMigrationRequest(Optional<String> targetSchemaRef, Optional<String> transformationRef) {
        public SchemaMigrationRequest {
            targetSchemaRef = Objects.requireNonNull(targetSchemaRef, "targetSchemaRef");
            transformationRef = Objects.requireNonNull(transformationRef, "transformationRef");
            targetSchemaRef.ifPresent(ref -> requireVersionRef(ref, "targetSchemaRef"));
            transformationRef.ifPresent(ref -> requireVersionRef(ref, "transformationRef"));
        }
    }

    public enum SchemaMigrationDisposition {
        NOT_REQUESTED,
        UNKNOWN_INCOMPLETE_INPUTS,
        UNKNOWN_UNSUPPORTED_TRANSFORMATION
    }

    /**
     * Explicit fail-closed result for optional operation inputs 5 and 6. This
     * compiler currently has no source-declared supported transformation, so
     * the result deliberately carries no migration candidate.
     */
    public record SchemaMigrationAssessment(
            SchemaMigrationDisposition disposition,
            String sourceSpecRef,
            String sourceSchemaRef,
            Optional<String> targetSchemaRef,
            Optional<String> transformationRef) {
        public SchemaMigrationAssessment {
            Objects.requireNonNull(disposition, "disposition");
            requireVersionRef(sourceSpecRef, "sourceSpecRef");
            requireVersionRef(sourceSchemaRef, "sourceSchemaRef");
            targetSchemaRef = Objects.requireNonNull(targetSchemaRef, "targetSchemaRef");
            transformationRef = Objects.requireNonNull(transformationRef, "transformationRef");
        }
    }

    /** Effect-free fixed-DAG local prototype; admission checks also require compiler-issued identity. */
    public record CompiledPlan(
            String schemaVersion,
            String projectRevision,
            String originClass,
            List<PlanNode> nodes,
            String planFingerprint,
            CompilationInputs inputProvenance,
            String admissionBindingFingerprint) {
        /** Source-compatible constructor for previously compiled local candidates. */
        public CompiledPlan(
                String schemaVersion,
                String projectRevision,
                String originClass,
                List<PlanNode> nodes,
                String planFingerprint) {
            this(schemaVersion, projectRevision, originClass, nodes, planFingerprint, null, null);
        }

        /** Source-compatible constructor for previously compiled reference-bound candidates. */
        public CompiledPlan(
                String schemaVersion,
                String projectRevision,
                String originClass,
                List<PlanNode> nodes,
                String planFingerprint,
                CompilationInputs inputProvenance) {
            this(schemaVersion, projectRevision, originClass, nodes, planFingerprint, inputProvenance, null);
        }

        public CompiledPlan {
            nodes = List.copyOf(Objects.requireNonNull(nodes, "nodes"));
        }

        /** Changed or removed nodes relative to a prior compile, including affected descendants. */
        public List<String> invalidatedAgainst(CompiledPlan prior) {
            Map<String, String> priorPrints = new LinkedHashMap<>();
            for (PlanNode node : prior.nodes()) {
                priorPrints.put(node.stepId(), node.nodeFingerprint());
            }
            List<String> invalidated = new ArrayList<>();
            for (PlanNode node : nodes) {
                if (!node.nodeFingerprint().equals(priorPrints.remove(node.stepId()))) {
                    invalidated.add(node.stepId());
                }
            }
            // Outputs belonging to deleted nodes must not remain reusable.
            invalidated.addAll(priorPrints.keySet());
            return invalidated;
        }

    }

    /**
     * Builds the legacy fixed-DAG local prototype without canonical operation
     * input provenance. This is retained for source compatibility; it is not
     * the source-semantic compiler operation and cannot admit external effects.
     */
    public CompiledPlan compile(ProductionSpec spec) {
        return compileInternal(spec, null, null, null, List.of());
    }

    /**
     * Compiles a local reference-bound prototype with versioned source, schema,
     * and compiler-contract references. This does not resolve or interpret
     * external contract content and is not a source-semantic candidate or admission.
     */
    public CompiledPlan compileWithInputs(ProductionSpec spec, CompilationInputs inputs) {
        return compileInternal(spec, null, null, Objects.requireNonNull(inputs, "inputs"), List.of());
    }

    /**
     * Resolves the specification, schema, and compiler-contract references; validates
     * input 1 against the exact resolved Draft 2020-12 schema and the existing typed
     * production-spec mirror; then binds all three digest-checked responses into the
     * effect-free local candidate fingerprint. The resolver must enforce immutable-
     * version lookup and authorization and bound reads before materializing content.
     * The compiler-contract content remains opaque, and this does not define step
     * semantics, establish source authority, or admit runtime effects. Each
     * materialized response is limited by {@link MediaVersionedContractContent#MAX_CONTENT_BYTES}.
     */
    public CompiledPlan compileWithResolvedContentFingerprints(
            ProductionSpec spec,
            CompilationInputs inputs,
            MediaVersionedContractContent.Resolver resolver) {
        return compileWithResolvedContentFingerprints(spec, inputs, null, null, resolver);
    }

    /**
     * Resolves and validates the versioned production inputs while retaining
     * the exact optional revision assertion and v3 admission context on the
     * effect-free candidate. This still does not interpret compiler-contract
     * semantics or authenticate the resolver; the caller must supply the
     * existing authoritative resolver and execution remains NOT_ADMITTED.
     */
    public CompiledPlan compileWithResolvedContentFingerprints(
            ProductionSpec spec,
            CompilationInputs inputs,
            String optionalProjectRevisionRef,
            MediaProductionAdmissionBinding.Binding binding,
            MediaVersionedContractContent.Resolver resolver) {
        Objects.requireNonNull(spec, "spec");
        Objects.requireNonNull(inputs, "inputs");
        Objects.requireNonNull(resolver, "resolver");
        requireInputSchemaVersion(spec, inputs);
        validateCompileBinding(spec, optionalProjectRevisionRef, binding);
        MediaVersionedContractContent.ResolvedContent specificationContent = resolver.resolve(inputs.productionSpecRef());
        var specificationFingerprint = MediaVersionedContractContent.verifyDigestChecked(
                inputs.productionSpecRef(), specificationContent);
        MediaVersionedContractContent.ResolvedContent schemaContent = resolver.resolve(inputs.productionSpecSchemaRef());
        var schemaFingerprint = MediaVersionedContractContent.verifyDigestChecked(
                inputs.productionSpecSchemaRef(), schemaContent);
        validateProductionSpecContent(specificationContent.content(), schemaContent.content(), spec);
        var compilerFingerprint = MediaVersionedContractContent.resolveDigestChecked(
                inputs.compilerContractRef(), resolver);
        List<MediaVersionedContractContent.ResolvedContentFingerprint> resolved = List.of(
                specificationFingerprint, schemaFingerprint, compilerFingerprint);
        return compileInternal(spec, optionalProjectRevisionRef, binding, inputs, resolved);
    }

    private static void validateProductionSpecContent(
            byte[] specificationBytes,
            byte[] schemaBytes,
            ProductionSpec typedSpec) {
        ProductionSpec decodedSpec;
        try {
            JsonNode specificationNode = CONTRACT_JSON.readTree(specificationBytes);
            JsonNode schemaNode = CONTRACT_JSON.readTree(schemaBytes);
            if (specificationNode == null || !specificationNode.isObject()
                    || schemaNode == null || !schemaNode.isObject()) {
                throw invalidProductionSpecContent();
            }
            String schemaJson = strictUtf8(schemaBytes);
            String specificationJson = strictUtf8(specificationBytes);
            Schema schema = newLocalSchemaRegistry().getSchema(schemaJson, InputFormat.JSON);
            if (!schema.validate(specificationJson, InputFormat.JSON).isEmpty()) {
                throw invalidProductionSpecContent();
            }
            decodedSpec = decodeProductionSpec(specificationNode);
        } catch (StackOverflowError excessiveSchemaRecursion) {
            throw invalidProductionSpecContent();
        } catch (RuntimeException | IOException invalidSchemaOrContent) {
            throw invalidProductionSpecContent();
        }
        if (!typedSpec.equals(decodedSpec)) {
            throw new IllegalArgumentException(
                    "resolved production-spec content does not match the supplied typed specification");
        }
    }

    /**
     * Resolves the three canonical compile inputs and derives the normalized
     * semantic graph from the exact instance-bound compiler contract. The
     * resolver remains responsible for immutable-version lookup and authority.
     * Count-only evidence retains the source-defined caller-owned cardinality
     * behavior; typed evidence additionally verifies the caller-asserted
     * operationRef-to-definitionRef association and digest. The definition
     * bytes are not interpreted to prove that association. Neither path
     * establishes resolver authority, operation semantics, or admission.
     */
    public MediaProductionSemanticSource.CompilationResult compileSemanticSourceFromResolvedInputs(
            ProductionSpec typedSpec,
            CompilationInputs inputs,
            MediaVersionedContractContent.Resolver resolver,
            Map<String, Integer> exactOperationResolutionCounts) {
        return compileSemanticSourceFromResolvedInputs(typedSpec, inputs, null, resolver,
                exactOperationResolutionCounts, null);
    }

    /**
     * Resolves canonical inputs and caller-asserted operation-definition refs.
     * Definition refs and digests are checked structurally; the bytes are not
     * decoded to prove an operation identity. Resolver authority,
     * source-currentness, operation semantics, and runtime admission remain unproven.
     */
    public MediaProductionSemanticSource.CompilationResult compileSemanticSourceFromResolvedInputs(
            ProductionSpec typedSpec,
            CompilationInputs inputs,
            MediaVersionedContractContent.Resolver resolver,
            MediaProductionSemanticSource.OperationResolutionEvidence operationEvidence) {
        return compileSemanticSourceFromResolvedInputs(typedSpec, inputs, null, resolver, null,
                Objects.requireNonNull(operationEvidence, "operationEvidence"));
    }

    /** Resolves canonical inputs only after checking the optional exact revision assertion. */
    public MediaProductionSemanticSource.CompilationResult compileSemanticSourceFromResolvedInputs(
            ProductionSpec typedSpec,
            CompilationInputs inputs,
            String optionalProjectRevisionRef,
            MediaVersionedContractContent.Resolver resolver,
            Map<String, Integer> exactOperationResolutionCounts) {
        return compileSemanticSourceFromResolvedInputs(typedSpec, inputs, optionalProjectRevisionRef,
                resolver, exactOperationResolutionCounts, null);
    }

    /** Resolves canonical inputs after checking the revision and exact operation evidence. */
    public MediaProductionSemanticSource.CompilationResult compileSemanticSourceFromResolvedInputs(
            ProductionSpec typedSpec,
            CompilationInputs inputs,
            String optionalProjectRevisionRef,
            MediaVersionedContractContent.Resolver resolver,
            MediaProductionSemanticSource.OperationResolutionEvidence operationEvidence) {
        return compileSemanticSourceFromResolvedInputs(typedSpec, inputs, optionalProjectRevisionRef,
                resolver, null, Objects.requireNonNull(operationEvidence, "operationEvidence"));
    }

    private MediaProductionSemanticSource.CompilationResult compileSemanticSourceFromResolvedInputs(
            ProductionSpec typedSpec,
            CompilationInputs inputs,
            String optionalProjectRevisionRef,
            MediaVersionedContractContent.Resolver resolver,
            Map<String, Integer> exactOperationResolutionCounts,
            MediaProductionSemanticSource.OperationResolutionEvidence operationEvidence) {
        Objects.requireNonNull(typedSpec, "typedSpec");
        Objects.requireNonNull(inputs, "inputs");
        Objects.requireNonNull(resolver, "resolver");
        if (operationEvidence == null) {
            Objects.requireNonNull(exactOperationResolutionCounts, "exactOperationResolutionCounts");
        }
        requireInputSchemaVersion(typedSpec, inputs);
        if (optionalProjectRevisionRef != null && !optionalProjectRevisionRef.equals(typedSpec.revisionId())) {
            return new MediaProductionSemanticSource.CompilationResult(
                    MediaProductionSemanticSource.Disposition.NOT_ADMITTED,
                    MediaProductionSemanticSource.Reason.EXECUTION_CONTEXT_MISMATCH, List.of(), null);
        }

        final MediaVersionedContractContent.ResolvedContent specContent;
        final MediaVersionedContractContent.ResolvedContent schemaContent;
        final MediaVersionedContractContent.ResolvedContent compilerContent;
        try {
            // Each canonical operation input is resolved exactly once.
            specContent = resolver.resolve(inputs.productionSpecRef());
            schemaContent = resolver.resolve(inputs.productionSpecSchemaRef());
            compilerContent = resolver.resolve(inputs.compilerContractRef());
        } catch (RuntimeException unavailable) {
            return semanticSourceFailure(MediaProductionSemanticSource.Reason.UNRESOLVED_SOURCE_BINDING);
        }

        var specFingerprint = checkedResolverFingerprint(inputs.productionSpecRef(), specContent);
        var schemaFingerprint = checkedResolverFingerprint(inputs.productionSpecSchemaRef(), schemaContent);
        var compilerFingerprint = checkedResolverFingerprint(inputs.compilerContractRef(), compilerContent);
        if (specFingerprint == null || schemaFingerprint == null || compilerFingerprint == null) {
            return semanticSourceFailure(MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);
        }
        List<MediaVersionedContractContent.ResolvedContentFingerprint> resolved = new ArrayList<>(List.of(
                specFingerprint, schemaFingerprint, compilerFingerprint));

        try {
            validateProductionSpecContent(specContent.content(), schemaContent.content(), typedSpec);
            CompilerContract contract = decodeCompilerContract(compilerContent.content());
            if (!inputs.productionSpecRef().equals(contract.targetProductionSpecRef())
                    || !specFingerprint.sha256().equals(contract.targetProductionSpecSha256())
                    || !inputs.productionSpecSchemaRef().equals(contract.targetProductionSpecSchemaRef())
                    || !schemaFingerprint.sha256().equals(contract.targetProductionSpecSchemaSha256())) {
                return semanticSourceFailure(MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);
            }

            Set<String> specSceneRefs = new HashSet<>(typedSpec.sceneRefs());
            if (contract.steps().stream().anyMatch(step -> !specSceneRefs.containsAll(step.sourceSceneRefs()))) {
                return new MediaProductionSemanticSource.CompilationResult(
                        MediaProductionSemanticSource.Disposition.NOT_ADMITTED,
                        MediaProductionSemanticSource.Reason.EXECUTION_CONTEXT_MISMATCH, List.of(), null);
            }

            if (operationEvidence != null) {
                var evidenceProblem = validateOperationEvidenceCoverage(contract.steps(), operationEvidence);
                if (evidenceProblem != MediaProductionSemanticSource.Reason.NONE) {
                    return semanticSourceFailure(evidenceProblem);
                }
                Map<String, MediaVersionedContractContent.ResolvedContentFingerprint> operationFingerprints =
                        new TreeMap<>();
                for (var definition : operationEvidence.definitions()) {
                    if (operationFingerprints.containsKey(definition.definitionRef())) continue;
                    final MediaVersionedContractContent.ResolvedContent operationContent;
                    try {
                        operationContent = resolver.resolve(definition.definitionRef());
                    } catch (RuntimeException unavailable) {
                        return semanticSourceFailure(MediaProductionSemanticSource.Reason.UNRESOLVED_SOURCE_BINDING);
                    }
                    if (operationContent == null) {
                        return semanticSourceFailure(MediaProductionSemanticSource.Reason.UNRESOLVED_SOURCE_BINDING);
                    }
                    var fingerprint = checkedResolverFingerprint(definition.definitionRef(), operationContent);
                    if (fingerprint == null || !fingerprint.sha256().equals(definition.definitionSha256())) {
                        return semanticSourceFailure(MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);
                    }
                    operationFingerprints.put(definition.definitionRef(), fingerprint);
                }
                resolved.addAll(operationFingerprints.values());
            }

            var source = new MediaProductionSemanticSource(MediaProductionSemanticSource.SCHEMA_VERSION,
                    new MediaProductionSemanticSource.SourceBindings(
                            inputs.productionSpecRef(), specFingerprint.sha256(),
                            inputs.productionSpecSchemaRef(), schemaFingerprint.sha256(),
                            inputs.compilerContractRef(), compilerFingerprint.sha256()),
                    contract.steps());
            var graph = operationEvidence == null
                    ? source.compileSyntaxCheckedGraphCandidate(inputs, resolved, exactOperationResolutionCounts)
                    : source.compileSyntaxCheckedGraphCandidate(inputs, resolved, operationEvidence);
            if (graph.disposition() != MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED) return graph;
            StringBuilder candidateProjection = new StringBuilder();
            appendSemanticField(candidateProjection, "media.production.semantic-graph-resolved-input-candidate.v1");
            appendResolvedSemanticInput(candidateProjection, specFingerprint);
            appendResolvedSemanticInput(candidateProjection, schemaFingerprint);
            appendResolvedSemanticInput(candidateProjection, compilerFingerprint);
            appendSemanticField(candidateProjection, graph.fingerprint());
            return new MediaProductionSemanticSource.CompilationResult(graph.disposition(), graph.reason(), graph.nodes(),
                    "sha256:" + sha256(candidateProjection.toString()));
        } catch (IOException | RuntimeException invalidContractOrInputs) {
            return semanticSourceFailure(MediaProductionSemanticSource.Reason.INVALID_SEMANTIC_SOURCE_CONTENT);
        }
    }

    private record CompilerContract(
            String targetProductionSpecRef,
            String targetProductionSpecSha256,
            String targetProductionSpecSchemaRef,
            String targetProductionSpecSchemaSha256,
            List<MediaProductionSemanticSource.Node> steps) {
        private CompilerContract {
            steps = List.copyOf(steps);
        }
    }

    private static CompilerContract decodeCompilerContract(byte[] bytes) throws IOException {
        JsonNode root = CONTRACT_JSON.readTree(strictUtf8(bytes));
        requireExactFields(root, Set.of("schemaVersion", "targetProductionSpecRef", "targetProductionSpecSha256",
                "targetProductionSpecSchemaRef", "targetProductionSpecSchemaSha256", "steps"));
        if (!PRODUCTION_COMPILER_CONTRACT_SCHEMA_VERSION.equals(requiredText(root, "schemaVersion"))) {
            throw new IllegalArgumentException("unsupported production compiler contract version");
        }
        JsonNode stepArray = root.get("steps");
        if (stepArray == null || !stepArray.isArray() || stepArray.isEmpty()
                || stepArray.size() > MediaProductionSemanticSource.MAX_NODES) {
            throw new IllegalArgumentException("compiler contract steps are absent or outside the bound");
        }
        List<MediaProductionSemanticSource.Node> steps = new ArrayList<>(stepArray.size());
        for (JsonNode step : stepArray) {
            requireExactFields(step, Set.of("stepId", "kind", "operationRef", "inputArtifactVersionRefs",
                    "outputArtifactVersionRefs", "dependsOn", "sourceSceneRefs", "manualLockTarget"));
            JsonNode lockNode = step.get("manualLockTarget");
            Optional<MediaProductionSemanticSource.LockTarget> lock;
            if (lockNode == null || lockNode.isNull()) {
                lock = Optional.empty();
            } else {
                requireExactFields(lockNode, Set.of("scopeKind", "targetRef"));
                lock = Optional.of(new MediaProductionSemanticSource.LockTarget(
                        requiredText(lockNode, "scopeKind"), requiredText(lockNode, "targetRef")));
            }
            steps.add(new MediaProductionSemanticSource.Node(requiredText(step, "stepId"),
                    requiredText(step, "kind"), requiredText(step, "operationRef"),
                    possiblyEmptyTextList(step, "inputArtifactVersionRefs", MediaProductionSemanticSource.MAX_REFERENCES_PER_NODE),
                    possiblyEmptyTextList(step, "outputArtifactVersionRefs", MediaProductionSemanticSource.MAX_REFERENCES_PER_NODE),
                    possiblyEmptyTextList(step, "dependsOn", MediaProductionSemanticSource.MAX_REFERENCES_PER_NODE),
                    possiblyEmptyTextList(step, "sourceSceneRefs", MediaProductionSemanticSource.MAX_REFERENCES_PER_NODE), lock));
        }
        return new CompilerContract(requiredText(root, "targetProductionSpecRef"),
                requiredText(root, "targetProductionSpecSha256"),
                requiredText(root, "targetProductionSpecSchemaRef"),
                requiredText(root, "targetProductionSpecSchemaSha256"), steps);
    }

    private static MediaVersionedContractContent.ResolvedContentFingerprint checkedResolverFingerprint(
            String requestedRef, MediaVersionedContractContent.ResolvedContent resolved) {
        if (resolved == null || !requestedRef.equals(resolved.versionRef())) return null;
        try {
            return MediaVersionedContractContent.verifyDigestChecked(requestedRef, resolved);
        } catch (IllegalArgumentException invalidDigest) {
            return null;
        }
    }

    private static MediaProductionSemanticSource.Reason validateOperationEvidenceCoverage(
            List<MediaProductionSemanticSource.Node> steps,
            MediaProductionSemanticSource.OperationResolutionEvidence operationEvidence) {
        Set<String> graphOperations = new TreeSet<>();
        steps.forEach(step -> graphOperations.add(step.operationRef()));
        Map<String, MediaProductionSemanticSource.OperationDefinitionBinding> evidenceByOperation = new TreeMap<>();
        for (var definition : operationEvidence.definitions()) {
            if (evidenceByOperation.put(definition.operationRef(), definition) != null) {
                return MediaProductionSemanticSource.Reason.AMBIGUOUS_OPERATION;
            }
        }
        if (evidenceByOperation.keySet().equals(graphOperations)) {
            return MediaProductionSemanticSource.Reason.NONE;
        }
        return graphOperations.containsAll(evidenceByOperation.keySet())
                ? MediaProductionSemanticSource.Reason.UNRESOLVED_OPERATION
                : MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH;
    }

    private static void appendResolvedSemanticInput(
            StringBuilder target, MediaVersionedContractContent.ResolvedContentFingerprint input) {
        appendSemanticField(target, input.versionRef());
        appendSemanticField(target, input.sha256());
        appendSemanticField(target, Integer.toString(input.byteLength()));
    }

    private static ProductionSpec decodeProductionSpec(JsonNode node) {
        Set<String> fields = new HashSet<>();
        fields.addAll(node.propertyNames());
        if (!fields.equals(PRODUCTION_SPEC_FIELDS)) throw invalidProductionSpecContent();
        return new ProductionSpec(
                requiredText(node, "tenantId"),
                requiredText(node, "projectId"),
                requiredText(node, "revisionId"),
                requiredText(node, "schemaVersion"),
                requiredText(node, "originClass"),
                requiredText(node, "purposeRef"),
                requiredTextList(node, "sceneRefs", MAX_SCENES),
                requiredText(node, "timelineRef"),
                requiredText(node, "rightsRef"),
                requiredTextList(node, "outputProfileRefs", MAX_OUTPUT_PROFILES));
    }

    private static String requiredText(JsonNode object, String field) {
        JsonNode value = object.get(field);
        if (value == null || !value.isString()) throw invalidProductionSpecContent();
        return value.asString();
    }

    private static List<String> requiredTextList(JsonNode object, String field, int maximumItems) {
        JsonNode value = object.get(field);
        if (value == null || !value.isArray() || value.isEmpty() || value.size() > maximumItems) {
            throw invalidProductionSpecContent();
        }
        List<String> items = new ArrayList<>(value.size());
        for (JsonNode item : value) {
            if (!item.isString()) throw invalidProductionSpecContent();
            items.add(item.asString());
        }
        return List.copyOf(items);
    }

    private static String strictUtf8(byte[] content) throws CharacterCodingException {
        return StandardCharsets.UTF_8.newDecoder()
                .onMalformedInput(CodingErrorAction.REPORT)
                .onUnmappableCharacter(CodingErrorAction.REPORT)
                .decode(ByteBuffer.wrap(content))
                .toString();
    }

    private static IllegalArgumentException invalidProductionSpecContent() {
        return new IllegalArgumentException("resolved production-spec content is invalid under its versioned schema");
    }

    private static SchemaRegistry newLocalSchemaRegistry() {
        // A registry belongs to one exact resolved schema version. Avoid cache
        // reuse across immutable references that happen to share a stable $id.
        return SchemaRegistry.withDefaultDialect(SpecificationVersion.DRAFT_2020_12,
                builder -> builder.schemaLoader(loader -> loader.fetchRemoteResources(false))
                        .schemaRegistryConfig(SchemaRegistryConfig.builder()
                                .strict(SpecificationVersion.DRAFT_2020_12.getDialectId(), true)
                                .build()));
    }

    /** Compile with a separately versioned execution binding in every node identity. */
    public CompiledPlan compile(ProductionSpec spec, MediaProductionAdmissionBinding.Binding binding) {
        return compileInternal(spec, null, binding, null, List.of());
    }

    /** Compile reference-bound operation inputs with an optional revision assertion. */
    public CompiledPlan compileWithInputs(
            ProductionSpec spec,
            CompilationInputs inputs,
            String optionalProjectRevisionRef,
            MediaProductionAdmissionBinding.Binding binding) {
        return compileInternal(spec, optionalProjectRevisionRef, binding,
                Objects.requireNonNull(inputs, "inputs"), List.of());
    }

    /**
     * Classifies the source-defined optional migration inputs without applying
     * a transformation or fabricating a migration candidate.
     */
    public SchemaMigrationAssessment assessSchemaMigration(
            CompilationInputs sourceInputs,
            SchemaMigrationRequest request) {
        Objects.requireNonNull(sourceInputs, "sourceInputs");
        Objects.requireNonNull(request, "request");
        SchemaMigrationDisposition disposition;
        if (request.targetSchemaRef().isEmpty() && request.transformationRef().isEmpty()) {
            disposition = SchemaMigrationDisposition.NOT_REQUESTED;
        } else if (request.targetSchemaRef().isEmpty() || request.transformationRef().isEmpty()) {
            disposition = SchemaMigrationDisposition.UNKNOWN_INCOMPLETE_INPUTS;
        } else {
            // PDP-1 declares no supported transformation yet. An opaque ref is
            // not evidence that the transformation is implemented or lossless.
            disposition = SchemaMigrationDisposition.UNKNOWN_UNSUPPORTED_TRANSFORMATION;
        }
        return new SchemaMigrationAssessment(disposition, sourceInputs.productionSpecRef(),
                sourceInputs.productionSpecSchemaRef(), request.targetSchemaRef(), request.transformationRef());
    }

    /**
     * Verify exact semantic-source bytes, then perform graph syntax/shape and
     * topology checks. Node refs are not resolved; source-binding fingerprints
     * and operation evidence remain caller-owned. The typed overload checks
     * operation definition refs and digests against the resolved source set;
     * the graph fingerprint remains the source-defined structural identity.
     * This is effect-free and does not create an admission-bound CompiledPlan.
     */
    public MediaProductionSemanticSource.CompilationResult compileSemanticSource(
            Optional<MediaVersionedContractContent.ResolvedContent> sourceContent,
            String semanticSourceRef,
            String semanticSourceSha256,
            CompilationInputs expectedInputs,
            List<MediaVersionedContractContent.ResolvedContentFingerprint> resolvedSources,
            Map<String, Integer> exactOperationResolutionCounts) {
        return compileSemanticSource(sourceContent, semanticSourceRef, semanticSourceSha256, expectedInputs,
                resolvedSources, exactOperationResolutionCounts, null);
    }

    /** Verify semantic-source bytes and caller-asserted operation definition refs/digests. */
    public MediaProductionSemanticSource.CompilationResult compileSemanticSource(
            Optional<MediaVersionedContractContent.ResolvedContent> sourceContent,
            String semanticSourceRef,
            String semanticSourceSha256,
            CompilationInputs expectedInputs,
            List<MediaVersionedContractContent.ResolvedContentFingerprint> resolvedSources,
            MediaProductionSemanticSource.OperationResolutionEvidence operationEvidence) {
        return compileSemanticSource(sourceContent, semanticSourceRef, semanticSourceSha256, expectedInputs,
                resolvedSources, null, Objects.requireNonNull(operationEvidence, "operationEvidence"));
    }

    private MediaProductionSemanticSource.CompilationResult compileSemanticSource(
            Optional<MediaVersionedContractContent.ResolvedContent> sourceContent,
            String semanticSourceRef,
            String semanticSourceSha256,
            CompilationInputs expectedInputs,
            List<MediaVersionedContractContent.ResolvedContentFingerprint> resolvedSources,
            Map<String, Integer> exactOperationResolutionCounts,
            MediaProductionSemanticSource.OperationResolutionEvidence operationEvidence) {
        if (operationEvidence == null) Objects.requireNonNull(exactOperationResolutionCounts, "exactOperationResolutionCounts");
        if (sourceContent == null || sourceContent.isEmpty()) {
            return new MediaProductionSemanticSource.CompilationResult(MediaProductionSemanticSource.Disposition.UNKNOWN,
                    MediaProductionSemanticSource.Reason.ABSENT_GRAPH, List.of(), null);
        }
        requireSemanticSourceRef(semanticSourceRef);
        requireSemanticSourceDigest(semanticSourceSha256);
        try {
            var content = sourceContent.orElseThrow();
            var fingerprint = MediaVersionedContractContent.verifyDigestChecked(semanticSourceRef, content);
            if (!fingerprint.sha256().equals(semanticSourceSha256)) {
                return semanticSourceFailure(MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);
            }
            if (!containsFingerprint(resolvedSources, semanticSourceRef, semanticSourceSha256)) {
                return semanticSourceFailure(MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);
            }
            var source = decodeSemanticSource(content.content());
            var graph = operationEvidence == null
                    ? source.compileSyntaxCheckedGraphCandidate(expectedInputs, resolvedSources, exactOperationResolutionCounts)
                    : source.compileSyntaxCheckedGraphCandidate(expectedInputs, resolvedSources, operationEvidence);
            if (graph.disposition() != MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED) return graph;
            StringBuilder projection = new StringBuilder();
            appendSemanticField(projection, "media.production.semantic-source-artifact-binding.v1");
            appendSemanticField(projection, semanticSourceRef);
            appendSemanticField(projection, semanticSourceSha256);
            appendSemanticField(projection, graph.fingerprint());
            return new MediaProductionSemanticSource.CompilationResult(graph.disposition(), graph.reason(), graph.nodes(),
                    "sha256:" + sha256(projection.toString()));
        } catch (IOException | RuntimeException failure) {
            return semanticSourceFailure(MediaProductionSemanticSource.Reason.INVALID_SEMANTIC_SOURCE_CONTENT);
        }
    }

    public record SemanticCandidateBindResult(
            MediaProductionSemanticSource.Disposition disposition,
            MediaProductionSemanticSource.Reason reason,
            String candidateFingerprint) {
        public SemanticCandidateBindResult(
                MediaProductionSemanticSource.Disposition disposition,
                MediaProductionSemanticSource.Reason reason) {
            this(disposition, reason, null);
        }

        public SemanticCandidateBindResult {
            Objects.requireNonNull(disposition, "disposition");
            Objects.requireNonNull(reason, "reason");
            if (disposition == MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED) {
                if (candidateFingerprint == null || !candidateFingerprint.matches("sha256:[0-9a-f]{64}")) {
                    throw new IllegalArgumentException("a prepared semantic candidate requires a SHA-256 fingerprint");
                }
            } else if (candidateFingerprint != null) {
                throw new IllegalArgumentException("only a prepared semantic candidate may carry a fingerprint");
            }
        }
    }

    /**
     * Compares the digest-bound graph structure with the unchanged v3 context.
     * The owner-authored mapping is an exact stepId join only. A successful
     * result is an effect-free structural candidate fingerprint, not proof of
     * resolver authority, operation existence/currentness, engine-operation
     * compatibility, or runtime admission.
     */
    public SemanticCandidateBindResult bindSemanticSourceCandidate(
            Optional<MediaVersionedContractContent.ResolvedContent> sourceContent,
            String semanticSourceRef,
            String semanticSourceSha256,
            CompilationInputs expectedInputs,
            ProductionSpec spec,
            MediaProductionAdmissionBinding.Binding binding,
            List<MediaVersionedContractContent.ResolvedContentFingerprint> resolvedSources,
            Map<String, Integer> exactOperationResolutionCounts) {
        return bindSemanticSourceCandidate(sourceContent, semanticSourceRef, semanticSourceSha256, expectedInputs,
                spec, binding, resolvedSources, exactOperationResolutionCounts, null);
    }

    /** Structurally checks caller-asserted operation definition evidence against the unchanged v3 context. */
    public SemanticCandidateBindResult bindSemanticSourceCandidate(
            Optional<MediaVersionedContractContent.ResolvedContent> sourceContent,
            String semanticSourceRef,
            String semanticSourceSha256,
            CompilationInputs expectedInputs,
            ProductionSpec spec,
            MediaProductionAdmissionBinding.Binding binding,
            List<MediaVersionedContractContent.ResolvedContentFingerprint> resolvedSources,
            MediaProductionSemanticSource.OperationResolutionEvidence operationEvidence) {
        return bindSemanticSourceCandidate(sourceContent, semanticSourceRef, semanticSourceSha256, expectedInputs,
                spec, binding, resolvedSources, null, Objects.requireNonNull(operationEvidence, "operationEvidence"));
    }

    private SemanticCandidateBindResult bindSemanticSourceCandidate(
            Optional<MediaVersionedContractContent.ResolvedContent> sourceContent,
            String semanticSourceRef,
            String semanticSourceSha256,
            CompilationInputs expectedInputs,
            ProductionSpec spec,
            MediaProductionAdmissionBinding.Binding binding,
            List<MediaVersionedContractContent.ResolvedContentFingerprint> resolvedSources,
            Map<String, Integer> exactOperationResolutionCounts,
            MediaProductionSemanticSource.OperationResolutionEvidence operationEvidence) {
        Objects.requireNonNull(spec, "spec");
        Objects.requireNonNull(binding, "binding");
        Objects.requireNonNull(resolvedSources, "resolvedSources");
        if (operationEvidence == null) Objects.requireNonNull(exactOperationResolutionCounts, "exactOperationResolutionCounts");
        if (sourceContent == null || sourceContent.isEmpty()) {
            return new SemanticCandidateBindResult(MediaProductionSemanticSource.Disposition.UNKNOWN,
                    MediaProductionSemanticSource.Reason.ABSENT_GRAPH);
        }
        requireSemanticSourceRef(semanticSourceRef);
        requireSemanticSourceDigest(semanticSourceSha256);
        final MediaProductionSemanticSource source;
        try {
            var sourceBytes = sourceContent.orElseThrow();
            var sourceContentFingerprint = MediaVersionedContractContent.verifyDigestChecked(semanticSourceRef, sourceBytes);
            if (!semanticSourceSha256.equals(sourceContentFingerprint.sha256())) {
                return failedSemanticBind(MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);
            }
            source = decodeSemanticSource(sourceBytes.content());
        } catch (IOException | RuntimeException failure) {
            return failedSemanticBind(MediaProductionSemanticSource.Reason.INVALID_SEMANTIC_SOURCE_CONTENT);
        }
        var resolvedByRef = new LinkedHashMap<String, MediaVersionedContractContent.ResolvedContentFingerprint>();
        for (var fingerprint : resolvedSources) {
            if (fingerprint != null && resolvedByRef.put(fingerprint.versionRef(), fingerprint) != null) {
                return failedSemanticBind(MediaProductionSemanticSource.Reason.UNRESOLVED_SOURCE_BINDING);
            }
        }
        var sourceFingerprint = resolvedByRef.get(semanticSourceRef);
        if (sourceFingerprint == null || !semanticSourceSha256.equals(sourceFingerprint.sha256())) {
            return failedSemanticBind(MediaProductionSemanticSource.Reason.SOURCE_BINDING_MISMATCH);
        }
        var graph = operationEvidence == null
                ? source.compileSyntaxCheckedGraphCandidate(expectedInputs, resolvedSources, exactOperationResolutionCounts)
                : source.compileSyntaxCheckedGraphCandidate(expectedInputs, resolvedSources, operationEvidence);
        if (graph.disposition() != MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED) {
            return new SemanticCandidateBindResult(graph.disposition(), graph.reason());
        }
        if (!spec.projectId().equals(binding.projectId())
                || !spec.revisionId().equals(binding.expectedProjectRevision())
                || !spec.tenantId().equals(binding.authority().tenantId())
                || !spec.purposeRef().equals(binding.authority().purposeRef())
                || !spec.rightsRef().equals(binding.authority().rightsRef())
                || !new TreeSet<>(spec.sceneRefs()).equals(new TreeSet<>(binding.sourceBindingsByScene().keySet()))) {
            return notAdmittedSemanticBind(MediaProductionSemanticSource.Reason.EXECUTION_CONTEXT_MISMATCH);
        }
        Set<String> graphStepIds = new TreeSet<>();
        graph.nodes().forEach(node -> graphStepIds.add(node.stepId()));
        if (!graphStepIds.equals(binding.enginesByStep().keySet())) {
            return notAdmittedSemanticBind(MediaProductionSemanticSource.Reason.EXECUTION_CONTEXT_MISMATCH);
        }
        Set<String> specSceneRefs = new TreeSet<>(spec.sceneRefs());
        Map<String, MediaProductionSemanticSource.LockTarget> declaredLocks = new TreeMap<>();
        for (var node : graph.nodes()) {
            if (!specSceneRefs.containsAll(source.nodes().stream().filter(n -> n.stepId().equals(node.stepId()))
                    .findFirst().orElseThrow().sourceSceneRefs())) {
                return notAdmittedSemanticBind(MediaProductionSemanticSource.Reason.EXECUTION_CONTEXT_MISMATCH);
            }
            var sourceNode = source.nodes().stream().filter(n -> n.stepId().equals(node.stepId())).findFirst().orElseThrow();
            sourceNode.manualLockTarget().ifPresent(lock -> declaredLocks.put(node.stepId(), lock));
        }
        if (!declaredLocks.keySet().equals(binding.editLocksByStep().keySet())) {
            return notAdmittedSemanticBind(MediaProductionSemanticSource.Reason.EXECUTION_CONTEXT_MISMATCH);
        }
        for (var entry : declaredLocks.entrySet()) {
            var actual = binding.editLocksByStep().get(entry.getKey());
            var expected = entry.getValue();
            if (!expected.scopeKind().equals(actual.scopeKind()) || !expected.targetRef().equals(actual.targetRef())
                    || !binding.authority().principalId().equals(actual.ownerPrincipalId())) {
                return notAdmittedSemanticBind(MediaProductionSemanticSource.Reason.EXECUTION_CONTEXT_MISMATCH);
            }
        }

        StringBuilder projection = new StringBuilder();
        appendSemanticField(projection, "media.production.semantic-source-v3-candidate.v1");
        appendSemanticField(projection, semanticSourceRef);
        appendSemanticField(projection, semanticSourceSha256);
        appendSemanticField(projection, graph.fingerprint());
        appendSemanticField(projection, binding.fingerprint());
        return new SemanticCandidateBindResult(MediaProductionSemanticSource.Disposition.CANDIDATE_PREPARED,
                MediaProductionSemanticSource.Reason.NONE, "sha256:" + sha256(projection.toString()));
    }

    private static SemanticCandidateBindResult failedSemanticBind(MediaProductionSemanticSource.Reason reason) {
        return new SemanticCandidateBindResult(MediaProductionSemanticSource.Disposition.UNKNOWN, reason);
    }

    private static MediaProductionSemanticSource.CompilationResult semanticSourceFailure(
            MediaProductionSemanticSource.Reason reason) {
        return new MediaProductionSemanticSource.CompilationResult(MediaProductionSemanticSource.Disposition.UNKNOWN,
                reason, List.of(), null);
    }

    private static boolean containsFingerprint(
            List<MediaVersionedContractContent.ResolvedContentFingerprint> sources, String ref, String digest) {
        if (sources == null) return false;
        long matches = sources.stream().filter(Objects::nonNull).filter(item -> ref.equals(item.versionRef())
                && digest.equals(item.sha256())).count();
        return matches == 1;
    }

    private static MediaProductionSemanticSource decodeSemanticSource(byte[] bytes) throws IOException {
        JsonNode root = CONTRACT_JSON.readTree(strictUtf8(bytes));
        requireExactFields(root, Set.of("schemaVersion", "sourceBindings", "nodes"));
        String schemaVersion = requiredText(root, "schemaVersion");
        JsonNode sourceBindingsNode = root.get("sourceBindings");
        requireExactFields(sourceBindingsNode, Set.of("productionSpecRef", "productionSpecSha256",
                "productionSpecSchemaRef", "productionSpecSchemaSha256", "compilerContractRef", "compilerContractSha256"));
        var sourceBindings = new MediaProductionSemanticSource.SourceBindings(
                requiredText(sourceBindingsNode, "productionSpecRef"), requiredText(sourceBindingsNode, "productionSpecSha256"),
                requiredText(sourceBindingsNode, "productionSpecSchemaRef"), requiredText(sourceBindingsNode, "productionSpecSchemaSha256"),
                requiredText(sourceBindingsNode, "compilerContractRef"), requiredText(sourceBindingsNode, "compilerContractSha256"));
        JsonNode nodeArray = root.get("nodes");
        if (nodeArray == null || !nodeArray.isArray() || nodeArray.isEmpty()
                || nodeArray.size() > MediaProductionSemanticSource.MAX_NODES) {
            throw new IllegalArgumentException("semantic source nodes are absent or outside the bound");
        }
        List<MediaProductionSemanticSource.Node> nodes = new ArrayList<>(nodeArray.size());
        for (JsonNode node : nodeArray) {
            requireExactFields(node, Set.of("stepId", "kind", "operationRef", "inputArtifactVersionRefs",
                    "outputArtifactVersionRefs", "dependsOn", "sourceSceneRefs", "manualLockTarget"));
            JsonNode lockNode = node.get("manualLockTarget");
            Optional<MediaProductionSemanticSource.LockTarget> lock;
            if (lockNode == null || lockNode.isNull()) {
                lock = Optional.empty();
            } else {
                requireExactFields(lockNode, Set.of("scopeKind", "targetRef"));
                lock = Optional.of(new MediaProductionSemanticSource.LockTarget(
                        requiredText(lockNode, "scopeKind"), requiredText(lockNode, "targetRef")));
            }
            nodes.add(new MediaProductionSemanticSource.Node(requiredText(node, "stepId"),
                    requiredText(node, "kind"), requiredText(node, "operationRef"),
                    possiblyEmptyTextList(node, "inputArtifactVersionRefs", MediaProductionSemanticSource.MAX_REFERENCES_PER_NODE),
                    possiblyEmptyTextList(node, "outputArtifactVersionRefs", MediaProductionSemanticSource.MAX_REFERENCES_PER_NODE),
                    possiblyEmptyTextList(node, "dependsOn", MediaProductionSemanticSource.MAX_REFERENCES_PER_NODE),
                    possiblyEmptyTextList(node, "sourceSceneRefs", MediaProductionSemanticSource.MAX_REFERENCES_PER_NODE), lock));
        }
        return new MediaProductionSemanticSource(schemaVersion, sourceBindings, nodes);
    }

    private static void requireExactFields(JsonNode object, Set<String> expected) {
        if (object == null || !object.isObject() || !new HashSet<>(object.propertyNames()).equals(expected)) {
            throw new IllegalArgumentException("semantic source object is not closed or complete");
        }
    }

    private static List<String> possiblyEmptyTextList(JsonNode object, String field, int maximumItems) {
        JsonNode value = object.get(field);
        if (value == null || !value.isArray() || value.size() > maximumItems) {
            throw new IllegalArgumentException("semantic source list is invalid: " + field);
        }
        List<String> values = new ArrayList<>(value.size());
        for (JsonNode item : value) {
            if (!item.isString()) throw new IllegalArgumentException("semantic source list contains non-text");
            values.add(item.asString());
        }
        return List.copyOf(values);
    }

    private static void requireSemanticSourceDigest(String value) {
        if (value == null || !value.matches("sha256:[0-9a-f]{64}")) {
            throw new IllegalArgumentException("semanticSourceSha256 must be a lowercase SHA-256 digest");
        }
    }

    private static void appendSemanticField(StringBuilder target, String value) {
        if (!hasWellFormedUtf16(value)) throw new IllegalArgumentException("malformed UTF-16 in semantic fingerprint input");
        target.append(value.getBytes(StandardCharsets.UTF_8).length).append(':').append(value);
    }

    private static SemanticCandidateBindResult notAdmittedSemanticBind(MediaProductionSemanticSource.Reason reason) {
        return new SemanticCandidateBindResult(MediaProductionSemanticSource.Disposition.NOT_ADMITTED, reason);
    }

    private static void requireSemanticSourceRef(String value) {
        if (!isValidSemanticVersionRef(value)) {
            throw new IllegalArgumentException("semanticSourceRef is invalid");
        }
    }

    private static boolean isValidSemanticVersionRef(String value) {
        return value != null && !value.isEmpty() && value.codePointCount(0, value.length()) <= 384
                && hasWellFormedUtf16(value)
                && value.codePoints().noneMatch(ch -> Character.isWhitespace(ch)
                        || Character.isSpaceChar(ch) || ch == 0xFEFF);
    }

    /**
     * Compile the existing operation's optional project-revision slot together
     * with its separate admission context. The optional slot is a consistency
     * assertion only; the canonical revision remains the one inside spec.
     */
    public CompiledPlan compile(
            ProductionSpec spec,
            String optionalProjectRevisionRef,
            MediaProductionAdmissionBinding.Binding binding) {
        return compileInternal(spec, optionalProjectRevisionRef, binding, null, List.of());
    }

    private CompiledPlan compileInternal(
            ProductionSpec spec,
            String optionalProjectRevisionRef,
            MediaProductionAdmissionBinding.Binding binding,
            CompilationInputs inputs,
            List<MediaVersionedContractContent.ResolvedContentFingerprint> resolvedContents) {
        Objects.requireNonNull(spec, "spec");
        if (inputs != null) requireInputSchemaVersion(spec, inputs);
        validateCompileBinding(spec, optionalProjectRevisionRef, binding);
        String admissionFingerprint = binding == null ? null : binding.stableContextFingerprint();
        Map<String, String> fingerprints = new LinkedHashMap<>();
        List<PlanNode> nodes = new ArrayList<>();

        List<String> planBinding = new ArrayList<>(List.of(
                spec.tenantId(), spec.projectId(), spec.schemaVersion(), spec.originClass()));
        if (inputs != null) {
            planBinding.add("versioned-production-specification");
            planBinding.add(inputs.productionSpecRef());
            planBinding.add("versioned-production-specification-schema");
            planBinding.add(inputs.productionSpecSchemaRef());
            planBinding.add(inputs.productionSpecSchemaVersion());
            planBinding.add("versioned-compiler-contract");
            planBinding.add(inputs.compilerContractRef());
        }
        appendResolvedContent(planBinding, resolvedContents);
        if (binding != null) planBinding.add(binding.planContextFingerprint());
        planBinding.addAll(engineContext(binding, "validate-spec"));
        addNode(nodes, fingerprints, "validate-spec", "validate", ExecutionMode.AUTOMATIC,
                List.of(), List.of(spec.revisionId(), spec.purposeRef()), planBinding);
        addNode(nodes, fingerprints, "rights-review", "rights-review", ExecutionMode.MANUAL_GATE,
                List.of("validate-spec"), List.of(spec.rightsRef()), engineContext(binding, "rights-review"));
        List<String> captureIds = new ArrayList<>();
        for (int i = 0; i < spec.sceneRefs().size(); i++) {
            String id = "capture-source-" + i;
            addNode(nodes, fingerprints, id, "capture", ExecutionMode.AUTOMATIC,
                    List.of("rights-review"), List.of(spec.sceneRefs().get(i)),
                    sourceContext(binding, spec.sceneRefs().get(i), id));
            captureIds.add(id);
        }
        addNode(nodes, fingerprints, "compose-timeline", "compose", ExecutionMode.AUTOMATIC,
                captureIds, List.of(spec.timelineRef), engineContext(binding, "compose-timeline"));
        List<String> renderIds = new ArrayList<>();
        for (int i = 0; i < spec.outputProfileRefs().size(); i++) {
            String id = "render-profile-" + i;
            addNode(nodes, fingerprints, id, "render", ExecutionMode.AUTOMATIC,
                    List.of("compose-timeline"), List.of(spec.outputProfileRefs().get(i)), engineContext(binding, id));
            renderIds.add(id);
        }
        addNode(nodes, fingerprints, "publish-review", "publish-review", ExecutionMode.MANUAL_GATE,
                renderIds, List.of(spec.revisionId()), engineContext(binding, "publish-review"));

        if (binding != null) {
            Set<String> nodeIds = new TreeSet<>();
            nodes.forEach(node -> nodeIds.add(node.stepId()));
            if (!nodeIds.equals(binding.enginesByStep().keySet())) {
                throw new IllegalArgumentException("enginesByStep must bind exactly every compiled plan node");
            }
            validateEditLockTargets(spec, binding);
        }

        // Length framing makes the digest unambiguous even when a reference
        // itself contains punctuation used by prior delimiter-based projections.
        StringBuilder projection = new StringBuilder();
        appendField(projection, "media.production-plan.v1");
        appendField(projection, spec.tenantId());
        appendField(projection, spec.projectId());
        appendField(projection, spec.revisionId());
        appendField(projection, spec.originClass());
        appendField(projection, spec.purposeRef());
        appendField(projection, spec.rightsRef());
        if (inputs != null) {
            appendField(projection, "versioned-production-specification");
            appendField(projection, inputs.productionSpecRef());
            appendField(projection, "versioned-production-specification-schema");
            appendField(projection, inputs.productionSpecSchemaRef());
            appendField(projection, inputs.productionSpecSchemaVersion());
            appendField(projection, "versioned-compiler-contract");
            appendField(projection, inputs.compilerContractRef());
        }
        appendResolvedContent(projection, resolvedContents);
        if (admissionFingerprint != null) appendField(projection, admissionFingerprint);
        appendField(projection, Integer.toString(nodes.size()));
        for (PlanNode node : nodes) {
            appendField(projection, node.stepId());
            appendField(projection, node.nodeFingerprint());
        }
        CompiledPlan compiledPlan = new CompiledPlan(
                "media.production-plan.v1",
                spec.revisionId(),
                spec.originClass(),
                nodes,
                "sha256:" + sha256(projection.toString()),
                inputs,
                admissionFingerprint);
        markCompilerIssued(compiledPlan);
        return compiledPlan;
    }

    private static void validateCompileBinding(
            ProductionSpec spec,
            String optionalProjectRevisionRef,
            MediaProductionAdmissionBinding.Binding binding) {
        if (optionalProjectRevisionRef != null && !optionalProjectRevisionRef.equals(spec.revisionId())) {
            throw new MediaProductionAdmissionBinding.AdmissionException(
                    MediaProductionAdmissionBinding.AdmissionFailure.PROJECT_REVISION_STALE);
        }
        if (binding != null && (!binding.projectId().equals(spec.projectId())
                || !binding.expectedProjectRevision().equals(spec.revisionId())
                || !binding.authority().tenantId().equals(spec.tenantId())
                || !binding.authority().purposeRef().equals(spec.purposeRef())
                || !binding.authority().rightsRef().equals(spec.rightsRef()))) {
            throw new MediaProductionAdmissionBinding.AdmissionException(
                    MediaProductionAdmissionBinding.AdmissionFailure.BINDING_SPEC_MISMATCH);
        }
        if (binding != null && !binding.sourceBindingsByScene().keySet().equals(new TreeSet<>(spec.sceneRefs()))) {
            // The separately-versioned v3 envelope must bind every exact scene
            // ref and no other scene; partial/extra mappings cannot authorize a plan.
            throw new MediaProductionAdmissionBinding.AdmissionException(
                    MediaProductionAdmissionBinding.AdmissionFailure.MULTI_SOURCE_AUTHORITY_UNMAPPED);
        }
    }

    private static List<String> engineContext(
            MediaProductionAdmissionBinding.Binding binding, String stepId) {
        return binding == null ? List.of() : List.of(binding.engineFingerprint(stepId));
    }

    private static void appendResolvedContent(
            List<String> target,
            List<MediaVersionedContractContent.ResolvedContentFingerprint> contents) {
        if (contents.isEmpty()) return;
        target.add("resolved-versioned-contract-content");
        target.add(Integer.toString(contents.size()));
        for (MediaVersionedContractContent.ResolvedContentFingerprint content : contents) {
            target.add(content.versionRef());
            target.add(content.sha256());
            target.add(Integer.toString(content.byteLength()));
        }
    }

    private static void appendResolvedContent(
            StringBuilder target,
            List<MediaVersionedContractContent.ResolvedContentFingerprint> contents) {
        if (contents.isEmpty()) return;
        appendField(target, "resolved-versioned-contract-content");
        appendField(target, Integer.toString(contents.size()));
        for (MediaVersionedContractContent.ResolvedContentFingerprint content : contents) {
            appendField(target, content.versionRef());
            appendField(target, content.sha256());
            appendField(target, Integer.toString(content.byteLength()));
        }
    }

    private static List<String> sourceContext(MediaProductionAdmissionBinding.Binding binding, String sceneRef, String stepId) {
        if (binding == null) return List.of();
        MediaProductionAdmissionBinding.SceneSourceAuthority source = binding.sourceBindingsByScene().get(sceneRef);
        if (source == null) {
            throw new MediaProductionAdmissionBinding.AdmissionException(
                    MediaProductionAdmissionBinding.AdmissionFailure.MULTI_SOURCE_AUTHORITY_UNMAPPED);
        }
        return List.of(binding.engineFingerprint(stepId), source.sourceVersionRef(), source.sourceSha256(),
                source.rightsRef(), source.ownerDecisionRef(), source.decisionExpiresAt().toString(),
                Long.toString(source.revocationEpoch()));
    }

    private static void requireInputSchemaVersion(ProductionSpec spec, CompilationInputs inputs) {
        if (!spec.schemaVersion().equals(inputs.productionSpecSchemaVersion())) {
            throw new IllegalArgumentException("productionSpecSchemaVersion must match the specification schemaVersion");
        }
    }

    /** Bind only source-defined scene capture and output render nodes to scoped edit locks. */
    private static void validateEditLockTargets(
            ProductionSpec spec, MediaProductionAdmissionBinding.Binding binding) {
        Map<String, MediaProductionAdmissionBinding.EditLock> locks = binding.editLocksByStep();
        Set<String> expectedLockSteps = new TreeSet<>();
        for (int i = 0; i < spec.sceneRefs().size(); i++) {
            String stepId = "capture-source-" + i;
            expectedLockSteps.add(stepId);
            MediaProductionAdmissionBinding.EditLock lock = locks.get(stepId);
            if (lock == null || !"SCENE".equals(lock.scopeKind())
                    || !spec.sceneRefs().get(i).equals(lock.targetRef())) {
                throw new MediaProductionAdmissionBinding.AdmissionException(
                        MediaProductionAdmissionBinding.AdmissionFailure.EDIT_LOCK_INVALID);
            }
        }
        for (int i = 0; i < spec.outputProfileRefs().size(); i++) {
            String stepId = "render-profile-" + i;
            expectedLockSteps.add(stepId);
            MediaProductionAdmissionBinding.EditLock lock = locks.get(stepId);
            if (lock == null || !"OUTPUT".equals(lock.scopeKind())
                    || !spec.outputProfileRefs().get(i).equals(lock.targetRef())) {
                throw new MediaProductionAdmissionBinding.AdmissionException(
                        MediaProductionAdmissionBinding.AdmissionFailure.EDIT_LOCK_INVALID);
            }
        }
        if (!expectedLockSteps.equals(locks.keySet())) {
            throw new MediaProductionAdmissionBinding.AdmissionException(
                    MediaProductionAdmissionBinding.AdmissionFailure.BINDING_SPEC_MISMATCH);
        }
    }

    private static void addNode(
            List<PlanNode> nodes,
            Map<String, String> fingerprints,
            String stepId,
            String kind,
            ExecutionMode mode,
            List<String> dependsOn,
            List<String> versionRefs) {
        addNode(nodes, fingerprints, stepId, kind, mode, dependsOn, versionRefs, List.of());
    }

    private static void addNode(
            List<PlanNode> nodes,
            Map<String, String> fingerprints,
            String stepId,
            String kind,
            ExecutionMode mode,
            List<String> dependsOn,
            List<String> versionRefs,
            List<String> fingerprintContext) {
        StringBuilder fingerprintInput = new StringBuilder();
        appendField(fingerprintInput, kind);
        appendField(fingerprintInput, mode.name());
        appendField(fingerprintInput, Integer.toString(fingerprintContext.size()));
        for (String value : fingerprintContext) appendField(fingerprintInput, value);
        appendField(fingerprintInput, Integer.toString(dependsOn.size()));
        for (String dep : dependsOn) {
            appendField(fingerprintInput, dep);
            appendField(fingerprintInput, Objects.requireNonNull(fingerprints.get(dep), "dependency fingerprint"));
        }
        appendField(fingerprintInput, Integer.toString(versionRefs.size()));
        for (String ref : versionRefs) {
            appendField(fingerprintInput, ref);
        }
        String nodeFingerprint = "sha256:" + sha256(fingerprintInput.toString());
        fingerprints.put(stepId, nodeFingerprint);
        nodes.add(new PlanNode(stepId, kind, mode, dependsOn, versionRefs, nodeFingerprint));
    }

    private static void appendField(StringBuilder target, String value) {
        target.append(value.length()).append(':').append(value);
    }

    private static void requireIdentifier(String value, String field) {
        if (value == null || value.length() > 128 || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]*")) {
            throw new IllegalArgumentException(field + " must be a bounded opaque identifier");
        }
    }

    private static void requireVersionRef(String value, String field) {
        if (value == null || value.length() > 384 || value.isEmpty()
                || !hasWellFormedUtf16(value)
                || value.codePoints().anyMatch(ch -> Character.isWhitespace(ch) || Character.isSpaceChar(ch))) {
            throw new IllegalArgumentException(field + " must be a bounded version reference");
        }
    }

    /** Reject malformed UTF-16 so UTF-8 hashing cannot collapse distinct references. */
    private static boolean hasWellFormedUtf16(String value) {
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (Character.isHighSurrogate(current)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) {
                    return false;
                }
                index++;
            } else if (Character.isLowSurrogate(current)) {
                return false;
            }
        }
        return true;
    }

    private static String sha256(String input) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256")
                            .digest(input.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException("SHA-256 unavailable", e);
        }
    }
}
