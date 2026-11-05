package com.ghatana.audiovideo.adapter.ledger;

import com.ghatana.core.lifecycle.ExecutionOutcome;
import com.ghatana.core.lifecycle.JobExecutionState;
import com.ghatana.datacloud.delivery.ledger.InputSnapshot;
import com.ghatana.datacloud.delivery.ledger.OutputSnapshot;
import com.ghatana.datacloud.delivery.ledger.RunLedger;
import com.ghatana.datacloud.delivery.ledger.WorkflowPolicySnapshot;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.node.ObjectNode;

import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Explicit JSON codec for {@link RunLedger} and its snapshot value types.
 * Field-by-field mapping keeps the durable projection backing independent of
 * databind record-introspection edge cases; the canonical constructors
 * re-validate every invariant on decode, so corrupt records fail closed.
 */
final class RunLedgerJson {

    private static final ObjectMapper JSON = new ObjectMapper();

    private RunLedgerJson() {}

    static String encode(RunLedger ledger) {
        ObjectNode root = JSON.createObjectNode();
        root.put("runId", ledger.runId());
        root.put("runType", ledger.runType());
        root.put("contextId", ledger.contextId());
        root.put("state", ledger.state().name());
        if (ledger.outcome() != null) root.put("outcome", ledger.outcome().name());
        root.put("createdAtMs", ledger.createdAtMs());
        root.put("startedAtMs", ledger.startedAtMs());
        root.put("completedAtMs", ledger.completedAtMs());
        root.set("inputs", encodeInputs(ledger.inputs()));
        if (ledger.outputs() != null) root.set("outputs", encodeOutputs(ledger.outputs()));
        if (ledger.failureReason() != null) root.put("failureReason", ledger.failureReason());
        ledger.failureTrace().ifPresent(t -> root.put("failureTrace", t));
        root.put("attemptNumber", ledger.attemptNumber());
        root.put("maxRetries", ledger.maxRetries());
        root.put("retryPolicy", ledger.retryPolicy());
        root.put("nextRetryAtMs", ledger.nextRetryAtMs());
        root.put("policyCheckpointId", ledger.policyCheckpointId());
        ledger.policyDecision().ifPresent(p -> root.set("policyDecision", encodePolicy(p)));
        root.put("auditEventId", ledger.auditEventId());
        root.put("requiresBlockingAudit", ledger.requiresBlockingAudit());
        root.put("traceId", ledger.traceId());
        root.put("correlationId", ledger.correlationId());
        ObjectNode attrs = JSON.createObjectNode();
        ledger.attributes().forEach(attrs::put);
        root.set("attributes", attrs);
        return root.toString();
    }

    static RunLedger decode(String json) {
        JsonNode root;
        try {
            root = JSON.readTree(json);
        } catch (RuntimeException e) {
            throw new IllegalStateException("run ledger record corrupt", e);
        }
        return new RunLedger(
                text(root, "runId"), text(root, "runType"), text(root, "contextId"),
                JobExecutionState.valueOf(text(root, "state")),
                root.hasNonNull("outcome") ? ExecutionOutcome.valueOf(root.get("outcome").asText()) : null,
                root.path("createdAtMs").asLong(), root.path("startedAtMs").asLong(),
                root.path("completedAtMs").asLong(),
                decodeInputs(required(root, "inputs")),
                root.has("outputs") && !root.get("outputs").isNull() ? decodeOutputs(root.get("outputs")) : null,
                root.hasNonNull("failureReason") ? root.get("failureReason").asText() : null,
                Optional.ofNullable(root.hasNonNull("failureTrace") ? root.get("failureTrace").asText() : null),
                root.path("attemptNumber").asInt(), root.path("maxRetries").asInt(),
                text(root, "retryPolicy"), root.path("nextRetryAtMs").asLong(),
                text(root, "policyCheckpointId"),
                Optional.ofNullable(root.has("policyDecision") && !root.get("policyDecision").isNull()
                        ? decodePolicy(root.get("policyDecision")) : null),
                text(root, "auditEventId"), root.path("requiresBlockingAudit").asBoolean(),
                text(root, "traceId"), text(root, "correlationId"),
                stringMap(required(root, "attributes")));
    }

