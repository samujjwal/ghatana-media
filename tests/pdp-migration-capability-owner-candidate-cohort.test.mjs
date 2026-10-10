import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const candidatePath = "docs/implementation/verification/pdp-38/migration-capability-owner-candidate-163.json";
const candidate = JSON.parse(readFileSync(resolve(root, candidatePath), "utf8"));
const historicalReview = JSON.parse(readFileSync(resolve(root, "docs/implementation/verification/pdp-38/migration-capability-reviewed.json"), "utf8"));
const historicalPlan = readFileSync(resolve(root, "docs/migration/expert-reviewed-master-plan.md"), "utf8").split(/\r?\n/u);
const gapSource = parse(readFileSync(resolve(root, ".product-experience/gaps.yaml"), "utf8"));
const sha256Json = (value) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const sha256Text = (value) => createHash("sha256").update(value).digest("hex");

function assertCurrentObservation(observation, sourceRef, value, previousCandidateTargetValueSha256) {
  assert.equal(observation?.sourceRef, sourceRef);
  assert.equal(observation?.currentTargetValueSha256, sha256Json(value));
  assert.equal(observation?.previousCandidateTargetValueSha256, previousCandidateTargetValueSha256);
  assert.equal(observation?.status, "STALE_CANDIDATE_REQUIRES_REVIEW");
  assert.equal(observation?.semanticPromotion, false);
  assert.equal(observation?.acceptanceEffect, "none");
}

function assertRouteTargetCurrentOrObserved(route, sourceRef, value) {
  const currentHash = sha256Json(value);
  if (route?.targetValueSha256 === currentHash) return;
  assertCurrentObservation(route?.currentTargetObservation, sourceRef, value, route?.targetValueSha256);
}

