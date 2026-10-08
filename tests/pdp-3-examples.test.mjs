import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const toolsRequire = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = toolsRequire("yaml");
const experience = ".product-experience/pdp-3-product-experience";
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const sourcePath = (path) => resolve(root, experience, path);
const assertStepBinding = (contract, actionRef, expectedOperationRef) => {
  const step = contract.steps.find((candidate) => (candidate.action ?? candidate.actionRef) === actionRef);
  assert.ok(step, `${contract.journeyId} has no step bound to ${actionRef}`);
  assert.equal(step.canonicalOperationRef, expectedOperationRef,
    `${contract.journeyId} ${actionRef} canonicalOperationRef drifted`);
  return step;
};
const assertDocumentedActionOperationIdsResolve = (doc, actionIds, operationIds) => {
  for (const [, identity, kind] of doc.matchAll(/(media\.(action|operation(?:-slice)?)\.[A-Za-z0-9._-]+)/gu)) {
    const known = kind === "action" ? actionIds.has(identity) : operationIds.has(identity);
    assert.ok(known, `documentation names stale ${kind} ${identity}`);
  }
};

const families = [
  ["Source upload, verification, and caption correction", ["J-02", "J-03"]],
  ["Versioned caption time edits", ["J-03"]],
  ["Authorized voice synthesis to approved audio", ["J-04"]],
  ["Mix/master with loudness evidence", ["J-17"]],
  ["Video repair, color, and quality comparison", ["J-08", "J-18", "J-19"]],
  ["Reviewed render and acknowledged delivery", ["J-18", "J-22"]],
  ["Scene, animation, simulation, and interchange loss", ["J-12", "J-13", "J-14", "J-15", "J-28"]],
  ["Generation from references with provenance review", ["J-10"]],
  ["Offline work and conflict reconciliation", ["J-23"]],
  ["Live session loss and reconnect", ["J-29"]],
  ["Headless CLI batch", ["J-24"]],
  ["API, SDK, and Agent bounded result", ["J-25"]],
];

test("P3-08 examples trace every named family to stable journey contracts", () => {
  const doc = readFileSync(resolve(root, "docs/EXAMPLES.md"), "utf8");
  const registry = readYaml(`${experience}/journey-registry.yaml`);
  const journeys = new Map(registry.journeys.map((journey) => [journey.id, journey]));

  assert.match(doc, /cited PDP-3 journey is source-authored but not accepted/u);
  assert.match(doc, /deterministic fixture data only/u);
  assert.match(doc, /does not meet P3-08 Done/u);

  for (const [family, requiredIds] of families) {
    const heading = `## ${family}`;
    const start = doc.indexOf(heading);
    assert.notEqual(start, -1, `missing P3-08 family ${family}`);
    const nextHeading = doc.indexOf("\n## ", start + heading.length);
    const section = doc.slice(start, nextHeading === -1 ? undefined : nextHeading);
    assert.match(section, /\*\*Status:\*\*/u, `${family} needs an availability/status statement`);
    assert.match(section, /\*\*Expected effect:\*\*/u, `${family} needs expected effects`);
    assert.match(section, /\*\*Failure\/recovery:\*\*/u, `${family} needs failure/recovery semantics`);
    assert.match(section, /\*\*Binding gap:\*\*/u, `${family} needs an explicit gap`);

    for (const id of requiredIds) {
      const journey = journeys.get(id);
      assert.ok(journey, `${family} references unknown journey ${id}`);
      assert.ok(section.includes(id), `${family} does not mention ${id}`);
      const contractPath = resolve(root, experience, journey.contract);
      assert.ok(existsSync(contractPath), `${id} contract is missing: ${journey.contract}`);
      const contract = parse(readFileSync(contractPath, "utf8"));
      assert.equal(contract.journeyId, id, `${id} contract identity mismatch`);
      assert.ok(doc.includes(`../${experience}/${journey.contract}`), `${family} must link its source contract ${journey.contract}`);
    }
  }
});

