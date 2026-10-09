const unique = (values) => [...new Set((values ?? []).filter((value) => typeof value === "string" && value.length > 0))];

const plainRecord = (value) => value !== null && typeof value === "object"
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  && !Array.isArray(value);

// Older version-binding rows omit the separator in the journey prefix
// (J01.step-03 vs J-01.step-03). Compare that legacy spelling only after the
// canonical source path and journeyRef have independently matched.
const normalizeStepSemanticId = (value) => typeof value === "string"
  ? value.replace(/^(J)(\d+)(\.step-\d+)$/u, "$1-$2$3") : value;

/** Resolve an exact legacy machine/state token to its canonical PDP-1 source selector. */
export function resolvePdp1StateReference(ref, resolveDefinitionRef) {
  if (typeof resolveDefinitionRef !== "function") return ref;
  if (resolveDefinitionRef(ref)) return ref;
  const match = typeof ref === "string" ? ref.match(/^([^/]+)\/([^/]+)$/u) : null;
  if (!match) return ref;
  const canonicalRef = `.product-experience/pdp-1-domain-data/states.yaml#stateMachines/${match[1]}/stateDefinitions/${match[2]}`;
  return resolveDefinitionRef(canonicalRef) ? canonicalRef : ref;
}

/** Resolve a public reference only in the exact journey-step owner scope. */
export function isPdp3ReferenceInStepScope({ ref, owner, ownersByReference }) {
  if (typeof ref !== "string" || typeof owner !== "string" || !(ownersByReference instanceof Map)) return false;
  const allowedOwners = ownersByReference.get(ref);
  return allowedOwners instanceof Set ? allowedOwners.has(owner) : allowedOwners === owner;
}

/**
 * Compare a proposed canonical object-version tuple with the exact tuple a
 * trusted owner read selected for this step. The trusted tuple is an input to
 * this definition oracle, not proof that a runtime issuer actually produced
 * it. Incomplete, stale, latest-aliased, cross-tenant, mixed-version, and
 * wrong-object candidates remain UNKNOWN.
 */
export function evaluatePdp3CanonicalVersionTuple({ versionFieldBinding, objectRef, candidateTuple, expectedTuple, trustedTenantId, resolveDefinitionRef }) {
  if (!plainRecord(versionFieldBinding) || typeof versionFieldBinding.id !== "string"
    || versionFieldBinding.objectRef !== objectRef
    || versionFieldBinding.coverageDisposition !== "EXACT_VERSION_REQUEST_OR_RESULT_FIELD_BOUND"
    || typeof resolveDefinitionRef !== "function") return { verdict: "UNKNOWN", reason: "VERSION_BINDING_NOT_EXACT" };
  const requirement = versionFieldBinding.canonicalVersionIdentityRequirement;
  const identity = requirement?.identityContractRef && resolveDefinitionRef(requirement.identityContractRef);
  const components = requirement?.identityComponentsRef && resolveDefinitionRef(requirement.identityComponentsRef);
  if (!plainRecord(requirement) || !identity || identity.objectRef !== objectRef || !Array.isArray(components)
    || !Array.isArray(identity.canonicalIdentityTuple) || identity.canonicalIdentityTuple.length === 0
    || JSON.stringify(requirement.exactTupleFields) !== JSON.stringify(identity.canonicalIdentityTuple)
    || !plainRecord(candidateTuple) || !plainRecord(expectedTuple)) return { verdict: "UNKNOWN", reason: "CANONICAL_IDENTITY_CONTRACT_UNRESOLVED" };

  const fields = identity.canonicalIdentityTuple;
  const componentByField = new Map(components.map((component) => [component.field, component]));
  if (fields.some((field) => !componentByField.has(field))
    || Object.keys(candidateTuple).length !== fields.length || Object.keys(expectedTuple).length !== fields.length
    || Object.keys(candidateTuple).some((field) => !fields.includes(field))
    || Object.keys(expectedTuple).some((field) => !fields.includes(field))) return { verdict: "UNKNOWN", reason: "INCOMPLETE_OR_OPEN_TUPLE" };

  for (const field of fields) {
    const component = componentByField.get(field);
    const candidateValue = candidateTuple[field];
    const expectedValue = expectedTuple[field];
    if (typeof candidateValue !== "string" || candidateValue.length === 0 || typeof expectedValue !== "string" || expectedValue.length === 0
      || candidateValue === "latest" || candidateValue === "current" || expectedValue === "latest" || expectedValue === "current") {
      return { verdict: "UNKNOWN", reason: "MISSING_OR_ALIAS_IDENTITY_COMPONENT" };
    }
    if (component.origin === "TRUSTED_HOST_CONTEXT" && (field !== "tenantId" || typeof trustedTenantId !== "string" || trustedTenantId.length === 0
      || expectedValue !== trustedTenantId || candidateValue !== trustedTenantId)) {
      return { verdict: "UNKNOWN", reason: "FOREIGN_OR_UNBOUND_TRUSTED_SCOPE" };
    }
    if (candidateValue !== expectedValue) return { verdict: "UNKNOWN", reason: "STALE_FOREIGN_OR_MIXED_VERSION_TUPLE" };
  }
  return { verdict: "TRUE", reason: "EXACT_OWNER_SELECTED_VERSION_TUPLE_MATCH" };
}

