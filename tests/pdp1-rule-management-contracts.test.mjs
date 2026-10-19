import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { buildPdp1SourceCensus } from "../scripts/report-media-pdp-readiness.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const Ajv2020 = require("ajv/dist/2020").default ?? require("ajv/dist/2020");
const sourcePath = ".product-experience/pdp-1-domain-data/rule-management-contracts.yaml";
const contract = parse(readFileSync(resolve(root, sourcePath), "utf8"));
const ajv = new Ajv2020({ allErrors: true, strict: false, validateFormats: false });

function pointer(rootValue, ref) {
  return ref.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, key) => value[key], rootValue);
}

function resolveRefs(schema) {
  if (Array.isArray(schema)) return schema.map(resolveRefs);
  if (!schema || typeof schema !== "object") return schema;
  if (schema.$ref) return resolveRefs(structuredClone(pointer(contract, schema.$ref)));
  return Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, resolveRefs(value)]));
}

function assertSchema(path, value) {
  const schema = path.split(".").reduce((current, key) => current[key], contract);
  const validate = ajv.compile(resolveRefs(schema));
  assert.equal(validate(value), true, `${path}: ${JSON.stringify(validate.errors)}`);
}

function assertRejected(path, value) {
  const schema = path.split(".").reduce((current, key) => current[key], contract);
  const validate = ajv.compile(resolveRefs(schema));
  assert.equal(validate(value), false, `${path} must reject ${JSON.stringify(value)}`);
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const normalized = new Map();
    for (const key of Object.keys(value)) {
      const normalizedKey = key.normalize("NFC");
      assert.equal(normalized.has(normalizedKey), false, "NFC-equivalent keys are rejected");
      normalized.set(normalizedKey, value[key]);
    }
    const keys = [...normalized.keys()].sort(compareUtf8);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonical(normalized.get(key))}`).join(",")}}`;
  }
  if (typeof value === "number") assert.equal(Number.isFinite(value), true, "non-finite numbers are rejected");
  return JSON.stringify(value);
}

