import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { validatePdpUiCandidateOperationBindings } from "../scripts/lib/pdp-ui-action-semantic-validation.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const yaml = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => yaml.parse(readFileSync(resolve(root, path), "utf8"));
const parity = readYaml(".product-experience/interface-parity/operation-parity.yaml");
const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
const byId = new Map([
  ...operations.operations,
  ...operations.individualOperationContracts.records,
  ...operations.ownerDefinedOperationContracts.records,
  ...operations.capabilityOperationContracts.records,
].map((record) => [record.id, record]));

const expected = new Map([
  ["media.action.begin-artifact-upload", ["media.operation-slice.begin-upload"]],
  ["media.action.resume-artifact-upload", ["media.operation-slice.inspect-upload", "media.operation-slice.append-upload-chunk", "media.operation-slice.complete-upload"]],
  ["media.action.inspect-artifact", ["media.operation-slice.inspect-artifact"]],
  ["media.action.attach-source-asset", ["media.operation-slice.attach-source-asset"]],
  ["media.action.view-job-status", ["media.operation.action.view-job-status"]],
  ["media.action.check-job-outcome", ["media.operation.action.check-job-outcome"]],
  ["media.action.request-cancellation", ["media.operation-slice.cancel-job"]],
  ["media.action.retry-job", ["media.operation-slice.retry-job"]],
  ["media.action.request-transcription", ["media.operation.transcription-submission"]],
  ["media.action.review-transcript", ["media.operation.transcript-version-read"]],
  ["media.action.correct-caption", ["media.operation.caption-draft-write"]],
  ["media.action.align-caption-timing", ["media.operation.caption-draft-write"]],
  ["media.action.save-caption-version", ["media.operation.caption-version-write"]],
  ["media.action.compare-caption-versions", ["media.operation.caption-version-read"]],
]);

function semanticRequestAndResult(operation) {
  if (operation.ownerWireSchema?.requestSchema && operation.ownerWireSchema?.resultSchema) {
    return { request: operation.ownerWireSchema.requestSchema, result: operation.ownerWireSchema.resultSchema };
  }
  if (operation.requestSchema && operation.resultSchema) {
    return { request: operation.requestSchema, result: operation.resultSchema };
  }
  if (operation.inputSemantics?.requiredFields?.length && operation.outputSemantics?.requiredFields?.length) {
    return { request: operation.inputSemantics, result: operation.outputSemantics };
  }
  // The existing artifact metadata read is a source-observed HTTP adapter, not a
  // typed PDP-1 owner wire schema. Keep its exact request/result observations
  // distinct so the test cannot mistake the route for canonical wire parity.
  if (operation.id === "media.operation-slice.inspect-artifact"
    && operation.requestFields?.length
    && operation.outcomes?.success
    && operation.readSemantics) {
    return { request: operation.requestFields, result: operation.readSemantics };
  }
  return undefined;
}

test("all fourteen historical UI operation candidates select exact current owner definitions", () => {
  assert.deepEqual(validatePdpUiCandidateOperationBindings({ parity, operations }), [
    "media.operation-slice.attach-source-asset: unknown-outcome semantics are missing",
    "media.operation.action.view-job-status: unknown-outcome semantics are missing",
    "media.operation.action.check-job-outcome: unknown-outcome semantics are missing",
  ], "the exact candidate map remains non-admitted and exposes its three typed-outcome gaps");
  const actions = new Map(parity.typedUiActionSemantics.map((row) => [row.identity, row]));
  assert.equal(expected.size, 14);
  for (const [actionId, expectedRefs] of expected) {
    const action = actions.get(actionId);
    assert.ok(action, `${actionId} has a current source-semantic row`);
    const typed = action.actionDefinitionSemantics.typedDefinition;
    assert.deepEqual(typed.exactOperationRefs, expectedRefs, `${actionId} exact owner operation sequence`);
    assert.equal(typed.operationRef, expectedRefs.length === 1 ? expectedRefs[0] : null);
    assert.equal(typed.runtimeAdmission, "NOT_ADMITTED");
    assert.ok(action.actionDefinitionSemantics.sourceEnvelope.effect);
    assert.ok(action.actionDefinitionSemantics.sourceEnvelope.finality);
    assert.ok(action.actionDefinitionSemantics.sourceEnvelope.failure);
    for (const ref of expectedRefs) {
      const owner = byId.get(ref);
      assert.ok(owner, `${actionId}: exact owner operation resolves: ${ref}`);
      const contract = semanticRequestAndResult(owner);
      assert.ok(contract?.request, `${ref} has exact request/input semantics`);
      assert.ok(contract?.result, `${ref} has exact result/output semantics`);
      assert.ok(owner.operationKind ?? owner.ownerWireSchema?.operationKind, `${ref} has an explicit query/command kind`);
    }
  }
});

