package com.ghatana.media.runtime;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.TreeSet;
import java.util.Set;

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

    /** Bounded plan size — a spec cannot compile an unbounded DAG. */
    public static final int MAX_SCENES = 256;
    public static final int MAX_OUTPUT_PROFILES = 64;
    public static final String PRODUCTION_SPEC_SCHEMA_VERSION = "media.declarative.value.production-spec.v1";

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

    /** Exact immutable identities for source-spec input 1 and contract inputs 2 and 3. */
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

    /** Effect-free fixed-DAG local prototype; optional provenance is not admission evidence. */
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
            nodes = List.copyOf(nodes);
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
        return compileInternal(spec, null, null, null);
    }

    /**
     * Compiles a local reference-bound prototype with the exact versioned source,
     * schema, and compiler-contract identities. This does not resolve or interpret
     * external contract content and is not a source-semantic candidate or admission.
     */
    public CompiledPlan compileWithInputs(ProductionSpec spec, CompilationInputs inputs) {
        return compileInternal(spec, null, null, Objects.requireNonNull(inputs, "inputs"));
    }

    /** Compile with a separately versioned execution binding in every node identity. */
    public CompiledPlan compile(ProductionSpec spec, MediaProductionAdmissionBinding.Binding binding) {
        return compileInternal(spec, null, binding, null);
    }

    /** Compile reference-bound operation inputs with an optional revision assertion. */
    public CompiledPlan compileWithInputs(
            ProductionSpec spec,
            CompilationInputs inputs,
            String optionalProjectRevisionRef,
            MediaProductionAdmissionBinding.Binding binding) {
        return compileInternal(spec, optionalProjectRevisionRef, binding, Objects.requireNonNull(inputs, "inputs"));
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
     * Compile the existing operation's optional project-revision slot together
     * with its separate admission context. The optional slot is a consistency
     * assertion only; the canonical revision remains the one inside spec.
     */
    public CompiledPlan compile(
            ProductionSpec spec,
            String optionalProjectRevisionRef,
            MediaProductionAdmissionBinding.Binding binding) {
        return compileInternal(spec, optionalProjectRevisionRef, binding, null);
    }

    private CompiledPlan compileInternal(
            ProductionSpec spec,
            String optionalProjectRevisionRef,
            MediaProductionAdmissionBinding.Binding binding,
            CompilationInputs inputs) {
        Objects.requireNonNull(spec, "spec");
        if (inputs != null && !spec.schemaVersion().equals(inputs.productionSpecSchemaVersion())) {
            throw new IllegalArgumentException("productionSpecSchemaVersion must match the specification schemaVersion");
        }
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
        if (binding != null && spec.sceneRefs().size() > 1) {
            // The v2 authority envelope binds one source version and has no
            // source-per-scene mapping. Do not compile an admitted-looking DAG
            // whose source rights cannot be bound to every scene.
            throw new MediaProductionAdmissionBinding.AdmissionException(
                    MediaProductionAdmissionBinding.AdmissionFailure.MULTI_SOURCE_AUTHORITY_UNMAPPED);
        }
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
        if (admissionFingerprint != null) planBinding.add(admissionFingerprint);
        planBinding.addAll(engineContext(binding, "validate-spec"));
        addNode(nodes, fingerprints, "validate-spec", "validate", ExecutionMode.AUTOMATIC,
                List.of(), List.of(spec.revisionId(), spec.purposeRef()), planBinding);
        addNode(nodes, fingerprints, "rights-review", "rights-review", ExecutionMode.MANUAL_GATE,
                List.of("validate-spec"), List.of(spec.rightsRef()), engineContext(binding, "rights-review"));
        List<String> captureIds = new ArrayList<>();
        for (int i = 0; i < spec.sceneRefs().size(); i++) {
            String id = "capture-source-" + i;
            addNode(nodes, fingerprints, id, "capture", ExecutionMode.AUTOMATIC,
                    List.of("rights-review"), List.of(spec.sceneRefs().get(i)), engineContext(binding, id));
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
        if (admissionFingerprint != null) appendField(projection, admissionFingerprint);
        appendField(projection, Integer.toString(nodes.size()));
        for (PlanNode node : nodes) {
            appendField(projection, node.stepId());
            appendField(projection, node.nodeFingerprint());
        }
        return new CompiledPlan(
                "media.production-plan.v1",
                spec.revisionId(),
                spec.originClass(),
                nodes,
                "sha256:" + sha256(projection.toString()),
                inputs,
                admissionFingerprint);
    }

    private static List<String> engineContext(
            MediaProductionAdmissionBinding.Binding binding, String stepId) {
        return binding == null ? List.of() : List.of(binding.engineFingerprint(stepId));
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