test("P3-08 examples preserve the proposal-only caption operation boundary", () => {
  const doc = readFileSync(resolve(root, "docs/EXAMPLES.md"), "utf8");
  const journey = readYaml(`${experience}/journey-contracts/transcribe-and-correct-captions.yaml`);
  const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const operationById = new Map(operations.operations.map((operation) => [operation.id, operation]));
  const stepsByAction = new Map(journey.steps.map((step) => [step.action, step]));
  const draftWrite = operationById.get("media.operation.caption-draft-write");
  const versionWrite = operationById.get("media.operation.caption-version-write");

  assert.ok(draftWrite, "PDP-1 must define the caption draft write proposal");
  assert.ok(versionWrite, "PDP-1 must define the caption version write proposal");
  assert.deepEqual(draftWrite.actionRefs, ["media.action.correct-caption", "media.action.align-caption-timing"]);
  assert.deepEqual(versionWrite.actionRefs, ["media.action.save-caption-version"]);

  for (const action of ["media.action.correct-caption", "media.action.align-caption-timing"]) {
    assert.equal(stepsByAction.get(action)?.canonicalOperationRef, draftWrite.id, `${action} must remain a draft write`);
  }
  const saveStep = stepsByAction.get("media.action.save-caption-version");
  assert.equal(saveStep?.canonicalOperationRef, versionWrite.id,
    "J-03 copies the exact PDP-1 proposal crosswalk to the save step");
  assert.equal(saveStep?.bindingStatus?.canonicalOperationRef,
    "candidate-copied-from-explicit-PDP1-action-operation-crosswalk; owner-acceptance-pending",
    "J-03 must keep the copied operation candidate pending owner acceptance");

  assert.match(doc, /media\.action\.align-caption-timing/u);
  assert.match(doc, /media\.action\.save-caption-version/u);
  assert.match(doc, /media\.operation\.caption-draft-write/u);
  assert.match(doc, /media\.operation\.caption-version-write/u);
  assert.match(doc, /J-03 copies that candidate into the\s+save step's `canonicalOperationRef` and marks owner acceptance pending/u);
  assert.match(doc, /proposal\s+candidates, not accepted behavior/su);
});

test("P3-08 journey view and screen identities resolve through the current registry", () => {
  const doc = readFileSync(resolve(root, "docs/EXAMPLES.md"), "utf8");
  const registry = readYaml(`${experience}/journey-registry.yaml`);
  const screens = readYaml(`${experience}/screen-registry.yaml`);
  const screensById = new Map([...screens.screens, ...screens.laneViews].map((screen) => [screen.id, screen]));
  const referencedIds = new Set(families.flatMap(([, ids]) => ids));

  for (const id of referencedIds) {
    const journey = registry.journeys.find((candidate) => candidate.id === id);
    assert.ok(journey, `missing current registry identity ${id}`);
    const contract = readYaml(`${experience}/${journey.contract}`);
    assert.equal(contract.journeyId, id, `${id} contract identity mismatch`);

    const viewBindings = contract.orderedViews
      ? contract.orderedViews.map((view) => ({ view }))
      : contract.steps.map((step) => ({ view: step.view, screenContractRef: step.screenContractRef }));
    assert.ok(viewBindings.length > 0, `${id} has no source-declared view identity`);
    for (const binding of viewBindings) {
      assert.ok(binding.view, `${id} has a view binding with no identity`);
      const screen = screensById.get(binding.view);
      assert.ok(screen, `${id} references stale or unknown view ${binding.view}`);
      const contractRef = binding.screenContractRef ?? screen.contract ?? screen.contractRefs?.[0];
      assert.ok(contractRef, `${id} ${binding.view} has no screen contract reference`);
      if (binding.screenContractRef) {
        assert.ok(screen.contractRefs.includes(binding.screenContractRef),
          `${id} ${binding.view} does not declare ${binding.screenContractRef}`);
      }
      assert.ok(existsSync(sourcePath(contractRef)),
        `${id} screen contract is missing: ${contractRef}`);
    }
  }

  assert.equal(screensById.has("media.view.not-a-real-view"), false,
    "negative control: stale view identifiers must not resolve");

  const liveSession = readYaml(`${experience}/journey-contracts/live-session-loss-consent-change-and-bounded-recovery.yaml`);
  assert.deepEqual(liveSession.orderedViews,
    ["media.view.work-in-project", "media.view.job-status", "media.view.review-activity"]);
  for (const view of liveSession.orderedViews) assert.ok(doc.includes(view), `J-29 trace omits ${view}`);

  const offline = readYaml(`${experience}/journey-contracts/work-locally-and-reconcile-after-reconnect.yaml`);
  const offlineViews = offline.steps.map(({ view }) => view);
  const offlineSectionStart = doc.indexOf("## Offline work and conflict reconciliation");
  const offlineSectionEnd = doc.indexOf("\n## ", offlineSectionStart + 1);
  const offlineSection = doc.slice(offlineSectionStart, offlineSectionEnd === -1 ? undefined : offlineSectionEnd);
  let previousViewIndex = -1;
  for (const view of offlineViews) {
    const viewIndex = offlineSection.indexOf(view);
    assert.notEqual(viewIndex, -1, `J-23 offline example omits source view ${view}`);
    assert.ok(viewIndex > previousViewIndex, `J-23 offline example must preserve source view order at ${view}`);
    previousViewIndex = viewIndex;
  }
  assert.deepEqual(offlineViews, [
    "media.view.work-in-project",
    "media.view.inspect-media",
    "media.view.job-status",
    "media.view.review-activity",
  ], "J-23 remains the source of the four-view proposal trace");
});

test("P3-08 documented action and operation identities are source-backed", () => {
  const doc = readFileSync(resolve(root, "docs/EXAMPLES.md"), "utf8");
  const actions = readYaml(`${experience}/action-registry.yaml`);
  const actionIds = new Set(actions.actions.map((action) => action.id));
  const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const operationsById = new Map([...operations.operations, ...operations.individualOperationContracts.records].map((operation) => [operation.id, operation]));

  const operationIds = new Set(operationsById.keys());
  assertDocumentedActionOperationIdsResolve(doc, actionIds, operationIds);
  assert.throws(() => assertDocumentedActionOperationIdsResolve("`media.action.not-in-registry`", actionIds, operationIds),
    /stale action/u, "negative control: claims without source identities must fail");
  assert.throws(() => assertDocumentedActionOperationIdsResolve("`media.operation.not-in-registry`", actionIds, operationIds),
    /stale operation/u, "negative control: claims without source identities must fail");

  const journey02 = readYaml(`${experience}/journey-contracts/upload-import-and-verify-artifact.yaml`);
  const terminalStep = journey02.steps.at(-1);
  assert.equal(terminalStep.action, "media.action.inspect-artifact");
  assert.equal(terminalStep.canonicalOperationRef, "media.operation-slice.inspect-artifact");
  assert.ok(operations.sourceDenominators.uiProductActions.exactOwnerReviewedSliceBindings[terminalStep.action] === terminalStep.canonicalOperationRef,
    "J-02 terminal action must match the PDP-1 action/operation crosswalk");
  assert.match(doc, /terminal step is `media\.action\.inspect-artifact`[\s\S]*?`media\.operation-slice\.inspect-artifact`/u);
  assert.doesNotMatch(doc, /terminal action is `media\.action\.attach-source-asset`/u,
    "an earlier J-02 action must not be misreported as its terminal action");

  const journey03 = readYaml(`${experience}/journey-contracts/transcribe-and-correct-captions.yaml`);
  assertStepBinding(journey03, "media.action.correct-caption", "media.operation.caption-draft-write");
  assertStepBinding(journey03, "media.action.align-caption-timing", "media.operation.caption-draft-write");
  const saveStep = assertStepBinding(journey03, "media.action.save-caption-version", "media.operation.caption-version-write");
  assert.equal(saveStep.bindingStatus?.canonicalOperationRef,
    "candidate-copied-from-explicit-PDP1-action-operation-crosswalk; owner-acceptance-pending");
  assert.throws(() => assertStepBinding(journey03, "media.action.save-caption-version", null),
    /canonicalOperationRef drifted/u,
    "negative control: the exact source-backed proposal must not be dropped");
  assert.match(doc, /J-03 records as a proposal candidate with owner acceptance pending/u);
});

test("P3-08 definition, implementation, qualification, license, availability, and acceptance stay distinct", () => {
  const doc = readFileSync(resolve(root, "docs/EXAMPLES.md"), "utf8");
  assert.match(doc, /`DEFINITION_ONLY`/u);
  assert.match(doc, /not runtime\s+implementation or qualification/u);
  for (const independentAxis of ["Implementation", "license admission", "qualification", "runtime availability", "owner acceptance"]) {
    assert.ok(doc.includes(independentAxis), `missing independent status axis: ${independentAxis}`);
  }

  const gapsStart = doc.indexOf("## P3-08 coverage and remaining gaps");
  const checksStart = doc.indexOf("## Local source checks", gapsStart);
  const coverage = doc.slice(gapsStart, checksStart);
  assert.match(coverage, /does not meet P3-08 Done/u);
  assert.match(coverage, /none of the examples above is an accepted\s+end-to-end capability/u);
  assert.equal(families.length, 12, "the plan enumerates twelve P3-08 families");
});
