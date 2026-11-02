package com.ghatana.media.runtime;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.TreeSet;

/** Versioned PDP-1 semantic graph input. This model never represents execution admission. */
public record MediaProductionSemanticSource(
        String schemaVersion,
        SourceBindings sourceBindings,
        List<Node> nodes) {
    public static final String SCHEMA_VERSION = "media.production.semantic-source.v1";
    public static final int MAX_NODES = 512;
    public static final int MAX_REFERENCES_PER_NODE = 512;

    public MediaProductionSemanticSource {
        if (!SCHEMA_VERSION.equals(schemaVersion)) throw new IllegalArgumentException("unsupported semantic source version");
        Objects.requireNonNull(sourceBindings, "sourceBindings");
        nodes = List.copyOf(Objects.requireNonNull(nodes, "nodes"));
        if (nodes.isEmpty() || nodes.size() > MAX_NODES) throw new IllegalArgumentException("nodes must contain 1.." + MAX_NODES);
    }

    public record SourceBindings(
            String productionSpecRef, String productionSpecSha256,
            String productionSpecSchemaRef, String productionSpecSchemaSha256,
            String compilerContractRef, String compilerContractSha256) {
        public SourceBindings {
            requireVersionRef(productionSpecRef, "productionSpecRef");
            requireDigest(productionSpecSha256, "productionSpecSha256");
            requireVersionRef(productionSpecSchemaRef, "productionSpecSchemaRef");
            requireDigest(productionSpecSchemaSha256, "productionSpecSchemaSha256");
            requireVersionRef(compilerContractRef, "compilerContractRef");
            requireDigest(compilerContractSha256, "compilerContractSha256");
        }
    }

    /** kind remains text at the decode boundary so unknown enum values return typed UNKNOWN. */
    public record Node(
            String stepId, String kind, String operationRef,
            List<String> inputArtifactVersionRefs,
            List<String> outputArtifactVersionRefs,
            List<String> dependsOn,
            List<String> sourceSceneRefs,
            Optional<LockTarget> manualLockTarget) {
        public Node {
            requireIdentifier(stepId, "stepId");
            Objects.requireNonNull(kind, "kind");
            requireVersionRef(operationRef, "operationRef");
            inputArtifactVersionRefs = immutableRefs(inputArtifactVersionRefs, "inputArtifactVersionRefs");
            outputArtifactVersionRefs = immutableRefs(outputArtifactVersionRefs, "outputArtifactVersionRefs");
            dependsOn = List.copyOf(Objects.requireNonNull(dependsOn, "dependsOn"));
            if (dependsOn.size() > MAX_REFERENCES_PER_NODE) throw new IllegalArgumentException("too many dependencies");
            dependsOn.forEach(id -> requireIdentifier(id, "dependsOn"));
            sourceSceneRefs = immutableRefs(sourceSceneRefs, "sourceSceneRefs");
            manualLockTarget = Objects.requireNonNull(manualLockTarget, "manualLockTarget");
        }
    }

    public record LockTarget(String scopeKind, String targetRef) {
        public LockTarget {
            if (!Set.of("SCENE", "OUTPUT").contains(scopeKind)) throw new IllegalArgumentException("unsupported lock scope");
            requireVersionRef(targetRef, "lock targetRef");
        }
    }

    public enum NodeKind { DETERMINISTIC, GENERATIVE, UNKNOWN }
    public enum Disposition { CANDIDATE_PREPARED, UNKNOWN, NOT_ADMITTED }
    public enum Reason {
        NONE, ABSENT_GRAPH, DUPLICATE_STEP_ID, UNKNOWN_NODE_KIND,
        UNRESOLVED_OPERATION, AMBIGUOUS_OPERATION, UNRESOLVED_SOURCE_BINDING,
        SOURCE_BINDING_MISMATCH, MISSING_DEPENDENCY, CYCLIC_GRAPH, EXECUTION_CONTEXT_MISMATCH,
        INVALID_SEMANTIC_SOURCE_CONTENT, STEP_OPERATION_MAPPING_UNDEFINED
    }

    public record NormalizedNode(
            String stepId, NodeKind kind, String operationRef,
            List<String> inputArtifactVersionRefs,
            List<String> outputArtifactVersionRefs,
            List<String> dependsOn,
            List<String> sourceSceneRefs,
            Optional<LockTarget> manualLockTarget) { }

    public record CompilationResult(Disposition disposition, Reason reason,
                                    List<NormalizedNode> nodes, String fingerprint) {
        public CompilationResult {
            nodes = List.copyOf(nodes);
        }
    }

    /**
     * Package-private graph shape/syntax checks after the owning compiler has
     * digest-verified semantic-source bytes. Node references are not resolved;
     * source-binding fingerprints and operation cardinalities are caller evidence.
     */
    CompilationResult compileSyntaxCheckedGraphCandidate(
            MediaProductionSpecCompiler.CompilationInputs expectedInputs,
            List<MediaVersionedContractContent.ResolvedContentFingerprint> resolvedSources,
            Map<String, Integer> operationResolutionCounts) {
        Objects.requireNonNull(expectedInputs, "expectedInputs");
        Objects.requireNonNull(resolvedSources, "resolvedSources");
        Objects.requireNonNull(operationResolutionCounts, "operationResolutionCounts");
        if (nodes.isEmpty()) return result(Disposition.UNKNOWN, Reason.ABSENT_GRAPH);
        if (!sourceBindings.productionSpecRef().equals(expectedInputs.productionSpecRef())
                || !sourceBindings.productionSpecSchemaRef().equals(expectedInputs.productionSpecSchemaRef())
                || !sourceBindings.compilerContractRef().equals(expectedInputs.compilerContractRef())) {
            return result(Disposition.UNKNOWN, Reason.SOURCE_BINDING_MISMATCH);
        }

        Map<String, MediaVersionedContractContent.ResolvedContentFingerprint> byRef = new HashMap<>();
        for (var source : resolvedSources) {
            if (source != null && byRef.put(source.versionRef(), source) != null) {
                return result(Disposition.UNKNOWN, Reason.UNRESOLVED_SOURCE_BINDING);
            }
        }
        if (!matches(sourceBindings.productionSpecRef(), sourceBindings.productionSpecSha256(), byRef)
                || !matches(sourceBindings.productionSpecSchemaRef(), sourceBindings.productionSpecSchemaSha256(), byRef)
                || !matches(sourceBindings.compilerContractRef(), sourceBindings.compilerContractSha256(), byRef)) {
            return result(Disposition.UNKNOWN, Reason.SOURCE_BINDING_MISMATCH);
        }

        Map<String, Node> byId = new HashMap<>();
        for (Node node : nodes) {
            if (byId.put(node.stepId(), node) != null) return result(Disposition.UNKNOWN, Reason.DUPLICATE_STEP_ID);
            if (!Set.of("DETERMINISTIC", "GENERATIVE", "UNKNOWN").contains(node.kind())) {
                return result(Disposition.UNKNOWN, Reason.UNKNOWN_NODE_KIND);
            }
            Integer matches = operationResolutionCounts.get(node.operationRef());
            if (matches == null || matches == 0) return result(Disposition.UNKNOWN, Reason.UNRESOLVED_OPERATION);
            if (matches != 1) return result(Disposition.UNKNOWN, Reason.AMBIGUOUS_OPERATION);
            if ("UNKNOWN".equals(node.kind())) return result(Disposition.UNKNOWN, Reason.UNKNOWN_NODE_KIND);
        }
        for (Node node : nodes) {
            if (new HashSet<>(node.dependsOn()).size() != node.dependsOn().size()) {
                return result(Disposition.UNKNOWN, Reason.DUPLICATE_STEP_ID);
            }
            if (!byId.keySet().containsAll(node.dependsOn())) return result(Disposition.UNKNOWN, Reason.MISSING_DEPENDENCY);
        }

        List<NormalizedNode> ordered = topologicalOrder(byId);
        if (ordered == null) return result(Disposition.NOT_ADMITTED, Reason.CYCLIC_GRAPH);
        String fingerprint = fingerprint(sourceBindings, ordered);
        return new CompilationResult(Disposition.CANDIDATE_PREPARED, Reason.NONE, ordered, fingerprint);
    }

    private CompilationResult result(Disposition disposition, Reason reason) {
        return new CompilationResult(disposition, reason, List.of(), null);
    }

    private static boolean matches(String ref, String digest,
                                   Map<String, MediaVersionedContractContent.ResolvedContentFingerprint> resolved) {
        var item = resolved.get(ref);
        return item != null && item.sha256().equals(digest);
    }

    private static List<NormalizedNode> topologicalOrder(Map<String, Node> byId) {
        Map<String, Integer> indegree = new HashMap<>();
        Map<String, List<String>> children = new HashMap<>();
        byId.keySet().forEach(id -> { indegree.put(id, 0); children.put(id, new ArrayList<>()); });
        for (Node node : byId.values()) for (String dependency : node.dependsOn()) {
            indegree.compute(node.stepId(), (key, value) -> value + 1);
            children.get(dependency).add(node.stepId());
        }
        TreeSet<String> ready = new TreeSet<>();
        indegree.forEach((id, degree) -> { if (degree == 0) ready.add(id); });
        List<NormalizedNode> output = new ArrayList<>();
        while (!ready.isEmpty()) {
            String id = ready.pollFirst();
            Node node = byId.get(id);
            output.add(new NormalizedNode(id, NodeKind.valueOf(node.kind()), node.operationRef(),
                    node.inputArtifactVersionRefs().stream().sorted().toList(),
                    node.outputArtifactVersionRefs().stream().sorted().toList(),
                    node.dependsOn().stream().sorted().toList(),
                    node.sourceSceneRefs().stream().sorted().toList(), node.manualLockTarget()));
            children.get(id).stream().sorted().forEach(child -> {
                int next = indegree.compute(child, (key, value) -> value - 1);
                if (next == 0) ready.add(child);
            });
        }
        return output.size() == byId.size() ? List.copyOf(output) : null;
    }

    private static String fingerprint(SourceBindings bindings, List<NormalizedNode> nodes) {
        StringBuilder canonical = new StringBuilder();
        field(canonical, SCHEMA_VERSION);
        field(canonical, bindings.productionSpecRef()); field(canonical, bindings.productionSpecSha256());
        field(canonical, bindings.productionSpecSchemaRef()); field(canonical, bindings.productionSpecSchemaSha256());
        field(canonical, bindings.compilerContractRef()); field(canonical, bindings.compilerContractSha256());
        field(canonical, Integer.toString(nodes.size()));
        for (NormalizedNode node : nodes) {
            field(canonical, node.stepId()); field(canonical, node.kind().name()); field(canonical, node.operationRef());
            list(canonical, node.inputArtifactVersionRefs());
            list(canonical, node.outputArtifactVersionRefs());
            list(canonical, node.dependsOn());
            list(canonical, node.sourceSceneRefs());
            field(canonical, node.manualLockTarget().map(LockTarget::scopeKind).orElse("NO_LOCK"));
            field(canonical, node.manualLockTarget().map(LockTarget::targetRef).orElse("NO_LOCK"));
        }
        try {
            return "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(canonical.toString().getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) { throw new IllegalStateException("SHA-256 unavailable", e); }
    }

    private static void list(StringBuilder target, List<String> values) {
        field(target, Integer.toString(values.size())); values.forEach(value -> field(target, value));
    }
    private static void field(StringBuilder target, String value) {
        if (!hasWellFormedUtf16(value)) throw new IllegalArgumentException("malformed UTF-16 in semantic fingerprint input");
        target.append(value.getBytes(StandardCharsets.UTF_8).length).append(':').append(value);
    }
    private static List<String> immutableRefs(List<String> refs, String field) {
        List<String> values = List.copyOf(Objects.requireNonNull(refs, field));
        if (values.size() > MAX_REFERENCES_PER_NODE) throw new IllegalArgumentException(field + " exceeds the bound");
        values.forEach(ref -> requireVersionRef(ref, field));
        if (new HashSet<>(values).size() != values.size()) throw new IllegalArgumentException(field + " must be unique");
        return values;
    }
    private static void requireIdentifier(String value, String field) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) throw new IllegalArgumentException(field + " is invalid");
    }
    private static void requireVersionRef(String value, String field) {
        if (value == null || value.isEmpty() || value.codePointCount(0, value.length()) > 384 || !hasWellFormedUtf16(value)
                || value.codePoints().anyMatch(ch -> Character.isWhitespace(ch) || Character.isSpaceChar(ch) || ch == 0xFEFF)) {
            throw new IllegalArgumentException(field + " is invalid");
        }
    }

    private static boolean hasWellFormedUtf16(String value) {
        for (int index = 0; index < value.length(); index++) {
            char current = value.charAt(index);
            if (Character.isHighSurrogate(current)) {
                if (index + 1 >= value.length() || !Character.isLowSurrogate(value.charAt(index + 1))) return false;
                index++;
            } else if (Character.isLowSurrogate(current)) return false;
        }
        return true;
    }
    private static void requireDigest(String value, String field) {
        if (value == null || !value.matches("sha256:[0-9a-f]{64}")) throw new IllegalArgumentException(field + " is invalid");
    }
}
