import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
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

test("checked-in MPSEM-0023-C002 observation matches current bytes without changing semantic disposition", () => {
  const sourceText = readFileSync(resolve(root, OPERATION_PARITY_PATH), "utf8");
  const operationParity = parse(sourceText);
  const candidate = JSON.parse(readFileSync(resolve(root, OWNER_CANDIDATE_PATH), "utf8"));
  const routeManifest = JSON.parse(readFileSync(resolve(root, "config/route-manifest.json"), "utf8"));
  const result = refreshMpsem0023C002Observation({ candidate, sourceText, operationParity, routeManifest });

  assert.equal(result.changed, false);
  const row = result.candidate.records.find(({ claimId }) => claimId === "MPSEM-0023-C002");
  assert.equal(row.currentProposalObservation.currentSourceFileSha256, sha(sourceText));
  assert.equal(row.semanticDisposition, "CLAIM_SPECIFIC_PARITY_NOT_YET_VERIFIED");
  assert.equal(row.currentProposalObservation.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(row.currentProposalObservation.acceptanceEffect ?? "none", "none");
  assert.equal(row.ownerSemanticReview.runtimeStatus, "NOT_EVALUATED");
});
