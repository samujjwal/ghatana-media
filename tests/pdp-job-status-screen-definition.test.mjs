import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const [screenText, actionText, operationText, stateText, authorityText] = await Promise.all([
  readFile(".product-experience/pdp-3-product-experience/screen-contracts/job-status.yaml", "utf8"),
  readFile(".product-experience/pdp-3-product-experience/action-registry.yaml", "utf8"),
  readFile(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"),
  readFile(".product-experience/pdp-1-domain-data/states.yaml", "utf8"),
  readFile(".product-experience/pdp-1-domain-data/authority.yaml", "utf8"),
]);
const screen = parse(screenText);
const actions = parse(actionText).actions;
const operations = parse(operationText);
const states = parse(stateText).stateMachines;
const authority = parse(authorityText);

const operationById = new Map([
  ...(operations.ownerDefinedOperationContracts.records ?? []),
  ...(operations.individualOperationContracts.records ?? []),
].map((record) => [record.id, record]));

test("job status screen binds the normalized read model and exact safe command meanings", () => {
  assert.deepEqual(screen.domainObjectRefs, ["media.domain.processing-job", "media.domain.job-attempt", "media.domain.job-lease"]);
  for (const operationRef of screen.operationRefs) {
    assert.ok(operationById.has(operationRef), `exact owner operation resolves: ${operationRef}`);
  }
  assert.ok(screen.operationRefs.includes("media.operation.job-status.read-dimensions.v1"));
  assert.ok(screen.operationRefs.includes("media.operation.action.inspect-job-retry-policy"));
  assert.ok(screen.authorityRefs.includes(".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/jobStatusRead"));
  assert.match(screen.entry.join(" "), /authenticated tenant and principal/u);
  assert.match(screen.entry.join(" "), /expected read authority and read version/u);
  assert.match(screen.exit.join(" "), /remain UNKNOWN/u);
  assert.match(screen.exit.join(" "), /not cancellation finality/u);

  const job = states.find((machine) => machine.machineId === "media-job");
  const attempt = states.find((machine) => machine.machineId === "media-attempt");
  const expectedStateRefs = [
    ...job.stateIds.map((id) => `media-job/${id}`),
    ...attempt.stateIds.map((id) => `media-attempt/${id}`),
  ];
  assert.deepEqual(screen.stateRefs, expectedStateRefs);
  const expectedOperations = new Map([
    ["media.action.view-job-status", "media.operation.job-status.read-dimensions.v1"],
    ["media.action.check-job-outcome", "media.operation.job-status.read-dimensions.v1"],
    ["media.action.request-cancellation", "media.operation-slice.cancel-job"],
    ["media.action.retry-job", "media.operation-slice.retry-job"],
  ]);
  for (const [actionId, operationRef] of expectedOperations) {
    const consequence = screen.actionConsequences.find((row) => row.actionId === actionId);
    assert.ok(consequence, `${actionId} is represented`);
    assert.equal(consequence.operationRef, operationRef);
    assert.match(consequence.effectRef, new RegExp(`action-registry.yaml#actions/@id=${actionId}/actionDefinitionSemantics/typedDefinition`, "u"));
    assert.doesNotMatch(consequence.consequence, /unresolved|pending-owner/u);
    assert.match(consequence.status, /NOT_ADMITTED/u);
    assert.ok(actions.some((action) => action.id === actionId));
  }
  assert.ok(authority.ownerDefinedPdp10AuthorityScopes.jobStatusRead);
  const statusRead = operationById.get("media.operation.job-status.read-dimensions.v1");
  assert.deepEqual(statusRead.requestSchema.required,
    ["queryId", "jobId", "stageRefs", "qualitySubjectVersionRefs", "destinationRefs"]);
  for (const field of ["stageRefs", "qualitySubjectVersionRefs", "destinationRefs"]) {
    assert.equal(statusRead.requestSchema.properties[field].minItems, 0);
    assert.equal(statusRead.requestSchema.properties[field].maxItems, 64);
  }
  assert.match(screen.entry.join(" "), /never expands to all stages, quality subjects, or destinations by default/u);
});

test("job-status screen rejects command/query substitution, foreign state dimensions, and invented actions", () => {
  const wrongRead = structuredClone(screen);
  wrongRead.actionConsequences.find((row) => row.actionId === "media.action.view-job-status").operationRef = "media.operation-slice.retry-job";
  assert.notEqual(wrongRead.actionConsequences.find((row) => row.actionId === "media.action.view-job-status").operationRef,
    "media.operation.job-status.read-dimensions.v1");

  const wrongState = structuredClone(screen);
  wrongState.stateRefs[0] = "media-upload-and-artifact/AVAILABLE";
  assert.ok(!screen.stateRefs.includes(wrongState.stateRefs[0]), "an artifact lifecycle state is not a job or attempt state");

  const inventedAction = structuredClone(screen);
  inventedAction.actionConsequences[0].actionId = "media.action.submit-validated-request";
  assert.ok(!expectedActionSet.has(inventedAction.actionConsequences[0].actionId));
});

const expectedActionSet = new Set([
  "media.action.view-job-status",
  "media.action.check-job-outcome",
  "media.action.request-cancellation",
  "media.action.retry-job",
]);
