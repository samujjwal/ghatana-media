import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const read = (path) => readFileSync(resolve(root, path), "utf8");
const yaml = (path) => parse(read(path));

function exactRuleSet(source, expectedIds, requiredPhrases) {
  const byId = new Map((source.ownerDefinedProjectionRules ?? source.ownerDefinedInvocationRules ?? [])
    .map((rule) => [rule.id, rule]));
  const rules = expectedIds.map((id) => byId.get(id));
  if (rules.some((rule) => !rule || typeof rule.rule !== "string" || !rule.rule.trim())) return false;
  return rules.every((rule, index) => requiredPhrases[index].every((phrase) => rule.rule.includes(phrase)));
}

function cliMaterialRulesValid(source) {
  const groups = [source.ownerDefinedInvocationRules ?? [], source.ownerDefinedMachineOutputRules ?? []];
  const byId = new Map(groups.flat().map((rule) => [rule.id, rule]));
  const requirements = new Map([
    ["media.cli.literal-argument-boundary.v1", ["Never interpolate them into a shell command", "fixed executable plus separately passed argument values"]],
    ["media.cli.finite-command-family-registry.v1", ["finite set of registered command identities", "Wildcards, implicit aliases, or a parameter value cannot introduce"]],
    ["media.cli.machine-output-exit-semantics.v1", ["stdout contains exactly one versioned result or error object", "cannot change stable JSON keys, reason codes, command effects, or exit-code meaning"]],
    ["media.cli.wait-timeout-semantics.v1", ["A client timeout bounds observation", "does not cancel the remote job, prove failure, or authorize a blind resubmission"]],
  ]);
  return [...requirements].every(([id, clauses]) => {
    const rule = byId.get(id);
    return typeof rule?.rule === "string" && clauses.every((clause) => rule.rule.includes(clause));
  });
}

test("API projection authority keeps authored sources primary and the historical aggregate inactive", () => {
  const api = yaml(".product-experience/pdp-2-design-interface-system/api/conventions.yaml");
  const id = "media.api.authored-source-projection-authority.v1";
  const rule = api.ownerDefinedProjectionRules.find((candidate) => candidate.id === id);
  assert.ok(rule);
  assert.ok(rule.rule.includes("only inputs to generated API/client/fixture projections"));
  assert.ok(rule.rule.includes("never the primary place to change semantics"));
  assert.ok(rule.rule.includes("cannot add an operation, field, status, authority, or finality rule"));
  assert.match(rule.currentAggregateStatus, /No active aggregate service-contract\.yaml is established/u);
  assert.match(rule.currentAggregateStatus, /exact authored source and generator bindings/u);
  assert.equal(rule.scopeStatus.includes("runtime parity"), true);
  assert.deepEqual(api.normativeRuleRecords.filter(({ ruleRef }) => ruleRef.includes(id)).map(({ id: recordId }) => recordId), [
    "media.p2.rule.api-authored-source-projection-authority.v1",
  ]);

  const docs = `${read("docs/README.md")}\n${read("docs/API_DOCUMENTATION.md")}`;
  assert.match(docs, /There is no active (?:aggregate )?`?service-contract\.yaml`?/u);
  assert.equal(exactRuleSet(api, [id], [["only inputs to generated", "never the primary place"]]), true);
  const missingPrimaryRule = structuredClone(api);
  missingPrimaryRule.ownerDefinedProjectionRules[0].rule = missingPrimaryRule.ownerDefinedProjectionRules[0].rule
    .replace("never the primary place to change semantics", "a useful place to change semantics");
  assert.equal(exactRuleSet(missingPrimaryRule, [id], [["only inputs to generated", "never the primary place"]]), false,
    "removing authored-source authority cannot pass by retaining the same rule ID");
  const inventedAggregate = structuredClone(api);
  inventedAggregate.ownerDefinedProjectionRules[0].currentAggregateStatus = "service-contract.yaml is active";
  assert.equal(/No active aggregate service-contract\.yaml is established/u.test(inventedAggregate.ownerDefinedProjectionRules[0].currentAggregateStatus), false,
    "historical plan text cannot be changed into a current active-contract claim");
});

