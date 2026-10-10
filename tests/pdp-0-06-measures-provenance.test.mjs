import test from "node:test";
import { validateBusinessMeasureDefinitions } from "../scripts/lib/product-definition-domain-rule-mapping.mjs";
import { validateProductDefinitionTimestampProvenance } from "../scripts/lib/product-definition-authored-timestamp-provenance.mjs";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

const paths = {
  goals: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml",
  quality: ".product-experience/pdp-0-product-truth/quality-policy.yaml",
  profiles: ".product-experience/pdp-0-product-truth/profile-semantics.yaml",
  qualification: ".product-experience/pdp-0-product-truth/qualification-policy.yaml",
  capabilities: ".product-experience/pdp-0-product-truth/capabilities.yaml",
  policy: ".product-experience/pdp-0-product-truth/policy-authority-model.yaml",
  nfr: ".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml",
  candidate: ".product-experience/pdp-0-product-truth/generated/product-definition.candidate.json",
};

test("P0-06 projects accepted measurement definitions while keeping actual profile measurement and qualification unevaluated", () => {
  const goals = readYaml(paths.goals);
  const quality = readYaml(paths.quality);
  const candidate = JSON.parse(readFileSync(resolve(root, paths.candidate), "utf8"));

  assert.equal(goals.outcomes.length, 10);
  assert.equal(quality.qualityDimensions.length, 6);
  assert.equal(quality.metricDefinitions.length, 16);
  assert.equal(quality.authority, "prospective-Phase-0-policy; does not establish measurements, calibration, qualification, or runtime support");
  assert.ok(quality.qualityDimensions.every(({ ownerCurrentApplicability }) =>
    ownerCurrentApplicability.sourceStatus === "COMPLETE_DEFINITION_ONLY" && ownerCurrentApplicability.populationCount === 462));
  assert.ok(quality.metricDefinitions.every(({ ownerCurrentApplicability, calibrationState, qualificationState }) =>
    ownerCurrentApplicability.sourceStatus === "COMPLETE_DEFINITION_ONLY" && ownerCurrentApplicability.populationCount === 462
      && (calibrationState === "NOT_EVALUATED" || /^pending-[a-z0-9-]+-decision$/u.test(calibrationState))
      && qualificationState === "NOT_EVALUATED"));

  const measureById = new Map(candidate.candidateModel.successMeasures.map((measure) => [measure.id, measure]));
  const sourceMeasureById = new Map(goals.successMeasureContracts.records.map((measure) => [measure.id, measure]));
  assert.equal(goals.businessIntents.filter(({ measuredBy }) => measuredBy).length, 4);
  assert.equal(measureById.size, 4, "only the four source-authored business-intent measuredBy statements become proposals");
  for (const businessIntent of goals.businessIntents) {
    const measureId = `${businessIntent.id}.measure`;
    const measure = measureById.get(measureId);
    const sourceMeasure = sourceMeasureById.get(measureId);
    assert.ok(sourceMeasure, `${measureId} has an authored definition contract`);
    assert.equal(measure.description, businessIntent.measuredBy);
    assert.match(measure.metric, new RegExp(sourceMeasure.metric, "u"));
    assert.match(measure.metric, new RegExp(`unit: ${sourceMeasure.unit}`, "u"));
    assert.match(measure.metric, new RegExp(`denominator: ${sourceMeasure.denominator}`, "u"));
    assert.ok(measure.metric.includes(`applicability: ${sourceMeasure.applicability}`));
    assert.ok(measure.metric.includes(`acceptance: ${sourceMeasure.acceptanceCriterion}`));
    assert.match(measure.metric, new RegExp(`evidence: ${sourceMeasure.evidenceMethod}`, "u"));
    assert.equal(measure.baseline, sourceMeasure.baseline);
    assert.equal(measure.target, sourceMeasure.target);
    assert.equal(sourceMeasure.qualification, "NOT_EVALUATED");
    assert.equal(candidate.candidateModel.businessIntents.find(({ id }) => id === businessIntent.id).measuredBy, measureId);
  }
  assert.equal(candidate.candidateModel.successMeasures.length, sourceMeasureById.size);
  assert.match(candidate.candidateMappingReview.fieldDispositions.successMeasures.status, /4_SOURCE_DEFINED_MEASUREMENT_CONTRACTS_PROJECTED/u);
  assert.match(candidate.candidateMappingReview.fieldDispositions.successMeasures.status, /TARGET_NOT_SET/u);
  assert.match(candidate.candidateMappingReview.fieldDispositions.successMeasures.status, /BASELINE_AND_QUALIFICATION_NOT_EVALUATED/u);
  assert.match(candidate.candidateMappingReview.fieldDispositions.successMeasures.status, /OWNER_ACCEPTED_DEFINITION_SOURCE_CROSSWALK/u);
  assert.equal(candidate.candidateMappingReview.businessIntentMeasureProposals.length, 4);
  assert.ok(candidate.candidateMappingReview.businessIntentMeasureProposals.every(({ disposition }) => /SOURCE_DEFINED_MEASUREMENT_CONTRACT/u.test(disposition)));
  const blocker = candidate.fieldMappingBlockers.find(({ field }) => field === "successMeasures");
  assert.equal(blocker, undefined, "PXD-048 accepts the exact measurement definition mapping; measured admission remains unevaluated");
});