/**
 * Validate the definition-level source-version join for a caption pair. The
 * caption-version identities must come from an exact owner resolver keyed by
 * each requested version ID. Comparison prose or a bare comparison result is
 * not identity evidence; no runtime resolver is implied here.
 */
export function evaluatePdp3CaptionPairSourceVersionJoin({ versionFieldBinding, leftCaptionVersionId, rightCaptionVersionId,
  leftIdentityTuple, rightIdentityTuple, expectedArtifactVersionTuple, trustedTenantId, resolveDefinitionRef }) {
  if (!plainRecord(versionFieldBinding) || versionFieldBinding.objectRef !== "media.domain.artifact-version"
    || versionFieldBinding.coverageDisposition !== "ARTIFACT_VERSION_IS_TRANSITIVE_THROUGH_EXACT_CAPTION_VERSION_IDENTITY; COMPARISON_RESULT_HAS_NO_DIRECT_TYPED_SOURCE_VERSION_FIELD; DO_NOT_INFER_SOURCE_VERSION"
    || typeof leftCaptionVersionId !== "string" || leftCaptionVersionId.length === 0
    || typeof rightCaptionVersionId !== "string" || rightCaptionVersionId.length === 0
    || !plainRecord(expectedArtifactVersionTuple) || typeof resolveDefinitionRef !== "function") return { verdict: "UNKNOWN", reason: "TRANSITIVE_VERSION_BINDING_NOT_EXACT" };
  const requirement = versionFieldBinding.canonicalVersionIdentityRequirement;
  const identityRef = requirement?.identityContractRef;
  const identity = identityRef && resolveDefinitionRef(identityRef);
  if (identity?.objectRef !== "media.domain.artifact-version" || JSON.stringify(requirement.exactTupleFields) !== JSON.stringify(identity.canonicalIdentityTuple)
    || !plainRecord(leftIdentityTuple) || !plainRecord(rightIdentityTuple)) return { verdict: "UNKNOWN", reason: "ARTIFACT_VERSION_IDENTITY_CONTRACT_UNRESOLVED" };
  const captionIdentity = resolveDefinitionRef(".product-experience/pdp-1-domain-data/domain-objects.yaml#ownerTypedIdentityContracts/records/@id=media.identity-contract.caption-version");
  if (captionIdentity?.objectRef !== "media.domain.caption-version" || !Array.isArray(captionIdentity.canonicalIdentityTuple)) {
    return { verdict: "UNKNOWN", reason: "CAPTION_VERSION_IDENTITY_CONTRACT_UNRESOLVED" };
  }
  const expectedArtifactFields = identity.canonicalIdentityTuple;
  if (Object.keys(expectedArtifactVersionTuple).length !== expectedArtifactFields.length
    || expectedArtifactFields.some((field) => typeof expectedArtifactVersionTuple[field] !== "string" || expectedArtifactVersionTuple[field].length === 0)
    || expectedArtifactVersionTuple.tenantId !== trustedTenantId || expectedArtifactVersionTuple.versionId === "latest") {
    return { verdict: "UNKNOWN", reason: "EXPECTED_ARTIFACT_VERSION_TUPLE_NOT_TRUSTED_OR_EXACT" };
  }
  for (const [requestedId, tuple] of [[leftCaptionVersionId, leftIdentityTuple], [rightCaptionVersionId, rightIdentityTuple]]) {
    const fields = captionIdentity.canonicalIdentityTuple;
    if (Object.keys(tuple).length !== fields.length || fields.some((field) => typeof tuple[field] !== "string" || tuple[field].length === 0)
      || tuple.captionVersionId !== requestedId || tuple.tenantId !== trustedTenantId) return { verdict: "UNKNOWN", reason: "CAPTION_VERSION_REF_OR_TENANT_MISMATCH" };
    if (tuple.sourceArtifactId !== expectedArtifactVersionTuple.artifactId
      || tuple.sourceArtifactVersionId !== expectedArtifactVersionTuple.versionId) return { verdict: "UNKNOWN", reason: "CAPTION_PAIR_SOURCE_VERSION_MISMATCH" };
  }
  return { verdict: "TRUE", reason: "BOTH_EXACT_CAPTION_VERSIONS_JOIN_TO_REQUESTED_ARTIFACT_VERSION" };
}