test("CLI argument and finite-family rules reject shell interpolation and implicit command expansion", () => {
  const cli = yaml(".product-experience/pdp-2-design-interface-system/cli-language.yaml");
  const literal = cli.ownerDefinedInvocationRules.find(({ id }) => id === "media.cli.literal-argument-boundary.v1");
  const finite = cli.ownerDefinedInvocationRules.find(({ id }) => id === "media.cli.finite-command-family-registry.v1");
  const output = cli.ownerDefinedMachineOutputRules.find(({ id }) => id === "media.cli.machine-output-exit-semantics.v1");
  const wait = cli.ownerDefinedMachineOutputRules.find(({ id }) => id === "media.cli.wait-timeout-semantics.v1");
  assert.ok(literal && finite && output && wait);
  assert.match(literal.rule, /Never interpolate them into a shell command/u);
  assert.match(literal.rule, /fixed executable plus separately passed argument values/u);
  assert.match(finite.rule, /finite set of registered command identities/u);
  assert.match(finite.rule, /current fixture registry has no production action bindings/u);
  assert.match(output.rule, /stdout contains exactly one versioned result or error object/u);
  assert.match(output.rule, /cannot change stable JSON keys, reason codes, command effects, or exit-code meaning/u);
  assert.match(output.rule, /Non-TTY output remains line-oriented/u);
  assert.match(wait.rule, /A client timeout bounds observation/u);
  assert.match(wait.rule, /does not cancel the remote job, prove failure, or authorize a blind resubmission/u);
  assert.match(wait.rule, /Reconciliation observes the same job\/request identity first/u);
  assert.match(finite.rule, /Wildcards, implicit aliases, or a parameter value cannot introduce a new command/u);
  assert.equal(cli.normativeRuleRecords.length >= 2, true);
  for (const rule of [literal, finite, output, wait]) {
    const record = cli.normativeRuleRecords.find(({ ruleRef }) => ruleRef.includes(rule.id));
    assert.ok(record, `${rule.id} has a stable normative obligation record`);
    assert.equal(record.acceptanceEffect, "none");
  }

  const commands = yaml(".product-experience/pdp-3-product-experience/cli/command-registry.yaml").commands;
  const commandIds = new Set(commands.map(({ id }) => id));
  assert.equal(commandIds.size, commands.length, "the source command registry is finite and unique");
  const registryMutation = structuredClone(commands);
  registryMutation.push({ id: "media.cli.unregistered.*", actionRef: "media.action.unregistered" });
  const finiteRegistryValid = (rows) => rows.every(({ id }) => typeof id === "string"
    && !id.includes("*") && commandIds.has(id));
  assert.equal(finiteRegistryValid(commands), true);
  assert.equal(finiteRegistryValid(registryMutation), false,
    "a wildcard command or action cannot be added merely by extending a family name");
  assert.equal(cliMaterialRulesValid(cli), true);
  const weakened = structuredClone(cli);
  weakened.ownerDefinedInvocationRules[0].rule = weakened.ownerDefinedInvocationRules[0].rule.replace(
    "Never interpolate them into a shell command", "Interpolate them into a shell command",
  );
  assert.equal(cliMaterialRulesValid(weakened), false, "shell interpolation prohibition is a material source requirement");
  const weakenedOutput = structuredClone(cli);
  weakenedOutput.ownerDefinedMachineOutputRules[0].rule = weakenedOutput.ownerDefinedMachineOutputRules[0].rule
    .replace("stdout contains exactly one versioned result or error object", "stdout may contain progress before a result object");
  assert.equal(cliMaterialRulesValid(weakenedOutput), false, "JSON stdout framing is a material source requirement");
  const weakenedWait = structuredClone(cli);
  weakenedWait.ownerDefinedMachineOutputRules[1].rule = weakenedWait.ownerDefinedMachineOutputRules[1].rule
    .replace("does not cancel the remote job, prove failure, or authorize a blind resubmission", "cancels the remote job and permits a new request");
  assert.equal(cliMaterialRulesValid(weakenedWait), false, "client wait cancellation cannot be confused with server cancellation");
  const weakenedRegistryRule = structuredClone(cli);
  weakenedRegistryRule.ownerDefinedInvocationRules[1].rule = weakenedRegistryRule.ownerDefinedInvocationRules[1].rule
    .replace("Wildcards, implicit aliases, or a parameter value cannot introduce", "Wildcards or parameters may introduce");
  assert.equal(cliMaterialRulesValid(weakenedRegistryRule), false, "command membership cannot expand by string substitution");
});

