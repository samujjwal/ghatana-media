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
            for (String field : List.of(tenantId, projectId, revisionId, originClass,
                    purposeRef, timelineRef, rightsRef)) {
                requireText(field, "spec field");
            }
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

        /** The nodes whose fingerprints differ from a prior compile — affected descendants only. */
        public List<String> invalidatedAgainst(CompiledPlan prior) {
            Map<String, String> priorPrints = new LinkedHashMap<>();
            for (PlanNode node : prior.nodes()) {
                priorPrints.put(node.stepId(), node.nodeFingerprint());
            }
            List<String> invalidated = new ArrayList<>();
            for (PlanNode node : nodes) {
                if (!node.nodeFingerprint().equals(priorPrints.get(node.stepId()))) {
                    invalidated.add(node.stepId());
                }
            }
            return invalidated;
        }
    }

    /**
     * Compiles a spec into the deterministic plan DAG. The DAG is fixed in
     * shape: validate → per-scene capture (automatic) → rights review
     * (manual gate) → compose → per-profile render (automatic) → publish
     * review (manual gate). Node fingerprints bind exact version refs so a
     * changed source revision invalidates only its descendants.
     */
    public CompiledPlan compile(ProductionSpec spec) {
        Objects.requireNonNull(spec, "spec");
        Map<String, String> fingerprints = new LinkedHashMap<>();
        List<PlanNode> nodes = new ArrayList<>();

        addNode(nodes, fingerprints, "validate-spec", "validate", ExecutionMode.AUTOMATIC,
                List.of(), List.of(spec.revisionId(), spec.purposeRef()));
        List<String> captureIds = new ArrayList<>();
        for (int i = 0; i < spec.sceneRefs().size(); i++) {
            String id = "capture-source-" + i;
            addNode(nodes, fingerprints, id, "capture", ExecutionMode.AUTOMATIC,
                    List.of("validate-spec"), List.of(spec.sceneRefs().get(i)));
            captureIds.add(id);
        }
        addNode(nodes, fingerprints, "rights-review", "rights-review", ExecutionMode.MANUAL_GATE,
                captureIds, List.of(spec.rightsRef()));
        addNode(nodes, fingerprints, "compose-timeline", "compose", ExecutionMode.AUTOMATIC,
                List.of("rights-review"), List.of(spec.timelineRef));
        List<String> renderIds = new ArrayList<>();
        for (int i = 0; i < spec.outputProfileRefs().size(); i++) {
            String id = "render-profile-" + i;
            addNode(nodes, fingerprints, id, "render", ExecutionMode.AUTOMATIC,
                    List.of("compose-timeline"), List.of(spec.outputProfileRefs().get(i)));
            renderIds.add(id);
        }
        addNode(nodes, fingerprints, "publish-review", "publish-review", ExecutionMode.MANUAL_GATE,
                renderIds, List.of(spec.revisionId()));

        String projection = spec.revisionId() + "|" + spec.originClass() + "|"
                + spec.purposeRef() + "|" + spec.rightsRef();
        for (PlanNode node : nodes) {
            projection += "|" + node.stepId() + ":" + node.nodeFingerprint();
        }
        return new CompiledPlan(
                "media.production-plan.v1",
                spec.revisionId(),
                spec.originClass(),
                nodes,
                "sha256:" + sha256(projection));
    }

    private static void addNode(
            List<PlanNode> nodes,
            Map<String, String> fingerprints,
            String stepId,
            String kind,
            ExecutionMode mode,
            List<String> dependsOn,
            List<String> versionRefs) {
        StringBuilder fingerprintInput = new StringBuilder(kind).append('|').append(mode);
        for (String dep : dependsOn) {
            fingerprintInput.append('|').append(dep).append(':').append(fingerprints.get(dep));
        }
        for (String ref : versionRefs) {
            fingerprintInput.append('|').append(ref);
        }
        String nodeFingerprint = "sha256:" + sha256(fingerprintInput.toString());
        fingerprints.put(stepId, nodeFingerprint);
        nodes.add(new PlanNode(stepId, kind, mode, dependsOn, versionRefs, nodeFingerprint));
    }

    private static void requireText(String value, String field) {
        if (value == null || value.isBlank() || value.length() > 384 || !value.equals(value.trim())) {
            throw new IllegalArgumentException(field + " is required, bounded and canonical");
        }
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