/** Definition-only resolver for the consent-reference version join. */
export function evaluatePdp3ConsentRevisionVersionJoin({ request, result, trusted, resolvedRevision, now, maxAgeMs = 300000 }) {
  const unknown = (reason) => ({ verdict: "UNKNOWN", reason });
  const exactKeys = (value, keys) => plainRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
  const consentRequiredKeys = ["kind", "consentId", "consentRef", "consentRevisionRef", "tenantScopeRef", "principalRef", "purposes", "allowedRegions",
    "externalProcessingAllowed", "biometricProcessingAllowed", "status", "authorityRef", "evidenceRef", "grantedAt", "version"];
  const consentOptionalKeys = ["expiresAt", "revokedAt"];
  if (!exactKeys(request, ["queryId", "consentId", "purposeRef"]) || !exactKeys(trusted,
    ["tenantId", "tenantScopeRef", "principalRef", "expectedRequestFingerprint", "expectedOperationRef", "expectedReadAuthorityRef", "expectedReadVersion"])
    || !exactKeys(result, ["queryId", "requestFingerprint", "operationRef", "readAuthorityRef", "currentness", "readVersion", "observedAt", "outcome"])) return unknown("CLOSED_REQUEST_OR_RESULT_REQUIRED");
  if ([request.queryId, request.consentId, request.purposeRef, trusted.tenantId, trusted.tenantScopeRef, trusted.principalRef,
    trusted.expectedRequestFingerprint, trusted.expectedOperationRef, trusted.expectedReadAuthorityRef, trusted.expectedReadVersion]
    .some((value) => typeof value !== "string" || value.length === 0)) return unknown("REQUEST_OR_TRUSTED_CONTEXT_INVALID");
  if (typeof now !== "string" || !Number.isFinite(Date.parse(now)) || new Date(now).toISOString() !== now
    || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 0) return unknown("TRUSTED_CLOCK_INVALID");
  if (result.queryId !== request.queryId || result.requestFingerprint !== trusted.expectedRequestFingerprint
    || result.operationRef !== trusted.expectedOperationRef || result.readAuthorityRef !== trusted.expectedReadAuthorityRef
    || result.readVersion !== trusted.expectedReadVersion || result.currentness !== "CURRENT") return unknown("QUERY_OR_CURRENT_READ_TUPLE_MISMATCH");
  if (typeof result.observedAt !== "string" || !Number.isFinite(Date.parse(result.observedAt)) || new Date(result.observedAt).toISOString() !== result.observedAt) {
    return unknown("OBSERVATION_TIME_INVALID");
  }
  const nowMs = Date.parse(now);
  const observedMs = Date.parse(result.observedAt);
  if (observedMs > nowMs || nowMs - observedMs > maxAgeMs) return unknown("OBSERVATION_STALE_OR_FUTURE");
  const outcome = result.outcome;
  if (!plainRecord(outcome) || consentRequiredKeys.some((key) => !Object.hasOwn(outcome, key))
    || Object.keys(outcome).some((key) => !consentRequiredKeys.includes(key) && !consentOptionalKeys.includes(key))
    || typeof outcome.consentRef !== "string" || outcome.consentRef.length === 0
    || typeof outcome.consentRevisionRef !== "string" || outcome.consentRevisionRef.length === 0
    || typeof outcome.authorityRef !== "string" || outcome.authorityRef.length === 0
    || typeof outcome.evidenceRef !== "string" || outcome.evidenceRef.length === 0
    || outcome.kind !== "OBSERVED_CONSENT_REVISION" || outcome.consentId !== request.consentId
    || outcome.tenantScopeRef !== trusted.tenantScopeRef || outcome.principalRef !== trusted.principalRef
    || !Array.isArray(outcome.purposes) || !outcome.purposes.includes(request.purposeRef) || outcome.status !== "ACTIVE"
    || !Number.isSafeInteger(outcome.version) || outcome.version < 1
    || typeof outcome.grantedAt !== "string" || !Number.isFinite(Date.parse(outcome.grantedAt))
    || new Date(outcome.grantedAt).toISOString() !== outcome.grantedAt || Date.parse(outcome.grantedAt) > nowMs
    || (Object.hasOwn(outcome, "revokedAt") && outcome.revokedAt !== null)
    || (Object.hasOwn(outcome, "expiresAt") && outcome.expiresAt !== null
      && (typeof outcome.expiresAt !== "string" || !Number.isFinite(Date.parse(outcome.expiresAt))
        || new Date(outcome.expiresAt).toISOString() !== outcome.expiresAt || Date.parse(outcome.expiresAt) <= nowMs))) {
    return unknown("CONSENT_SCOPE_OR_VALIDITY_MISMATCH");
  }
  if (!exactKeys(resolvedRevision, ["reference", "consentRef", "version", "identityTuple", "readAuthorityRef", "readVersion", "currentness", "requestFingerprint"])
    || resolvedRevision.reference !== outcome.consentRevisionRef || resolvedRevision.consentRef !== outcome.consentRef
    || resolvedRevision.version !== outcome.version || resolvedRevision.readAuthorityRef !== trusted.expectedReadAuthorityRef
    || resolvedRevision.readVersion !== trusted.expectedReadVersion || resolvedRevision.currentness !== "CURRENT"
    || resolvedRevision.requestFingerprint !== trusted.expectedRequestFingerprint
    || !exactKeys(resolvedRevision.identityTuple, ["tenantId", "consentId", "consentRevisionId"])
    || resolvedRevision.identityTuple.tenantId !== trusted.tenantId || resolvedRevision.identityTuple.consentId !== request.consentId
    || resolvedRevision.identityTuple.consentRevisionId !== outcome.consentRevisionRef) return unknown("CANONICAL_CONSENT_REVISION_IDENTITY_JOIN_MISMATCH");
  return { verdict: "TRUE", reason: "CURRENT_EXACT_CONSENT_REVISION_IDENTITY_JOIN" };
}