test("API retry and timeout definitions preserve request identity, authority, and effect finality", () => {
  const api = yaml(".product-experience/pdp-2-design-interface-system/api/retry-timeout-unknown-outcome.yaml");
  const rule = api.ownerDefinedRetrySemantics;
  const required = [
    "read-only observation before considering any resubmission",
    "never mint a new request identity",
    "persisted idempotency key and exact canonical request fingerprint",
    "current authority, rights/consent, budget, profile, and dependency checks still pass",
    "does not cancel server work, establish failure, or prove provider finality",
    "cancellation request, cancellation acknowledgement, confirmed cancellation",
    "cannot override reserved tenant, principal, authorization, budget, routing, profile-version, or idempotency fields",
  ];
  const valid = (source) => {
    const candidate = source.ownerDefinedRetrySemantics;
    return candidate?.id === "media.api.retry-timeout-unknown-outcome.v1"
      && required.every((phrase) => candidate.rules.join(" ").includes(phrase))
      && candidate.runtimeAdmission === "NOT_ADMITTED"
      && source.normativeRuleRecords?.some((record) => record.id === "media.p2.rule.api-retry-timeout-unknown-outcome.v1"
        && record.acceptanceEffect === "none");
  };
  assert.equal(valid(api), true);
  for (const phrase of [required[0], required[2], required[4], required[5], required[6]]) {
    const weakened = structuredClone(api);
    weakened.ownerDefinedRetrySemantics.rules = weakened.ownerDefinedRetrySemantics.rules
      .map((line) => line.replace(phrase, "a retry may use a new request identity and assume completion"));
    assert.equal(valid(weakened), false, `removing ${phrase} must invalidate the Media owner rule`);
  }
});

test("PXD-100 has the only approved status for its exact 97-row PDP-2 migration cohort", () => {
  const approvalPath = "docs/implementation/verification/pdp-38/migration-coordinator-p2-review-97.json";
  const approval = JSON.parse(read(approvalPath));
  const migration = yaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml").pdp38ClaimReconciliation;
  const leaves = migration.records.flatMap(({ claims }) => claims ?? []).flatMap((claim) => claim.subclaims ?? [claim]);
  const leafById = new Map(leaves.map((claim) => [claim.claimId, claim]));
  assert.equal(approval.decisionRef, ".product-experience/decision-log.md#PXD-100");
  assert.equal(approval.records.length, 97);
  assert.equal(new Set(approval.records.map(({ claimId }) => claimId)).size, 97);
  for (const row of approval.records) {
    const current = leafById.get(row.claimId);
    assert.ok(current, `${row.claimId} remains in the migration ledger`);
    assert.equal(row.reviewStatus, "APPROVED_BOUNDED_SOURCE_SEMANTIC_ROUTE");
    assert.equal(row.acceptanceEffect, "none");
    assert.equal(current.semanticReviewStatus, "CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED");
    assert.equal(current.coordinatorReviewStatus, "APPROVED_BOUNDED_OWNER_SOURCE_SEMANTIC_ROUTE");
    assert.equal(current.semanticReviewRef, `${approvalPath}#/records/@claimId=${row.claimId}`);
    assert.equal(current.targetRef, row.currentTargetRef);
    assert.equal(current.targetTextSha256, row.currentTargetValueSha256);
    assert.equal(current.acceptanceEffect, "none");
    assert.notEqual(current.independentAcceptance, "ACCEPTED");
    assert.notEqual(current.runtimeAdmission, "ADMITTED");
  }
});