test("P0-06 defines exact outcome/capability crosswalks and deterministic profile-scoped numerators and denominators", () => {
  const goals = readYaml(paths.goals);
  const capabilities = readYaml(paths.capabilities);
  const capabilityIds = new Set(capabilities.capabilities.map(({ id }) => id));
  const outcomeIds = new Set(goals.outcomes.map(({ id }) => id));
  const profileAxisIds = new Set(readYaml(paths.profiles).profileAxes.map(({ id }) => id));

  assert.equal(goals.successMeasureContracts.records.length, 4);
  for (const measure of goals.successMeasureContracts.records) {
    assert.ok(measure.outcomeRefs.length > 0, `${measure.id} must map to an exact outcome`);
    assert.ok(measure.capabilityRefs.length > 0, `${measure.id} must map to exact capability leaves`);
    assert.ok(measure.profileAxisRefs.length > 0, `${measure.id} must declare applicable profile dimensions`);
    assert.equal(new Set(measure.outcomeRefs).size, measure.outcomeRefs.length);
    assert.equal(new Set(measure.capabilityRefs).size, measure.capabilityRefs.length);
    assert.ok(measure.outcomeRefs.every((id) => outcomeIds.has(id)), `${measure.id} has no inferred or stale outcome IDs`);
    assert.ok(measure.capabilityRefs.every((id) => capabilityIds.has(id)), `${measure.id} uses finite canonical capability leaf IDs`);
    assert.ok(measure.profileAxisRefs.every((id) => profileAxisIds.has(id)), `${measure.id} uses declared profile axes`);
    assert.match(measure.numerator, /Count /u);
    assert.match(measure.denominator, /Count /u);
    assert.match(measure.calculation, /100 \* numerator \/ denominator/u);
    assert.match(measure.calculation, /zero denominator is NOT_APPLICABLE/u);
    assert.match(measure.calculation, /NOT_EVALUATED/u);
    assert.equal(measure.valueUnit, "percent; retain raw integer numerator and denominator with each observation.");
    assert.match(measure.profileBinding, /Freeze/u);
    assert.match(measure.capabilityCrosswalkStatus, /exact-.*(?:owner-applicability|candidate-leaf)-crosswalk/u);
    assert.match(measure.capabilityCrosswalkStatus, /admitted-population-and-measurements-NOT_EVALUATED/u);
    assert.match(measure.populationEnumeration, /NOT_EVALUATED/u);
    assert.ok(measure.ownerRecommendation.length > 40);
    assert.match(measure.baseline, /^NOT_EVALUATED/u);
    assert.match(measure.target, /^NOT_SET/u);
    assert.equal(measure.qualification, "NOT_EVALUATED");
  }

  const invalid = structuredClone(goals.successMeasureContracts.records[0]);
  invalid.capabilityRefs.push("media.capability.family-wildcard");
  const validateCapabilityCrosswalk = (record) => {
    for (const id of record.capabilityRefs) assert.ok(capabilityIds.has(id), `unresolved capability leaf: ${id}`);
  };
  assert.throws(() => validateCapabilityCrosswalk(invalid), /unresolved capability leaf: media\.capability\.family-wildcard/u,
    "unknown names and family wildcards cannot silently expand a source-defined denominator");

  const outputs = goals.successMeasureContracts.records.find(({ id }) => id === "media.business.trustworthy-versioned-outputs.measure");
  assert.equal(outputs.unit, "capability-intent-profile-pair");
  assert.match(outputs.metric, /^applicable-output-capability-intent-profile-pairs/u,
    "the metric identity must describe the same unit as its denominator");
  assert.match(outputs.denominator, /output-producing capability-intent\/profile pair/u);
  assert.match(outputs.denominator, /operation identity does not gate this P0 candidate set/u);
  assert.match(outputs.applicability, /stable capability ID appears in this measure’s P0 capabilityRefs list/u);
  assert.match(outputs.numerator, /capability-intent\/profile pairs/u);
  assert.match(outputs.acceptanceCriterion, /Every applicable output contract/u);
  assert.match(outputs.acceptanceCriterion, /missing or incomplete contract keeps the pair out of the numerator/u);
  const reuse = goals.successMeasureContracts.records.find(({ id }) => id === "media.business.reuse-media-capabilities.measure");
  assert.match(reuse.denominator, /retain failed, blocked, and untested workflows/u);
  assert.match(reuse.applicability, /missing or unadmitted contract leaves the workflow in the denominator/u);
  const bounded = goals.successMeasureContracts.records.find(({ id }) => id === "media.business.bounded-provider-execution.measure");
  assert.equal(bounded.unit, "capability-intent-profile-pair");
  assert.match(bounded.metric, /^selected-capability-intent-profile-pairs/u);
  assert.match(bounded.acceptanceCriterion, /Each counted capability-intent\/profile pair/u);
  const recovery = goals.successMeasureContracts.records.find(({ id }) => id === "media.business.safe-recoverable-operations.measure");
  assert.equal(recovery.unit, "capability-intent-profile-pair");
  assert.match(recovery.metric, /^applicable-capability-intent-profile-pairs/u);
  assert.match(recovery.numerator, /every applicable downstream operation contract/u);
  assert.match(recovery.numerator, /incomplete operation inventory makes the aggregate NOT_EVALUATED/u);
  assert.match(recovery.acceptanceCriterion, /Every applicable operation bound to a counted capability-intent\/profile pair/u);
  assert.match(recovery.applicabilityRule, /stable capability ID appears in this measure’s P0 capabilityRefs list/u);
  assert.match(recovery.applicabilityRule, /does not require a completed PDP-1 operation mapping/u);
  assert.match(recovery.denominator, /safe-recovery candidate capability-intent\/profile pair/u);
});

