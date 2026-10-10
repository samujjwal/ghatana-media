import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const { validateProductDefinition } = await import(new URL(`file://${resolve(root, "../ghatana-tools/libs/product-development/product-definition/src/index.ts")}`));
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

test("PDP-0 ProductDefinition candidate is schema and public-validator conformant while retaining open mapping decisions", () => {
  const projection = JSON.parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/generated/product-definition.candidate.json"), "utf8"));
  assert.equal(projection.projectionStatus, "GENERATED_CANDIDATE_NOT_ACCEPTED_NOT_CURRENT");
  validateProductDefinition(projection.candidateModel);
  assert.equal(projection.validation.schemaValid, true);
  assert.equal(projection.validation.publicValidatorPassed, true);
  assert.equal(projection.validation.publicValidator, "sibling public source entrypoint; package publication and installed-artifact verification pending");
  assert.match(projection.installedArtifactVerification, /PENDING/u);
  assert.equal(projection.acceptance, "NOT_CLAIMED");
  assert.match(projection.candidateMappingReview.ownerDecisionStatus, /PENDING/u);
  assert.ok(projection.candidateMappingReview.omittedCollections.timestamps.includes("omitted intentionally"));
  assert.ok(projection.candidateMappingReview.mappedCollections.journeys.includes("30 of 30 source journeys have exact representative initiators"));
  assert.ok(projection.candidateMappingReview.mappedCollections.userIntents.includes("19 of 19 source intents have exact actor/priority decisions"));
  assert.equal(projection.candidateModel.capabilities.length, 462);
  assert.equal(projection.candidateModel.requirements.length, 52);
  assert.equal(projection.candidateModel.userIntents.length, 19, "all source intents have owner-selected actor and priority decisions");
  assert.equal(projection.candidateModel.journeys.length, 30, "all source collaborator actor lists are projected");
  assert.equal(projection.candidateModel.journeys.filter(({ actorRef }) => actorRef !== undefined).length, 30, "all source journeys have owner-selected representative initiating actors");
  assert.equal(Object.hasOwn(projection.candidateModel, "createdAt"), false, "optional authored timestamp omitted without provenance");
  assert.equal(Object.hasOwn(projection.candidateModel, "updatedAt"), false, "optional authored timestamp omitted without provenance");
  const goalSource = readYaml(".product-experience/pdp-0-product-truth/goals-jtbd.yaml");
  assert.deepEqual(projection.candidateModel.nonGoals, goalSource.nonGoals.map(({ id, description, reason }) => ({ id, description, reason })), "only explicitly owner-authored non-goals are projected");
  assert.equal(projection.candidateModel.nonGoals.some(({ id }) => goalSource.scope.exclusionsFromMediaAuthority.includes(id)), false, "scope authority exclusions are not reclassified as product non-goals");
  const functionalRequirements = readYaml(".product-experience/pdp-0-product-truth/requirements.yaml").requirements;
  assert.ok(functionalRequirements.some((item) => item.traceToIntentIds.length > 0), "the source intent traces remain available for crosswalk resolution");
  const resolvedIntentIds = new Set(projection.candidateModel.userIntents.map((item) => item.id));
  assert.ok(projection.candidateModel.requirements.every((item) => item.traceToIntentIds.every((id) => resolvedIntentIds.has(id))), "unresolved userIntent targets are not emitted as dangling refs");
  assert.equal(projection.candidateMappingReview.unresolvedUserIntentIds.length, 0);
  assert.equal(projection.candidateMappingReview.unresolvedJourneyIds.length, 0);
  assert.equal(projection.candidateMappingReview.intentTracesWithUnresolvedTargets.length, 0);
  assert.equal(projection.candidateMappingReview.intentTracesWithUnresolvedTargets.reduce((count, row) => count + row.unresolvedIntentRefs.length, 0), 0);
  assert.equal(projection.candidateModel.actors.find(({ id }) => id === "media.external-provider").kind, "external-service");
  assert.equal(projection.candidateModel.policies.length, 9, "explicit fail-closed enforcement points map to strict product policies");
  assert.ok(!projection.fieldMappingBlockers.some(({ field }) => ["createdAt", "updatedAt", "journeys"].includes(field)));
  assert.equal(Object.keys(projection.candidateFieldSources).length, 22);
  assert.ok(projection.fieldMappingBlockers.every((item) => !/ACCEPTED|CLOSED/u.test(item.status)));
  assert.match(projection.candidateMappingReview.fieldDispositions.policies.status, /DIRECT_FAIL_CLOSED_ENFORCEMENT_MAPPING/u);
  assert.match(projection.candidateMappingReview.fieldDispositions.capabilities.status, /DIRECT_SOURCE_MAPPING/u);
  assert.match(projection.candidateMappingReview.fieldDispositions.requirements.status, /DIRECT_SOURCE_MAPPING; ALL_INTENT_TARGETS_RESOLVED/u);
});

