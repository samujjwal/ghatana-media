import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

const capabilities = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
const requirements = readYaml(".product-experience/pdp-0-product-truth/requirements.yaml");
const nfr = readYaml(".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml");
const profiles = readYaml(".product-experience/pdp-0-product-truth/profile-semantics.yaml");
const qualification = readYaml(".product-experience/pdp-0-product-truth/qualification-policy.yaml");

const genericBoundsText =
  "Not yet enumerated; the owning profile/public contract must define units, ranges, defaults, and unsupported values before a claim of support.";

function expectedParameterMeaning(leaf) {
  const properties = Object.keys(leaf.ownerDefinition.parameterSchema.properties ?? {});
  return properties.length
    ? `P0 defines parameter fields in ownerDefinition.parameterSchema: ${properties.join(", ")}. This is a typed request-shape definition, not evidence of product support, qualification, or runtime availability; profile-specific defaults and eligibility remain separate owner decisions. Typed input meaning is defined by this leaf's P0 ownerDefinition.typedInputSlots.`
    : "P0 defines no additional parameter fields in ownerDefinition.parameterSchema; this leaf's P0 ownerDefinition.typedInputSlots carry request meaning. No additional fields are implied; support, qualification, and runtime availability remain separate decisions.";
}

function validateP0ParameterMeaning(leaf) {
  const schema = leaf.ownerDefinition?.parameterSchema;
  const slots = leaf.ownerDefinition?.typedInputSlots;
  if (!schema || schema.type !== "object" || schema.additionalProperties !== false
      || !Array.isArray(schema.required) || !schema.properties || !Array.isArray(slots) || slots.length === 0) return false;
  const propertyNames = Object.keys(schema.properties);
  if (new Set(schema.required).size !== schema.required.length
      || schema.required.some((name) => !propertyNames.includes(name))) return false;
  if (Object.hasOwn(schema, "default") || propertyNames.some((name) => {
    const property = schema.properties[name];
    return !property || typeof property.type !== "string" || Object.hasOwn(property, "default");
  })) return false;
  if ((propertyNames.length === 0) !== (schema.emptyDisposition === "NO_ADDITIONAL_PARAMETERS_REQUIRED_INPUTS_CARRY_THE_TYPED_INTENT_AND_REFERENCES")) return false;
  const slotIds = slots.map(({ slotId }) => slotId);
  if (slotIds.some((id) => !id) || new Set(slotIds).size !== slots.length) return false;
  const cardinalities = new Set(["CONDITIONALLY_ONE", "EXACTLY_ONE", "EXACTLY_ONE_OF_DECLARED_ALTERNATIVES", "ZERO_OR_ONE"]);
  if (slots.some(({ sourceType, cardinality, required, alternatives, condition }) => {
    if (!sourceType || !cardinalities.has(cardinality) || typeof required !== "boolean") return true;
    if (cardinality === "EXACTLY_ONE_OF_DECLARED_ALTERNATIVES" || alternatives !== undefined) {
      return !Array.isArray(alternatives) || alternatives.length < 2 || new Set(alternatives).size !== alternatives.length;
    }
    if (cardinality === "CONDITIONALLY_ONE") return required !== false || typeof condition !== "string" || condition.length === 0;
    return condition !== undefined;
  })) return false;
  const detailedProjectReviewMeaning = leaf.id === "media.project.review"
    && ["reviewPurpose", "reviewScope", "reviewAction"].every((name) => leaf.supportedParameters.includes(name))
    && /quality, rights, provenance, and approval/u.test(leaf.supportedParameters)
    && /comment, approve, reject, or request-changes/u.test(leaf.supportedParameters)
    && /Support, qualification, and runtime availability remain separate decisions/u.test(leaf.supportedParameters);
  if (leaf.supportedParameters !== expectedParameterMeaning(leaf) && !detailedProjectReviewMeaning) return false;
  return !/Not yet enumerated|Proposed typed request fields|Proposed fields|Proposed input|Proposed query fields|Proposed observation fields/u.test(leaf.supportedParameters);
}