test("P0-06 retains source-defined measurement applicability without turning it into a pass or target", () => {
  const quality = readYaml(paths.quality);
  const qualification = readYaml(paths.qualification);
  const metrics = Object.fromEntries(quality.metricDefinitions.map((metric) => [metric.id, metric]));

  assert.ok(quality.assessmentContract.requiredFields.includes("scopeAndApplicability"));
  assert.ok(quality.assessmentContract.requiredFields.includes("observationTime"));
  assert.ok(quality.assessmentContract.applicabilityStates.includes("NOT_APPLICABLE"));
  assert.ok(quality.assessmentContract.applicabilityStates.includes("ABSTAINED"));
  assert.ok(quality.assessmentContract.semantics.some((rule) => /Missing, out-of-domain, stale, or uncalibrated measurements remain unknown\/abstained/u.test(rule)));

  const temporal = metrics["QUALITY-METRIC-VIDEO-TEMPORAL-DEFECTS"];
  assert.match(temporal.applicability, /valid frame\/time mapping/u);
  assert.ok(temporal.abstainWhen.includes("time-map-missing"));
  const identity = metrics["QUALITY-METRIC-IMAGE-IDENTITY"];
  assert.match(identity.applicability, /lawful\/policy-authorized identity comparison/u);
  assert.ok(identity.abstainWhen.includes("identity-comparison-not-authorized"));
  assert.equal(identity.qualificationState, "NOT_EVALUATED");

  assert.ok(qualification.decisionRules.some((rule) => /Qualification applies to a declared leaf and scope/u.test(rule)));
  assert.ok(qualification.decisionRules.some((rule) => /Availability is profile-, tenant\/policy-, deployment-, region-, language-, format-, rights-, and time-scoped/u.test(rule)));
});

