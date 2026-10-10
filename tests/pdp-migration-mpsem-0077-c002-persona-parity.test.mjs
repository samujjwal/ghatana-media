import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const ownerPath = ".product-experience/pdp-0-product-truth/actors-responsibilities.yaml";
const journeyPath = ".product-experience/pdp-0-product-truth/journey-catalog.yaml";
const ownerText = readFileSync(resolve(root, ownerPath), "utf8");
const journeyText = readFileSync(resolve(root, journeyPath), "utf8");
const owner = parse(ownerText);
const journeys = parse(journeyText);
const candidate = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/truth-domain-pdp0-pdp1-owner-candidate-199.json"), "utf8"));
const partition = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-pending-owner-partition-499.json"), "utf8"));
const review = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml"), "utf8"));
const sha = (value) => createHash("sha256").update(value).digest("hex");
const ids = [
  "media.persona.educator-or-researcher",
  "media.persona.campaign-producer",
  "media.persona.archive-restorer",
  "media.persona.independent-creator",
  "media.persona.integrator",
];
const personaRecords = ids.map((id) => owner.personas.find((persona) => persona.id === id));
const goalIds = [...new Set(personaRecords.flatMap((persona) => persona.typicalGoals))];
const outcomeRows = goalIds.map((goal) => journeys.outcomeCoverage.find((row) => row.outcomeRef === goal));
const contextRefs = ids.map((id) => `${ownerPath}#/personas/@id=${id}/context`);
const goalRefs = ids.map((id) => `${ownerPath}#/personas/@id=${id}/typicalGoals`);
const outcomeRefs = outcomeRows.map((row) => `${journeyPath}#/outcomeCoverage/${journeys.outcomeCoverage.indexOf(row)}`);
const expectedRefs = [...contextRefs, ...goalRefs, ...outcomeRefs];
const serialize = (value) => typeof value === "string" ? value : JSON.stringify(value);
const resolveRef = (ref, actorDoc = owner, journeyDoc = journeys) => {
  const [sourcePath, pointer = ""] = ref.split("#", 2);
  let value = sourcePath === ownerPath ? actorDoc : sourcePath === journeyPath ? journeyDoc : undefined;
  for (const raw of pointer.split("/").filter(Boolean)) {
    const segment = raw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (segment.startsWith("@id=")) value = Array.isArray(value) ? value.find((item) => item?.id === segment.slice(4)) : undefined;
    else if (/^\d+$/u.test(segment)) value = value?.[Number(segment)];
    else value = value?.[segment];
  }
  return value;
};
const expectedValues = expectedRefs.map((ref) => serialize(resolveRef(ref)));
const row = candidate.records.find((item) => item.claimId === "MPSEM-0077-C002");
const historicalDocuments = new Map();

function resolveHistoricalDocument(path, expectedFileSha256) {
  const key = `${path}:${expectedFileSha256}`;
  if (historicalDocuments.has(key)) return historicalDocuments.get(key);
  const revisions = execFileSync("git", ["log", "--all", "--format=%H", "--", path], { cwd: root, encoding: "utf8" }).trim().split(/\r?\n/u);
  for (const revision of revisions) {
    const content = execFileSync("git", ["show", `${revision}:${path}`], { cwd: root, encoding: "utf8" });
    if (sha(content) === expectedFileSha256) {
      const document = parse(content);
      historicalDocuments.set(key, document);
      return document;
    }
  }
  throw new Error(`historical source snapshot ${path} at ${expectedFileSha256} is unavailable in Git history`);
}

function bindingsAreExact(bindings, actorDoc = owner, journeyDoc = journeys) {
  if (!Array.isArray(bindings) || bindings.length !== expectedRefs.length) return false;
  return expectedRefs.every((ref, index) => {
    const binding = bindings[index];
    const value = serialize(resolveRef(ref, actorDoc, journeyDoc));
    return binding?.ref === ref
      && binding.requiredSourcePhrase === value
      && binding.currentProposalObservation?.priorSourceValueSha256 === binding.sourceValueSha256
      && binding.currentProposalObservation?.currentSourceValueSha256 === sha(value);
  });
}