test("API idempotency and cancellation reuse exact operation identity without implying durability or finality", () => {
  const idempotency = yaml(".product-experience/pdp-2-design-interface-system/api/idempotency.yaml");
  const cancellation = yaml(".product-experience/pdp-2-design-interface-system/api/cancellation.yaml");
  const operations = yaml(".product-experience/pdp-1-domain-data/operations.yaml");
  const states = yaml(".product-experience/pdp-1-domain-data/states.yaml");
  const cancellationRule = cancellation.ownerDefinedCancellationSemantics;
  const validIdempotency = (source) => {
    const rule = source.ownerDefinedIdempotencySemantics;
    return rule?.id === "media.api.idempotency-identity.v1"
      && rule.identityTuple.join("|") === "trustedTenantId|trustedPrincipalIdWhenOperationScoped|exactCanonicalOperationId|operationVersion|clientRequestKey|canonicalValidatedRequestFingerprint"
      && rule.rules.some((line) => line.includes("matching key and fingerprint") && line.includes("without a second effect"))
      && rule.rules.some((line) => line.includes("creates no durable store, replay window, or automatic retry"))
      && source.normativeRuleRecords?.some((record) => record.id === "media.p2.rule.api-idempotency-identity.v1" && record.acceptanceEffect === "none");
  };
  const validCancellation = (source) => {
    const rule = source.ownerDefinedCancellationSemantics;
    return rule?.id === "media.api.cancellation-request-finality.v1"
      && rule.canonicalOperationRef === "media.operation-slice.cancel-job"
      && rule.canonicalStateAuthority === ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-job"
      && rule.rules.some((line) => line.includes("request persistence does not mean any worker/provider stopped"))
      && rule.rules.some((line) => line.includes("confirmed cancellation requires authoritative evidence"))
      && rule.rules.some((line) => line.includes("does not issue a server cancellation request"))
      && rule.rules.some((line) => line.includes("retain the canonical job/attempt states and finality vocabulary"))
      && source.normativeRuleRecords?.some((record) => record.id === "media.p2.rule.api-cancellation-request-finality.v1" && record.acceptanceEffect === "none");
  };
  assert.equal(validIdempotency(idempotency), true);
  assert.equal(validCancellation(cancellation), true);
  assert.equal(operations.individualOperationContracts.records.some(({ id }) => id === cancellationRule.canonicalOperationRef), true);
  assert.equal(states.stateMachines.some(({ machineId }) => machineId === "media-job"), true);

  const idempotencyWithoutScope = structuredClone(idempotency);
  idempotencyWithoutScope.ownerDefinedIdempotencySemantics.identityTuple = ["clientRequestKey"];
  assert.equal(validIdempotency(idempotencyWithoutScope), false, "untrusted client key alone cannot define mutation identity");
  const idempotencyWithoutReplay = structuredClone(idempotency);
  idempotencyWithoutReplay.ownerDefinedIdempotencySemantics.rules = idempotencyWithoutReplay.ownerDefinedIdempotencySemantics.rules
    .map((line) => line.replace("without a second effect", "and repeat the effect"));
  assert.equal(validIdempotency(idempotencyWithoutReplay), false, "same-key replay cannot repeat a completed effect");
  const cancellationWithFalseFinality = structuredClone(cancellation);
  cancellationWithFalseFinality.ownerDefinedCancellationSemantics.rules = cancellationWithFalseFinality.ownerDefinedCancellationSemantics.rules
    .map((line) => line.replace("request persistence does not mean any worker/provider stopped", "request persistence means the provider stopped"));
  assert.equal(validCancellation(cancellationWithFalseFinality), false, "request acceptance is not stop/finality evidence");
  const cancellationWithNewTaxonomy = structuredClone(cancellation);
  cancellationWithNewTaxonomy.ownerDefinedCancellationSemantics.rules = cancellationWithNewTaxonomy.ownerDefinedCancellationSemantics.rules
    .map((line) => line.replace("retain the canonical job/attempt states and finality vocabulary", "invent a transport-specific job state and finality vocabulary"));
  assert.equal(validCancellation(cancellationWithNewTaxonomy), false, "transport cannot fork the canonical state/finality taxonomy");
});

