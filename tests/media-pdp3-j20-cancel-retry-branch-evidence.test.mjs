import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const { parse } = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"))("yaml");
const readYaml = (sourcePath) => parse(readFileSync(sourcePath, "utf8"));
const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/long-running-job-observation-and-recovery.yaml");
const cancelRef = "media.operation-slice.cancel-job";
const retryRef = "media.operation-slice.retry-job";

const getIndividualOperation = (id) => operations.individualOperationContracts.records.find((operation) => operation.id === id);

test("J20 step 05 allocates only P1-defined cancellation branches and preserves the deadline blocker", () => {
  const cancel = getIndividualOperation(cancelRef);
  const step = journey.steps[4];
  const branches = Object.fromEntries(step.failure.branches.map((branch) => [branch.id, branch]));

  assert.ok(cancel);
  assert.equal(step.stepDefinitionSemantics.action.actionRef, "media.action.request-cancellation");
  assert.equal(step.canonicalOperationRef, cancelRef);
  assert.equal(step.failure.status, "SOURCE_DEFINED_OPERATION_FAILURE_BRANCHES; DEADLINE_BRANCH_BLOCKED");
  assert.equal(branches["already-terminal"].condition, "terminal-job-is-returned-without-rewriting-history");
  assert.ok(cancel.ownerDefinition.guards.includes("terminal-job-is-returned-without-rewriting-history"));
  assert.match(branches["already-terminal"].disposition, /do-not-create-or-imply-a-cancellation-transition/u);
  assert.ok(cancel.ownerDefinition.errors.includes("ACCESS_DENIED"));
  assert.equal(branches.denied.sourceRef.endsWith("/ownerDefinition/errors"), true);
  assert.ok(cancel.ownerDefinition.errors.includes("UNKNOWN_OUTCOME"));
  assert.match(cancel.ownerDefinition.retry, /same-request-reconciliation-before-resubmission/u);
  assert.match(branches["request-unknown-or-lost-ack"].disposition, /same-requestId-and-reconcile.*before-any-resubmission/u);
  assert.match(branches["request-unknown-or-lost-ack"].disposition, /automatic-retry-is-forbidden/u);
  assert.match(branches["reconciliation-unknown"].disposition, /do-not-claim-CANCELLED/u);
  assert.equal(branches["deadline-semantics-unavailable"].disposition.startsWith("BLOCKED_NO_P1_CANCEL_DEADLINE_FIELD_GUARD_OR_RESULT_SEMANTIC"), true);
  assert.match(branches["deadline-semantics-unavailable"].blocker, /no deadline request field, deadline guard, or deadline-specific error\/result/u);

  const actionBranches = step.stepDefinitionSemantics.stepOutcomeSemantics.nonhappy.branchEvidence;
  assert.equal(actionBranches.sourceOperationRef, `.product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/@id=${cancelRef}`);
  assert.ok(actionBranches.allocatedBranches.some((branch) => Object.hasOwn(branch, "already-terminal")));
  assert.ok(actionBranches.allocatedBranches.some((branch) => Object.hasOwn(branch, "UNKNOWN_OUTCOME-or-lost-ack")));
  assert.equal(actionBranches.deadlineDisposition, "BLOCKED_NO_P1_CANCEL_DEADLINE_SEMANTIC");
  assert.match(step.success.meaning, /request acknowledgement does not prove stop/u);
  assert.match(step.transitionDisposition.reason, /CANCEL_REQUESTED is not CANCELLED/u);
});

test("J20 step 06 maps retry denial, forbidden, stale, budget, and UNKNOWN branches to P1", () => {
  const retry = getIndividualOperation(retryRef);
  const step = journey.steps[5];
  const branches = Object.fromEntries(step.failure.branches.map((branch) => [branch.id, branch]));

  assert.ok(retry);
  assert.equal(step.stepDefinitionSemantics.action.actionRef, "media.action.retry-job");
  assert.equal(step.canonicalOperationRef, retryRef);
  assert.equal(step.failure.status, "SOURCE_DEFINED_OPERATION_FAILURE_BRANCHES");
  assert.ok(retry.ownerDefinition.errors.includes("ACCESS_DENIED"));
  assert.ok(retry.ownerDefinition.errors.includes("ATTEMPT_NOT_RETRYABLE"));
  assert.ok(retry.ownerDefinition.errors.includes("OUTCOME_UNKNOWN"));
  assert.ok(retry.ownerDefinition.errors.includes("RETRY_BUDGET_EXHAUSTED"));
  assert.ok(retry.ownerDefinition.errors.includes("VERSION_CONFLICT"));
  assert.ok(retry.ownerDefinition.guards.includes("prior-outcome-is-not-unknown"));
  assert.ok(retry.ownerDefinition.guards.includes("retry-budget-remains"));
  assert.match(retry.ownerDefinition.authority, /retry-budget-and-rights-are-authority-read/u);
  assert.match(retry.ownerDefinition.retry, /inspect-same-requestId-and-job-before-any-resubmission/u);
  assert.match(retry.ownerDefinition.recovery, /separate-authoritative-reconciliation-contract-first/u);
  assert.match(branches["retry-forbidden"].disposition, /do-not-dispatch/u);
  assert.match(branches["stale-authority-or-version"].disposition, /reject-without-new-attempt/u);
  assert.match(branches["exhausted-budget"].disposition, /no-new-attempt-or-fence-is-created/u);
  assert.match(branches["retry-request-unknown-or-lost-ack"].disposition, /same-requestId-and-job-before-any-resubmission/u);
  assert.match(branches["prior-effect-reconciliation-unknown"].disposition, /UNKNOWN-denies-retry/u);
  assert.match(step.stepDefinitionSemantics.stepOutcomeSemantics.nonhappy.failure, /do-not-dispatch.*outcome-is-unknown/u);
  assert.match(step.success.meaning, /at most one fenced new-attempt identity/u);
  assert.match(step.success.meaning, /does not establish provider dispatch/u);
});
