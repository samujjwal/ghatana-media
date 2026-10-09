import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

test("P0-04 records delegated representative initiators without reducing requirement actors", () => {
  const base = ".product-experience/pdp-0-product-truth/";
  const goals = readYaml(`${base}goals-jtbd.yaml`);
  const decisions = readYaml(`${base}intent-resolutions.yaml`);
  const requirements = readYaml(`${base}requirements.yaml`).requirements;
  const ambiguousIntentIds = [
    "media.intent.improve",
    "media.intent.animate",
    "media.intent.understand",
    "media.intent.review-workspace-settings",
    "media.intent.restore-project",
    "media.intent.manage-artifact-lifecycle",
    "media.intent.resolve-job",
    "media.intent.recover-live-session",
    "media.intent.choose-eligible-processing-option",
    "media.intent.check-processing-options",
    "media.intent.inspect-provenance",
  ];
  const decisionById = new Map(decisions.intents.map((item) => [item.id, item]));
  for (const id of ambiguousIntentIds) {
    const source = goals.intents.find((item) => item.id === id);
    const decision = decisionById.get(id);
    assert.ok(source && decision, `${id} has canonical source and decision records`);
    assert.ok(source.actorRefs.length > 1, `${id} source has multiple actor candidates`);
    assert.equal(decision.actorStatus, "resolved", `${id} has an explicit Media-owner initiator decision`);
    assert.ok(source.actorRefs.includes(decision.actorRef), `${id} selects only a source-listed actor`);
    assert.ok(decision.actorRationale.includes("owner selects"), `${id} explains the delegated owner choice`);
    assert.ok(decision.actorEvidenceRefs.length, `${id} retains exact source evidence`);
  }

  const understandRequirement = requirements.find(({ id }) => id === "MEDIA-REQ-CAP-VISION");
  assert.deepEqual(understandRequirement.traceToIntentIds, ["media.intent.understand"]);
  assert.deepEqual(understandRequirement.actorRefs, ["media.creator", "media.editor", "media.reviewer"],
    "an initiating-actor decision does not rewrite the separately declared requirement actor scope");
});

test("P0-04 records delegated journey initiators without changing collaborators or operation bindings", () => {
  const base = ".product-experience/pdp-0-product-truth/";
  const journeys = readYaml(`${base}journey-catalog.yaml`).journeys;
  const decisions = readYaml(`${base}journey-actor-resolutions.yaml`).journeys;
  const contractDir = ".product-experience/pdp-3-product-experience/journey-contracts/";
  const cases = [
    ["J-06", "return-grounded-typed-consumer-results.yaml"],
    ["J-12", "animate-vector-or-procedural-scenes.yaml"],
    ["J-24", "run-cli-batch-and-review-verified-outputs.yaml"],
    ["J-30", "check-which-processing-options-are-eligible.yaml"],
  ];
  const decisionById = new Map(decisions.map((item) => [item.id, item]));
  const sourceById = new Map(journeys.map((item) => [item.id, item]));
  for (const [id, file] of cases) {
    const source = sourceById.get(id);
    const decision = decisionById.get(id);
    const contract = readYaml(`${contractDir}${file}`);
    assert.ok(source && decision, `${id} has canonical source and decision records`);
    assert.ok(source.actors.length > 1, `${id} retains multiple collaborators`);
    assert.equal(decision.actorStatus, "resolved", `${id} has an explicit Media-owner initiator decision`);
    assert.ok(source.actors.includes(decision.initiatingActorRef), `${id} selects only a source-listed actor`);
    assert.ok(decision.rationale.includes("owner selects"), `${id} explains the delegated owner choice`);
    assert.deepEqual(decision.collaboratorActorRefs, source.actors, `${id} preserves the source actor list`);
    assert.ok(contract.steps.length > 0, `${id} has an ordered contract step`);
    const step = contract.steps[0];
    const semantics = step.stepDefinitionSemantics;
    assert.ok(semantics, `${id} keeps its independent PDP-3 step definition`);
    assert.equal(step.actionRef ?? step.action ?? null, semantics.action.actionRef ?? null,
      `${id} initiator resolution does not replace the separately authored action binding`);
    assert.equal(step.canonicalOperationRef ?? null, semantics.canonicalBindings.canonicalOperationRef ?? null,
      `${id} initiator resolution does not widen or replace the exact operation binding`);
    assert.deepEqual(step.ownerActionRef ?? null, semantics.ownerActionRef ?? null,
      `${id} owner-defined action identity remains separately bound`);
    if (semantics.ownerActionRef) {
      assert.equal(semantics.operationContractBinding.operationRef, step.canonicalOperationRef,
        `${id} owner action keeps its exact operation contract`);
      assert.equal(semantics.operationContractBinding.runtimeAdmission, "NOT_ADMITTED");
    }
  }
});