test("ProductDefinition mapping coverage is explicit, source-pinned, and rejects invalid semantic fixtures", () => {
  const projection = JSON.parse(readFileSync(resolve(root, ".product-experience/pdp-0-product-truth/generated/product-definition.candidate.json"), "utf8"));
  const schema = JSON.parse(readFileSync(resolve(root, "../ghatana-tools/libs/product-development/product-definition/schemas/product-definition.v1.schema.json"), "utf8"));
  const sourceFields = projection.candidateFieldSources;
  assert.deepEqual(Object.keys(sourceFields).sort(), Object.keys(schema.properties).sort(), "every public ProductDefinition property has exactly one mapping disposition");
  for (const [field, mapping] of Object.entries(sourceFields)) {
    assert.ok(typeof mapping.mapping === "string" && mapping.mapping.trim(), `${field} needs transformation or omission semantics`);
    if (mapping.sourceRef === null || mapping.sourcePath === null) {
      assert.equal(mapping.sourceRef, null, `${field} null sourceRef must be paired with null sourcePath`);
      assert.equal(mapping.sourcePath, null, `${field} null sourcePath must be paired with null sourceRef`);
      assert.ok(field === "id" || field === "domainRules" || field === "createdAt" || field === "updatedAt",
        `${field} cannot silently omit its source path`);
    }
  }
  for (const field of schema.required) assert.ok(Object.hasOwn(projection.candidateModel, field), `${field} is required by the public schema`);
  for (const field of ["createdAt", "updatedAt"]) assert.equal(Object.hasOwn(projection.candidateModel, field), false, `${field} stays omitted without authored timestamp provenance`);
  assert.ok(!projection.fieldMappingBlockers.some(({ field }) => field === "domainRules"), "bounded owner-decided rules have a direct PDP-1 source mapping");
  assert.ok(!projection.fieldMappingBlockers.some(({ field }) => field === "successMeasures"), "PXD-048 accepts definition mapping without asserting measured calibration");
  assert.equal(projection.candidateModel.domainRules.length, 6, "only bounded accepted PDP-1 policy decisions are projected");
  assert.equal(projection.candidateModel.successMeasures.length, 4, "all source-defined business-intent measurement contracts are projected");
  assert.ok(projection.candidateModel.successMeasures.every((measure) => Object.keys(measure).sort().join(",") === "baseline,description,id,metric,target"), "the candidate maps defined criteria while preserving unknown baseline and unset target");
  assert.ok(projection.candidateModel.successMeasures.every(({ baseline, target }) => baseline.startsWith("NOT_EVALUATED") && target.startsWith("NOT_SET")));
  for (const source of projection.sourceAuthorities) {
    const text = readFileSync(resolve(root, source.sourceRef), "utf8");
    assert.equal(createHash("sha256").update(text).digest("hex"), source.sha256, `${source.sourceRef} drifted since projection generation`);
    const driftFixture = `${text}\n# G-03 source-drift fixture\n`;
    assert.notEqual(createHash("sha256").update(driftFixture).digest("hex"), source.sha256,
      `${source.sourceRef} source drift fixture must invalidate the pinned projection fingerprint`);
  }

  const valid = projection.candidateModel;
  const rejected = (mutate, label) => {
    const fixture = structuredClone(valid);
    mutate(fixture);
    assert.throws(() => validateProductDefinition(fixture), undefined, label);
  };
  rejected((fixture) => { fixture.schemaVersion = "ghatana.product-definition.v999"; }, "schema version enum drift must fail");
  rejected((fixture) => { fixture.userIntents[0].priority = "urgent"; }, "illegal priority must fail rather than be coerced");
  rejected((fixture) => { fixture.actors[0].kind = "guessed-principal-kind"; }, "actor kind conversion must use an allowed discriminator");
  rejected((fixture) => { fixture.requirements[0].traceToIntentIds = ["media.intent.stale"];
    fixture.userIntents = fixture.userIntents.filter(({ id }) => id !== "media.intent.stale");
  }, "stale cross-phase intent references must fail referential closure");
  rejected((fixture) => { delete fixture.purpose.statement; }, "missing required properties must fail");
  rejected((fixture) => { fixture.journeys[0].actorRefs = []; }, "journey actor guards must reject an empty participant list");
  rejected((fixture) => { fixture.actors[1].id = fixture.actors[0].id; }, "duplicate target IDs must fail uniqueness validation");
  assert.throws(() => validateProductDefinition({}), undefined, "an empty schema-shaped object must not validate as green");

  const ownerRules = readYaml(".product-experience/pdp-0-product-truth/actors-responsibilities.yaml").ownershipRules.rules;
  assert.deepEqual(valid.ownershipRules.map(({ id, owner }) => [id, owner]),
    ownerRules.map(({ id, accountableRoleRef }) => [id, accountableRoleRef]),
    "owner values must come from the explicit accountableRoleRef source, not inferred principals");
});

