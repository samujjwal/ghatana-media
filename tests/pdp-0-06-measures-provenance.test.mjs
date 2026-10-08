import test from "node:test";
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
  policy: ".product-experience/pdp-0-product-truth/policy-authority-model.yaml",
  nfr: ".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml",
  candidate: ".product-experience/pdp-0-product-truth/generated/product-definition.candidate.json",
};

test("P0-06 maps exact business-intent measure descriptions while keeping metric, profile, and qualification gaps open", () => {
  const goals = readYaml(paths.goals);
  const quality = readYaml(paths.quality);
  const candidate = JSON.parse(readFileSync(resolve(root, paths.candidate), "utf8"));

  assert.equal(goals.outcomes.length, 10);
  assert.equal(quality.qualityDimensions.length, 6);
  assert.equal(quality.metricDefinitions.length, 16);
  assert.equal(quality.authority, "prospective-Phase-0-policy; does not establish measurements, calibration, qualification, or runtime support");
  assert.ok(quality.qualityDimensions.every(({ capabilityRefs, capabilityRefState }) => capabilityRefs.length === 0 && /pending/u.test(capabilityRefState)));
  assert.ok(quality.metricDefinitions.every(({ capabilityRefs, capabilityRefState, calibrationState, qualificationState }) =>
    capabilityRefs.length === 0 && /pending/u.test(capabilityRefState) && /pending/u.test(calibrationState) && qualificationState === "NOT_EVALUATED"));

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
  assert.match(candidate.candidateMappingReview.fieldDispositions.successMeasures.status, /EXACT_CAPABILITY_CROSSWALK_AND_INDEPENDENT_CALIBRATION_OPEN/u);
  assert.equal(candidate.candidateMappingReview.businessIntentMeasureProposals.length, 4);
  assert.ok(candidate.candidateMappingReview.businessIntentMeasureProposals.every(({ disposition }) => /SOURCE_DEFINED_MEASUREMENT_CONTRACT/u.test(disposition)));
  const blocker = candidate.fieldMappingBlockers.find(({ field }) => field === "successMeasures");
  assert.ok(blocker, "partial direct mapping retains the unresolved P0-06 blocker");
  assert.match(blocker.reasons.join(" "), /exact outcome\/capability crosswalk and independent calibration remain open/u);
  assert.match(blocker.reasons.join(" "), /explicit unknown baseline\/target and no qualification claim/u);
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
  assert.match(profiles.integrationGaps.capabilityReferences, /pending-P0-003/u);
  assert.match(profiles.integrationGaps.profileRuntimeBindings, /pending-public-contract-license-and-qualification-evidence/u);
  assert.equal(profiles.candidateDeliveryProfiles[0].status, "candidate-not-runtime-available");

  const qualityIntent = profiles.profileAxes.find(({ name }) => name === "quality-intent");
  assert.match(qualityIntent.axisRule, /not a numeric threshold or evidence/u);
  const preservation = profiles.profileAxes.find(({ name }) => name === "preservation");
  assert.equal(preservation.qualificationPolicyMappingState, "pending-owner-schema-validation");
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
});
