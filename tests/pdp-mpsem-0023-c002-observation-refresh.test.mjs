import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fingerprintPxdDecisionSection } from "../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs";
import {
  OPERATION_PARITY_PATH,
  OWNER_CANDIDATE_PATH,
  digestMpsemObservationValue,
  refreshMpsem0023C002Observation,
} from "../scripts/lib/media-mpsem-0023-c002-observation-refresh.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const sha = (value) => createHash("sha256").update(value).digest("hex");

function candidateFixture({ sourceText = "previous source bytes", observedValue = "2-of-2 observed legacy/candidate SDK paths are absent from the 30-route active manifest; this proves non-admission and does not choose a replacement route." } = {}) {
  const historicalValue = "2-of-2 observed legacy/candidate SDK paths are absent from the 27-route active manifest; this proves non-admission and does not choose a replacement route.";
  const historicalDigest = digestMpsemObservationValue(historicalValue);
  const sourceDigest = sha(sourceText);
  const previousObservationDigest = sha("earlier source bytes");
  return {
    records: [{
      claimId: "MPSEM-0023-C002",
      currentTargetValueSha256: historicalDigest,
      semanticDisposition: "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED",
      targetSnapshotStatus: "LIVE_OBSERVATION_UNREVIEWED",
      ownerSemanticReview: { acceptanceEffect: "none", runtimeStatus: "NOT_EVALUATED" },
      currentProposalObservation: {
        status: "PENDING_COORDINATOR_MATERIAL_REVIEW",
        priorTargetValueSha256: historicalDigest,
        currentTargetValueSha256: historicalDigest,
        currentSourceFileSha256: sourceDigest,
        previousCurrentSourceFileSha256: previousObservationDigest,
        supersededCurrentSourceFileSha256: previousObservationDigest,
        sourceFileSha256History: [previousObservationDigest],
        currentValueDriftObservation: {
          status: "PENDING_COORDINATOR_MATERIAL_REVIEW",
          ref: `${OPERATION_PARITY_PATH}#compatibilityRouteFindings/currentComparison`,
          recordedTargetValueSha256: historicalDigest,
          observedTargetValueSha256: digestMpsemObservationValue(observedValue),
          observedTargetValuePreview: observedValue,
          acceptanceEffect: "none",
        },
      },
    }],
  };
}

function sourceInput({ value, routeCount = 30, findings = [{ method: "POST", path: "/api/v1/legacy" }, { method: "GET", path: "/api/v1/candidate" }] } = {}) {
  const currentValue = value ?? `2-of-2 observed legacy/candidate SDK paths are absent from the ${routeCount}-route active manifest; this proves non-admission and does not choose a replacement route.`;
  return {
    sourceText: "current owner source bytes",
    operationParity: { compatibilityRouteFindings: { sourceFindings: findings, currentComparison: currentValue } },
    routeManifest: { routes: Array.from({ length: routeCount }, (_, index) => ({ method: "GET", path: `/api/v1/current/${index}` })) },
  };
}