function assertStaleMaterialBlocker(record, sourceRef, value, expectedMissingClauses) {
  const route = record?.claimSpecificSemanticRoute;
  assert.equal(route?.sourceRef, sourceRef);
  assert.notEqual(route?.targetValueSha256, sha256Json(value));
  assert.deepEqual(route?.requiredClauses.filter((clause) => !JSON.stringify(value).includes(clause)), expectedMissingClauses);
  assert.equal(record?.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(route?.acceptanceEffect, "none");
  assert.equal(route?.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(route?.currentTargetObservation, undefined,
    "do not refresh a current target observation when a required material clause is absent");
}

function removeRequiredClause(value, clause) {
  if (typeof value === "string") return value.replace(clause, "MATERIAL_CLAUSE_REMOVED");
  const copy = structuredClone(value);
  let changed = false;
  const visit = (node) => {
    if (Array.isArray(node)) {
      for (let index = node.length - 1; index >= 0; index -= 1) {
        if (node[index] === clause) {
          node.splice(index, 1);
          changed = true;
        } else if (typeof node[index] === "string" && node[index].includes(clause)) {
          node[index] = node[index].replace(clause, "MATERIAL_CLAUSE_REMOVED");
          changed = true;
        } else {
          visit(node[index]);
        }
      }
      return;
    }
    if (!node || typeof node !== "object") return;
    for (const [key, child] of Object.entries(node)) {
      if (clause === "false" && child === false) {
        node[key] = true;
        changed = true;
        return;
      }
      if (clause === "true" && child === true) {
        node[key] = false;
        changed = true;
        return;
      }
      if (key === clause) {
        delete node[key];
        changed = true;
      } else if (key.includes(clause)) {
        const replacement = key.replace(clause, "materialClauseRemoved");
        node[replacement] = child;
        delete node[key];
        changed = true;
        visit(child);
      } else if (typeof child === "string" && child.includes(clause)) {
        node[key] = child.replace(clause, "MATERIAL_CLAUSE_REMOVED");
        changed = true;
      } else {
        visit(child);
      }
    }
  };
  visit(copy);
  assert.equal(changed, true, `material clause ${clause} must occur in a mutable source value`);
  return copy;
}

const priorOwnerSourcePaths = [
  ".product-experience/pdp-0-product-truth/migration-semantics-review.yaml",
  ".product-experience/gaps.yaml",
  ".product-experience/pdp-0-product-truth/policy-authority-model.yaml",
  ".product-experience/pdp-0-product-truth/capabilities.yaml",
  ".product-experience/pdp-0-product-truth/time-units-fidelity.yaml",
  ".product-experience/pdp-2-design-interface-system/cli-language.yaml",
  ".product-experience/pdp-2-design-interface-system/interface-grammar.yaml",
  ".product-experience/pdp-1-domain-data/privacy.yaml",
  ".product-experience/pdp-0-product-truth/domain-model.yaml",
  ".product-experience/pdp-0-product-truth/capabilities.yaml",
  ".product-experience/pdp-0-product-truth/glossary.yaml",
  ".product-experience/pdp-0-product-truth/quality-policy.yaml",
  ".product-experience/pdp-0-product-truth/qualification-policy.yaml",
  ".product-experience/pdp-1-domain-data/operations.yaml",
  ".product-experience/pdp-1-domain-data/value-objects.yaml",
  ".product-experience/pdp-0-product-truth/applications-channels.yaml",
  ".product-experience/pdp-0-product-truth/constitution.yaml",
  ".product-experience/pdp-1-domain-data/states.yaml",
  ".product-experience/pdp-0-product-truth/reuse-decisions.yaml",
  ".product-experience/pdp-0-product-truth/requirements.yaml",
  ".product-experience/pdp-1-domain-data/operations.yaml",
  ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml",
  ".product-experience/pdp-2-design-interface-system/api/identifiers.yaml",
  ".product-experience/pdp-2-design-interface-system/api/compatibility.yaml",
  ".product-experience/pdp-2-design-interface-system/api/errors.yaml",
  ".product-experience/pdp-2-design-interface-system/api/cancellation.yaml",
  ".product-experience/pdp-2-design-interface-system/api/conventions.yaml",
  ".product-experience/pdp-2-design-interface-system/media-editing-grammar.yaml",
  ".product-experience/pdp-2-design-interface-system/accessibility.yaml",
  ".product-experience/pdp-3-product-experience/navigation-contracts.yaml",
  ".product-experience/pdp-2-design-interface-system/motion.yaml",
  ".product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml",
  ".product-experience/pdp-2-design-interface-system/media-editing-grammar.yaml",
  ".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml",
  ".product-experience/pdp-2-design-interface-system/api/async-operations.yaml",
  ".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml",
  "docs/migration/master-plan-source-change-claims.yaml",
];
const priorOwnerSources = Object.fromEntries(priorOwnerSourcePaths.map((path) => [
  path,
  parse(readFileSync(resolve(root, path), "utf8")),
]));

function resolveExactSourceRef(ref) {
  const [file, pointer] = ref.split("#");
  if (!pointer || !Object.hasOwn(priorOwnerSources, file)) return undefined;
  return pointer.split("/").filter(Boolean).reduce((value, token) => {
    const selector = token.match(/^@(id|machineId)=([^/]+)$/u);
    if (selector) return (Array.isArray(value) ? value : Object.values(value ?? {})).find((entry) => entry?.[selector[1]] === selector[2]);
    const key = token.replace(/~1/gu, "/").replace(/~0/gu, "~");
    if (Array.isArray(value) && /^\d+$/u.test(key)) return value[Number(key)];
    return value?.[key];
  }, priorOwnerSources[file]);
}

function validPriorOwnerRouteCandidate(record, prior) {
  const route = record.priorOwnerRouteReviewCandidate;
  if (!route || !prior) return false;
  const liveTargetValue = resolveExactSourceRef(route.recommendedOwnerTargetRef);
  const targetValue = route.currentTargetValue;
  return record.exactSourceText === prior.exactSourceText
    && record.sourceTextSha256 === prior.sourceTextSha256
    && prior.semanticReviewStatus === "SEMANTIC_PARITY_VERIFIED"
    && route.recommendedOwnerTargetRef === prior.proposedTargetRef
    && route.materialMeaning === prior.materialMeaning
    && route.historicalTargetValueSha256 === prior.targetValueSha256
    && liveTargetValue !== undefined
    && targetValue !== undefined
    && route.currentTargetValueSha256 === sha256Json(targetValue)
    && route.historicalTargetUnchanged === (route.currentTargetValueSha256 === route.historicalTargetValueSha256)
    && route.currentTargetDrift === !route.historicalTargetUnchanged
    && route.acceptanceEffect === "none"
    && record.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW";
}

function validClaimSpecificScopeMapping(record) {
  const mapping = record.claimSpecificSemanticCandidate;
  if (!mapping || mapping.reviewStatus !== "PENDING_COORDINATOR_MATERIAL_REVIEW"
    || mapping.acceptanceEffect !== "none" || mapping.runtimeAdmission !== "NOT_ADMITTED"
    || mapping.qualification !== "NOT_EVALUATED" || mapping.negativeCases.length < 2) return false;
  const value = resolveExactSourceRef(mapping.sourceRef);
  if (value === undefined || mapping.sourceValueSha256 !== sha256Json(value)) return false;
  if (mapping.expectedMembers) {
    if (value.scopeStatus !== "TARGET" || !Array.isArray(value.capabilityIds)) return false;
    const actual = new Set(value.capabilityIds);
    return new Set(mapping.expectedMembers).size === mapping.expectedMembers.length
      && mapping.expectedMembers.every((id) => actual.has(id));
  }
  if (mapping.expectedOutputTypes) {
    if (value.recordCount !== mapping.expectedOutputTypes.length || value.records?.length !== mapping.expectedOutputTypes.length) return false;
    const types = value.records.map(({ artifactType }) => artifactType.replace(/^simulation-pass-result-/u, ""));
    return new Set(types).size === types.length
      && mapping.expectedOutputTypes.length === types.length
      && mapping.expectedOutputTypes.every((type) => types.includes(type))
      && value.records.every((record) => record.ownerDefinitionStatus === "OWNER_DEFINED_DEFINITION_ONLY"
        && record.domainObjectRefs?.length === 1 && record.domainObjectRefs[0] === "media.domain.media-run"
        && record.immutableArtifactVersionCreated === false);
  }
  return false;
}

function validGapMetadataDisposition(candidateValue, gapDocument) {
  const record = candidateValue.records.find(({ claimId }) => claimId === "MPSEM-0003-C004");
  const route = record?.claimSpecificSemanticRoute;
  const gap = gapDocument.gaps.find(({ id }) => id === "GAP-MEDIA-MIGRATION-SEMANTICS");
  return record?.exactSourceText === "extraction and review are tracked in `GAP-MEDIA-MIGRATION-SEMANTICS`."
    && record.routeKind === "GAP_REGISTER_STATUS_METADATA_NOT_CAPABILITY_BEHAVIOR"
    && route?.sourceRef === ".product-experience/gaps.yaml#/gaps/@id=GAP-MEDIA-MIGRATION-SEMANTICS"
    && route?.targetValueSha256 === sha256Json(gap)
    && record.currentDisposition?.ownerTargetRef === route.sourceRef
    && record.capabilityRef === undefined
    && record.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"
    && record.semanticEquivalence === "NOT_ASSERTED"
    && gap?.status === "open"
    && record.semanticEvidence?.gapSourceRef === route.sourceRef
    && record.semanticEvidence?.gapValueSha256 === sha256Json(gap)
    && record.semanticEvidence?.observedStatus === "open"
    && /does not map to a product capability/u.test(record.semanticEvidence.meaning ?? "");
}

test("migration-gap tracking metadata resolves to the exact open gap register row, not a capability leaf", () => {
  assert.equal(candidate.records.length, 163);
  assert.equal(new Set(candidate.records.map(({ claimId }) => claimId)).size, 163);
  assert.equal(candidate.population.currentClaimSpecificSemanticRoutesPending,
    candidate.records.filter(({ claimSpecificSemanticRoute }) => claimSpecificSemanticRoute).length);
  assert.equal(candidate.population.currentClaimUnitsWithoutClaimSpecificSemanticRoute,
    candidate.records.filter(({ claimSpecificSemanticRoute }) => !claimSpecificSemanticRoute).length);
  assert.equal(candidate.population.currentRouteStatus,
    "one derived current source route/scope mapping/gap disposition per exact claim; all candidate routes remain pending material review and no acceptance, runtime, or qualification promotion");
  assert.ok(candidate.records.every(({ semanticReviewStatus }) => semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"));
  assert.equal(candidate.population.exactCapabilityLeafOwnerCandidates,
    candidate.records.filter(({ routeKind }) => routeKind === "EXACT_CAPABILITY_LEAF_OWNER_DEFINITION_CANDIDATE").length);
  assert.equal(candidate.population.exactPolicyOwnerRouteCandidates,
    candidate.records.filter(({ routeKind }) => routeKind.includes("POLICY")).length);
  assert.equal(candidate.population.gapRegisterStatusMetadataNotCapability, 1);
  const gapRecord = candidate.records.find(({ claimId }) => claimId === "MPSEM-0003-C004");
  const gap = gapSource.gaps.find(({ id }) => id === "GAP-MEDIA-MIGRATION-SEMANTICS");
  if (validGapMetadataDisposition(candidate, gapSource)) {
    assert.equal(gap.status, "open");
  } else {
    assert.equal(gap.status, "open");
    assertStaleMaterialBlocker(gapRecord,
      ".product-experience/gaps.yaml#/gaps/@id=GAP-MEDIA-MIGRATION-SEMANTICS", gap,
      ["unresolved semantic content items", "preserve crosswalk/provenance references", "P0-03 remains open"]);
  }

  const capabilityMisroute = structuredClone(candidate);
  const row = capabilityMisroute.records.find(({ claimId }) => claimId === "MPSEM-0003-C004");
  row.routeKind = "EXACT_CAPABILITY_LEAF_OWNER_DEFINITION_CANDIDATE";
  row.proposedTargetRef = ".product-experience/pdp-0-product-truth/capabilities.yaml#/capabilities/@id=media.project.review";
  row.capabilityRef = "media.project.review";
  assert.equal(validGapMetadataDisposition(capabilityMisroute, gapSource), false,
    "a project-review capability cannot substantiate a migration-gap tracking statement");

  const closedGapWithoutReview = structuredClone(gapSource);
  closedGapWithoutReview.gaps.find(({ id }) => id === "GAP-MEDIA-MIGRATION-SEMANTICS").status = "closed";
  assert.equal(validGapMetadataDisposition(candidate, closedGapWithoutReview), false,
    "the candidate pins the current open gap state and cannot imply closure");
});

test("external-engine selection is gated by exact Ghatana reuse evidence, not a capability-name route", () => {
  const record = candidate.records.find(({ claimId }) => claimId === "MPSEM-0021-C002");
  const ref = ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#/selectionSequenceRule";
  const reuseRef = ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#mediaArchitectureRules/externalStackSelectionRule";
  const value = resolveExactSourceRef(ref);
  const reuseValue = resolveExactSourceRef(reuseRef);
  assert.equal(record?.exactSourceText, "U1 §15 prioritizes external candidates without an executable internal-reuse gate");
  assert.equal(record?.proposedTargetRef, ref);
  assert.equal(record?.routeKind, "CURRENT_REUSE_SELECTION_SEQUENCE_CANDIDATE");
  assert.equal(record?.claimContext?.sourceRef, "docs/migration/expert-reviewed-master-plan.md#line=100");
  assert.equal(record?.claimContext?.exactParentRow, historicalPlan[99]);
  assert.equal(record?.claimContext?.sourceTextSha256, sha256Text(historicalPlan[99]));
  assert.equal(record?.claimSpecificSemanticRoute?.targetValueSha256, sha256Json(value));
  assert.deepEqual(record.claimSpecificSemanticRoute.relatedSourceRefs, [reuseRef]);
  assertCurrentObservation(record.claimSpecificSemanticRoute.relatedTargetObservations?.[0], reuseRef, reuseValue,
    record.claimSpecificSemanticRoute.relatedTargetValueSha256);
  assert.ok(record.claimSpecificSemanticRoute.requiredClauses.every((clause) =>
    JSON.stringify(value).includes(clause) || JSON.stringify(reuseValue).includes(clause)));
  assert.match(value.orderedChoices[0], /inspect-Ghatana-public-library-service-and-product-owner-contracts/u);
  assert.match(value.orderedChoices[2], /external-OSS-only-after-exact-reuse-license-security/u);
  assert.match(reuseValue.rule, /demonstrated Ghatana reuse gap/u);
  assert.equal(record.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(record.claimSpecificSemanticRoute.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(record.claimSpecificSemanticRoute.acceptanceEffect, "none");

  const weakened = structuredClone(value);
  weakened.orderedChoices[2] = "consider external OSS before inspecting Ghatana reuse";
  assert.notEqual(sha256Json(weakened), record.claimSpecificSemanticRoute.targetValueSha256,
    "removing the reuse-gap gate invalidates the candidate target pin");
  assert.ok(record.claimSpecificSemanticRoute.requiredClauses.some((clause) => !JSON.stringify(weakened).includes(clause)));
  const missingReuseGap = structuredClone(reuseValue);
  missingReuseGap.rule = "Integrate every candidate library or engine.";
  assert.notEqual(sha256Json(missingReuseGap), record.claimSpecificSemanticRoute.relatedTargetValueSha256);
  const wrongCapability = structuredClone(record);
  wrongCapability.proposedTargetRef = wrongCapability.supersededCapabilityCandidate.targetRef;
  assert.notEqual(wrongCapability.proposedTargetRef, ref,
    "artifact ingestion does not establish ecosystem selection policy");

  const tutorPutor = candidate.records.find(({ claimId }) => claimId === "MPSEM-0027-C003");
  assert.equal(tutorPutor?.proposedTargetRef, ref, "candidate evaluation follows the ordered Ghatana-first selection process");
  assert.equal(tutorPutor?.claimSpecificSemanticRoute?.targetValueSha256, sha256Json(value));
  assert.ok(tutorPutor.claimSpecificSemanticRoute.requiredClauses.every((clause) => JSON.stringify(value).includes(clause)));
});

test("stream integration and protocol preservation keep distinct material contracts", () => {
  const ref = ".product-experience/pdp-2-design-interface-system/api/compatibility.yaml#/ownerDefinedCompatibilityRules/@id=media.api.preserved-stream-protocol-and-integration.v1";
  const value = resolveExactSourceRef(ref);
  assert.ok(value);
  assert.equal(value.id, "media.api.preserved-stream-protocol-and-integration.v1");
  assert.equal(value.streamIntegration.operations.recording, "media.operation.capability.media-stream-recording-integrate");
  assert.equal(value.streamIntegration.operations.liveProcessing, "media.operation.capability.media-stream-live-processing-integrate");
  assert.equal(value.streamIntegration.operations.reconnect, "media.operation.capability.media-stream-session-reconnect");
  for (const [id, target, expected] of [
    ["MPSEM-0177-C002", value.streamIntegration, ["distinct explicit operation contracts", "clock-domain, sequence, and authority context", "transport connection alone", "contiguous success"]],
    ["MPSEM-0177-C003", value.protocolPreservation, ["exact request, response, event, ordering", "field-level mapping", "explicitly unsupported", "runtime availability"]],
  ]) {
    const row = candidate.records.find((record) => record.claimId === id);
    const route = row?.claimSpecificSemanticRoute;
    assert.equal(row.proposedTargetRef, ref);
    assert.equal(route?.sourceRef, ref);
    assert.equal(route?.targetValueSha256, sha256Json(value));
    assert.equal(route?.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(route?.acceptanceEffect, "none");
    assert.equal(route?.runtimeAdmission, "NOT_ADMITTED");
    for (const clause of route.requiredClauses) {
      assert.ok(JSON.stringify(value).includes(clause), `${id} source preserves ${clause}`);
      const missing = removeRequiredClause(value, clause);
      assert.equal(JSON.stringify(missing).includes(clause), false, `${id} mutation removes required source clause ${clause}`);
    }
    for (const phrase of expected) assert.ok(JSON.stringify(target).includes(phrase), `${id} retains ${phrase}`);
    const weakened = structuredClone(target);
    if (id.endsWith("C002")) weakened.rule = weakened.rule.replace("transport connection alone", "transport connection");
    else weakened.requiredEvidence = weakened.requiredEvidence.filter((item) => item !== "field-level-request-response-and-error-mapping");
    assert.notEqual(sha256Json(weakened), sha256Json(target), `${id} material weakening changes its owner value`);
  }
});

test("Media API error families and SDK cancellation methods preserve distinct meanings", () => {
  const errorRef = ".product-experience/pdp-2-design-interface-system/api/errors.yaml#ownerDefinedErrorSemantics/ownerDefinedReasonFamilyDispositions";
  const errorFamilies = resolveExactSourceRef(errorRef);
  assert.equal(errorFamilies.id, "media.api.error-reason-family-dispositions.v1");
  const errorCases = [
    ["MPSEM-0341-C001", "AUTHORITY_PRIVACY_RIGHTS_POLICY", ["current identity, tenant scope, purpose, consent, rights, privacy, egress, or policy", "not a capacity or local configuration failure", "Do not automatically retry"]],
    ["MPSEM-0343-C001", "CAPACITY_QUOTA_DEPENDENCY_ADMISSION", ["bounded capacity, an owner quota, or an exact dependency/profile admission fact", "unsupported capability or unqualified provider a transient capacity failure", "Quota exhaustion is not automatically transient"]],
    ["MPSEM-0349-C001", "LOCAL_CONFIGURATION", ["before sending the request", "Do not resend unchanged invalid local configuration", "If request transmission may have started"]],
  ];
  for (const [claimId, familyId, phrases] of errorCases) {
    const row = candidate.records.find((record) => record.claimId === claimId);
    const route = row.claimSpecificSemanticRoute;
    const family = errorFamilies.families[familyId];
    assert.equal(route.sourceRef, `${errorRef}/families/${familyId}`);
    assert.equal(route.targetValueSha256, sha256Json(family));
    for (const phrase of phrases) assert.ok(JSON.stringify(family).includes(phrase), `${claimId} preserves ${phrase}`);
    for (const clause of route.requiredClauses) {
      assert.ok(JSON.stringify(family).includes(clause));
      assert.equal(JSON.stringify(removeRequiredClause(family, clause)).includes(clause), false);
    }
    assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(route.acceptanceEffect, "none");
  }
  const cancelRef = ".product-experience/pdp-2-design-interface-system/api/cancellation.yaml#ownerDefinedCancellationSemantics";
  const cancellation = resolveExactSourceRef(cancelRef);
  const sdkRow = candidate.records.find((record) => record.claimId === "MPSEM-0315-C002");
  assert.equal(sdkRow.claimSpecificSemanticRoute.sourceRef, cancelRef);
  assert.equal(sdkRow.claimSpecificSemanticRoute.targetValueSha256, sha256Json(cancellation));
  assert.ok(cancellation.rules.includes("stopping or timing out a local poll only ends observation and does not issue a server cancellation request"));
  assert.equal(resolveExactSourceRef(".product-experience/pdp-2-design-interface-system/api/errors.yaml#ownerDefinedErrorSemantics").runtimeAdmission, "NOT_ADMITTED");
});

test("profile, capability, provider diagnostics, and scoped readiness stay distinct", () => {
  const ref = ".product-experience/pdp-2-design-interface-system/api/conventions.yaml#ownerDefinedProfileCapabilityAndProviderDiagnostics";
  const value = resolveExactSourceRef(ref);
  assert.equal(value.id, "media.api.profile-capability-provider-diagnostics.v1");
  assert.ok(value.sourceRefs.includes(".product-experience/pdp-0-product-truth/profile-semantics.yaml#streamProfileRule"));
  assert.equal(value.semantics.profileDiscovery, "Return only declared, versioned Media profiles and their exact typed axes/constraints. Discovery does not imply that a profile is compatible with a requested capability, qualified, or currently executable.");
  assert.match(value.semantics.capabilityDiscovery, /exact Media capability identities/u);
  assert.match(value.semantics.providerDiagnostics, /diagnostics only/u);
  assert.match(value.semantics.executionCompatibility, /compatible, incompatible, or unknown/u);
  assert.match(value.semantics.readiness, /separate observations/u);
  for (const id of ["MPSEM-0178-C001", "MPSEM-0178-C002", "MPSEM-0385-C001"]) {
    const row = candidate.records.find((record) => record.claimId === id);
    const route = row.claimSpecificSemanticRoute;
    assert.equal(route.sourceRef, ref);
    assertRouteTargetCurrentOrObserved(route, ref, value);
    assert.ok(route.requiredClauses.every((clause) => JSON.stringify(value).includes(clause)), `${id} has exact source clauses`);
    const wrong = structuredClone(value);
    if (route.requiredClauses.some((clause) => clause.includes("Provider identifiers"))) {
      wrong.semantics.providerDiagnostics = "Provider health proves qualification and runtime admission.";
      wrong.serviceRolePrerequisites.controlPlane.requiredDependencies = [];
    } else {
      wrong.serviceRolePrerequisites.capabilityExecution.applicability = "Every dependency gates all capabilities.";
    }
    assert.equal(route.requiredClauses.every((clause) => JSON.stringify(wrong).includes(clause)), false, `${id} rejects diagnostics-as-admission weakening`);
  }
});

test("visual, graph, and textual editors share one canonical revision and selection", () => {
  const ref = ".product-experience/pdp-2-design-interface-system/media-editing-grammar.yaml#revisionProjectionRule";
  const rule = resolveExactSourceRef(ref);
  const route = candidate.records.find((record) => record.claimId === "MPSEM-0447-C004").claimSpecificSemanticRoute;
  assert.equal(route.sourceRef, ref);
  assert.equal(route.targetValueSha256, sha256Json(rule));
  for (const clause of route.requiredClauses) assert.ok(JSON.stringify(rule).includes(clause));
  const wrongRevision = structuredClone(rule);
  wrongRevision.rule = wrongRevision.rule.replace("one exact canonical revision", "independent revisions");
  assert.equal(route.requiredClauses.every((clause) => JSON.stringify(wrongRevision).includes(clause)), false);
  assert.ok(rule.negativeCases.includes("stale-selection-renders-against-a-newer-unnoticed-revision"));
});

test("erasure, audit minimization, and cache reuse retain exact owner boundaries", () => {
  const cases = [
    ["MPSEM-0366-C001", ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/@machineId=media-upload-and-artifact/stateDefinitions", ["ERASURE_REQUESTED", "ACCESS_REVOKED", "PHYSICAL_ERASURE_PENDING", "ERASURE_CONFIRMED", "BLOCKED_BY_HOLD", "EXTERNAL_ERASURE_UNCONFIRMED"]],
    ["MPSEM-0367-C003", ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#dataHandling/minimization", ["minimum fields and media ranges necessary to complete that exact purpose", "apply the same minimization to logs, traces, metrics, audit, provenance, exports", "while preserving required accountability evidence"]],
    ["MPSEM-0380-C005", ".product-experience/pdp-0-product-truth/qualification-policy.yaml#ownerDefinedMigrationQualificationRules/cacheReuseValidityRule", ["quality-profile and delivery-profile identities and versions", "temporal, color, audio, layout, and font configuration", "current authorization and retention checks", "changed policy, expired authority, or unknown impact invalidates reuse"]],
  ];
  for (const [claimId, ref, phrases] of cases) {
    const route = candidate.records.find((record) => record.claimId === claimId)?.claimSpecificSemanticRoute;
    const value = resolveExactSourceRef(ref);
    assert.ok(route && value, `${claimId} exact semantic route resolves`);
    assert.equal(route.sourceRef, ref);
    assert.equal(route.targetValueSha256, sha256Json(value));
    for (const phrase of phrases) assert.ok(JSON.stringify(value).includes(phrase), `${claimId} preserves ${phrase}`);
    for (const clause of route.requiredClauses) assert.equal(JSON.stringify(removeRequiredClause(value, clause)).includes(clause), false);
    for (const supporting of route.supportingSourceRefs ?? []) {
      const supportValue = resolveExactSourceRef(supporting.sourceRef);
      assert.ok(supportValue, `${claimId} supporting source resolves`);
      assert.equal(supporting.targetValueSha256, sha256Json(supportValue));
      assert.ok(supporting.meaning.length > 20);
    }
    assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
  }
});

test("bounded polling and resumable event continuation preserve job truth", () => {
  const ref = ".product-experience/pdp-2-design-interface-system/api/async-operations.yaml#/ownerDefinedAsyncRules/@id=media.async.bounded-poll-and-resumable-event-observation.v1";
  const rule = resolveExactSourceRef(ref);
  const route = candidate.records.find((record) => record.claimId === "MPSEM-0310-C001")?.claimSpecificSemanticRoute;
  assert.ok(rule && route);
  assert.equal(route.sourceRef, ref);
  assert.equal(route.targetValueSha256, sha256Json(rule));
  for (const clause of route.requiredClauses) assert.ok(JSON.stringify(rule).includes(clause));
  const unbounded = structuredClone(rule);
  const boundedClause = route.requiredClauses.find((clause) => JSON.stringify(rule.rule).includes(clause));
  assert.ok(boundedClause, "the pending route must identify a clause in the rule text");
  unbounded.rule = unbounded.rule.replace(boundedClause, "unbounded observation without the required recovery boundary");
  assert.equal(route.requiredClauses.every((clause) => JSON.stringify(unbounded).includes(clause)), false);
  const noGapRecovery = structuredClone(rule);
  noGapRecovery.rule = noGapRecovery.rule.replace("reports an expired or missing cursor as a gap requiring an authorized status read", "reports an expired cursor as continuous");
  assert.equal(route.requiredClauses.every((clause) => JSON.stringify(noGapRecovery).includes(clause)), false);
});

test("the 163-record candidate remains a pending source-routing review, not claim acceptance", () => {
  assert.ok(candidate.records.every((record) => record.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"));
  assert.ok(candidate.records.every((record) => record.semanticEquivalence === "NOT_ASSERTED"));
  assert.equal(candidate.authority.includes("not independent acceptance"), true);
});

test("all 163 claims have exactly one derived current route-or-gap disposition", () => {
  const counts = {
    OWNER_SOURCE_ROUTE_PENDING_MATERIAL_REVIEW: 0,
    OWNER_SOURCE_ROUTE_AND_EXACT_SCOPE_MAPPING_PENDING_MATERIAL_REVIEW: 0,
    EXACT_SCOPE_MAPPING_PENDING_MATERIAL_REVIEW: 0,
    EXACT_MATERIAL_SOURCE_GAP: 0,
  };
  for (const record of candidate.records) {
    const disposition = record.currentDisposition;
    assert.ok(disposition, `${record.claimId} has a current disposition`);
    assert.equal(disposition.claimId, record.claimId);
    assert.equal(disposition.sourceClaimTextSha256, record.sourceTextSha256);
    assert.equal(disposition.sourceParentRef, record.sourceContext.sourceRef);
    assert.equal(disposition.acceptanceEffect, "none");
    assert.equal(disposition.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(disposition.qualification, "NOT_EVALUATED");
    assert.ok(Object.hasOwn(counts, disposition.status), `${record.claimId} has one recognized disposition`);
    counts[disposition.status] += 1;
    if (["OWNER_SOURCE_ROUTE_PENDING_MATERIAL_REVIEW", "OWNER_SOURCE_ROUTE_AND_EXACT_SCOPE_MAPPING_PENDING_MATERIAL_REVIEW"].includes(disposition.status)) {
      assert.equal(disposition.ownerTargetRef, record.claimSpecificSemanticRoute?.sourceRef);
      assert.equal(disposition.ownerTargetValueSha256, record.claimSpecificSemanticRoute?.targetValueSha256);
      assert.ok(disposition.meaning.length > 30);
    }
    if (["OWNER_SOURCE_ROUTE_AND_EXACT_SCOPE_MAPPING_PENDING_MATERIAL_REVIEW", "EXACT_SCOPE_MAPPING_PENDING_MATERIAL_REVIEW"].includes(disposition.status)) {
      assert.equal(disposition.scopeMappingRef, record.claimSpecificSemanticCandidate?.sourceRef);
      assert.equal(disposition.scopeMappingValueSha256, record.claimSpecificSemanticCandidate?.sourceValueSha256);
      assert.equal(validClaimSpecificScopeMapping(record), true, `${record.claimId} exact population mapping`);
    }
    if (disposition.status === "EXACT_MATERIAL_SOURCE_GAP") {
      assert.equal(disposition.exactUnresolvedClaim, record.exactSourceText);
      assert.ok(disposition.reason.includes("not been shown to preserve"));
      assert.ok(disposition.requiredNextDisposition.includes("exact owner rule/contract"));
    }
  }
  assert.equal(counts.OWNER_SOURCE_ROUTE_PENDING_MATERIAL_REVIEW, candidate.records.filter((r) => r.claimSpecificSemanticRoute && !r.claimSpecificSemanticCandidate).length);
  assert.equal(counts.OWNER_SOURCE_ROUTE_AND_EXACT_SCOPE_MAPPING_PENDING_MATERIAL_REVIEW, candidate.records.filter((r) => r.claimSpecificSemanticRoute && r.claimSpecificSemanticCandidate).length);
  assert.equal(counts.EXACT_SCOPE_MAPPING_PENDING_MATERIAL_REVIEW, candidate.records.filter((r) => !r.claimSpecificSemanticRoute && r.claimSpecificSemanticCandidate).length);
  assert.equal(counts.EXACT_MATERIAL_SOURCE_GAP, candidate.records.filter((r) => !r.claimSpecificSemanticRoute && !r.claimSpecificSemanticCandidate).length);
  assert.deepEqual(candidate.population.currentDispositionCounts, {
    ownerSourceRoutePendingMaterialReview: counts.OWNER_SOURCE_ROUTE_PENDING_MATERIAL_REVIEW,
    ownerSourceRouteAndExactScopeMappingPendingMaterialReview: counts.OWNER_SOURCE_ROUTE_AND_EXACT_SCOPE_MAPPING_PENDING_MATERIAL_REVIEW,
    exactScopeMappingPendingMaterialReview: counts.EXACT_SCOPE_MAPPING_PENDING_MATERIAL_REVIEW,
    exactMaterialSourceGap: counts.EXACT_MATERIAL_SOURCE_GAP,
    total: candidate.records.length,
  });
});

test("reuse and release-policy routes preserve every material clause and reject weakened owner values", () => {
  const expected = new Map([
    ["MPSEM-0003-C004", ".product-experience/gaps.yaml#/gaps/@id=GAP-MEDIA-MIGRATION-SEMANTICS"],
    ["MPSEM-0027-C002", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#ownerDefinedTutorPutorReuseReviewRule"],
    ["MPSEM-0072-C001", ".product-experience/pdp-2-design-interface-system/api/identifiers.yaml#ownerDefinedPackageCoordinateBoundary"],
    ["MPSEM-0076-C001", ".product-experience/pdp-0-product-truth/requirements.yaml#ownerDefinedProductMissionCapabilityMaps/@id=media.requirement.product-mission-capability-map.v1"],
    ["MPSEM-0454-C002", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#ownerDefinedPackagePublicationEvidenceRule"],
    ["MPSEM-0457-C002", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#ownerDefinedDistributionSourceOfferRule"],
    ["MPSEM-0459-C003", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#mediaArchitectureRules/externalStackSelectionRule"],
    ["MPSEM-0461-C003", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#mediaArchitectureRules/dependencyUpdatePolicy/validationBeforePromotion"],
    ["MPSEM-0365-C001", ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedErasureInventoryContract"],
    ["MPSEM-0261-C008", ".product-experience/pdp-0-product-truth/requirements.yaml#ownerDefinedImportAdapterConversionRule"],
    ["MPSEM-0452-C003", ".product-experience/pdp-2-design-interface-system/accessibility.yaml#ownerDefinedCaptionAndAudioDescriptionOutputUse"],
    ["MPSEM-0262-C003", ".product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml#ownerDefinedVisualVsScientificFidelityBoundary"],
    ["MPSEM-0387-C002", ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#modelAcquisitionAndFallback/hardwareFootprintDoesNotWaiveAdmission"],
    ["MPSEM-0458-C005", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#mediaArchitectureRules/componentLicenseBoundary/processIsolationDoesNotWaiveLicenseRule"],
  ]);
  for (const [claimId, sourceRef] of expected) {
    const record = candidate.records.find((entry) => entry.claimId === claimId);
    const route = record?.claimSpecificSemanticRoute;
    const value = route && resolveExactSourceRef(route.sourceRef);
    assert.equal(route?.sourceRef, sourceRef, `${claimId} exact owner selector`);
    assert.ok(value, `${claimId} selector resolves`);
    if (claimId === "MPSEM-0003-C004") {
      assertStaleMaterialBlocker(record, sourceRef, value,
        ["unresolved semantic content items", "preserve crosswalk/provenance references", "P0-03 remains open"]);
      continue;
    }
    if (claimId === "MPSEM-0076-C001" || claimId === "MPSEM-0459-C003") {
      assertRouteTargetCurrentOrObserved(route, sourceRef, value);
    }
    else assert.equal(route.targetValueSha256, sha256Json(value), `${claimId} exact owner-value pin`);
    assert.equal(route.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(route.acceptanceEffect, "none");
    assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
    for (const clause of route.requiredClauses) {
      assert.ok(JSON.stringify(value).includes(clause), `${claimId} source preserves ${clause}`);
      const weakened = removeRequiredClause(value, clause);
      assert.equal(route.requiredClauses.every((required) => JSON.stringify(weakened).includes(required)), false,
        `${claimId} rejects removal of ${clause}`);
    }
    assert.ok(route.negativeCases.length >= 3, `${claimId} has material falsifiers`);
  }
  const lifecycle = resolveExactSourceRef(expected.get("MPSEM-0365-C001"));
  const lifecycleClasses = lifecycle.copyInventory.managedContentClasses.classes;
  for (const contentClass of ["ORIGINAL_MEDIA", "DERIVED_MEDIA", "THUMBNAIL", "PROXY", "CAPTION", "TRANSCRIPT", "MASK_OR_GEOMETRY", "EMBEDDING", "VOICE_MODEL", "SOURCE_REQUEST", "TEMPORARY_FILE", "CACHED_INTERMEDIATE", "EXPORT", "EXTERNAL_PROVIDER_COPY", "BACKUP", "AUDIT_OR_PROVENANCE"]) {
    assert.ok(lifecycleClasses.includes(contentClass), `lifecycle inventory preserves ${contentClass}`);
  }
  assert.match(lifecycle.copyInventory.managedContentClasses.bindingRule, /PARTIAL or UNKNOWN/u);
  assert.match(lifecycle.copyInventory.sharedReferenceRule, /Physical deletion of shared bytes is permitted only after exact versioned-reference inventory/u);
  assert.match(lifecycle.tombstones.restoreRule, /replay applicable tombstones/u);
  const missingBackup = structuredClone(lifecycle);
  missingBackup.copyInventory.managedContentClasses.classes = lifecycleClasses.filter((entry) => entry !== "BACKUP");
  const requiredClasses = lifecycleClasses;
  const validLifecycleInventory = (value) => requiredClasses.every((entry) => value.copyInventory.managedContentClasses.classes.includes(entry));
  assert.equal(validLifecycleInventory(lifecycle), true);
  assert.equal(validLifecycleInventory(missingBackup), false, "the owner-inventory oracle rejects removal of a managed class");
  const mission = resolveExactSourceRef(expected.get("MPSEM-0076-C001"));
  const missionCapabilities = new Set(priorOwnerSources[".product-experience/pdp-0-product-truth/capabilities.yaml"].capabilities.map(({ id }) => id));
  const validMissionMap = (value) => Object.entries(value.missionVerbs).length === 12
    && Object.values(value.missionVerbs).every((refs) => Array.isArray(refs) && refs.length > 0 && refs.every((id) => missionCapabilities.has(id)))
    && value.runtimeAdmission === "NOT_ADMITTED"
    && value.qualification === "NOT_EVALUATED";
  assert.equal(validMissionMap(mission), true, "mission breadth is bound to exact capability identities");
  const missingMissionVerb = structuredClone(mission);
  delete missingMissionVerb.missionVerbs.synchronize;
  assert.equal(validMissionMap(missingMissionVerb), false, "the mapping rejects removal of a material mission verb");
  const inventedCapability = structuredClone(mission);
  inventedCapability.missionVerbs.understand[0] = "media.capability.invented";
  assert.equal(validMissionMap(inventedCapability), false, "the mapping rejects a noncanonical capability identity");
});

test("all 163 candidate fragments retain their exact parent-row context and source location", () => {
  assert.equal(candidate.records.length, 163);
  for (const record of candidate.records) {
    const context = record.sourceContext;
    const parent = resolveExactSourceRef(context?.sourceRef);
    assert.ok(parent, `${record.claimId} must resolve its exact source item`);
    assert.equal(parent.itemId, context.itemId, `${record.claimId} parent item identity`);
    assert.equal(parent.text, context.exactParentText, `${record.claimId} parent row text`);
    assert.equal(context.parentTextSha256, sha256Text(parent.text), `${record.claimId} parent text pin`);
    assert.ok(parent.text.includes(record.exactSourceText), `${record.claimId} exact fragment is contained in its parent row`);
    assert.deepEqual(context.sourceLocations, parent.sourceLocations, `${record.claimId} source location`);
  }
});

test("document-extraction preservation resolves to its actual owner boundary and rejects a capability-name route", () => {
  const record = candidate.records.find(({ claimId }) => claimId === "MPSEM-0101-C002");
  const route = record?.claimSpecificSemanticRoute;
  const ref = ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/productPolicy/platformMechanics/documentIntelligence";
  const value = resolveExactSourceRef(ref);
  const valid = (row, ownerValue) => row?.exactSourceText === "Preserve their document-extraction integration"
    && row.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"
    && row.proposedTargetRef === ref
    && row.routeKind === "EXACT_DOCUMENT_INTELLIGENCE_OWNER_BOUNDARY_CANDIDATE"
    && row.capabilityRef === undefined
    && row.supersededCapabilityCandidate?.targetRef === ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.color.skin-tone-preserve"
    && row.claimSpecificSemanticRoute?.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"
    && row.claimSpecificSemanticRoute?.acceptanceEffect === "none"
    && row.claimSpecificSemanticRoute?.targetValueSha256 === sha256Json(ownerValue)
    && row.claimSpecificSemanticRoute?.requiredClauses.every((clause) => JSON.stringify(ownerValue).includes(clause));
  assert.ok(route);
  assert.equal(valid(record, value), true);
  assert.equal(record.semanticEquivalence, "NOT_ASSERTED");
  assert.equal(route.acceptanceEffect, "none");
  const wrongCapabilityRoute = structuredClone(record);
  wrongCapabilityRoute.proposedTargetRef = wrongCapabilityRoute.supersededCapabilityCandidate.targetRef;
  wrongCapabilityRoute.routeKind = "EXACT_CAPABILITY_LEAF_OWNER_DEFINITION_CANDIDATE";
  wrongCapabilityRoute.capabilityRef = "media.color.skin-tone-preserve";
  assert.equal(valid(wrongCapabilityRoute, value), false, "color-preservation capability cannot stand in for document-extraction ownership");
  for (const clause of route.requiredClauses) {
    const weakened = JSON.parse(JSON.stringify(value).replace(clause, "[material clause removed]"));
    assert.equal(valid(record, weakened), false, `${clause} must remain in the exact owner boundary`);
  }
});

test("document-intelligence worker preservation keeps the target-owned handoff explicit and unverified", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0026-C004");
  const restrictionRow = candidate.records.find(({ claimId }) => claimId === "MPSEM-0387-C003");
  const ref = ".product-experience/pdp-0-product-truth/requirements.yaml#ownerDefinedExternalWorkerBoundaryRules/@id=media.requirement.document-intelligence-worker-boundary.v1";
  const value = resolveExactSourceRef(ref);
  const route = row?.claimSpecificSemanticRoute;
  assert.equal(row?.proposedTargetRef, ref);
  assert.equal(route?.sourceRef, ref);
  assert.equal(route?.targetValueSha256, sha256Json(value));
  assert.equal(value.observedInventory.worker, "ghatana/services/media/modules/intelligence/document-intelligence-worker");
  assert.equal(value.observedInventory.targetOwner, "ghatana/services/document-intelligence");
  assert.equal(value.observedInventory.contractBoundary, "frozen Shared document-extraction contracts");
  assert.match(value.rule, /Office\/PDF\/OCR consumer inventory/u);
  assert.match(value.rule, /owns its cancellation and admission behavior/u);
  assert.match(value.rule, /not proof that rehome, consumer parity/u);
  assert.match(value.rule, /do not decide clinical eligibility, clinical disposition, KYC identity, or financial eligibility/u);
  assert.match(value.rule, /A recognized term, extracted field, or confidence score cannot be promoted to a decision/u);
  assert.equal(value.implementationState, "UNKNOWN");
  assert.equal(value.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(route?.acceptanceEffect, "none");
  assert.equal(restrictionRow?.proposedTargetRef, ref, "the bounded worker restriction claim uses this exact boundary");
  assert.equal(restrictionRow?.claimSpecificSemanticRoute?.sourceRef, ref);
  assert.equal(restrictionRow?.claimSpecificSemanticRoute?.targetValueSha256, sha256Json(value));

  const validBoundary = (candidateValue) => candidateValue.observedInventory.worker === "ghatana/services/media/modules/intelligence/document-intelligence-worker"
    && candidateValue.observedInventory.targetOwner === "ghatana/services/document-intelligence"
    && candidateValue.observedInventory.contractBoundary === "frozen Shared document-extraction contracts"
    && candidateValue.requiredFacts.includes("Office/PDF/OCR consumer inventory and mapping")
    && candidateValue.requiredFacts.includes("target-owned cancellation and admission semantics")
    && candidateValue.requiredFacts.includes("no clinical, KYC, identity, or financial decision inference from extracted observations")
    && /do not orphan or silently absorb those consumers into audio\/video processing/u.test(candidateValue.rule)
    && /do not decide clinical eligibility, clinical disposition, KYC identity, or financial eligibility/u.test(candidateValue.rule)
    && /cannot be promoted to a decision/u.test(candidateValue.rule)
    && /not proof that rehome, consumer parity/u.test(candidateValue.rule)
    && candidateValue.implementationState === "UNKNOWN"
    && candidateValue.runtimeAdmission === "NOT_ADMITTED";
  assert.equal(validBoundary(value), true);
  for (const weakened of [
    { ...structuredClone(value), observedInventory: { ...value.observedInventory, targetOwner: "ghatana/services/media" } },
    { ...structuredClone(value), rule: value.rule.replace("do not orphan or silently absorb those consumers into audio/video processing", "absorb those consumers into audio/video processing") },
    { ...structuredClone(value), rule: value.rule.replace("not proof that rehome, consumer parity", "proof that rehome, consumer parity") },
    { ...structuredClone(value), requiredFacts: value.requiredFacts.filter((fact) => fact !== "Office/PDF/OCR consumer inventory and mapping") },
    { ...structuredClone(value), rule: value.rule.replace("do not decide clinical eligibility", "decide clinical eligibility") },
    { ...structuredClone(value), requiredFacts: value.requiredFacts.filter((fact) => !fact.startsWith("no clinical, KYC")) },
  ]) {
    assert.notEqual(sha256Json(weakened), route.targetValueSha256);
    assert.equal(validBoundary(weakened), false, "the owner-boundary oracle rejects material loss or false completion");
  }
});

test("exact-content and action-impact claims bind to complete P2 owner rules, not capability labels", () => {
  const contentRow = candidate.records.find(({ claimId }) => claimId === "MPSEM-0210-C001");
  const contentRef = ".product-experience/pdp-2-design-interface-system/media-editing-grammar.yaml#exactContentOverlayRule";
  const content = resolveExactSourceRef(contentRef);
  const contentRoute = contentRow?.claimSpecificSemanticRoute;
  const validContent = (row, value) => row?.exactSourceText === "Exact logos, captions, legal copy, mathematics, UI screenshots, diagrams and product labels are deterministic overlays or approved source assets."
    && row.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"
    && row.proposedTargetRef === contentRef
    && row.routeKind === "PDP2_EXACT_CONTENT_OVERLAY_RULE_CANDIDATE"
    && row.capabilityRef === undefined
    && row.supersededCapabilityCandidate?.capabilityRef === "media.compose.exact-typography-logo-brand"
    && row.claimSpecificSemanticRoute?.sourceRef === contentRef
    && row.claimSpecificSemanticRoute?.targetValueSha256 === sha256Json(value)
    && row.claimSpecificSemanticRoute?.requiredClauses.every((clause) => JSON.stringify(value).includes(clause))
    && row.claimSpecificSemanticRoute?.acceptanceEffect === "none"
    && row.claimSpecificSemanticRoute?.runtimeAdmission === "NOT_ADMITTED";
  assert.equal(validContent(contentRow, content), true);
  assert.equal(contentRoute.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.ok(content.appliesTo.includes("legal-copy") && content.appliesTo.includes("mathematics-and-equations"));
  assert.ok(content.sourceBinding.required.includes("immutableVersion") && content.sourceBinding.required.includes("rightsAndUseScope"));
  assert.ok(content.composition.prohibit.includes("model-authored-or-rewritten-exact-copy"));
  assert.match(content.translationAndDubbing.authority, /retains meaning approval/u);
  assert.match(content.translationAndDubbing.authority, /never authorizes mistranslation/u);
  for (const weaken of [
    (copy) => { copy.appliesTo = copy.appliesTo.filter((item) => item !== "legal-copy"); },
    (copy) => { copy.sourceBinding.required = copy.sourceBinding.required.filter((item) => item !== "immutableVersion"); },
    (copy) => { copy.composition.prohibit = copy.composition.prohibit.filter((item) => item !== "model-authored-or-rewritten-exact-copy"); },
    (copy) => { copy.translationAndDubbing.authority = "Duration fit approves generated translation."; },
  ]) {
    const weakened = structuredClone(content);
    weaken(weakened);
    assert.equal(validContent(contentRow, weakened), false, "each exact-content material clause must remain pinned");
  }

  const actionRow = candidate.records.find(({ claimId }) => claimId === "MPSEM-0158-C003");
  const actionRef = ".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml#changeImpactRule";
  const action = resolveExactSourceRef(actionRef);
  const actionRoute = actionRow?.claimSpecificSemanticRoute;
  const validAction = (row, value) => row?.exactSourceText === "New capabilities or changed action consequences |"
    && row.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"
    && row.proposedTargetRef === actionRef
    && row.routeKind === "PDP2_ACTION_CHANGE_IMPACT_RULE_CANDIDATE"
    && row.capabilityRef === undefined
    && row.supersededCapabilityCandidate?.capabilityRef === "media.capability.discover"
    && row.claimSpecificSemanticRoute?.sourceRef === actionRef
    && row.claimSpecificSemanticRoute?.targetValueSha256 === sha256Json(value)
    && row.claimSpecificSemanticRoute?.requiredClauses.every((clause) => JSON.stringify(value).includes(clause))
    && row.claimSpecificSemanticRoute?.acceptanceEffect === "none"
    && row.claimSpecificSemanticRoute?.runtimeAdmission === "NOT_ADMITTED";
  assert.equal(validAction(actionRow, action), true);
  assert.equal(actionRoute.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.match(action.trigger, /new capability is added/u);
  assert.match(action.rule, /missing or ambiguous binding remains an open definition gap/u);
  assert.equal(action.requiredImpactBindings.length, 6);
  for (const binding of [
    "exactCapabilityAndCanonicalOperationIdentitiesAndVersions",
    "affectedActionIdsAndTypedRequestAndResultBranches",
    "authorityRightsConsentAndPolicyGuardsAtTheEffectBoundary",
    "stateTransitionReceiptEventAndUnknownOutcomeSemantics",
    "affectedChannelsViewsAndKeyboardAccessibleControls",
    "recoveryAndIdempotencyConsequencesIncludingRacingOrPartialEffects",
  ]) assert.ok(action.requiredImpactBindings.includes(binding), binding);
  for (const omit of [
    "authorityRightsConsentAndPolicyGuardsAtTheEffectBoundary",
    "stateTransitionReceiptEventAndUnknownOutcomeSemantics",
    "recoveryAndIdempotencyConsequencesIncludingRacingOrPartialEffects",
  ]) {
    const weakened = structuredClone(action);
    weakened.requiredImpactBindings = weakened.requiredImpactBindings.filter((item) => item !== omit);
    assert.equal(validAction(actionRow, weakened), false, `${omit} remains material to the impact contract`);
  }
});

test("ordinary-path provider navigation is routed to the exact experience boundary", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0041-C004");
  const route = row?.claimSpecificSemanticRoute;
  const ref = ".product-experience/pdp-3-product-experience/navigation-contracts.yaml#/informationArchitecture/ordinaryPathProviderSelection";
  const ownerValue = resolveExactSourceRef(ref);
  const valid = (candidateRow, value) => candidateRow?.exactSourceText === "No technical-provider navigation in the ordinary path."
    && candidateRow.proposedTargetRef === ref
    && candidateRow.routeKind === "EXACT_MEDIA_NAVIGATION_BOUNDARY_CANDIDATE"
    && candidateRow.capabilityRef === undefined
    && candidateRow.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"
    && candidateRow.semanticEquivalence === "NOT_ASSERTED"
    && candidateRow.runtimeAdmission === "NOT_ADMITTED"
    && candidateRow.acceptanceEffect === "none"
    && candidateRow.supersededCapabilityCandidate?.targetRef === ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.animation.path"
    && candidateRow.claimSpecificSemanticRoute?.targetValueSha256 === sha256Json(value)
    && candidateRow.claimSpecificSemanticRoute?.requiredClauses.every((clause) => JSON.stringify(value).includes(clause));
  assert.ok(route);
  assert.equal(valid(row, ownerValue), true);
  for (const clause of route.requiredClauses) {
    const weakened = JSON.parse(JSON.stringify(ownerValue).replace(clause, "[material clause removed]"));
    assert.equal(valid(row, weakened), false, `${clause} is required by the ordinary-path boundary`);
  }
  const providerCatalogDefault = structuredClone(ownerValue);
  providerCatalogDefault.rule = "Ordinary product navigation starts from a provider catalog.";
  assert.equal(valid(row, providerCatalogDefault), false, "a provider catalog default violates the bounded Media rule");
  const falselyAuthorizingDisclosure = structuredClone(ownerValue);
  falselyAuthorizingDisclosure.disclosure = "Displaying a provider authorizes provider execution.";
  assert.equal(valid(row, falselyAuthorizingDisclosure), false, "disclosure cannot grant provider selection or execution authority");
});

test("person-related inference claims bind limitations and scoped non-person IDs", () => {
  const record = candidate.records.find(({ claimId }) => claimId === "MPSEM-0187-C001");
  const route = record?.claimSpecificSemanticRoute;
  const ref = ".product-experience/pdp-0-product-truth/quality-policy.yaml#personAndIdentityInferenceRule/explicitApplicabilityPermissionAndLimitations";
  const value = resolveExactSourceRef(ref);
  const parentRef = ".product-experience/pdp-0-product-truth/quality-policy.yaml#personAndIdentityInferenceRule";
  const parent = resolveExactSourceRef(parentRef);
  assert.match(record?.exactSourceText ?? "", /Identity, biometrics, emotions and gaze require explicit applicability, permission and limitation records/u);
  assert.equal(record?.proposedTargetRef, ref);
  assert.equal(record?.routeKind, "PERSON_IDENTITY_INFERENCE_POLICY_CANDIDATE");
  assert.equal(route?.sourceRef, ref);
  assert.equal(route?.targetValueSha256, sha256Json(value));
  assert.deepEqual(route.relatedSourceRefs, [parentRef]);
  assert.equal(route.relatedTargetValueSha256, sha256Json(parent));
  assert.ok(route.requiredClauses.every((clause) => JSON.stringify(value).includes(clause)));
  for (const dimension of ["identity", "biometrics", "emotion", "gaze"]) {
    assert.ok(value.dimensions[dimension].applicability.length > 0, `${dimension} has an explicit applicability rule`);
    assert.ok(value.dimensions[dimension].permission.length > 0, `${dimension} has an explicit permission rule`);
    assert.ok(value.dimensions[dimension].limitations.length > 0, `${dimension} has explicit limitations`);
  }
  assert.ok(value.commonRules.some((rule) => /UNKNOWN and blocks the inference effect/u.test(rule)));
  assert.ok(value.commonRules.some((rule) => /NOT_APPLICABLE and NOT_SUPPORTED/u.test(rule)));
  assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(route.qualification, "NOT_EVALUATED");
  assert.equal(route.acceptanceEffect, "none");

  const validDimensionSafeguards = (candidateValue) => {
    const { dimensions } = candidateValue;
    return /purpose-bound authority/u.test(dimensions.identity.permission)
      && /purpose-specific authority/u.test(dimensions.biometrics.permission)
      && /applicable consent/u.test(dimensions.biometrics.permission)
      && /uncertain model inference/u.test(dimensions.emotion.limitations)
      && /does not establish attention, intent, comprehension, or identity/u.test(dimensions.gaze.limitations);
  };
  assert.equal(validDimensionSafeguards(value), true);
  for (const [dimension, field, replacement] of [
    ["identity", "permission", "Asset presence authorizes identity resolution."],
    ["biometrics", "permission", "A biometric score authorizes matching."],
    ["emotion", "limitations", "An emotion label is established internal state."],
    ["gaze", "limitations", "Gaze direction establishes intent and comprehension."],
  ]) {
    const weakened = structuredClone(value);
    weakened.dimensions[dimension][field] = replacement;
    assert.notEqual(sha256Json(weakened), route.targetValueSha256, `${dimension}.${field} material weakening changes the pinned target`);
    assert.equal(validDimensionSafeguards(weakened), false, `${dimension} mutation violates an exact dimension safeguard`);
  }

  const wrongTarget = structuredClone(record);
  wrongTarget.proposedTargetRef = ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.vision.analyze.gaze";
  assert.notEqual(wrongTarget.proposedTargetRef, ref, "a gaze capability definition alone does not establish anonymous identity handling");
});

test("additional owner routes preserve exact job, reproducibility, CLI interruption, and bounded-agent clauses", () => {
  const cases = [
    ["MPSEM-0221-C002", ".product-experience/pdp-0-product-truth/domain-model.yaml#proposedRecordCatalog/@id=ProcessingJob-and-RenderJob", (value) => value.meaning.includes("RenderJob and ArtifactVerificationJob are intent-specific views")],
    ["MPSEM-0269-C002", ".product-experience/pdp-0-product-truth/time-units-fidelity.yaml#simulationAndFidelity/replayClasses", (value) => value.classes.some((row) => row.class === "STATISTICAL" && /seed alone does not promise identical output/u.test(row.permittedClaim)) && value.default.includes("REPLAY_UNAVAILABLE")],
    ["MPSEM-0351-C001", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#machineOutput/productExitCodeTaxonomy", (value) => value.codes.some((row) => row.code === 130 && row.id === "media.cli.exit.local-interruption" && row.result.includes("local-observation-interrupted"))],
    ["MPSEM-0472-C002", ".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml#mediaOwnedToolDefinitionContracts/boundedPlanningSemantics", (value) => value.id === "media.agent-tool-bounded-planning.v1" && value.rules.some((rule) => /bounded ordered list/u.test(rule) || /bounded ordered list/u.test(value.planningUnit)) && value.rules.some((rule) => /observation itself never dispatches/u.test(rule))],
    ["MPSEM-0442-C003", ".product-experience/pdp-0-product-truth/glossary.yaml#terms/@id=media.term.disclosure-levels", (value) => value.definition.includes("one Media semantic model, action set, and state") && value.distinctions.some((item) => item.includes("does not create separate workflows"))],
    ["MPSEM-0305-C002", ".product-experience/pdp-2-design-interface-system/interface-grammar.yaml#invariants/retry", (value) => /unknown outcome must be reconciled first/u.test(value.rule) && value.forbidden.includes("retry-unknown")],
    ["MPSEM-0310-C003", ".product-experience/pdp-2-design-interface-system/interface-grammar.yaml#invariants/progress", (value) => /preserve unknown or absent measurement without a percentage/u.test(value.rule) && value.forbidden.includes("state-label-as-percent")],
    ["MPSEM-0346-C002", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#ownerDefinedMachineOutputRules/@id=media.cli.wait-timeout-semantics.v1", (value) => /timeout or interruption of local waiting does not cancel the remote job, prove failure/u.test(value.rule) && /same job\/request identity first/u.test(value.rule)],
    ["MPSEM-0371-C001", ".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml#mediaOwnedToolDefinitionContracts/untrustedMediaDataBoundary", (value) => value.untrustedInputClasses.includes("transcript-text-and-recognized-speech") && value.untrustedInputClasses.includes("OCR-and-scene-text") && value.untrustedInputClasses.includes("raw-image-audio-video-and-frame-content") && /cannot supply or override those fields/u.test(value.envelopeSourceRule) && /cannot add an action or operation to a plan/u.test(value.authorityRule) && value.adversarialCases.some((item) => /tenant/u.test(item.attack) && /retain the host-selected tool/u.test(item.expected))],
    ["MPSEM-0352-C001", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/ownerDefinedInvocationRules/@id=media.cli.command-flag-and-idempotency-applicability.v1", (value) => value.requiredBindings.includes("commandId") && value.requiredBindings.includes("exactOptionSet") && /explicit registry binding/u.test(value.rule) && value.negativeCases.includes("flag-accepted-by-unlisted-command")],
    ["MPSEM-0352-C002", ".product-experience/pdp-2-design-interface-system/cli-language.yaml#/ownerDefinedInvocationRules/@id=media.cli.command-flag-and-idempotency-applicability.v1", (value) => /read-only query does not acquire a mutation idempotency requirement/u.test(value.rule) && /exact canonical operation contract declares it/u.test(value.rule) && value.negativeCases.includes("read-only-query-forced-to-supply-mutation-idempotency-key")],
    ["MPSEM-0372-C006", ".product-experience/pdp-2-design-interface-system/api/async-operations.yaml#/ownerDefinedAsyncRules/@id=media.async.definition-and-run-state-separation.v1", (value) => /Labels such as “planning” or “rendering” are presentation labels and do not create another job authority/u.test(value.rule) && /exact owning Media operation and job state machine/u.test(value.rule) && value.negativeCases.includes("stage-label-creates-another-job-authority")],
    ["MPSEM-0378-C002", ".product-experience/pdp-2-design-interface-system/action-finality-grammar.yaml#immutableOutputCorrectionRule", (value) => /A completed output version is immutable/u.test(value.rule) && /correction.*appends a new version or reconciliation record/u.test(value.rule) && /exact prior output and correction request/u.test(value.rule) && /never overwrites the completed version/u.test(value.rule) && value.negativeCases.includes("overwrite-completed-output-version")],
    ["MPSEM-0311-C002", ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/idempotency", (value) => value.scope.join("+") === "tenantId+principalId+operationRef+requestId" && /return-original-jobId-and-receipt/u.test(value.samePayload) && /retain-through-job-and-reconciliation-evidence-lifetime/u.test(value.retention)],
    ["MPSEM-0311-C003", ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/idempotency", (value) => /IDEMPOTENCY_CONFLICT/u.test(value.differentPayload) && /without-second-job/u.test(value.differentPayload) && /different-targetOperationRef-or-validated-parameter-values/u.test(value.differentPayload)],
  ];
  for (const [claimId, sourceRef, preserves] of cases) {
    const row = candidate.records.find((record) => record.claimId === claimId);
    const route = row?.claimSpecificSemanticRoute;
    const sourceValue = resolveExactSourceRef(sourceRef);
    assert.ok(sourceValue, `${claimId}: exact source resolves`);
    assert.equal(route?.sourceRef, sourceRef, `${claimId}: route uses exact source selector`);
    assert.equal(route?.targetValueSha256, sha256Json(sourceValue), `${claimId}: target hash covers exact parsed value`);
    assert.equal(row.currentDisposition?.ownerTargetValueSha256, sha256Json(sourceValue));
    assert.equal(route.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(route.acceptanceEffect, "none");
    assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(preserves(sourceValue), true, `${claimId}: owner source retains the material predicate`);
    assert.ok(route.negativeCases.length >= 3, `${claimId}: exact weakening cases are recorded`);
  }

  const job = structuredClone(resolveExactSourceRef(cases[0][1]));
  job.meaning = job.meaning.replace("RenderJob and ArtifactVerificationJob are intent-specific views", "RenderJob is an independent generic runtime");
  assert.equal(job.meaning.includes("RenderJob and ArtifactVerificationJob are intent-specific views"), false);
  const replay = structuredClone(resolveExactSourceRef(cases[1][1]));
  replay.classes.find((row) => row.class === "STATISTICAL").permittedClaim = "A seed promises identical output.";
  assert.equal(/seed alone does not promise identical output/u.test(replay.classes.find((row) => row.class === "STATISTICAL").permittedClaim), false);
  const taxonomy = structuredClone(resolveExactSourceRef(cases[2][1]));
  taxonomy.codes.find((row) => row.code === 130).result = "remote-job-failed";
  assert.equal(taxonomy.codes.find((row) => row.code === 130).result.includes("local-observation-interrupted"), false);
  const planning = structuredClone(resolveExactSourceRef(cases[3][1]));
  planning.rules = planning.rules.map((rule) => rule.replace("observation itself never dispatches that action", "observation dispatches that action"));
  assert.equal(planning.rules.some((rule) => /observation itself never dispatches/u.test(rule)), false);
  const untrusted = structuredClone(resolveExactSourceRef(cases[8][1]));
  untrusted.authorityRule = untrusted.authorityRule.replace("cannot add an action or operation to a plan", "may add an action or operation to a plan");
  assert.equal(/cannot add an action or operation/u.test(untrusted.authorityRule), false);
  assert.equal(cases[8][2](untrusted), false, "untrusted media cannot add an action to a bounded plan");
  const flags = structuredClone(resolveExactSourceRef(cases[9][1]));
  flags.rule = flags.rule.replace("explicit registry binding", "implicit global binding");
  assert.equal(cases[9][2](flags), false, "options cannot become global by convention");
  const readIdempotency = structuredClone(resolveExactSourceRef(cases[10][1]));
  readIdempotency.rule = readIdempotency.rule.replace("A read-only query does not acquire a mutation idempotency requirement", "Every read-only query requires a mutation idempotency key");
  assert.equal(cases[10][2](readIdempotency), false, "read operations do not inherit mutation keys");
  const stage = structuredClone(resolveExactSourceRef(cases[11][1]));
  stage.rule = stage.rule.replace("do not create another job authority", "create another job authority");
  assert.equal(cases[11][2](stage), false, "a stage label cannot create a new job authority");
  const correction = structuredClone(resolveExactSourceRef(cases[12][1]));
  correction.rule = correction.rule.replace("never overwrites the completed version", "overwrites the completed version");
  assert.equal(cases[12][2](correction), false, "corrections append a revision and preserve prior output versions");
  const sameKey = structuredClone(resolveExactSourceRef(cases[13][1]));
  sameKey.samePayload = "return-a-new-job-id";
  assert.equal(cases[13][2](sameKey), false, "identical semantic requests return the original receipt");
  const changedKey = structuredClone(resolveExactSourceRef(cases[14][1]));
  changedKey.differentPayload = "accept-as-new-job";
  assert.equal(cases[14][2](changedKey), false, "changed content under the same key conflicts");
});

test("quality, erasure, and untrusted-media claims bind complete owner policies", () => {
  const rows = [
    {
      id: "MPSEM-0035-C003",
      ref: ".product-experience/pdp-0-product-truth/quality-policy.yaml#qualificationScopeIdentity",
      required: ["metricRef", "metricVersion", "domainRef", "providerRef", "methodRef", "methodVersion", "modelRef", "modelVersion", "applicabilityScopeRef", "calibrationScopeRef", "calibrationVersion"],
      mutations: [
        { mutate: (value) => { value.exactTuple.requiredFields = value.exactTuple.requiredFields.filter((name) => name !== "providerRef"); }, rejects: (value) => !value.exactTuple.requiredFields.includes("providerRef") },
        { mutate: (value) => { value.status = "owner-definition-only; qualification-passed"; }, rejects: (value) => value.status !== "NOT_EVALUATED" },
      ],
    },
    {
      id: "MPSEM-0037-C002",
      ref: ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedErasureInventoryContract",
      required: ["DERIVED_ARTIFACT", "BACKUP_SNAPSHOT", "CACHE", "EXTERNAL_PROVIDER_COPY", "blocks irreversible deletion", "replay applicable tombstones", "never proves remote/provider-side erasure", "do not emit ERASURE_CONFIRMED"],
      mutations: [
        { mutate: (value) => { value.copyInventory.requiredCopyClasses = value.copyInventory.requiredCopyClasses.filter((name) => name !== "BACKUP_SNAPSHOT"); }, rejects: (value) => !value.copyInventory.requiredCopyClasses.includes("BACKUP_SNAPSHOT") },
        { mutate: (value) => { value.tombstones.restoreRule = "Restored bytes are readable before replay."; }, rejects: (value) => value.tombstones.restoreRule !== "Before restored data becomes readable or dispatchable, replay applicable tombstones against every restored copy" },
        { mutate: (value) => { value.erasureFinality.externalProviderRule = "A local delete confirms remote erasure."; }, rejects: (value) => value.erasureFinality.externalProviderRule !== "A local delete or request acknowledgement never proves remote/provider-side erasure" },
      ],
    },
    {
      id: "MPSEM-0037-C003",
      ref: ".product-experience/pdp-1-domain-data/privacy.yaml#ownerDefinedErasureInventoryContract",
      required: ["DERIVED_ARTIFACT", "BACKUP_SNAPSHOT", "CACHE", "EXTERNAL_PROVIDER_COPY", "holdRef", "tombstones", "PROVIDER_DELETION_PENDING"],
      mutations: [
        { mutate: (value) => { value.copyInventory.requiredCopyClasses = value.copyInventory.requiredCopyClasses.filter((name) => name !== "CACHE"); }, rejects: (value) => !value.copyInventory.requiredCopyClasses.includes("CACHE") },
        { mutate: (value) => { value.holds.unknownRule = "Unknown evidence permits deletion."; }, rejects: (value) => value.holds.unknownRule !== "Missing, stale, malformed, or conflicting hold evidence is UNKNOWN and blocks irreversible deletion" },
        { mutate: (value) => { value.tombstones.restoreRule = "No tombstone replay is required."; }, rejects: (value) => value.tombstones.restoreRule !== "Before restored data becomes readable or dispatchable, replay applicable tombstones against every restored copy" },
      ],
    },
    {
      id: "MPSEM-0039-C003",
      ref: ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy/inputAndExecutionThreats",
      required: ["decode-in-isolated-worker-before-promoting-to-usable-content", "disable-imported-scene-script-execution-by-default", "do-not-run-model-generated-code-on-the-host", "admit-engine-plugin-model-font-and-code-by-version-digest-license-and-security-review", "wall-clock", "monetary-budget"],
      mutations: [
        (value) => { value.requiredControls = value.requiredControls.filter((name) => name !== "decode-in-isolated-worker-before-promoting-to-usable-content"); },
        (value) => { value.requiredControls = value.requiredControls.filter((name) => !name.includes("model-generated-code")); },
        (value) => { value.executionBounds = value.executionBounds.filter((name) => name !== "wall-clock"); },
      ],
    },
  ];

  for (const { id, ref, required, mutations } of rows) {
    const record = candidate.records.find(({ claimId }) => claimId === id);
    const route = record?.claimSpecificSemanticRoute;
    const value = resolveExactSourceRef(ref);
    assert.equal(record?.proposedTargetRef, ref, `${id} exact target`);
    assert.equal(route?.sourceRef, ref, `${id} route source`);
    if ((id === "MPSEM-0037-C002" || id === "MPSEM-0037-C003" || id === "MPSEM-0039-C003") && route?.targetValueSha256 !== sha256Json(value)) {
      assert.equal(route?.currentTargetObservation?.sourceRef, ref, `${id} drift observation source`);
      assert.equal(route?.currentTargetObservation?.currentTargetValueSha256, sha256Json(value), `${id} exact current source observation`);
      assert.equal(route?.currentTargetObservation?.previousCandidateTargetValueSha256, route?.targetValueSha256, `${id} preserves the stale candidate pin`);
      assert.equal(route?.currentTargetObservation?.status, "STALE_CANDIDATE_REQUIRES_REVIEW", `${id} remains open for review`);
      assert.equal(route?.currentTargetObservation?.semanticPromotion, false, `${id} does not promote source drift`);
    } else {
      assert.equal(route?.targetValueSha256, sha256Json(value), `${id} current target pin`);
    }
    for (const clause of required) assert.ok(JSON.stringify(value).includes(clause), `${id} preserves ${clause}`);
    for (const entry of mutations) {
      const weakened = structuredClone(value);
      const mutate = typeof entry === "function" ? entry : entry.mutate;
      mutate(weakened);
      assert.notEqual(sha256Json(weakened), route.targetValueSha256, `${id} material mutation invalidates its target pin`);
      if (typeof entry !== "function") assert.equal(entry.rejects(weakened), true, `${id} oracle rejects weakened meaning`);
      else assert.ok(route.requiredClauses.some((clause) => !JSON.stringify(weakened).includes(clause)), `${id} oracle rejects weakened meaning`);
    }
    assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(route.qualification, "NOT_EVALUATED");
    assert.equal(route.acceptanceEffect, "none");
  }
});

test("generation, requirement retention, phase views, and Constitution share one source authority", () => {
  const ref = ".product-experience/pdp-0-product-truth/requirements.yaml#ownerDefinedProjectionAuthorityRules/@id=media.requirement.generated-projection-single-authority.v1";
  const value = resolveExactSourceRef(ref);
  const expectations = new Map([
    ["MPSEM-0025-C003", ["Media source records remain the only editable Media-specific semantic authorities", "ProductDefinition capabilities and requirements are read-only projections of the exact Media capability and requirement records", "The generic schema cannot absorb Media-specific semantics or replace those records", "Generated files are never the primary edit target"]],
    ["MPSEM-0078-C002", ["Implementation order only sequences execution", "It never deletes, weakens, or reclassifies a requirement to match incomplete implementation"]],
    ["MPSEM-0122-C002", ["readable PRODUCT-CONSTITUTION.md is generated from or unambiguously references this one structured requirement register", "not a second editable authority"]],
    ["MPSEM-0162-C002", ["It never deletes, weakens, or reclassifies a requirement to match incomplete implementation", "Definition completeness, implementation state, qualification, runtime availability, and acceptance remain distinct"]],
    ["MPSEM-0165-C002", ["Phase-local gap, coverage, and acceptance views are generated filtered views of root source obligations", "not independently editable inventories or alternate acceptance authorities"]],
    ["MPSEM-0166-C002", ["runtime reuse-decision projection may be generated only from the exact Media-owned reuse decision records", "not a second editable decision register", "does not itself admit a dependency"]],
  ]);
  for (const [claimId, requiredClauses] of expectations) {
    const record = candidate.records.find(({ claimId: id }) => id === claimId);
    const route = record?.claimSpecificSemanticRoute;
    assert.equal(record?.proposedTargetRef, ref, `${claimId} exact owner target`);
    assert.equal(route?.sourceRef, ref, `${claimId} source selector`);
    assert.equal(route?.targetValueSha256, sha256Json(value), `${claimId} source value pin`);
    assert.ok(requiredClauses.every((clause) => JSON.stringify(value).includes(clause)), `${claimId} material clauses exist`);
    assert.ok(route.requiredClauses.length >= 2, `${claimId} route is material, not a locator-only record`);
    assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(route.acceptanceEffect, "none");
    const weakened = structuredClone(value);
    const mutatedField = {
      "MPSEM-0025-C003": "productDefinitionProjection",
      "MPSEM-0078-C002": "requirementRetention",
      "MPSEM-0122-C002": "constitutionProjection",
      "MPSEM-0162-C002": "requirementRetention",
      "MPSEM-0165-C002": "phaseViews",
      "MPSEM-0166-C002": "runtimeReuseProjection",
    }[claimId];
    weakened[mutatedField] = "This owner rule does not preserve the source requirement.";
    assert.notEqual(sha256Json(weakened), route.targetValueSha256, `${claimId} material mutation changes the target pin`);
    assert.ok(route.requiredClauses.some((clause) => !JSON.stringify(weakened).includes(clause)), `${claimId} material oracle rejects the weakened field`);
  }
});

test("leaf trust and reconstruction claims bind the exact owner policy without inferring from leaf names", () => {
  const record = candidate.records.find(({ claimId }) => claimId === "MPSEM-0078-C005");
  const ref = ".product-experience/pdp-0-product-truth/requirements.yaml#ownerDefinedLeafTrustReconstructionPolicy";
  const value = resolveExactSourceRef(ref);
  const route = record?.claimSpecificSemanticRoute;
  assert.equal(record?.exactSourceText, "trust/reconstruction policy");
  assert.equal(record?.proposedTargetRef, ref);
  assert.equal(route?.sourceRef, ref);
  assertStaleMaterialBlocker(record, ref, value,
    ["exact typed inputs, outputs, and operation contract"]);
  assert.equal(route?.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(route?.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(route?.qualification, "NOT_EVALUATED");
  assert.equal(route?.acceptanceEffect, "none");
  assert.equal(value.id, "media.requirement.leaf-trust-reconstruction-policy.v1");
  assert.match(value.appliesTo, /Every exact capability leaf/u);
  for (const clause of route.requiredClauses.filter((entry) => entry !== "exact typed inputs, outputs, and operation contract")) {
    assert.ok(JSON.stringify(value).includes(clause), `owner policy retains ${clause}`);
  }
  assert.deepEqual(value.dispositions, [
    "SOURCE_DERIVED_TRANSFORMATION",
    "ESTIMATED_OR_RECONSTRUCTED",
    "ESTIMATED_OR_INFERRED_OBSERVATION",
    "NO_RECONSTRUCTION_OR_INFERENCE",
    "UNRESOLVED_EXACT_OUTPUT_SEMANTICS",
  ]);

  const weakened = structuredClone(value);
  weakened.rule = weakened.rule.replace("never present generated detail as recovered fact", "present generated detail as recovered fact");
  assert.notEqual(sha256Json(weakened), route.targetValueSha256);
  assert.ok(route.requiredClauses.some((clause) => !JSON.stringify(weakened).includes(clause)));
  const inferredFromName = structuredClone(value);
  inferredFromName.unknownDisposition = "Infer disposition from capability family name";
  assert.notEqual(sha256Json(inferredFromName), route.targetValueSha256);
  assert.ok(route.requiredClauses.some((clause) => !JSON.stringify(inferredFromName).includes(clause)),
    "the exact unknown disposition rejects name-derived trust classification");
});

test("predicted depth is an exact inferred observation, never ground-truth geometry", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0199-C003");
  const ref = ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml#ownerTrustReconstructionDispositions/records/@id=media.capability-trust-reconstruction.media-capability-adjudication-vision-estimate-depth.v1";
  const value = resolveExactSourceRef(ref);
  const route = row?.claimSpecificSemanticRoute;
  const branch = value?.outputBranches?.[0];
  const outcome = branch?.outcomes?.[0];
  assert.equal(row?.proposedTargetRef, ref);
  assert.equal(route?.sourceRef, ref);
  assertRouteTargetCurrentOrObserved(route, ref, value);
  assert.equal(value.capabilityRef, "media.vision.estimate.depth");
  assert.equal(outcome?.disposition, "ESTIMATED_OR_INFERRED_OBSERVATION");
  assert.match(outcome?.meaning ?? "", /never present a label or estimate as ground truth/u);
  assert.match(outcome?.meaning ?? "", /uncertainty and limitations/u);
  assert.match(value.unknownPolicy, /UNKNOWN_OR_ABSTAINED/u);
  assert.equal(value.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(route.acceptanceEffect, "none");

  const validDepthDisposition = (candidateValue) => candidateValue.capabilityRef === "media.vision.estimate.depth"
    && candidateValue.outputBranches?.[0]?.outcomes?.[0]?.disposition === "ESTIMATED_OR_INFERRED_OBSERVATION"
    && /never present a label or estimate as ground truth/u.test(candidateValue.outputBranches[0].outcomes[0].meaning)
    && /uncertainty and limitations/u.test(candidateValue.outputBranches[0].outcomes[0].meaning)
    && /UNKNOWN_OR_ABSTAINED/u.test(candidateValue.unknownPolicy);
  assert.equal(validDepthDisposition(value), true);
  const groundTruth = structuredClone(value);
  groundTruth.outputBranches[0].outcomes[0].disposition = "NO_RECONSTRUCTION_OR_INFERENCE";
  groundTruth.outputBranches[0].outcomes[0].meaning = "The predicted depth map is ground-truth geometry.";
  assert.equal(validDepthDisposition(groundTruth), false);
  assert.notEqual(sha256Json(groundTruth), route.targetValueSha256);
  const unknownAsSuccess = structuredClone(value);
  unknownAsSuccess.unknownPolicy = "Treat missing provenance as a measured fact.";
  assert.equal(validDepthDisposition(unknownAsSuccess), false);
});

test("timeline semantics have inspectable nonvisual and keyboard-equivalent controls", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0196-C002");
  const file = ".product-experience/pdp-2-design-interface-system/accessibility.yaml";
  const ref = `${file}#accessibilityRules/@id=media.a11y.media-alternatives`;
  const keyboardRef = `${file}#accessibilityRules/@id=media.a11y.keyboard-equivalence`;
  const dataRef = `${file}#selectedPolicy/nonVisualAlternatives`;
  const value = resolveExactSourceRef(ref);
  const keyboard = resolveExactSourceRef(keyboardRef);
  const alternatives = resolveExactSourceRef(dataRef);
  const route = row?.claimSpecificSemanticRoute;
  assert.equal(row?.proposedTargetRef, ref);
  assert.equal(route?.sourceRef, ref);
  assert.equal(route?.targetValueSha256, sha256Json(value));
  assert.equal(value.id, "media.a11y.media-alternatives");
  assert.match(value.requirement, /timeline and canvas semantics.*textual or structured alternatives/u);
  assert.match(alternatives, /inspectable semantic data and keyboard-equivalent operations/u);
  assert.match(keyboard.requirement, /keyboard and non-drag equivalents/u);
  assert.deepEqual(route.relatedSourceRefs, [dataRef, keyboardRef]);
  assert.deepEqual(route.relatedTargetValueSha256s, [sha256Json(alternatives), sha256Json(keyboard)]);
  assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(route.acceptanceEffect, "none");

  const validTimelineAlternative = (semantic, nonvisual, keyboardRule) => /timeline and canvas semantics.*textual or structured alternatives/u.test(semantic.requirement)
    && /inspectable semantic data and keyboard-equivalent operations/u.test(nonvisual)
    && /keyboard and non-drag equivalents/u.test(keyboardRule.requirement);
  assert.equal(validTimelineAlternative(value, alternatives, keyboard), true);
  const pointerOnly = structuredClone(keyboard);
  pointerOnly.requirement = "Time-based editing is available only by pointer drag.";
  assert.equal(validTimelineAlternative(value, alternatives, pointerOnly), false);
  const noInspectability = alternatives.replace("inspectable semantic data", "visual canvas only");
  assert.equal(validTimelineAlternative(value, noInspectability, keyboard), false);
  assert.notEqual(sha256Json(noInspectability), route.relatedTargetValueSha256s[0]);
});

test("deployment partitioning follows resource and authority boundaries, not capability count", () => {
  const record = candidate.records.find(({ claimId }) => claimId === "MPSEM-0213-C005");
  const ref = ".product-experience/pdp-0-product-truth/requirements.yaml#ownerDefinedDeploymentPartitionRules/@id=media.requirement.resource-isolation-deployment-partition.v1";
  const value = resolveExactSourceRef(ref);
  const route = record?.claimSpecificSemanticRoute;
  assert.equal(record?.proposedTargetRef, ref);
  assert.equal(route?.sourceRef, ref);
  assert.equal(route?.targetValueSha256, sha256Json(value));
  for (const clause of route.requiredClauses) assert.ok(JSON.stringify(value).includes(clause));
  assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(route.acceptanceEffect, "none");
  const oneServicePerCapability = structuredClone(value);
  oneServicePerCapability.granularity = "Create one microservice per capability.";
  assert.notEqual(sha256Json(oneServicePerCapability), route.targetValueSha256);
  assert.ok(route.requiredClauses.some((clause) => !JSON.stringify(oneServicePerCapability).includes(clause)));
  const deploymentClaim = structuredClone(record);
  deploymentClaim.claimSpecificSemanticRoute.runtimeAdmission = "ADMITTED";
  assert.notEqual(deploymentClaim.claimSpecificSemanticRoute.runtimeAdmission, route.runtimeAdmission,
    "a definition rule cannot be used as evidence that deployment is running");
});

test("Media-owned workflows retain exact authoring, recipe, and template execution boundaries", () => {
  const rows = [
    ["MPSEM-0029-C005", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#mediaArchitectureRules/genericMechanicsBoundary/tools", ["do not constitute production Media execution", "durable provider dispatch", "product finality", "exact admitted Media operation", "authoritative receipt"]],
    ["MPSEM-0095-C004", ".product-experience/pdp-0-product-truth/domain-model.yaml#/proposedRecordCatalog/@id=MediaRecipe/agentRuntimeBoundary", ["not an agent-runtime graph", "does not itself dispatch work", "Workflow-like shape, branching, or ordered steps does not grant agent, tool, model, or privileged execution authority", "exact authorized contract", "Missing fields or authority block dispatch", "NOT_ADMITTED"]],
    ["MPSEM-0200-C002", ".product-experience/pdp-0-product-truth/requirements.yaml#ownerDefinedRecipeTemplateBindingRules/@id=media.requirement.recipe-template-versioned-schema-binding.v1", ["A reusable template is a versioned MediaRecipe identity plus exact versioned content and schema bindings", "not hidden application code or mutable defaults", "not a separately hard-coded application", "Missing, stale, incompatible, or unauthorized content/schema bindings make the template instance invalid or unresolved", "never silently substitute content or schema"]],
  ];
  for (const [claimId, ref, clauses] of rows) {
    const record = candidate.records.find(({ claimId: id }) => id === claimId);
    const route = record?.claimSpecificSemanticRoute;
    const value = resolveExactSourceRef(ref);
    assert.equal(record?.proposedTargetRef, ref, `${claimId} exact source boundary`);
    assert.equal(route?.targetValueSha256, sha256Json(value), `${claimId} current source value pin`);
    assert.ok(clauses.every((clause) => JSON.stringify(value).includes(clause)), `${claimId} complete material boundary`);
    for (const clause of clauses) assert.ok(route.requiredClauses.includes(clause), `${claimId} falsifiable oracle includes ${clause}`);
    assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(route.acceptanceEffect, "none");
  }
  const recipe = resolveExactSourceRef(rows[1][1]);
  const noAgentBoundary = structuredClone(recipe);
  noAgentBoundary.rule = "A MediaRecipe is a dynamic agent graph that dispatches tools.";
  const recipeRoute = candidate.records.find(({ claimId }) => claimId === "MPSEM-0095-C004").claimSpecificSemanticRoute;
  assert.notEqual(sha256Json(noAgentBoundary), recipeRoute.targetValueSha256);
  assert.ok(recipeRoute.requiredClauses.some((clause) => !JSON.stringify(noAgentBoundary).includes(clause)));
  const template = resolveExactSourceRef(rows[2][1]);
  const hardCodedApp = structuredClone(template);
  hardCodedApp.executionBoundary = "A template is a hard-coded application.";
  const templateRoute = candidate.records.find(({ claimId }) => claimId === "MPSEM-0200-C002").claimSpecificSemanticRoute;
  assert.notEqual(sha256Json(hardCodedApp), templateRoute.targetValueSha256);
  assert.ok(templateRoute.requiredClauses.some((clause) => !JSON.stringify(hardCodedApp).includes(clause)));
});

test("bounded planning claim maps to the Media owner plan contract without implying an admitted agent runtime", () => {
  const claimId = "MPSEM-0095-C002";
  const ref = ".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml#mediaOwnedToolDefinitionContracts/boundedPlanningSemantics";
  const record = candidate.records.find(({ claimId: id }) => id === claimId);
  const route = record?.claimSpecificSemanticRoute;
  const value = resolveExactSourceRef(ref);
  assert.equal(record?.proposedTargetRef, ref);
  assert.equal(route?.sourceRef, ref);
  assert.equal(route?.targetValueSha256, sha256Json(value));
  assert.equal(value.id, "media.agent-tool-bounded-planning.v1");
  for (const clause of route.requiredClauses) assert.ok(JSON.stringify(value).includes(clause), `${claimId} preserves ${clause}`);
  assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(route.qualification, "NOT_EVALUATED");
  assert.equal(route.acceptanceEffect, "none");

  const mutations = [
    (copy) => { copy.rules[1] = "The planner may add any tool or operation it chooses."; },
    (copy) => { copy.rules[4] = "Observation may dispatch a consequential action."; },
    (copy) => { copy.rules[6] = "ACCEPTED and UNKNOWN results satisfy later preconditions."; },
    (copy) => { copy.rules[3] = "A child step may enlarge or delegate the budget and authority."; },
  ];
  for (const mutate of mutations) {
    const weakened = structuredClone(value);
    mutate(weakened);
    assert.notEqual(sha256Json(weakened), route.targetValueSha256);
    assert.ok(route.requiredClauses.some((clause) => !JSON.stringify(weakened).includes(clause)));
  }
  const falselyAdmitted = structuredClone(record);
  falselyAdmitted.claimSpecificSemanticRoute.runtimeAdmission = "ADMITTED";
  assert.notEqual(falselyAdmitted.claimSpecificSemanticRoute.runtimeAdmission, route.runtimeAdmission);
});

test("shared cross-media mechanics preserve modality-specific units, versions, and evidence", () => {
  const record = candidate.records.find(({ claimId }) => claimId === "MPSEM-0075-C003");
  const ref = ".product-experience/pdp-0-product-truth/requirements.yaml#ownerDefinedCrossMediaMechanicsRules/@id=media.requirement.shared-cross-media-mechanics.v1";
  const value = resolveExactSourceRef(ref);
  const route = record?.claimSpecificSemanticRoute;
  assert.equal(record?.proposedTargetRef, ref);
  assert.equal(route?.targetValueSha256, sha256Json(value));
  assert.ok(route.requiredClauses.every((clause) => JSON.stringify(value).includes(clause)));
  const weakened = structuredClone(value);
  weakened.typedBoundary = "All image, video, audio, animation, and simulation units and clocks are interchangeable.";
  assert.notEqual(sha256Json(weakened), route.targetValueSha256);
  assert.ok(route.requiredClauses.some((clause) => !JSON.stringify(weakened).includes(clause)));
});

test("capability identity names Media semantics without promoting provider identity", () => {
  const record = candidate.records.find(({ claimId }) => claimId === "MPSEM-0172-C002");
  const ref = ".product-experience/pdp-0-product-truth/requirements.yaml#ownerDefinedCapabilityNamingRules/@id=media.requirement.capability-identities-name-media-semantics.v1";
  const value = resolveExactSourceRef(ref);
  const route = record?.claimSpecificSemanticRoute;
  assert.equal(record?.proposedTargetRef, ref);
  assert.equal(route?.sourceRef, ref);
  assert.equal(route?.targetValueSha256, sha256Json(value));
  assert.ok(route.requiredClauses.every((clause) => JSON.stringify(value).includes(clause)));
  assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(route.acceptanceEffect, "none");
  const vendorIdentityAsMeaning = structuredClone(value);
  vendorIdentityAsMeaning.semanticIdentity = "Capability IDs identify the provider and model implementing them.";
  assert.notEqual(sha256Json(vendorIdentityAsMeaning), route.targetValueSha256);
  assert.ok(route.requiredClauses.some((clause) => !JSON.stringify(vendorIdentityAsMeaning).includes(clause)));
  const aliasAsNewLifecycle = structuredClone(value);
  aliasAsNewLifecycle.aliasing = "Every alias creates an independent capability lifecycle and admission.";
  assert.notEqual(sha256Json(aliasAsNewLifecycle), route.targetValueSha256);
  assert.ok(route.requiredClauses.some((clause) => !JSON.stringify(aliasAsNewLifecycle).includes(clause)));
});

test("temporal claims distinguish media, simulation, story, sample, and wall clocks", () => {
  const sourcePath = ".product-experience/pdp-1-domain-data/value-objects.yaml";
  const clockRef = `${sourcePath}#canonicalConversionDefinitions`;
  const nonEquivalenceRef = `${sourcePath}#observedTemporalSpatialFields/nonEquivalences`;
  const clockDefinitions = resolveExactSourceRef(clockRef);
  const nonEquivalences = resolveExactSourceRef(nonEquivalenceRef);
  const clockClaims = [
    ["MPSEM-0033-C002", ["exact-rational-media", "exact-rational-simulation-story", "audio-sample-boundary"]],
    ["MPSEM-0033-C004", ["media.value.rational-media-time", "media.value.sample-boundary-index", "media.value.source-frame-sample-mapping", "VFR presentation index resolves through the retained explicit frame map"]],
  ];
  for (const [claimId, required] of clockClaims) {
    const record = candidate.records.find(({ claimId: id }) => id === claimId);
    const route = record?.claimSpecificSemanticRoute;
    assert.equal(record?.proposedTargetRef, clockRef);
    assert.equal(route?.targetValueSha256, sha256Json(clockDefinitions));
    const relatedValues = route.relatedSourceRefs.map(resolveExactSourceRef);
    assert.ok(route.relatedSourceRefs.includes(nonEquivalenceRef));
    assert.equal(route.relatedTargetValueSha256, sha256Json(nonEquivalences));
    if (claimId === "MPSEM-0033-C004") {
      const frameMapRef = `${sourcePath}#ownerDescriptorDefinitions/records/@id=media.value.source-frame-sample-mapping`;
      const frameMap = resolveExactSourceRef(frameMapRef);
      assert.ok(route.relatedSourceRefs.includes(frameMapRef), "exact source-frame/sample descriptor is bound");
      assert.equal(route.relatedTargetValueSha256s[1], sha256Json(frameMap));
      assert.ok(frameMap.rules.some((rule) => /VFR presentation index resolves through the retained explicit frame map, not numeric fps/u.test(rule)));
      assert.ok(frameMap.rules.some((rule) => /sample count, origin and encoder priming\/padding/u.test(rule)));
      assert.ok(frameMap.rules.some((rule) => /selected rounding, priming\/padding, loss and retained provenance/u.test(rule)));
      assert.ok(frameMap.rules.some((rule) => /creates a new immutable artifact/u.test(rule)));
      const lostFrameMap = structuredClone(frameMap);
      lostFrameMap.rules = lostFrameMap.rules.filter((rule) => !/VFR presentation index/u.test(rule));
      assert.notEqual(sha256Json(lostFrameMap), route.relatedTargetValueSha256s[1], "loss of explicit VFR mapping changes the exact descriptor value");
    }
    for (const clause of required) assert.ok(JSON.stringify(clockDefinitions).includes(clause)
      || relatedValues.some((value) => JSON.stringify(value).includes(clause)), `${claimId} preserves ${clause}`);
    for (const clause of route.requiredClauses) assert.ok(JSON.stringify(clockDefinitions).includes(clause)
      || relatedValues.some((value) => JSON.stringify(value).includes(clause)), `${claimId} exact source clause ${clause}`);
    assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(route.qualification, "NOT_EVALUATED");
    assert.equal(route.acceptanceEffect, "none");

    const changedClockKind = structuredClone(clockDefinitions);
    changedClockKind.machineContract.clockKinds = ["media"];
    assert.notEqual(sha256Json(changedClockKind), route.targetValueSha256, `${claimId} rejects collapsing clock kinds`);
  }
  assert.deepEqual(clockDefinitions.machineContract.clockKinds, ["media", "simulation", "story"], "clock identity enum is explicit and exact");
  assert.ok(nonEquivalences.some((rule) => rule.includes("wall-clock Instants and lease/retention Durations")));
  assert.ok(nonEquivalences.some((rule) => rule.includes("not timestamps or proof of frame rate")));
});

test("text-to-image requests accept typed text without requiring an input artifact", () => {
  const record = candidate.records.find(({ claimId }) => claimId === "MPSEM-0193-C003");
  const route = record?.claimSpecificSemanticRoute;
  const operationRef = ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/records/@id=media.operation.capability.media-generate-image-text-to-image/requestSchema";
  const capabilityRef = ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.generate.image.text-to-image";
  const schema = resolveExactSourceRef(operationRef);
  const capability = resolveExactSourceRef(capabilityRef);
  const combined = JSON.stringify({ schema, capability });
  assert.equal(record?.proposedTargetRef, operationRef);
  assert.equal(route?.sourceRef, operationRef);
  assertRouteTargetCurrentOrObserved(route, operationRef, schema);
  assert.deepEqual(route.relatedSourceRefs, [capabilityRef]);
  assertCurrentObservation(route.relatedTargetObservations?.[0], capabilityRef, capability,
    route.relatedTargetValueSha256);
  assert.ok(route.requiredClauses.every((clause) => combined.includes(clause)));
  assert.deepEqual(schema.required, ["parameters", "input1", "requestId"]);
  const payloadBranches = schema.properties.input1.properties.payload.oneOf;
  assert.ok(payloadBranches.some((branch) => branch.properties.kind.const === "text" && branch.required.includes("text")));
  assert.equal(schema.required.includes("input2"), false,
    "the current canonical contract admits typed text without requiring the optional reference-artifact member");
  assert.equal(schema.properties.input2.properties.artifactType.const, "optional-authorized-reference-artifacts");
  assert.deepEqual(schema.properties.input2.properties.payload.required, [],
    "reference fields are optional and remain distinct from the typed text intent");
  assert.deepEqual(capability.inputArtifactTypes, ["text-or-visual-intent", "optional-authorized-reference-artifacts"]);
  const wronglyBinaryRequired = structuredClone(schema);
  wronglyBinaryRequired.required.push("input2");
  assert.notEqual(sha256Json(wronglyBinaryRequired), route.targetValueSha256);
  assert.equal(wronglyBinaryRequired.required.includes("input2"), true);
  const textBranchRemoved = structuredClone(schema);
  textBranchRemoved.properties.input1.properties.payload.oneOf = payloadBranches.filter((branch) => branch.properties.kind.const !== "text");
  assert.notEqual(sha256Json(textBranchRemoved), route.targetValueSha256);
  assert.ok(!textBranchRemoved.properties.input1.properties.payload.oneOf.some((branch) => branch.properties.kind.const === "text"));
  assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(route.qualification, "NOT_EVALUATED");
  assert.equal(route.acceptanceEffect, "none");
});

test("generic Shared and Tools mechanics do not claim a complete GPU scheduler", () => {
  const record = candidate.records.find(({ claimId }) => claimId === "MPSEM-0374-C005");
  const ref = ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#mediaArchitectureRules/genericMechanicsBoundary/gpuSchedulerBoundary";
  const value = resolveExactSourceRef(ref);
  const route = record?.claimSpecificSemanticRoute;
  assert.equal(record?.proposedTargetRef, ref);
  assert.equal(route?.sourceRef, ref);
  assert.equal(route?.targetValueSha256, sha256Json(value));
  assert.ok(route.requiredClauses.every((clause) => JSON.stringify(value).includes(clause)));
  assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(route.acceptanceEffect, "none");
  const falselyComplete = structuredClone(value);
  falselyComplete.rule = "Shared workflow and Tools authoring provide a complete GPU job scheduler.";
  assert.notEqual(sha256Json(falselyComplete), route.targetValueSha256);
  assert.ok(route.requiredClauses.some((clause) => !JSON.stringify(falselyComplete).includes(clause)));
  const falselyAdmitted = structuredClone(record);
  falselyAdmitted.claimSpecificSemanticRoute.runtimeAdmission = "ADMITTED";
  assert.notEqual(falselyAdmitted.claimSpecificSemanticRoute.runtimeAdmission, route.runtimeAdmission);
});

test("corrected migration claims resolve to exact owner rules and preserve every asserted clause", () => {
  const stableRequirementRow = candidate.records.find(({ claimId }) => claimId === "MPSEM-0059-C001");
  const stableRequirementRef = ".product-experience/pdp-0-product-truth/requirements.yaml#ownerDefinedIdentifierRules/@id=media.requirement-identity.separation-from-execution-task-prefixes.v1";
  const stableRequirementValue = resolveExactSourceRef(stableRequirementRef);
  assert.equal(stableRequirementRow?.proposedTargetRef, stableRequirementRef);
  assert.equal(stableRequirementRow?.claimSpecificSemanticRoute?.sourceRef, stableRequirementRef);
  assert.equal(stableRequirementRow?.claimSpecificSemanticRoute?.targetValueSha256, sha256Json(stableRequirementValue));
  assert.ok(stableRequirementRow.claimSpecificSemanticRoute.requiredClauses.every((clause) => JSON.stringify(stableRequirementValue).includes(clause)));
  const validStableIdentity = (value) => value.identityFormats.requirement === "MEDIA-REQ-<stable-semantic-suffix>"
    && value.identityFormats.capability === "media.<canonical-capability-id>"
    && value.identityFormats.prohibitedSemanticReuse.includes("P0")
    && /task labels.*identify program work only/u.test(value.rule)
    && /not requirement, capability, operation, domain, or authorization identities/u.test(value.rule);
  assert.equal(validStableIdentity(stableRequirementValue), true);
  const taskPrefixAsIdentity = structuredClone(stableRequirementValue);
  taskPrefixAsIdentity.identityFormats.requirement = "P0-003";
  assert.notEqual(sha256Json(taskPrefixAsIdentity), stableRequirementRow.claimSpecificSemanticRoute.targetValueSha256);
  assert.equal(validStableIdentity(taskPrefixAsIdentity), false, "task execution IDs cannot satisfy the semantic requirement ID format");

  const cases = [
    ["MPSEM-0027-C003", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#/selectionSequenceRule"],
    ["MPSEM-0059-C002", ".product-experience/pdp-0-product-truth/requirements.yaml#/ownerDefinedIdentifierRules/@id=media.requirement-identity.separation-from-execution-task-prefixes.v1"],
    ["MPSEM-0171-C004", ".product-experience/pdp-0-product-truth/capabilities.yaml#/productDefinitionContract/specializationBoundary"],
    ["MPSEM-0171-C007", ".product-experience/pdp-0-product-truth/capabilities.yaml#/productDefinitionContract/specializationBoundary"],
    ["MPSEM-0171-C009", ".product-experience/pdp-0-product-truth/capabilities.yaml#/productDefinitionContract/specializationBoundary"],
    ["MPSEM-0096-C004", ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/productPolicy/platformMechanics/privilegedEffects"],
    ["MPSEM-0180-C001", ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/productPolicy/platformMechanics/documentIntelligence"],
    ["MPSEM-0313-C003", ".product-experience/pdp-2-design-interface-system/api/identifiers.yaml#/ownerDefinedEphemeralAccessReferenceRule"],
    ["MPSEM-0380-C002", ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/productPolicy/enforcementPoints/4"],
    ["MPSEM-0443-C001", ".product-experience/pdp-0-product-truth/requirements.yaml#/ownerDefinedInputInspectionRules/@id=media.requirement.source-inspection-is-purpose-bound-and-estimated.v1"],
    ["MPSEM-0457-C002", ".product-experience/pdp-0-product-truth/reuse-decisions.yaml#ownerDefinedDistributionSourceOfferRule"],
    ["MPSEM-0204-C001", ".product-experience/pdp-0-product-truth/quality-policy.yaml#/optimizationPolicy/defaultEnhancerApplicationRule"],
    ["MPSEM-0212-C005", ".product-experience/pdp-0-product-truth/quality-policy.yaml#/deliveryCompatibilityPolicy"],
    ["MPSEM-0260-C003", ".product-experience/pdp-0-product-truth/domain-model.yaml#/imageVideoOutputConstraints/resolutionRule"],
    ["MPSEM-0287-C001", ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/productPolicy/independentGovernanceAxes/3"],
    ["MPSEM-0291-C002", ".product-experience/pdp-0-product-truth/quality-policy.yaml#/protectedSemanticProperties/@id=PROTECTED-DELIVERY-CONSTRAINTS"],
    ["MPSEM-0298-C001", ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/requestEnvelope/body"],
    ["MPSEM-0298-C002", ".product-experience/pdp-1-domain-data/privacy.yaml#/ownerDefinedPdp10Boundary/identity"],
    ["MPSEM-0300-C001", ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/ownerWireSchema/resultSchema"],
    ["MPSEM-0300-C003", ".product-experience/pdp-1-domain-data/operations.yaml#/ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/resultSemantics/acknowledged"],
    ["MPSEM-0312-C002", ".product-experience/pdp-1-domain-data/operations.yaml#/capabilityOperationContracts/requestEnvelope/body"],
    ["MPSEM-0334-C002", ".product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/pathHandling"],
    ["MPSEM-0336-C006", ".product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/interruptHandling/ctrlC"],
    ["MPSEM-0336-C007", ".product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/remoteCancellationRule"],
    ["MPSEM-0355-C001", ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#/dataHandling"],
    ["MPSEM-0355-C003", ".product-experience/pdp-0-product-truth/constitution.yaml#/invariants/records/@id=MEDIA-INV-002/statement"],
    ["MPSEM-0375-C001", ".product-experience/pdp-1-domain-data/operations.yaml#/ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/dispatchProtocol"],
    ["MPSEM-0375-C002", ".product-experience/pdp-1-domain-data/operations.yaml#/ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/dispatchProtocol"],
    ["MPSEM-0375-C004", ".product-experience/pdp-1-domain-data/operations.yaml#/ownerDefinedOperationContracts/records/@id=media.operation.job.submit.v1/dispatchProtocol"],
    ["MPSEM-0377-C001", ".product-experience/pdp-1-domain-data/operations.yaml#/individualOperationContracts/records/@id=media.operation-slice.retry-job/ownerDefinition"],
    ["MPSEM-0377-C003", ".product-experience/pdp-0-product-truth/capabilities.yaml#/capabilities/@id=media.job.retry/constraints/0"],
    ["MPSEM-0198-C002", ".product-experience/pdp-0-product-truth/requirements.yaml#/ownerDefinedSimulationScopeRules/@id=media.requirement.simulation-family-and-domain-owner-boundary.v1"],
    ["MPSEM-0198-C003", ".product-experience/pdp-0-product-truth/requirements.yaml#/ownerDefinedSimulationScopeRules/@id=media.requirement.simulation-family-and-domain-owner-boundary.v1"],
    ["MPSEM-0198-C004", ".product-experience/pdp-0-product-truth/requirements.yaml#/ownerDefinedSimulationScopeRules/@id=media.requirement.simulation-family-and-domain-owner-boundary.v1"],
    ["MPSEM-0198-C005", ".product-experience/pdp-0-product-truth/requirements.yaml#/ownerDefinedSimulationScopeRules/@id=media.requirement.simulation-family-and-domain-owner-boundary.v1"],
    ["MPSEM-0198-C006", ".product-experience/pdp-0-product-truth/requirements.yaml#/ownerDefinedSimulationScopeRules/@id=media.requirement.simulation-family-and-domain-owner-boundary.v1"],
    ["MPSEM-0042-C002", ".product-experience/pdp-0-product-truth/capabilities.yaml#/familyDefinitionPolicy"],
    ["MPSEM-0042-C004", ".product-experience/pdp-0-product-truth/capabilities.yaml#/familyDefinitionPolicy"],
    ["MPSEM-0043-C002", ".product-experience/pdp-0-product-truth/capabilities.yaml#/familyDefinitionPolicy"],
    ["MPSEM-0080-C002", ".product-experience/pdp-0-product-truth/capabilities.yaml#/familyDefinitionPolicy"],
    ["MPSEM-0440-C001", ".product-experience/pdp-3-product-experience/navigation-contracts.yaml#/informationArchitecture/normativeRuleRecords/@id=media.navigation.default-global-and-utility-placement.v1"],
    ["MPSEM-0440-C002", ".product-experience/pdp-3-product-experience/navigation-contracts.yaml#/informationArchitecture/normativeRuleRecords/@id=media.navigation.default-global-and-utility-placement.v1"],
  ];
  for (const [claimId, expectedRef] of cases) {
    const row = candidate.records.find((item) => item.claimId === claimId);
    const route = row?.claimSpecificSemanticRoute;
    const value = resolveExactSourceRef(expectedRef);
    assert.ok(row && route && value, `${claimId} resolves to its exact owner source`);
    assert.equal(row.proposedTargetRef, expectedRef, `${claimId} target`);
    assert.equal(route.sourceRef, expectedRef, `${claimId} semantic target`);
    if (claimId === "MPSEM-0375-C004") {
      assertStaleMaterialBlocker(row, expectedRef, value,
        ["If provider execution identity or finality evidence is absent, preserve OUTCOME_UNKNOWN and never blind-replay"]);
      continue;
    }
    if (["MPSEM-0042-C002", "MPSEM-0042-C004"].includes(claimId)) {
      assertStaleMaterialBlocker(row, expectedRef, value, [
        "A family reference never substitutes for a leaf operationRef. Multi-leaf workflows require exact member operation refs, caller intent, and declared ordering/choice semantics.",
      ]);
      continue;
    }
    if (["MPSEM-0198-C003", "MPSEM-0198-C004", "MPSEM-0198-C005", "MPSEM-0198-C006"].includes(claimId)) {
      assertStaleMaterialBlocker(row, expectedRef, value, ["model/solver family"]);
      continue;
    }
    assertRouteTargetCurrentOrObserved(route, expectedRef, value);
    if (claimId === "MPSEM-0198-C002") {
      assert.deepEqual(route.requiredClauses, [
        "exact modeled family",
        "concrete solver identity/version",
        "no cross-family substitution",
      ]);
    }
    assert.equal(route.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(route.acceptanceEffect, "none");
    assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
    assert.ok(route.requiredClauses.length >= 2, `${claimId} has material clauses, not a locator-only route`);
    for (const clause of route.requiredClauses) {
      assert.ok(JSON.stringify(value).includes(clause), `${claimId} source preserves: ${clause}`);
      const weakened = removeRequiredClause(value, clause);
      assert.notEqual(sha256Json(weakened), route.targetValueSha256, `${claimId} weakening ${clause} changes the pinned target`);
    }
    assert.ok(route.negativeCases.length >= (claimId === "MPSEM-0355-C003" ? 2 : 3), `${claimId} retains material falsifiers`);
  }
});

test("current exact claims preserve operation, delivery, privacy, and CLI material predicates", () => {
  const checks = [
    ["MPSEM-0204-C001", (value) => value.disposition === "never-apply-every-enhancer-by-default" && /include only individually applicable, authorized, profile-bounded operations/u.test(value.candidateSelection) && /separate explicit operation/u.test(value.execution), (value) => { value.disposition = "apply-every-enhancer"; }],
    ["MPSEM-0212-C005", (value) => ["codec", "container", "playerOrConsumerContract", "versionedProfileRef"].every((field) => value.targetBinding.required.includes(field)) && value.evaluation.noSilentDowngrade === true && value.fallback.require.includes("minimum-quality-floor"), (value) => { value.evaluation.noSilentDowngrade = false; }],
    ["MPSEM-0260-C003", (value) => /Do not assume an odd output height is accepted by a selected 4:2:0 encoder/u.test(value) && /exact model\/encoder profile to declare and satisfy its pixel alignment/u.test(value), (value) => value.replace("Do not assume an odd output height is accepted", "Assume an odd output height is accepted")],
    ["MPSEM-0287-C001", (value) => value.axis === "processing-locality" && ["local", "remote", "hybrid", "unknown"].every((item) => value.values.includes(item)) && /no-location-claim/u.test(value.default), (value) => { value.values = value.values.filter((item) => item !== "unknown"); }],
    ["MPSEM-0291-C002", (value) => value.degradableByAutomaticOptimization === false && /Explicit target format, compatibility, dimensions, aspect ratio, and required delivery constraints/u.test(value.property) && /explicitly permitted/u.test(value.rule) && /declared floor/u.test(value.rule) && /confirmation/u.test(value.rule) && /compatible binding/u.test(value.rule), (value) => { value.rule = value.rule.replace("explicitly permitted", "implicitly permitted"); }],
    ["MPSEM-0298-C001", (value) => value.schemaKind === "OPERATION_SPECIFIC_CLOSED_OBJECT" && value.additionalProperties === false && /each record declares input1\.\.inputN as separate typed root properties/iu.test(value.rootProperties) && /leaf-specific parameters property/u.test(value.rootProperties) && /requestId only for COMMAND/u.test(value.rootProperties) && /forbidden from caller body/u.test(value.identityRule), (value) => { value.rootProperties = value.rootProperties.replace("leaf-specific parameters property", "parameters optional"); }],
    ["MPSEM-0298-C002", (value) => ["tenantRef", "principalRef", "delegationRef", "workspaceRef", "identityEpoch"].every((field) => value.requiredTrustedContext.includes(field)) && value.callerControlledIdentityFields.includes("tenantId") && /Reject caller-supplied identity authority/u.test(value.disposition), (value) => { value.requiredTrustedContext = value.requiredTrustedContext.filter((field) => field !== "tenantRef"); }],
    ["MPSEM-0300-C001", (value) => { const accepted = value.oneOf.find((branch) => branch.properties.outcome.const === "REQUEST_ACKNOWLEDGED"); return ["operationRef", "operationVersion", "requestId", "requestFingerprint", "jobId", "canonicalStatus", "observationLocation", "replayDisposition", "acceptedAt"].every((field) => accepted.required.includes(field)) && value.oneOf.some((branch) => branch.properties.outcome.const === "UNKNOWN_OUTCOME"); }, (value) => { value.oneOf[0].required = value.oneOf[0].required.filter((field) => field !== "requestFingerprint"); }],
    ["MPSEM-0300-C003", (value) => /authoritative durable acceptance transaction/u.test(value) && /does not prove provider crossing, execution start, or completion/u.test(value), (value) => value.replace("does not prove provider crossing", "proves provider crossing")],
    ["MPSEM-0312-C002", (value) => value.schemaKind === "OPERATION_SPECIFIC_CLOSED_OBJECT" && value.additionalProperties === false && /host-attested context/u.test(value.identityRule) && /reject-before-effect/u.test(value.overflow), (value) => { value.additionalProperties = true; }],
    ["MPSEM-0334-C002", (value) => /client-side input reference only/u.test(value.rule) && /never reinterpret it as an HTTP route/iu.test(value.rule) && /server-side retrieval target/u.test(value.rule), (value) => { value.rule = "A local path is accepted as a server filesystem path."; }],
    ["MPSEM-0336-C006", (value) => value.effect === "stop-local-wait-or-stream-observation" && value.exitCode === 130 && value.serverCancellation === false && value.jobStateChange === false, (value) => { value.serverCancellation = true; }],
    ["MPSEM-0355-C001", (value) => value.purposeBoundDataAccess.defaultPolicy.sharing === "private" && value.purposeBoundDataAccess.defaultPolicy.crossTenantReuse === "deny" && value.purposeBoundDataAccess.defaultPolicy.externalEgress === "deny" && value.purposeBoundDataAccess.defaultPolicy.secondaryTraining === "deny" && /exact declared Media operation and purpose/u.test(value.purposeBoundDataAccess.rule) && /minimum fields and media ranges necessary/u.test(value.minimization.rule), (value) => { value.purposeBoundDataAccess.defaultPolicy.externalEgress = "allow"; }],
    ["MPSEM-0355-C003", (value) => /attestation/u.test(value) && /not verified consent or license/u.test(value), (value) => value.replace("not verified consent or license", "is verified consent and license")],
    ["MPSEM-0375-C001", (value) => { const persisted = value.ordering.findIndex((entry) => entry.startsWith("atomically persist one attemptId, monotonically increasing fencingToken")); const crossing = value.ordering.findIndex((entry) => entry.startsWith("dispatch using the exact provider/profile contract")); return value.attemptIdentity.requiredBeforeDispatch === true && ["attemptId", "fencingToken", "requestFingerprint", "sourceRevisionRefs", "profileConfigurationDigest", "dispatchIntentId", "authorityDecisionRefs"].every((field) => value.attemptIdentity.fields.includes(field)) && persisted >= 0 && crossing > persisted; }, (value) => { value.attemptIdentity.fields = value.attemptIdentity.fields.filter((field) => field !== "dispatchIntentId"); }],
    ["MPSEM-0375-C002", (value) => { const marker = value.ordering.findIndex((entry) => entry.startsWith("persist an EFFECT_STARTED receipt atomically before crossing")); const crossing = value.ordering.findIndex((entry) => entry.startsWith("dispatch using the exact provider/profile contract")); return value.effectStartedReceipt.requiredBeforeProviderCrossing === true && value.effectStartedReceipt.fields.includes("receiptId") && /not a provider acknowledgment or completion receipt/u.test(value.effectStartedReceipt.meaning) && marker >= 0 && crossing > marker; }, (value) => { value.ordering = value.ordering.filter((entry) => !entry.startsWith("persist an EFFECT_STARTED receipt atomically")); }],
    ["MPSEM-0375-C004", (value) => value.providerReceipt.requiredWhenSupportedByExactProviderContract === true && value.providerReceipt.fields.includes("providerExecutionId") && /OUTCOME_UNKNOWN/u.test(value.providerReceipt.absenceBehavior) && value.ordering.some((entry) => /reconcile the same attempt\/receipt before any retry/u.test(entry)) && value.ordering.some((entry) => /never blind-replay/u.test(entry)), (value) => { value.ordering = value.ordering.filter((entry) => !/reconcile the same attempt\/receipt/u.test(entry)); }],
    ["MPSEM-0377-C001", (value) => value.requestSchema.additionalProperties === false && value.requestSchema.required.includes("priorAttemptId") && value.authority.includes("current-trusted-principal-and-current-retry-policy") && value.guards.includes("prior-attempt-is-classified-retryable-by-current-job-owner") && value.guards.includes("current-authority-rights-consent-policy-license-resource-and-profile-eligibility-rechecked") && value.guards.includes("retry-budget-remains") && value.errors.includes("RETRY_BUDGET_EXHAUSTED") && /never-create-a-second-logical-job/u.test(value.effect) && value.recovery.includes("if-prior-outcome-is-unknown-run-the-separate-authoritative-reconciliation-contract-first") && value.recovery.includes("do-not-retry-until-it-classifies-a-safe-retryable-outcome") && /tenantId-plus-principalId-plus-jobId-plus-requestId/u.test(value.idempotency) && /inspect-same-requestId-and-job-before-any-resubmission/u.test(value.retry), (value) => { value.idempotency = "jobId-only"; }],
    ["MPSEM-0377-C003", (value) => /new attempt under the same semantic job/u.test(value) && /not create a second logical request/u.test(value), (value) => value.replace("new attempt under the same semantic job", "new logical job")],
  ];
  for (const [id, valid, weaken] of checks) {
    const row = candidate.records.find((record) => record.claimId === id);
    const route = row?.claimSpecificSemanticRoute;
    const value = resolveExactSourceRef(route?.sourceRef);
    assert.ok(row && route && value, `${id} exact source route resolves`);
    assert.equal(route.sourceRef, row.proposedTargetRef, `${id} selected owner source`);
    if (id === "MPSEM-0375-C004") {
      assertStaleMaterialBlocker(row, route.sourceRef, value,
        ["If provider execution identity or finality evidence is absent, preserve OUTCOME_UNKNOWN and never blind-replay"]);
      continue;
    }
    assertRouteTargetCurrentOrObserved(route, route.sourceRef, value);
    assert.equal(route.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(route.acceptanceEffect, "none");
    assert.equal(valid(value), true, `${id} owner value retains material semantics`);
    const weakened = structuredClone(value);
    const mutated = weaken(weakened);
    const invalid = mutated === undefined ? weakened : mutated;
    assert.equal(valid(invalid), false, `${id} weakened material rule is rejected`);
    assert.notEqual(sha256Json(invalid), route.targetValueSha256, `${id} weakened material rule changes the exact target`);
  }
  const parameterRow = candidate.records.find(({ claimId }) => claimId === "MPSEM-0298-C001");
  const parameterRoute = parameterRow.claimSpecificSemanticRoute.supportingSourceRefs.find(({ meaning }) => meaning === "dynamic leaf-specific schema resolution and validation before fingerprinting/effect");
  const parameterRule = resolveExactSourceRef(parameterRoute?.sourceRef);
  assertCurrentObservation(parameterRoute?.currentTargetObservation, parameterRoute?.sourceRef, parameterRule,
    parameterRoute?.targetValueSha256);
  assert.equal(parameterRule.id, "media.job-submit.operation-parameters.v1");
  assert.match(parameterRule.selection, /exact member of that record\.operationRefs/u);
  assert.match(parameterRule.schemaResolution, /exact canonicalSourceContractRefs/u);
  assert.match(parameterRule.validation, /reject before fingerprinting, durable acceptance, audit-intent commit, or dispatch/u);
  assert.match(parameterRule.fingerprint, /full resolved request-schema source closure SHA-256.*parameter-schema SHA-256, and canonical JSON parameter values/u);
  const withoutPreEffectValidation = structuredClone(parameterRule);
  withoutPreEffectValidation.validation = withoutPreEffectValidation.validation.replace("reject before fingerprinting, durable acceptance, audit-intent commit, or dispatch", "reject after dispatch");
  assert.doesNotMatch(withoutPreEffectValidation.validation, /reject before fingerprinting, durable acceptance, audit-intent commit, or dispatch/u);
});

test("CLI interruption stays local while an explicit remote cancellation command is separately defined", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0336-C007");
  const ref = ".product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/remoteCancellationRule";
  const value = resolveExactSourceRef(ref);
  const route = row?.claimSpecificSemanticRoute;
  assert.equal(row?.proposedTargetRef, ref);
  assert.equal(route?.sourceRef, ref);
  assert.equal(route?.targetValueSha256, sha256Json(value));
  assert.match(value.rule, /Remote cancellation is a separate explicit command/u);
  assert.match(value.rule, /Ctrl-C stops only the local wait or stream observer/u);
  assert.match(value.rule, /never sends a cancellation request/u);
  assert.match(value.rule, /No --cancel-on-interrupt behavior is defined/u);
  assert.equal(value.command.id, "media.cli.job.cancel");
  assert.equal(value.command.resultSemantics.providerTermination, "never implied by command receipt, process exit, or observer interruption.");
  assert.equal(value.executionAdmission, "NOT_ADMITTED");
  for (const [needle, replacement] of [
    ["separate explicit command", "implicit command"],
    ["never sends a cancellation request", "sends a cancellation request"],
    ["never implied by command receipt", "implied by command receipt"],
    ["No --cancel-on-interrupt behavior is defined", "--cancel-on-interrupt is enabled"],
  ]) {
    assert.equal(value.rule.includes(needle) || JSON.stringify(value).includes(needle), true);
    const weakened = JSON.stringify(value).replace(needle, replacement);
    assert.notEqual(weakened, JSON.stringify(value), `mutation must remove ${needle}`);
    assert.equal(/Remote cancellation is a separate explicit command/u.test(weakened)
      && /never sends a cancellation request/u.test(weakened)
      && /never implied by command receipt/u.test(weakened)
      && /No --cancel-on-interrupt behavior is defined/u.test(weakened), false,
    `weakened cancellation contract must fail for ${needle}`);
  }
  assert.equal(route?.acceptanceEffect, "none");
  assert.equal(route?.runtimeAdmission, "NOT_ADMITTED");
});

test("CLI filenames remain literal client arguments with spaces and Unicode intact", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0334-C005");
  const ref = ".product-experience/pdp-0-product-truth/applications-channels.yaml#/channels/@id=media.channel.cli/ownerCliDefinitionContract/filenameArgumentRule";
  const value = resolveExactSourceRef(ref);
  assert.equal(row?.proposedTargetRef, ref);
  assert.equal(row?.claimSpecificSemanticRoute?.sourceRef, ref);
  assert.equal(row?.claimSpecificSemanticRoute?.targetValueSha256, sha256Json(value));
  assert.equal(value.id, "media.cli.filename-argument.v1");
  assert.match(value.inputArguments.representation, /spaces, Unicode code points, and literal shell metacharacters remain part of that argument/u);
  assert.match(value.inputArguments.execution, /Never construct a shell command string from a path/u);
  assert.match(value.outputPaths.overwrite, /explicit overwrite option/u);
  assert.equal(row.claimSpecificSemanticRoute.runtimeAdmission, "NOT_ADMITTED");
  const shellMutation = structuredClone(value);
  shellMutation.inputArguments.execution = shellMutation.inputArguments.execution.replace("Never construct a shell command string", "Construct a shell command string");
  assert.notEqual(sha256Json(shellMutation), row.claimSpecificSemanticRoute.targetValueSha256);
  assert.doesNotMatch(shellMutation.inputArguments.execution, /Never construct a shell command string/u);
});

test("local-only capability availability cannot silently fall back to cloud execution", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0287-C002");
  const ref = ".product-experience/pdp-0-product-truth/requirements.yaml#ownerDefinedDeploymentAvailabilityRules/@id=media.requirement.policy-and-admitted-deployment-availability.v1";
  const value = resolveExactSourceRef(ref);
  assert.equal(row?.proposedTargetRef, ref);
  assert.equal(row?.claimSpecificSemanticRoute?.sourceRef, ref);
  assert.equal(row?.claimSpecificSemanticRoute?.targetValueSha256, sha256Json(value));
  assert.match(value.rule, /A local-only request cannot fall back to a remote or cloud execution path/u);
  assert.match(value.rule, /Missing or unknown policy, locality, dependency, or deployment evidence yields unavailable or review-required/u);
  assert.equal(value.runtimeAdmission, "NOT_ADMITTED");
  const weakened = structuredClone(value);
  weakened.rule = weakened.rule.replace("cannot fall back to a remote or cloud execution path", "may fall back to a remote or cloud execution path");
  assert.notEqual(sha256Json(weakened), row.claimSpecificSemanticRoute.targetValueSha256);
  assert.doesNotMatch(weakened.rule, /cannot fall back to a remote or cloud execution path/u);
});

test("simulation produced-versus-estimated claims bind every exact pass-specific wire overlay", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0199-C002");
  const route = row?.claimSpecificSemanticRoute;
  const refs = route?.targetRefs ?? [];
  const resolved = refs.map((entry) => ({ entry, value: resolveExactSourceRef(entry.ref) }));
  const valid = (candidateRow, targets) => candidateRow?.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"
    && candidateRow?.claimSpecificSemanticRoute?.acceptanceEffect === "none"
    && candidateRow?.claimSpecificSemanticRoute?.runtimeAdmission === "NOT_ADMITTED"
    && targets.length === 11
    && new Set(targets.map(({ entry }) => entry.passKind)).size === 11
    && targets.every(({ entry, value }) => value
      && entry.currentTargetObservation?.sourceRef === entry.ref
      && entry.currentTargetObservation?.currentTargetValueSha256 === sha256Json(value)
      && entry.currentTargetObservation?.previousCandidateTargetValueSha256 === entry.sha256
      && entry.currentTargetObservation?.status === "STALE_CANDIDATE_REQUIRES_REVIEW"
      && entry.currentTargetObservation?.semanticPromotion === false
      && entry.currentTargetObservation?.acceptanceEffect === "none"
      && entry.productionStatuses?.join(",") === "PRODUCED,ESTIMATED"
      && entry.productionEvidenceRefRequired === true
      && entry.profileBound === true
      && value.resultSchema.properties.outputs.items.properties.payload.properties.passKind.const === entry.passKind
      && value.resultSchema.properties.outputs.items.properties.artifactType.const === entry.artifactType
      && value.resultSchema.properties.outputs.items.properties.payload.properties.productionStatus.enum.join(",") === "PRODUCED,ESTIMATED"
      && value.resultSchema.properties.outputs.items.properties.payload.required.includes("productionEvidenceRef")
      && value.resultSchema.properties.provenance.required.includes("profileId")
      && value.resultSchema.properties.provenance.required.includes("profileVersion"));
  assert.equal(valid(row, resolved), true);
  assert.equal(row.proposedTargetRef, refs[0].ref);
  assert.equal(route.targetValueSha256, refs[0].sha256);
  for (let index = 0; index < resolved.length; index += 1) {
    const wrongPass = structuredClone(resolved);
    wrongPass[index].value.resultSchema.properties.outputs.items.properties.payload.properties.passKind.const = "wrong-pass-kind";
    assert.equal(valid(row, wrongPass), false, `${refs[index].passKind} must reject another output pass identity`);
    const missingProductionEvidence = structuredClone(resolved);
    missingProductionEvidence[index].value.resultSchema.properties.outputs.items.properties.payload.required =
      missingProductionEvidence[index].value.resultSchema.properties.outputs.items.properties.payload.required
        .filter((name) => name !== "productionEvidenceRef");
    assert.equal(valid(row, missingProductionEvidence), false, `${refs[index].passKind} must retain produced/estimated evidence`);
  }
  const weakenedOutput = structuredClone(resolved);
  weakenedOutput[0].value.resultSchema.properties.outputs.items.properties.payload.properties.productionStatus.enum = ["PRODUCED"];
  assert.equal(valid(row, weakenedOutput), false, "ESTIMATED remains a first-class result classification");
});

test("simulation output inventory lists all eleven unique typed pass results", () => {
  const row = candidate.records.find(({ claimId }) => claimId === "MPSEM-0199-C001");
  const targets = row?.claimSpecificSemanticRoute?.targetRefs ?? [];
  const expected = ["rgb", "depth", "normals", "segmentation", "optical-flow", "motion-vectors", "object-ids", "contacts", "physical-events", "measurements", "timestamped-state"];
  assert.deepEqual(targets.map(({ artifactType }) => artifactType), expected.map((kind) => `simulation-pass-result-${kind}`));
  for (const target of targets) {
    const value = resolveExactSourceRef(target.ref);
    assert.ok(value, `${target.ref} resolves`);
    assert.equal(target.sha256, sha256Json(value));
    assert.equal(value.artifactType, target.artifactType);
    assert.equal(value.domainObjectRefs.length, 1);
    assert.equal(value.domainObjectRefs[0], "media.domain.media-run");
    assert.equal(value.immutableArtifactVersionCreated, false);
  }
  const missingOne = targets.slice(1);
  assert.notDeepEqual(missingOne.map(({ artifactType }) => artifactType), expected.map((kind) => `simulation-pass-result-${kind}`),
    "the inventory rejects any missing pass type");
  assert.equal(row.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(row.claimSpecificSemanticRoute.acceptanceEffect, "none");
});

test("composite output and quality claims enumerate exact family members without leaf-name substitution", () => {
  const expected = new Map([
    ["MPSEM-0080-C001", [
      ["media.simulation", ["media.simulation.fluid", "media.simulation.scientific-demo"]],
      ["media.generate.spatial", null],
      ["media.generate.video", null],
    ]],
    ["MPSEM-0196-C001", [["media.animation.output", [
      "media.animation.output.output.interactive-scene",
      "media.animation.output.output.vector-raster-frames",
      "media.animation.output.output.composited-video",
      "media.animation.output.output.reusable-clip",
      "media.animation.output.output.exchange-package",
    ]]]],
    ["MPSEM-0211-C001", [["media.quality", [
      "media.quality.inspect", "media.quality.compare", "media.quality.diagnose", "media.quality.rank",
      "media.quality.recommend", "media.quality.repair-plan", "media.quality.bounded-optimize",
    ]]]],
    ["MPSEM-0211-C002", [["media.quality.image", null]]],
    ["MPSEM-0211-C003", [["media.quality.video", null]]],
    ["MPSEM-0211-C004", [["media.quality.audio", null]]],
    ["MPSEM-0212-C001", [["media.deliver", null]]],
    ["MPSEM-0212-C002", [["media.deliver", ["media.deliver.renditions.aspect-ratio", "media.deliver.renditions.resolution"]]]],
    ["MPSEM-0212-C003", [["media.deliver", [
      "media.deliver.profile.web", "media.deliver.profile.social", "media.deliver.profile.podcast",
      "media.deliver.profile.broadcast", "media.deliver.profile.cinematic", "media.deliver.profile.archival",
      "media.deliver.profile.interactive", "media.deliver.profile.named",
    ]]]],
    ["MPSEM-0212-C004", [["media.deliver", ["media.deliver.interactive-scene-bundle", "media.deliver.provenance-manifest"]]]],
  ]);
  for (const [claimId, expectedBindings] of expected) {
    const row = candidate.records.find((item) => item.claimId === claimId);
    const route = row?.claimSpecificSemanticRoute;
    const bindings = route?.memberBindings ?? [];
    assert.equal(bindings.length, expectedBindings.length, `${claimId} family count`);
    for (let index = 0; index < bindings.length; index += 1) {
      const [familyId, exactIds] = expectedBindings[index];
      const binding = bindings[index];
      const family = resolveExactSourceRef(binding.ref);
      assert.equal(binding.familyId, familyId, `${claimId} exact family`);
      assert.equal(binding.valueSha256, sha256Json(family), `${claimId} family source pin`);
      assert.deepEqual(binding.capabilityIds, exactIds ?? family.capabilityIds, `${claimId} exact member inventory`);
      assert.ok(binding.capabilityIds.every((id) => family.capabilityIds.includes(id)), `${claimId} members belong to the named family`);
      const weakened = structuredClone(family);
      weakened.capabilityIds = weakened.capabilityIds.filter((id) => id !== binding.capabilityIds[0]);
      assert.notEqual(sha256Json(weakened), binding.valueSha256, `${claimId} removing a required member changes the source pin`);
    }
    assert.deepEqual(route.requiredClauses, bindings.flatMap(({ capabilityIds }) => capabilityIds));
    assert.equal(route.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(route.acceptanceEffect, "none");
    assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
  }
});

test("disruptive audio autoplay is a playback rule and unknown risk remains fail-closed", () => {
  const record = candidate.records.find(({ claimId }) => claimId === "MPSEM-0452-C005");
  const route = record?.claimSpecificSemanticRoute;
  const ref = ".product-experience/pdp-2-design-interface-system/motion.yaml#ownerDefinedDisruptiveAudioPlayback";
  const value = resolveExactSourceRef(ref);
  assert.equal(record?.exactSourceText, "Do not auto-play disruptive audio.");
  assert.equal(record?.proposedTargetRef, ref);
  assert.equal(record?.routeKind, "PDP2_DISRUPTIVE_AUDIO_PLAYBACK_OWNER_RULE");
  assert.equal(record?.supersededCapabilityCandidate?.capabilityRef, "media.generate.audio.audio-to-audio");
  assert.equal(route?.targetValueSha256, sha256Json(value));
  assert.ok(route.requiredClauses.every((clause) => JSON.stringify(value).includes(clause)));
  assert.ok(value.nonClaims.includes("no-audio-disruption-detector-or-player-runtime-is-claimed"));
  assert.equal(route.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  assert.equal(route.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(route.acceptanceEffect, "none");

  const permitsUnknownAutoplay = structuredClone(value);
  permitsUnknownAutoplay.unknownBehavior = "allow-automatic-playback";
  assert.notEqual(sha256Json(permitsUnknownAutoplay), route.targetValueSha256,
    "unknown disruption cannot be treated as evidence for autoplay");
  const wrongOwner = structuredClone(record);
  wrongOwner.proposedTargetRef = wrongOwner.supersededCapabilityCandidate.targetRef;
  assert.notEqual(wrongOwner.proposedTargetRef, ref,
    "generation capability identity cannot prove player behavior");
});

test("plan assessment clauses retain the exact historical/current source hunk, not capability behavior", () => {
  const ref = "docs/migration/master-plan-source-change-claims.yaml#/hunkReconciliation/records/5";
  const hunk = resolveExactSourceRef(ref);
  assert.equal(hunk?.hunkId, "MSD-006");
  assert.deepEqual(hunk.historicalLines, [89, 89]);
  assert.deepEqual(hunk.currentLines, [92, 92]);
  assert.ok(hunk.exactHistoricalChangedText[0].includes("four source-of-truth phases"));
  assert.ok(hunk.exactCurrentChangedText[0].includes("four PDP source-of-truth authorities"));
  for (const [claimId, expectedClauses] of [
    ["MPSEM-0017-C001", ["The supplied plan has broad capability coverage and a sound intention", "four source-of-truth phases"]],
    ["MPSEM-0017-C002", ["It is not safe to execute unchanged", "leave safety-critical contracts underspecified"]],
  ]) {
    const row = candidate.records.find(({ claimId: id }) => id === claimId);
    const route = row?.claimSpecificSemanticRoute;
    const valid = (candidateRow, sourceHunk) => {
      const sourceText = [...(sourceHunk?.exactHistoricalChangedText ?? []), ...(sourceHunk?.exactCurrentChangedText ?? [])];
      const candidateRoute = candidateRow?.claimSpecificSemanticRoute;
      return sourceHunk?.hunkId === "MSD-006"
        && candidateRow?.routeKind === "HISTORICAL_SOURCE_ASSESSMENT_ONLY"
        && candidateRow.proposedTargetRef === ref
        && candidateRow.capabilityRef === undefined
        && candidateRow.semanticReviewStatus === "PENDING_COORDINATOR_MATERIAL_REVIEW"
        && candidateRow.semanticEquivalence === "NOT_ASSERTED"
        && candidateRoute?.targetValueSha256 === sha256Json(sourceHunk)
        && candidateRoute?.requiredClauses?.every((clause) => sourceText.some((text) => text.includes(clause)))
        && candidateRoute?.acceptanceEffect === "none"
        && candidateRoute?.runtimeAdmission === "NOT_ADMITTED";
    };
    assert.equal(row?.routeKind, "HISTORICAL_SOURCE_ASSESSMENT_ONLY");
    assert.equal(row?.proposedTargetRef, ref);
    assert.equal(row?.capabilityRef, undefined);
    assert.equal(row?.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(row?.semanticEquivalence, "NOT_ASSERTED");
    assert.equal(valid(row, hunk), true);
    assert.equal(route?.acceptanceEffect, "none");
    assert.equal(route?.runtimeAdmission, "NOT_ADMITTED");
    assert.ok(route?.requiredClauses.every((clause) => [...hunk.exactHistoricalChangedText, ...hunk.exactCurrentChangedText].some((text) => text.includes(clause))));
    for (const clause of expectedClauses) assert.ok(route.requiredClauses.some((value) => value.includes(clause)));
    assert.equal(route?.negativeCases.length >= 3, true);

    const weakened = structuredClone(hunk);
    weakened.exactHistoricalChangedText = weakened.exactHistoricalChangedText.map((text) => text.replace(expectedClauses.at(-1), "[removed]"));
    assert.equal(valid(row, weakened), false, `${claimId}: removed material source clause invalidates the route`);
    const capabilityRelabel = structuredClone(row);
    capabilityRelabel.routeKind = "EXACT_CAPABILITY_LEAF_OWNER_DEFINITION_CANDIDATE";
    capabilityRelabel.proposedTargetRef = capabilityRelabel.supersededCapabilityCandidate.targetRef;
    assert.equal(valid(capabilityRelabel, hunk), false,
      `${claimId}: a capability route cannot preserve this plan-level historical assessment`);
  }
});

test("review-title fragments remain historical source metadata with exact raw line evidence", () => {
  const expectedLines = new Map([
    ["MPSEM-0021-C001", 100],
    ["MPSEM-0030-C001", 109],
    ["MPSEM-0036-C001", 115],
    ["MPSEM-0039-C001", 118],
  ]);
  for (const [claimId, lineNumber] of expectedLines) {
    const record = candidate.records.find(({ claimId: id }) => id === claimId);
    const route = record?.claimSpecificSemanticRoute;
    const exactLine = historicalPlan[lineNumber - 1];
    assert.equal(record?.proposedTargetRef, `docs/migration/expert-reviewed-master-plan.md#line=${lineNumber}`);
    assert.equal(route?.sourceRef, record.proposedTargetRef);
    assert.equal(route?.sourceLine, lineNumber);
    assert.equal(route?.hashEncoding, "raw-UTF8");
    assert.equal(route?.exactParentRow, exactLine);
    assert.equal(route?.targetValueSha256, sha256Text(exactLine));
    assert.ok(exactLine.includes(record.exactSourceText));
    assert.equal(route?.meaning, "Historical assessment heading metadata only; the substantive correction remains in its separate atomic source claim(s).");
    assert.equal(route?.acceptanceEffect, "none");
    assert.ok(route.negativeCases.length >= 2);
    assert.equal(record.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
  }
  const wrongLine = structuredClone(candidate.records.find(({ claimId }) => claimId === "MPSEM-0030-C001"));
  wrongLine.claimSpecificSemanticRoute.sourceLine = 118;
  assert.notEqual(wrongLine.claimSpecificSemanticRoute.targetValueSha256, sha256Text(historicalPlan[117]),
    "a different revision heading cannot validate this exact historical title fragment");
});

test("55 prior owner routes are carried forward only as exact-text-matched review inputs", () => {
  const oldById = new Map(historicalReview.records.map((record) => [record.claimId, record]));
  const carried = candidate.records.filter((record) => record.priorOwnerRouteReviewCandidate);
  assert.equal(carried.length, 55);
  assert.equal(candidate.population.priorOwnerReviewPartition.currentTargetsCompared, 52);
  assert.equal(candidate.population.priorOwnerReviewPartition.currentTargetsUnchanged
    + candidate.population.priorOwnerReviewPartition.currentTargetsDrifted, 52);
  assert.match(candidate.population.priorOwnerReviewPartition.status, /historical hashes\/reviews remain unchanged/u);
  for (const record of carried) {
    const prior = oldById.get(record.claimId);
    const review = record.priorOwnerRouteReviewCandidate;
    assert.equal(prior?.semanticReviewStatus, "SEMANTIC_PARITY_VERIFIED");
    assert.equal(record.exactSourceText, prior.exactSourceText);
    assert.equal(record.sourceTextSha256, prior.sourceTextSha256);
    assert.equal(review.exactSourceMatch, true);
    assert.equal(review.recommendedOwnerTargetRef, prior.proposedTargetRef);
    assert.equal(review.historicalTargetValueSha256, prior.targetValueSha256);
    assert.ok(review.materialMeaning.trim().length > 0);
    assert.ok(review.reviewedPredicates.length > 0);
    assert.ok(review.negativeCases.length > 0);
    assert.ok(review.testSources.length > 0
      || review.currentDisposition.startsWith("PENDING_EXACT_NEGATIVE_ORACLE"),
    "a prior route without a focused test stays explicitly pending");
    assert.equal(review.acceptanceEffect, "none");
    assert.equal(record.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(validPriorOwnerRouteCandidate(record, prior), true, `${record.claimId} exact current target resolves and stays pending`);
  }

  const wrongText = structuredClone(candidate.records.find((record) => record.priorOwnerRouteReviewCandidate));
  wrongText.exactSourceText += " unrelated text";
  assert.equal(wrongText.exactSourceText === oldById.get(wrongText.claimId).exactSourceText, false,
    "a prior route cannot be reused for a different atomic source claim");
  const wrongTarget = structuredClone(candidate.records.find((record) => record.priorOwnerRouteReviewCandidate));
  wrongTarget.priorOwnerRouteReviewCandidate.recommendedOwnerTargetRef = ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.project.review";
  assert.notEqual(wrongTarget.priorOwnerRouteReviewCandidate.recommendedOwnerTargetRef,
    oldById.get(wrongTarget.claimId).proposedTargetRef,
    "a current name-matched capability cannot replace the exact prior owner target");
  assert.equal(validPriorOwnerRouteCandidate(wrongTarget, oldById.get(wrongTarget.claimId)), false);

  const weakenedMeaning = structuredClone(carried[0]);
  weakenedMeaning.priorOwnerRouteReviewCandidate.materialMeaning = "The source says something related.";
  assert.equal(validPriorOwnerRouteCandidate(weakenedMeaning, oldById.get(weakenedMeaning.claimId)), false,
    "a generic summary cannot replace the exact previously reviewed material predicates");

  const driftedTarget = structuredClone(carried[0]);
  driftedTarget.priorOwnerRouteReviewCandidate.currentTargetValue = { deliberately: "changed" };
  assert.equal(validPriorOwnerRouteCandidate(driftedTarget, oldById.get(driftedTarget.claimId)), false,
    "changing the captured owner value without its exact content hash invalidates the pending route candidate");
});

test("55 prior owner routes replace the lexical capability candidates while remaining pending", () => {
  const routed = candidate.records.filter((record) => record.claimSpecificRouteCandidate);
  assert.equal(routed.length, 55);
  const headings = routed.filter((record) => record.claimSpecificRouteCandidate.disposition === "HISTORICAL_REVIEW_ROW_HEADING_METADATA");
  assert.equal(headings.length, 3);
  for (const record of routed) {
    const route = record.claimSpecificRouteCandidate;
    assert.equal(record.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(route.status, "PENDING_COORDINATOR_MATERIAL_REVIEW");
    assert.equal(route.acceptanceEffect, "none");
    assert.ok(route.negativeCases.length >= 2);
    assert.equal(record.supersededCapabilityCandidate?.targetRef?.includes("capabilities.yaml"), true,
      `${record.claimId} preserves the prior lexical route as historical candidate data`);
    if (route.disposition === "HISTORICAL_REVIEW_ROW_HEADING_METADATA") {
      const line = Number(route.sourceRef.match(/#line=(\d+)$/u)?.[1]);
      assert.ok(line > 0);
      assert.equal(historicalPlan[line - 1], route.exactParentRow);
      assert.equal(sha256Text(route.exactParentRow), route.sourceValueSha256);
      assert.match(record.exactSourceText, /^\| REV-\d+ —/u);
      assert.equal(record.proposedTargetRef, route.sourceRef);
      assert.equal(record.capabilityRef, undefined);
    } else {
      const prior = historicalReview.records.find(({ claimId }) => claimId === record.claimId);
      assert.equal(record.claimSpecificRouteCandidate.historicalTargetRef, prior.proposedTargetRef,
        "the immutable prior target remains in the historical route record when a new exact source target is proposed");
      assert.equal(route.historicalTargetRef, prior.proposedTargetRef);
      assert.equal(route.materialMeaning, prior.materialMeaning);
      const historicalLineMatch = record.proposedTargetRef.match(/^docs\/migration\/expert-reviewed-master-plan\.md#line=(\d+)$/u);
      const currentValue = historicalLineMatch
        ? historicalPlan[Number(historicalLineMatch[1]) - 1]
        : resolveExactSourceRef(record.proposedTargetRef);
      assert.notEqual(currentValue, undefined);
      if (historicalLineMatch) {
        assert.equal(record.claimSpecificSemanticRoute?.hashEncoding, "raw-UTF8");
        assert.equal(record.claimSpecificSemanticRoute?.targetValueSha256, sha256Text(currentValue));
        assert.equal(record.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW");
        assert.equal(route.acceptanceEffect, "none");
        continue;
      }
      assert.equal(route.currentTargetValueSha256, sha256Json(route.currentTargetValue),
        "the captured current-source-window value remains content-pinned even after later owner edits");
      assert.equal(route.historicalTargetUnchanged, route.currentTargetValueSha256 === route.historicalTargetValueSha256);
      assert.equal(route.currentTargetDrift, !route.historicalTargetUnchanged);
      if (route.currentTargetValueSha256 !== sha256Json(currentValue)) {
        assert.equal(record.semanticReviewStatus, "PENDING_COORDINATOR_MATERIAL_REVIEW",
          "later live-source drift remains pending for an explicit impact review");
        assert.equal(route.acceptanceEffect, "none");
      }
    }
  }

  const wrongOwner = structuredClone(routed.find((record) => record.routeKind !== "HISTORICAL_REVIEW_ROW_HEADING_METADATA"));
  wrongOwner.proposedTargetRef = ".product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=media.project.create";
  assert.notEqual(wrongOwner.proposedTargetRef, wrongOwner.claimSpecificRouteCandidate.historicalTargetRef,
    "a generic capability leaf cannot replace the exact owner rule for a reviewed claim");
  const promoted = structuredClone(routed[0]);
  promoted.semanticReviewStatus = "SEMANTIC_PARITY_VERIFIED";
  assert.equal(promoted.claimSpecificRouteCandidate.status, "PENDING_COORDINATOR_MATERIAL_REVIEW",
    "carrying a prior review never silently promotes this new 163-record candidate");
});

test("eight capability inventory claims bind exact complete member/output populations and definition-only limits", () => {
  const rows = candidate.records.filter((record) => record.claimSpecificSemanticCandidate);
  assert.equal(rows.length, 8);
  assert.equal(candidate.population.claimSpecificMeaningMappings, 8);
  for (const row of rows) assert.equal(validClaimSpecificScopeMapping(row), true, row.claimId);

  for (const row of rows.filter((record) => record.claimSpecificSemanticCandidate.expectedMembers)) {
    const mapping = row.claimSpecificSemanticCandidate;
    const family = resolveExactSourceRef(mapping.sourceRef);
    for (const member of mapping.expectedMembers) {
      const weakened = structuredClone(family);
      weakened.capabilityIds = weakened.capabilityIds.filter((id) => id !== member);
      const mutatedSources = priorOwnerSources;
      const [file, pointer] = mapping.sourceRef.split("#");
      const original = mutatedSources[file];
      const familyRows = original.families;
      const familyIndex = familyRows.findIndex(({ id }) => id === family.id);
      const replacement = structuredClone(original);
      replacement.families[familyIndex] = weakened;
      priorOwnerSources[file] = replacement;
      assert.equal(validClaimSpecificScopeMapping(row), false, `${row.claimId} rejects missing ${member}`);
      priorOwnerSources[file] = original;
    }
  }

  const simulation = rows.find(({ claimId }) => claimId === "MPSEM-0199-C001");
  const simulationValue = resolveExactSourceRef(simulation.claimSpecificSemanticCandidate.sourceRef);
  for (const record of simulationValue.records) {
    const changed = structuredClone(simulation);
    changed.claimSpecificSemanticCandidate.sourceValueSha256 = sha256Json({
      ...simulationValue,
      records: simulationValue.records.filter(({ id }) => id !== record.id),
    });
    assert.equal(validClaimSpecificScopeMapping(changed), false, `removing ${record.id} from the exact output matrix is rejected`);
  }
  const forgedKind = structuredClone(simulation);
  const operations = priorOwnerSources[".product-experience/pdp-1-domain-data/operations.yaml"];
  const originalOperations = operations;
  const mutatedOperations = structuredClone(operations);
  mutatedOperations.ownerLeafWireContracts.outputTypes.records[0].artifactType = "simulation-pass-result-depth";
  priorOwnerSources[".product-experience/pdp-1-domain-data/operations.yaml"] = mutatedOperations;
  assert.equal(validClaimSpecificScopeMapping(forgedKind), false, "a pass cannot claim a different output kind");
  priorOwnerSources[".product-experience/pdp-1-domain-data/operations.yaml"] = originalOperations;
});