/**
 * Make the generic public JourneyStep binding from the exact step oracle and,
 * where present, the PDP-1 operation owner join. This only projects source
 * definitions; it does not evaluate guards or imply admission.
 */
export function projectPdp3JourneyStepSemantics({ sourceRef, oracleStep, ownerBinding, sourceBindingRef, versionBinding, actionIds, operationKindsByRef, effectRefsByAction, finalityByAction, recoveryRefsByAction, failureRecoverySourceRefsByAction, validObjectRefs, resolveDefinitionRef, onReject }) {
  const reject = (reason) => { if (typeof onReject === "function") onReject(reason); return undefined; };
  const oracle = oracleStep?.canonicalBindings;
  if (!oracle || oracleStep.sourceRef !== sourceRef || !operationKindsByRef || !(actionIds instanceof Set)
    || !versionBinding || versionBinding.stepRef !== sourceRef || versionBinding.runtimeAdmission !== "NOT_ADMITTED"
    || versionBinding.acceptanceEffect !== "none" || !(validObjectRefs instanceof Set) || typeof resolveDefinitionRef !== "function") return reject("STEP_OR_VERSION_SOURCE_SHAPE");

  const expectedVersionBindingRef = `.product-experience/pdp-3-product-experience/step-version-binding-contracts.yaml#records/@id=${versionBinding.id}`;
  const resolvedVersionBinding = typeof versionBinding.id === "string" ? resolveDefinitionRef(expectedVersionBindingRef) : undefined;
  if (typeof versionBinding.id !== "string" || !versionBinding.id.startsWith("media.step-version-binding.")
    || normalizeStepSemanticId(versionBinding.stepSemanticDefinitionId) !== normalizeStepSemanticId(oracleStep.id)
    || versionBinding.journeyRef !== oracleStep.journeyId
    || !resolvedVersionBinding || resolvedVersionBinding.id !== versionBinding.id || resolvedVersionBinding.stepRef !== sourceRef) return reject("VERSION_BINDING_REF_OR_IDENTITY");

  const resolvedSourceBinding = typeof sourceBindingRef === "string" ? resolveDefinitionRef(sourceBindingRef) : undefined;
  const sourceBindingStepRef = ownerBinding?.journeyStepRef?.replace("#steps/", "#/steps/") ?? ownerBinding?.stepRef;
  if (!ownerBinding || !resolvedSourceBinding || resolvedSourceBinding.id !== ownerBinding.id
    || sourceBindingStepRef !== sourceRef) return reject("STEP_OWNER_BINDING_REF_OR_IDENTITY");

  const actionRef = ownerBinding?.actionRef ?? oracle.actionRef;
  const actionRefs = typeof actionRef === "string" && actionIds.has(actionRef) ? [actionRef] : [];
  const optionRecords = Array.isArray(oracle.capabilityOptions) ? oracle.capabilityOptions : [];
  const primaryRefs = ownerBinding
    ? ownerBinding.operationRefs ?? (ownerBinding.operationRef ? [ownerBinding.operationRef] : [])
    : (oracle.operationRefs ?? []);
  const supportingRefs = ownerBinding?.supportingObservationOperationRefs ?? ownerBinding?.supportingOperationRefs
    ?? oracle.supportingObservationOperationRefs ?? [];
  const capabilityRefs = optionRecords.flatMap((option) => option.operationRefs ?? []);
  // An explicit capability menu binds to the selected leaf operation. The
  // generic request dispatcher is an implementation surface, not a second
  // user-selectable effect branch.
  const operationRefs = unique(optionRecords.length ? capabilityRefs : primaryRefs);
  const supportingOperationRefs = unique(supportingRefs).filter((ref) => !operationRefs.includes(ref));
  const operationKinds = operationRefs.map((ref) => operationKindsByRef.get(ref));
  const supportingOperationKinds = supportingOperationRefs.map((ref) => operationKindsByRef.get(ref));
  if (operationKinds.some((kind) => kind !== "COMMAND" && kind !== "QUERY") || supportingOperationKinds.some((kind) => kind !== "QUERY")) return reject("OPERATION_KIND_UNRESOLVED_OR_INVALID");

  const bindingKind = ownerBinding?.bindingKind ?? oracle.bindingKind;
  const isChoice = bindingKind === "EXPLICIT_USER_CHOICE_AMONG_EXACT_OPERATIONS" || optionRecords.length > 1;
  const allQuery = operationKinds.length > 0 && operationKinds.every((kind) => kind === "QUERY");
  const bindingDisposition = isChoice ? "ACTION_CHOICE"
    : primaryRefs.length > 1 && primaryRefs.every((ref) => operationKindsByRef.get(ref) === "COMMAND") ? "ORDERED_WORKFLOW"
      : actionRefs.length === 0 && allQuery ? "PASSIVE_QUERY"
      : String(bindingKind).startsWith("EXTERNAL_SHARED_IDENTITY_HANDOFF") ? (actionRefs.length ? "SINGLE_ACTION" : "UNRESOLVED")
          : bindingKind === "EXPLICIT_NO_DOMAIN_DISPATCH" ? (actionRefs.length ? "LOCAL_ONLY" : "NO_DISPATCH")
            : actionRefs.length === 0 && operationRefs.length === 0 ? (bindingKind === "UNRESOLVED" ? "UNRESOLVED" : "NO_DISPATCH")
          : actionRefs.length === 0 && operationRefs.length > 0 ? "UNRESOLVED"
            : "SINGLE_ACTION";

  const choiceAlternatives = isChoice ? optionRecords.map((option) => ({
    actionRefs,
    operationRefs: unique(option.operationRefs ?? []),
  })).filter((alternative) => alternative.operationRefs.length > 0) : undefined;
  if (isChoice && (!choiceAlternatives || choiceAlternatives.length < 2)) return reject("CHOICE_ALTERNATIVES_INCOMPLETE");

  const ownerObjects = ownerBinding?.domainObjectRefs;
  const ownerStates = ownerBinding?.stateRefs;
  const ownerAuthorities = ownerBinding?.authorityRefs;
  const ownerRequirements = ownerBinding?.requirementRefs;
  const objectRefs = unique(ownerObjects ?? oracle.ownerDomainObjectRefs ?? oracle.domainObjectRefs ?? []);
  const resolveStateRef = (ref) => resolvePdp1StateReference(ref, resolveDefinitionRef);
  const stateRefs = unique((ownerStates ?? oracle.ownerStateRefs ?? oracle.stateRefs ?? []).map(resolveStateRef));
  const authorityRefs = unique(ownerAuthorities ?? oracle.ownerAuthorityRefs ?? oracle.authorityRefs ?? []);
  const requirementRefs = unique(ownerRequirements ?? oracle.ownerRequirementRefs ?? oracle.requirementRefs ?? []);
  if (objectRefs.some((ref) => !validObjectRefs.has(ref))) return reject("DOMAIN_OBJECT_REFERENCE_UNRESOLVED");
  if (stateRefs.some((ref) => !resolveDefinitionRef(ref))) return reject(`STATE_REFERENCE_UNRESOLVED:${stateRefs.find((ref) => !resolveDefinitionRef(ref))}`);
  if (authorityRefs.some((ref) => !resolveDefinitionRef(ref))) return reject(`AUTHORITY_REFERENCE_UNRESOLVED:${authorityRefs.find((ref) => !resolveDefinitionRef(ref))}`);
  if (requirementRefs.some((ref) => !resolveDefinitionRef(ref))) return reject("REQUIREMENT_REFERENCE_UNRESOLVED");
  if (!Array.isArray(versionBinding.versionFieldBindings)) return reject("VERSION_FIELD_BINDINGS_NOT_ARRAY");
  const versionBindingRefs = [];
  const versionBindingIds = new Set();
  for (const versionFieldBinding of versionBinding.versionFieldBindings) {
    if (!versionFieldBinding || typeof versionFieldBinding.id !== "string" || versionBindingIds.has(versionFieldBinding.id)
      || !objectRefs.includes(versionFieldBinding.objectRef) || !Array.isArray(versionFieldBinding.fields)
      || !versionFieldBinding.canonicalVersionIdentityRequirement?.identityContractRef
      || !versionFieldBinding.canonicalVersionIdentityRequirement?.identityComponentsRef) return reject("VERSION_FIELD_IDENTITY_CONTRACT_SHAPE");
    if (!resolveDefinitionRef(versionFieldBinding.canonicalVersionIdentityRequirement.identityContractRef)) {
      return reject(`VERSION_IDENTITY_CONTRACT_UNRESOLVED:${versionFieldBinding.canonicalVersionIdentityRequirement.identityContractRef}`);
    }
    if (!resolveDefinitionRef(versionFieldBinding.canonicalVersionIdentityRequirement.identityComponentsRef)) {
      return reject(`VERSION_IDENTITY_COMPONENTS_UNRESOLVED:${versionFieldBinding.canonicalVersionIdentityRequirement.identityComponentsRef}`);
    }
    const fieldBoundCoverage = [
      "EXACT_VERSION_REQUEST_OR_RESULT_FIELD_BOUND",
      "EXACT_VERSION_REQUEST_FIELD_BOUND",
      "EXACT_TYPED_CONSENT_REVISION_OBSERVATION; LOGICAL_DEFINITION_ONLY; TRANSPORT_NOT_ADMITTED",
    ].includes(versionFieldBinding.coverageDisposition);
    const transitiveCoverage = versionFieldBinding.coverageDisposition === "ARTIFACT_VERSION_IS_TRANSITIVE_THROUGH_EXACT_CAPTION_VERSION_IDENTITY; COMPARISON_RESULT_HAS_NO_DIRECT_TYPED_SOURCE_VERSION_FIELD; DO_NOT_INFER_SOURCE_VERSION"
      && versionFieldBinding.fields.length === 0 && Array.isArray(versionFieldBinding.transitiveVersionJoins)
      && versionFieldBinding.transitiveVersionJoins.length > 0
      && versionFieldBinding.transitiveVersionJoins.every((join) => typeof join.id === "string"
        && Boolean(resolveDefinitionRef(join.operationContractRef))
        && Boolean(resolveDefinitionRef(join.selectorBranchRef))
        && (join.resultFieldSelectors ?? []).every((ref) => Boolean(resolveDefinitionRef(ref)))
        && Boolean(resolveDefinitionRef(join.captionVersionIdentityRef)));
    const deferredApplicability = versionFieldBinding.fields.length === 0
      && versionFieldBinding.applicabilityContract?.disposition === "NOT_YET_ISSUED_AT_THIS_STEP"
      && versionFieldBinding.applicabilityContract?.runtimeAdmission === "NOT_ADMITTED"
      && typeof versionFieldBinding.applicabilityContract?.sourceOperationRef === "string"
      && typeof versionFieldBinding.applicabilityContract?.exactDeferredOperationRef === "string"
      && Boolean(resolveDefinitionRef(versionFieldBinding.applicabilityContract.sourceContractRef))
      && Boolean(resolveDefinitionRef(versionFieldBinding.applicabilityContract.exactDeferredResultRef));
    const logicalObservationContract = resolveDefinitionRef(versionFieldBinding.logicalVersionJoin?.candidateObservationContractRef);
    const logicalTupleCoverage = versionFieldBinding.fields.length === 0
      && Array.isArray(versionFieldBinding.exactVersionTupleRequirement)
      && versionFieldBinding.exactVersionTupleRequirement.length > 0
      && Array.isArray(versionFieldBinding.logicalVersionJoin?.canonicalTuple)
      && versionFieldBinding.logicalVersionJoin.canonicalTuple.length > 0
      && versionFieldBinding.logicalVersionJoin.canonicalTuple.includes("tenantId")
      && Array.isArray(versionFieldBinding.canonicalVersionIdentityRequirement?.exactTupleFields)
      && versionFieldBinding.logicalVersionJoin.canonicalTuple.every((field) => versionFieldBinding.canonicalVersionIdentityRequirement.exactTupleFields.includes(field))
      && versionFieldBinding.exactVersionTupleRequirement.includes(versionFieldBinding.logicalVersionJoin.consentRevisionField)
      && logicalObservationContract?.id === "media.observation-contract.consent-revision-current-read.v1"
      && logicalObservationContract.operationRef?.endsWith(`/@id=${versionFieldBinding.logicalVersionJoin.candidateObservationOperationRef}`)
      && typeof versionFieldBinding.logicalVersionJoin.candidateObservationOperationRef === "string"
      && typeof versionFieldBinding.logicalVersionJoin.missingOrMismatchedTuple === "string"
      && versionFieldBinding.logicalVersionJoin.missingOrMismatchedTuple.includes("UNKNOWN")
      && versionFieldBinding.logicalVersionJoin.runtimeAdmission === "NOT_ADMITTED";
    if ((!fieldBoundCoverage && !transitiveCoverage && !deferredApplicability && !logicalTupleCoverage)
      || (fieldBoundCoverage && versionFieldBinding.fields.length === 0)) return reject("VERSION_FIELD_COVERAGE_UNSUPPORTED");
    if (versionFieldBinding.fields.some((field) => typeof field.fieldSelector === "string" && !resolveDefinitionRef(field.fieldSelector))) return reject("VERSION_FIELD_SELECTOR_UNRESOLVED");
    versionBindingIds.add(versionFieldBinding.id);
    const exactRef = `${expectedVersionBindingRef}/versionFieldBindings/@id=${versionFieldBinding.id}`;
    const resolvedField = resolveDefinitionRef(exactRef);
    if (!resolvedField || resolvedField.id !== versionFieldBinding.id || resolvedField.objectRef !== versionFieldBinding.objectRef) return reject("VERSION_FIELD_REFERENCE_MISMATCH");
    versionBindingRefs.push(exactRef);
  }
  if (versionBindingRefs.length === 0 && !["NO_CANONICAL_OBJECT_VERSION_TUPLE_IN_STEP_SOURCE", "LOCAL_DRAFT_REVISION_CAS; NOT_CANONICAL_PRODUCT_VERSION",
    "EXPLICIT_NO_CANONICAL_VERSION_APPLICABILITY", "NOT_APPLICABLE_BEFORE_OWNER_ISSUED_ARTIFACT_VERSION", "NO_ARTIFACT_VERSION_EXISTS_AT_BEGIN_UPLOAD",
    "EXACT_STABLE_OBJECT_TUPLE; NO_VERSION_COMPONENT_IN_IDENTITY_SOURCE"].includes(versionBinding.versionDisposition)) return reject("VERSION_DISPOSITION_UNRESOLVED");
  const guardRefs = unique(oracle.guardRefs ?? []);
  const sourceRefs = unique([sourceRef, sourceBindingRef, ...(oracle.sourceRefs ?? [])]);
  const actionEffectRefs = actionRefs.flatMap((ref) => effectRefsByAction.get(ref) ?? []);
  const finalityRefs = actionRefs.flatMap((ref) => finalityByAction.get(ref) ?? []);
  const actionRecoveryRefs = actionRefs.flatMap((ref) => recoveryRefsByAction?.get(ref) ?? []);
  // Public recoveryRefs are identities in the recovery-contract catalog. The
  // action's exact failureRecovery clause is source evidence, so retain its
  // locator in sourceRefs rather than misrepresenting a YAML pointer as a
  // public recovery-contract ID.
  const actionFailureRecoverySourceRefs = actionRefs.flatMap((ref) => failureRecoverySourceRefsByAction?.get(ref) ?? []);
  const authoredSessionRecoveryRef = typeof oracleStep.sessionRecoveryDefinitionSourceRef === "string"
    ? oracleStep.sessionRecoveryDefinitionSourceRef
    : undefined;
  const authoredStepRecoveryRef = !authoredSessionRecoveryRef && sourceRef
    ? `${sourceRef}/recovery`
    : undefined;
  const authoredRecoveryRef = authoredSessionRecoveryRef ?? authoredStepRecoveryRef;
  const recoveryRefs = unique(actionRecoveryRefs);
  const recoverySourceRefs = unique([
    ...actionFailureRecoverySourceRefs,
    ...(authoredRecoveryRef && resolveDefinitionRef(authoredRecoveryRef) ? [authoredRecoveryRef] : []),
  ]);

  return {
    bindingDisposition,
    actorRefs: unique(oracle.actorRefs ?? []),
    sourceRefs: unique([...sourceRefs, ...recoverySourceRefs]),
    actionRefs,
    operationRefs,
    operationKinds,
    ...(supportingOperationRefs.length ? { supportingOperationRefs, supportingOperationKinds } : {}),
    objectRefs,
    objectVersionRefs: versionBindingRefs,
    stateRefs,
    guardRefs,
    authorityRefs,
    requirementRefs,
    effectRefs: unique(actionEffectRefs),
    finalityRefs: unique(finalityRefs),
    recoveryRefs: unique(recoveryRefs),
    ...(choiceAlternatives ? { choiceAlternatives } : {}),
  };
}