test("Media state presentation, non-dummy input, and behavior-preserving relocation have explicit source rules", () => {
  const grammar = yaml(".product-experience/pdp-2-design-interface-system/semantic-state-grammar.yaml");
  const states = yaml(".product-experience/pdp-1-domain-data/states.yaml");
  const rules = grammar.ownerDefinedStatePresentationRules;
  const byId = new Map(rules.map((rule) => [rule.id, rule]));
  const requirements = new Map([
    ["media.ui.state-presentation-not-state-machine.v1", ["Brand strings, CSS classes, screen names, and localized labels never create states", "Media owns state meaning, transition, scheduling, and persistence"]],
    ["media.ui.no-semantic-dummy-input.v1", ["does not require a placeholder artifact, source file, or dummy input", "necessary to the selected Media operation"]],
    ["media.ui.behavior-preserving-relocation.v1", ["preserves the prior behavior, identities, authorization checks, side effects", "independently of feature additions"]],
  ]);
  const valid = (source) => [...requirements].every(([id, clauses]) => {
    const rule = source.ownerDefinedStatePresentationRules.find((candidate) => candidate.id === id);
    const normative = source.normativeRuleRecords.find((record) => record.ruleRef.includes(id));
    return rule && clauses.every((clause) => rule.rule.includes(clause)) && normative?.acceptanceEffect === "none";
  });
  assert.equal(valid(grammar), true);
  for (const display of grammar.states) {
    const machine = [...states.stateMachines].sort((a, b) => b.machineId.length - a.machineId.length)
      .find((candidate) => display.stateRef.startsWith(`${candidate.machineId}.`));
    assert.ok(machine, `${display.stateRef} identifies an owner state machine`);
    const suffix = display.stateRef.slice(machine.machineId.length + 1).split(".");
    const definitions = suffix.length > 1
      ? machine.stateDefinitionsByDimension?.[suffix[0]] ?? []
      : machine.stateDefinitions ?? [];
    assert.ok(definitions.some(({ id }) => id === suffix.at(-1)), `${display.stateRef} resolves to the exact owner state`);
    const stateId = suffix.at(-1);
    assert.notEqual(display.label, stateId, `${display.label} remains a display string, not a state identity`);
  }
  assert.equal(new Set(requirements.keys()).size, rules.length);
  assert.ok(byId.get("media.ui.no-semantic-dummy-input.v1").negativeCases.some((line) => line.includes("dummy file")));
  const withoutBrandBoundary = structuredClone(grammar);
  withoutBrandBoundary.ownerDefinedStatePresentationRules[0].rule = withoutBrandBoundary.ownerDefinedStatePresentationRules[0].rule
    .replace("Brand strings, CSS classes, screen names, and localized labels never create states", "Brand labels create states");
  assert.equal(valid(withoutBrandBoundary), false, "brand labels cannot become a parallel state machine");
  const withDummySource = structuredClone(grammar);
  withDummySource.ownerDefinedStatePresentationRules[1].rule = withDummySource.ownerDefinedStatePresentationRules[1].rule
    .replace("does not require a placeholder artifact, source file, or dummy input", "requires a placeholder artifact, source file, or dummy input");
  assert.equal(valid(withDummySource), false, "transport shape cannot create a semantically irrelevant required input");
  const featureAsRelocation = structuredClone(grammar);
  featureAsRelocation.ownerDefinedStatePresentationRules[2].rule = featureAsRelocation.ownerDefinedStatePresentationRules[2].rule
    .replace("independently of feature additions", "as a result of feature additions");
  assert.equal(valid(featureAsRelocation), false, "new feature implementation does not establish relocation parity");
});