test("P0-01 defines all 462 capability intents with complete meaning and no PDP-1 prerequisites", () => {
  const source = readYaml(".product-experience/pdp-0-product-truth/capabilities.yaml");
  const leaves = source.capabilities;
  assert.equal(leaves.length, 462);
  assert.equal(new Set(leaves.map(({ id }) => id)).size, 462);
  const p0OwnerDispositionNames = new Set();
  for (const leaf of leaves) {
    assert.ok(leaf.actorRefs?.length, `${leaf.id} has source-backed actors`);
    assert.ok(leaf.intentRefs?.length, `${leaf.id} has source-backed intent`);
    assert.ok(leaf.outcome, `${leaf.id} states its outcome`);
    assert.ok(leaf.inputArtifactTypes?.length, `${leaf.id} has semantic inputs`);
    assert.ok(leaf.outputArtifactTypes?.length, `${leaf.id} has semantic outputs`);
    assert.ok(leaf.preconditions?.length, `${leaf.id} has product preconditions`);
    assert.ok(leaf.constraints?.length, `${leaf.id} has product constraints`);
    assert.ok(leaf.acceptanceCases?.length, `${leaf.id} has falsifiable cases`);
    assert.ok(leaf.acceptanceCases.every((scenario) => scenario.given && scenario.when && scenario.then), `${leaf.id} cases are testable`);
    assert.ok(leaf.requiredAuthority?.length, `${leaf.id} names its authority requirements`);
    assert.ok(leaf.qualityFidelityContract, `${leaf.id} defines quality/fidelity meaning`);
    assert.ok(leaf.cancellationRetryReconciliation, `${leaf.id} defines safe unknown behavior`);
    assert.ok(/profile-semantics\.yaml#boundedInvocationAdmission/u.test(leaf.executionResourceRequirements), `${leaf.id} has a bounded resource strategy`);
    assert.ok(leaf.qualificationDimensions?.length, `${leaf.id} declares qualification dimensions without a qualified claim`);
    assert.ok(leaf.explicitUnsupportedCases?.length, `${leaf.id} states unsupported cases`);

    const owner = leaf.ownerDefinition;
    assert.ok(owner?.familyProfileRef?.startsWith("media.capability-profile."), `${leaf.id} has a P0 profile`);
    assert.ok(owner?.boundsRef?.startsWith("media.capability-bounds."), `${leaf.id} has P0 bounds`);
    assert.ok(owner?.channelApplicabilityRef?.startsWith(".product-experience/pdp-0-product-truth/"), `${leaf.id} has P0 channel applicability`);
    assert.ok(Array.isArray(owner.typedInputSlots) && owner.typedInputSlots.length > 0, `${leaf.id} has semantic input slots`);
    assert.ok(owner.typedInputSlots.every(({ slotId, sourceType, cardinality, required }) => slotId && sourceType && cardinality && typeof required === "boolean"), `${leaf.id} input slots are complete`);
    assert.equal(owner.parameterSchema.type, "object", `${leaf.id} parameters are typed`);
    assert.equal(owner.parameterSchema.additionalProperties, false, `${leaf.id} parameters are closed`);
    assert.deepEqual(owner.successOutputs.map(({ artifactType }) => artifactType), leaf.outputArtifactTypes, `${leaf.id} P0 output shapes match`);
    assert.ok(owner.successOutputs.every(({ requiredOnSuccess }) => typeof requiredOnSuccess === "boolean"), `${leaf.id} output requirements are explicit`);
    assert.ok(owner.idempotency && owner.recovery, `${leaf.id} has safe repeat and unknown-outcome semantics`);
    assert.equal(owner.availability.implementationState, "UNKNOWN");
    assert.equal(owner.availability.qualificationState, "NOT_EVALUATED");
    assert.equal(owner.availability.runtimeAvailability, "UNKNOWN");
    assert.equal(owner.availability.executionAdmission, "NOT_ADMITTED");
    assert.equal(owner.ownerDisposition.includes("OPERATION"), false, `${leaf.id} applicability is a P0 capability decision`);
    p0OwnerDispositionNames.add(owner.ownerDisposition);

    for (const forbiddenKey of ["operationRefs", "operationKind", "operationContractRef", "payloadSchemaRef", "domainObjectRefs", "stateRefs", "canonicalAuthorityRefs"]) {
      assert.equal(Object.hasOwn(owner, forbiddenKey), false, `${leaf.id} has no downstream ${forbiddenKey}`);
    }
    assert.ok(owner.typedInputSlots.every((slot) => !Object.hasOwn(slot, "payloadSchemaRef")), `${leaf.id} has no PDP-1 input schema dependency`);
    assert.ok(owner.successOutputs.every((output) => !Object.hasOwn(output, "payloadSchemaRef")), `${leaf.id} has no PDP-1 output schema dependency`);
  }
  assert.ok(p0OwnerDispositionNames.size >= 2, "P0 distinguishes journey, machine, and explicit dependency applicability");

  const reviewed = readYaml(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml");
  const adjudication = reviewed.ownerCapabilityLeafAdjudication;
  assert.equal(adjudication.exactLeafCount, 462);
  assert.equal(adjudication.records.length, 462);
  assert.equal(new Set(adjudication.records.map(({ capabilityRef }) => capabilityRef)).size, 462);
  assert.deepEqual(adjudication.records.map(({ capabilityRef }) => capabilityRef), leaves.map(({ id }) => id));
  assert.ok(adjudication.records.every((row) => row.ownerDisposition && row.channelApplicability), "each leaf has a P0 applicability decision");
  assert.ok(adjudication.records.every((row) => !Object.hasOwn(row, "operationRefs") && !Object.hasOwn(row, "operationContractRef")), "P0 adjudication does not require exact operations");

  const crosswalk = readYaml(".product-experience/pdp-0-product-truth/capability-preservation-crosswalk.yaml");
  const familyIds = crosswalk.familyCrosswalk.flatMap((family) => family.capabilityIds);
  assert.deepEqual([...familyIds].sort(), leaves.map(({ id }) => id).sort(), "preservation crosswalk retains the exact capability denominator");
  const journeySource = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml");
  const knownJourneys = new Set(journeySource.journeys.map(({ id }) => id));
  assert.equal(journeySource.journeys.length, 30);
  for (const leaf of leaves) for (const ref of leaf.journeyRefs ?? []) assert.ok(knownJourneys.has(ref), `${leaf.id} journey ${ref} exists in P0`);
  for (const key of ["inputArtifactTypes", "outputArtifactTypes", "typedInputSlots", "successOutputs"]) {
    const serialized = JSON.stringify(leaves.map((leaf) => key === "typedInputSlots" || key === "successOutputs" ? leaf.ownerDefinition[key] : leaf[key]));
    assert.doesNotMatch(serialized, /pdp-1-domain-data|operationContractRef|payloadSchemaRef/u, `${key} remains P0 semantic meaning`);
  }
});

test("PDP-0 quality and NFR records retain measurement limits and unresolved specialist decisions", () => {
  const nfr = readYaml(".product-experience/pdp-0-product-truth/nonfunctional-requirements.yaml");
  const quality = readYaml(".product-experience/pdp-0-product-truth/quality-policy.yaml");
  assert.equal(nfr.requirements.length, 14);
  assert.ok(nfr.requirements.every((item) => item.owner && item.acceptance));
  assert.ok(nfr.openDecisions.length >= 3);
  assert.equal(quality.qualityDimensions.length, 6);
  assert.ok(quality.qualityDimensions.every((item) => item.applicability && item.abstainWhen));
  assert.match(nfr.authorityStatus, /pending-P0-010/iu);
  const goals = readYaml(".product-experience/pdp-0-product-truth/goals-jtbd.yaml");
  const measures = goals.successMeasureContracts;
  assert.match(measures.status, /baseline-target-and-qualification-not-evaluated/u);
  assert.equal(measures.records.length, 4);
  assert.deepEqual(measures.records.map(({ businessIntentRef }) => businessIntentRef), goals.businessIntents.map(({ id }) => id));
  assert.ok(measures.records.every(({ metric, unit, denominator, applicability, acceptanceCriterion, evidenceMethod, baseline, target, qualification }) =>
    metric && unit && denominator && applicability && acceptanceCriterion && evidenceMethod &&
    baseline.startsWith("NOT_EVALUATED") && target.startsWith("NOT_SET") && qualification === "NOT_EVALUATED"));
});

test("P0-05 defines Media policy, trust, rights, and ownership without PDP-1 state prerequisites", () => {
  const constitution = readYaml(".product-experience/pdp-0-product-truth/constitution.yaml");
  const actors = readYaml(".product-experience/pdp-0-product-truth/actors-responsibilities.yaml");
  const policy = readYaml(".product-experience/pdp-0-product-truth/policy-authority-model.yaml").productPolicy;
  assert.equal(constitution.requirements.length, 32);
  assert.equal(new Set(constitution.requirements.map(({ id }) => id)).size, 32);
  assert.ok(constitution.requirements.every(({ statement, normativeFieldRefs }) => statement && normativeFieldRefs));

  const invariants = constitution.invariants.records;
  assert.equal(invariants.length, 7);
  assert.equal(new Set(invariants.map(({ id }) => id)).size, invariants.length);
  assert.ok(invariants.every(({ statement, violation, sourceRefs }) => statement && violation && sourceRefs.length));
  assert.ok(invariants.every(({ sourceRefs }) => sourceRefs.every((ref) => ref.startsWith(".product-experience/pdp-0-product-truth/policy-authority-model.yaml#"))));
  assert.match(invariants.find(({ id }) => id === "MEDIA-INV-005").violation, /do not replay/u, "unknown effect outcomes cannot be replayed as audit repair");

  assert.ok(policy.independentGovernanceAxes.length >= 8);
  assert.ok(policy.invariants.length >= invariants.length);
  assert.ok(policy.adversarialAcceptanceCases.includes("expired-or-revoked-consent-blocks-new-frame-and-provider-dispatch"));
  assert.ok(policy.adversarialAcceptanceCases.includes("cancelled-remote-work-remains-uncertain-until-provider-confirmation"));
  assert.equal(policy.platformMechanics.identityAndAuthentication.owner, "ghatana-shared-and-identity-service");
  assert.ok(policy.platformMechanics.identityAndAuthentication.prohibited.includes("caller-selected-tenant-authority"));
  assert.equal(policy.platformMechanics.privilegedEffects.owner, "ghatana-action-plane");
  assert.ok(policy.platformMechanics.privilegedEffects.prohibited.includes("model-output-as-approval"));

  const contexts = actors.trustContexts;
  assert.match(contexts.principalKindInference, /forbidden/u);
  assert.deepEqual(contexts.contexts.map(({ trustLevel }) => trustLevel), ["public", "authenticated", "privileged", "admin"]);
  assert.ok(contexts.contexts.every(({ dataSensitivity, effectScope, auditRequired, sourceRefs }) => dataSensitivity && effectScope && typeof auditRequired === "boolean" && sourceRefs.length));
  assert.equal(contexts.contexts[0].auditRequired, false);
  assert.ok(contexts.contexts.slice(1).every(({ auditRequired }) => auditRequired));

  const owners = actors.ownershipRules;
  assert.equal(owners.accountabilityIsNotPrivilege, true);
  assert.equal(owners.rules.length, 5);
  assert.equal(new Set(owners.rules.map(({ id }) => id)).size, owners.rules.length);
  assert.ok(owners.rules.every(({ accountableRoleRef, executionAuthority, contractOwner, sourceRefs }) => accountableRoleRef && executionAuthority && contractOwner && sourceRefs.length));
  assert.ok(owners.rules.filter(({ contractOwner }) => contractOwner.repository !== "samujjwal/ghatana-media").every(({ bindingStatus }) => /identified|unverified/u.test(bindingStatus)), "external owner contracts remain honestly unverified");
  for (const source of [constitution.invariants, actors.trustContexts]) assert.doesNotMatch(JSON.stringify(source), /pdp-1-domain-data\/.*(states|transitions|authority)\.yaml/u);
});

test("P0-04 owner intent decisions are auditable and preserve collaborative actor references", () => {
  const goals = readYaml(".product-experience/pdp-0-product-truth/goals-jtbd.yaml");
  const decisions = readYaml(".product-experience/pdp-0-product-truth/intent-resolutions.yaml");
  assert.match(decisions.status, /P0-010-independent-semantic-review-pending/u);
  const requirementSource = readYaml(".product-experience/pdp-0-product-truth/requirements.yaml");
  const actorSource = readYaml(".product-experience/pdp-0-product-truth/actors-responsibilities.yaml");
  assert.equal(decisions.intents.length, goals.intents.length);
  assert.deepEqual(decisions.intents.map(({ id }) => id), goals.intents.map(({ id }) => id));
  const sourceById = new Map(goals.intents.map((intent) => [intent.id, intent]));
  const journeySource = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml");
  const validateEvidenceRef = (ref, id) => {
    if (ref.startsWith("goals-jtbd.yaml#/intents/")) {
      assert.ok(goals.intents[Number(ref.split("/").at(-1))], `${id} intent evidence ${ref} resolves`);
    } else if (ref.startsWith("goals-jtbd.yaml#/jobs/")) {
      assert.ok(goals.jobs[Number(ref.split("/").at(-1))], `${id} job evidence ${ref} resolves`);
    } else if (ref.startsWith("goals-jtbd.yaml#/outcomes/")) {
      assert.ok(goals.outcomes[Number(ref.split("/").at(-1))], `${id} outcome evidence ${ref} resolves`);
    } else if (ref.startsWith("journey-catalog.yaml#/journeys/")) {
      assert.ok(journeySource.journeys[Number(ref.split("/").at(-1))], `${id} journey evidence ${ref} resolves`);
    } else if (ref.startsWith("requirements.yaml#/requirements/")) {
      const requirementId = ref.split("/").at(-1);
      assert.ok(requirementSource.requirements.some(({ id: sourceId }) => sourceId === requirementId), `${id} requirement evidence ${ref} resolves`);
    } else if (ref.startsWith("actors-responsibilities.yaml#/actors/")) {
      const actorId = ref.split("/").at(-1);
      assert.ok(actorSource.actors.some(({ id: sourceId }) => sourceId === actorId), `${id} actor evidence ${ref} resolves`);
    } else if (ref.startsWith("actors-responsibilities.yaml#/responsibilityRoles/")) {
      const roleId = ref.split("/").at(-1);
      assert.ok(actorSource.responsibilityRoles.some(({ id: sourceId }) => sourceId === roleId), `${id} role evidence ${ref} resolves`);
    } else {
      assert.ok(["goals-jtbd.yaml#/scope/includedFamilies", "goals-jtbd.yaml#/scope/documentIntelligenceBoundary"].includes(ref), `${id} evidence ref ${ref} is a known scope authority`);
    }
  };
  for (const decision of decisions.intents) {
    const source = sourceById.get(decision.id);
    assert.ok(["must", "should", "could", "wont"].includes(decision.priority), `${decision.id} has a valid priority`);
    assert.ok(decision.priorityRationale.length > 0, `${decision.id} has a priority rationale`);
    assert.ok(decision.priorityEvidenceRefs.length > 0, `${decision.id} cites priority evidence`);
    for (const ref of decision.priorityEvidenceRefs) validateEvidenceRef(ref, decision.id);
    assert.ok(["resolved", "unresolved"].includes(decision.actorStatus), `${decision.id} has an actor disposition`);
    if (decision.actorStatus === "resolved") {
      assert.ok(source.actorRefs.includes(decision.actorRef), `${decision.id} actor is among source candidates`);
      assert.ok(decision.actorEvidenceRefs.length > 0, `${decision.id} actor cites evidence`);
      assert.ok(decision.actorRationale.length > 0, `${decision.id} has an actor rationale`);
    } else {
      assert.equal(decision.actorRef, null, `${decision.id} unresolved actor is not selected`);
    }
    for (const ref of decision.actorEvidenceRefs) validateEvidenceRef(ref, decision.id);
  }
  assert.equal(decisions.intents.filter(({ actorStatus }) => actorStatus === "resolved").length, 19);
  assert.equal(decisions.intents.filter(({ actorStatus }) => actorStatus === "unresolved").length, 0);
  const readiness = decisions.intents.find(({ id }) => id === "media.intent.check-processing-readiness");
  const healthRequirement = requirementSource.requirements.find(({ id }) => id === "MEDIA-REQ-CAP-HEALTH");
  assert.equal(readiness.actorRef, "media.operator");
  assert.equal(readiness.actorScope, "human-initiated-health-readiness-inspection");
  assert.deepEqual(readiness.collaboratorActorRefs, ["media.administrator", "media.automation-client"]);
  assert.deepEqual(healthRequirement.traceToIntentIds, [readiness.id]);
  assert.deepEqual(healthRequirement.actorRefs, ["media.operator"]);
  assert.deepEqual(healthRequirement.actorRoleBindings, [{
    sourceRoleLabel: "operator",
    status: "resolved",
    actorRef: "media.operator",
    responsibilityRoleRef: "media.role.operator",
    resolution: "exact",
    note: "Canonical actor/role assignment does not grant permission.",
  }]);
  assert.deepEqual(goals.intents.find(({ id }) => id === readiness.id).actorRefs, [
    "media.operator", "media.administrator", "media.automation-client",
  ], "alternate/collaborator actors remain in the source intent");
  assert.match(readiness.actorRationale, /grants no permission/u);
  assert.match(decisions.resolutionPolicy.actor, /collaborator actorRefs/u);
  assert.match(decisions.resolutionPolicy.acceptance, /P0-010/u);
});

test("P0-04 journey actors and requirement intent targets remain source-bound", () => {
  const goals = readYaml(".product-experience/pdp-0-product-truth/goals-jtbd.yaml");
  const journeys = readYaml(".product-experience/pdp-0-product-truth/journey-catalog.yaml").journeys;
  const decisions = readYaml(".product-experience/pdp-0-product-truth/journey-actor-resolutions.yaml");
  const intentDecisions = readYaml(".product-experience/pdp-0-product-truth/intent-resolutions.yaml").intents;
  const requirements = readYaml(".product-experience/pdp-0-product-truth/requirements.yaml").requirements;
  assert.match(decisions.status, /P0-010-independent-semantic-review-pending/u);
  assert.equal(decisions.journeys.length, 30);
  assert.deepEqual(decisions.journeys.map(({ id }) => id), journeys.map(({ id }) => id));
  for (let index = 0; index < journeys.length; index += 1) {
    const source = journeys[index];
    const decision = decisions.journeys[index];
    assert.deepEqual(decision.collaboratorActorRefs, source.actors, `${source.id} retains the full source collaborator set`);
    assert.equal(decision.sourceRef, `journey-catalog.yaml#/journeys/${index}`, `${source.id} source pointer is exact`);
    assert.ok(["resolved", "unresolved"].includes(decision.actorStatus));
    if (decision.actorStatus === "resolved") {
      assert.ok(source.actors.includes(decision.initiatingActorRef), `${source.id} initiating actor is a source actor`);
      assert.ok(decision.rationale.length > 0);
    } else {
      assert.equal(decision.initiatingActorRef, null, `${source.id} unresolved actor is not selected`);
    }
    assert.ok(decision.evidenceRefs.every((ref) => ref.length > 0), `${source.id} retains its evidence locators`);
  }
  assert.equal(decisions.journeys.filter(({ actorStatus }) => actorStatus === "resolved").length, 30);
  assert.equal(decisions.journeys.filter(({ actorStatus }) => actorStatus === "unresolved").length, 0);
  const firstUseDecision = decisions.journeys.find(({ id }) => id === "J-01");
  assert.ok(goals.firstUse.actorRefs.includes(firstUseDecision.initiatingActorRef));
  assert.match(decisions.policy.disclosure, /do not select an initiating actor/u);

  const intentById = new Map(intentDecisions.map((intent) => [intent.id, intent]));
  let traceRefs = 0;
  let resolvedTraceRefs = 0;
  let fullyResolvableRequirements = 0;
  let partlyResolvableRequirements = 0;
  let noResolvedActorTargetRequirements = 0;
  for (const requirement of requirements) {
    const traces = requirement.traceToIntentIds ?? [];
    assert.ok(traces.length > 0, `${requirement.id} has an authored intent trace`);
    traceRefs += traces.length;
    const resolved = traces.filter((id) => {
      const intent = intentById.get(id);
      assert.ok(intent, `${requirement.id} trace ${id} exists in the canonical intent catalog`);
      assert.ok(intent.priority, `${requirement.id} trace ${id} has a ProductDefinition priority`);
      return intent.actorStatus === "resolved";
    }).length;
    resolvedTraceRefs += resolved;
    if (resolved === traces.length) fullyResolvableRequirements += 1;
    else if (resolved > 0) partlyResolvableRequirements += 1;
    else noResolvedActorTargetRequirements += 1;
  }
  assert.equal(requirements.length, 38);
  assert.equal(traceRefs, 69, "current owner-reviewed STREAM, PROVENANCE, and PROJECT traces are included");
  assert.equal(resolvedTraceRefs, 69);
  assert.equal(fullyResolvableRequirements, 38);
  assert.equal(partlyResolvableRequirements, 0);
  assert.equal(noResolvedActorTargetRequirements, 0);
});

test("migration extraction keeps the mixed blocks and unresolved owner review visible", () => {
  const review = readYaml(".product-experience/pdp-0-product-truth/migration-semantics-review.yaml");
  assert.equal(review.counts.uniqueUnitsByClassification.UNRESOLVED, 260);
  assert.equal(review.counts.blockStructureProposalCounts.MIXED_REQUIRES_DECOMPOSITION, 124);
  assert.equal(review.counts.blockStructureProposalCounts.ownerReviewed, 3);
  assert.match(review.blockStructureProposalAuthority, /Proposal-only/u);
  assert.equal(review.ownerDecisionOverlay.resolvedBlockCount, 0);
  for (const id of ["MPSEM-0178", "MPSEM-0211"]) {
    const item = review.items.find((candidate) => candidate.itemId === id);
    assert.equal(item.classification, "UNRESOLVED");
    assert.ok(item.partialClaimMappings?.length);
    assert.ok(item.partialClaimMappings.every((claim) => claim.disposition.includes("block-remains-UNRESOLVED")));
  }
  assert.match(review.systematicScope.gapState, /open/u);
});
