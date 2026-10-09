import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const phase = ".product-experience/pdp-3-product-experience";
const registryPath = path.join(root, phase, "journey-registry.yaml");
const overviewPath = path.join(root, phase, "COMPLETE-PRODUCT-EXPERIENCE.md");
const candidatePath = path.join(root, phase, "generated/experience-specification.candidate.json");

test("PDP-3 overview reports the registered baseline and extension journey denominators", () => {
  const registry = fs.readFileSync(registryPath, "utf8");
  const overview = fs.readFileSync(overviewPath, "utf8");
  const candidate = JSON.parse(fs.readFileSync(candidatePath, "utf8"));
  const baselineCount = Number(registry.match(/^requiredMasterPlanJourneyCount: (\d+)$/mu)?.[1]);
  const extensionCount = Number(registry.match(/^additionalPdp0JourneyCount: (\d+)$/mu)?.[1]);
  const registeredIds = [...registry.matchAll(/^\s*- id: (J-\d+)$/gmu)].map((match) => match[1]);
  const contractPaths = [...registry.matchAll(/^\s*contract: (journey-contracts\/[^\s]+)$/gmu)].map((match) => match[1]);

  assert.equal(baselineCount, 28);
  assert.equal(extensionCount, 2);
  assert.equal(registeredIds.length, baselineCount + extensionCount);
  assert.equal(contractPaths.length, registeredIds.length);
  assert.ok(contractPaths.every((contract) => fs.existsSync(path.join(root, phase, contract))));
  assert.match(overview, /All 28\s+plan-baseline journey files are PDP-0-grounded proposals with ordered screen\s+references; J-29 and J-30 are explicit extension contracts/u);
  assert.doesNotMatch(overview, /24 added journey files/u);

  const projectedJourneys = candidate.candidateModel.journeys;
  const journeyAudit = candidate.candidateMappingReview.journeyBindingAudit;
  assert.equal(projectedJourneys.length, 30);
  assert.equal(projectedJourneys.reduce((count, journey) => count + journey.steps.length, 0), 130);
  assert.equal(projectedJourneys.find(({ id }) => id === "J-29").steps.length, 4);
  assert.deepEqual(journeyAudit.stepIntentProjection.omitted, []);
  assert.match(overview, /30 journey records with 130 of 130 source\s+steps/u);
  assert.match(overview, /Four J-29 step intents and all eight J-29\/J-30 step-view links are now explicit/u);
  assert.match(overview, /Empty\s+`transitionRefs` arrays are schema placeholders/u);
  assert.match(overview, /five semantic blockers/u);
  assert.match(overview, /does not imply full PDP-3 acceptance, owner or\s+independent review, or Lifecycle currentness and closure/u);
  assert.doesNotMatch(overview, /0 schema-shaped journeys|no schema-shaped journey is emitted/u);
});