test("animation and simulation presentation use canonical time domains without implicit synchronization", () => {
  const grammar = yaml(".product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml");
  const values = yaml(".product-experience/pdp-1-domain-data/value-objects.yaml");
  const rule = grammar.ownerDefinedClockPresentation;
  const references = Object.values(rule.canonicalDefinitionRefs);
  const ruleText = rule.rules.join(" ");
  const valid = (source) => {
    const candidate = source.ownerDefinedClockPresentation;
    const text = candidate.rules.join(" ");
    return candidate.id === "media.animation.clock-domain-presentation.v1"
      && candidate.canonicalDefinitionRefs.rationalMediaAndSimulationStoryTime.includes("media.value.rational-media-time")
      && candidate.canonicalDefinitionRefs.sampleBoundary.includes("media.value.sample-boundary-index")
      && candidate.canonicalDefinitionRefs.sourceFrameSampleMapping.includes("media.value.source-frame-sample-mapping")
      && text.includes("cross-clock, cross-stream, timebase, frame-rate, sample-rate, and drift conversion")
      && text.includes("scrubbing, pausing, or changing story presentation does not advance, reset, or mutate the simulation state")
      && text.includes("numeric frame-rate division cannot replace VFR frame maps or source PTS")
      && source.normativeRuleRecords.some((record) => record.id === "media.p2.rule.animation-clock-domain-presentation.v1" && record.acceptanceEffect === "none");
  };
  const conversionIds = new Set(values.canonicalConversionDefinitions.records.map(({ id }) => id));
  const descriptorIds = new Set(values.ownerDescriptorDefinitions.records.map(({ id }) => id));
  assert.equal(conversionIds.has("media.value.rational-media-time"), true);
  assert.equal(conversionIds.has("media.value.sample-boundary-index"), true);
  assert.equal(descriptorIds.has("media.value.source-frame-sample-mapping"), true);
  assert.ok(rule.clockRoles.mediaPresentation.includes("VFR uses retained frame mapping"));
  assert.ok(rule.clockRoles.wallClock.includes("never used as a media-frame or simulation-step count"));
  assert.equal(rule.scopeStatus.includes("NOT_EVALUATED"), true);
  assert.equal(references.length, 3);
  assert.match(ruleText, /scrubbing/u);
  assert.equal(valid(grammar), true);

  const implicitRate = structuredClone(grammar);
  implicitRate.ownerDefinedClockPresentation.rules = implicitRate.ownerDefinedClockPresentation.rules
    .map((line) => line.replace("numeric frame-rate division cannot replace VFR frame maps or source PTS", "divide by nominal frame rate to convert every timestamp"));
  assert.equal(valid(implicitRate), false, "VFR source mapping cannot be replaced by nominal-rate arithmetic");
  const scrubAdvances = structuredClone(grammar);
  scrubAdvances.ownerDefinedClockPresentation.rules = scrubAdvances.ownerDefinedClockPresentation.rules
    .map((line) => line.replace("does not advance, reset, or mutate the simulation state", "advances the simulation state"));
  assert.equal(valid(scrubAdvances), false, "presentation controls cannot mutate simulation time or state");
});

