/**
 * Pure PDP-1 transition definition oracle. It evaluates only the explicit typed
 * Media guard contracts. It has no runtime mutation, effect, or admission path.
 */
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { validateTypedConsentRevisionCurrentRead, validateTypedObservationCurrentRead } from "./pdp-truth-domain-observation-currentness.mjs";

const yaml = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"))("yaml");
const operationSource = yaml.parse(readFileSync(resolve(process.cwd(), ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const RIGHTS_DECISION_CONTRACT = operationSource.ownerTypedObservationContracts?.records?.find((record) => record.id === "media.observation-contract.rights-decision.v1");
const CONSENT_REVISION_CONTRACT = operationSource.ownerConsentRevisionObservationContract;
const RIGHTS_DECISION_CONTRACT_REF = ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.rights-decision.v1";
const RIGHTS_READ_AUTHORITY_REF = ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation";
const CONSENT_READ_AUTHORITY_REF = ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope";

function recordsOf(transitions) {
  return [...(transitions.transitionRecords ?? []), ...(transitions.ownerDefinedTransitionRecords ?? [])];
}

function definitionsFor(states, machineId, dimension) {
  const machine = states.stateMachines?.find((entry) => entry.machineId === machineId);
  if (!machine) return [];
  if (machine.stateDefinitionsByDimension) return machine.stateDefinitionsByDimension[dimension] ?? [];
  return machine.stateDefinitions ?? [];
}

const canonicalUtc = (value) => typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && Number.isFinite(Date.parse(value)) && new Date(Date.parse(value)).toISOString() === value;
const exactKeys = (value, expected) => value !== null && typeof value === "object" && !Array.isArray(value)
  && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort());

function evaluateConsentPerEffectCurrent(facts) {
  const trusted = facts.trustedConsentContext;
  const read = facts.typedOwnerFacts?.consentPerEffectCurrent;
  if (!trusted || !Array.isArray(read?.effectReads) || !RIGHTS_DECISION_CONTRACT || !CONSENT_REVISION_CONTRACT || read.effectReads.length === 0) {
    return { value: "UNKNOWN", failures: ["CONSENT_TYPED_CURRENT_READ_MISSING"] };
  }
  const nowMs = Date.parse(trusted.now);
  if (typeof trusted.tenantScopeRef !== "string" || !trusted.tenantScopeRef || typeof trusted.principalRef !== "string" || !trusted.principalRef ||
      typeof trusted.subjectArtifactVersionRef !== "string" || !trusted.subjectArtifactVersionRef || typeof trusted.purposeRef !== "string" || !trusted.purposeRef ||
      typeof trusted.regionRef !== "string" || !trusted.regionRef || typeof trusted.retentionPolicyRef !== "string" || !trusted.retentionPolicyRef ||
      !Array.isArray(trusted.expectedEffects) || trusted.expectedEffects.length === 0 || !canonicalUtc(trusted.now) ||
      !Number.isSafeInteger(trusted.maxAgeMs) || trusted.maxAgeMs < 0 || trusted.expectedRightsAuthorityRef !== RIGHTS_READ_AUTHORITY_REF ||
      typeof trusted.expectedRightsReadVersion !== "string" || !trusted.expectedRightsReadVersion ||
      trusted.expectedConsentReadAuthorityRef !== CONSENT_READ_AUTHORITY_REF || typeof trusted.expectedConsentReadVersion !== "string" ||
      !trusted.expectedConsentReadVersion || !trusted.expectedEffects.every((row) => row && typeof row.effectRef === "string" && row.effectRef &&
        typeof row.consentId === "string" && row.consentId && typeof row.consentRef === "string" && row.consentRef &&
        typeof row.consentRevisionRef === "string" && row.consentRevisionRef &&
        Number.isSafeInteger(row.consentRevisionVersion) && row.consentRevisionVersion > 0 &&
        typeof row.decisionAuthorityVersionRef === "string" && row.decisionAuthorityVersionRef &&
        ["REQUIRED", "NOT_REQUIRED"].includes(row.externalProcessingRequirement) &&
        ["REQUIRED", "NOT_REQUIRED"].includes(row.biometricProcessingRequirement)) ||
      new Set(trusted.expectedEffects.map((row) => row.effectRef)).size !== trusted.expectedEffects.length ||
      read.effectReads.length !== trusted.expectedEffects.length) {
    return { value: "UNKNOWN", failures: ["CONSENT_TYPED_CURRENT_READ_SCOPE_AUTHORITY_VERSION_OR_FRESHNESS_MISMATCH"] };
  }
  const wanted = new Map(trusted.expectedEffects.map((row) => [row.effectRef, row]));
  const seen = new Set();
  let denied = false;
  for (const entry of read.effectReads) {
    const request = entry?.rightsRequest;
    const result = entry?.rightsResult;
    const consentRequest = entry?.consentRequest;
    const consentResult = entry?.consentResult;
    const effectRef = request?.useRef;
    const expected = wanted.get(effectRef);
    if (!expected || seen.has(effectRef) || !request || !result || !consentRequest || !consentResult) {
      return { value: "UNKNOWN", failures: ["CONSENT_EFFECT_REVISION_OR_VALIDITY_BINDING_MISMATCH"] };
    }
    const expectedRightsRequest = { subjectArtifactVersionRef: trusted.subjectArtifactVersionRef, decisionKind: "CONSENT",
      purposeRef: trusted.purposeRef, useRef: expected.effectRef, regionRef: trusted.regionRef, retentionPolicyRef: trusted.retentionPolicyRef };
    const rightsTrusted = { tenantScopeRef: trusted.tenantScopeRef, principalRef: trusted.principalRef,
      expectedOperationRef: "media.operation.action.inspect-consent-and-permitted-use",
      expectedReadAuthorityRef: trusted.expectedRightsAuthorityRef, expectedReadVersion: trusted.expectedRightsReadVersion };
    const rightsCurrent = validateTypedObservationCurrentRead({ contract: RIGHTS_DECISION_CONTRACT, request, result,
      trusted: rightsTrusted, now: trusted.now, maxAgeMs: trusted.maxAgeMs });
    const decision = result.decision;
    const dispositionMapping = RIGHTS_DECISION_CONTRACT.decisionKindStateMapping?.find((row) =>
      row.decisionKind === "CONSENT" && row.observationStatus === result.observationStatus);
    const allowedPair = result.observationStatus === "ALLOWED_FOR_DECLARED_SCOPE" && result.decisionKind === "CONSENT"
      && decision?.effectDisposition === "PERMITTED";
    if (rightsCurrent.truth !== "TRUE" || Object.entries(expectedRightsRequest).some(([key, value]) => request[key] !== value) ||
        result.decisionKind !== "CONSENT" || (!allowedPair && (!dispositionMapping || decision?.effectDisposition !== dispositionMapping.effectDisposition))) {
      return { value: "UNKNOWN", failures: ["CONSENT_RIGHTS_QUERY_OR_EFFECT_BINDING_MISMATCH"] };
    }
    if (!allowedPair) {
      seen.add(effectRef);
      denied = true;
      continue;
    }
    if (!decision || decision.tenantScopeRef !== trusted.tenantScopeRef || decision.principalRef !== trusted.principalRef ||
        Object.entries(expectedRightsRequest).some(([key, value]) => decision[key] !== value) ||
        decision.authorityVersionRef !== expected.decisionAuthorityVersionRef || !Array.isArray(decision.evidenceRefs) ||
        !decision.evidenceRefs.includes(expected.consentRevisionRef) || !canonicalUtc(decision.validFrom) || !canonicalUtc(decision.validUntil) ||
        Date.parse(decision.validFrom) >= Date.parse(decision.validUntil)) {
      return { value: "UNKNOWN", failures: ["CONSENT_RIGHTS_DECISION_TUPLE_OR_EVIDENCE_MISMATCH"] };
    }
    const consent = consentResult.outcome;
    const consentCurrent = validateTypedConsentRevisionCurrentRead({ contract: CONSENT_REVISION_CONTRACT, request: consentRequest,
      result: consentResult, trusted: { tenantScopeRef: trusted.tenantScopeRef, principalRef: trusted.principalRef,
        expectedOperationRef: CONSENT_REVISION_CONTRACT.operationRef, expectedReadAuthorityRef: trusted.expectedConsentReadAuthorityRef,
        expectedReadVersion: trusted.expectedConsentReadVersion }, now: trusted.now, maxAgeMs: trusted.maxAgeMs });
    if (!exactKeys(consentRequest, ["queryId", "consentId", "purposeRef"]) ||
        consentCurrent.truth !== "TRUE" || consentRequest.consentId !== expected.consentId || consentRequest.purposeRef !== trusted.purposeRef ||
        consent?.kind !== "OBSERVED_CONSENT_REVISION" || consent.consentId !== expected.consentId ||
        consent.consentRef !== expected.consentRef || consent.consentRevisionRef !== expected.consentRevisionRef || consent.version !== expected.consentRevisionVersion ||
        consent.tenantScopeRef !== trusted.tenantScopeRef || consent.principalRef !== trusted.principalRef || consent.status !== "ACTIVE" ||
        !Array.isArray(consent.purposes) || !consent.purposes.includes(trusted.purposeRef) ||
        !Array.isArray(consent.allowedRegions) || !consent.allowedRegions.includes(trusted.regionRef)) {
      return { value: "UNKNOWN", failures: ["CONSENT_REVISION_READ_IDENTITY_AUTHORITY_OR_CURRENTNESS_MISMATCH"] };
    }
    const grantedAt = Date.parse(consent.grantedAt);
    if (!canonicalUtc(consent.grantedAt) || !Number.isFinite(grantedAt) || grantedAt > nowMs ||
        (consent.expiresAt !== null && (!canonicalUtc(consent.expiresAt) || !Number.isFinite(Date.parse(consent.expiresAt))))) {
      return { value: "UNKNOWN", failures: ["CONSENT_REVISION_GRANT_INTERVAL_INVALID_OR_FUTURE"] };
    }
    if (consent.revokedAt !== null && (!canonicalUtc(consent.revokedAt) || !Number.isFinite(Date.parse(consent.revokedAt)))) {
      return { value: "UNKNOWN", failures: ["CONSENT_REVISION_REVOCATION_TIME_INVALID"] };
    }
    if (consent.revokedAt !== null || (consent.expiresAt !== null && Date.parse(consent.expiresAt) <= nowMs) ||
        (expected.externalProcessingRequirement === "REQUIRED" && consent.externalProcessingAllowed !== true) ||
        (expected.biometricProcessingRequirement === "REQUIRED" && consent.biometricProcessingAllowed !== true)) denied = true;
    seen.add(effectRef);
    if (Date.parse(decision.validFrom) > nowMs || Date.parse(decision.validUntil) <= nowMs) denied = true;
  }
  return denied ? { value: "FALSE", failures: ["CONSENT_NOT_CURRENT_PERMITTED_FOR_EVERY_EFFECT"] } : { value: "TRUE", failures: [] };
}

function evaluateExpression(expression, facts, contracts) {
  if (!expression || typeof expression !== "object" || Array.isArray(expression)) {
    return { value: "UNKNOWN", failures: ["GUARD_EXPRESSION_INVALID"] };
  }
  const keys = Object.keys(expression);
  if (keys.length !== 1) return { value: "UNKNOWN", failures: ["GUARD_EXPRESSION_INVALID"] };
  const [operator] = keys;
  const operand = expression[operator];
  if (operator === "fact") {
    if (typeof operand !== "string") return { value: "UNKNOWN", failures: ["GUARD_FACT_ID_INVALID"] };
    if (operand === "tenant.matches") {
      const tenantFact = contracts.commonFacts?.[operand];
      if (tenantFact?.inputKind !== "DEFINITION_MODEL_INPUT") {
        return { value: "UNKNOWN", failures: ["GUARD_FACT_INPUT_KIND_INVALID:tenant.matches"] };
      }
      if (!Object.hasOwn(facts.modelInputs ?? {}, operand)) {
        return { value: "UNKNOWN", failures: ["GUARD_MODEL_INPUT_MISSING:tenant.matches"] };
      }
      if (typeof facts.modelInputs[operand] !== "boolean") {
        return { value: "UNKNOWN", failures: ["GUARD_FACT_INVALID_TYPE:tenant.matches"] };
      }
      return facts.modelInputs[operand]
        ? { value: "TRUE", failures: [] }
        : { value: "FALSE", failures: ["MODEL_INPUT_NOT_ESTABLISHED:tenant.matches"] };
    }
    if (!Object.hasOwn(contracts.facts ?? {}, operand)) {
      return { value: "UNKNOWN", failures: [`UNKNOWN_GUARD_FACT:${operand}`] };
    }
    const factContract = contracts.facts[operand];
    if (!factContract || !["DEFINITION_MODEL_INPUT", "TYPED_OWNER_OBSERVATION"].includes(factContract.inputKind)) {
      return { value: "UNKNOWN", failures: [`GUARD_FACT_INPUT_KIND_INVALID:${operand}`] };
    }
    if (operand === "expectedVersionMatches" || operand === "expectedVersionConflicts") {
      if (factContract.inputKind !== "DEFINITION_MODEL_INPUT") {
        return { value: "UNKNOWN", failures: [`GUARD_FACT_INPUT_KIND_INVALID:${operand}`] };
      }
      const expected = facts.version?.expected;
      const current = facts.version?.current;
      if (typeof expected !== "string" || expected.trim().length === 0 || typeof current !== "string" || current.trim().length === 0) {
        return { value: "UNKNOWN", failures: ["VERSION_PRECONDITION_MISSING_OR_INVALID"] };
      }
      const matches = expected === current;
      const passed = operand === "expectedVersionMatches" ? matches : !matches;
      return passed
        ? { value: "TRUE", failures: [] }
        : { value: "FALSE", failures: [operand === "expectedVersionMatches" ? "VERSION_PRECONDITION_STALE" : "VERSION_CONFLICT_NOT_PRESENT"] };
    }
    if (operand === "consentPerEffectCurrent") {
      const definition = contracts.facts[operand]?.typedEvaluation;
      const expectedContracts = [
        ".product-experience/pdp-1-domain-data/operations.yaml#ownerTypedObservationContracts/records/@id=media.observation-contract.rights-decision.v1",
        ".product-experience/pdp-1-domain-data/operations.yaml#ownerConsentRevisionObservationContract",
      ];
      const expectedAuthorities = [RIGHTS_READ_AUTHORITY_REF, CONSENT_READ_AUTHORITY_REF];
      if (factContract.inputKind !== "TYPED_OWNER_OBSERVATION" || definition?.inputPath !== "facts.typedOwnerFacts.consentPerEffectCurrent" ||
          definition?.legacyBooleanInputDisposition !== "IGNORED; typed observation required" || definition?.runtimeAdmission !== "NOT_ADMITTED" ||
          JSON.stringify(definition.sourceContractRefs) !== JSON.stringify(expectedContracts) ||
          JSON.stringify(definition.authorityRefs) !== JSON.stringify(expectedAuthorities)) {
        return { value: "UNKNOWN", failures: ["TYPED_GUARD_FACT_CONTRACT_INVALID"] };
      }
      return evaluateConsentPerEffectCurrent(facts);
    }
    if (factContract.inputKind === "TYPED_OWNER_OBSERVATION") {
      return { value: "UNKNOWN", failures: [`TYPED_GUARD_FACT_EVALUATOR_MISSING:${operand}`] };
    }
    if (factContract.inputKind !== "DEFINITION_MODEL_INPUT") {
      return { value: "UNKNOWN", failures: [`GUARD_FACT_INPUT_KIND_INVALID:${operand}`] };
    }
    if (!Object.hasOwn(facts.modelInputs ?? {}, operand)) return { value: "UNKNOWN", failures: [`GUARD_MODEL_INPUT_MISSING:${operand}`] };
    const value = facts.modelInputs[operand];
    if (typeof value !== "boolean") return { value: "UNKNOWN", failures: [`GUARD_FACT_INVALID_TYPE:${operand}`] };
    return value
      ? { value: "TRUE", failures: [] }
      : { value: "FALSE", failures: [`GUARD_FACT_NOT_ESTABLISHED:${operand}`] };
  }
  if (operator === "all" || operator === "any") {
    if (!Array.isArray(operand) || operand.length === 0) return { value: "UNKNOWN", failures: ["GUARD_EXPRESSION_INVALID"] };
    const results = operand.map((child) => evaluateExpression(child, facts, contracts));
    const failures = results.flatMap((result) => result.failures);
    // Unknown is never hidden by a passing sibling; malformed/unknown contract
    // content invalidates the whole expression tree.
    if (results.some((result) => result.value === "UNKNOWN")) return { value: "UNKNOWN", failures };
    const passed = operator === "all" ? results.every((result) => result.value === "TRUE") : results.some((result) => result.value === "TRUE");
    if (passed) return { value: "TRUE", failures: [] };
    return { value: "FALSE", failures: operator === "all" ? failures : ["ANY_GUARD_ALTERNATIVE_UNSATISFIED", ...failures] };
  }
  if (operator === "not") {
    const result = evaluateExpression(operand, facts, contracts);
    if (result.value === "UNKNOWN") return result;
    return result.value === "TRUE"
      ? { value: "FALSE", failures: ["NEGATED_GUARD_FACT_ESTABLISHED"] }
      : { value: "TRUE", failures: [] };
  }
  return { value: "UNKNOWN", failures: [`UNKNOWN_GUARD_OPERATOR:${operator}`] };
}

/** List concrete predicate IDs used by an exact edge contract. */
export function transitionGuardFactRequirements(contract) {
  const ids = new Set();
  const visit = (node) => {
    if (!node || typeof node !== "object") return;
    if (node.fact) ids.add(node.fact);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(visit);
      else if (value && typeof value === "object") visit(value);
    }
  };
  for (const edge of contract?.edgeRules ?? []) visit(edge.when);
  return [...ids];
}

/** Return an explanation-only result for one explicitly defined transition edge. */
export function evaluatePdpTransition({ transitions, states, guardContracts, transitionId, from, to, facts = {} }) {
  const record = recordsOf(transitions).find(({ id }) => id === transitionId);
  if (!record) return { allowed: false, reasonCodes: ["UNKNOWN_TRANSITION_ID"] };
  const contract = guardContracts?.records?.find(({ transitionId: id }) => id === transitionId);
  if (!contract) return { allowed: false, reasonCodes: ["GUARD_CONTRACT_MISSING"], transitionId };
  if (contract.sourceMachineId !== record.sourceMachineId || contract.stateDimension !== (record.stateDimension ?? null)) {
    return { allowed: false, reasonCodes: ["GUARD_CONTRACT_MACHINE_MISMATCH"], transitionId };
  }
  const sourceGuard = record.ownerGuardDefinition ?? record.sourceGuard;
  if (contract.sourceGuard !== sourceGuard) return { allowed: false, reasonCodes: ["GUARD_CONTRACT_SOURCE_STALE"], transitionId };
  const edge = contract.edgeRules?.find((candidate) => candidate.from === from && candidate.to === to);
  if (!edge) return { allowed: false, reasonCodes: ["EDGE_NOT_EXPLICITLY_DEFINED"], transitionId, from, to };
  if (!record.from.includes(from) || !record.to.includes(to)) {
    return { allowed: false, reasonCodes: ["EDGE_NOT_DECLARED"], transitionId, from, to };
  }
  const stateIds = new Set(definitionsFor(states, record.sourceMachineId, record.stateDimension ?? null).map(({ id }) => id));
  if (!stateIds.has(from) || !stateIds.has(to)) {
    return { allowed: false, reasonCodes: ["STATE_OUTSIDE_MACHINE_DIMENSION"], transitionId, from, to };
  }
  const seenGroups = new Set();
  for (const group of guardContracts.exclusiveFactGroups ?? []) {
    if (!group || typeof group.id !== "string" || seenGroups.has(group.id) || !Array.isArray(group.factIds) || group.factIds.length < 2
        || group.factIds.some((id) => !Object.hasOwn(guardContracts.facts ?? {}, id))) {
      return { allowed: false, reasonCodes: ["EXCLUSIVE_FACT_GROUP_INVALID"], transitionId, from, to };
    }
    seenGroups.add(group.id);
    if (group.rule !== "at-most-one-positive-outcome-fact") {
      return { allowed: false, reasonCodes: ["EXCLUSIVE_FACT_GROUP_RULE_UNKNOWN"], transitionId, from, to };
    }
    const positive = group.factIds.filter((id) => facts.modelInputs?.[id] === true);
    if (positive.length > 1) {
      return { allowed: false, reasonCodes: [`CONTRADICTORY_OUTCOME_FACTS:${group.id}`], transitionId, from, to };
    }
  }
  const result = evaluateExpression(edge.when, facts, guardContracts);
  return { allowed: result.value === "TRUE", reasonCodes: result.failures, transitionId, from, to, sourceGuard };
}
