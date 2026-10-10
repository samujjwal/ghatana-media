import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const profileSemantics = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/profile-semantics.yaml"), "utf8"));
const capabilities = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capabilities.yaml"), "utf8"));
const handoff = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/handoff-contracts.yaml"), "utf8"));
const capabilityLeafReview = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml"), "utf8"));
const nfr = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml"), "utf8"));
const qualification = parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/qualification-policy.yaml"), "utf8"));

function resolveP0CapabilityBoundsEnvelopes(capabilitySource, crosswalkSource, profileSource) {
  const leaves = capabilitySource?.capabilities;
  const rows = crosswalkSource?.ownerCapabilityLeafAdjudication?.records;
  const rule = profileSource?.capabilityBoundsEnvelope;
  if (!Array.isArray(leaves) || leaves.length !== 462 || new Set(leaves.map(({ id }) => id)).size !== 462
      || !Array.isArray(rows) || rows.length !== 462 || new Set(rows.map(({ capabilityRef }) => capabilityRef)).size !== 462
      || rule?.id !== "media.profile.p0-capability-bounds-envelope.v1" || rule.population?.count !== 462) return null;
  const byCapability = new Map(rows.map((row) => [row.capabilityRef, row]));
  const boundsRefs = new Set();
  const envelopes = new Map();
  for (const leaf of leaves) {
    const id = leaf.id;
    const owner = leaf.ownerDefinition;
    const row = byCapability.get(id);
    const expectedBoundsRef = `media.capability-bounds.media-${id.slice("media.".length).replaceAll(".", "-")}`;
    if (!owner || owner.capabilityIntentId !== id || !leaf.outcome?.trim()
        || leaf.intentBindingState !== "P0_OWNER_DEFINED_CAPABILITY_INTENT; independent P0-010 semantic acceptance remains pending"
        || /per-leaf fit pending|semantic closure pending|proposed canonical family-intent/u.test(`${leaf.semanticReferenceScope} ${leaf.requirementTraceState}`)
        || leaf.semanticReferenceScope !== "media.capability-intent.owner-binding.v1"
        || !Array.isArray(leaf.actorRefs) || leaf.actorRefs.length === 0
        || !Array.isArray(leaf.inputArtifactTypes) || leaf.inputArtifactTypes.length === 0
        || !Array.isArray(leaf.outputArtifactTypes) || leaf.outputArtifactTypes.length === 0
        || !Array.isArray(owner.typedInputSlots) || owner.typedInputSlots.length === 0
        || owner.parameterSchema?.type !== "object" || owner.parameterSchema.additionalProperties !== false
        || !Array.isArray(owner.parameterSchema.required) || !owner.parameterSchema.properties
        || !Array.isArray(owner.successOutputs)
        || JSON.stringify(owner.successOutputs.map(({ artifactType }) => artifactType)) !== JSON.stringify(leaf.outputArtifactTypes)
        || owner.familyProfileRef !== row?.profileRef || owner.boundsRef !== expectedBoundsRef
        || row?.boundsRef !== expectedBoundsRef || boundsRefs.has(owner.boundsRef)) return null;
    boundsRefs.add(owner.boundsRef);
    envelopes.set(owner.boundsRef, {
      capabilityIntentId: id,
      profileRef: owner.familyProfileRef,
      parameterSchema: owner.parameterSchema,
      typedInputSlots: owner.typedInputSlots,
      inputArtifactTypes: leaf.inputArtifactTypes,
      outputArtifactTypes: leaf.outputArtifactTypes,
      successOutputs: owner.successOutputs,
    });
  }
  return envelopes.size === 462 ? envelopes : null;
}