    private static ObjectNode encodeInputs(InputSnapshot in) {
        ObjectNode node = JSON.createObjectNode();
        node.set("parameters", stringMapNode(in.parameters()));
        if (in.requestBody() != null) node.put("requestBody", in.requestBody());
        node.set("headers", stringMapNode(in.headers()));
        node.put("initiatedBy", in.initiatedBy());
        node.put("receivedAtMs", in.receivedAtMs());
        return node;
    }

    private static InputSnapshot decodeInputs(JsonNode node) {
        return new InputSnapshot(
                stringMap(required(node, "parameters")),
                node.hasNonNull("requestBody") ? node.get("requestBody").asText() : null,
                stringMap(required(node, "headers")),
                text(node, "initiatedBy"), node.path("receivedAtMs").asLong());
    }

    private static ObjectNode encodeOutputs(OutputSnapshot out) {
        ObjectNode node = JSON.createObjectNode();
        node.put("statusCode", out.statusCode());
        if (out.responseBody() != null) node.put("responseBody", out.responseBody());
        node.set("headers", stringMapNode(out.headers()));
        node.put("durationMs", out.durationMs());
        ObjectNode metrics = JSON.createObjectNode();
        out.metrics().forEach((k, v) -> metrics.set(k, JSON.valueToTree(v)));
        node.set("metrics", metrics);
        if (out.resultId() != null) node.put("resultId", out.resultId());
        return node;
    }

    private static OutputSnapshot decodeOutputs(JsonNode node) {
        Map<String, Number> metrics = new LinkedHashMap<>();
        required(node, "metrics").properties().forEach(e -> metrics.put(e.getKey(), e.getValue().numberValue()));
        return new OutputSnapshot(
                node.path("statusCode").asInt(),
                node.hasNonNull("responseBody") ? node.get("responseBody").asText() : null,
                stringMap(required(node, "headers")),
                node.path("durationMs").asLong(), metrics,
                node.hasNonNull("resultId") ? node.get("resultId").asText() : null);
    }

    private static ObjectNode encodePolicy(WorkflowPolicySnapshot policy) {
        ObjectNode node = JSON.createObjectNode();
        node.put("policyId", policy.policyId());
        node.put("allowed", policy.allowed());
        node.put("reason", policy.reason());
        var constraints = JSON.createArrayNode();
        policy.constraints().forEach(constraints::add);
        node.set("constraints", constraints);
        node.put("evaluatedAtMs", policy.evaluatedAtMs());
        return node;
    }

    private static WorkflowPolicySnapshot decodePolicy(JsonNode node) {
        Set<String> constraints = new LinkedHashSet<>();
        node.get("constraints").forEach(c -> constraints.add(c.asText()));
        return new WorkflowPolicySnapshot(
                text(node, "policyId"),
                node.path("allowed").asBoolean(),
                text(node, "reason"),
                constraints,
                node.path("evaluatedAtMs").asLong());
    }

    private static ObjectNode stringMapNode(Map<String, String> map) {
        ObjectNode node = JSON.createObjectNode();
        map.forEach(node::put);
        return node;
    }

    private static Map<String, String> stringMap(JsonNode node) {
        Map<String, String> map = new LinkedHashMap<>();
        node.properties().forEach(e -> map.put(e.getKey(), e.getValue().asText()));
        return Map.copyOf(map);
    }

    private static JsonNode required(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull()) throw new IllegalStateException("run ledger record missing field: " + field);
        return value;
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || value.isNull() || !value.isTextual()) {
            throw new IllegalStateException("run ledger record missing field: " + field);
        }
        return value.asText();
    }
}
