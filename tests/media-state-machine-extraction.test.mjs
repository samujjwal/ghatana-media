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

function bracedBlock(source, openBrace) {
  assert.equal(source[openBrace], "{", "expected an opening brace for the bounded Java block");
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    if (source[index] === "{") depth += 1;
    if (source[index] === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, index);
    }
  }
  assert.fail("unterminated Java block while reading the allowed transition method");
}

function observedAllowedTransitions(source) {
  const signature = /private static boolean allowed\s*\(\s*StreamState\s+(\w+)\s*,\s*StreamState\s+(\w+)\s*\)\s*\{/gu;
  const matches = [...source.matchAll(signature)];
  assert.equal(matches.length, 1, "expected exactly one bounded allowed(StreamState, StreamState) method");
  const method = matches[0];
  const methodOpenBrace = method.index + method[0].lastIndexOf("{");
  const methodBody = bracedBlock(source, methodOpenBrace);
  const switchMatch = /return\s+switch\s*\(\s*(\w+)\s*\)\s*\{/u.exec(methodBody);
  assert.ok(switchMatch, "allowed method must return a StreamState switch expression");
  const switchOpenBrace = methodBody.indexOf("{", switchMatch.index);
  const switchBody = bracedBlock(methodBody, switchOpenBrace);
  const casePattern = /case\s+([A-Z][A-Z0-9_]*(?:\s*,\s*[A-Z][A-Z0-9_]*)*)\s*->/gu;
  const cases = [...switchBody.matchAll(casePattern)];
  assert.ok(cases.length > 0, "allowed switch must contain explicit state branches");
  const relations = {};
  for (const [index, branch] of cases.entries()) {
    const labels = branch[1].split(/\s*,\s*/u);
    const branchStart = branch.index + branch[0].length;
    const branchEnd = cases[index + 1]?.index ?? switchBody.length;
    const branchBody = switchBody.slice(branchStart, branchEnd);
    const targets = [...branchBody.matchAll(/StreamState\.([A-Z][A-Z0-9_]*)/gu)].map((match) => match[1]);
    if (targets.length > 0) {
      const targetParameter = method[2];
      assert.match(branchBody, new RegExp(`\\b${targetParameter}\\s*==\\s*StreamState\\.`, "u"),
        "transition targets must come from comparisons against the target parameter");
    }
    for (const label of labels) {
      assert.ok(!(label in relations), `duplicate allowed-switch branch for ${label}`);
      relations[label] = targets;
    }
  }
  const selfStateAllowed = new RegExp(
    `if\\s*\\(\\s*${method[1]}\\s*==\\s*${method[2]}\\s*\\)\\s*return\\s+true\\s*;`, "u",
  ).test(methodBody);
  return { relations, selfStateAllowed };
}

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

test("PDP-1 records runtime stream-state and store-transition observations without promoting the proposal", () => {
  const states = readYaml(statesPath);
  const observations = states.crossSourceReconciliation.projectionMappings.unresolvedObservedMappings;
  const get = (source) => observations.find((entry) => entry.source === source);
  const contractsPath = "runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java";
  const localStorePath = "launcher/src/main/java/com/ghatana/media/launcher/LocalMediaRuntimeSupport.java";
  const postgresStorePath = "providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlMediaStreamSessionStore.java";
  const runtimePath = "launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java";
  const contracts = readFileSync(resolve(root, contractsPath), "utf8");
  const localStore = readFileSync(resolve(root, localStorePath), "utf8");
  const postgresStore = readFileSync(resolve(root, postgresStorePath), "utf8");
  const runtime = readFileSync(resolve(root, runtimePath), "utf8");

  assert.equal(states.authorityStatus, "proposal-only; owner-review-pending; P0-010-independent-acceptance-pending");
  const streamStates = get(`${contractsPath}#StreamState`);
  assert.deepEqual(streamStates.values, ["OPEN", "CONNECTED", "DEGRADED", "DRAINING", "CLOSED", "FAILED"]);
  assert.match(contracts, /enum StreamState \{ OPEN, CONNECTED, DEGRADED, DRAINING, CLOSED, FAILED \}/u);
  assert.match(streamStates.disposition, /not accepted|remain unresolved/u);

  const expectedEdges = {
    OPEN: ["CONNECTED", "CLOSED", "FAILED"],
    CONNECTED: ["DEGRADED", "DRAINING", "CLOSED", "FAILED"],
    DEGRADED: ["CONNECTED", "DRAINING", "CLOSED", "FAILED"],
    DRAINING: ["CLOSED", "FAILED"],
    CLOSED: [],
    FAILED: [],
  };
  for (const [path, source] of [[localStorePath, localStore], [postgresStorePath, postgresStore]]) {
    const observed = get(`${path}#${path === localStorePath ? "StreamStore.allowed" : "allowed"}`);
    const actual = observedAllowedTransitions(source);
    assert.deepEqual(actual.relations, observed.observedTransitionRelations,
      `${path}: recorded transition relations must match the parsed Java switch branches`);
    assert.deepEqual(observed.observedTransitionRelations, expectedEdges);
    assert.match(observed.disposition, /not accepted as product transition policy/u);
    if (path === localStorePath) assert.equal(actual.selfStateAllowed, false);
    else {
      assert.equal(actual.selfStateAllowed, true);
      assert.match(observed.additionalBehavior, /same-state transition accepted before the listed edge guard/u);
    }
  }

  const closePath = get(`${runtimePath}#closeStream`);
  assert.match(runtime, /current\.state\(\) == StreamState\.OPEN\s*\|\| current\.state\(\) == StreamState\.DRAINING/u);
  assert.match(runtime, /streamStore\.transition\(current, StreamState\.DRAINING\)/u);
  assert.match(runtime, /streamStore\.transition\(closing, StreamState\.CLOSED\)/u);
  assert.match(closePath.observedPath, /OPEN closes directly/u);
  assert.match(closePath.disposition, /does not prove provider-effect finality/u);

  const proposal = readYaml(sourcePath).models.find(({ modelId }) => modelId === "media-stream-session");
  assert.deepEqual(proposal.transitions[0].to, ["CONNECTED", "DRAINING", "FAILED"]);
  assert.deepEqual(proposal.transitions[1].to, ["DEGRADED", "DRAINING", "FAILED"]);
  assert.match(get(`${localStorePath}#StreamStore.allowed`).disposition, /differs from PDP-0 proposal edges/u);
  assert.equal(observations.find(({ inventoryScope }) => inventoryScope)?.observation,
    "no delivery-state enum, delivery store, or recipient-acknowledgment state transition was found in this scope");
});