test("P0 bounded invocation admission distinguishes inapplicable resources from unknown or unbounded ones", () => {
  assert.equal(profileSemantics.semanticCompletion.phase, "PDP-0");
  assert.equal(profileSemantics.semanticCompletion.status, "DEV_COMPLETE_FOR_PROFILE_MEANING");
  assert.ok(profileSemantics.semanticCompletion.completed.includes("fallback-default-deny"));
  assert.ok(profileSemantics.semanticCompletion.completed.includes("unknown-or-unbound-denial"));
  assert.ok(profileSemantics.semanticCompletion.laterBindingWork.includes("exact-capability-operation-profile-bindings"));
  assert.deepEqual(profileSemantics.semanticCompletion.ownerPendingSemantics, []);
  const preservationAxis = profileSemantics.profileAxes.find((axis) => axis.id === "PROFILE-AXIS-PRESERVATION");
  assert.equal(preservationAxis.qualificationPolicyDimension, "preservation-policy");
  assert.match(preservationAxis.qualificationPolicyMappingState, /^DEFINED/u);
  assert.ok(profileSemantics.semanticCompletion.laterBindingWork.includes("per-capability-profile-qualification-evidence"));

  const contract = profileSemantics.boundedInvocationAdmission;
  assert.equal(contract.id, "media.profile.bounded-invocation-admission");
  assert.equal(profileSemantics.capabilityBoundsEnvelope.id, "media.profile.p0-capability-bounds-envelope.v1");
  assert.equal(profileSemantics.capabilityBoundsEnvelope.population.count, 462);
  assert.equal(profileSemantics.capabilityBoundsEnvelope.parameterRule.includes("No operation wire schema"), true);
  assert.match(profileSemantics.capabilityBoundsEnvelope.parameterRule, /other declared properties are optional/u);
  assert.match(profileSemantics.capabilityBoundsEnvelope.parameterRule, /Defaults exist only when explicitly present in that exact schema/u);
  assert.match(profileSemantics.capabilityBoundsEnvelope.inputShapeRule, /sourceType, cardinality, required flag, alternatives, and condition/u);
  assert.match(profileSemantics.capabilityBoundsEnvelope.inputShapeRule, /No family-level optionality, field, default, or cardinality is inherited/u);
  const inputShapeSlots = capabilities.capabilities.flatMap(({ ownerDefinition }) => ownerDefinition.typedInputSlots);
  const inputShapeIdentity = (slot) => JSON.stringify({
    sourceType: slot.sourceType,
    cardinality: slot.cardinality,
    required: slot.required,
    alternatives: slot.alternatives,
    condition: slot.condition,
  });
  assert.equal(inputShapeSlots.length,
    profileSemantics.capabilityBoundsEnvelope.inputShapeFamilyReconciliation.currentPopulation.slotCount);
  assert.equal(new Set(inputShapeSlots.map(inputShapeIdentity)).size,
    profileSemantics.capabilityBoundsEnvelope.inputShapeFamilyReconciliation.currentPopulation.distinctSharedShapeCount);
  const currentResourceEvidence = profileSemantics.capabilityBoundsEnvelope.resourceDimensionRule.currentEvidencePopulation;
  assert.deepEqual(currentResourceEvidence, {
    capabilityCount: 462,
    dimensionCountPerCapability: 10,
    applicability: "UNKNOWN",
    bound: "NOT_EVALUATED",
    unit: "DEFINED",
    unitSourceRef: ".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml#ownerMeasurementDefinitions/records/@id=media.nfr-measurement.NFR-COST-001.v1",
    authority: "NOT_EVALUATED",
    source: "NOT_EVALUATED",
    enforcementBoundary: "NOT_EVALUATED",
    meaning: "No numeric resource ceiling or dimension inapplicability has been owner-established for a leaf/profile/invocation tuple in this P0 source cut. The normative units above are defined by NFR-COST-001; exact bound, authority, applicability, and enforcement evidence remain NOT_EVALUATED.",
  });
  assert.ok(profileSemantics.capabilityBoundsEnvelope.negativeCases.some((item) => /missing, duplicate, stale, or foreign boundsRef does not resolve/u.test(item)),
    "negative boundsRef cases must say they fail resolution");
  assert.deepEqual(contract.resourceDimensions, ["cpu", "ram", "vram", "gpu-time", "storage", "network", "process-count", "time", "retry-count", "cost"]);
  assert.deepEqual(contract.resourceDimensionUnits, {
    cpu: "CPU-milliseconds per job",
    ram: "bytes of system memory per job",
    vram: "bytes of video memory per job",
    "gpu-time": "GPU-milliseconds per job",
    storage: "bytes per job",
    network: "bytes transferred per job",
    "process-count": "process count per job",
    time: "wall-milliseconds per job",
    "retry-count": "retry count per job",
    cost: "currency minor units per job",
  });
  const resourceMeasurement = nfr.ownerMeasurementDefinitions.records.find(({ requirementRef }) => requirementRef === "NFR-COST-001");
  assert.equal(resourceMeasurement?.unit,
    "CPU-milliseconds per job; bytes of system memory per job; bytes of video memory per job; GPU-milliseconds per job; bytes of storage per job; bytes transferred over the network per job; process count per job; wall-milliseconds per job; retry count per job; currency minor units per job");
  assert.match(nfr.requirements.find(({ id }) => id === "NFR-COST-001").statement,
    /CPU, system-memory, video-memory, GPU-time, storage, network-transfer, process-count, wall-time, retry-count, and monetary bounds/u);
  assert.ok(contract.resourceDimensionUnits.cpu.includes("CPU-milliseconds"));
  assert.ok(contract.resourceDimensionUnits["gpu-time"].includes("GPU-milliseconds"));
  assert.ok(contract.resourceDimensionUnits["process-count"].includes("process count"));
  assert.ok(contract.resourceDimensionUnits["retry-count"].includes("retry count"));
  assert.ok(contract.resourceDimensionUnits.cost.includes("currency minor units"));
  assert.deepEqual(contract.applicabilityStates, ["APPLICABLE", "INAPPLICABLE", "UNKNOWN"]);
  assert.equal(profileSemantics.boundedInvocationAdmission.additionalResourceDimensionSources.vram,
    ".product-experience/pdp-0-product-truth/qualification-policy.yaml#qualificationDimensions");
  assert.equal(profileSemantics.boundedInvocationAdmission.additionalResourceDimensionSources.network,
    ".product-experience/pdp-0-product-truth/qualification-policy.yaml#securityAndRightsBaseline");
  assert.match(qualification.qualificationDimensions.join(" "), /CPU\/RAM\/VRAM\/GPU-time\/storage\/network\/process-count\/wall-time\/retry-count\/cost/u);
  assert.match(qualification.securityAndRightsBaseline.join(" "), /network-import destination\/redirect\/size\/time limits/u);
  assert.match(profileSemantics.boundedInvocationAdmission.additionalResourceDimensionSources.scope, /do not relax or replace NFR-COST-001 bounds/u);
  assert.deepEqual(contract.resourceEvidenceStates.bound, ["DEFINED_FINITE", "NOT_EVALUATED"]);
  assert.match(contract.resourceEvidenceStates.note, /not an empty, zero, unlimited, or inapplicable value/u);
  assert.deepEqual(contract.requiredRecord, [
    "capabilityLeafRef", "requestedProfileRefAndVersion", "effectiveProfileRefAndVersion",
    "resourceDimensionDecisions", "admissionDecision", "decisionAuthorityRef",
  ]);

  for (const field of ["dimension", "applicability", "applicabilityReason", "bound", "unit", "authorityRef", "sourceRef", "enforcementBoundary"]) {
    assert.ok(contract.resourceDimensionDecisionFields.includes(field), `dimension decision requires ${field}`);
  }

  const cases = Object.fromEntries(contract.decisionCases.map((item) => [item.id, item.then]));
  assert.match(cases["bounded-resource-all-applicable"], /may proceed to the remaining .* gates/u);
  assert.match(cases["bounded-resource-inapplicable-with-evidence"], /does not require a bound/u);
  for (const id of ["bounded-resource-unknown-applicability", "bounded-resource-missing-bound-or-provenance"]) {
    assert.match(cases[id], /NOT_ADMITTED; block before dispatch/u, `${id} denies before dispatch`);
    assert.match(cases[id], /explicit denial or blocked outcome/u, `${id} exposes explicit denial`);
  }
  assert.match(cases["bounded-resource-fallback"], /Re-evaluate every resource dimension/u);
  assert.ok(contract.nonClaims.includes("no numeric resource limits are selected here"));
  assert.ok(contract.nonClaims.includes("no runtime support, enforcement implementation, or availability is claimed"));
  assert.doesNotMatch(profileSemantics.scopeNote, /pending integration with P0-003/u);
  assert.doesNotMatch(profileSemantics.profileResolutionRecord.capabilityBindingState, /pending-P0-003/u);

  assert.equal(capabilities.capabilities.length, 462);
  assert.ok(capabilities.capabilities.every(({ executionResourceRequirements }) =>
    /profile-semantics\.yaml#boundedInvocationAdmission/u.test(executionResourceRequirements)
    && /finite bound/u.test(executionResourceRequirements)
    && /blocks before dispatch/u.test(executionResourceRequirements)
    && /INAPPLICABLE requires a reason and evidence/u.test(executionResourceRequirements)
    && /no numeric resource limit/u.test(executionResourceRequirements)
    && /claims no runtime availability/u.test(executionResourceRequirements)));
  const envelopes = resolveP0CapabilityBoundsEnvelopes(capabilities, capabilityLeafReview, profileSemantics);
  assert.equal(envelopes?.size, 462, "every stable capabilityIntentId resolves one exact unique P0 profile/schema envelope");
  for (const leaf of capabilities.capabilities) {
    assert.equal(leaf.semanticReferenceScope, capabilities.ownerDefinedCapabilityIntentBinding.id);
    const envelope = envelopes.get(leaf.ownerDefinition.boundsRef);
    assert.equal(envelope.capabilityIntentId, leaf.id);
    assert.equal(envelope.profileRef, leaf.ownerDefinition.familyProfileRef);
    assert.deepEqual(envelope.parameterSchema, leaf.ownerDefinition.parameterSchema);
    assert.deepEqual(envelope.typedInputSlots, leaf.ownerDefinition.typedInputSlots);
  }

  for (const mutate of [
    (copy) => { delete copy.capabilities[0].ownerDefinition.boundsRef; },
    (copy) => { copy.capabilities[0].ownerDefinition.boundsRef = copy.capabilities[1].ownerDefinition.boundsRef; },
    (copy) => { copy.capabilities[0].ownerDefinition.boundsRef = "media.capability-bounds.stale-leaf"; },
    (copy) => { copy.capabilities[0].ownerDefinition.familyProfileRef = "media.capability-profile.foreign"; },
    (copy) => { copy.capabilities[0].ownerDefinition.capabilityIntentId = copy.capabilities[1].id; },
    (copy) => { copy.capabilities[0].semanticReferenceScope = "per-leaf fit pending"; },
  ]) {
    const altered = structuredClone(capabilities);
    mutate(altered);
    assert.equal(resolveP0CapabilityBoundsEnvelopes(altered, capabilityLeafReview, profileSemantics), null,
      "missing, foreign, stale, or semantically pending envelope bindings are rejected");
  }
  assert.equal(profileSemantics.capabilityBoundsEnvelope.resourceDimensionRule.unappliedEvidenceState.includes("UNKNOWN applicability"), true);
  assert.equal(profileSemantics.capabilityBoundsEnvelope.resourceDimensionRule.admission.includes("NOT_ADMITTED"), true);
  assert.equal(profileSemantics.capabilityBoundsEnvelope.resourceDimensionRule.admission.includes("block before dispatch"), true);
  assert.equal(capabilities.capabilities.every(({ supportDimensions }) => supportDimensions.qualificationState === "NOT_EVALUATED"
    && supportDimensions.runtimeAvailability === "UNKNOWN"), true);
  assert.equal(handoff.pdpPhaseHandoffContracts.pdp0ToPdp1CapabilityIntent.requiredMeaning.executionResourceAdmission,
    ".product-experience/pdp-0-product-truth/profile-semantics.yaml#boundedInvocationAdmission");
});
