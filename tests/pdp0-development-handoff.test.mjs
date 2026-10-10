import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (file) => parse(readFileSync(resolve(root, file), "utf8"));

const sourcePath = ".product-experience/pdp-0-product-truth/capabilities.yaml";
const handoffPath = ".product-experience/pdp-0-product-truth/handoff-contracts.yaml";
const projectionGeneratorPath = "scripts/generate-media-phase-projections.mjs";

function validateCapabilityIntentHandoff(capabilities, handoff, trustReview) {
  const isMeaningfulValue = (value) => typeof value === "string"
    && value.trim().length > 0
    && !/^(?:unknown|tbd|todo|unspecified|unresolved)$/iu.test(value.trim());
  const leaves = capabilities?.capabilities;
  const contract = handoff?.pdpPhaseHandoffContracts?.pdp0ToPdp1CapabilityIntent;
  if (!Array.isArray(leaves) || leaves.length !== 462) return false;
  const ids = leaves.map(({ id }) => id);
  if (ids.some((id) => typeof id !== "string" || !id.trim()) || new Set(ids).size !== 462) return false;
  if (contract?.id !== "media.pdp0-pdp1.capability-intent-handoff.v1"
      || contract.sourcePhase !== "PDP-0"
      || contract.consumerPhase !== "PDP-1"
      || contract.status !== "DEFINITION_HANDOFF_CONTRACT"
      || contract.sourceRecordPopulation?.count !== 462) return false;
  const bindingRule = capabilities.ownerDefinedCapabilityIntentBinding;
  if (bindingRule?.id !== "media.capability-intent.owner-binding.v1"
      || bindingRule.count !== 462
      || !bindingRule.identityRule?.includes("existing id is its stable P0 capabilityIntentId")
      || !bindingRule.exactLeafMeaningRule?.includes("ownerDisposition selects its meaning") || !bindingRule.exactLeafMeaningRule?.includes("These P0 meanings are sufficient for handoff without a PDP-1 operation")
      || !bindingRule.secondaryTraceRule?.includes("makes no claim")
      || !bindingRule.downstreamContextRule?.includes("do not define P0 intent meaning")
      || bindingRule.independentAcceptance !== "P0-010-independent-semantic-review-remains-pending") return false;
  const dispositionCounts = Object.fromEntries([
    "JOURNEY_STEP_CAPABILITY",
    "MACHINE_CAPABILITY_WITH_EXPLICIT_CHANNEL_APPLICABILITY",
    "PLATFORM_DEPENDENCY_WITH_EXPLICIT_APPLICABILITY",
  ].map((disposition) => [disposition,
    leaves.filter(({ ownerDefinition }) => ownerDefinition?.ownerDisposition === disposition).length]));
  if (JSON.stringify(dispositionCounts) !== JSON.stringify({
    JOURNEY_STEP_CAPABILITY: 77,
    MACHINE_CAPABILITY_WITH_EXPLICIT_CHANNEL_APPLICABILITY: 383,
    PLATFORM_DEPENDENCY_WITH_EXPLICIT_APPLICABILITY: 2,
  })) return false;
  if (!Array.isArray(contract.negativeCases) || contract.negativeCases.length < 4) return false;

  const required = [
    "actorRefs", "intentRefs", "outcome", "semanticOutcomeContract", "requirementIds", "inputSemanticShapes",
    "outputSemanticShapes", "preconditions", "constraints", "executionResourceAdmission", "rightsPrivacy",
    "fidelity", "provenance", "supportedChannels", "channelApplicability",
    "exclusions", "qualificationAndAvailability",
  ];
  if (required.some((field) => !contract.requiredMeaning?.[field])) return false;
  const outputMeaning = contract.requiredMeaning.outputSemanticShapes;
  if (outputMeaning?.artifactTypes !== `${sourcePath}#/capabilities/@id=<capabilityIntentId>/outputArtifactTypes`
      || outputMeaning?.successOutputs !== `${sourcePath}#/capabilities/@id=<capabilityIntentId>/ownerDefinition/successOutputs`
      || outputMeaning?.successOutputVariants !== `${sourcePath}#/capabilities/@id=<capabilityIntentId>/ownerDefinition/successOutputs/*/resultVariants`
      || outputMeaning?.trustReconstructionBranches !== ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerTrustReconstructionDispositions/records/@capabilityRef=<capabilityIntentId>/outputBranches/*/outcomes"
      || !outputMeaning.variantBindingRule?.includes("exact selector and disposition")) return false;
  const trustRecords = trustReview?.ownerTrustReconstructionDispositions?.records;
  if (!Array.isArray(trustRecords) || trustRecords.length !== 462) return false;
  if (contract.consumerObligations?.some((text) => /PDP-0.*(?:operation|route).*required/iu.test(text))) return false;

  const requiredLeafFields = [
    "label", "outcome", "actorRefs", "intentRefs", "outcomeRefs", "requirementIds",
    "inputArtifactTypes", "outputArtifactTypes", "supportedParameters", "preconditions",
    "constraints", "requiredAuthority", "rightsPrivacyImplications", "qualityFidelityContract",
    "cancellationRetryReconciliation", "executionResourceRequirements", "provenance",
    "qualificationDimensions", "supportedChannels", "explicitUnsupportedCases", "supportDimensions",
  ];
  for (const leaf of leaves) {
    if (leaf.ownerDefinition?.capabilityIntentId !== leaf.id
        || leaf.intentBindingState !== "P0_OWNER_DEFINED_CAPABILITY_INTENT; independent P0-010 semantic acceptance remains pending"
        || /per-leaf fit pending|semantic closure pending|proposed canonical family-intent/u.test(`${leaf.semanticReferenceScope} ${leaf.requirementTraceState}`)
        || leaf.semanticReferenceScope !== bindingRule.id) return false;
    if (requiredLeafFields.some((field) => leaf[field] === undefined || leaf[field] === null)) return false;
    if (!leaf.ownerDefinition?.ownerDisposition) return false;
    if (!isMeaningfulValue(leaf.outcome)
        || leaf.inputArtifactTypes.some((value) => !isMeaningfulValue(value))
        || leaf.outputArtifactTypes.some((value) => !isMeaningfulValue(value))) return false;
    const p0Inputs = leaf.ownerDefinition;
    const outcomeContract = p0Inputs?.semanticOutcomeContract;
    if (!outcomeContract || outcomeContract.result !== leaf.outcome
        || p0Inputs.effect?.semanticOutcome !== leaf.outcome
        || leaf.outcome.startsWith("The P0 result for “")
        || !outcomeContract.unknownDisposition?.trim()
        || !outcomeContract.outputDistinctions?.length
        || !outcomeContract.sourceRefs?.length) return false;
    const trust = trustRecords.find(({ capabilityRef }) => capabilityRef === leaf.id);
    if (!trust || !Array.isArray(p0Inputs.successOutputs) || p0Inputs.successOutputs.length === 0
        || !Array.isArray(trust.outputBranches)) return false;
    for (const output of p0Inputs.successOutputs) {
      const branch = trust.outputBranches.find(({ outputArtifactType }) => outputArtifactType === output.artifactType);
      if (!branch || !Array.isArray(branch.outcomes) || branch.outcomes.length === 0) return false;
      const variants = output.resultVariants ?? [];
      for (const variant of variants) {
        if (typeof variant.selector !== "string" || !variant.selector.trim()
            || typeof variant.disposition !== "string"
            || (variant.claimLimit !== undefined && (typeof variant.claimLimit !== "string" || !variant.claimLimit.trim()))) return false;
        for (const dimension of ["resultKind", "originRelation", "epistemicDisposition"]) {
          if (variant[dimension] !== undefined && !variant.selector.includes(`${dimension}=${variant[dimension]}`)) return false;
        }
        const matching = branch.outcomes.filter(({ when }) => when === variant.selector);
        if (matching.length !== 1 || matching[0].disposition !== variant.disposition) return false;
      }
      for (const outcome of branch.outcomes) {
        if ((variants.some(({ selector }) => selector === outcome.when)
            && variants.filter(({ selector }) => selector === outcome.when).length !== 1)
            || (/^(?:resultKind|outputOrigin)=/u.test(outcome.when)
              && !variants.some(({ selector }) => selector === outcome.when))) return false;
      }
    }
    const parameterSchema = p0Inputs?.parameterSchema;
    const typedInputSlots = p0Inputs?.typedInputSlots;
    if (parameterSchema?.type !== "object" || parameterSchema.additionalProperties !== false
        || !Array.isArray(parameterSchema.required) || !parameterSchema.properties
        || !Array.isArray(typedInputSlots) || typedInputSlots.length === 0) return false;
    const propertyNames = Object.keys(parameterSchema.properties);
    if (parameterSchema.required.some((key) => !propertyNames.includes(key))) return false;
    const slotIds = typedInputSlots.map(({ slotId }) => slotId);
    if (slotIds.some((id) => typeof id !== "string" || !id.trim()) || new Set(slotIds).size !== slotIds.length) return false;
    if (typedInputSlots.some(({ sourceType, cardinality, required: isRequired }) =>
      !isMeaningfulValue(sourceType)
      || !["EXACTLY_ONE", "EXACTLY_ONE_OF_DECLARED_ALTERNATIVES", "ZERO_OR_ONE", "CONDITIONALLY_ONE"].includes(cardinality)
      || typeof isRequired !== "boolean")) return false;
    for (const field of ["actorRefs", "intentRefs", "outcomeRefs", "requirementIds", "inputArtifactTypes", "outputArtifactTypes", "preconditions", "constraints", "requiredAuthority", "rightsPrivacyImplications", "provenance", "qualificationDimensions", "supportedChannels", "explicitUnsupportedCases"]) {
      if (!Array.isArray(leaf[field]) || leaf[field].length === 0) return false;
    }
    if (typeof leaf.supportedParameters !== "string" || !leaf.supportedParameters.trim()) return false;
    if (!leaf.acceptanceCases?.length || leaf.acceptanceCases.some(({ given, when, then }) => !given || !when || !then)) return false;
    if (!leaf.supportDimensions?.implementationState
        || !leaf.supportDimensions?.licenseAdmissionState
        || !leaf.supportDimensions?.qualificationState
        || !leaf.supportDimensions?.runtimeAvailability) return false;
    if (leaf.supportDimensions.runtimeAvailability === "AVAILABLE"
        && (leaf.supportDimensions.implementationState !== "IMPLEMENTED"
          || leaf.supportDimensions.licenseAdmissionState !== "ADMITTED"
          || leaf.supportDimensions.qualificationState !== "QUALIFIED")) return false;
  }
  return true;
}

test("PDP-0 hands off all 462 stable capability intents with complete product meaning independent of PDP-1 operations", () => {
  const capabilities = readYaml(sourcePath);
  const handoff = readYaml(handoffPath);
  const trustReview = readYaml(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml");
  assert.equal(validateCapabilityIntentHandoff(capabilities, handoff, trustReview), true);

  const contract = handoff.pdpPhaseHandoffContracts.pdp0ToPdp1CapabilityIntent;
  assert.equal(contract.sourceRecordPopulation.identity, `${sourcePath}#/capabilities/@id=<capabilityIntentId>`);
  assert.ok(contract.requiredMeaning.inputSemanticShapes.includes(`${sourcePath}#/capabilities/@id=<capabilityIntentId>/ownerDefinition/typedInputSlots`));
  assert.ok(contract.requiredMeaning.inputSemanticShapes.includes(`${sourcePath}#/capabilities/@id=<capabilityIntentId>/ownerDefinition/parameterSchema`));
  assert.equal(contract.requiredMeaning.semanticOutcomeContract,
    `${sourcePath}#/capabilities/@id=<capabilityIntentId>/ownerDefinition/semanticOutcomeContract`);
  assert.equal(contract.requiredMeaning.executionResourceAdmission,
    ".product-experience/pdp-0-product-truth/profile-semantics.yaml#boundedInvocationAdmission");
  assert.match(contract.consumerObligations.join(" "), /Add exact typed PDP-1 operation/u);
  assert.match(contract.consumerObligations.join(" "), /does not make a complete PDP-0 intent incomplete/u);
  assert.ok(contract.consumerObligations.every((text) => !/runtime admission/u.test(text)));
  assert.match(contract.consumerObligations.join(" "), /payloadSchemaRef names are downstream schema-lookup hints/u);

  // Future operation references and wire contracts are intentionally omitted
  // from this source-level validator. The source-backed P0 parameter schema
  // and typed semantic input slots remain part of the handoff.
    const withoutDownstreamImplementation = structuredClone(capabilities);
    for (const leaf of withoutDownstreamImplementation.capabilities) {
      delete leaf.stateModelRefs;
      delete leaf.stateModelBindingState;
      delete leaf.stateModelBindings;
      delete leaf.unresolvedStateModelBindings;
      delete leaf.actionStateReferences;
      leaf.ownerDefinition = {
      capabilityIntentId: leaf.ownerDefinition.capabilityIntentId,
      ownerDisposition: leaf.ownerDefinition.ownerDisposition,
      effect: { semanticOutcome: leaf.ownerDefinition.effect.semanticOutcome },
      semanticOutcomeContract: leaf.ownerDefinition.semanticOutcomeContract,
      successOutputs: leaf.ownerDefinition.successOutputs,
      parameterSchema: leaf.ownerDefinition.parameterSchema,
      typedInputSlots: leaf.ownerDefinition.typedInputSlots.map(({ payloadSchemaRef: _downstreamSchemaRef, ...semanticSlot }) => semanticSlot),
    };
    }
  assert.equal(validateCapabilityIntentHandoff(withoutDownstreamImplementation, handoff, trustReview), true,
      "retained PDP-1 state references do not define the P0 capability intent");

  const missingP0ParameterContract = structuredClone(withoutDownstreamImplementation);
  delete missingP0ParameterContract.capabilities[0].ownerDefinition.parameterSchema;
  assert.equal(validateCapabilityIntentHandoff(missingP0ParameterContract, handoff, trustReview), false);

  const missingVariants = structuredClone(capabilities);
  const variantLeaf = missingVariants.capabilities.find(({ ownerDefinition }) => ownerDefinition?.successOutputs?.some(({ resultVariants }) => resultVariants?.length));
  variantLeaf.ownerDefinition.successOutputs[0].resultVariants = [];
  assert.equal(validateCapabilityIntentHandoff(missingVariants, handoff, trustReview), false,
    "a trust selector without its owner success-output variant is not a complete handoff");

  const mismatchedProvenance = structuredClone(capabilities);
  const provenanceVariant = mismatchedProvenance.capabilities.find(({ ownerDefinition }) => ownerDefinition?.successOutputs?.some(({ resultVariants }) => resultVariants?.length));
  provenanceVariant.ownerDefinition.successOutputs[0].resultVariants[0].originRelation = "AUTHORED_CREATION";
  assert.equal(validateCapabilityIntentHandoff(mismatchedProvenance, handoff, trustReview), false,
    "variant provenance must agree with its exact selector");

  const mismatchedTrust = structuredClone(trustReview);
  const variantTrust = mismatchedTrust.ownerTrustReconstructionDispositions.records.find(({ outputBranches }) => outputBranches?.some(({ outcomes }) => outcomes?.some(({ when }) => /resultKind=/u.test(when))));
  const variantOutcome = variantTrust.outputBranches.find(({ outcomes }) => outcomes.some(({ when }) => /resultKind=/u.test(when))).outcomes[0];
  variantOutcome.disposition = variantOutcome.disposition === "NO_RECONSTRUCTION_OR_INFERENCE"
    ? "ESTIMATED_OR_INFERRED_OBSERVATION"
    : "NO_RECONSTRUCTION_OR_INFERENCE";
  assert.equal(validateCapabilityIntentHandoff(capabilities, handoff, mismatchedTrust), false);
});

test("PDP-0 handoff rejects missing, duplicate, or weakened capability meaning", () => {
  const capabilities = readYaml(sourcePath);
  const handoff = readYaml(handoffPath);

  const missingIdentity = structuredClone(capabilities);
  delete missingIdentity.capabilities[0].id;
  assert.equal(validateCapabilityIntentHandoff(missingIdentity, handoff), false);

  const duplicateIdentity = structuredClone(capabilities);
  duplicateIdentity.capabilities[1].id = duplicateIdentity.capabilities[0].id;
  assert.equal(validateCapabilityIntentHandoff(duplicateIdentity, handoff), false);

  const missingOutcome = structuredClone(capabilities);
  delete missingOutcome.capabilities[0].outcome;
  assert.equal(validateCapabilityIntentHandoff(missingOutcome, handoff), false);

  const openParameters = structuredClone(capabilities);
  openParameters.capabilities[0].ownerDefinition.parameterSchema.additionalProperties = true;
  assert.equal(validateCapabilityIntentHandoff(openParameters, handoff), false);

  const unknownOutcome = structuredClone(capabilities);
  unknownOutcome.capabilities[0].outcome = "UNKNOWN";
  assert.equal(validateCapabilityIntentHandoff(unknownOutcome, handoff), false);

  const unknownOutput = structuredClone(capabilities);
  unknownOutput.capabilities[0].outputArtifactTypes = ["UNKNOWN"];
  assert.equal(validateCapabilityIntentHandoff(unknownOutput, handoff), false);

  const falselyAvailable = structuredClone(capabilities);
  falselyAvailable.capabilities[0].supportDimensions.runtimeAvailability = "AVAILABLE";
  assert.equal(validateCapabilityIntentHandoff(falselyAvailable, handoff), false);
});

test("PDP-0 product-definition candidate has no PDP-1 operation-contract input", () => {
  const generator = readFileSync(resolve(root, projectionGeneratorPath), "utf8");
  const candidateStart = generator.indexOf('name: "product-definition"');
  const nextDefinition = generator.indexOf('\n  {\n    name:', candidateStart + 1);
  assert.ok(candidateStart >= 0 && nextDefinition > candidateStart);
  const p0Projection = generator.slice(candidateStart, nextDefinition);
  assert.doesNotMatch(p0Projection, /pdp-1-domain-data\/operations\.yaml/u);
  assert.doesNotMatch(p0Projection, /operationContracts/u);
  assert.doesNotMatch(p0Projection, /feature-review-operation-reference-correction/u);
});
