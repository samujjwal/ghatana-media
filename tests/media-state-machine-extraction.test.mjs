import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

const sourcePath = ".product-experience/pdp-0-product-truth/state-models.yaml";
const statesPath = ".product-experience/pdp-1-domain-data/states.yaml";
const transitionsPath = ".product-experience/pdp-1-domain-data/transitions.yaml";
const stateId = (state) => typeof state === "string" ? state : state?.id;

test("PDP-1 state inventory preserves the PDP-0 proposal without accepting its semantics", () => {
  const source = readYaml(sourcePath);
  const extracted = readYaml(statesPath);
  const sourceMachines = new Map(source.models.map((machine) => [machine.modelId, machine]));

  assert.equal(extracted.authorityStatus, "proposal-only; owner-review-pending; P0-010-independent-acceptance-pending");
  assert.equal(extracted.inventory.sourceMachineRecords, source.models.length);
  assert.equal(extracted.inventory.extractedMachineRecords, source.models.length);
  assert.equal(extracted.inventory.sourceStateRecords, source.models.reduce((count, machine) => count + (machine.states?.length ?? 0), 0));
  assert.equal(extracted.inventory.extractedStateRecords, extracted.stateMachines.reduce((count, machine) => count + machine.stateIds.length, 0));

  assert.deepEqual(extracted.stateMachines.map(({ machineId }) => machineId), source.models.map(({ modelId }) => modelId));
  for (const machine of extracted.stateMachines) {
    const sourceMachine = sourceMachines.get(machine.machineId);
    assert.equal(machine.sourceMachineId, sourceMachine.modelId);
    assert.equal(machine.sourceRef, `${sourcePath}#${sourceMachine.modelId}`);
    const sourceStateIds = (sourceMachine.states ?? []).map(stateId);
    assert.deepEqual(machine.stateIds, sourceStateIds, `${machine.machineId} state spelling/order drift`);
    assert.equal(machine.stateCount, sourceStateIds.length);
    assert.match(machine.meaningDisposition, /pending-owner-review|owner decision required/u);
  }
  assert.equal(extracted.inventory.sourceMachinesWithoutEnumeratedStates, source.models.filter(({ states }) => !states?.length).length);
});

test("PDP-1 transition extraction preserves every source edge and leaves guards and bindings unresolved", () => {
  const source = readYaml(sourcePath);
  const extracted = readYaml(transitionsPath);
  const sourceMachines = new Map(source.models.map((machine) => [machine.modelId, machine]));
  const expected = source.models.flatMap((machine) => (machine.transitions ?? []).map((transition, index) => ({
    machineId: machine.modelId,
    sourceTransitionIndex: index + 1,
    ...transition,
  })));

  assert.equal(extracted.authorityStatus, "proposal-only; owner-review-pending; P0-010-independent-acceptance-pending");
  assert.equal(extracted.inventory.sourceMachineRecords, source.models.length);
  assert.equal(extracted.inventory.transitionRecords, expected.length);
  assert.equal(extracted.transitionRecords.length, expected.length);

  for (const [index, transition] of extracted.transitionRecords.entries()) {
    const sourceTransition = expected[index];
    assert.equal(transition.id, `${sourceTransition.machineId}/T${String(sourceTransition.sourceTransitionIndex).padStart(2, "0")}`);
    assert.equal(transition.sourceMachineId, sourceTransition.machineId);
    assert.equal(transition.sourceTransitionIndex, sourceTransition.sourceTransitionIndex);
    assert.equal(transition.sourceRef, `${sourcePath}#${sourceTransition.machineId}`);
    assert.deepEqual(transition.from, sourceTransition.from);
    assert.deepEqual(transition.to, sourceTransition.to);
    assert.match(transition.guardDisposition, /pending-owner-review/u);
    assert.match(transition.operationBinding, /unresolved/u);
    assert.match(transition.eventTriggers, /pending-PDP1-004/u);
    assert.match(transition.permissions, /pending-owner-contracts/u);
    assert.match(transition.executionEffects, /pending-runtime-and-platform-owner-contracts/u);

    const machineStates = sourceMachines.get(sourceTransition.machineId).states;
    const stateIds = new Set((machineStates ?? []).map(stateId));
    for (const stateId of [...transition.from, ...transition.to]) {
      if (stateIds.size > 0) assert.ok(stateIds.has(stateId), `${transition.id} references a state outside ${sourceTransition.machineId}: ${stateId}`);
    }
  }
});

test("PDP-1 adapter observations point to live methods and remain unresolved projections", () => {
  const states = readYaml(statesPath);
  const adapterPath = "modules/speech/stt-service/src/main/java/com/ghatana/stt/job/AvJobLifecycleAdapter.java";
  const adapter = readFileSync(resolve(root, adapterPath), "utf8");
  const projectionMappings = states.crossSourceReconciliation.projectionMappings;
  const entries = projectionMappings.unresolvedObservedMappings;
  const sharedMapping = entries.find(({ source }) => source === `${adapterPath}#mapStatus`);
  const exactStateMarker = entries.find(({ source }) => source === `${adapterPath}#canonicalMediaState`);

  assert.equal(states.authorityStatus, "proposal-only; owner-review-pending; P0-010-independent-acceptance-pending");
  assert.deepEqual(projectionMappings.proposals, []);
  assert.ok(sharedMapping, "catalog must use the live adapter projection method anchor");
  assert.match(adapter, /private static CanonicalJobStatus mapStatus\(/u);
  assert.deepEqual(sharedMapping.observedMapping, {
    CREATED: "PENDING", QUEUED: "QUEUED", PROCESSING: "RUNNING", COMPLETED: "COMPLETED",
    FAILED: "FAILED", CANCELLED: "CANCELLED", RETRY_PENDING: "RETRYING", RETRYING: "RETRYING",
    OUTCOME_UNKNOWN: "RUNNING", RECONCILING: "RUNNING",
  });
  assert.ok(exactStateMarker, "catalog must describe the exact source-state metadata anchor");
  assert.match(adapter, /private static String canonicalMediaState\(/u);
  assert.match(adapter, /metadata\.put\("mediaCanonicalState", canonicalMediaState\(job\.status\(\)\)\)/u);
  assert.match(exactStateMarker.observedMetadata, /retains the exact .* spelling/u);
  assert.match(exactStateMarker.disposition, /does not make the shared status lossless or accept/u);
  assert.ok(!entries.some(({ source }) => source === `${adapterPath}#toCanonicalStatus`),
    "stale pre-rename method anchors must not remain catalogued");
});
