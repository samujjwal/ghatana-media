import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const [decisionText, catalogText, goalsText, contractTexts] = await Promise.all([
  readFile(".product-experience/pdp-3-product-experience/journey-outcome-projection-decisions.yaml", "utf8"),
  readFile(".product-experience/pdp-0-product-truth/journey-catalog.yaml", "utf8"),
  readFile(".product-experience/pdp-0-product-truth/goals-jtbd.yaml", "utf8"),
  readdir(".product-experience/pdp-3-product-experience/journey-contracts")
    .then((names) => Promise.all(names.filter((name) => name.endsWith(".yaml"))
      .map((name) => readFile(`.product-experience/pdp-3-product-experience/journey-contracts/${name}`, "utf8")))),
]);
const decisions = parse(decisionText).records;
const journeys = parse(catalogText).journeys;
const outcomes = new Set(parse(goalsText).outcomes.map((outcome) => outcome.id));
const contracts = contractTexts.map((text) => parse(text)).filter((contract) => contract.journeyId);
const contractById = new Map(contracts.map((contract) => [contract.journeyId, contract]));
const expected = new Map([
  ["J-01", "media.goal.resolve-safely"], ["J-02", "media.goal.understand-media"],
  ["J-03", "media.goal.review-trustworthy-output"], ["J-04", "media.goal.finished-asset"],
  ["J-05", "media.goal.understand-media"], ["J-06", "media.goal.integrate-repeatably"],
  ["J-07", "media.goal.improve-with-disclosure"], ["J-08", "media.goal.improve-with-disclosure"],
  ["J-09", "media.goal.finished-asset"], ["J-10", "media.goal.finished-asset"],
  ["J-11", "media.goal.improve-with-disclosure"], ["J-12", "media.goal.finished-asset"],
  ["J-13", "media.goal.finished-asset"], ["J-14", "media.goal.explain-or-demonstrate"],
  ["J-15", "media.goal.explain-or-demonstrate"], ["J-16", "media.goal.finished-asset"],
  ["J-17", "media.goal.finished-asset"], ["J-18", "media.goal.finished-asset"],
  ["J-19", "media.goal.improve-with-disclosure"], ["J-20", "media.goal.resolve-safely"],
  ["J-21", "media.goal.review-trustworthy-output"], ["J-22", "media.goal.deliver-approved-output"],
  ["J-23", "media.goal.resolve-safely"], ["J-24", "media.goal.integrate-repeatably"],
  ["J-25", "media.goal.integrate-repeatably"], ["J-26", "media.goal.preserve-source"],
  ["J-27", "media.goal.resolve-safely"], ["J-28", "media.goal.deliver-approved-output"],
  ["J-29", "media.goal.resolve-safely"], ["J-30", "media.goal.integrate-repeatably"],
]);

function validDecision(record, journey) {
  const contract = contractById.get(journey.id);
  return record?.journeyRef === journey.id
    && record.sourceJourneyRef === `.product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=${journey.id}`
    && JSON.stringify(record.sourceOutcomeRefs) === JSON.stringify(journey.outcomeRefs)
    && JSON.stringify(contract?.outcomes) === JSON.stringify(journey.outcomeRefs)
    && outcomes.has(record.primaryDesiredOutcomeRef)
    && journey.outcomeRefs.includes(record.primaryDesiredOutcomeRef)
    && record.selectionStatus === "MEDIA_OWNER_EXPLICIT_PRIMARY_OUTCOME_SELECTION; REVIEW_PENDING"
    && record.runtimeAdmission === "NOT_ADMITTED" && record.acceptanceEffect === "none";
}

test("all 30 journeys have an explicit primary outcome while preserving the complete P0 outcome set", () => {
  assert.equal(journeys.length, 30);
  assert.equal(decisions.length, 30);
  assert.equal(new Set(decisions.map((record) => record.journeyRef)).size, 30);
  const byJourney = new Map(decisions.map((record) => [record.journeyRef, record]));
  for (const journey of journeys) {
    const record = byJourney.get(journey.id);
    assert.ok(record, `${journey.id} has a decision record`);
    assert.equal(record.id, `media.pdp3.journey-outcome-projection.${journey.id.toLowerCase().replace("-", "")}.v1`);
    assert.equal(record.primaryDesiredOutcomeRef, expected.get(journey.id));
    assert.ok(validDecision(record, journey), `${journey.id} binds exact catalog and contract source sets`);
    assert.match(record.rationale, /.+/u);
  }
});

test("outcome projection decisions reject valid-looking foreign, incomplete, or drifted selections", () => {
  const journey = journeys.find((item) => item.id === "J-22");
  const original = decisions.find((item) => item.journeyRef === journey.id);
  for (const mutate of [
    (record) => { record.sourceJourneyRef = ".product-experience/pdp-0-product-truth/journey-catalog.yaml#journeys/@id=J-09"; },
    (record) => { record.sourceOutcomeRefs.pop(); },
    (record) => { record.primaryDesiredOutcomeRef = "media.goal.finished-asset"; },
    (record) => { record.runtimeAdmission = "ADMITTED"; },
  ]) {
    const changed = structuredClone(original);
    mutate(changed);
    assert.equal(validDecision(changed, journey), false);
  }
  assert.equal(validDecision(original, journey), true);
});
