import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { validateTypedComponentContracts, validateTypedComponentInstance } from "../scripts/lib/pdp-design-composition-validator.mjs";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse, stringify } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const componentPath = ".product-experience/pdp-2-design-interface-system/component-contracts.yaml";
const auditPath = ".product-experience/pdp-2-design-interface-system/gui/reuse-audit.yaml";
const components = parse(readFileSync(resolve(root, componentPath), "utf8")).components;
const valueTypes = parse(readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/component-value-types.yaml"), "utf8"));
const audit = parse(readFileSync(resolve(root, auditPath), "utf8"));
const contractOnly = audit.publicExportInventory.unboundFamilies;

function validate(records) {
  return validateTypedComponentContracts(root, records, audit);
}

test("all 28 contract-only component families have typed, meaningful Media source definitions", () => {
  assert.equal(components.length, 31);
  assert.equal(contractOnly.length, 28);
  assert.equal(new Set(contractOnly).size, 28);
  for (const id of contractOnly) {
    const component = components.find((record) => record.id === id);
    assert.ok(component, `${id} source record exists`);
    const definition = component.typedDefinition;
    assert.ok(definition, `${id} has an owner-authored typed contract`);
    assert.ok(definition.invariants.length > 0, `${id} has material semantic invariants`);
    const fields = definition.props.slice(0, -4);
    assert.ok(fields.length > 0, `${id} has domain data fields`);
    assert.ok(fields.every((field) => field.meaning.trim() && !/^(string|object|unknown|any)$/iu.test(field.type)), `${id} uses meaningful non-generic property schemas`);
    assert.deepEqual(Object.keys(definition.inputSchema.properties), definition.props.map((field) => field.name));
  }
  assert.deepEqual(validate(components), []);
});

test("every family rejects a missing material field, an untyped field, and a missing semantic invariant", () => {
  for (const id of contractOnly) {
    const original = components.find((record) => record.id === id);
    const prefix = `${id}:`;

    const missingField = structuredClone(components);
    const target = missingField.find((record) => record.id === id);
    target.typedDefinition.props.splice(0, 1);
    delete target.typedDefinition.inputSchema.properties[original.typedDefinition.props[0].name];
    target.typedDefinition.inputSchema.required = target.typedDefinition.inputSchema.required.filter((name) => name !== original.typedDefinition.props[0].name);
    assert.ok(validate(missingField).some((error) => error.startsWith(prefix)), `${id} rejects omission of ${original.typedDefinition.props[0].name}`);

    const untypedField = structuredClone(components);
    untypedField.find((record) => record.id === id).typedDefinition.props[0].type = "unknown";
    assert.ok(validate(untypedField).some((error) => error.startsWith(prefix)), `${id} rejects an unknown field type`);

    const missingInvariant = structuredClone(components);
    missingInvariant.find((record) => record.id === id).typedDefinition.invariants = [];
    assert.ok(validate(missingInvariant).some((error) => error.startsWith(prefix)), `${id} rejects missing material invariants`);
  }
});

test("all 28 closed schemas validate positive values and reject invalid field types and contradictory state/variant pairs", () => {
  assert.deepEqual(validate(components), []);
  for (const id of contractOnly) {
    const component = components.find((record) => record.id === id);
    const definition = component.typedDefinition;
    const fixture = structuredClone(definition.positiveFixture);
    assert.deepEqual(validateTypedComponentInstance(id, fixture, root), { valid: true, errors: [] }, `${id} accepts its positive value fixture`);

    const missingMaterialValue = structuredClone(fixture);
    delete missingMaterialValue[definition.requiredDataProps[0]];
    assert.equal(validateTypedComponentInstance(id, missingMaterialValue, root).valid, false, `${id} requires ${definition.requiredDataProps[0]}`);

    const wrongType = structuredClone(fixture);
    wrongType[definition.requiredDataProps[0]] = { forged: true };
    assert.equal(validateTypedComponentInstance(id, wrongType, root).valid, false, `${id} rejects a value with the wrong type/shape`);

    const first = definition.allowedStateVariantPairs[0];
    const contradictory = definition.allowedStateVariantPairs.find((pair) => pair.state !== first.state && pair.variant !== first.variant);
    assert.ok(contradictory, `${id} has a material state/variant contradiction to test`);
    const inconsistent = { ...fixture, state: contradictory.state, variant: first.variant };
    assert.equal(validateTypedComponentInstance(id, inconsistent, root).valid, false, `${id} rejects state ${contradictory.state} with variant ${first.variant}`);
  }
});

test("identity readiness requires an exact resolved upstream context tuple", () => {
  const id = "media.component.identity-context-boundary";
  const component = components.find((record) => record.id === id);
  const fixture = structuredClone(component.typedDefinition.positiveFixture);
  fixture.requestedDestinationRef = "media.view.work-in-project";
  fixture.handoffState = "context-ready";
  assert.equal(validateTypedComponentInstance(id, fixture, root).valid, false, "handoff disposition cannot contradict the component state and variant");
  fixture.state = "context-ready";
  fixture.variant = "context-ready";
  assert.equal(validateTypedComponentInstance(id, fixture, root).valid, false, "ready cannot be asserted without request, trusted pin, result and workspace evidence");
  fixture.identityRequest = {
    action: "SELECT_CONFIRMED_WORKSPACE",
    mediaRequest: { registeredReturnRouteId: fixture.requestedDestinationRef, correlationId: "corr-1", requestedWorkspaceId: "workspace-a" },
    hostContext: { interactionNonce: "nonce-1", identityStatus: "AUTHENTICATED", principalContextRef: "principal-a", tenantContextRef: "tenant-a", adapterVerificationStatus: "HOST_ADAPTER_READY" },
  };
  const pin = { externalOwner: "ghatana-shared", externalContractRef: "shared.identity.contract", externalRevision: "rev-7", externalFingerprint: `sha256:${"a".repeat(64)}` };
  fixture.resolvedWorkspaceRef = { tenantId: "tenant-a", workspaceId: "workspace-a" };
  fixture.contextResolution = {
    request: structuredClone(fixture.identityRequest),
    result: {
      ...pin, interactionNonce: "nonce-1", outcome: "AUTHORIZED", principalContextRef: "principal-a", tenantContextRef: "tenant-a",
      requestedWorkspaceId: "workspace-a", membershipDisposition: "CURRENT_MEMBER", workspaceSelectionEvidenceRef: "membership-evidence-1",
      observedAt: "2026-10-08T11:59:00.000Z", validUntil: "2026-10-08T12:01:00.000Z", registeredReturnRouteId: fixture.requestedDestinationRef, hostAdapterVerificationStatus: "HOST_VERIFIED",
    },
    expectedOwnerPin: pin,
    evaluatedAt: "2026-10-08T12:00:00.000Z",
    evaluatorDisposition: "HOST_ADAPTER_EVIDENCE_ACCEPTABLE_FOR_CONTEXT",
  };
  const trustedEvaluation = {
    now: "2026-10-08T12:00:00.000Z",
    expectedOwnerPin: structuredClone(pin),
    registeredReturnRouteIds: ["media.view.work-in-project"],
    identityRequest: structuredClone(fixture.identityRequest),
  };
  assert.equal(validateTypedComponentInstance(id, fixture, root, trustedEvaluation).valid, true, "out-of-band trusted evaluation and exact authorized context/workspace tuple allow ready state");
  assert.equal(validateTypedComponentInstance(id, fixture, root).valid, false, "component-supplied timestamps and pins cannot establish host authority");
  const selfAssertedPin = structuredClone(fixture);
  selfAssertedPin.contextResolution.expectedOwnerPin.externalRevision = "untrusted-revision";
  assert.equal(validateTypedComponentInstance(id, selfAssertedPin, root, trustedEvaluation).valid, false, "component metadata cannot replace the out-of-band owner pin");

  const mismatchedTenant = structuredClone(fixture);
  mismatchedTenant.contextResolution.result.tenantContextRef = "tenant-b";
  assert.equal(validateTypedComponentInstance(id, mismatchedTenant, root, trustedEvaluation).valid, false, "result tenant cannot disagree with trusted request and resolved workspace");

  for (const [field, value] of [["tenantContextRef", "tenant-attacker"], ["principalContextRef", "principal-attacker"], ["interactionNonce", "nonce-attacker"]]) {
    const forgedHost = structuredClone(fixture);
    forgedHost.identityRequest.hostContext[field] = value;
    forgedHost.contextResolution.request.hostContext[field] = value;
    forgedHost.contextResolution.result[field] = value;
    assert.equal(validateTypedComponentInstance(id, forgedHost, root, trustedEvaluation).valid, false, `component cannot self-assert host ${field}`);
  }

  const stalePin = structuredClone(fixture);
  stalePin.contextResolution.result.externalRevision = "untrusted-revision";
  assert.equal(validateTypedComponentInstance(id, stalePin, root, trustedEvaluation).valid, false, "result cannot provide or change its own expected owner pin");

  const denied = structuredClone(fixture);
  denied.contextResolution.result.outcome = "DENIED";
  denied.contextResolution.result.membershipDisposition = "UNKNOWN";
  denied.contextResolution.result.workspaceSelectionEvidenceRef = null;
  denied.contextResolution.evaluatorDisposition = "DENIED";
  assert.equal(validateTypedComponentInstance(id, denied, root, trustedEvaluation).valid, false, "a denied context cannot satisfy the context-ready tuple");

  const mismatchedRequest = structuredClone(fixture);
  mismatchedRequest.contextResolution.request.mediaRequest.correlationId = "different-interaction";
  assert.equal(validateTypedComponentInstance(id, mismatchedRequest, root, trustedEvaluation).valid, false, "the evaluated request must be identical to the initiating request");

  const nonexistentRoute = structuredClone(fixture);
  nonexistentRoute.identityRequest.mediaRequest.registeredReturnRouteId = "media.route.not-registered";
  nonexistentRoute.contextResolution.request.mediaRequest.registeredReturnRouteId = "media.route.not-registered";
  nonexistentRoute.contextResolution.result.registeredReturnRouteId = "media.route.not-registered";
  assert.equal(validateTypedComponentInstance(id, nonexistentRoute, root, trustedEvaluation).valid, false, "host return route must satisfy both the current Media identity and trusted host registration policy");

  const nonexistentDestination = structuredClone(fixture);
  nonexistentDestination.requestedDestinationRef = "media.view.not-registered";
  assert.equal(validateTypedComponentInstance(id, nonexistentDestination, root, trustedEvaluation).valid, false, "destination must resolve to a canonical screen or lane-view identity");
  const unregisteredDestination = structuredClone(fixture);
  unregisteredDestination.requestedDestinationRef = "media.view.work-in-project";
  unregisteredDestination.identityRequest.mediaRequest.registeredReturnRouteId = "media.view.work-in-project";
  unregisteredDestination.contextResolution.request.mediaRequest.registeredReturnRouteId = "media.view.work-in-project";
  unregisteredDestination.contextResolution.result.registeredReturnRouteId = "media.view.work-in-project";
  assert.equal(validateTypedComponentInstance(id, unregisteredDestination, root, { ...trustedEvaluation, registeredReturnRouteIds: [] }).valid, false, "a source-known view without an out-of-band host registration is not an acceptable return route");
});

test("typed schema validators refresh when the current source bytes change", () => {
  const tempRoot = mkdtempSync(join(tmpdir(), "pdp-component-validator-cache-"));
  const sourcePaths = [componentPath, ".product-experience/pdp-2-design-interface-system/component-value-types.yaml",
    ".product-experience/pdp-1-domain-data/value-objects.yaml", ".product-experience/pdp-3-product-experience/screen-registry.yaml",
    ".product-experience/pdp-3-product-experience/action-registry.yaml", ".product-experience/pdp-0-product-truth/goals-jtbd.yaml"];
  try {
    for (const sourcePath of sourcePaths) {
      const destination = join(tempRoot, sourcePath);
      mkdirSync(join(destination, ".."), { recursive: true });
      copyFileSync(resolve(root, sourcePath), destination);
    }
    const component = components.find((record) => record.id === "media.component.identity-context-boundary");
    const fixture = structuredClone(component.typedDefinition.positiveFixture);
    assert.equal(validateTypedComponentInstance(component.id, fixture, tempRoot).valid, true, "the unmodified source fixture validates");

    const typePath = join(tempRoot, ".product-experience/pdp-2-design-interface-system/component-value-types.yaml");
    const source = parse(readFileSync(typePath, "utf8"));
    source.$defs.MediaViewRef.enum = ["media.view.changed-after-cache"];
    writeFileSync(typePath, stringify(source));
    const refreshed = validateTypedComponentInstance(component.id, fixture, tempRoot);
    assert.equal(refreshed.valid, false, "a changed canonical view type invalidates a formerly cached positive value");
    assert.match(refreshed.errors.join("\n"), /enum|must be equal/u);
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});

test("rational clock values and half-open intervals enforce exact bounded semantics", () => {
  const sourceComponent = components.find((record) => record.id === "media.component.source-player");
  const source = structuredClone(sourceComponent.typedDefinition.positiveFixture);
  assert.equal(validateTypedComponentInstance(sourceComponent.id, source, root).valid, true);
  source.sourceTime.ticks = "9223372036854775808";
  assert.equal(validateTypedComponentInstance(sourceComponent.id, source, root).valid, false, "unsafe signed-64-bit ticks fail closed");
  const zeroClock = structuredClone(sourceComponent.typedDefinition.positiveFixture);
  zeroClock.timebaseRef.secondsPerTick.numerator = "0";
  assert.equal(validateTypedComponentInstance(sourceComponent.id, zeroClock, root).valid, false, "zero clock rate is rejected by the executable exact timebase rules");
  const oversizedClock = structuredClone(sourceComponent.typedDefinition.positiveFixture);
  oversizedClock.sourceTime.ticks = "9".repeat(10000);
  assert.equal(validateTypedComponentInstance(sourceComponent.id, oversizedClock, root).valid, false, "oversized decimal strings are rejected before BigInt parsing");

  const waveform = components.find((record) => record.id === "media.component.waveform-spectrogram");
  const nullOptionalRange = structuredClone(waveform.typedDefinition.positiveFixture);
  nullOptionalRange.selectedRange = null;
  assert.equal(validateTypedComponentInstance(waveform.id, nullOptionalRange, root).valid, true, "a valid null branch does not run semantics for the non-null rational interval branch");

  const mixer = components.find((record) => record.id === "media.component.audio-mixer");
  const validMixer = structuredClone(mixer.typedDefinition.positiveFixture);
  validMixer.tracks = [{
    trackId: "track-a",
    sourceVersionRef: { tenantId: "tenant-a", artifactId: "artifact-a", versionId: "version-a" },
    channelLayout: { layoutId: "stereo", channels: ["left", "right"] },
    interval: {
      start: { clockKind: "media", clockId: "clock-a", streamId: "stream-a", ticks: "0", secondsPerTick: { numerator: "1", denominator: "48000" } },
      end: { clockKind: "media", clockId: "clock-a", streamId: "stream-a", ticks: "480", secondsPerTick: { numerator: "1", denominator: "48000" } },
    },
    gain: { value: 1, unit: "linear-amplitude", scale: "linear" },
  }];
  assert.equal(validateTypedComponentInstance(mixer.id, validMixer, root).valid, true);
  const reversed = structuredClone(validMixer);
  reversed.tracks[0].interval.end.ticks = "0";
  assert.equal(validateTypedComponentInstance(mixer.id, reversed, root).valid, false, "empty and reversed half-open intervals fail closed");
  const crossClock = structuredClone(validMixer);
  crossClock.tracks[0].interval.end.clockId = "other-clock";
  assert.equal(validateTypedComponentInstance(mixer.id, crossClock, root).valid, false, "interval endpoints cannot silently align different clocks");
  const zeroRate = structuredClone(validMixer);
  zeroRate.tracks[0].interval.start.secondsPerTick.numerator = "0";
  assert.equal(validateTypedComponentInstance(mixer.id, zeroRate, root).valid, false, "zero timebase rate is invalid");

  const storyboard = components.find((record) => record.id === "media.component.storyboard");
  const orderedScenes = structuredClone(storyboard.typedDefinition.positiveFixture);
  orderedScenes.scenes = [structuredClone(valueTypes.$defs.OrderedScene.examples[0])];
  assert.equal(validateTypedComponentInstance(storyboard.id, orderedScenes, root).valid, true);
  orderedScenes.scenes[0].sourceVersionRefs[0].tenantId = "tenant-b";
  assert.equal(validateTypedComponentInstance(storyboard.id, orderedScenes, root).valid, false, "scene source versions must share the exact scene tenant scope");

  const transitionSpecs = structuredClone(storyboard.typedDefinition.positiveFixture);
  transitionSpecs.transitionSpecs = [structuredClone(valueTypes.$defs.VersionedTransitionSpec.examples[0])];
  assert.equal(validateTypedComponentInstance(storyboard.id, transitionSpecs, root).valid, true);
  transitionSpecs.transitionSpecs[0].toSceneRef.tenantId = "tenant-b";
  assert.equal(validateTypedComponentInstance(storyboard.id, transitionSpecs, root).valid, false, "transition endpoints cannot cross tenant-scoped scene identities");

  const plan = components.find((record) => record.id === "media.component.creation-plan-summary");
  const rightsScopeMismatch = structuredClone(plan.typedDefinition.positiveFixture);
  rightsScopeMismatch.policyAndRightsEffects = [structuredClone(valueTypes.$defs.ScopedPolicyDecision.examples[0])];
  assert.equal(validateTypedComponentInstance(plan.id, rightsScopeMismatch, root).valid, true);
  rightsScopeMismatch.policyAndRightsEffects[0].scope.subjectVersionRef.tenantId = "tenant-b";
  assert.equal(validateTypedComponentInstance(plan.id, rightsScopeMismatch, root).valid, false, "subject version tenant must match the enclosing rights/consent scope");

  const artifactPicker = components.find((record) => record.id === "media.component.artifact-source-picker");
  const unknownActionRef = structuredClone(artifactPicker.typedDefinition.positiveFixture);
  unknownActionRef.selectionAction = "media.action.not-registered";
  assert.equal(validateTypedComponentInstance(artifactPicker.id, unknownActionRef, root).valid, false, "action refs absent from the current action registry are invalid");
  const unknownIntentRef = structuredClone(plan.typedDefinition.positiveFixture);
  unknownIntentRef.requestedOutcome = "media.intent.not-registered";
  assert.equal(validateTypedComponentInstance(plan.id, unknownIntentRef, root).valid, false, "canonical intents absent from PDP-0 goals-jtbd are invalid");
});

test("public-source dispositions remain distinct and are not mislabeled as typed Media contracts", () => {
  const publicSourceComponents = components.filter((record) => !contractOnly.includes(record.id));
  assert.equal(publicSourceComponents.length, 3);
  for (const component of publicSourceComponents) assert.equal(component.typedDefinition, undefined);
});