test("all ten reusable component behavior rules preserve bounds, safety, and effect scope", () => {
  const sourcePath = ".product-experience/pdp-2-design-interface-system/component-contracts.yaml";
  const source = yaml(sourcePath);
  const requiredById = new Map([
    ["media.component.bounded-repair-loop.v1", "finite per-operation bound for attempt count, elapsed time, and resource budget"],
    ["media.component.erasure-retention-provenance.v1", "Immutable output versions and provenance do not require retaining source media or personal content forever"],
    ["media.component.navigation-and-safety-visibility.v1", "keeping the current location, primary task navigation, Cancel, Undo"],
    ["media.component.typed-parameter-boundaries.v1", "finite declared type, unit when dimensional, accepted range or finite enum"],
    ["media.component.risk-bounded-analysis-selection.v1", "selects only operations eligible for the exact source, purpose, rights, profile, and budget"],
    ["media.component.acceptance-after-durable-identity.v1", "stable tenant/principal-scoped identity and durable owner receipt before acceptance"],
    ["media.component.contextual-workspace-navigation.v1", "Section visibility is not a permission grant"],
    ["media.component.undo-redo-effect-boundary.v1", "They never reverse a published delivery, external provider effect, consent decision"],
    ["media.component.source-change-and-evidence-boundary.v1", "A source relocation preserves existing behavior, identities, authority checks, and side effects"],
    ["media.component.upstream-owner-source-first.v1", "route the requirement to the authoritative source phase and correct that source first"],
  ]);
  const valid = (candidate) => {
    const rules = candidate.ownerDefinedComponentRules;
    const records = candidate.normativeRuleRecords;
    if (rules.length < requiredById.size || records.length < requiredById.size) return false;
    const byId = new Map(rules.map((rule) => [rule.id, rule]));
    const baseRules = [...requiredById].every(([id, phrase]) => {
      const rule = byId.get(id);
      const normative = records.find((record) => record.ruleRef.includes(id));
      return rule?.rule.includes(phrase) && normative?.acceptanceEffect === "none";
    });
    const sourceChange = byId.get("media.component.source-change-and-evidence-boundary.v1")?.rule ?? "";
    return baseRules && [
      "A source relocation preserves existing behavior, identities, authority checks, and side effects",
      "Reuse a component only when its actual public boundary covers the required typed inputs, states, actions, errors, and accessibility behavior",
      "a name or visual resemblance is insufficient",
      "Safety-critical authority, denial, uncertainty, finality, and budget rules must be explicit before the affected action is available",
      "Desired quality is a target, not a guarantee",
      "claims of achieved quality require scoped qualification evidence",
    ].every((clause) => sourceChange.includes(clause));
  };
  assert.equal(valid(source), true);
  const sourceChange = source.ownerDefinedComponentRules.find(({ id }) => id === "media.component.source-change-and-evidence-boundary.v1");
  for (const clause of [
    "Reuse a component only when its actual public boundary covers the required typed inputs, states, actions, errors, and accessibility behavior",
    "a name or visual resemblance is insufficient",
    "Safety-critical authority, denial, uncertainty, finality, and budget rules must be explicit before the affected action is available",
    "Desired quality is a target, not a guarantee",
    "claims of achieved quality require scoped qualification evidence",
  ]) assert.ok(sourceChange.rule.includes(clause), `source-change rule retains ${clause}`);
  for (const record of source.normativeRuleRecords) {
    const ownerPath = record.sourceAuthority.split("#")[0];
    assert.ok(existsSync(resolve(root, ownerPath)), `normative authority exists: ${record.sourceAuthority}`);
    assert.ok(record.ruleRef.startsWith(`${sourcePath}#`));
  }
  for (const [index, [id, phrase]] of [...requiredById].entries()) {
    const weakened = structuredClone(source);
    const rule = weakened.ownerDefinedComponentRules.find((candidate) => candidate.id === id);
    rule.rule = rule.rule.replace(phrase, `the rule does not require the ${id} boundary`);
    assert.equal(valid(weakened), false, `material component rule ${index + 1} cannot be weakened while retaining its identity`);
  }
  for (const clause of [
    "a name or visual resemblance is insufficient",
    "authority, denial, uncertainty, finality, and budget rules must be explicit",
    "Desired quality is a target, not a guarantee",
    "claims of achieved quality require scoped qualification evidence",
  ]) {
    const weakened = structuredClone(source);
    const rule = weakened.ownerDefinedComponentRules.find(({ id }) => id === "media.component.source-change-and-evidence-boundary.v1");
    rule.rule = rule.rule.replace(clause, "the removed condition is optional");
    assert.equal(valid(weakened), false, "source-change rule cannot lose a material limitation while retaining the same identity");
    assert.equal(weakened.ownerDefinedComponentRules.find(({ id }) => id === "media.component.source-change-and-evidence-boundary.v1").rule.includes(clause), false);
  }
});