test("P0-06 profiles and proposed budgets do not claim capability availability or qualified success targets", () => {
  const profiles = readYaml(paths.profiles);
  const nfr = readYaml(paths.nfr);

  assert.equal(profiles.profileAxes.length, 6);
  assert.match(profiles.status, /proposed/u);
  assert.match(profiles.authority, /not runtime binding or qualification evidence/u);
  assert.match(profiles.scopeNote, /does not select, qualify, or declare available/u);
  assert.match(profiles.integrationGaps.capabilityReferences, /RESOLVED_FOR_462_LEAVES/u);
  assert.match(profiles.integrationGaps.profileRuntimeBindings, /concrete public-contract, license, and runtime qualification evidence remain NOT_EVALUATED/u);
  assert.equal(profiles.candidateDeliveryProfiles[0].status, "candidate-not-runtime-available");

  const qualityIntent = profiles.profileAxes.find(({ name }) => name === "quality-intent");
  assert.match(qualityIntent.axisRule, /not a numeric threshold or evidence/u);
  const preservation = profiles.profileAxes.find(({ name }) => name === "preservation");
  assert.match(preservation.qualificationPolicyMappingState, /^DEFINED;.*NOT_EVALUATED/u);
  assert.match(preservation.axisRule, /independent of quality intent and resource profile/u);
  assert.equal(profiles.fallbackSemantics.permissionFields.qualityIntentChange.permitted, false);

  const performance = nfr.requirements.find(({ id }) => id === "NFR-PERF-001");
  const serviceLevel = nfr.requirements.find(({ id }) => id === "NFR-SLO-001");
  assert.match(nfr.measurementRule, /proposed-budgets-are-not-observed-results-or-production-SLOs/u);
  assert.equal(performance.initialProposedBudgets.length, 6);
  assert.ok(performance.initialProposedBudgets.every(({ environment }) => environment === "not-yet-named"));
  assert.equal(serviceLevel.status, "open-owner-decision");
  assert.ok(nfr.openDecisions.some(({ id }) => id === "NFR-DEC-REF-ENV"));
  assert.ok(nfr.openDecisions.some(({ id }) => id === "NFR-DEC-SLO"));
});

test("P0-06 keeps privacy and locality applicability as independent policy decisions", () => {
  const policy = readYaml(paths.policy);
  const axes = new Map(policy.productPolicy.independentGovernanceAxes.map(({ axis, ...record }) => [axis, record]));

  assert.equal(policy.productPolicy.authorityStatus, "authored-proposal; pending-P0-010-independent-acceptance");
  assert.equal(axes.get("access-and-sharing").default, "private-to-authorized-context");
  assert.equal(axes.get("processing-locality").default, "no-location-claim-without-binding-and-observation");
  assert.equal(axes.get("provider-retention").default, "unknown-is-ineligible-when-no-retention-is-required");
  assert.ok(policy.productPolicy.invariants.includes("private-does-not-imply-local-processing"));
  assert.ok(policy.productPolicy.invariants.includes("local-does-not-imply-authorized-use"));
});

