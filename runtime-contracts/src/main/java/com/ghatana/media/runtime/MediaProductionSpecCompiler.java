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

    /** Typed spec — the Java mirror of media.declarative.value.production-spec.v1. */
    public record ProductionSpec(
            String tenantId,
            String projectId,
            String revisionId,
            String originClass,
            String purposeRef,
            List<String> sceneRefs,
            String timelineRef,
            String rightsRef,
            List<String> outputProfileRefs) {
        public ProductionSpec {
            sceneRefs = List.copyOf(Objects.requireNonNull(sceneRefs, "sceneRefs"));
            outputProfileRefs = List.copyOf(Objects.requireNonNull(outputProfileRefs, "outputProfileRefs"));
            requireIdentifier(tenantId, "tenantId");
            requireIdentifier(projectId, "projectId");
            requireIdentifier(revisionId, "revisionId");
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

    /** The compiled plan — ordered DAG + stable fingerprint + canonical revision. */
    public record CompiledPlan(
            String schemaVersion,
            String projectRevision,
            String originClass,
            List<PlanNode> nodes,
            String planFingerprint) {
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
     * Compiles a spec into the deterministic plan DAG. The DAG is fixed in
     * shape: validate → rights review (manual gate) → per-scene capture →
     * compose → per-profile render → publish review (manual gate). Each
     * external capture still requires current source-specific authorization;
     * this plan and its manual gate do not themselves grant access. Node
     * fingerprints bind exact version refs for descendant invalidation.
     */
    public CompiledPlan compile(ProductionSpec spec) {
        Objects.requireNonNull(spec, "spec");
        Map<String, String> fingerprints = new LinkedHashMap<>();
        List<PlanNode> nodes = new ArrayList<>();

        addNode(nodes, fingerprints, "validate-spec", "validate", ExecutionMode.AUTOMATIC,
                List.of(), List.of(spec.revisionId(), spec.purposeRef()),
                List.of(spec.tenantId(), spec.projectId(), spec.originClass()));
        addNode(nodes, fingerprints, "rights-review", "rights-review", ExecutionMode.MANUAL_GATE,
                List.of("validate-spec"), List.of(spec.rightsRef()));
        List<String> captureIds = new ArrayList<>();
        for (int i = 0; i < spec.sceneRefs().size(); i++) {
            String id = "capture-source-" + i;
            addNode(nodes, fingerprints, id, "capture", ExecutionMode.AUTOMATIC,
                    List.of("rights-review"), List.of(spec.sceneRefs().get(i)));
            captureIds.add(id);
        }
        addNode(nodes, fingerprints, "compose-timeline", "compose", ExecutionMode.AUTOMATIC,
                captureIds, List.of(spec.timelineRef));
        List<String> renderIds = new ArrayList<>();
        for (int i = 0; i < spec.outputProfileRefs().size(); i++) {
            String id = "render-profile-" + i;
            addNode(nodes, fingerprints, id, "render", ExecutionMode.AUTOMATIC,
                    List.of("compose-timeline"), List.of(spec.outputProfileRefs().get(i)));
            renderIds.add(id);
        }
        addNode(nodes, fingerprints, "publish-review", "publish-review", ExecutionMode.MANUAL_GATE,
                renderIds, List.of(spec.revisionId()));

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
                "sha256:" + sha256(projection.toString()));
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