test("MPSEM-0077-C002 binds personas through exact goals and proposed journey coverage", () => {
  assert.equal(row.ownerSemanticReview.disposition, "SOURCE_RULE_CONTENT_SUPPORTS_CLAIM_AT_DEFINITION_LEVEL");
  assert.deepEqual(row.ownerSemanticReview.exactContractRefs, expectedRefs);
  assert.equal(row.ownerSemanticReview.proposedTargetRef, expectedRefs[0]);
  assert.equal(bindingsAreExact(row.ownerSemanticReview.materialBindings), true);
  assert.equal(row.ownerSemanticReview.acceptanceEffect, "none");
  assert.equal(row.ownerSemanticReview.runtimeStatus, "NOT_EVALUATED");
  assert.match(row.ownerSemanticReview.reason, /persona → typicalGoal → proposed journey outcome-coverage chain/u);
  assert.match(row.ownerSemanticReview.reason, /does not assert screen\/action completeness, market validation or adoption, runtime support, or phase acceptance/u);

  assert.match(personaRecords[1].context, /marketing or campaign producer/u);
  assert.match(personaRecords[2].context, /archival or historical material/u);
  assert.ok(personaRecords.every((persona) => persona.typicalGoals.length > 0));
  assert.ok(outcomeRows.every((outcome, index) => outcome?.outcomeRef === goalIds[index] && outcome.proposedJourneyRefs.length > 0));
  assert.ok(outcomeRows.every((outcome) => outcome.proposedJourneyRefs.every((id) => /^J-\d{2}$/u.test(id))));

  assert.equal(row.currentProposalObservation.currentSourceFileSha256, sha(ownerText));
  assert.equal(row.currentProposalObservation.priorSourceFileSha256, row.ownerSourceSha256);
  assert.notEqual(row.currentProposalObservation.priorSourceFileSha256, row.currentProposalObservation.currentSourceFileSha256);
  assert.deepEqual(row.currentProposalObservation.currentMaterialRefs, expectedRefs);
  assert.deepEqual(row.currentProposalObservation.currentMaterialValueSha256, expectedValues.map(sha));
  for (const binding of row.ownerSemanticReview.materialBindings) {
    const [path] = binding.ref.split("#", 2);
    const historicalDocument = resolveHistoricalDocument(path, binding.sourceFileSha256);
    const historicalValue = resolveRef(binding.ref, path === ownerPath ? historicalDocument : owner, path === journeyPath ? historicalDocument : journeys);
    assert.equal(binding.sourceValueSha256, sha(serialize(historicalValue)), `${binding.ref} historical target pin remains intact`);
    assert.equal(binding.currentProposalObservation?.priorSourceFileSha256, binding.sourceFileSha256);
    assert.equal(binding.currentProposalObservation?.priorSourceValueSha256, binding.sourceValueSha256);
  }
  assert.equal(partition.records.find((item) => item.claimId === "MPSEM-0077-C002").acceptanceEffect, "none");
});

test("MPSEM-0077-C002 rejects missing, weakened, or substituted persona/goal/journey examples", () => {
  const bindings = structuredClone(row.ownerSemanticReview.materialBindings);
  assert.equal(bindingsAreExact(bindings.slice(1)), false, "missing persona context rejected");
  const weakened = structuredClone(owner);
  weakened.personas.find((persona) => persona.id === ids[1]).context = "A producer preparing media.";
  assert.equal(bindingsAreExact(bindings, weakened), false, "weakened marketing/campaign context rejected");
  const substituted = structuredClone(bindings);
  substituted[2].ref = contextRefs[3];
  assert.equal(bindingsAreExact(substituted), false, "creator substituted for archival/historical example rejected");
  const missingGoal = structuredClone(owner);
  missingGoal.personas.find((persona) => persona.id === ids[0]).typicalGoals.pop();
  assert.equal(bindingsAreExact(bindings, missingGoal), false, "weakened persona-goal chain rejected");
  const missingJourney = structuredClone(journeys);
  missingJourney.outcomeCoverage.find((entry) => entry.outcomeRef === goalIds[0]).proposedJourneyRefs = [];
  assert.equal(bindingsAreExact(bindings, owner, missingJourney), false, "missing proposed journey references rejected");
  const substitutedJourney = structuredClone(bindings);
  substitutedJourney.at(-1).requiredSourcePhrase = "runtime-supported complete named journey";
  assert.equal(bindingsAreExact(substitutedJourney), false, "runtime or completeness claim cannot replace proposed journey evidence");
});

test("migration semantics review records the full persona-goal-journey chain without completeness claims", () => {
  const claim = review.pdp38ClaimReconciliation.records.flatMap(({ claims }) => claims ?? [])
    .find(({ claimId }) => claimId === "MPSEM-0077-C002");
  assert.equal(claim.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
  assert.deepEqual(claim.materialTargetRefs, expectedRefs);
  assert.deepEqual(claim.materialTargetValueSha256, expectedValues.map(sha));
  assert.equal(claim.decisionRef, ".product-experience/decision-log.md#PXD-136");
  assert.equal(claim.acceptanceEffect, "none");
  assert.match(claim.rationale, /persona-to-goal-to-proposed-journey example coverage only/u);
  assert.match(claim.rationale, /screen\/action completeness/u);
});
