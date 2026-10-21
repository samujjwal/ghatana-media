import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const { parse } = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(path, "utf8"));
const journey = readYaml(".product-experience/pdp-3-product-experience/journey-contracts/review-exact-version-and-recheck-changes.yaml");
const p0 = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml");
const p1 = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
const p0Journey = p0.journeys.find(({ id }) => id === "J-21");
const evidence = journey.pdp1ResultEvidence.productIntegrationBoundary;
const operations = new Map(p1.ownerDefinedOperationContracts.records.map((record) => [record.id, record]));
const typedObservations = new Map(p1.ownerTypedObservationContracts.records.map((record) => [record.id, record]));
const rightsQuery = operations.get("media.operation.action.review-rights-approval-and-format-effects");
const reviewRecord = operations.get("media.operation.action.record-version-review-decision");
const rightsObservation = typedObservations.get("media.observation-contract.rights-decision.v1");

test("J21 product integration is source-evidence-only with approval mutation blocked", () => {
  assert.ok(p0Journey, "P0 J-21 source journey exists");
  assert.equal(journey.journeyId, "J-21");
  assert.ok(p0Journey.preconditions.includes("Review purpose, exact artifact version, reviewer authority, and scope/expiry are explicit."));
  assert.match(p0Journey.completion, /Decision attaches to the reviewed version/u);

  assert.equal(evidence.channelRef, "media.channel.product-integration");
  assert.equal(evidence.status, "SOURCE_EVIDENCE_ONLY; READ_ONLY_RIGHTS_OBSERVATION; APPROVAL_MUTATION_BLOCKED; RUNTIME_NOT_ADMITTED");
  assert.equal(evidence.readOnlyEvidence.operationRef, rightsQuery.id);
  assert.equal(rightsQuery.operationKind, "QUERY");
  assert.equal(rightsQuery.sourceFinality, "read-only-or-navigation; no-write-finality");
  assert.equal(evidence.readOnlyEvidence.observationContractRef.split("@id=").at(-1), rightsObservation.id);
  assert.match(evidence.readOnlyEvidence.exactSubject, /equal to the immutable version reviewed by J-21/u);
  assert.match(evidence.readOnlyEvidence.approvedOnlyWhen, /nonempty authoritative evidenceRefs/u);
  assert.match(evidence.readOnlyEvidence.missingOrUncertainEvidence, /Preserve UNKNOWN/u);
  assert.match(evidence.readOnlyEvidence.missingOrUncertainEvidence, /do not establish absence/u);
  assert.ok(rightsObservation.operationRefs.includes(rightsQuery.id));
  assert.equal(rightsObservation.operationKind, "QUERY");

  assert.equal(evidence.blockedApprovalMutation.status, "BLOCKED_EXCLUDED");
  assert.equal(evidence.blockedApprovalMutation.actionRef, null);
  assert.match(evidence.blockedApprovalMutation.disposition, /Do not dispatch or infer an approval mutation/u);
  assert.equal(evidence.receiptBoundary.operationRef, reviewRecord.id);
  assert.match(evidence.receiptBoundary.meaning, /does not imply HUMAN_REVIEW_APPROVAL/u);
  assert.match(reviewRecord.resultSchema.finality, /does not\s+imply approval/u);
  assert.match(evidence.receiptBoundary.unknown, /UNKNOWN is neither success nor failure/u);
  assert.equal(journey.pdp1ResultEvidence.rightsApprovalActionDisposition.status, "BLOCKED_EXCLUDED");
  assert.equal(journey.pdp1ResultEvidence.rightsApprovalActionDisposition.ownerReceiptDisposition,
    "EXTERNAL_CURRENT_OWNER_EVIDENCE; NOT_A_PDP3_DEVELOPMENT_PREREQUISITE; NO_RECEIPT_ASSERTED");
  assert.match(journey.pdp1ResultEvidence.rightsApprovalActionDisposition.developmentBoundary,
    /genuine owner receipt is external current evidence and is not a prerequisite to completing this source definition/u);
  assert.equal(journey.pdp1ResultEvidence.rightsApprovalActionDisposition.actionRef, null,
    "no approval mutation action is authored or implied by the rights-decision query");
  assert.equal(evidence.transport, "UNBOUND");
  assert.equal(evidence.runtimeAdmission, "NOT_ADMITTED");
});
