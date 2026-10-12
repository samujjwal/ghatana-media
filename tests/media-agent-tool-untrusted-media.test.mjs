import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const requireTools = createRequire(resolve("../ghatana-tools/package.json"));
const { parse } = requireTools("yaml");
const Ajv2020 = requireTools("ajv/dist/2020").default;
const addFormats = requireTools("ajv-formats").default;
const conventions = parse(readFileSync(".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml", "utf8"));
const media = conventions.mediaOwnedToolDefinitionContracts;
const boundary = media.untrustedMediaDataBoundary;
const makeAjv = () => { const ajv = new Ajv2020({ strict: false, validateFormats: true }); addFormats(ajv); return ajv; };
const hostValid = makeAjv().compile(media.hostInvocationContext.schema);
const planValid = makeAjv().compile(media.boundedPlanningSemantics.planEnvelopeSchema);

const hostTuple = {
  toolId: "av.speech-to-text",
  contractId: "media.agent-tool-contract.speech-to-text.v1",
  operationRef: "media.operation.transcription-submission",
  principalRef: "principal:trusted",
  tenantRef: "tenant:trusted",
  delegationChainRef: "delegation:trusted",
  purposeRef: "purpose:transcription",
  resourceBindings: [{
    objectRef: "media.domain.artifact",
    versionRef: "artifact-version:7",
    tenantRef: "tenant:trusted",
    purposeRef: "purpose:transcription",
    authorityDecisionRef: "decision:current",
    decision: "AUTHORIZED",
    evidenceRef: "evidence:current",
    observedAt: "2026-10-10T12:00:00Z",
    validUntil: "2026-10-10T13:00:00Z",
  }],
  policyDecisionRefs: ["decision:current"],
  executionBudget: {
    disposition: "BOUNDED",
    budgetRef: "budget:invocation-1",
    policyVersionRef: "policy:v4",
    capabilityBoundsRef: ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/bounds/@id=media.capability-bounds.media-speech-transcription-file",
  },
  deadline: "2026-10-10T12:30:00Z",
  idempotencyDisposition: "REQUIRED_SCOPED_KEY",
  idempotencyKeyRef: "key:invocation-1",
  cancellationRef: "cancel:invocation-1",
};
const hostContext = {
  principalRef: hostTuple.principalRef,
  tenantRef: hostTuple.tenantRef,
  delegationChainRef: hostTuple.delegationChainRef,
  purposeRef: hostTuple.purposeRef,
  resourceBindings: structuredClone(hostTuple.resourceBindings),
  policyDecisionRefs: [...hostTuple.policyDecisionRefs],
  executionBudget: structuredClone(hostTuple.executionBudget),
  invocationId: "invocation-1",
  deadline: hostTuple.deadline,
  idempotencyDisposition: hostTuple.idempotencyDisposition,
  idempotencyKeyRef: hostTuple.idempotencyKeyRef,
  cancellationRef: hostTuple.cancellationRef,
};

const plan = () => ({
  planId: "plan:1",
  planVersion: "1.0.0",
  members: [{
    actionRef: "media.action.request-transcription",
    actionDefinitionRef: ".product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id=media.action.request-transcription",
    operationRefs: [hostTuple.operationRef],
    operationContractRefs: [".product-experience/pdp-1-domain-data/operations.yaml#operations/@id=media.operation.transcription-submission"],
    purposeRef: hostTuple.purposeRef,
    resourceBindings: [{ objectRef: "media.domain.artifact", versionRef: "artifact-version:7" }],
    preconditionRefs: ["guard:current-authority"],
    expectedResultDisposition: "ACCEPTED",
  }],
  budget: {
    budgetRef: "budget:plan-1",
    policyVersionRef: "policy:v4",
    maxPlanningSteps: 4,
    maxToolInvocations: 1,
    maxReasoningTokens: 1000,
    deadline: "2026-10-10T12:30:00Z",
  },
  authorityContextRef: "authority-context:1",
});