test("MPSEM-0023-C002 refreshes only the pending live source digest and preserves historical and non-admission state", () => {
  const candidate = candidateFixture();
  const input = sourceInput();
  const historicalTargetDigest = candidate.records[0].currentProposalObservation.currentTargetValueSha256;
  const oldSourceDigest = candidate.records[0].currentProposalObservation.currentSourceFileSha256;
  const result = refreshMpsem0023C002Observation({ candidate, ...input });
  const row = result.candidate.records[0];
  const observation = row.currentProposalObservation;
  const drift = observation.currentValueDriftObservation;

  assert.equal(result.changed, true);
  assert.equal(result.sourceSha256, sha(input.sourceText));
  assert.equal(observation.currentSourceFileSha256, sha(input.sourceText));
  assert.equal(observation.previousCurrentSourceFileSha256, oldSourceDigest);
  assert.equal(observation.supersededCurrentSourceFileSha256, oldSourceDigest);
  assert.deepEqual(observation.sourceFileSha256History, [sha("earlier source bytes"), oldSourceDigest]);
  assert.equal(observation.currentTargetValueSha256, historicalTargetDigest);
  assert.equal(observation.priorTargetValueSha256, historicalTargetDigest);
  assert.equal(drift.observedTargetValueSha256, digestMpsemObservationValue(input.operationParity.compatibilityRouteFindings.currentComparison));
  assert.equal(observation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(row.targetSnapshotStatus, "LIVE_OBSERVATION_UNREVIEWED");
  assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
  assert.equal(row.ownerSemanticReview.runtimeStatus, "NOT_EVALUATED");
  assert.equal(drift.acceptanceEffect, "none");

  const idempotent = refreshMpsem0023C002Observation({ candidate: result.candidate, ...input });
  assert.equal(idempotent.changed, false);

  const laterInput = { ...input, sourceText: "later owner source bytes" };
  const later = refreshMpsem0023C002Observation({ candidate: result.candidate, ...laterInput });
  assert.equal(later.changed, true);
  assert.equal(later.candidate.records[0].currentProposalObservation.currentSourceFileSha256, sha(laterInput.sourceText));
  assert.deepEqual(later.candidate.records[0].currentProposalObservation.sourceFileSha256History,
    [sha("earlier source bytes"), oldSourceDigest, sha(input.sourceText)]);
  assert.equal(later.candidate.records[0].currentProposalObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
});

test("MPSEM-0023-C002 refuses a changed target value until material review updates its pending observation", () => {
  const input = sourceInput({ routeCount: 31 });
  const candidate = candidateFixture();
  assert.throws(() => refreshMpsem0023C002Observation({ candidate, ...input }), /selected target value changed/u);
});

test("MPSEM-0023-C002 refuses to call a present SDK path absent from the active manifest", () => {
  const input = sourceInput({
    findings: [{ method: "GET", path: "/api/v1/current/0" }, { method: "POST", path: "/api/v1/legacy" }],
  });
  input.routeManifest.routes.push({ method: "GET", path: "/api/v1/current/0" });
  const candidate = candidateFixture();
  assert.throws(() => refreshMpsem0023C002Observation({ candidate, ...input }), /currentComparison|source summary|present in the current manifest/u);
});

test("PXD-228 current-source successor observes MPSEM-0023-C002 without changing the immutable candidate", () => {
  const sourceText = readFileSync(resolve(root, OPERATION_PARITY_PATH), "utf8");
  const operationParity = parse(sourceText);
  const decisionLogText = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");
  const candidate = JSON.parse(readFileSync(resolve(root, OWNER_CANDIDATE_PATH), "utf8"));
  const candidateBytes = readFileSync(resolve(root, OWNER_CANDIDATE_PATH));
  const successor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd228-live-source-2026-11-16.json"), "utf8"));
  const predecessorSuccessor = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd228.json"), "utf8"));
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0023-C002");
  const observed = successor.records.find(({ claimId }) => claimId === "MPSEM-0023-C002");
  assert.equal(successor.successorKind, "CURRENTNESS_ONLY");
  assert.equal(successor.predecessorRef, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd228.json");
  assert.equal(successor.predecessorSha256, sha(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/pdp0-migration-current-source-successor-pxd228.json"))));
  assert.equal(predecessorSuccessor.predecessorArtifact.artifactSha256, sha(candidateBytes));
  assert.equal(successor.decisionSectionSha256, fingerprintPxdDecisionSection(decisionLogText, "PXD-228").sha256);
  assert.equal(successor.sourceFingerprints[OPERATION_PARITY_PATH], sha(sourceText));
  assert.equal(observed.currentSourceFileSha256, sha(sourceText));
  assert.equal(observed.currentTargetValueSha256, sha(operationParity.compatibilityRouteFindings.currentComparison));
  assert.equal(observed.currentTargetValue, operationParity.compatibilityRouteFindings.currentComparison);
  assert.equal(observed.predecessorTargetValueSha256, row.currentTargetValueSha256);
  assert.equal(observed.predecessorSourceFileSha256, row.currentProposalObservation.currentSourceFileSha256);
  assert.equal(observed.predecessorPendingDriftTargetValueSha256,
    row.currentProposalObservation.currentValueDriftObservation.observedTargetValueSha256);
  assert.equal(observed.findingCounts.total, 14);
  assert.equal(observed.findingCounts.pathIdentityRetained, 6);
  assert.equal(observed.findingCounts.pathIdentityRetired, 8);
  assert.equal(observed.findingCounts.retainedMethodDispatchable, 5);
  assert.equal(observed.findingCounts.retainedMethodFailClosed, 1);
  assert.equal(observed.findingCounts.activeManifestPresent, 0);
  assert.equal(row.currentProposalObservation.currentSourceFileSha256, "27bc34748b22e6a59ff7dd4f2e50df18a3e5415ee6acad55e466ef7bb4016bcf",
    "the immutable predecessor source pin remains historical");
  assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(observed.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(observed.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(observed.semanticPromotion, false);
  assert.equal(observed.acceptanceEffect, "none");
  assert.equal(row.currentProposalObservation.acceptanceEffect ?? "none", "none");
  assert.equal(row.ownerSemanticReview.runtimeStatus, "NOT_EVALUATED");
});