test("P0-02 reconciles supportedParameters with each P0 parameter schema and typed inputs", () => {
  assert.equal(capabilities.capabilities.length, 462);

  const parameterized = capabilities.capabilities.filter(({ ownerDefinition }) =>
    Object.keys(ownerDefinition.parameterSchema.properties ?? {}).length > 0);
  const slotOnly = capabilities.capabilities.filter(({ ownerDefinition }) =>
    Object.keys(ownerDefinition.parameterSchema.properties ?? {}).length === 0);
  assert.equal(parameterized.length, 130, "P0 parameter schemas define fields for 130 leaves");
  assert.equal(slotOnly.length, 332, "332 leaves carry request meaning only in typed input slots");
  assert.ok(capabilities.capabilities.every(validateP0ParameterMeaning), "every top-level parameter description matches its P0 schema and slots");
  const slots = capabilities.capabilities.flatMap(({ ownerDefinition }) => ownerDefinition.typedInputSlots);
  const sharedShapeKey = ({ sourceType, cardinality, required, alternatives, condition }) =>
    JSON.stringify({ sourceType, cardinality, required, alternatives, condition });
  assert.equal(slots.length, 930, "all 462 leaves reconcile through their explicit input slots");
  assert.equal(new Set(slots.map(sharedShapeKey)).size, 129,
    "repeated request shapes are reusable only when all semantic slot fields match");
  const alternativeLeaf = capabilities.capabilities.find(({ ownerDefinition }) =>
    ownerDefinition.typedInputSlots.some(({ cardinality }) => cardinality === "EXACTLY_ONE_OF_DECLARED_ALTERNATIVES"));
  const brokenAlternative = structuredClone(alternativeLeaf);
  brokenAlternative.ownerDefinition.typedInputSlots.find(({ cardinality }) => cardinality === "EXACTLY_ONE_OF_DECLARED_ALTERNATIVES").alternatives = [];
  assert.equal(validateP0ParameterMeaning(brokenAlternative), false, "alternative input cardinality cannot omit its finite alternatives");
  const conditionalLeaf = capabilities.capabilities.find(({ ownerDefinition }) =>
    ownerDefinition.typedInputSlots.some(({ cardinality }) => cardinality === "CONDITIONALLY_ONE"));
  const brokenCondition = structuredClone(conditionalLeaf);
  brokenCondition.ownerDefinition.typedInputSlots.find(({ cardinality }) => cardinality === "CONDITIONALLY_ONE").condition = undefined;
  assert.equal(validateP0ParameterMeaning(brokenCondition), false, "conditional input cardinality requires its condition");
  assert.ok(capabilities.capabilities.every(({ supportedParameters }) => supportedParameters !== genericBoundsText));

  for (const leaf of capabilities.capabilities) {
    assert.equal(leaf.supportDimensions.implementationState, "UNKNOWN", `${leaf.id} implementation evidence`);
    assert.equal(leaf.supportDimensions.licenseAdmissionState, "UNKNOWN", `${leaf.id} license evidence`);
    assert.equal(leaf.supportDimensions.qualificationState, "NOT_EVALUATED", `${leaf.id} qualification evidence`);
    assert.equal(leaf.supportDimensions.runtimeAvailability, "UNKNOWN", `${leaf.id} live availability`);
  }

  const resume = capabilities.capabilities.find(({ id }) => id === "media.artifact.upload.resume");
  assert.deepEqual(resume.ownerDefinition.parameterSchema.properties, {}, "resume does not inherit upload's byte-length/media-type parameters");
  assert.deepEqual(resume.ownerDefinition.parameterSchema.required, []);
  assert.deepEqual(resume.ownerDefinition.typedInputSlots.map(({ sourceType }) => sourceType), [
    "owner-issued-uploadId", "owner-issued-resume-authority-or-session-reference", "current-workspace-identity",
  ]);

  assert.match(profiles.capabilityBoundsEnvelope.parameterRule, /other declared properties are optional/u);
  assert.match(profiles.capabilityBoundsEnvelope.parameterRule, /Defaults exist only when explicitly present in that exact schema/u);
  assert.ok(capabilities.capabilities.every(({ ownerDefinition }) =>
    !Object.hasOwn(ownerDefinition.parameterSchema, "default")
      && Object.values(ownerDefinition.parameterSchema.properties).every((property) => !Object.hasOwn(property, "default"))),
  "the current P0 schemas declare no defaults; consumers must not infer them");
});