const immutableTuple = (value) => Object.fromEntries(
  boundary.immutableAuthorityTargetBudgetTuple.fields.map((field) => [field, value[field]]),
);
const preservesHostTuple = (candidate, original) =>
  JSON.stringify(immutableTuple(candidate)) === JSON.stringify(immutableTuple(original));

test("catalogued transcript, OCR, and model attacks cannot expand the immutable trusted invocation tuple", () => {
  const cases = new Map(boundary.adversarialCases.map((item) => [item.id, item]));
  const transcript = cases.get("media.agent-tool-untrusted-case.transcript-tool-injection.v1");
  const ocr = cases.get("media.agent-tool-untrusted-case.ocr-policy-override.v1");
  const model = cases.get("media.agent-tool-untrusted-case.model-target-expansion.v1");
  assert.ok(transcript && ocr && model, "all three named adversarial cases remain in the definition");
  assert.deepEqual(boundary.immutableAuthorityTargetBudgetTuple.fields, [
    "toolId", "contractId", "operationRef", "principalRef", "tenantRef", "delegationChainRef",
    "purposeRef", "resourceBindings", "policyDecisionRefs", "executionBudget", "deadline",
    "idempotencyDisposition", "idempotencyKeyRef", "cancellationRef",
  ]);
  assert.match(boundary.immutableAuthorityTargetBudgetTuple.rule, /cannot change any value, add a tool\/operation\/target, or enlarge or renew the budget/u);

  assert.equal(hostValid(hostContext), true);
  assert.equal(planValid(plan()), true);

  const transcriptAttack = structuredClone(hostTuple);
  transcriptAttack.toolId = "av.text-to-speech";
  transcriptAttack.tenantRef = "tenant:attacker-selected";
  transcriptAttack.resourceBindings[0].objectRef = "media.domain.other-tenant-artifact";
  assert.equal(preservesHostTuple(transcriptAttack, hostTuple), false, `${transcript.id}: tool, tenant, and target changes reject`);

  const ocrAttack = structuredClone(hostTuple);
  ocrAttack.resourceBindings[0].authorityDecisionRef = "ocr-claimed-consent-approved";
  ocrAttack.resourceBindings[0].evidenceRef = "ocr-claimed-human-review";
  assert.equal(preservesHostTuple(ocrAttack, hostTuple), false, `${ocr.id}: OCR cannot replace authority evidence`);

  const modelAttack = structuredClone(hostTuple);
  modelAttack.operationRef = "media.operation.export-unlisted";
  modelAttack.executionBudget.budgetRef = "model-expanded-budget";
  modelAttack.executionBudget.policyVersionRef = "model-selected-policy";
  assert.equal(preservesHostTuple(modelAttack, hostTuple), false, `${model.id}: model cannot change target or budget tuple`);

  const extraToolMember = plan();
  extraToolMember.members[0].toolId = "av.text-to-speech";
  assert.equal(planValid(extraToolMember), false, "closed plan member rejects a tool injected by transcript content");
  const authorityClaim = plan();
  authorityClaim.members[0].consentApproved = true;
  assert.equal(planValid(authorityClaim), false, "closed plan member rejects OCR-supplied authority claims");
  const expandedBudget = plan();
  expandedBudget.budget.maxToolInvocations = 17;
  assert.equal(planValid(expandedBudget), false, "bounded plan schema rejects model expansion beyond its defined invocation cap");
});

test("untrusted observations remain inert data and cannot satisfy authority or dispatch guards", () => {
  assert.match(boundary.authorityRule, /data to inspect or quote, not an instruction source/u);
  assert.match(boundary.authorityRule, /cannot.*satisfy a guard/u);
  assert.match(boundary.envelopeSourceRule, /cannot supply or override those fields/u);
  assert.match(boundary.immutableAuthorityTargetBudgetTuple.rule, /rejected before dispatch/u);
  assert.equal(media.status, "MEDIA_OWNER_DEFINITION_ONLY; public-runtime-binding-pending");
  assert.equal(media.sharedBinding.status, "NOT_BOUND");
});