test("candidate operation joins fail on missing, substituted, reordered, or broadened owner operations", () => {
  const value = structuredClone(parity);
  const validate = (candidate, ownerSource = operations) => validatePdpUiCandidateOperationBindings({ parity: candidate, operations: ownerSource });
  value.typedUiActionSemantics.find(({ identity }) => identity === "media.action.begin-artifact-upload")
    .actionDefinitionSemantics.typedDefinition.exactOperationRefs = ["media.operation.artifact-ingest"];
  assert.ok(validate(value).some((error) => error.includes("exact owner operation sequence is missing or substituted")),
    "a family-level operation cannot replace the exact leaf");

  const resume = structuredClone(parity);
  resume.typedUiActionSemantics.find(({ identity }) => identity === "media.action.resume-artifact-upload")
    .actionDefinitionSemantics.typedDefinition.exactOperationRefs.reverse();
  assert.ok(validate(resume).some((error) => error.includes("exact owner operation sequence is missing or substituted")),
    "upload resume order is inspect, append, then complete");

  const comparison = structuredClone(parity);
  comparison.typedUiActionSemantics.find(({ identity }) => identity === "media.action.compare-caption-versions")
    .actionDefinitionSemantics.typedDefinition.exactOperationRefs = ["media.operation.caption-version-write"];
  assert.ok(validate(comparison).some((error) => error.includes("exact owner operation sequence is missing or substituted")),
    "comparison cannot be widened into a write");

  const missingUnknown = structuredClone(operations);
  const jobRead = missingUnknown.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation.action.view-job-status");
  delete jobRead.unknownOutcome;
  assert.ok(validate(parity, missingUnknown).some((error) => error.includes("unknown-outcome semantics are missing")),
    "a typed status result without its unknown/read-unavailable semantics is incomplete");
});

test("source request and outcome material cannot disappear while identity and operation kind remain", () => {
  const inspect = byId.get("media.operation-slice.inspect-artifact");
  assert.ok(inspect.requestFields.length > 0);
  assert.ok(inspect.outcomes.success && inspect.outcomes.unknownOutcome);
  assert.ok(inspect.readSemantics);
  const transcript = byId.get("media.operation.transcript-version-read");
  assert.ok(transcript.inputSemantics.requiredFields.includes("transcriptVersionId"));
  assert.ok(transcript.outputSemantics.requiredFields.includes("uncertaintyAvailability"));
  assert.match(transcript.finality, /read-only/u);
  assert.match(transcript.unknownOutcome, /UNAVAILABLE/u);
  assert.match(transcript.recovery, /same-exact-transcriptVersionId/u);

  const weakened = structuredClone(operations);
  weakened.operations.find(({ id }) => id === "media.operation.transcript-version-read")
    .outputSemantics.requiredFields = transcript.outputSemantics.requiredFields.filter((field) => field !== "uncertaintyAvailability");
  assert.ok(validatePdpUiCandidateOperationBindings({ parity, operations: weakened }).some((error) =>
    error.includes("uncertaintyAvailability")), "dropping field-level uncertainty disclosure must fail validation");
});