test("P0-06 omits authored ProductDefinition timestamps when Media has no timestamp provenance", () => {
  const candidate = JSON.parse(readFileSync(resolve(root, paths.candidate), "utf8"));

  assert.equal(Object.hasOwn(candidate.candidateModel, "createdAt"), false);
  assert.equal(Object.hasOwn(candidate.candidateModel, "updatedAt"), false);
  for (const field of ["createdAt", "updatedAt"]) {
    assert.equal(candidate.candidateFieldSources[field].sourceRef, null);
    assert.equal(candidate.candidateFieldSources[field].sourcePath, null);
    assert.match(candidate.candidateFieldSources[field].mapping, /optional authored metadata omitted intentionally/u);
  }
  assert.equal(candidate.candidateMappingReview.fieldDispositions.timestamps.status, "OPTIONAL_AUTHORED_METADATA_OMITTED_INTENTIONALLY");
  assert.match(candidate.candidateMappingReview.fieldDispositions.timestamps.source, /generation time is not authored metadata/u);
  assert.equal(validateProductDefinitionTimestampProvenance(candidate.candidateModel, candidate.candidateFieldSources, {}), true);
  const generatedTime = structuredClone(candidate.candidateModel);
  generatedTime.createdAt = new Date().toISOString();
  assert.throws(() => validateProductDefinitionTimestampProvenance(generatedTime, candidate.candidateFieldSources, {}), /no reviewed canonical authored timestamp source/u,
    "projection generation time cannot be promoted to authored ProductDefinition metadata");
  const forgedSource = structuredClone(candidate.candidateModel);
  forgedSource.updatedAt = "2026-10-09T12:00:00.000Z";
  const forgedFields = structuredClone(candidate.candidateFieldSources);
  forgedFields.updatedAt = { sourceRef: ".product-experience/pdp-0-product-truth/goals-jtbd.yaml", sourcePath: ["updatedAt"] };
  assert.throws(() => validateProductDefinitionTimestampProvenance(forgedSource, forgedFields, {
    ".product-experience/pdp-0-product-truth/goals-jtbd.yaml": { updatedAt: "2026-10-09T12:00:00.000Z" },
  }), /no reviewed canonical authored timestamp source/u,
  "a matching timestamp-shaped field is insufficient without an exact reviewed canonical source selector");
});


test("measurement projection rejects stale identity, guessed scope, empty grammar and forged qualified values", () => {
  const goals = readYaml(paths.goals), capabilities = readYaml(paths.capabilities), profiles = readYaml(paths.profiles);
  assert.equal(validateBusinessMeasureDefinitions(goals, capabilities, profiles).length, 4);
  for (const change of [
    (copy) => copy.successMeasureContracts.records.pop(),
    (copy) => { copy.successMeasureContracts.records[1].id = copy.successMeasureContracts.records[0].id; },
    (copy) => { copy.successMeasureContracts.records[0].capabilityRefs = ["media.artifact.guessed"]; },
    (copy) => { copy.successMeasureContracts.records[0].profileAxisRefs = ["PROFILE-GUESSED"]; },
    (copy) => { copy.successMeasureContracts.records[0].numerator = ""; },
    (copy) => { copy.successMeasureContracts.records[0].calculation = "numerator / denominator"; },
    (copy) => { copy.successMeasureContracts.records[0].qualification = "PASS"; },
    (copy) => { copy.successMeasureContracts.records[0].populationEnumeration = "COMPLETE"; },
  ]) { const copy = structuredClone(goals); change(copy); assert.throws(() => validateBusinessMeasureDefinitions(copy, capabilities, profiles)); }
});