test("P0-02 profile labels and proposed performance budgets do not become product guarantees", () => {
  assert.equal(requirements.requirements.length, 38, "family requirements are not per-leaf bounds");

  for (const requirement of requirements.requirements) {
    assert.equal(requirement.scopeStatus, "TARGET");
    assert.match(requirement.expectedBehavior, /does not substitute|unsupported/iu, `${requirement.id} rejects silent support claims`);
    assert.match(requirement.acceptanceCases[1].then, /blocked|absent|unknown/iu, `${requirement.id} fails closed on unknown qualification`);
  }

  assert.match(profiles.scopeNote, /does not select, qualify, or declare available any engine, model, codec, provider, runtime, or deployment/iu);
  assert.match(profiles.profileAxes.find(({ id }) => id === "PROFILE-AXIS-DELIVERY").axisRule, /do not imply format support or qualification/iu);
  assert.match(qualification.decisionRules.join(" "), /UNKNOWN is not AVAILABLE/iu);

  const performance = nfr.requirements.find(({ id }) => id === "NFR-PERF-001");
  assert.match(nfr.measurementRule, /proposed-budgets-are-not-observed-results-or-production-SLOs/iu);
  assert.match(performance.acceptance, /proposals-until-environment-corpus-load-method-and-owner-approval-are-recorded/iu);
  assert.ok(performance.initialProposedBudgets.every(({ environment }) => environment === "not-yet-named"));
  const resourceSafety = nfr.requirements.find(({ id }) => id === "NFR-COST-001");
  assert.match(resourceSafety.statement,
    /finite CPU, system-memory, video-memory, GPU-time, storage, network-transfer, process-count, wall-time, retry-count, and monetary bounds for each applicable dimension before dispatch/u);
  assert.match(resourceSafety.statement, /unknown or unevaluated applicable bound blocks admission/u);
  assert.match(resourceSafety.acceptance, /unknown-applicable-bound-blocks-before-dispatch/u);
  assert.match(qualification.decisionRules.join(" "), /NOT_EVALUATED bound, unit, authority, source, or enforcement boundary blocks before dispatch/u);
  assert.match(qualification.decisionRules.join(" "), /request shape and a proposed performance target do not establish a finite execution limit/u);
});

test("P0 input and output meaning has no dependency on downstream operation or wire-schema bindings", () => {
  for (const leaf of capabilities.capabilities) {
    assert.equal(validateP0ParameterMeaning(leaf), true, `${leaf.id} has closed P0 parameter and input-slot meaning`);
    assert.doesNotMatch(leaf.supportedParameters, /operations\.yaml|PDP-1|operationContractRef|boundsRef/u, `${leaf.id} does not depend on PDP-1`);
    assert.equal(Object.hasOwn(leaf.ownerDefinition, "operationRefs"), false, `${leaf.id} leaves operation selection downstream`);
    assert.equal(Object.hasOwn(leaf.ownerDefinition, "operationKind"), false, `${leaf.id} leaves command/query classification downstream`);
    assert.equal(Object.hasOwn(leaf.ownerDefinition, "operationContractRef"), false, `${leaf.id} has no concrete PDP-1 contract prerequisite`);
    assert.ok(leaf.ownerDefinition.typedInputSlots.every((slot) => !Object.hasOwn(slot, "payloadSchemaRef")), `${leaf.id} keeps P1 wire schemas outside P0 meaning`);
    assert.deepEqual(leaf.ownerDefinition.successOutputs.map(({ artifactType }) => artifactType), leaf.outputArtifactTypes,
      `${leaf.id} P0 output semantic shapes match the top-level output meaning`);
    assert.ok(leaf.ownerDefinition.successOutputs.every((output) => !Object.hasOwn(output, "payloadSchemaRef")), `${leaf.id} leaves output wire schemas downstream`);
    assert.equal(leaf.supportDimensions.implementationState, "UNKNOWN", `${leaf.id} implementation remains unknown`);
    assert.equal(leaf.supportDimensions.qualificationState, "NOT_EVALUATED", `${leaf.id} qualification remains unevaluated`);
  }
});
