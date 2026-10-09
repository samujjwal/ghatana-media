import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const path = ".product-experience/pdp-2-design-interface-system/component-contracts.yaml";
const p2ApprovalPath = "docs/implementation/verification/pdp-38/migration-coordinator-p2-review-97.json";
const p2Approval = JSON.parse(readFileSync(resolve(root, p2ApprovalPath), "utf8"));
const p2ApprovedById = new Map(p2Approval.records.map((record) => [record.claimId, record]));
const ruleId = "media.component.source-change-and-evidence-boundary.v1";
const clauses = [
  "A source relocation preserves existing behavior, identities, authority checks, and side effects",
  "new product behavior is specified as a separate change",
  "actual public boundary covers the required typed inputs, states, actions, errors, and accessibility behavior",
  "a name or visual resemblance is insufficient",
  "Safety-critical authority, denial, uncertainty, finality, and budget rules must be explicit",
  "Desired quality is a target, not a guarantee",
  "scoped qualification evidence",
];

function target(source) {
  return source.ownerDefinedComponentRules.find(({ id }) => id === ruleId);
}

function valid(source) {
  const rule = target(source);
  const obligation = source.normativeRuleRecords.find((record) => record.ruleRef.includes(ruleId));
  return Boolean(rule && clauses.every((clause) => rule.rule.includes(clause))
    && rule.negativeCases.length === 4
    && obligation?.id === "media.p2.rule.component-source-change-and-evidence-boundary.v1"
    && obligation.acceptanceEffect === "none");
}

