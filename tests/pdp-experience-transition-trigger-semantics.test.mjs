import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { evaluateMediaCausalTriggerDefinition, evaluateMediaGuardFactReceiptSetDefinition, evaluateMediaTransitionTriggerDefinition } from "../scripts/lib/media-transition-trigger-definition.mjs";
import { typedObservationRequestFingerprint } from "../scripts/lib/pdp-truth-domain-observation-currentness.mjs";
import { canonicalizeJobParameterJson, resolveJobSubmitParameterSchema, validateJobSubmitParameterContract } from "../scripts/lib/pdp-job-submit-parameter-contract.mjs";

const require = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url));
const { parse } = require("yaml");
const Ajv = require("ajv");
const addFormats = require("ajv-formats");
const read = async (path) => parse(await readFile(path, "utf8"));
const p1 = ".product-experience/pdp-1-domain-data";
const p3 = ".product-experience/pdp-3-product-experience";
const [transitions, guards, actions, operations] = await Promise.all([
  read(`${p1}/transitions.yaml`),
  read(`${p1}/transition-guard-contracts.yaml`),
  read(`${p3}/action-registry.yaml`),
  read(`${p1}/operations.yaml`),
]);
const rightsDecisionContract = operations.ownerTypedObservationContracts.records.find(({ id }) => id === "media.observation-contract.rights-decision.v1");
const consentRevisionContract = operations.ownerConsentRevisionObservationContract;
const sourceRows = [...transitions.transitionRecords, ...transitions.ownerDefinedTransitionRecords];
const sourceById = new Map(sourceRows.map((row) => [row.id, row]));
const guardByTransition = new Map(guards.records.map((row) => [row.transitionId, row]));
const semantic = transitions.ownerDefinedTransitionTriggerSemantics;
const semanticByTransition = new Map(semantic.records.map((row) => [row.transitionRef.split("/@id=")[1], row]));
const actionCrosswalk = new Map();
for (const action of [...actions.actions, ...actions.ownerDefinedActions]) {
  for (const operation of action.actionDefinitionSemantics?.typedDefinition?.canonicalOperationBindings?.operations ?? []) {
    for (const transitionId of operation.transitionRefs ?? []) {
      const rows = actionCrosswalk.get(transitionId) ?? [];
      rows.push({ actionRef: action.id, operationRef: operation.operationRef, operationKind: operation.operationKind, actorRefs: action.actorRefs ?? [] });
      actionCrosswalk.set(transitionId, rows);
    }
  }
}
const validators = new Map();
const ajv = new Ajv({ allErrors: true, strict: false, validateFormats: true });
addFormats(ajv);

async function resolveExactSourceRef(reference, documents) {
  const marker = reference.indexOf("#");
  if (marker < 0) return undefined;
  const path = reference.slice(0, marker);
  const fragment = reference.slice(marker + 1);
  if (!documents.has(path)) documents.set(path, await read(path));
  let value = documents.get(path);
  if (!fragment) return value;
  const parts = fragment.split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    const selector = part.match(/^@(id|machineId|modelId)=/u);
    if (selector) {
      if (!Array.isArray(value)) return undefined;
      const property = selector[1];
      const initial = part.slice(part.indexOf("=") + 1);
      let found;
      let consumed = 0;
      for (let end = index; end < parts.length; end += 1) {
        const candidate = [initial, ...parts.slice(index + 1, end + 1)].join("/");
        found = value.find((row) => row?.[property] === candidate);
        if (found) { consumed = end - index; break; }
      }
      if (!found) return undefined;
      value = found;
      index += consumed;
    } else if (Array.isArray(value)) {
      const number = Number(part);
      value = Number.isInteger(number) ? value[number] : value.find((row) => row?.id === part || row?.machineId === part);
    } else {
      value = value?.[part];
    }
    if (value === undefined || value === null) return undefined;
  }
  return value;
}

function validateTriggerEvent(edge, verdicts = {}) {
  const guardFacts = edge.triggerGuardFacts;
  const event = {
    eventId: "definition-fixture:event-001",
    producerRef: edge.producerRoleRef,
    transitionRef: edge.eventPayloadSchema.properties.transitionRef.const,
    edgeRuleRef: edge.eventPayloadSchema.properties.edgeRuleRef.const,
    aggregateRef: "tenant-object:exact-subject-001",
    aggregateVersionRef: "tenant-object-version:current-001",
    fromStateRef: edge.fromStateRef,
    toStateRef: edge.toStateRef,
    decision: "APPLIED",
    occurredAt: "2026-10-09T12:00:00.000Z",
    guardFactResults: guardFacts.map((fact) => ({
      factRef: fact.sourceRef,
      verdict: verdicts[fact.sourceRef] ?? "SATISFIED",
      ...(fact.valueKind === "EXACT_TARGET_STATE_OBSERVATION"
        ? verdicts[fact.sourceRef] === "UNKNOWN"
          ? { observationDisposition: "UNKNOWN", observationReason: "definition fixture has no current state observation" }
          : { observationDisposition: "OBSERVED", observedStateRef: verdicts[fact.sourceRef] === "DENIED" ? fact.validStateRefs.find((ref) => ref !== fact.targetStateRef) : fact.targetStateRef }
        : {}),
      evidenceRefs: [`definition-fixture:evidence:${fact.sourceRef.split("/").at(-1)}`],
      subjectRef: "tenant-object:exact-subject-001",
      subjectVersionRef: "tenant-object-version:current-001",
      authorityRef: "definition-fixture:authority-current-001",
      readVersion: 1,
      observedAt: "2026-10-09T11:59:00.000Z",
    })),
  };
  const validate = validators.get(edge) ?? ajv.compile(edge.eventPayloadSchema);
  validators.set(edge, validate);
  return { event, valid: validate(event), errors: validate.errors };
}

function flattenGuardFacts(node, sourcePrefix, path, output = []) {
  if (node.factRef) {
    output.push({ fact: node.fact, sourceRef: node.factRef });
  } else {
    for (const operator of ["all", "any"]) {
      (node[operator] ?? []).forEach((child, index) => flattenGuardFacts(child, sourcePrefix, `${path}/${operator}/${index}`, output));
    }
  }
  return output;
}

function schemaFixture(schema) {
  const value = (definition) => {
    if (definition.const !== undefined) return definition.const;
    if (definition.enum) return definition.enum[0];
    if (definition.type === "string") {
      if (definition.pattern?.startsWith("^sha256:")) return `sha256:${"a".repeat(64)}`;
      if (definition.pattern === "^[0-9a-f]{64}$") return "b".repeat(64);
      if (definition.format === "date-time") return "2026-10-09T12:00:00.000Z";
      return "fixture-value";
    }
    if (definition.type === "integer" || definition.type === "number") return definition.minimum ?? 1;
    if (definition.type === "array") return Array.from({ length: definition.minItems ?? 1 }, () => value(definition.items ?? { type: "string" }));
    if (definition.type === "boolean") return true;
    if (definition.type === "object") return Object.fromEntries((definition.required ?? []).map((key) => [key, value(definition.properties[key]) ]));
    return "fixture-value";
  };
  return Object.fromEntries(schema.required.map((key) => [key, value(schema.properties[key])]));
}

