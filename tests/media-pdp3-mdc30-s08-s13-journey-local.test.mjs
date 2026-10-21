import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const cache = new Map();
const readYaml = (path) => { if (!cache.has(path)) cache.set(path, parse(readFileSync(resolve(root, path), "utf8"))); return cache.get(path); };
const p1Path = ".product-experience/pdp-1-domain-data/operations.yaml";
const p3Path = ".product-experience/pdp-3-product-experience";
const p1 = readYaml(p1Path);
const actions = readYaml(`${p3Path}/action-registry.yaml`);
const stepOracles = readYaml(`${p3Path}/step-definition-oracles.yaml`);
const cases = [
  { file: "transcribe-and-correct-captions.yaml", stepId: "J03-2", binding: "media.pdp1.journey-operation-binding.transcribe-and-correct-captions.J03-2", action: "media.action.request-transcription", operation: "media.operation.transcription-submission" },
  { file: "transcribe-and-correct-captions.yaml", stepId: "J03-5", binding: "media.pdp1.journey-operation-binding.transcribe-and-correct-captions.J03-5", action: "media.action.correct-caption", operation: "media.operation.caption-draft-write" },
  { file: "transcribe-and-correct-captions.yaml", stepId: "J03-6", binding: "media.pdp1.journey-operation-binding.transcribe-and-correct-captions.J03-6", action: "media.action.align-caption-timing", operation: "media.operation.caption-draft-write" },
  { file: "transcribe-and-correct-captions.yaml", stepId: "J03-7", binding: "media.pdp1.journey-operation-binding.transcribe-and-correct-captions.J03-7", action: "media.action.save-caption-version", operation: "media.operation.caption-version-write" },
  { file: "translate-and-dub-existing-video.yaml", journey: "J-16", ordinal: 3, binding: "media.pdp1.journey-operation-binding.translate-and-dub-existing-video.index-2", action: "media.action.correct-caption", operation: "media.operation.caption-draft-write" },
  { file: "compose-and-render-reviewed-media.yaml", journey: "J-18", ordinal: 4, binding: "media.pdp1.journey-operation-binding.compose-and-render-reviewed-media.index-3", action: "media.action.correct-caption", operation: "media.operation.caption-draft-write" },
];

function resolveYamlRef(ref) {
  const hash = ref.indexOf("#");
  assert.notEqual(hash, -1, `source ref must be anchored: ${ref}`);
  const path = ref.slice(0, hash);
  let value = readYaml(path);
  for (const segment of ref.slice(hash + 1).split("/")) {
    if (!segment) continue;
    if (segment.startsWith("@id=")) {
      assert.ok(Array.isArray(value), `@id selector requires an array in ${ref}`);
      value = value.find((entry) => entry.id === segment.slice(4));
    } else {
      value = value?.[segment];
    }
    assert.notEqual(value, undefined, `unresolved source ref: ${ref}`);
  }
  return value;
}

for (const item of cases) {
  test(`${item.journey ?? item.stepId}: exact immediate result, branches, authority, and no-transition boundary`, () => {
    const path = `${p3Path}/journey-contracts/${item.file}`;
    const journey = readYaml(path);
    const step = journey.steps.find((candidate) => item.stepId
      ? candidate.stepId === item.stepId
      : candidate.stepDefinitionSemantics?.journeyRef === item.journey && candidate.stepDefinitionSemantics?.ordinal === item.ordinal);
    assert.ok(step, `step exists: ${item.stepId ?? `${item.journey}/${item.ordinal}`}`);
    const semantics = step.stepDefinitionSemantics;
    const binding = p1.ownerDefinedJourneyOperationBindings.records.find((entry) => entry.id === item.binding);
    assert.ok(binding, `live P1 operation binding exists: ${item.binding}`);
    assert.equal(step.action, item.action);
    assert.equal(step.canonicalOperationRef, item.operation);
    assert.equal(semantics.action.actionRef, item.action);
    assert.deepEqual(semantics.action.exactOperationRefs, [item.operation]);
    assert.equal(semantics.canonicalBindings.canonicalOperationRef, item.operation);
    assert.deepEqual(semantics.canonicalBindings.authorityRefs, binding.authorityRefs);
    assert.deepEqual(semantics.canonicalBindings.objectRefs, binding.domainObjectRefs);
    assert.deepEqual(semantics.canonicalBindings.stateRefs, []);
    assert.match(semantics.transitionApplicability.status, /NO_P1_MACHINE_TRANSITION/u);
    assert.equal(semantics.transitionApplicability.transitionRef, null);
    assert.equal(semantics.action.runtimeAdmission, "NOT_ADMITTED");
    assert.match(semantics.verification.status, /SOURCE_LINKAGE_CHECKED_BY_LOCAL_REGRESSION/u);
    assert.match(semantics.verification.status, /INDEPENDENT_REVIEW_OPEN/u);
    assert.ok(semantics.verification.requiredChecks.length > 0);
    assert.ok(semantics.verification.actualEvidence.some((entry) => entry.kind === "SOURCE_BOUND_CONTRACT_FINDING"));
    assert.ok(semantics.verification.actualEvidence.some((entry) => entry.kind === "FOCUSED_REGRESSION"));
    assert.ok(semantics.verification.sourceRefs.includes(`${p1Path}#ownerDefinedJourneyOperationBindings/records/@id=${item.binding}`));
    if (item.operation === "media.operation.caption-draft-write") assert.ok(semantics.verification.sourceRefs.includes(`${p1Path}#operations/@id=${item.operation}/idempotency`));
    for (const ref of semantics.verification.sourceRefs) {
      if (ref.startsWith(`${p1Path}#`)) assert.ok(resolveYamlRef(ref), `live P1 contract resolves: ${ref}`);
    }
    const sourceAction = actions.actions.find((entry) => entry.id === item.action);
    assert.ok(sourceAction, `P3 action exists: ${item.action}`);
    assert.ok(semantics.stepSourceFacts.success.proposal || semantics.stepSourceFacts.success.meaning);
    assert.ok(semantics.stepSourceFacts.failure.proposal);
    assert.ok(semantics.stepSourceFacts.recovery.proposal);
    assert.equal(semantics.fixtureOracle.executable, false);
    assert.equal(semantics.fixtureOracle.ownerOracleAcceptance, "pending-independent-review");
  });
}