function assertClaimReviewStatus(claim) {
  const approved = p2ApprovedById.get(claim.claimId);
  assert.equal(claim.acceptanceEffect, "none");
  if (approved) {
    assert.equal(claim.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
    assert.equal(claim.coordinatorReviewStatus, "APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE");
    assert.equal(claim.semanticReviewRef, `${p2ApprovalPath}#/records/@claimId=${claim.claimId}`);
    assert.equal(claim.targetRef, approved.currentTargetRef);
    assert.equal(claim.targetTextSha256, approved.currentTargetValueSha256);
    assert.equal(approved.acceptanceEffect, "none");
    assert.notEqual(claim.independentAcceptance, "ACCEPTED");
    assert.notEqual(claim.runtimeAdmission, "ADMITTED");
  } else {
    assert.equal(claim.semanticReviewStatus, "OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY");
    assert.equal(claim.coordinatorReviewStatus, undefined);
  }
}

test("PDP-2 source-change, reuse-boundary, safety-contract, and quality-claim requirements have separate falsifiers", () => {
  const source = readYaml(path);
  const migration = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  const claim = migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
    .flatMap((record) => record.subclaims ?? [record]).find(({ claimId }) => claimId === "MPSEM-0017-C003");
  assert.ok(claim);
  assert.match(claim.exactSourceText, /conflate source relocation with product redesign/u);
  assert.match(claim.exactSourceText, /reusable components without checking their boundaries/u);
  assert.match(claim.exactSourceText, /safety-critical contracts underspecified/u);
  assert.match(claim.exactSourceText, /desired quality as if it were guaranteed/u);
  assertClaimReviewStatus(claim);
  assert.equal(target(source).id, "media.component.source-change-and-evidence-boundary.v1",
    "the route selects the exact rule record through its real id field");
  assert.equal(valid(source), true);

  for (const clause of clauses.slice(0, 7)) {
    const weakened = structuredClone(source);
    const rule = target(weakened);
    rule.rule = rule.rule.replace(clause, "");
    assert.equal(valid(weakened), false, `weakening ${clause} invalidates this owner definition`);
  }
  const hiddenAuthority = structuredClone(source);
  hiddenAuthority.normativeRuleRecords.find((record) => record.ruleRef.includes(ruleId)).acceptanceEffect = "phase acceptance";
  assert.equal(valid(hiddenAuthority), false, "owner definition cannot self-promote to phase acceptance");
});

test("provider parameters cannot override reserved authority, budget, or routing fields", () => {
  const api = readYaml(".product-experience/pdp-2-design-interface-system/api/retry-timeout-unknown-outcome.yaml");
  const migration = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  const claim = migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
    .flatMap((record) => record.subclaims ?? [record]).find(({ claimId }) => claimId === "MPSEM-0312-C003");
  assert.ok(claim);
  assert.match(claim.exactSourceText, /Provider parameters cannot overwrite reserved authority, budget or routing policy/u);
  assertClaimReviewStatus(claim);
  const required = "provider-supplied parameters cannot override reserved tenant, principal, authorization, budget, routing, profile-version, or idempotency fields";
  const valid = (source) => source.ownerDefinedRetrySemantics?.rules.includes(required) === true
    && source.normativeRuleRecords?.some(({ ruleRef, acceptanceEffect }) => ruleRef.includes("#ownerDefinedRetrySemantics")
      && acceptanceEffect === "none");
  assert.equal(valid(api), true);
  const weakened = structuredClone(api);
  weakened.ownerDefinedRetrySemantics.rules = weakened.ownerDefinedRetrySemantics.rules.filter((rule) => rule !== required);
  assert.equal(valid(weakened), false, "removing the reserved-field rule invalidates this exact claim route");
});

test("generated API projections remain subordinate to authored contracts", () => {
  const api = readYaml(".product-experience/pdp-2-design-interface-system/api/conventions.yaml");
  const migration = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  const claims = migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
    .flatMap((record) => record.subclaims ?? [record]);
  for (const claimId of ["MPSEM-0025-C002", "MPSEM-0025-C004"]) {
    const claim = claims.find((row) => row.claimId === claimId);
    assert.ok(claim);
    assertClaimReviewStatus(claim);
  }
  assert.match(claims.find(({ claimId }) => claimId === "MPSEM-0025-C002").exactSourceText, /generated from authored sources\/overlays/u);
  assert.match(claims.find(({ claimId }) => claimId === "MPSEM-0025-C004").exactSourceText, /Never edit generated files as the primary change/u);

  const ruleId = "media.api.authored-source-projection-authority.v1";
  const rule = api.ownerDefinedProjectionRules.find(({ id }) => id === ruleId);
  const valid = (source) => {
    const selected = source.ownerDefinedProjectionRules.find(({ id }) => id === ruleId);
    return Boolean(selected?.rule.includes("only inputs to generated API/client/fixture projections")
      && selected.rule.includes("never the primary place to change semantics")
      && selected.rule.includes("cannot add an operation, field, status, authority, or finality rule")
      && source.normativeRuleRecords.some(({ ruleRef, acceptanceEffect }) => ruleRef.includes(ruleId)
        && acceptanceEffect === "none"));
  };
  assert.ok(rule);
  assert.equal(valid(api), true);
  for (const clause of [
    "only inputs to generated API/client/fixture projections",
    "never the primary place to change semantics",
    "cannot add an operation, field, status, authority, or finality rule",
  ]) {
    const weakened = structuredClone(api);
    const selected = weakened.ownerDefinedProjectionRules.find(({ id }) => id === ruleId);
    selected.rule = selected.rule.replace(clause, "generated files may define behavior");
    assert.equal(valid(weakened), false, `removing ${clause} breaks both generated-source claim routes`);
  }
});

test("UI relocation, state labels, and operation inputs preserve the owning Media contract", () => {
  const grammar = readYaml(".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml");
  const migration = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  const claims = migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
    .flatMap((record) => record.subclaims ?? [record]);
  const mappings = new Map([
    ["MPSEM-0022-C004", "media.ui.behavior-preserving-relocation.v1"],
    ["MPSEM-0029-C004", "media.ui.state-presentation-not-state-machine.v1"],
    ["MPSEM-0074-C001", "media.ui.state-presentation-not-state-machine.v1"],
    ["MPSEM-0193-C004", "media.ui.no-semantic-dummy-input.v1"],
  ]);
  for (const [claimId, ruleId] of mappings) {
    const claim = claims.find((row) => row.claimId === claimId);
    assert.ok(claim);
    assertClaimReviewStatus(claim);
    const rule = grammar.ownerDefinedStatePresentationRules.find((row) => row.id === ruleId);
    const obligation = grammar.normativeRuleRecords.find((row) => row.ruleRef.includes(ruleId));
    assert.ok(rule && obligation);
    assert.equal(obligation.acceptanceEffect, "none");
    if (claimId === "MPSEM-0022-C004") {
      assert.match(claim.exactSourceText, /behavior-preserving relocation independently of new-feature implementation/u);
      const required = ["preserves the prior behavior, identities, authorization checks, side effects, error/finality semantics, and persistence boundaries", "independently of feature additions"];
      const valid = (value) => required.every((phrase) => value.includes(phrase));
      assert.equal(valid(rule.rule), true);
      assert.equal(valid(rule.rule.replace("authorization checks", "")), false);
    } else if (claimId === "MPSEM-0029-C004" || claimId === "MPSEM-0074-C001") {
      const required = ["Brand strings, CSS classes, screen names, and localized labels never create states, transitions, finality, or scheduling policy", "Media owns state meaning, transition, scheduling, and persistence"];
      const valid = (value) => required.every((phrase) => value.includes(phrase));
      assert.equal(valid(rule.rule), true);
      assert.equal(valid(rule.rule.replace(required[1], "UI owns state meaning")), false);
    } else {
      assert.match(claim.exactSourceText, /must not require a dummy source file/u);
      const required = ["does not require a placeholder artifact, source file, or dummy input", "necessary to the selected Media operation"];
      const valid = (value) => required.every((phrase) => value.includes(phrase));
      assert.equal(valid(rule.rule), true);
      assert.equal(valid(rule.rule.replace(required[0], "requires a placeholder source file")), false);
    }
  }
});

test("async, component, licensing, and CLI claims bind to their complete owner rules", () => {
  const migration = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  const claims = migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
    .flatMap((record) => record.subclaims ?? [record]);
  const findClaim = (id) => {
    const claim = claims.find((candidate) => candidate.claimId === id);
    assert.ok(claim, `${id} remains in the migration census`);
    assertClaimReviewStatus(claim);
    return claim;
  };

  const asyncApi = readYaml(".product-experience/pdp-2-design-interface-system/api/async-operations.yaml");
  const parentChild = asyncApi.ownerDefinedAsyncRules.find(({ id }) => id === "media.async.parent-child-budget-and-cancellation-scope.v1");
  const graphClaim = findClaim("MPSEM-0034-C002");
  assert.match(graphClaim.exactSourceText, /parameters, policies and execution state in one graph/u);
  const asyncRequired = [
    "parent request identity, deadline, cancellation policy, and remaining budget propagate to each child stage",
    "child completion remains scoped to that child and does not establish parent completion",
    "A stage label or orchestration graph does not create a new job authority or lifecycle taxonomy",
  ];
  const asyncValid = (rule) => asyncRequired.every((clause) => rule?.rule.includes(clause));
  assert.equal(asyncValid(parentChild), true);
  for (const clause of asyncRequired) assert.equal(asyncValid({ ...parentChild, rule: parentChild.rule.replace(clause, "") }), false);

  const components = readYaml(".product-experience/pdp-2-design-interface-system/component-contracts.yaml");
  const repair = components.ownerDefinedComponentRules.find(({ id }) => id === "media.component.bounded-repair-loop.v1");
  const repairClaim = findClaim("MPSEM-0035-C004");
  assert.match(repairClaim.exactSourceText, /bounded repair loops/u);
  const repairRequired = ["finite per-operation bound for attempt count, elapsed time, and resource budget", "unknown outcome is reconciled before continuing", "stops the loop with an inspectable non-success"];
  const repairValid = (rule) => repairRequired.every((clause) => rule?.rule.includes(clause));
  assert.equal(repairValid(repair), true);
  for (const clause of repairRequired) assert.equal(repairValid({ ...repair, rule: repair.rule.replace(clause, "") }), false);

  const reuse = readYaml(".product-experience/pdp-0-product-truth/reuse-decisions.yaml");
  const license = reuse.mediaArchitectureRules.componentLicenseBoundary;
  const licenseClaim = findClaim("MPSEM-0040-C005");
  assert.match(licenseClaim.exactSourceText, /Process isolation does not remove license obligations/u);
  const licenseValid = (record) => record.requiredEvidence.includes("authoritative source and full distribution/build SBOM")
    && record.requiredEvidence.some((line) => line.includes("patent"))
    && record.unknownDisposition.includes("DENY_SELECTION_OR_ACQUISITION")
    && record.scopeStatus.includes("legal/security review");
  assert.equal(licenseValid(license), true);
  const withoutPatents = structuredClone(license);
  withoutPatents.requiredEvidence = withoutPatents.requiredEvidence.filter((line) => !line.includes("patent"));
  assert.equal(licenseValid(withoutPatents), false, "process isolation cannot erase patent or other license evidence obligations");

  const cli = readYaml(".product-experience/pdp-2-design-interface-system/cli-language.yaml");
  const finite = cli.ownerDefinedInvocationRules.find(({ id }) => id === "media.cli.finite-command-family-registry.v1");
  const output = cli.ownerDefinedMachineOutputRules.find(({ id }) => id === "media.cli.machine-output-exit-semantics.v1");
  assert.match(findClaim("MPSEM-0042-C003").exactSourceText, /One command registry over canonical action IDs/u);
  assert.match(findClaim("MPSEM-0042-C005").exactSourceText, /stable JSON\/JSONL, exit codes and interruption semantics/u);
  const finiteValid = (rule) => rule?.rule.includes("finite set of registered command identities")
    && rule.rule.includes("explicit; this current fixture registry has no production action bindings")
    && rule.rule.includes("cannot introduce a new command, action, operation, or permission");
  const outputValid = (rule) => rule?.rule.includes("stdout contains exactly one versioned result or error object")
    && rule.rule.includes("stable JSON keys, reason codes, command effects, or exit-code meaning")
    && rule.rule.includes("Non-TTY output remains line-oriented");
  assert.equal(finiteValid(finite), true);
  assert.equal(outputValid(output), true);
  assert.equal(finiteValid({ ...finite, rule: finite.rule.replace("finite set of registered command identities", "unbounded command identities") }), false);
  assert.equal(outputValid({ ...output, rule: output.rule.replace("stable JSON keys, reason codes, command effects, or exit-code meaning", "stable JSON keys only") }), false);
});

test("time controls reference distinct canonical media, sample, simulation, story, and wall clocks", () => {
  const grammar = readYaml(".product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml");
  const values = readYaml(".product-experience/pdp-1-domain-data/value-objects.yaml");
  const migration = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  const claim = migration.pdp38ClaimReconciliation.records.flatMap((record) => record.claims ?? [])
    .flatMap((record) => record.subclaims ?? [record]).find(({ claimId }) => claimId === "MPSEM-0033-C003");
  assert.ok(claim);
  assert.match(claim.exactSourceText, /rational media time, sample\/frame mapping, simulation time, story time, and wall-clock deadlines/u);
  assertClaimReviewStatus(claim);

  const owner = grammar.ownerDefinedClockPresentation;
  assert.equal(owner.id, "media.animation.clock-domain-presentation.v1");
  assert.equal(owner.canonicalDefinitionRefs.rationalMediaAndSimulationStoryTime,
    ".product-experience/pdp-1-domain-data/value-objects.yaml#/canonicalConversionDefinitions/records/@id=media.value.rational-media-time");
  assert.equal(owner.canonicalDefinitionRefs.sampleBoundary,
    ".product-experience/pdp-1-domain-data/value-objects.yaml#/canonicalConversionDefinitions/records/@id=media.value.sample-boundary-index");
  assert.equal(owner.canonicalDefinitionRefs.sourceFrameSampleMapping,
    ".product-experience/pdp-1-domain-data/value-objects.yaml#/ownerDescriptorDefinitions/records/@id=media.value.source-frame-sample-mapping");
  for (const ref of Object.values(owner.canonicalDefinitionRefs)) {
    const [, selector] = ref.split("#");
    const id = selector.match(/@id=([^/]+)/u)?.[1];
    const collection = selector.includes("ownerDescriptorDefinitions") ? values.ownerDescriptorDefinitions.records
      : values.canonicalConversionDefinitions.records;
    assert.ok(collection.some((record) => record.id === id), `${ref} resolves by its actual id field`);
  }
  const required = [
    "every displayed time control identifies its clock kind, clock identity, stream when applicable, units, and conversion convention",
    "cross-clock, cross-stream, timebase, frame-rate, sample-rate, and drift conversion uses the exact referenced PDP-1 definition and explicit alignment mapping; missing mapping disables conversion",
    "numeric frame-rate division cannot replace VFR frame maps or source PTS; rounded values disclose the selected rounding and loss",
    "scrubbing, pausing, or changing story presentation does not advance, reset, or mutate the simulation state",
    "an unsupported conversion preserves the source value and model and exposes the lost or unmapped feature; it never silently substitutes 24 fps, zero, or a guessed duration",
  ];
  const valid = (source) => required.every((line) => source.ownerDefinedClockPresentation.rules.includes(line))
    && typeof source.ownerDefinedClockPresentation.canonicalDefinitionRefs.sampleBoundary === "string"
    && typeof source.ownerDefinedClockPresentation.canonicalDefinitionRefs.sourceFrameSampleMapping === "string";
  assert.equal(valid(grammar), true);
  for (const phrase of required) {
    const weakened = structuredClone(grammar);
    weakened.ownerDefinedClockPresentation.rules = weakened.ownerDefinedClockPresentation.rules.filter((line) => line !== phrase);
    assert.equal(valid(weakened), false, `removing ${phrase} invalidates the clock mapping`);
  }
  const withoutSampleAuthority = structuredClone(grammar);
  delete withoutSampleAuthority.ownerDefinedClockPresentation.canonicalDefinitionRefs.sampleBoundary;
  assert.equal(valid(withoutSampleAuthority), false, "omitting canonical sample-boundary authority invalidates the route");
});