function compareUtf8(left, right) {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

function normalizeGraph(graph) {
  return {
    ...graph,
    scope: { ...graph.scope, targetOperationRefs: [...graph.scope.targetOperationRefs].sort(compareUtf8) },
    declaredInputs: [...graph.declaredInputs].sort((a, b) => compareUtf8(a.inputRef, b.inputRef)),
    constraints: [...graph.constraints].sort((a, b) => compareUtf8(a.constraintRef, b.constraintRef)),
    nodes: [...graph.nodes].map((node) => node.nodeKind === "RULE" ? { ...node, sourceRefs: [...node.sourceRefs].sort(compareUtf8) } : node).sort((a, b) => compareUtf8(a.nodeId, b.nodeId)),
    edges: [...graph.edges].sort((a, b) => compareUtf8(a.edgeId, b.edgeId)),
  };
}

function fingerprint(graph) {
  return `sha256:${createHash("sha256").update("media.rules.graph.v1\n", "utf8").update(canonical(normalizeGraph(graph)), "utf8").digest("hex")}`;
}

function assertGraphValid(value, expected) {
  const nodeIds = new Set(value.nodes.map(({ nodeId }) => nodeId));
  const edgeIds = value.edges.map(({ edgeId }) => edgeId);
  assert.equal(nodeIds.size, value.nodes.length, "node IDs are unique");
  assert.equal(new Set(edgeIds).size, edgeIds.length, "edge IDs are unique");
  for (const edge of value.edges) {
    assert.ok(nodeIds.has(edge.fromNodeId) && nodeIds.has(edge.toNodeId), "edge endpoints resolve");
    const sourceKind = value.nodes.find(({ nodeId }) => nodeId === edge.fromNodeId)?.nodeKind;
    const targetKind = value.nodes.find(({ nodeId }) => nodeId === edge.toNodeId)?.nodeKind;
    if (edge.port === "input") assert.ok(["INPUT", "RULE"].includes(sourceKind) && targetKind === "RULE", "input port connects INPUT/RULE to RULE");
    else if (edge.port === "result") assert.equal(sourceKind === "RULE" && ["RULE", "OUTPUT"].includes(targetKind), true, "result port connects RULE to RULE/OUTPUT");
    else assert.fail("unknown graph edge port");
  }
  assert.ok(value.nodes.some(({ nodeKind }) => nodeKind === "RULE"));
  assert.ok(value.nodes.some(({ nodeKind }) => nodeKind === "INPUT"));
  assert.ok(value.nodes.some(({ nodeKind }) => nodeKind === "OUTPUT"));
  assert.deepEqual(value.scope, expected.declaredScope ?? expected.scope, "graph scope matches the exact candidate");
  assert.equal(value.ruleSetRef, expected.ruleSetRef, "graph ruleSetRef matches the exact candidate");
  assert.deepEqual(value.ruleSetVersion, expected.ruleSetVersion, "graph carries the exact version tuple");
  assert.deepEqual(value.declaredInputs, expected.declaredInputs, "graph carries exact declared inputs");
  assert.deepEqual(value.constraints, expected.constraints, "graph carries exact constraints");
  assert.equal(new Set(value.declaredInputs.map(({ inputRef }) => inputRef)).size, value.declaredInputs.length, "input references are unique");
  assert.equal(new Set(value.constraints.map(({ constraintRef }) => constraintRef)).size, value.constraints.length, "constraint references are unique");
  assert.equal(new Set(value.nodes.filter(({ nodeKind }) => nodeKind === "RULE").map(({ ruleId }) => ruleId)).size, expected.rules.length, "rule identities are unique");
  const declaredInputRefs = new Set(value.declaredInputs.map(({ inputRef }) => inputRef));
  const candidateSourceRefs = new Set(expected.sourceRefs);
  const graphRules = value.nodes.filter(({ nodeKind }) => nodeKind === "RULE");
  assert.deepEqual(graphRules.map(({ ruleId }) => ruleId).sort(compareUtf8), expected.rules.map(({ ruleId }) => ruleId).sort(compareUtf8), "graph contains exactly the candidate rules");
  for (const node of graphRules) {
    const rule = expected.rules.find(({ ruleId }) => ruleId === node.ruleId);
    assert.deepEqual({ operatorRef: node.operatorRef, parameters: node.parameters, sourceRefs: node.sourceRefs }, { operatorRef: rule.operatorRef, parameters: rule.parameters, sourceRefs: rule.sourceRefs }, "graph rule preserves exact candidate semantics and provenance");
    assert.ok(declaredInputRefs.has(node.parameters.fieldRef), "rule fields bind to a declared typed input");
    for (const sourceRef of node.sourceRefs) assert.ok(candidateSourceRefs.has(sourceRef), "rule provenance belongs to candidate source refs");
  }
  for (const node of value.nodes.filter(({ nodeKind }) => nodeKind === "INPUT")) {
    const input = value.declaredInputs.find(({ inputRef }) => inputRef === node.inputRef);
    assert.ok(input, "input node binds to an exact declared input");
    assert.equal(input.sourceVersionRef, node.sourceVersionRef, "input node preserves the declared source version");
  }
  for (const constraint of value.constraints) assert.ok(candidateSourceRefs.has(constraint.sourceRef), "constraint provenance belongs to candidate source refs");
  const adjacency = new Map(value.nodes.map(({ nodeId }) => [nodeId, []]));
  for (const edge of value.edges) adjacency.get(edge.fromNodeId).push(edge.toNodeId);
  const active = new Set();
  const done = new Set();
  function visit(id) {
    assert.equal(active.has(id), false, "graph is acyclic");
    if (done.has(id)) return;
    active.add(id);
    for (const child of adjacency.get(id)) visit(child);
    active.delete(id);
    done.add(id);
  }
  for (const id of nodeIds) visit(id);
  const reachableFrom = (starts) => {
    const reached = new Set(starts);
    const pending = [...starts];
    while (pending.length) for (const child of adjacency.get(pending.pop())) if (!reached.has(child)) { reached.add(child); pending.push(child); }
    return reached;
  };
  const inputReachable = reachableFrom(value.nodes.filter(({ nodeKind }) => nodeKind === "INPUT").map(({ nodeId }) => nodeId));
  const reverse = new Map(value.nodes.map(({ nodeId }) => [nodeId, []]));
  for (const edge of value.edges) reverse.get(edge.toNodeId).push(edge.fromNodeId);
  const outputReachable = new Set(value.nodes.filter(({ nodeKind }) => nodeKind === "OUTPUT").map(({ nodeId }) => nodeId));
  const reversePending = [...outputReachable];
  while (reversePending.length) for (const parent of reverse.get(reversePending.pop())) if (!outputReachable.has(parent)) { outputReachable.add(parent); reversePending.push(parent); }
  for (const rule of value.nodes.filter(({ nodeKind }) => nodeKind === "RULE")) {
    assert.ok(inputReachable.has(rule.nodeId), "every rule is reachable from an input");
    assert.ok(outputReachable.has(rule.nodeId), "every rule reaches an output");
  }
}

function ruleSetRefFor(tuple) {
  return `media.ruleset:${tuple.tenantRef}:${tuple.ruleSetId}`;
}

function ruleSetVersionRefFor(tuple) {
  return `media.ruleset-version:${tuple.tenantRef}:${tuple.ruleSetId}:${tuple.versionId}`;
}

function assertContextBindings(context, tuple, scope) {
  assert.equal(context.tenantRef, tuple.tenantRef, "operation tenant matches the exact version tuple");
  assert.equal(context.purposeRef, scope.purposeRef, "operation purpose matches declared scope");
}

function assertRuleSetRefBindings(ref, context) {
  const [, tenantRef, ruleSetId] = ref.split(":");
  assert.equal(ref, `media.ruleset:${tenantRef}:${ruleSetId}`, "ruleSetRef has the declared canonical tuple encoding");
  assert.equal(tenantRef, context.tenantRef, "ruleSetRef tenant equals the operation request tenant");
  return { tenantRef, ruleSetId };
}

function assertReuseMatchesReceipt(request, receipt, plan, scope) {
  assert.equal(request.validationResultRef, receipt.validationResultRef, "reuse names the exact validation receipt");
  assert.equal(request.candidateVersionRef, receipt.candidateVersionRef, "reuse names the validated candidate version");
  assert.deepEqual(request.ruleSetVersion, receipt.ruleSetVersion, "reuse version tuple equals the validation receipt tuple");
  assert.equal(request.expectedFingerprint, receipt.fingerprint, "reuse fingerprint equals the receipt fingerprint");
  assert.equal(request.validationContextRef, receipt.validationContextRef, "reuse validation context equals the receipt context");
  assert.equal(request.candidateVersionRef, ruleSetVersionRefFor(request.ruleSetVersion), "version reference encodes the exact typed tuple");
  assert.equal(receipt.candidateVersionRef, ruleSetVersionRefFor(receipt.ruleSetVersion), "validation receipt version reference encodes its exact tuple");
  assert.equal(request.requestContext.tenantRef, request.ruleSetVersion.tenantRef, "reuse tenant equals its exact rule-set tuple");
  assert.equal(request.targetOperationRef, plan.targetOperationRef, "operation plan binds the requested target operation");
  assert.ok(scope.targetOperationRefs.includes(request.targetOperationRef), "target operation belongs to declared scope");
  assert.ok(request.targetOperationAuthorizationRef, "reuse carries separate target-operation authorization reference");
  assert.equal(plan.targetOperationAuthorizationRef, request.targetOperationAuthorizationRef, "plan preserves exact authorization reference");
  assert.equal(plan.validationResultRef, receipt.validationResultRef, "plan binds the exact validation receipt");
  assert.equal(plan.fingerprint, receipt.fingerprint, "plan binds the exact validated fingerprint");
  assert.equal(plan.validationContextRef, receipt.validationContextRef, "plan binds the exact validation context");
  assert.deepEqual(plan.ruleSetVersion, receipt.ruleSetVersion, "plan carries exact validation version tuple");
  assert.deepEqual(plan.requestedBy, request.requestContext, "plan preserves exact reuse request context");
  assert.equal(plan.reuseRequestRef, request.requestContext.requestIdentity, "plan preserves exact reuse request identity");
  assert.deepEqual(plan.sourceRefs, receipt.sourceRefs, "plan preserves exact validated source provenance");
}

function assertParameterValueCompatibility(rule, declaredInputs) {
  const input = declaredInputs.find(({ inputRef }) => inputRef === rule.parameters.fieldRef);
  assert.ok(input, "rule references a declared typed input");
  const nullable = input.valueType.startsWith("NULLABLE_");
  const baseType = nullable ? input.valueType.slice("NULLABLE_".length) : input.valueType;
  const typeOf = (value) => value === null ? "NULL" : typeof value === "string" ? "STRING" : typeof value === "number" ? "NUMBER" : typeof value === "boolean" ? "BOOLEAN" : "UNSUPPORTED";
  if (rule.parameters.kind === "FIELD_COMPARISON") {
    const { comparator, expectedValue } = rule.parameters;
    if (["GT", "GTE", "LT", "LTE"].includes(comparator)) {
      assert.equal(baseType, "NUMBER", "ordered comparisons require numeric input");
      assert.equal(typeof expectedValue, "number", "ordered comparisons require numeric expectedValue");
    } else {
      assert.equal(typeOf(expectedValue) === baseType || (expectedValue === null && nullable), true, "equality value matches declared input type");
    }
  } else if (rule.parameters.kind === "SET_MEMBERSHIP") {
    assert.ok(["IN", "NOT_IN"].includes(rule.parameters.comparator));
    for (const value of rule.parameters.expectedValues) assert.equal(typeOf(value) === baseType || (value === null && nullable), true, "membership values match declared input type");
  }
}

const requestContext = {
  tenantRef: "tenant-a", actorRef: "actor:creator-1", principalRef: "principal-1",
  purposeRef: "purpose:production", rightsConsentContextRef: "rights-context:current-check",
  requestIdentity: "request-identity-1", idempotencyKey: "idempotency-1",
};

const graph = {
  graphFormat: "media.rules.graph.v1",
  ruleSetRef: "media.ruleset:tenant-a:color-policy",
  ruleSetVersion: { tenantRef: "tenant-a", ruleSetId: "color-policy", versionId: "v2" },
  scope: { targetOperationRefs: ["media.operation.render", "media.operation.transcode"], subjectScopeRef: "scope:project-7", purposeRef: "purpose:production" },
  declaredInputs: [{ inputRef: "media.input.width", sourceVersionRef: "artifact-version:policy-source:v2", valueType: "NUMBER" }],
  constraints: [{ constraintRef: "constraint:min-width", constraintKind: "BOUNDS", sourceRef: "artifact-version:policy-source:v2" }],
  nodes: [
    { nodeId: "rule-2", nodeKind: "RULE", ruleId: "rule-2", operatorRef: "media.rules.operator.compare-field.v1", parameters: { kind: "FIELD_COMPARISON", fieldRef: "media.input.width", comparator: "GTE", expectedValue: 1280 }, sourceRefs: ["artifact-version:policy-source:v2"] },
    { nodeId: "input-1", nodeKind: "INPUT", inputRef: "media.input.width", sourceVersionRef: "artifact-version:policy-source:v2" },
    { nodeId: "output-1", nodeKind: "OUTPUT", outputRef: "media.rules.evaluation-result" },
  ],
  edges: [{ edgeId: "edge-1", fromNodeId: "input-1", toNodeId: "rule-2", port: "input" }, { edgeId: "edge-2", fromNodeId: "rule-2", toNodeId: "output-1", port: "result" }],
};
graph.ruleSetVersion = { tenantRef: "tenant-a", ruleSetId: "color-policy", versionId: "v2" };

const candidate = {
  candidateId: "candidate-2",
  ruleSetRef: "media.ruleset:tenant-a:color-policy",
  ruleSetVersion: { tenantRef: "tenant-a", ruleSetId: "color-policy", versionId: "v2" },
  parentVersionRef: "media.ruleset-version:tenant-a:color-policy:v1",
  declaredScope: graph.scope,
  declaredInputs: graph.declaredInputs,
  constraints: graph.constraints,
  sourceRefs: ["artifact-version:policy-source:v2"],
  rules: [{ ruleId: "rule-2", operatorRef: "media.rules.operator.compare-field.v1", parameters: { kind: "FIELD_COMPARISON", fieldRef: "media.input.width", comparator: "GTE", expectedValue: 1280 }, sourceRefs: ["artifact-version:policy-source:v2"] }],
  lifecycleState: "CANDIDATE",
};

assertContextBindings(requestContext, candidate.ruleSetVersion, candidate.declaredScope);
assert.equal(candidate.ruleSetRef, ruleSetRefFor(candidate.ruleSetVersion), "ruleSetRef encodes the exact stable tuple");
assert.equal(candidate.parentVersionRef, ruleSetVersionRefFor({ ...candidate.ruleSetVersion, versionId: "v1" }), "parent reference encodes exact predecessor tuple");

test("PDP-1 rule proposal defines typed immutable versions, closed graph/fingerprint, compile, validate, reuse, and fail-closed behavior", () => {
  assert.equal(contract.scopeStatus, "proposal-only; pending-owner-review; no-runtime-or-execution-admission");
  assert.equal(contract.ownerApproval, "NOT_CLAIMED");
  assert.equal(contract.independentAcceptance, "NOT_CLAIMED");
  assert.equal(contract.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(contract.executionAdmission, "NOT_ADMITTED");
  assert.equal(contract.contractIdentity.operationDisposition, "PROPOSED_PDP1_CONTRACT_ONLY; NOT_IN_CANONICAL_OPERATION_DENOMINATOR");
  assert.ok(contract.sourceRefs.includes(".product-experience/pdp-0-product-truth/campaign-extensions.yaml#records/@id=AUD-SPEC-020/compileAcceptance"));
  assert.ok(contract.sourceRefs.includes(".product-experience/pdp-0-product-truth/campaign-extensions.yaml#records/@id=AUD-SPEC-020/validationCoverage"));

  assertSchema("ruleSetVersion.candidate.schema", candidate);
  assertParameterValueCompatibility(candidate.rules[0], candidate.declaredInputs);
  assertRejected("ruleSetVersion.candidate.schema", { ...candidate, mystery: true });
  assertRejected("ruleSetVersion.candidate.schema", { ...candidate, lifecycleState: "APPROVED" });
  assertRejected("ruleSetVersion.candidate.schema", { ...candidate, rules: [{ ...candidate.rules[0], parameters: { ...candidate.rules[0].parameters, execute: true } }] });
  assertRejected("ruleSetVersion.candidate.schema", { ...candidate, rules: [{ ...candidate.rules[0], operatorRef: "media.rules.operator.membership-field.v1" }] });
  assertRejected("ruleSetVersion.candidate.schema", { ...candidate, rules: [{ ...candidate.rules[0], parameters: { kind: "SET_MEMBERSHIP", fieldRef: "media.field.width", comparator: "IN", expectedValues: [1280] } }] });
  assertSchema("ruleSetVersion.candidate.schema", { ...candidate, rules: [{ ...candidate.rules[0], operatorRef: "media.rules.operator.membership-field.v1", parameters: { kind: "SET_MEMBERSHIP", fieldRef: "media.input.width", comparator: "IN", expectedValues: [1280, 1920] } }] });
  assert.match(contract.ruleSetVersion.invariants[0], /immutable after creation/u);
  assert.match(contract.ruleSetVersion.invariants[1], /exact prior version/u);
  assert.match(contract.ruleSetVersion.invariants[2], /not an approval.*permission to mutate media/u);
  assert.match(contract.ruleSetVersion.invariants[3], /unknown operators or parameters fail validation/u);

  assertSchema("normalizedSemanticGraph.schema", graph);
  assertGraphValid(graph, candidate);
  assertRejected("normalizedSemanticGraph.schema", { ...graph, untypedExecutableExpression: "run()" });
  assertRejected("normalizedSemanticGraph.schema", { ...graph, nodes: [{ ...graph.nodes[0], operatorRef: "media.rules.operator.unknown.v1" }] });
  const graphPermutation = { ...graph, nodes: [...graph.nodes].reverse(), edges: [...graph.edges].reverse(), scope: { ...graph.scope, targetOperationRefs: [...graph.scope.targetOperationRefs].reverse() } };
  assert.deepEqual(normalizeGraph(graph), normalizeGraph(graphPermutation), "unordered graph sets normalize to the same canonical graph");
  const utf8SortedObject = canonical({ "\u{10000}": 1, "\uE000": 2 });
  assert.ok(utf8SortedObject.indexOf("\"\uE000\"") < utf8SortedObject.indexOf("\"\u{10000}\""), "object keys use unsigned UTF-8 byte order");
  assert.ok(compareUtf8("\uE000", "\u{10000}") < 0, "UTF-8 byte order is used instead of UTF-16 code-unit order");
  assert.throws(() => canonical({ "é": 1, "e\u0301": 2 }), /NFC-equivalent keys are rejected/u);
  const digest = fingerprint(graph);
  assert.equal(digest, fingerprint(graphPermutation), "equivalent authorized inputs have the same stable fingerprint");
  assertSchema("semanticFingerprint.schema", { algorithm: contract.semanticFingerprint.calculation.algorithm, value: digest, graphFormat: graph.graphFormat });
  assert.notEqual(digest, fingerprint({ ...graph, nodes: graph.nodes.map((node) => node.nodeId === "rule-2" ? { ...node, parameters: { ...node.parameters, expectedValue: 1920 } } : node) }), "material semantic changes alter the fingerprint");

  const compileRequest = { requestContext, ruleSetRef: candidate.ruleSetRef, expectedVersionRef: candidate.parentVersionRef, declaredScope: candidate.declaredScope, declaredInputs: candidate.declaredInputs, constraints: candidate.constraints, sourceRefs: candidate.sourceRefs, rules: candidate.rules };
  const compileTuple = assertRuleSetRefBindings(compileRequest.ruleSetRef, compileRequest.requestContext);
  if (compileRequest.expectedVersionRef !== null) {
    const [, expectedTenant, expectedRuleSet, expectedVersion] = compileRequest.expectedVersionRef.split(":");
    assert.deepEqual({ tenantRef: expectedTenant, ruleSetId: expectedRuleSet }, compileTuple, "expected version is from the exact request tenant and rule-set tuple");
    assert.ok(expectedVersion, "expected predecessor has a version identity");
  }
  assertSchema("compileContract.requestSchema", compileRequest);
  assert.throws(() => assertRuleSetRefBindings("media.ruleset:tenant-b:color-policy", compileRequest.requestContext), /tenant equals/u);
  assert.throws(() => {
    const [, tenantRef, ruleSetId] = "media.ruleset-version:tenant-b:color-policy:v1".split(":");
    assert.deepEqual({ tenantRef, ruleSetId }, compileTuple, "expected version belongs to compile rule-set tuple");
  }, /expected version belongs/u);
  assert.throws(() => assertRuleSetRefBindings("media.ruleset:tenant-a:other-policy", { ...compileRequest.requestContext, tenantRef: "tenant-b" }), /tenant equals/u);
  assertRejected("compileContract.requestSchema", { ...compileRequest, requestContext: { ...requestContext, rightsConsentContextRef: undefined } });
  const compileSuccess = { outcome: "COMPILED", requestContext, ruleSetRef: candidate.ruleSetRef, observedAt: "2026-10-19T12:00:00Z", candidate, normalizedSemanticGraph: graph, semanticFingerprint: { algorithm: contract.semanticFingerprint.calculation.algorithm, value: digest, graphFormat: graph.graphFormat } };
  assertSchema("compileContract.resultSchema", compileSuccess);
  assert.equal(compileSuccess.ruleSetRef, candidate.ruleSetRef, "successful compile returns candidate's exact stable ruleSetRef");
  for (const outcome of ["REJECTED", "UNSUPPORTED"]) assertSchema("compileContract.resultSchema", { outcome, requestContext, ruleSetRef: candidate.ruleSetRef, observedAt: "2026-10-19T12:00:00Z", diagnostics: [] });
  for (const outcome of ["DENIED", "CONFLICT", "STALE", "UNKNOWN", "UNAVAILABLE"]) assertSchema("compileContract.resultSchema", { outcome, requestContext, ruleSetRef: candidate.ruleSetRef, observedAt: "2026-10-19T12:00:00Z", reasonRef: `reason:${outcome.toLowerCase()}` });
  for (const outcome of ["REJECTED", "UNSUPPORTED", "DENIED", "CONFLICT", "STALE", "UNKNOWN", "UNAVAILABLE"]) {
    const failure = { outcome, requestContext, ruleSetRef: candidate.ruleSetRef, observedAt: "2026-10-19T12:00:00Z", ...(outcome === "REJECTED" || outcome === "UNSUPPORTED" ? { diagnostics: [] } : { reasonRef: `reason:${outcome.toLowerCase()}` }) };
    for (const key of ["candidate", "normalizedSemanticGraph", "semanticFingerprint"]) assertRejected("compileContract.resultSchema", { ...failure, [key]: compileSuccess[key] });
  }
  assertRejected("compileContract.resultSchema", { ...compileSuccess, semanticFingerprint: undefined });
  assertRejected("compileContract.resultSchema", { ...compileSuccess, outcome: "COMPILED", candidate: undefined });

  const validationRequest = { requestContext: { ...requestContext, requestIdentity: "request-validate", idempotencyKey: "idempotency-validate" }, candidateVersionRef: ruleSetVersionRefFor(candidate.ruleSetVersion), expectedFingerprint: digest, validationContextRef: "validation-context:current" };
  validationRequest.candidateVersionRef = ruleSetVersionRefFor(candidate.ruleSetVersion);
  validationRequest.ruleSetVersion = candidate.ruleSetVersion;
  assertContextBindings(validationRequest.requestContext, validationRequest.ruleSetVersion, candidate.declaredScope);
  assert.equal(validationRequest.candidateVersionRef, ruleSetVersionRefFor(validationRequest.ruleSetVersion), "validation reference encodes exact version tuple");
  assertSchema("validationContract.requestSchema", validationRequest);
  const validationReceipt = { validationResultRef: "media.rules.validation-result:tenant-a:request-validate", outcome: "VALID", requestContext: validationRequest.requestContext, candidateVersionRef: validationRequest.candidateVersionRef, ruleSetVersion: validationRequest.ruleSetVersion, fingerprint: digest, validationContextRef: validationRequest.validationContextRef, observedAt: "2026-10-19T12:00:00Z", sourceRefs: candidate.sourceRefs, diagnostics: [] };
  assertSchema("validationContract.resultSchema", validationReceipt);
  assertRejected("validationContract.resultSchema", { ...validationReceipt, validationResultRef: undefined });
  assertRejected("validationContract.resultSchema", { ...validationReceipt, validationContextRef: undefined });
  assertRejected("validationContract.resultSchema", { ...validationReceipt, observedAt: undefined });
  assertRejected("validationContract.resultSchema", { ...validationReceipt, sourceRefs: undefined });
  assertRejected("validationContract.resultSchema", { ...validationReceipt, outcome: "INVALID" });
  assertRejected("validationContract.resultSchema", { ...validationReceipt, diagnostics: [{ code: "UNEXPECTED", path: "rules", disposition: "ERROR" }] });
  for (const outcome of ["INVALID", "UNSUPPORTED", "UNKNOWN", "UNAVAILABLE", "DENIED", "CONFLICT", "STALE"]) {
    const result = ["INVALID", "UNSUPPORTED"].includes(outcome)
      ? { ...validationReceipt, outcome, diagnostics: [{ code: "RULE_INVALID", path: "rules[0]", disposition: "ERROR" }] }
      : { ...validationReceipt, outcome, reasonRef: `reason:${outcome.toLowerCase()}` };
    assertSchema("validationContract.resultSchema", result);
    assert.ok(!["VALID"].includes(outcome), `${outcome} must remain non-success`);
  }

  const reuseRequest = { requestContext: { ...requestContext, requestIdentity: "request-reuse", idempotencyKey: "idempotency-reuse" }, candidateVersionRef: validationRequest.candidateVersionRef, ruleSetVersion: candidate.ruleSetVersion, expectedFingerprint: digest, targetOperationRef: "media.operation.render", targetOperationAuthorizationRef: "authorization:render-current", validationResultRef: validationReceipt.validationResultRef, validationContextRef: validationReceipt.validationContextRef };
  assertSchema("reuseContract.requestSchema", reuseRequest);
  assertContextBindings(reuseRequest.requestContext, reuseRequest.ruleSetVersion, candidate.declaredScope);
  const operationPlan = { planRef: "operation-plan:reuse-1", candidateVersionRef: reuseRequest.candidateVersionRef, ruleSetVersion: reuseRequest.ruleSetVersion, fingerprint: digest, targetOperationRef: reuseRequest.targetOperationRef, targetOperationAuthorizationRef: reuseRequest.targetOperationAuthorizationRef, declaredScope: candidate.declaredScope, declaredInputs: candidate.declaredInputs, constraints: candidate.constraints, validationResultRef: reuseRequest.validationResultRef, validationContextRef: reuseRequest.validationContextRef, sourceRefs: candidate.sourceRefs, requestedBy: reuseRequest.requestContext, reuseRequestRef: reuseRequest.requestContext.requestIdentity, disposition: "CANDIDATE_OPERATION_PLAN_ONLY", executionAdmission: "NOT_ADMITTED" };
  assertSchema("reuseContract.resultSchema", { outcome: "REUSE_REQUESTED", requestContext: reuseRequest.requestContext, candidateVersionRef: reuseRequest.candidateVersionRef, operationPlan });
  assertReuseMatchesReceipt(reuseRequest, validationReceipt, operationPlan, candidate.declaredScope);
  assert.throws(() => assertReuseMatchesReceipt({ ...reuseRequest, expectedFingerprint: `sha256:${"0".repeat(64)}` }, validationReceipt, operationPlan, candidate.declaredScope), /fingerprint equals/u);
  assert.throws(() => assertReuseMatchesReceipt({ ...reuseRequest, candidateVersionRef: ruleSetVersionRefFor({ ...candidate.ruleSetVersion, versionId: "v3" }) }, validationReceipt, operationPlan, candidate.declaredScope), /validated candidate version/u);
  assert.throws(() => assertReuseMatchesReceipt({ ...reuseRequest, expectedFingerprint: `sha256:${"0".repeat(64)}` }, validationReceipt, operationPlan, candidate.declaredScope), /fingerprint equals/u);
  assert.throws(() => assertReuseMatchesReceipt({ ...reuseRequest, validationContextRef: "validation-context:other" }, validationReceipt, operationPlan, candidate.declaredScope), /context equals/u);
  assert.throws(() => assertReuseMatchesReceipt({ ...reuseRequest, targetOperationRef: "media.operation.delete" }, validationReceipt, operationPlan, candidate.declaredScope), /binds the requested target operation/u);
  assertRejected("reuseContract.requestSchema", { ...reuseRequest, targetOperationAuthorizationRef: undefined });
  assertRejected("reuseContract.resultSchema", { outcome: "REUSE_REQUESTED", requestContext: reuseRequest.requestContext, candidateVersionRef: reuseRequest.candidateVersionRef });
  for (const outcome of ["DENIED", "CONFLICT", "UNKNOWN", "UNAVAILABLE", "STALE", "INVALID", "UNSUPPORTED"]) {
    const failure = { outcome, requestContext: reuseRequest.requestContext, candidateVersionRef: reuseRequest.candidateVersionRef, reasonRef: `reason:${outcome.toLowerCase()}` };
    assertSchema("reuseContract.resultSchema", failure);
    assertRejected("reuseContract.resultSchema", { ...failure, operationPlan });
  }
  assert.throws(() => assertParameterValueCompatibility({ parameters: { kind: "FIELD_COMPARISON", fieldRef: "media.input.width", comparator: "EQ", expectedValue: "wide" } }, candidate.declaredInputs), /equality value matches/u);
  assert.throws(() => assertParameterValueCompatibility({ parameters: { kind: "FIELD_COMPARISON", fieldRef: "media.input.width", comparator: "GT", expectedValue: "wide" } }, [{ ...candidate.declaredInputs[0], valueType: "STRING" }]), /ordered comparisons require numeric input/u);
  assert.throws(() => assertParameterValueCompatibility({ parameters: { kind: "SET_MEMBERSHIP", fieldRef: "media.input.width", comparator: "IN", expectedValues: ["wide"] } }, candidate.declaredInputs), /membership values match/u);
  const inspectRequest = { requestContext: { ...requestContext, requestIdentity: "request-inspect", idempotencyKey: "idempotency-inspect" }, ruleSetVersion: candidate.ruleSetVersion };
  assertContextBindings(inspectRequest.requestContext, inspectRequest.ruleSetVersion, candidate.declaredScope);
  assertSchema("inspectContract.requestSchema", inspectRequest);
  assertSchema("inspectContract.resultSchema", { outcome: "INSPECTED", requestContext: inspectRequest.requestContext, ruleSetVersion: candidate.ruleSetVersion, candidate, sourceRefs: candidate.sourceRefs });
  for (const outcome of ["DENIED", "CONFLICT", "STALE", "UNKNOWN", "UNAVAILABLE"]) {
    const failure = { outcome, requestContext: inspectRequest.requestContext, ruleSetVersion: candidate.ruleSetVersion, reasonRef: `reason:${outcome.toLowerCase()}` };
    assertSchema("inspectContract.resultSchema", failure);
    assertRejected("inspectContract.resultSchema", { ...failure, candidate });
    assertRejected("inspectContract.resultSchema", { ...failure, sourceRefs: candidate.sourceRefs });
  }
  const duplicateNodeGraph = { ...graph, nodes: [...graph.nodes, graph.nodes[0]] };
  assert.throws(() => assertGraphValid(duplicateNodeGraph, candidate), /node IDs are unique/u);
  const danglingGraph = { ...graph, edges: [...graph.edges, { edgeId: "edge-3", fromNodeId: "missing", toNodeId: "output-1", port: "result" }] };
  assert.throws(() => assertGraphValid(danglingGraph, candidate), /edge endpoints resolve/u);
  const badScopeGraph = { ...graph, scope: { ...graph.scope, purposeRef: "purpose:other" } };
  assert.throws(() => assertGraphValid(badScopeGraph, candidate), /graph scope matches/u);
  const badVersionGraph = { ...graph, ruleSetVersion: { ...graph.ruleSetVersion, versionId: "v1" } };
  assert.throws(() => assertGraphValid(badVersionGraph, candidate), /exact version tuple/u);
  const missingInputGraph = { ...graph, declaredInputs: [] };
  assert.throws(() => assertGraphValid(missingInputGraph, candidate), /exact declared inputs/u);
  const duplicateEdgeGraph = { ...graph, edges: [...graph.edges, { ...graph.edges[0] }] };
  assert.throws(() => assertGraphValid(duplicateEdgeGraph, candidate), /edge IDs are unique/u);
  assert.throws(() => assertGraphValid({ ...graph, edges: [{ ...graph.edges[0], port: "result" }, graph.edges[1]] }, candidate), /result port connects/u);
  assert.throws(() => assertGraphValid({ ...graph, edges: [graph.edges[0], { ...graph.edges[1], port: "input" }] }, candidate), /input port connects/u);
  const extraRule = { ruleId: "rule-3", operatorRef: "media.rules.operator.compare-field.v1", parameters: { kind: "FIELD_COMPARISON", fieldRef: "media.input.width", comparator: "GTE", expectedValue: 1920 }, sourceRefs: candidate.sourceRefs };
  const cycleGraph = { ...graph, nodes: [...graph.nodes, { nodeId: "rule-3", nodeKind: "RULE", ...extraRule }], edges: [...graph.edges, { edgeId: "edge-3", fromNodeId: "rule-2", toNodeId: "rule-3", port: "result" }, { edgeId: "edge-4", fromNodeId: "rule-3", toNodeId: "rule-2", port: "input" }] };
  assert.throws(() => assertGraphValid(cycleGraph, { ...candidate, rules: [...candidate.rules, extraRule] }), /graph is acyclic/u);
  for (const failure of contract.failClosedCases) assert.equal(failure.effect, "NONE", `${failure.id} has no side effects`);
  assert.ok(contract.reuseContract.recovery.some((rule) => rule.includes("before retrying")));
  assert.deepEqual(contract.effectBoundary.forbidden, ["rule-application", "target-operation-execution", "approval", "approval-equivalence", "persistent-media-mutation", "measured-result-claim"]);
});

test("PDP-1 rule proposal identity is registered without entering canonical operation or object collections", () => {
  const identities = parse(readFileSync(resolve(root, ".product-experience/artifact-identities.yaml"), "utf8"));
  assert.ok(identities.records.some((row) => row.path === sourcePath && row.artifactId === "ART-P1-RULE-MANAGEMENT-CONTRACTS" && row.authorityClass === "DOMAIN_DATA_AUTHORITY"));
  const operations = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
  const objects = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/domain-objects.yaml"), "utf8"));
  const values = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/value-objects.yaml"), "utf8"));
  assert.equal(objects.objects.length, 39);
  assert.equal(values.values.length, 13);
  assert.equal(buildPdp1SourceCensus(root).sourceRecordCount.canonicalOperationSchemaCount, 448);
  assert.equal(operations.ownerDefinedOperationContracts.records.some((row) => ["media.rules.compile-candidate.v1", "media.rules.validate-candidate.v1", "media.rules.reuse-candidate.v1"].includes(row.id)), false);
});