test("J03-2 keeps accepted submission receipt distinct from job state and reconciles the same request", () => {
  const journey = readYaml(`${p3Path}/journey-contracts/transcribe-and-correct-captions.yaml`);
  const step = journey.steps.find((candidate) => candidate.stepId === "J03-2");
  const semantics = step.stepDefinitionSemantics;
  assert.match(semantics.stepSourceFacts.success.proposal, /REQUEST_ACKNOWLEDGED/u);
  assert.match(semantics.stepSourceFacts.success.proposal, /no current state or recognition result/u);
  assert.match(semantics.stepSourceFacts.failure.proposal, /IDEMPOTENCY_CONFLICT/u);
  assert.match(semantics.stepSourceFacts.failure.proposal, /UNKNOWN_OUTCOME/u);
  assert.match(semantics.stepSourceFacts.recovery.selector, /same requestId and full requestFingerprint/u);
  assert.equal(semantics.transitionApplicability.status, "NO_P1_MACHINE_TRANSITION");
});

test("J03-5 through J03-7 preserve session-local and registration boundaries", () => {
  const journey = readYaml(`${p3Path}/journey-contracts/transcribe-and-correct-captions.yaml`);
  const text = journey.steps.find((candidate) => candidate.stepId === "J03-5").stepDefinitionSemantics;
  const timing = journey.steps.find((candidate) => candidate.stepId === "J03-6").stepDefinitionSemantics;
  const save = journey.steps.find((candidate) => candidate.stepId === "J03-7").stepDefinitionSemantics;
  assert.match(text.stepSourceFacts.success.scope, /session-local/u);
  assert.match(text.stepSourceFacts.failure.proposal, /prior snapshot unchanged/u);
  assert.match(timing.stepSourceFacts.failure.proposal, /SOURCE_CLOCK_UNAVAILABLE/u);
  assert.match(timing.stepSourceFacts.failure.proposal, /CAPTION_TIMING_INVALID/u);
  assert.match(timing.stepSourceFacts.success.proposal, /half-open tick range/u);
  for (const semantics of [text, timing]) {
    assert.match(semantics.stepSourceFacts.recovery.proposal, /inspect the same active-session draft|inspect the same draftId and current draftRevision|Reinspect the same draft and exact source clock/iu);
    assert.match(semantics.stepSourceFacts.recovery.proposal, /never blindly reapply|never silently overwrite|explicit user-entered replacement values|never estimate/iu);
    assert.ok(semantics.verification.sourceRefs.includes(`${p1Path}#operations/@id=media.operation.caption-draft-write/idempotency`));
  }
  assert.match(save.stepSourceFacts.success.proposal, /captionVersionId/u);
  assert.match(save.stepSourceFacts.failure.proposal, /UNKNOWN/u);
  assert.match(save.stepSourceFacts.success.proposal, /not review approval or publication/u);
  for (const semantics of [text, timing, save]) assert.equal(semantics.action.runtimeAdmission, "NOT_ADMITTED");
});

test("J16-03 and J18-04 remain draft-only with no journey render or delivery outcome", () => {
  for (const [file, journeyRef, ordinal] of [["translate-and-dub-existing-video.yaml", "J-16", 3], ["compose-and-render-reviewed-media.yaml", "J-18", 4]]) {
    const journey = readYaml(`${p3Path}/journey-contracts/${file}`);
    const semantics = journey.steps.find((candidate) => candidate.stepDefinitionSemantics?.journeyRef === journeyRef && candidate.stepDefinitionSemantics?.ordinal === ordinal).stepDefinitionSemantics;
    const oracle = stepOracles.journeys.find((candidate) => candidate.journeyId === journeyRef).steps.find((candidate) => candidate.id === `${journeyRef}.step-${String(ordinal).padStart(2, "0")}`);
    const branchText = JSON.stringify({ success: semantics.stepSourceFacts.success, failure: semantics.stepSourceFacts.failure, recovery: semantics.stepSourceFacts.recovery, outcome: semantics.stepOutcomeSemantics });
    assert.match(branchText, /session-local/u);
    assert.equal("laterJourneyOutcomeRef" in semantics.stepSourceFacts.success, false);
    assert.doesNotMatch(branchText, /terminalSuccess|Versioned composition renders|delivered only/u);
    assert.equal(semantics.fixtureOracle.status, "NO_STEP_SCENARIO_BOUND");
    assert.deepEqual(semantics.fixtureOracle.scenarioRefs, []);
    assert.deepEqual(semantics.fixtureOracle.scenarios, []);
    assert.equal(oracle.canonicalBindings.actionRef, semantics.action.actionRef);
    assert.deepEqual(oracle.canonicalBindings.operationRefs, [semantics.canonicalBindings.canonicalOperationRef]);
    assert.deepEqual(oracle.canonicalBindings.domainObjectRefs, semantics.canonicalBindings.objectRefs);
    assert.deepEqual(oracle.canonicalBindings.requirementRefs, semantics.canonicalBindings.requirementRefs);
    assert.equal(oracle.sourceFacts.sourceRef, semantics.sourceRef);
  }
});