function schemaValue(schema, context = schema, depth = 0) {
  assert.ok(depth < 40, "job request fixture schema expansion is bounded");
  if (schema.$ref) {
    const resolved = schema.$ref.replace(/^#\//u, "").split("/").reduce((value, key) => value?.[key.replaceAll("~1", "/").replaceAll("~0", "~")], context);
    assert.ok(resolved, `job request fixture resolves ${schema.$ref}`);
    return schemaValue(resolved, context, depth + 1);
  }
  if (schema.const !== undefined) return schema.const;
  if (schema.enum?.length) return schema.enum[0];
  if (schema.oneOf) return schemaValue(schema.oneOf[0], context, depth + 1);
  if (schema.anyOf) return schemaValue(schema.anyOf[0], context, depth + 1);
  if (schema.allOf) return Object.assign({}, ...schema.allOf.map((item) => schemaValue(item, context, depth + 1)));
  if (schema.type === "object" || schema.properties) return Object.fromEntries((schema.required ?? []).map((key) => [key, schemaValue(schema.properties?.[key] ?? {}, context, depth + 1)]));
  if (schema.type === "array") return Array.from({ length: schema.minItems ?? 0 }, () => schemaValue(schema.items ?? {}, context, depth + 1));
  if (schema.type === "integer" || schema.type === "number") return schema.minimum ?? 1;
  if (schema.type === "boolean") return true;
  if (schema.type === "string") {
    if (schema.format === "date-time") return "2026-10-09T12:00:00.000Z";
    if (schema.format === "versioned-profile-reference") return "profile:1";
    if (schema.pattern?.includes("sha256:")) return `sha256:${"a".repeat(64)}`;
    for (const candidate of ["fixture-1", "request-1", "v-1", "ref:one", "profile:1", "en-US", "x"]) {
      if (!schema.pattern || new RegExp(schema.pattern).test(candidate)) return candidate;
    }
    return "x".repeat(schema.minLength ?? 1);
  }
  return {};
}

function acceptedJobSubmitRequest() {
  const contract = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.job.submit.v1");
  const request = schemaValue(contract.ownerWireSchema.requestSchema);
  const capabilityRef = "media.generate.image.text-to-image";
  const targetOperationRef = "media.operation.capability.media-generate-image-text-to-image";
  request.operationRef = "media.operation.job.submit.v1";
  request.operationVersion = 1;
  request.capabilityRef = capabilityRef;
  request.targetOperationRef = targetOperationRef;
  request.targetOperationVersion = 1;
  request.requestId = "request:tenant-a:job-1";
  const selected = resolveJobSubmitParameterSchema(operations, capabilityRef, targetOperationRef, 1);
  assert.equal(selected.valid, true, "fixture uses an exact async-submittable COMMAND/schema binding");
  const slots = Object.entries(selected.requestSchema.properties ?? {}).filter(([name]) => /^input[1-9]\d*$/u.test(name))
    .sort(([left], [right]) => Number(left.slice(5)) - Number(right.slice(5)));
  request.typedInputs = slots.map(([, schema]) => schemaValue(schema, selected.requestSchema));
  request.parameters = { outputWidth: 1024, outputHeight: 1024, outputProfileRef: "profile:1" };
  request.directRequestFields = {};
  const validation = validateJobSubmitParameterContract(operations, request);
  assert.equal(validation.valid, true, JSON.stringify(validation));
  return { request, validation };
}

function acceptedSnapshotFixture(trusted, sourceRef) {
  const { request, validation } = acceptedJobSubmitRequest();
  const canonicalJson = canonicalizeJobParameterJson;
  const digest = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;
  const typedInputs = Object.fromEntries(request.typedInputs.map((input, index) => [`input${index + 1}`, input]));
  const typedInputDigest = digest(canonicalJson(typedInputs));
  const parameterDigest = digest(canonicalJson(request.parameters));
  const acceptedRequestSnapshotRef = "media.accepted-request-snapshot/job-1/request-1/v1";
  const requestFingerprint = digest(canonicalJson({ tenantId: trusted.tenantId, principalId: trusted.principalId,
    jobId: trusted.expectedAggregateRef, requestId: request.requestId, purposeRef: request.purposeRef,
    capabilityRef: request.capabilityRef, targetOperationRef: request.targetOperationRef,
    targetOperationVersion: request.targetOperationVersion, targetSchemaDigest: validation.targetSchemaDigest,
    profileRef: request.profile.profileRef, profileVersion: request.profile.profileVersion,
    profileVersionRef: request.profile.profileVersionRef, typedInputDigest, parameterDigest }));
  const expected = { jobId: trusted.expectedAggregateRef, requestId: request.requestId, jobSubmitRequest: request,
    acceptedRequestSnapshotRef, requestFingerprint, targetOperationRef: request.targetOperationRef,
    targetOperationVersion: request.targetOperationVersion, targetSchemaDigest: validation.targetSchemaDigest,
    capabilityRef: request.capabilityRef, profileRef: request.profile.profileRef, profileVersion: request.profile.profileVersion,
    profileVersionRef: request.profile.profileVersionRef, purposeRef: request.purposeRef, typedInputDigest, parameterDigest,
    readAuthorityRef: ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope",
    readVersion: "request-snapshot-read-v1", sourceInputs: [], sourceVersionRefs: [], dependencyVersionRefs: [] };
  trusted.expectedRequestSnapshotByFact ??= {};
  trusted.expectedRequestSnapshotByFact[sourceRef] = expected;
  return { queryRequest: { jobId: expected.jobId, requestId: request.requestId }, queryResult: {
    outcome: "OBSERVED", operationRef: "media.operation.request-snapshot.inspect.v1", jobId: expected.jobId, requestId: request.requestId,
    acceptedRequestSnapshotRef, requestFingerprint, targetOperationRef: request.targetOperationRef,
    targetOperationVersion: request.targetOperationVersion, targetSchemaDigest: validation.targetSchemaDigest,
    capabilityRef: request.capabilityRef, profileRef: request.profile.profileRef, profileVersion: request.profile.profileVersion,
    profileVersionRef: request.profile.profileVersionRef, purposeRef: request.purposeRef, typedInputDigest, parameterDigest,
    sourceInputs: [], sourceVersionRefs: [], dependencyVersionRefs: [], tenantId: trusted.tenantId, principalId: trusted.principalId,
    readAuthorityRef: expected.readAuthorityRef, readVersion: expected.readVersion, currentness: "CURRENT", observedAt: trusted.now,
  } };
}

function trustedFor(edge) {
  return {
    tenantId: "fixture-tenant-001",
    principalId: "fixture-principal-001",
    expectedAggregateRef: "tenant-object:exact-subject-001",
    expectedAggregateVersionRef: "tenant-object-version:current-001",
    expectedProducerRef: edge.producerRoleRef,
    expectedFromStateRef: edge.fromStateRef,
    now: "2026-10-09T12:00:00.000Z",
    expectedAuthorityByFact: Object.fromEntries(edge.triggerGuardFacts.map(({ sourceRef }) => [sourceRef, "definition-fixture:authority-current-001"])),
    expectedReadVersionByFact: Object.fromEntries(edge.triggerGuardFacts.map(({ sourceRef }) => [sourceRef, 1])),
    maxAgeMsByFact: Object.fromEntries(edge.triggerGuardFacts.map(({ sourceRef }) => [sourceRef, 120_000])),
    maxEventAgeMs: 120_000,
  };
}

function expectedGuardDecision(definition, factContractsByRef, receipts, trusted = {}) {
  const verdicts = new Map();
  for (const expected of definition.triggerGuardFacts) {
    const contract = factContractsByRef.get(expected.factContractRef);
    const receipt = receipts.find((row) => row.factRef === expected.sourceRef);
    if (contract.valueKind === "UNRESOLVED_OWNER_PREDICATE") verdicts.set(expected.sourceRef, "UNKNOWN");
    else if (contract.valueKind === "EXACT_STATE_OBSERVATION") verdicts.set(expected.sourceRef, receipt.value.observedStateRef === definition.targetStateRef ? "SATISFIED" : "DENIED");
    else if (contract.valueKind === "TENANT_IDENTITY_TUPLE") verdicts.set(expected.sourceRef, receipt.value.tenantId === receipt.value.subjectTenantId ? "SATISFIED" : "DENIED");
    else if (contract.valueKind === "EXACT_PROJECT_HEAD_REVISION_EQUALITY") verdicts.set(expected.sourceRef, receipt.value.observationDisposition === "UNKNOWN" ? "UNKNOWN" : receipt.value.expectedHeadRevisionId === receipt.value.observedCurrentHeadRevisionId ? "SATISFIED" : "DENIED");
    else if (contract.valueKind === "EXHAUSTIVE_ACTIVE_HOLD_SET") verdicts.set(expected.sourceRef, receipt.value.enumerationDisposition !== "EXHAUSTIVE" ? "UNKNOWN" : receipt.value.activeHoldRefs.length === 0 ? "SATISFIED" : "DENIED");
    else if (contract.valueKind === "EXHAUSTIVE_COPY_INVENTORY") verdicts.set(expected.sourceRef, receipt.value.inventoryDisposition !== "COMPLETE" || receipt.value.unresolvedCopyRefs.length || receipt.value.classCoverage.some((row) => row.enumerationDisposition !== "EXHAUSTIVE") ? "UNKNOWN" : "SATISFIED");
    else if (contract.valueKind === "EXACT_ACCEPTED_REQUEST_SNAPSHOT") {
      const expectedQuery = trusted.expectedRequestSnapshotByFact?.[expected.sourceRef];
      const actual = receipt.value.queryResult;
      verdicts.set(expected.sourceRef, actual?.outcome === "OBSERVED" && expectedQuery &&
        actual.requestFingerprint === expectedQuery.requestFingerprint && actual.targetSchemaDigest === expectedQuery.targetSchemaDigest &&
        actual.targetOperationRef === expectedQuery.targetOperationRef && actual.targetOperationVersion === expectedQuery.targetOperationVersion
        ? "SATISFIED" : "UNKNOWN");
    }
    else if (contract.valueKind === "EXACT_SCOPED_AUTHORITY_DECISION") {
      const value = receipt.value;
      const expectedDecision = trusted.expectedAuthorityDecisionByFact?.[expected.sourceRef];
      const now = Date.parse(trusted.now);
      const from = Date.parse(value.validFrom);
      const until = Date.parse(value.validUntil);
      const observed = Date.parse(value.observedAt);
      const exact = expectedDecision && Object.entries(expectedDecision).every(([key, expectedValue]) => value[key] === expectedValue) &&
        value.tenantId === trusted.tenantId && value.principalId === trusted.principalId &&
        value.subjectRef === trusted.expectedAggregateRef && value.subjectVersionRef === trusted.expectedAggregateVersionRef &&
        value.transitionRef === definition.transitionRef && value.edgeRuleRef === definition.edgeRuleRef &&
        value.effectRef === definition.edgeRuleRef && Number.isFinite(now) && Number.isFinite(from) && Number.isFinite(until) &&
        Number.isFinite(observed) && from < until && observed <= now && now < until && now >= from &&
        now - observed <= trusted.maxAgeMsByFact?.[expected.sourceRef];
      verdicts.set(expected.sourceRef, !exact || value.decisionDisposition === "UNKNOWN" ? "UNKNOWN" : value.decisionDisposition === "GRANTED" ? "SATISFIED" : "DENIED");
    }
    else if (contract.valueKind === "EXACT_SCOPED_POLICY_REVISION_OBSERVATION") {
      const value = receipt.value;
      const now = Date.parse(trusted.now);
      const observed = Date.parse(value.observedAt);
      const expectedPolicyRef = trusted.expectedPolicyRefByFact?.[expected.sourceRef];
      const expectedPolicyRevisionRef = trusted.expectedPolicyRevisionRefByFact?.[expected.sourceRef];
      const exact = value.tenantId === trusted.tenantId && value.principalId === trusted.principalId &&
        value.subjectRef === trusted.expectedAggregateRef && value.subjectVersionRef === trusted.expectedAggregateVersionRef &&
        value.transitionRef === definition.transitionRef && value.edgeRuleRef === definition.edgeRuleRef && value.effectRef === definition.edgeRuleRef &&
        value.authorityRef === trusted.expectedAuthorityByFact?.[expected.sourceRef] && value.policyRef === expectedPolicyRef &&
        value.expectedPolicyRevisionRef === expectedPolicyRevisionRef && Number.isFinite(now) && Number.isFinite(observed) && observed <= now &&
        now - observed <= trusted.maxAgeMsByFact?.[expected.sourceRef];
      verdicts.set(expected.sourceRef, !exact || value.observationDisposition === "UNKNOWN" ? "UNKNOWN" :
        value.observationDisposition === "CURRENT" && value.observedPolicyRevisionRef === expectedPolicyRevisionRef ? "SATISFIED" :
          value.observationDisposition === "NOT_CURRENT" && value.observedPolicyRevisionRef !== expectedPolicyRevisionRef ? "DENIED" : "UNKNOWN");
    }
    else if (contract.valueKind === "CURRENT_PER_EFFECT_CONSENT_SET") {
      const reads = receipt.value.effectReads ?? [];
      if (reads.some(({ rightsResult, consentResult }) => rightsResult?.observationStatus === "UNKNOWN" || rightsResult?.observationStatus === "NOT_FOUND" || consentResult?.outcome?.kind === "UNKNOWN")) {
        verdicts.set(expected.sourceRef, "UNKNOWN");
      } else if (reads.some(({ rightsResult, consentResult }) => rightsResult?.observationStatus !== "ALLOWED_FOR_DECLARED_SCOPE" || consentResult?.outcome?.status !== "ACTIVE")) {
        verdicts.set(expected.sourceRef, "DENIED");
      } else verdicts.set(expected.sourceRef, "SATISFIED");
    }
    else verdicts.set(expected.sourceRef, receipt.value[contract.valueProperty] === contract.valueSemantics ? "SATISFIED" : receipt.value[contract.valueProperty] === "UNKNOWN" ? "UNKNOWN" : "DENIED");
  }
  const evaluate = (node) => {
    if (node?.factRef) return verdicts.get(node.factRef) === "SATISFIED" ? true : verdicts.get(node.factRef) === "DENIED" ? false : null;
    const op = Array.isArray(node?.all) ? "all" : Array.isArray(node?.any) ? "any" : null;
    if (!op || node[op].length === 0) return null;
    const values = node[op].map(evaluate);
    return op === "all" ? values.includes(false) ? false : values.includes(null) ? null : true : values.includes(true) ? true : values.includes(null) ? null : false;
  };
  const result = evaluate(definition.guardExpression);
  return result === true ? "APPLIED" : result === false ? "DENIED" : "UNKNOWN";
}

test("all transition trigger definitions resolve exact guard facts, state endpoints, producer, and action crosswalk", () => {
  assert.equal(semantic.id, "media.pdp1.owner-transition-trigger-semantics");
  assert.equal(semantic.recordCount, 55);
  assert.equal(semantic.records.length, 55);
  assert.equal(semantic.edgeCount, 165);
  assert.equal(semantic.records.reduce((count, row) => count + row.triggerCases.length, 0), 165);
  assert.equal(semantic.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(semantic.acceptanceEffect, "none");
  assert.ok(semantic.producerRoles.some(({ id }) => id === "media.event.producer.media-domain-state-owner.v1"));
  assert.equal(semantic.producerRoles.filter(({ id }) => id.startsWith("media.logical-producer.")).length, 11);

  for (const source of sourceRows) {
    const row = semanticByTransition.get(source.id);
    const guard = guardByTransition.get(source.id);
    assert.ok(row, `missing current trigger definition ${source.id}`);
    assert.ok(guard, `missing guard definition ${source.id}`);
    assert.equal(row.historicalEventTriggers, source.eventTriggers ?? null, `${source.id} preserves historical trigger text`);
    assert.equal(row.historicalOperationBinding, source.operationBinding ?? null, `${source.id} preserves historical operation binding`);
    assert.deepEqual(row.sourceOperationRefs, source.operationRefs ?? []);
    assert.deepEqual(row.exactSourceActionRefs, actionCrosswalk.get(source.id) ?? []);
    assert.equal(row.triggerCases.length, guard.edgeRules.length);
    for (const [index, edge] of row.triggerCases.entries()) {
      const legacyStateOnly = edge.triggerGuardFacts.every((fact) => fact.valueKind === "EXACT_TARGET_STATE_OBSERVATION");
      const sourceEdge = guard.edgeRules[index];
      const expectedFacts = [];
      function collect(node, path) {
        if (typeof node === "string" || node?.fact) {
          expectedFacts.push({ fact: typeof node === "string" ? node : node.fact, sourceRef: `${row.guardContractRef}/edgeRules/${index}/when/all/${path}` });
        } else if (node?.all || node?.any) {
          for (const operator of ["all", "any"]) (node[operator] ?? []).forEach((child, childIndex) => collect(child, `${path}/${operator}/${childIndex}`));
        }
      }
      (sourceEdge.when?.all ?? []).forEach((entry, factIndex) => collect(entry, String(factIndex)));
      assert.deepEqual(edge.triggerGuardFacts.map(({ fact, sourceRef }) => ({ fact, sourceRef })), expectedFacts);
      assert.equal(edge.fromStateRef.endsWith(`/@id=${sourceEdge.from}`), true);
      assert.equal(edge.toStateRef.endsWith(`/@id=${sourceEdge.to}`), true);
      for (const fact of edge.triggerGuardFacts.filter((item) => item.valueKind === "EXACT_TARGET_STATE_OBSERVATION")) {
        assert.equal(fact.targetStateRef, edge.toStateRef, "outcome support is bound to the exact edge target state, not a free boolean");
        assert.ok(fact.validStateRefs.includes(fact.targetStateRef));
      }
      assert.equal(edge.producerRoleRef, "media.event.producer.media-domain-state-owner.v1");
      assert.equal(edge.eventPayloadSchema.properties.transitionRef.const, row.transitionRef);
      assert.equal(edge.eventPayloadSchema.properties.edgeRuleRef.const, edge.edgeRuleRef);
      assert.equal(edge.eventPayloadSchema.properties.fromStateRef.const, edge.fromStateRef);
      assert.equal(edge.eventPayloadSchema.properties.toStateRef.const, edge.toStateRef);
      assert.equal(edge.effectBoundary.includes("does not prove a deployed producer"), true);
      assert.match(edge.missingOrContradictoryEvidence, /^UNKNOWN;/u);
      const positive = validateTriggerEvent(edge);
      assert.equal(positive.valid, true, `${source.id} edge ${index} accepts a fully scoped definition fixture`);
      assert.equal(evaluateMediaTransitionTriggerDefinition({ edge, event: positive.event, trusted: trustedFor(edge), validateEventSchema: validators.get(edge) }).decision,
        legacyStateOnly ? "APPLIED_DEFINITION_ONLY" : "UNKNOWN");
      for (const outcomeFact of edge.triggerGuardFacts.filter((item) => item.valueKind === "EXACT_TARGET_STATE_OBSERVATION")) {
        const forged = structuredClone(positive.event);
        const result = forged.guardFactResults.find((item) => item.factRef === outcomeFact.sourceRef);
        result.observedStateRef = outcomeFact.validStateRefs.find((ref) => ref !== outcomeFact.targetStateRef);
        assert.equal(evaluateMediaTransitionTriggerDefinition({ edge, event: forged, trusted: trustedFor(edge), validateEventSchema: validators.get(edge) }).decision, "UNKNOWN", `${source.id} edge ${index} cannot forge a target-state predicate with a satisfied verdict`);
      }

      if (edge.triggerGuardFacts.length) {
        const unknownFacts = Object.fromEntries(edge.triggerGuardFacts.map(({ sourceRef }) => [sourceRef, "UNKNOWN"]));
        const unknown = validateTriggerEvent(edge, unknownFacts);
        assert.equal(unknown.valid, true, `${source.id} edge ${index} schema carries raw verdicts; the evaluator derives the branch`);
        assert.equal(evaluateMediaTransitionTriggerDefinition({ edge, event: unknown.event, trusted: trustedFor(edge), validateEventSchema: validators.get(edge) }).decision, "UNKNOWN", `${source.id} edge ${index} cannot claim APPLIED with unresolved evidence`);
        unknown.event.decision = "UNKNOWN";
        assert.equal(evaluateMediaTransitionTriggerDefinition({ edge, event: unknown.event, trusted: trustedFor(edge), validateEventSchema: validators.get(edge) }).decision, "UNKNOWN", `${source.id} edge ${index} preserves unknown without claiming transition`);
        const deniedFacts = Object.fromEntries(edge.triggerGuardFacts.map(({ sourceRef }) => [sourceRef, "DENIED"]));
        const denied = validateTriggerEvent(edge, deniedFacts);
        denied.event.decision = "DENIED";
        assert.equal(validators.get(edge)(denied.event), true);
        assert.equal(evaluateMediaTransitionTriggerDefinition({ edge, event: denied.event, trusted: trustedFor(edge), validateEventSchema: validators.get(edge) }).decision,
          legacyStateOnly ? "DENIED" : "UNKNOWN", `${source.id} edge ${index} only evaluates supported typed state facts`);
        const foreign = structuredClone(positive.event);
        foreign.guardFactResults[0].subjectVersionRef = "tenant-object-version:foreign-tenant-999";
        assert.equal(evaluateMediaTransitionTriggerDefinition({ edge, event: foreign, trusted: trustedFor(edge), validateEventSchema: validators.get(edge) }).decision, "UNKNOWN", `${source.id} edge ${index} rejects a validly shaped foreign subject version`);
        const stale = structuredClone(positive.event);
        stale.guardFactResults[0].observedAt = "2026-10-09T11:50:00.000Z";
        assert.equal(evaluateMediaTransitionTriggerDefinition({ edge, event: stale, trusted: trustedFor(edge), validateEventSchema: validators.get(edge) }).decision, "UNKNOWN", `${source.id} edge ${index} rejects stale evidence`);
        const futureEvent = structuredClone(positive.event);
        futureEvent.occurredAt = "2026-10-09T12:00:01.000Z";
        assert.equal(evaluateMediaTransitionTriggerDefinition({ edge, event: futureEvent, trusted: trustedFor(edge), validateEventSchema: validators.get(edge) }).decision, "UNKNOWN", `${source.id} edge ${index} rejects future event time`);
        const malformedClock = trustedFor(edge);
        malformedClock.now = "2026-99-99T00:00:00.000Z";
        assert.equal(evaluateMediaTransitionTriggerDefinition({ edge, event: positive.event, trusted: malformedClock, validateEventSchema: validators.get(edge) }).decision, "UNKNOWN", `${source.id} edge ${index} fails closed for impossible trusted clock`);
      }
    }
  }
});

test("transition trigger event schemas reject foreign edge/source facts and incomplete evidence", () => {
  const edge = semantic.records.find((row) => row.transitionRef.endsWith("/@id=media-upload-and-artifact/T01")).triggerCases[0];
  const valid = validateTriggerEvent(edge);
  assert.equal(valid.valid, true);
  const validate = validators.get(edge);
  const foreign = structuredClone(valid.event);
  foreign.edgeRuleRef = ".product-experience/pdp-1-domain-data/transition-guard-contracts.yaml#records/@id=foreign";
  assert.equal(validate(foreign), false);
  const missing = structuredClone(valid.event);
  missing.guardFactResults.pop();
  assert.equal(validate(missing), false);
  const wrongProducer = structuredClone(valid.event);
  wrongProducer.producerRef = "media.event.producer.foreign.v1";
  assert.equal(validate(wrongProducer), false);
  const staleScope = structuredClone(valid.event);
  staleScope.guardFactResults[0].subjectVersionRef = "tenant-object-version:foreign-tenant-001";
  assert.equal(validate(staleScope), true, "schema validates shape; source evaluator compares the event with trusted expected context");
  assert.equal(evaluateMediaTransitionTriggerDefinition({ edge, event: staleScope, trusted: trustedFor(edge), validateEventSchema: validate }).decision, "UNKNOWN");
  assert.equal(edge.trustedContextBindings.expectedAggregateVersion, "HOST_OR_OWNER_READ_CURRENT_VERSION; MUST_MATCH_EVENT");
});

test("nested any-guard clauses preserve OR semantics instead of flattening alternatives", () => {
  const transition = semantic.records.find((row) => row.transitionRef.endsWith("/@id=media-rights-and-consent/rightsAssertion/T03"));
  const edge = transition.triggerCases[0];
  const alternatives = edge.triggerGuardFacts.filter(({ sourceRef }) => sourceRef.includes("/any/"));
  assert.equal(alternatives.length, 3);
  const verdicts = Object.fromEntries(edge.triggerGuardFacts.map(({ sourceRef }) => [sourceRef, "SATISFIED"]));
  verdicts[alternatives[0].sourceRef] = "DENIED";
  const accepted = validateTriggerEvent(edge, verdicts);
  assert.equal(accepted.valid, true);
  assert.equal(evaluateMediaTransitionTriggerDefinition({ edge, event: accepted.event, trusted: trustedFor(edge), validateEventSchema: validators.get(edge) }).decision, "UNKNOWN", "legacy caller verdicts cannot satisfy non-state alternatives");
  verdicts[alternatives[1].sourceRef] = "UNKNOWN";
  const unresolved = validateTriggerEvent(edge, verdicts);
  unresolved.event.decision = "APPLIED";
  assert.equal(evaluateMediaTransitionTriggerDefinition({ edge, event: unresolved.event, trusted: trustedFor(edge), validateEventSchema: validators.get(edge) }).decision, "UNKNOWN", "bare satisfied verdicts remain untrusted even within an OR clause");
});

test("legacy event evaluator rejects bare SATISFIED verdicts for non-state guard facts", () => {
  const edge = semantic.records.flatMap((row) => row.triggerCases).find((candidate) => candidate.triggerGuardFacts.some((fact) => fact.valueKind !== "EXACT_TARGET_STATE_OBSERVATION"));
  assert.ok(edge);
  const fixture = validateTriggerEvent(edge);
  assert.equal(fixture.valid, true);
  fixture.event.guardFactResults = fixture.event.guardFactResults.map((fact) => ({ ...fact, verdict: "SATISFIED" }));
  fixture.event.decision = "APPLIED";
  assert.equal(evaluateMediaTransitionTriggerDefinition({ edge, event: fixture.event, trusted: trustedFor(edge), validateEventSchema: validators.get(edge) }).decision, "UNKNOWN");
});

test("causal job-start and upload-finalization definitions require exact source evidence and trusted tuple joins", () => {
  const definitions = semantic.records.flatMap((row) => row.triggerCases.map((edge) => edge.causalTriggerDefinition).filter(Boolean));
  assert.equal(definitions.length, 165);
  assert.equal(definitions.filter((definition) => definition.triggerKind.startsWith("TYPED_FENCED_JOB_ATTEMPT_")).length, 44);
  assert.equal(definitions.filter((definition) => definition.domainObjectRefs?.includes("media.domain.upload-session")).length, 23);
  const compile = (definition) => ajv.compile(definition.inputSchema);
  const job = definitions.find((definition) => definition.triggerKind === "CURRENT_FENCED_ATTEMPT_START");
  const jobValidate = compile(job);
  const jobInput = {
    tenantId: "tenant-a",
    jobId: "job-1", jobRevisionRef: "job-revision-1", attemptId: "attempt-1", attemptRecordRef: "attempt-record-1",
    attemptStateRef: ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/@machineId=media-attempt/stateDefinitions/@id=RUNNING",
    workerId: "worker-1", leaseRef: "lease-1", leaseRevisionRef: "lease-revision-1", fencingToken: 7,
    leaseExpiresAt: "2026-10-09T12:01:00.000Z", requestFingerprint: `sha256:${"a".repeat(64)}`, observedAt: "2026-10-09T12:00:00.000Z",
  };
  jobInput.ownerReceipt = {
    sourceRef: job.receiptSemantics, tenantId: jobInput.tenantId, subjectRef: jobInput.jobId, subjectVersionRef: jobInput.jobRevisionRef,
    sourceStateRef: job.sourceStateRef, targetStateRef: jobInput.attemptStateRef,
    requestFingerprint: jobInput.requestFingerprint, attemptRef: jobInput.attemptId, attemptRecordRef: jobInput.attemptRecordRef,
    workerId: jobInput.workerId, leaseRef: jobInput.leaseRef, leaseRevisionRef: jobInput.leaseRevisionRef, fencingToken: jobInput.fencingToken,
    authorityRef: "fixture:attempt-owner-authority", readVersion: 1, currentness: "CURRENT",
    observedAt: jobInput.observedAt, evidenceRefs: ["fixture:attempt-running-evidence"], disposition: "VERIFIED",
  };
  const jobTrusted = {
    now: "2026-10-09T12:00:00.000Z", maxAgeMs: 120_000, expectedJobId: "job-1", expectedJobRevisionRef: "job-revision-1",
    expectedAttemptId: "attempt-1", expectedWorkerId: "worker-1", expectedLeaseRef: "lease-1", expectedLeaseRevisionRef: "lease-revision-1",
    expectedFencingToken: 7, expectedRequestFingerprint: jobInput.requestFingerprint,
    expectedJobStateRef: job.sourceStateRef, expectedReceiptSourceRef: job.receiptSemantics,
    tenantId: jobInput.tenantId, expectedReadAuthorityRef: "fixture:attempt-owner-authority", expectedReadVersion: 1,
  };
  assert.equal(jobValidate(jobInput), true, "job start receipt is closed and bound to exact job/attempt/fence fields");
  assert.equal(evaluateMediaCausalTriggerDefinition({ definition: job, input: jobInput, trusted: jobTrusted, validateInputSchema: jobValidate }).decision, "ELIGIBLE_DEFINITION_ONLY");
  const foreignTenantJob = structuredClone(jobInput);
  foreignTenantJob.tenantId = "tenant-b";
  foreignTenantJob.ownerReceipt.tenantId = "tenant-b";
  assert.equal(jobValidate(foreignTenantJob), true, "same raw job/attempt identifiers can occur in another tenant");
  assert.equal(evaluateMediaCausalTriggerDefinition({ definition: job, input: foreignTenantJob, trusted: jobTrusted, validateInputSchema: jobValidate }).decision, "UNKNOWN", "foreign tenant cannot alias the trusted job tuple");
  assert.equal(evaluateMediaCausalTriggerDefinition({ definition: job, input: { ...jobInput, fencingToken: 8 }, trusted: jobTrusted, validateInputSchema: jobValidate }).decision, "UNKNOWN", "a well-shaped but foreign fence cannot trigger job RUNNING");
  assert.equal(evaluateMediaCausalTriggerDefinition({ definition: job, input: { ...jobInput, leaseExpiresAt: "2026-10-09T11:59:59.000Z" }, trusted: jobTrusted, validateInputSchema: jobValidate }).decision, "UNKNOWN", "expired lease cannot trigger job RUNNING");

  const upload = definitions.find((definition) => definition.triggerKind === "ACCEPTED_UPLOAD_FINALIZATION_RECEIPT");
  const uploadValidate = compile(upload);
  const digest = "b".repeat(64);
  const uploadInput = {
    tenantId: "tenant-a",
    uploadSessionId: "upload-1", expectedSessionRevisionRef: "upload-revision-4", requestFingerprint: `sha256:${"c".repeat(64)}`,
    acceptedReceiptRef: "complete-upload-receipt-1", verifiedByteLength: 512, requiredByteLength: 512,
    computedSha256: digest, declaredSha256: digest, observedAt: "2026-10-09T12:00:00.000Z",
  };
  uploadInput.ownerReceipt = {
    sourceRef: upload.receiptSemantics, tenantId: uploadInput.tenantId, subjectRef: uploadInput.uploadSessionId, subjectVersionRef: uploadInput.expectedSessionRevisionRef,
    sourceStateRef: upload.sourceStateRef, targetStateRef: upload.targetStateRef, requestFingerprint: uploadInput.requestFingerprint,
    acceptedReceiptRef: uploadInput.acceptedReceiptRef, verifiedByteLength: uploadInput.verifiedByteLength, requiredByteLength: uploadInput.requiredByteLength,
    computedSha256: uploadInput.computedSha256, declaredSha256: uploadInput.declaredSha256,
    authorityRef: "fixture:upload-owner-authority", readVersion: 1, currentness: "CURRENT",
    observedAt: uploadInput.observedAt, evidenceRefs: ["fixture:verified-bytes"], disposition: "VERIFIED",
  };
  const uploadTrusted = { tenantId: uploadInput.tenantId, now: "2026-10-09T12:00:00.000Z", maxAgeMs: 120_000, expectedUploadSessionId: "upload-1", expectedSessionRevisionRef: "upload-revision-4", expectedRequestFingerprint: uploadInput.requestFingerprint, expectedSourceStateRef: upload.sourceStateRef, expectedTargetStateRef: upload.targetStateRef, expectedReceiptSourceRef: upload.receiptSemantics, expectedReadAuthorityRef: "fixture:upload-owner-authority", expectedReadVersion: 1 };
  assert.equal(uploadValidate(uploadInput), true, "upload finalization receipt is closed and exact to its session/digest/byte tuple");
  assert.equal(evaluateMediaCausalTriggerDefinition({ definition: upload, input: uploadInput, trusted: uploadTrusted, validateInputSchema: uploadValidate }).decision, "ELIGIBLE_DEFINITION_ONLY");
  const foreignTenantUpload = structuredClone(uploadInput);
  foreignTenantUpload.tenantId = "tenant-b";
  foreignTenantUpload.ownerReceipt.tenantId = "tenant-b";
  assert.equal(uploadValidate(foreignTenantUpload), true, "same raw upload/session version IDs may exist under another tenant");
  assert.equal(evaluateMediaCausalTriggerDefinition({ definition: upload, input: foreignTenantUpload, trusted: uploadTrusted, validateInputSchema: uploadValidate }).decision, "UNKNOWN", "foreign tenant cannot alias the trusted upload tuple");
  assert.equal(evaluateMediaCausalTriggerDefinition({ definition: upload, input: { ...uploadInput, computedSha256: "d".repeat(64) }, trusted: uploadTrusted, validateInputSchema: uploadValidate }).decision, "UNKNOWN", "mismatched digest cannot trigger VERIFYING");
  assert.equal(evaluateMediaCausalTriggerDefinition({ definition: upload, input: { ...uploadInput, verifiedByteLength: 511 }, trusted: uploadTrusted, validateInputSchema: uploadValidate }).decision, "UNKNOWN", "short upload cannot trigger VERIFYING");
  assert.equal(evaluateMediaCausalTriggerDefinition({ definition: upload, input: { ...uploadInput, uploadSessionId: "foreign-upload" }, trusted: uploadTrusted, validateInputSchema: uploadValidate }).decision, "UNKNOWN", "foreign session cannot trigger VERIFYING");
});

test("every job/attempt edge has a closed source-specific causal receipt and branch-correct lease applicability", () => {
  const definitions = semantic.records.flatMap((row) => row.triggerCases.map((edge) => edge.causalTriggerDefinition).filter((definition) => definition?.triggerKind.startsWith("TYPED_FENCED_JOB_ATTEMPT_")));
  assert.equal(definitions.length, 44);
  for (const definition of definitions) {
    const validate = ajv.compile(definition.inputSchema);
    const input = schemaFixture(definition.inputSchema);
    input.tenantId = "tenant-fixture-001";
    if (Object.hasOwn(input, "leaseExpiresAt")) input.leaseExpiresAt = "2026-10-09T12:01:00.000Z";
    input.occurredAt = "2026-10-09T12:00:00.000Z";
    const receipt = schemaFixture(definition.receiptSchema);
    Object.assign(receipt, {
      sourceRef: definition.receiptSemantics,
      tenantId: input.tenantId,
      subjectRef: input.jobId,
      subjectVersionRef: input.jobRevisionRef,
      sourceStateRef: input.sourceStateRef,
      targetStateRef: input.targetStateRef,
      requestFingerprint: input.requestFingerprint,
      authorityRef: "fixture:retry-and-attempt-owner-authority",
      readVersion: 1,
      currentness: "CURRENT",
      observedAt: "2026-10-09T12:00:00.000Z",
      evidenceRefs: ["fixture:owner-evidence-1"],
      disposition: "VERIFIED",
    });
    for (const key of Object.keys(definition.receiptSchema.properties)) {
      const sourceKey = ({ attemptRef: "attemptId" })[key] ?? key;
      if (Object.hasOwn(input, sourceKey)) receipt[key] = input[sourceKey];
    }
    input.ownerReceipt = receipt;
    const trusted = {
      tenantId: input.tenantId,
      now: "2026-10-09T12:00:00.000Z", maxAgeMs: 120_000,
      expectedJobId: input.jobId, expectedJobRevisionRef: input.jobRevisionRef,
      ...(input.attemptId === undefined ? {} : { expectedAttemptId: input.attemptId }),
      ...(input.workerId === undefined ? {} : { expectedWorkerId: input.workerId }),
      ...(input.leaseRef === undefined ? {} : { expectedLeaseRef: input.leaseRef, expectedLeaseRevisionRef: input.leaseRevisionRef, expectedFencingToken: input.fencingToken }),
      expectedRequestFingerprint: input.requestFingerprint,
      expectedSourceStateRef: input.sourceStateRef, expectedTargetStateRef: input.targetStateRef,
      expectedReceiptSourceRef: definition.receiptSemantics,
      expectedReadAuthorityRef: "fixture:retry-and-attempt-owner-authority",
      expectedReadVersion: 1,
    };
    assert.equal(validate(input), true, `${definition.id} accepts its complete typed positive fixture: ${JSON.stringify(validate.errors)}`);
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(definition.receiptSchema.additionalProperties, false);
    assert.equal(evaluateMediaCausalTriggerDefinition({ definition, input, trusted, validateInputSchema: validate }).decision, "ELIGIBLE_DEFINITION_ONLY", `${definition.id} binds a closed source-specific owner receipt`);
    const foreignTenant = structuredClone(input);
    foreignTenant.tenantId = "tenant-foreign";
    foreignTenant.ownerReceipt.tenantId = "tenant-foreign";
    assert.equal(validate(foreignTenant), true, `${definition.id} allows a structurally valid other-tenant tuple`);
    assert.equal(evaluateMediaCausalTriggerDefinition({ definition, input: foreignTenant, trusted, validateInputSchema: validate }).decision, "UNKNOWN", `${definition.id} rejects identical object/version refs under a foreign tenant`);
    const missingReceipt = { ...input };
    delete missingReceipt.ownerReceipt;
    assert.equal(validate(missingReceipt), false, `${definition.id} rejects a missing source receipt`);
    const forgedReceipt = structuredClone(input);
    forgedReceipt.ownerReceipt.sourceRef = ".product-experience/pdp-1-domain-data/operations.yaml#foreign-owner-record";
    assert.equal(validate(forgedReceipt), false, `${definition.id} rejects a foreign receipt source in its closed schema`);
    const alteredEvidence = structuredClone(input);
    alteredEvidence.ownerReceipt.targetStateRef = input.sourceStateRef;
    assert.equal(validate(alteredEvidence), false, `${definition.id} rejects a receipt for a different target state`);
    if (Object.hasOwn(input, "leaseRef")) {
      assert.equal(evaluateMediaCausalTriggerDefinition({ definition, input: { ...input, fencingToken: input.fencingToken + 1 }, trusted, validateInputSchema: validate }).decision, "UNKNOWN", `${definition.id} rejects a well-shaped foreign fence`);
    } else {
      assert.equal(Object.hasOwn(definition.inputSchema.properties, "leaseRef"), false, `${definition.id} does not demand or permit a synthetic worker lease for this branch`);
      assert.equal(definition.inputSchema.properties.leaseEvidenceDisposition.const === "CURRENT_FENCED_ATTEMPT_REQUIRED", false);
    }
  }
});

test("job lease requirements follow causal branch rather than blanket job/attempt membership", () => {
  const definitions = semantic.records.flatMap((row) => row.triggerCases.map((edge) => ({ transitionRef: row.transitionRef, edge, definition: edge.causalTriggerDefinition })).filter(({ definition }) => definition?.triggerKind.startsWith("TYPED_FENCED_JOB_ATTEMPT_")));
  const noLease = definitions.filter(({ definition }) => !Object.hasOwn(definition.inputSchema.properties, "leaseRef"));
  assert.ok(noLease.length > 0);
  for (const { transitionRef, edge, definition } of noLease) {
    assert.equal(definition.inputSchema.additionalProperties, false);
    assert.equal(definition.inputSchema.properties.leaseEvidenceDisposition.const === "CURRENT_FENCED_ATTEMPT_REQUIRED", false);
    assert.ok(!definition.inputSchema.required.some((key) => ["attemptId", "leaseRef", "leaseRevisionRef", "fencingToken", "leaseExpiresAt"].includes(key)), `${definition.id} has no fake active lease tuple`);
    assert.ok(definition.receiptSemantics && definition.receiptSchema?.additionalProperties === false, `${definition.id} uses an exact branch receipt`);
    if (transitionRef.endsWith("media-job/T01")) {
      assert.equal(definition.inputSchema.properties.leaseEvidenceDisposition.const, "NOT_YET_ISSUED_OR_NO_ACTIVE_ATTEMPT");
      if (edge.toStateRef.endsWith("/@id=CANCELLED")) assert.equal(definition.inputSchema.properties.activeAttemptDisposition.const, "NO_ACTIVE_ATTEMPT");
      if (edge.toStateRef.endsWith("/@id=FAILED")) assert.equal(definition.inputSchema.properties.effectFinality.const, "DEFINITIVE_PRE_DISPATCH_FAILURE");
    } else if (transitionRef.endsWith("media-job/T03")) {
      assert.equal(definition.inputSchema.properties.leaseEvidenceDisposition.const, "NO_NEW_ATTEMPT_CLAIMED");
      if (edge.toStateRef.endsWith("/@id=OUTCOME_UNKNOWN")) assert.equal(definition.inputSchema.properties.uncertaintyDisposition.enum.includes("PRIOR_EFFECT_UNRESOLVED"), true);
    } else {
      assert.match(transitionRef, /media-job\/T0[45]$/u, "only reconciliation/read branches omit current worker lease");
      assert.equal(definition.inputSchema.properties.leaseEvidenceDisposition.const, "CURRENT_WORKER_LEASE_NOT_REQUIRED_FOR_RECONCILIATION");
      assert.equal(definition.receiptSemantics.includes("operations.yaml"), true);
    }
  }
  for (const { transitionRef, definition } of definitions.filter(({ definition }) => Object.hasOwn(definition.inputSchema.properties, "leaseRef"))) {
    assert.ok(definition.inputSchema.required.includes("leaseRef"), `${definition.id} requires a lease only on a claim/worker-fenced branch`);
    assert.ok(definition.inputSchema.required.includes("fencingToken"));
    assert.ok(definition.inputSchema.required.includes("leaseExpiresAt"));
    assert.ok(transitionRef.includes("media-attempt/") || /media-job\/(T01|T02|T03)$/u.test(transitionRef));
  }
});

test("artifact lifecycle edges use distinct closed receipt shapes and require exact upload/version subjects", () => {
  const definitions = semantic.records.flatMap((row) => row.triggerCases.map((edge) => edge.causalTriggerDefinition).filter((definition) => definition?.domainObjectRefs?.includes("media.domain.upload-session")));
  assert.equal(definitions.length, 23);
  for (const definition of definitions) {
    const validate = ajv.compile(definition.inputSchema);
    const input = schemaFixture(definition.inputSchema);
    input.uploadSessionId = "upload-session:tenant-a:42";
    input.tenantId = "tenant-a";
    input.sessionRevisionRef = "upload-session-revision:42:8";
    input.sourceStateRef = definition.inputSchema.properties.sourceStateRef.const;
    input.targetStateRef = definition.inputSchema.properties.targetStateRef.const;
    input.occurredAt = "2026-10-09T12:00:00.000Z";
    if (Object.hasOwn(input, "artifactVersionRef")) input.artifactVersionRef = "artifact-version:tenant-a:17";
    const receipt = schemaFixture(definition.receiptSchema);
    Object.assign(receipt, {
      sourceRef: definition.receiptSemantics,
      tenantId: input.tenantId,
      subjectRef: input.uploadSessionId,
      subjectVersionRef: input.sessionRevisionRef,
      sourceStateRef: input.sourceStateRef,
      targetStateRef: input.targetStateRef,
      authorityRef: "fixture:artifact-state-owner-authority",
      readVersion: 1,
      currentness: "CURRENT",
      observedAt: input.occurredAt,
      evidenceRefs: ["fixture:artifact-causal-evidence"],
      disposition: "VERIFIED",
    });
    for (const key of Object.keys(definition.receiptSchema.properties)) {
      if (Object.hasOwn(input, key)) receipt[key] = input[key];
    }
    input.ownerReceipt = receipt;
    const trusted = {
      tenantId: input.tenantId,
      now: "2026-10-09T12:00:00.000Z", maxAgeMs: 120_000,
      expectedUploadSessionId: input.uploadSessionId,
      expectedSessionRevisionRef: input.sessionRevisionRef,
      ...(input.artifactVersionRef ? { expectedArtifactVersionRef: input.artifactVersionRef } : {}),
      expectedSourceStateRef: input.sourceStateRef,
      expectedTargetStateRef: input.targetStateRef,
      expectedReceiptSourceRef: definition.receiptSemantics,
      expectedReadAuthorityRef: "fixture:artifact-state-owner-authority",
      expectedReadVersion: 1,
    };
    assert.equal(validate(input), true, `${definition.id} accepts its exact owner receipt fixture: ${JSON.stringify(validate.errors)}`);
    const positiveResult = evaluateMediaCausalTriggerDefinition({ definition, input, trusted, validateInputSchema: validate });
    assert.equal(positiveResult.decision, "ELIGIBLE_DEFINITION_ONLY", `${definition.id} accepts a typed source-specific definition fixture only: ${JSON.stringify(positiveResult)}`);
    const foreignTenant = structuredClone(input);
    foreignTenant.tenantId = "tenant-b";
    foreignTenant.ownerReceipt.tenantId = "tenant-b";
    assert.equal(validate(foreignTenant), true, `${definition.id} allows a structurally valid foreign tenant receipt`);
    assert.equal(evaluateMediaCausalTriggerDefinition({ definition, input: foreignTenant, trusted, validateInputSchema: validate }).decision, "UNKNOWN", `${definition.id} rejects tenant substitution despite identical object/version IDs`);
    const foreignSubject = structuredClone(input);
    foreignSubject.ownerReceipt.subjectRef = "upload-session:tenant-b:42";
    assert.equal(evaluateMediaCausalTriggerDefinition({ definition, input: foreignSubject, trusted, validateInputSchema: validate }).decision, "UNKNOWN", `${definition.id} rejects foreign upload session receipt`);
    const wrongEvidence = structuredClone(input);
    wrongEvidence.ownerReceipt.sourceRef = ".product-experience/pdp-1-domain-data/operations.yaml#foreign-source";
    assert.equal(validate(wrongEvidence), false, `${definition.id} receipt schema is source-specific and closed`);
    if (Object.hasOwn(input, "artifactVersionRef")) {
      const foreignVersion = structuredClone(input);
      foreignVersion.ownerReceipt.artifactVersionRef = "artifact-version:tenant-b:17";
      assert.equal(evaluateMediaCausalTriggerDefinition({ definition, input: foreignVersion, trusted, validateInputSchema: validate }).decision, "UNKNOWN", `${definition.id} rejects a foreign immutable artifact version`);
    }
  }
});

test("the remaining edge population has per-fact closed evidence schemas and derives applied, denied, and unknown", () => {
  const contracts = new Map(semantic.guardFactContracts.map((row) => [`${p1}/transitions.yaml#ownerDefinedTransitionTriggerSemantics/guardFactContracts/@id=${row.id}`, row]));
  assert.equal(semantic.guardFactContractCount, 164);
  assert.equal(contracts.size, 164);
  const definitions = semantic.records.flatMap((row) => row.triggerCases.map((edge) => edge.causalTriggerDefinition).filter((definition) => definition?.triggerKind === "EDGE_SPECIFIC_TYPED_GUARD_RECEIPT_SET"));
  assert.equal(definitions.length, 96);
  for (const definition of definitions) {
    const validate = ajv.compile(definition.inputSchema);
    const trusted = {
      now: "2026-10-09T12:00:00.000Z", maxEventAgeMs: 120_000, tenantId: "tenant:media-test-01", principalId: "principal:media-test-01",
      expectedAggregateRef: "project:tenant-media-test:subject-001",
      expectedAggregateVersionRef: "project-revision:tenant-media-test:subject-001:rev-12",
      expectedAuthorityByFact: {}, expectedReadVersionByFact: {}, maxAgeMsByFact: {},
    };
    const factReceipts = definition.triggerGuardFacts.map(({ sourceRef, factContractRef }) => {
      const contract = contracts.get(factContractRef);
      assert.ok(contract, `${definition.id} resolves exact fact contract ${factContractRef}`);
      const authorityRef = contract.authorityRefs[0];
      trusted.expectedAuthorityByFact[sourceRef] = authorityRef;
      trusted.expectedReadVersionByFact[sourceRef] = 4;
      trusted.maxAgeMsByFact[sourceRef] = 120_000;
      if (contract.valueKind === "EXACT_PROJECT_HEAD_REVISION_EQUALITY") {
        trusted.expectedProjectRef = "project:tenant-media-test:subject-001";
        trusted.expectedVersionByFact ??= {};
        trusted.expectedVersionByFact[sourceRef] = "project-revision:tenant-media-test:subject-001:rev-12";
      }
      if (contract.valueKind === "EXHAUSTIVE_ACTIVE_HOLD_SET") trusted.expectedPurposeByFact ??= {}, trusted.expectedPurposeByFact[sourceRef] = "purpose:erasure";
      if (contract.valueKind === "CURRENT_PER_EFFECT_CONSENT_SET") {
        trusted.expectedPurposeByFact ??= {};
        trusted.expectedPurposeByFact[sourceRef] = "purpose:stream-effect";
        trusted.expectedEffectRefsByFact ??= {};
        trusted.expectedEffectRefsByFact[sourceRef] = [`effect:${definition.edgeRuleRef}`];
        trusted.expectedSubjectArtifactVersionRefByFact ??= {};
        trusted.expectedSubjectArtifactVersionRefByFact[sourceRef] = trusted.expectedAggregateVersionRef;
        trusted.expectedRightsOperationRefByFact ??= {};
        trusted.expectedRightsOperationRefByFact[sourceRef] = rightsDecisionContract.operationRefs[0];
        trusted.expectedRightsReadAuthorityRefByFact ??= {};
        trusted.expectedRightsReadAuthorityRefByFact[sourceRef] = rightsDecisionContract.readAuthorityRefs[0];
        trusted.expectedRightsReadVersionByFact ??= {};
        trusted.expectedRightsReadVersionByFact[sourceRef] = "rights-read-version-4";
        trusted.expectedConsentReadAuthorityRefByFact ??= {};
        trusted.expectedConsentReadAuthorityRefByFact[sourceRef] = consentRevisionContract.resultSchema.properties.readAuthorityRef.enum[0];
        trusted.expectedConsentReadVersionByFact ??= {};
        trusted.expectedConsentReadVersionByFact[sourceRef] = "consent-read-version-4";
        trusted.expectedRegionByFact ??= {};
        trusted.expectedRegionByFact[sourceRef] = "region:us";
        trusted.expectedRetentionPolicyRefByFact ??= {};
        trusted.expectedRetentionPolicyRefByFact[sourceRef] = "retention:stream-24h:v1";
        trusted.expectedConsentBindingsByEffect ??= [];
        trusted.expectedConsentBindingsByEffect.push({ effectRef: `effect:${definition.edgeRuleRef}`, consentId: "consent-7",
          consentRef: "consent-reference:tenant-a:7", consentRevisionRef: "consent-revision:tenant-a:7", consentRevisionVersion: 7,
          decisionAuthorityVersionRef: "media.policy-decision:tenant-a:7", externalProcessingRequirement: "NOT_REQUIRED",
          biometricProcessingRequirement: "NOT_REQUIRED" });
      }
      if (contract.valueKind === "EXACT_SCOPED_AUTHORITY_DECISION") {
        const transitionRef = definition.transitionRef;
        const edgeRuleRef = definition.edgeRuleRef;
        trusted.expectedAuthorityDecisionByFact ??= {};
        trusted.expectedAuthorityDecisionByFact[sourceRef] = {
          decisionRef: `definition-fixture:authority-decision:${edgeRuleRef}`,
          transitionRef,
          edgeRuleRef,
          effectRef: edgeRuleRef,
          authorityRef,
          policyRef: ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy",
          policyRevisionRef: "policy-revision:definition-fixture-4",
          decisionMethodRef: ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp05TrustAndOwnership/trustContexts/@id=media.trust.current-policy-decision",
        };
      }
      if (contract.valueKind === "EXACT_SCOPED_POLICY_REVISION_OBSERVATION") {
        trusted.expectedPolicyRefByFact ??= {};
        trusted.expectedPolicyRefByFact[sourceRef] = ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy";
        trusted.expectedPolicyRevisionRefByFact ??= {};
        trusted.expectedPolicyRevisionRefByFact[sourceRef] = "policy-revision:definition-fixture-4";
      }
      if (contract.valueKind === "EXHAUSTIVE_COPY_INVENTORY") {
        trusted.expectedCopyClassesByFact ??= {};
        trusted.expectedCopyClassesByFact[sourceRef] = contract.requiredCopyClasses;
        trusted.expectedInventoryManifestRefByFact ??= {};
        trusted.expectedInventoryManifestRefByFact[sourceRef] = "inventory-manifest:tenant-a:artifact-v7";
        trusted.expectedInventoryRevisionByFact ??= {};
        trusted.expectedInventoryRevisionByFact[sourceRef] = 3;
      }
      let value;
      if (contract.valueKind === "EXACT_STATE_OBSERVATION") value = { observationDisposition: "OBSERVED", observedStateRef: definition.targetStateRef };
      else if (contract.valueKind === "TENANT_IDENTITY_TUPLE") value = { tenantId: trusted.tenantId, subjectTenantId: trusted.tenantId };
      else if (contract.valueKind === "EXACT_PROJECT_HEAD_REVISION_EQUALITY") value = { projectRef: trusted.expectedProjectRef, expectedHeadRevisionId: trusted.expectedVersionByFact[sourceRef], observedCurrentHeadRevisionId: trusted.expectedVersionByFact[sourceRef] };
      else if (contract.valueKind === "EXHAUSTIVE_ACTIVE_HOLD_SET") value = { subjectRef: trusted.expectedAggregateRef, subjectVersionRef: trusted.expectedAggregateVersionRef, purposeRef: trusted.expectedPurposeByFact[sourceRef], enumerationDisposition: "EXHAUSTIVE", activeHoldRefs: [] };
      else if (contract.valueKind === "EXHAUSTIVE_COPY_INVENTORY") value = { subjectRef: trusted.expectedAggregateRef, subjectVersionRef: trusted.expectedAggregateVersionRef, inventoryManifestRef: "inventory-manifest:tenant-a:artifact-v7", inventoryRevision: 3, inventoryDisposition: "COMPLETE", requiredCopyClasses: [...contract.requiredCopyClasses], classCoverage: contract.requiredCopyClasses.map((copyClass) => ({ copyClass, enumerationDisposition: "EXHAUSTIVE", copyRefs: copyClass === "SOURCE" ? ["copy:source:1"] : [] })), unresolvedCopyRefs: [] };
      else if (contract.valueKind === "EXACT_ACCEPTED_REQUEST_SNAPSHOT") value = acceptedSnapshotFixture(trusted, sourceRef);
      else if (contract.valueKind === "EXACT_SCOPED_AUTHORITY_DECISION") {
        const expectedDecision = trusted.expectedAuthorityDecisionByFact[sourceRef];
        value = {
          decisionDisposition: "GRANTED", ...expectedDecision,
          tenantId: trusted.tenantId, principalId: trusted.principalId,
          subjectRef: trusted.expectedAggregateRef, subjectVersionRef: trusted.expectedAggregateVersionRef,
          validFrom: "2026-10-09T11:00:00.000Z", validUntil: "2026-10-09T13:00:00.000Z",
          observedAt: "2026-10-09T11:59:00.000Z", evidenceRefs: [`definition-fixture:authority-evidence:${definition.edgeRuleRef}`],
        };
      }
      else if (contract.valueKind === "EXACT_SCOPED_POLICY_REVISION_OBSERVATION") {
        value = {
          observationDisposition: "CURRENT", tenantId: trusted.tenantId, principalId: trusted.principalId,
          subjectRef: trusted.expectedAggregateRef, subjectVersionRef: trusted.expectedAggregateVersionRef,
          transitionRef: definition.transitionRef, edgeRuleRef: definition.edgeRuleRef, effectRef: definition.edgeRuleRef,
          authorityRef, policyRef: trusted.expectedPolicyRefByFact[sourceRef],
          expectedPolicyRevisionRef: trusted.expectedPolicyRevisionRefByFact[sourceRef],
          observedPolicyRevisionRef: trusted.expectedPolicyRevisionRefByFact[sourceRef],
          observedAt: "2026-10-09T11:59:00.000Z", evidenceRefs: [`definition-fixture:policy-revision:${definition.edgeRuleRef}`],
        };
      }
      else if (contract.valueKind === "CURRENT_PER_EFFECT_CONSENT_SET") {
        const effectRef = trusted.expectedEffectRefsByFact[sourceRef][0];
        const consentBinding = trusted.expectedConsentBindingsByEffect.find((row) => row.effectRef === effectRef);
        const rightsRequest = { queryId: "rights-query-1", subjectArtifactVersionRef: trusted.expectedSubjectArtifactVersionRefByFact[sourceRef],
          decisionKind: "CONSENT", purposeRef: trusted.expectedPurposeByFact[sourceRef], useRef: effectRef,
          regionRef: trusted.expectedRegionByFact[sourceRef], retentionPolicyRef: trusted.expectedRetentionPolicyRefByFact[sourceRef] };
        const rightsTrusted = { tenantScopeRef: trusted.tenantId, principalRef: trusted.principalId,
          expectedOperationRef: trusted.expectedRightsOperationRefByFact[sourceRef], expectedReadAuthorityRef: trusted.expectedRightsReadAuthorityRefByFact[sourceRef],
          expectedReadVersion: trusted.expectedRightsReadVersionByFact[sourceRef] };
        const rightsResult = { tenantScopeRef: trusted.tenantId, principalRef: trusted.principalId, queryId: rightsRequest.queryId,
          operationRef: rightsTrusted.expectedOperationRef, requestFingerprint: typedObservationRequestFingerprint(rightsRequest, rightsTrusted),
          readAuthorityRef: rightsTrusted.expectedReadAuthorityRef, currentness: "CURRENT", decisionKind: "CONSENT",
          observationStatus: "ALLOWED_FOR_DECLARED_SCOPE", observedAt: "2026-10-09T11:59:00.000Z", readVersion: rightsTrusted.expectedReadVersion,
          decision: { tenantScopeRef: trusted.tenantId, principalRef: trusted.principalId, subjectArtifactVersionRef: rightsRequest.subjectArtifactVersionRef,
            decisionKind: "CONSENT", purposeRef: rightsRequest.purposeRef, useRef: effectRef, regionRef: rightsRequest.regionRef,
            retentionPolicyRef: rightsRequest.retentionPolicyRef, authorityRef: rightsTrusted.expectedReadAuthorityRef,
            authorityVersionRef: consentBinding.decisionAuthorityVersionRef, effectDisposition: "PERMITTED",
            validFrom: "2026-10-09T11:00:00.000Z", validUntil: "2026-10-09T13:00:00.000Z",
            evidenceRefs: [consentBinding.consentRevisionRef] } };
        const consentRequest = { queryId: "consent-query-1", consentId: consentBinding.consentId,
          purposeRef: trusted.expectedPurposeByFact[sourceRef] };
        const consentTrusted = { tenantScopeRef: trusted.tenantId, principalRef: trusted.principalId,
          expectedOperationRef: consentRevisionContract.operationRef,
          expectedReadAuthorityRef: trusted.expectedConsentReadAuthorityRefByFact[sourceRef],
          expectedReadVersion: trusted.expectedConsentReadVersionByFact[sourceRef] };
        const consentResult = { queryId: consentRequest.queryId, requestFingerprint: typedObservationRequestFingerprint(consentRequest, consentTrusted),
          operationRef: consentTrusted.expectedOperationRef, readAuthorityRef: consentTrusted.expectedReadAuthorityRef, currentness: "CURRENT",
          readVersion: consentTrusted.expectedReadVersion, observedAt: "2026-10-09T11:59:00.000Z",
          outcome: { kind: "OBSERVED_CONSENT_REVISION", consentId: consentBinding.consentId, consentRef: consentBinding.consentRef,
            consentRevisionRef: consentBinding.consentRevisionRef, tenantScopeRef: trusted.tenantId, principalRef: trusted.principalId,
            purposes: [trusted.expectedPurposeByFact[sourceRef]], allowedRegions: [trusted.expectedRegionByFact[sourceRef]],
            externalProcessingAllowed: true, biometricProcessingAllowed: false, status: "ACTIVE",
            authorityRef: consentTrusted.expectedReadAuthorityRef, evidenceRef: "evidence:consent-grant:7",
            grantedAt: "2026-10-09T11:00:00.000Z", expiresAt: "2026-10-09T13:00:00.000Z", revokedAt: null, version: consentBinding.consentRevisionVersion } };
        value = { effectReads: [{ rightsRequest, rightsResult, consentRequest, consentResult }] };
      }
      else if (contract.valueKind === "UNRESOLVED_OWNER_PREDICATE") value = { observationDisposition: "UNKNOWN", observationReason: contract.semanticGap };
      else value = { [contract.valueProperty]: contract.valueSemantics };
      return {
        factRef: sourceRef, contractRef: factContractRef, producerRef: definition.producerRef,
        subjectRef: trusted.expectedAggregateRef, subjectVersionRef: trusted.expectedAggregateVersionRef,
        tenantId: trusted.tenantId, authorityRef, readVersion: 4,
        observedAt: trusted.now, evidenceRefs: [`fixture:evidence:${contract.id}`], value,
      };
    });
    const input = {
      transitionRef: definition.transitionRef, edgeRuleRef: definition.edgeRuleRef,
      producerRef: definition.producerRef, aggregateRef: trusted.expectedAggregateRef,
      aggregateVersionRef: trusted.expectedAggregateVersionRef, sourceStateRef: definition.sourceStateRef,
      targetStateRef: definition.targetStateRef, occurredAt: trusted.now,
      decision: expectedGuardDecision(definition, contracts, factReceipts, trusted), factReceipts,
    };
    assert.equal(validate(input), true, `${definition.id} accepts its complete, exact typed receipt set: ${JSON.stringify(validate.errors)}`);
    const expectedPositive = expectedGuardDecision(definition, contracts, factReceipts, trusted);
    assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision,
      expectedPositive === "APPLIED" ? "APPLIED_DEFINITION_ONLY" : expectedPositive, `${definition.id} derives only supported predicates and preserves unresolved ones`);

    if (definition.triggerGuardFacts.some((fact) => contracts.get(fact.factContractRef)?.valueKind === "CURRENT_PER_EFFECT_CONSENT_SET")) {
      const consentReceipt = input.factReceipts.find((row) => contracts.get(row.contractRef)?.valueKind === "CURRENT_PER_EFFECT_CONSENT_SET");
      assert.ok(consentReceipt.value.effectReads[0].rightsRequest.queryId, "actual rights query request carries the canonical queryId field");
      assert.ok(consentReceipt.value.effectReads[0].rightsResult.decision, "actual rights query result carries the singular decision field");
      assert.equal(Object.hasOwn(consentReceipt.value, "effectDecisions"), false, "synthetic effectDecisions is not accepted as the owner wire result");
      const legacyShape = structuredClone(input);
      legacyShape.factReceipts.find((row) => row.factRef === consentReceipt.factRef).value = {
        subjectRef: trusted.expectedAggregateRef, subjectVersionRef: trusted.expectedAggregateVersionRef,
        purposeRef: "purpose:stream-effect", effectDecisions: [{ effectRef: "effect:forged", decision: "PERMITTED" }],
      };
      assert.equal(validate(legacyShape), false, "legacy flattened effect decisions fail the closed event schema");
      const invalidWire = structuredClone(input);
      invalidWire.factReceipts.find((row) => row.factRef === consentReceipt.factRef).value.effectReads[0].rightsRequest.subjectRef = "wrong-field-name";
      assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: invalidWire, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision,
        "UNKNOWN", "a consumer alias that is absent from the canonical rights request schema is not treated as source evidence");
      const forgedRightsFingerprint = structuredClone(input);
      forgedRightsFingerprint.factReceipts.find((row) => row.factRef === consentReceipt.factRef).value.effectReads[0].rightsResult.requestFingerprint = `sha256:${"f".repeat(64)}`;
      assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: forgedRightsFingerprint, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision,
        "UNKNOWN", "a syntactically valid but uncomputed rights-query fingerprint fails the exact request/trusted-context join");
      const uncorrelatedConsent = structuredClone(input);
      uncorrelatedConsent.factReceipts.find((row) => row.factRef === consentReceipt.factRef).value.effectReads[0].consentResult.queryId = "other-query";
      assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: uncorrelatedConsent, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision,
        "UNKNOWN", "a consent result from another query cannot be joined to this effect");
      for (const [label, mutate] of [
        ["future grant", (read) => { read.consentResult.outcome.grantedAt = "2026-10-09T13:00:00.000Z"; }],
        ["expired ACTIVE grant", (read) => { read.consentResult.outcome.expiresAt = "2026-10-09T11:00:00.000Z"; }],
        ["revoked ACTIVE grant", (read) => { read.consentResult.outcome.revokedAt = "2026-10-09T11:30:00.000Z"; }],
        ["required external-processing permission denied", (read, binding) => { binding.externalProcessingRequirement = "REQUIRED"; read.consentResult.outcome.externalProcessingAllowed = false; }],
      ]) {
        const contradictoryConsent = structuredClone(input);
        const contradictoryTrusted = structuredClone(trusted);
        const changed = contradictoryConsent.factReceipts.find((row) => row.factRef === consentReceipt.factRef);
        mutate(changed.value.effectReads[0], contradictoryTrusted.expectedConsentBindingsByEffect[0]);
        const result = evaluateMediaGuardFactReceiptSetDefinition({ definition, input: contradictoryConsent, trusted: contradictoryTrusted, validateInputSchema: validate, factContractsByRef: contracts });
        assert.notEqual(result.decision, "APPLIED_DEFINITION_ONLY", `${label} cannot satisfy current per-effect consent`);
      }
    }

    if (definition.triggerGuardFacts.some((fact) => contracts.get(fact.factContractRef)?.valueKind === "EXACT_ACCEPTED_REQUEST_SNAPSHOT")) {
      const requestReceipt = input.factReceipts.find((row) => contracts.get(row.contractRef)?.valueKind === "EXACT_ACCEPTED_REQUEST_SNAPSHOT");
      const invalidAcceptedRequest = structuredClone(trusted);
      invalidAcceptedRequest.expectedRequestSnapshotByFact[requestReceipt.factRef].jobSubmitRequest.parameters.outputWidth = 0;
      assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input, trusted: invalidAcceptedRequest, validateInputSchema: validate, factContractsByRef: contracts }).decision,
        "UNKNOWN", "the requestValid fact reruns the exact submitted command parameter/input validator, not a caller PRESENT label");
      const wrongSchemaClosure = structuredClone(input);
      wrongSchemaClosure.factReceipts.find((row) => row.factRef === requestReceipt.factRef).value.queryResult.targetSchemaDigest = `sha256:${"f".repeat(64)}`;
      wrongSchemaClosure.decision = "UNKNOWN";
      assert.equal(validate(wrongSchemaClosure), true, "a different but well-formed schema digest remains structurally valid evidence");
      assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: wrongSchemaClosure, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision,
        "UNKNOWN", "a valid foreign target schema closure cannot satisfy requestValid");
    }

    if (definition.triggerGuardFacts.some((fact) => contracts.get(fact.factContractRef)?.valueKind === "EXACT_SCOPED_AUTHORITY_DECISION")) {
      const authorityReceipt = input.factReceipts.find((row) => contracts.get(row.contractRef)?.valueKind === "EXACT_SCOPED_AUTHORITY_DECISION");
      const deniedDecision = structuredClone(input);
      deniedDecision.factReceipts.find((row) => row.factRef === authorityReceipt.factRef).value.decisionDisposition = "DENIED";
      deniedDecision.decision = expectedGuardDecision(definition, contracts, deniedDecision.factReceipts, trusted);
      assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: deniedDecision, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision,
        "DENIED", "an exact, current, scope-matched DENIED authority decision denies the edge");

      for (const [label, mutate] of [
        ["foreign policy revision", (value) => { value.policyRevisionRef = "policy-revision:foreign-valid-9"; }],
        ["wrong subject version", (value) => { value.subjectVersionRef = "project-revision:foreign-valid-9"; }],
        ["expired decision", (value) => { value.validUntil = trusted.now; }],
        ["future decision", (value) => { value.observedAt = "2026-10-09T12:01:00.000Z"; }],
      ]) {
        const mismatch = structuredClone(input);
        mutate(mismatch.factReceipts.find((row) => row.factRef === authorityReceipt.factRef).value);
        mismatch.decision = "UNKNOWN";
        assert.equal(validate(mismatch), true, `${label} remains structurally well-formed`);
        assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: mismatch, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision,
          "UNKNOWN", `${label} cannot satisfy authorityCurrent`);
      }

      const unknownDecision = structuredClone(input);
      const oldValue = unknownDecision.factReceipts.find((row) => row.factRef === authorityReceipt.factRef).value;
      unknownDecision.factReceipts.find((row) => row.factRef === authorityReceipt.factRef).value = {
        decisionDisposition: "UNKNOWN", decisionRef: oldValue.decisionRef, tenantId: oldValue.tenantId,
        principalId: oldValue.principalId, subjectRef: oldValue.subjectRef, subjectVersionRef: oldValue.subjectVersionRef,
        transitionRef: oldValue.transitionRef, edgeRuleRef: oldValue.edgeRuleRef, effectRef: oldValue.effectRef,
        authorityRef: oldValue.authorityRef, policyRef: oldValue.policyRef, policyRevisionRef: oldValue.policyRevisionRef,
        decisionMethodRef: oldValue.decisionMethodRef, observedAt: oldValue.observedAt, unknownReason: "owner decision unavailable",
      };
      unknownDecision.decision = "UNKNOWN";
      assert.equal(validate(unknownDecision), true, "UNKNOWN is an explicit typed authority decision branch");
      assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: unknownDecision, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision,
        "UNKNOWN", "an explicit unknown authority decision never promotes the transition");
    }

    if (definition.triggerGuardFacts.some((fact) => contracts.get(fact.factContractRef)?.valueKind === "EXACT_SCOPED_POLICY_REVISION_OBSERVATION")) {
      const policyReceipt = input.factReceipts.find((row) => contracts.get(row.contractRef)?.valueKind === "EXACT_SCOPED_POLICY_REVISION_OBSERVATION");
      const changedPolicy = structuredClone(input);
      const changed = changedPolicy.factReceipts.find((row) => row.factRef === policyReceipt.factRef).value;
      changed.observationDisposition = "NOT_CURRENT";
      changed.observedPolicyRevisionRef = "policy-revision:observed-newer-5";
      changedPolicy.decision = expectedGuardDecision(definition, contracts, changedPolicy.factReceipts, trusted);
      assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: changedPolicy, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision,
        "DENIED", "a same-scope observation of a different current revision denies the policyCurrent predicate");

      for (const [label, mutate] of [
        ["foreign policy revision", (value) => { value.policyRef = ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#foreignPolicy"; }],
        ["contradictory CURRENT revision", (value) => { value.observedPolicyRevisionRef = "policy-revision:foreign-valid-5"; }],
        ["future policy observation", (value) => { value.observedAt = "2026-10-09T12:01:00.000Z"; }],
      ]) {
        const mismatch = structuredClone(input);
        mutate(mismatch.factReceipts.find((row) => row.factRef === policyReceipt.factRef).value);
        mismatch.decision = "UNKNOWN";
        assert.equal(validate(mismatch), true, `${label} remains structurally well-formed`);
        assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: mismatch, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision,
          "UNKNOWN", `${label} cannot satisfy policyCurrent`);
      }
    }

    for (const receipt of factReceipts) {
      const contract = contracts.get(receipt.contractRef);
      if (!["EXHAUSTIVE_COPY_INVENTORY", "EXHAUSTIVE_ACTIVE_HOLD_SET", "CURRENT_PER_EFFECT_CONSENT_SET", "EXACT_PROJECT_HEAD_REVISION_EQUALITY"].includes(contract.valueKind)) continue;
      const foreignMeaning = structuredClone(input);
      const changed = foreignMeaning.factReceipts.find((item) => item.factRef === receipt.factRef);
      if (contract.valueKind === "EXHAUSTIVE_COPY_INVENTORY") {
        changed.value.inventoryManifestRef = "inventory-manifest:tenant-b:foreign";
      }
      if (contract.valueKind === "EXHAUSTIVE_ACTIVE_HOLD_SET") changed.value.purposeRef = "purpose:other";
      if (contract.valueKind === "CURRENT_PER_EFFECT_CONSENT_SET") {
        changed.value.effectReads[0].consentResult.outcome.consentRevisionRef = "consent-revision:tenant-b:foreign";
      }
      if (contract.valueKind === "EXACT_PROJECT_HEAD_REVISION_EQUALITY") changed.value.expectedHeadRevisionId = "project-revision:tenant-media-test:subject-001:rev-11";
      foreignMeaning.decision = "UNKNOWN";
      assert.equal(validate(foreignMeaning), true, `${definition.id} accepts a well-shaped foreign predicate tuple`);
      assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: foreignMeaning, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision,
        "UNKNOWN", `${definition.id} rejects a foreign subject/purpose/effect/request revision despite valid structure`);
      if (contract.valueKind === "EXHAUSTIVE_COPY_INVENTORY") {
        const staleInventoryRevision = structuredClone(input);
        staleInventoryRevision.factReceipts.find((item) => item.factRef === receipt.factRef).value.inventoryRevision += 1;
        assert.equal(validate(staleInventoryRevision), true, `${definition.id} accepts a structurally valid inventory revision candidate`);
        assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: staleInventoryRevision, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision,
          "UNKNOWN", `${definition.id} rejects inventory enumeration from a different trusted manifest revision`);
      }
      if (contract.valueKind === "CURRENT_PER_EFFECT_CONSENT_SET") {
        const staleConsentRevision = structuredClone(input);
        staleConsentRevision.factReceipts.find((item) => item.factRef === receipt.factRef).value.effectReads[0].consentResult.outcome.version += 1;
        assert.equal(validate(staleConsentRevision), true, `${definition.id} accepts a structurally valid consent revision candidate`);
        assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: staleConsentRevision, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision,
          "UNKNOWN", `${definition.id} rejects a consent read at a different trusted revision number`);
      }
    }

    const denied = structuredClone(input);
    for (const receipt of denied.factReceipts) {
      const contract = contracts.get(receipt.contractRef);
      if (contract.valueKind === "UNRESOLVED_OWNER_PREDICATE") continue;
      if (contract.valueKind === "EXACT_STATE_OBSERVATION") {
        const otherState = contract.valueSchema.oneOf[0].properties.observedStateRef.enum.find((ref) => ref !== definition.targetStateRef);
        if (otherState) receipt.value.observedStateRef = otherState;
        else { receipt.value.observationDisposition = "UNKNOWN"; delete receipt.value.observedStateRef; receipt.value.observationReason = "no exact target state observation"; }
      } else if (contract.valueKind === "TENANT_IDENTITY_TUPLE") receipt.value.subjectTenantId = "tenant:foreign-02";
      else if (contract.valueKind === "EXACT_PROJECT_HEAD_REVISION_EQUALITY") receipt.value.observedCurrentHeadRevisionId = "project-revision:tenant-media-test:subject-001:rev-11";
      else if (contract.valueKind === "EXHAUSTIVE_ACTIVE_HOLD_SET") receipt.value.activeHoldRefs = ["hold:tenant-a:active-1"];
      else if (contract.valueKind === "EXHAUSTIVE_COPY_INVENTORY") receipt.value.inventoryDisposition = "PARTIAL";
      else if (contract.valueKind === "EXACT_ACCEPTED_REQUEST_SNAPSHOT") receipt.value.queryResult.targetOperationRef = "media.operation.capability.media-vision-detect";
      else if (contract.valueKind === "CURRENT_PER_EFFECT_CONSENT_SET") {
        const rights = receipt.value.effectReads[0].rightsResult;
        rights.observationStatus = "CONSENT_REQUIRED";
        rights.decision.effectDisposition = "CONSENT_REQUIRED";
      }
      else if (contract.valueKind === "EXACT_SCOPED_AUTHORITY_DECISION") receipt.value.decisionDisposition = "DENIED";
      else if (contract.valueKind === "EXACT_SCOPED_POLICY_REVISION_OBSERVATION") {
        receipt.value.observationDisposition = "NOT_CURRENT";
        receipt.value.observedPolicyRevisionRef = "policy-revision:observed-newer-5";
      }
      else receipt.value[contract.valueProperty] = contract.valueOptions.find((value) => value !== "UNKNOWN" && value !== contract.valueSemantics) ?? "UNKNOWN";
    }
    denied.decision = expectedGuardDecision(definition, contracts, denied.factReceipts, trusted);
    assert.equal(validate(denied), true, `${definition.id} accepts well-typed negative evidence`);
    const expectedDenied = expectedGuardDecision(definition, contracts, denied.factReceipts, trusted);
    assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: denied, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision,
      expectedDenied === "APPLIED" ? "APPLIED_DEFINITION_ONLY" : expectedDenied, `${definition.id} derives only supported predicates from typed negative evidence`);

    const unknown = structuredClone(input);
    for (const receipt of unknown.factReceipts) {
      const contract = contracts.get(receipt.contractRef);
      if (contract.valueKind === "EXACT_STATE_OBSERVATION") { receipt.value = { observationDisposition: "UNKNOWN", observationReason: "source read unavailable" }; }
      else if (contract.valueKind === "TENANT_IDENTITY_TUPLE") receipt.value = { identityDisposition: "UNKNOWN", observationReason: "tenant identity read unavailable" };
      else if (contract.valueKind === "EXACT_PROJECT_HEAD_REVISION_EQUALITY") receipt.value = { observationDisposition: "UNKNOWN", observationReason: "project head read unavailable" };
      else if (contract.valueKind === "EXHAUSTIVE_ACTIVE_HOLD_SET") receipt.value.enumerationDisposition = "UNKNOWN";
      else if (contract.valueKind === "EXHAUSTIVE_COPY_INVENTORY") receipt.value.inventoryDisposition = "UNKNOWN";
      else if (contract.valueKind === "EXACT_ACCEPTED_REQUEST_SNAPSHOT") receipt.value.queryResult = {
        outcome: "UNKNOWN_OBSERVATION", operationRef: "media.operation.request-snapshot.inspect.v1",
        jobId: trusted.expectedAggregateRef, requestId: trusted.expectedRequestSnapshotByFact[receipt.factRef].requestId,
        reasonCode: "SNAPSHOT_UNAVAILABLE", readAuthorityRef: trusted.expectedRequestSnapshotByFact[receipt.factRef].readAuthorityRef,
        readVersion: trusted.expectedRequestSnapshotByFact[receipt.factRef].readVersion, observedAt: trusted.now,
      };
      else if (contract.valueKind === "EXACT_SCOPED_AUTHORITY_DECISION") {
        const value = receipt.value;
        receipt.value = {
          decisionDisposition: "UNKNOWN", decisionRef: value.decisionRef, tenantId: value.tenantId, principalId: value.principalId,
          subjectRef: value.subjectRef, subjectVersionRef: value.subjectVersionRef, transitionRef: value.transitionRef,
          edgeRuleRef: value.edgeRuleRef, effectRef: value.effectRef, authorityRef: value.authorityRef,
          policyRef: value.policyRef, policyRevisionRef: value.policyRevisionRef, decisionMethodRef: value.decisionMethodRef,
          observedAt: value.observedAt, unknownReason: "authority result unavailable",
        };
      }
      else if (contract.valueKind === "EXACT_SCOPED_POLICY_REVISION_OBSERVATION") {
        const value = receipt.value;
        receipt.value = {
          observationDisposition: "UNKNOWN", tenantId: value.tenantId, principalId: value.principalId,
          subjectRef: value.subjectRef, subjectVersionRef: value.subjectVersionRef,
          transitionRef: value.transitionRef, edgeRuleRef: value.edgeRuleRef, effectRef: value.effectRef,
          authorityRef: value.authorityRef, policyRef: value.policyRef,
          expectedPolicyRevisionRef: value.expectedPolicyRevisionRef, observedPolicyRevisionRef: value.observedPolicyRevisionRef,
          observedAt: value.observedAt, unknownReason: "policy read unavailable",
        };
      }
      else if (contract.valueKind === "CURRENT_PER_EFFECT_CONSENT_SET") {
        receipt.value.effectReads[0].consentResult.outcome = { kind: "UNKNOWN", reasonRef: "reason:consent-unavailable" };
      }
      else if (contract.valueKind === "UNRESOLVED_OWNER_PREDICATE") receipt.value = { observationDisposition: "UNKNOWN", observationReason: contract.semanticGap };
      else receipt.value[contract.valueProperty] = "UNKNOWN";
    }
    unknown.decision = expectedGuardDecision(definition, contracts, unknown.factReceipts, trusted);
    assert.equal(validate(unknown), true, `${definition.id} accepts explicit unresolved evidence`);
    assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: unknown, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision, "UNKNOWN", `${definition.id} preserves unknown without transition`);

    const foreign = structuredClone(input);
    foreign.factReceipts[0].subjectVersionRef = "project-revision:foreign-tenant:rev-12";
    assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: foreign, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision, "UNKNOWN", `${definition.id} rejects a valid-shaped foreign version tuple`);
    const stale = structuredClone(input);
    stale.factReceipts[0].readVersion = 3;
    assert.equal(evaluateMediaGuardFactReceiptSetDefinition({ definition, input: stale, trusted, validateInputSchema: validate, factContractsByRef: contracts }).decision, "UNKNOWN", `${definition.id} rejects a stale read version`);
  }
});

