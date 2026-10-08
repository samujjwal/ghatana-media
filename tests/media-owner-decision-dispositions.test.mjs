import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const acceptance = parse(read(".product-experience/acceptance.yaml"));

test("PXD-026 has normalized, bounded owner-policy dispositions with exact source and scope", () => {
  const record = acceptance.recordedHumanDecisionInputs.find(({ id }) => id === "ACCEPT-INPUT-MEDIA-OWNER-20261007");
  assert.ok(record, "the delegated Media owner input remains explicit");
  const normalized = record.normalizedPolicyDispositions;
  assert.equal(normalized.sourceDecisionId, "PXD-026");
  assert.equal(normalized.decisionOwner, "media-product-owner-delegate");
  assert.equal(normalized.decisionSource, ".product-experience/decision-log.md#PXD-026");
  assert.match(normalized.scopeBoundary, /policy-decision-only/u);
  assert.match(normalized.scopeBoundary, /no-per-record-binding-acceptance-or-PDP-phase-acceptance/u);
  assert.deepEqual(normalized.allowedDispositions, [
    "ACCEPTED", "REJECTED_WITH_REASON", "REWORK_REQUIRED", "REQUIRES_INDEPENDENT_REVIEW", "NOT_APPLICABLE_WITH_REASON",
  ]);
  assert.equal(normalized.records.length, 11);

  const ids = normalized.records.map(({ id }) => id);
  assert.equal(new Set(ids).size, ids.length, "normalized disposition IDs must be unique");
  for (const [index, disposition] of normalized.records.entries()) {
    assert.equal(disposition.id, `MEDIA-OWNER-20261007-${String(index + 1).padStart(2, "0")}`);
    assert.equal(disposition.disposition, "ACCEPTED");
    assert.ok(normalized.allowedDispositions.includes(disposition.disposition));
    assert.ok(disposition.topic);
    assert.ok(disposition.scope);
    assert.ok(disposition.evidenceRefs.length > 0);
    for (const evidence of disposition.evidenceRefs) {
      assert.ok(existsSync(resolve(root, evidence)), `${disposition.id} evidence does not resolve: ${evidence}`);
    }
  }

  const decisionLog = read(".product-experience/decision-log.md");
  assert.match(decisionLog, /### PXD-026/u);
  assert.match(decisionLog, /Normalized dispositions:.*ACCEPTED/u);
  assert.match(decisionLog, /do not accept leaf-level mappings/u);
  assert.match(decisionLog, /do not accept.*phase status/u);

  const stateAdjudication = parse(read(".product-experience/pdp-1-domain-data/state-adjudication.yaml"));
  const statePolicy = stateAdjudication.ownerAcceptedPolicyDecisions;
  assert.equal(statePolicy.policyStatus, "ACCEPTED");
  assert.deepEqual(statePolicy.policyDispositionRefs, normalized.records.slice(3, 7).map(({ id }) =>
    `.product-experience/acceptance.yaml#${id}`));
});

test("PXD-027 is a separate bounded owner-policy decision, not phase acceptance", () => {
  const ownerRecord = acceptance.recordedHumanDecisionInputs.find(({ id }) => id === "ACCEPT-INPUT-MEDIA-OWNER-GATES-20261007");
  assert.ok(ownerRecord);
  assert.equal(ownerRecord.decisionInput, "accepted");
  assert.equal(ownerRecord.sourceOfDecision, "explicit-2026-10-07-delegation-to-adjudicate-remaining-owner-level-decisions");
  assert.ok(ownerRecord.evidenceRefs.includes(".product-experience/decision-log.md#PXD-027"));
  assert.ok(ownerRecord.acceptedScope.some((scope) => scope.includes("eight Media GUI composition recipe identities")));
  assert.ok(ownerRecord.exclusions.some((scope) => scope.includes("Full PDP-0, PDP-1, PDP-2 or PDP-3 phase acceptance")));
  assert.ok(ownerRecord.exclusions.some((scope) => scope.includes("Lifecycle admitted proof")));

  const decisionLog = read(".product-experience/decision-log.md");
  const ownerReview = read(".product-experience/reviews/2026-10-07-all-gate-unblocking.md");
  assert.match(decisionLog, /^### PXD-027\b/mu);
  assert.match(decisionLog, /all four PDP phase-acceptance states remain open/u);
  assert.match(ownerReview, /MEDIA-OWNER-GATES-2026-10-07/u);
  const pxd026 = acceptance.recordedHumanDecisionInputs.find(({ id }) => id === "ACCEPT-INPUT-MEDIA-OWNER-20261007");
  assert.equal(pxd026.normalizedPolicyDispositions.sourceDecisionId, "PXD-026");
  assert.equal(pxd026.normalizedPolicyDispositions.records.some(({ topic }) => topic.includes("PXD-027")), false);
});

test("bounded PXD-026 policy approval does not alter independent PDP phase acceptance inputs", () => {
  const phaseRows = acceptance.phaseAcceptanceInputs;
  for (const phase of ["PDP-1", "PDP-2", "PDP-3"]) {
    const rows = phaseRows.filter((row) => row.phase === phase);
    assert.ok(rows.length > 0, `${phase} acceptance inputs remain present`);
    assert.ok(rows.every((row) => row.decisionInput !== "accepted"), `${phase} remains unaccepted`);
  }
  assert.equal(acceptance.acceptanceAuthority.independentReviewRequiredForFullPDP0, "P0-010");
});

test("PXD-030 records only representative initiating actors and preserves independent P0-010 review", () => {
  const record = acceptance.recordedHumanDecisionInputs.find(({ id }) => id === "ACCEPT-INPUT-MEDIA-OWNER-PDP0-REPRESENTATIVE-INITIATORS-20261008");
  assert.ok(record);
  assert.equal(record.phaseTask, "P0-04");
  assert.equal(record.decisionInput, "accepted");
  assert.equal(record.sourceOfDecision, "explicit-user-delegation-in-current-thread-for-reversible-Media-owner-decisions-within-vision-and-requirements");
  assert.ok(record.acceptedScope.some((scope) => scope.includes("one representative initiating actor")));
  assert.ok(record.exclusions.some((scope) => scope.includes("Independent P0-010 review")));

  const intentResolutions = parse(read(".product-experience/pdp-0-product-truth/intent-resolutions.yaml"));
  const journeyResolutions = parse(read(".product-experience/pdp-0-product-truth/journey-actor-resolutions.yaml"));
  assert.equal(intentResolutions.intents.length, 19);
  assert.ok(intentResolutions.intents.every(({ actorStatus }) => actorStatus === "resolved"));
  assert.equal(journeyResolutions.journeys.length, 30);
  assert.ok(journeyResolutions.journeys.every(({ actorStatus }) => actorStatus === "resolved"));
  assert.match(intentResolutions.resolutionPolicy.acceptance, /P0-010/u);
  assert.match(journeyResolutions.policy.acceptance, /P0-010/u);

  const decisionLog = read(".product-experience/decision-log.md");
  assert.match(decisionLog, /^### PXD-030 — Resolve PDP-0 representative initiating actors$/mu);
  assert.match(decisionLog, /not an authenticated principal, permission/u);
  assert.match(decisionLog, /runtime execution authority/u);
  assert.equal(acceptance.phaseAcceptanceInputs.find(({ phase, phaseTask }) => phase === "PDP-0" && phaseTask === "P0-010").decisionInput,
    "pending-independent-review-not-executed");
});