test("all 164 typed guard-fact records resolve their exact source and authority selectors", async () => {
  const documents = new Map();
  const refs = semantic.guardFactContracts.flatMap((contract) => [...contract.predicateSourceRefs, ...contract.sourceRefs, ...contract.authorityRefs]);
  assert.equal(semantic.guardFactContracts.length, 164);
  for (const contract of semantic.guardFactContracts) {
    assert.equal(ajv.compile(contract.valueSchema) instanceof Function, true, `${contract.id} has a valid closed value schema`);
    assert.ok(contract.sourceRefs.length > 0 && contract.authorityRefs.length > 0);
    for (const ref of [...contract.predicateSourceRefs, ...contract.sourceRefs, ...contract.authorityRefs]) {
      assert.ok(await resolveExactSourceRef(ref, documents), `${contract.id} exact source selector resolves: ${ref}`);
    }
  }
});

test("inventory, hold, version, and per-effect consent predicates use typed source values", () => {
  const openFacts = new Set([]);
  for (const fact of openFacts) {
    const contract = semantic.guardFactContracts.find((row) => row.fact === fact);
    assert.equal(contract.valueKind, "UNRESOLVED_OWNER_PREDICATE");
    assert.equal(contract.semanticResolutionStatus, "OPEN_TYPED_FACT_SEMANTICS");
    assert.match(contract.semanticGap, /exact|exhaustive|current|subject|revision|effect/u);
    assert.deepEqual(contract.valueSchema.properties.observationDisposition, { const: "UNKNOWN" });
  }
  const holdFact = semantic.guardFactContracts.find((row) => row.fact === "hold.absent");
  assert.equal(holdFact.valueKind, "EXHAUSTIVE_ACTIVE_HOLD_SET");
  assert.deepEqual(Object.keys(holdFact.valueSchema.properties).sort(), ["activeHoldRefs", "enumerationDisposition", "purposeRef", "subjectRef", "subjectVersionRef"].sort());
  const consentFact = semantic.guardFactContracts.find((row) => row.fact === "consentPerEffectCurrent");
  assert.equal(consentFact.valueKind, "CURRENT_PER_EFFECT_CONSENT_SET");
  assert.deepEqual(consentFact.valueSchema.required, ["effectReads"]);
  assert.deepEqual(consentFact.valueSchema.properties.effectReads.items.required, ["rightsRequest", "rightsResult", "consentRequest", "consentResult"]);
  assert.ok(consentFact.sourceRefs.includes(".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.rights-decision.v1"));
  assert.ok(consentFact.sourceRefs.includes(".product-experience/pdp-1-domain-data/operations.yaml#ownerConsentRevisionObservationContract"));
  assert.equal(consentFact.valueSchema.properties.effectReads.items.properties.rightsRequest.type, "object");
  assert.equal(consentFact.valueSchema.properties.effectReads.items.properties.rightsResult.type, "object");
  assert.equal(consentFact.valueSchema.properties.effectReads.items.properties.consentRequest.type, "object");
  assert.equal(consentFact.valueSchema.properties.effectReads.items.properties.consentResult.type, "object");
  const versionFact = semantic.guardFactContracts.find((row) => row.fact === "expectedVersionMatches");
  assert.ok(versionFact.sourceRefs.includes(`${p1}/domain-objects.yaml#objects/@id=media.domain.project-revision`));
  assert.ok(versionFact.sourceRefs.some((ref) => ref.includes("transitionRecords/@id=media-project-version/T01")));
  assert.ok(versionFact.sourceRefs.includes(`${p1}/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation-slice.attach-source-asset`));
  assert.equal(versionFact.valueKind, "EXACT_PROJECT_HEAD_REVISION_EQUALITY");
  assert.equal(versionFact.valueSchema.oneOf[0].additionalProperties, false);
  assert.deepEqual(Object.keys(versionFact.valueSchema.oneOf[0].properties).sort(), ["expectedHeadRevisionId", "observedCurrentHeadRevisionId", "projectRef"].sort());
  const inventoryFact = semantic.guardFactContracts.find((row) => row.fact === "copyInventoryComplete");
  assert.equal(inventoryFact.valueKind, "EXHAUSTIVE_COPY_INVENTORY");
  assert.equal(inventoryFact.valueSchema.properties.classCoverage.items.additionalProperties, false);
  assert.equal(inventoryFact.valueSchema.properties.requiredCopyClasses.const.length, 6);
  assert.ok(inventoryFact.sourceRefs.includes(".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy/dataHandling/deletion"));
});
