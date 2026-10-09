import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const require = createRequire(new URL("../../../ghatana-tools/package.json", import.meta.url));
const Ajv2020 = require("ajv/dist/2020").default ?? require("ajv/dist/2020");
const addFormats = require("ajv-formats");
const { parse } = require("yaml");
const componentTypes = parse(readFileSync(resolve(process.cwd(), ".product-experience/pdp-2-design-interface-system/component-value-types.yaml"), "utf8"));
const localContracts = parse(readFileSync(resolve(process.cwd(), ".product-experience/pdp-3-product-experience/local-step-effect-contracts.yaml"), "utf8"));
const schemaValidator = new Ajv2020({ allErrors: true, strict: false, validateFormats: true });
addFormats(schemaValidator);
schemaValidator.addSchema(componentTypes);
schemaValidator.addSchema(localContracts);

const isRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
  (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null) &&
  Reflect.ownKeys(value).every((key) => typeof key === "string" &&
    Object.getOwnPropertyDescriptor(value, key)?.enumerable &&
    Object.hasOwn(Object.getOwnPropertyDescriptor(value, key) ?? {}, "value"));

const exactKeys = (value, keys) => isRecord(value) && Reflect.ownKeys(value).length === keys.length &&
  keys.every((key) => Object.hasOwn(value, key));
const nonEmpty = (value) => typeof value === "string" && value.trim().length > 0;
const optionalRef = (value) => value === null || nonEmpty(value);
const safeRevision = (value) => Number.isSafeInteger(value) && value >= 0;
const nextRevisionSafe = (value) => Number.isSafeInteger(value) && value >= 0 && value < Number.MAX_SAFE_INTEGER;
const canonicalJson = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isRecord(value)) return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
};
const schemaValid = (schemaRef, value) => {
  try { return Boolean(schemaValidator.getSchema(schemaRef)?.(value)); } catch { return false; }
};

const hold = (reason) => ({
  disposition: "HOLD_UNKNOWN",
  localPatchApplied: false,
  remoteDispatch: "NONE",
  committedMediaEffect: false,
  finality: "NOT_ESTABLISHED",
  retryAuthorized: false,
  reason,
  runtimeAdmission: "NOT_ADMITTED",
});

function validateContract(contract) {
  if (!isRecord(contract) || contract.runtimeAdmission !== "NOT_ADMITTED" ||
      !nonEmpty(contract.id) || !nonEmpty(contract.sourceRef) || !nonEmpty(contract.actionRef) ||
      !Array.isArray(contract.actorRefs) || contract.actorRefs.length === 0 ||
      !["DRAFT_PATCH", "CATALOG_SELECTION", "SOURCE_VERSION_SELECTION"].includes(contract.effectMode) ||
      !nonEmpty(contract.localDraftSlotRef) || !Array.isArray(contract.canonicalDomainObjectRefs) ||
      contract.exactOperationRefs?.length !== 0 || contract.canonicalTransitionRef !== null ||
      !Array.isArray(contract.guards) || contract.guards.length === 0 ||
      !isRecord(contract.effect) || contract.effect.remoteDispatch !== "none" ||
      contract.effect.committedMediaObjects !== "unchanged" ||
      contract.finality !== "LOCAL_DRAFT_REVISION_ONLY; no project revision, artifact version, job, remote effect, or committed result is established" ||
      contract.trustedContextContract?.notCallerSupplied !== true) return false;
  if (!contract.localScopeRequirements || !nonEmpty(contract.localScopeRequirements.tenantId) ||
      !contract.localScopeRequirements.workspaceRef?.startsWith("required,") ||
      (contract.effectMode === "DRAFT_PATCH" && !contract.localScopeRequirements.projectRef?.startsWith("required and non-null")) ||
      (contract.effectMode !== "DRAFT_PATCH" && !contract.localScopeRequirements.projectRef?.includes("exact request-to-host-session and catalog-context match"))) return false;
  if (contract.effectMode === "DRAFT_PATCH") {
    return Array.isArray(contract.inputContract?.mutation?.valueSchemaRefs) &&
      contract.inputContract.mutation.valueSchemaRefs.length > 0 &&
      contract.inputContract.mutation.valueSchemaRefs.every((ref) => typeof ref === "string" && Boolean(schemaValidator.getSchema(ref)));
  }
  return typeof contract.trustedContextContract.candidateSchemaRef === "string" &&
    Boolean(schemaValidator.getSchema(contract.trustedContextContract.candidateSchemaRef)) &&
    contract.inputContract?.mutation?.candidateSchemaRef === contract.trustedContextContract.candidateSchemaRef;
}

/**
 * Classifies a local draft request against host-supplied editor-session state.
 * It never applies the patch, dispatches a domain operation, or treats a caller
 * assertion as proof of session/catalog currentness.
 */
export function evaluateLocalStepEffect(contract, request, trustedSession) {
  if (!validateContract(contract) || !exactKeys(request, [
    "sessionRef", "actorRef", "tenantId", "workspaceRef", "projectRef", "expectedDraftRevision",
    "actionRef", "draftSlotRef", "mutationId", "mutation",
  ])) return hold("CONTRACT_OR_REQUEST_NOT_CLOSED");
  if (!exactKeys(trustedSession, [
    "sessionRef", "actorRef", "tenantId", "workspaceRef", "projectRef", "draftRevision",
    "sessionCurrentness", "catalogContext",
  ])) return hold("TRUSTED_EDITOR_CONTEXT_NOT_CLOSED");
  if (![request.sessionRef, request.actorRef, request.tenantId, request.workspaceRef, request.mutationId,
    trustedSession.tenantId, trustedSession.workspaceRef].every(nonEmpty) ||
      !optionalRef(request.projectRef) || !optionalRef(trustedSession.projectRef) ||
      !safeRevision(request.expectedDraftRevision) ||
      !safeRevision(trustedSession.draftRevision) || !["CURRENT", "STALE", "UNKNOWN"].includes(trustedSession.sessionCurrentness)) {
    return hold("SESSION_OR_REQUEST_IDENTITY_INVALID");
  }
  if (request.sessionRef !== trustedSession.sessionRef || request.actorRef !== trustedSession.actorRef ||
      request.tenantId !== trustedSession.tenantId ||
      request.workspaceRef !== trustedSession.workspaceRef || request.projectRef !== trustedSession.projectRef) {
    return hold("HOST_SESSION_IDENTITY_MISMATCH");
  }
  if (!contract.actorRefs.includes(request.actorRef)) return {
    ...hold("ACTOR_NOT_ALLOWED_FOR_SOURCE_ACTION"), disposition: "DENIED_NO_LOCAL_PATCH",
  };
  if (request.actionRef !== contract.actionRef || request.draftSlotRef !== contract.localDraftSlotRef) {
    return hold("ACTION_OR_LOCAL_SLOT_DOES_NOT_MATCH_SOURCE_STEP");
  }
  if (trustedSession.sessionCurrentness === "STALE") return {
    ...hold("EDITOR_SESSION_STALE"), disposition: "DENIED_NO_LOCAL_PATCH",
  };
  if (trustedSession.sessionCurrentness !== "CURRENT") return hold("EDITOR_SESSION_CURRENTNESS_UNKNOWN");
  if (request.expectedDraftRevision !== trustedSession.draftRevision) return {
    ...hold("LOCAL_DRAFT_REVISION_COMPARE_AND_SET_FAILED"), disposition: "DENIED_NO_LOCAL_PATCH",
  };
  if (contract.effectMode === "DRAFT_PATCH" && (!nonEmpty(request.projectRef) || !nonEmpty(trustedSession.projectRef))) {
    return hold("DRAFT_PATCH_REQUIRES_EXACT_WORKSPACE_AND_PROJECT_SCOPE");
  }
  if (!nextRevisionSafe(request.expectedDraftRevision)) return hold("LOCAL_DRAFT_REVISION_CANNOT_ADVANCE_SAFELY");

  if (contract.effectMode === "DRAFT_PATCH") {
    if (!exactKeys(request.mutation, ["kind", "value"]) ||
        request.mutation.kind !== "PATCH_LOCAL_DRAFT_SLOT" ||
        !Array.isArray(contract.inputContract.mutation.valueSchemaRefs) ||
        contract.inputContract.mutation.valueSchemaRefs.filter((schemaRef) => schemaValid(schemaRef, request.mutation.value)).length !== 1) {
      return hold("DRAFT_PATCH_SHAPE_OR_SLOT_INVALID");
    }
  } else {
    if (!exactKeys(request.mutation, ["kind", "candidateValue", "catalogRef", "catalogRevision"]) ||
        request.mutation.kind !== "SELECT_CATALOG_ENTRY" || !nonEmpty(request.mutation.catalogRef) ||
        !safeRevision(request.mutation.catalogRevision)) {
      return hold("CATALOG_SELECTION_SHAPE_INVALID");
    }
    const catalog = trustedSession.catalogContext;
    if (!exactKeys(catalog, ["catalogRef", "catalogRevision", "catalogCurrentness", "candidateValues", "candidateSchemaRef", "authorityRef", "tenantId", "workspaceRef", "projectRef"]) ||
        !["CURRENT", "STALE", "UNKNOWN"].includes(catalog.catalogCurrentness) ||
        !safeRevision(catalog.catalogRevision) || !Array.isArray(catalog.candidateValues) ||
        catalog.candidateValues.length > 2048 ||
        !nonEmpty(contract.trustedContextContract.candidateSchemaRef) ||
        catalog.candidateSchemaRef !== contract.trustedContextContract.candidateSchemaRef ||
        catalog.tenantId !== trustedSession.tenantId || catalog.workspaceRef !== trustedSession.workspaceRef ||
        catalog.projectRef !== trustedSession.projectRef ||
        catalog.authorityRef !== contract.trustedContextContract.catalogContextRequired.authorityRef ||
        !catalog.candidateValues.every((candidate) => schemaValid(catalog.candidateSchemaRef, candidate)) ||
        (contract.effectMode === "SOURCE_VERSION_SELECTION" && !nonEmpty(catalog.authorityRef))) {
      return hold("HOST_CATALOG_CONTEXT_NOT_CLOSED");
    }
    if (catalog.catalogCurrentness === "STALE") return {
      ...hold("SELECTION_CATALOG_STALE"), disposition: "DENIED_NO_LOCAL_PATCH",
    };
    if (catalog.catalogCurrentness !== "CURRENT") return hold("SELECTION_CATALOG_CURRENTNESS_UNKNOWN");
    if (request.mutation.catalogRef !== catalog.catalogRef || request.mutation.catalogRevision !== catalog.catalogRevision ||
        !schemaValid(catalog.candidateSchemaRef, request.mutation.candidateValue)) {
      return hold("SELECTION_CATALOG_IDENTITY_OR_REVISION_MISMATCH");
    }
    const selected = catalog.candidateValues.find((candidate) => canonicalJson(candidate) === canonicalJson(request.mutation.candidateValue));
    if (!selected) return { ...hold("SELECTED_ENTRY_NOT_IN_CURRENT_HOST_CATALOG"), disposition: "DENIED_NO_LOCAL_PATCH" };
    if (selected.versionRef?.tenantId !== undefined && selected.versionRef.tenantId !== trustedSession.tenantId) return hold("SELECTED_VERSION_TENANT_MISMATCH");
    if (!isSelectableCandidate(catalog.candidateSchemaRef, selected)) return {
      ...hold("CURRENT_CATALOG_MEMBER_IS_NOT_ELIGIBLE_FOR_THIS_SELECTION"), disposition: "DENIED_NO_LOCAL_PATCH",
    };
  }

  return {
    disposition: "LOCAL_PATCH_ELIGIBLE_NOT_APPLIED",
    localPatchApplied: false,
    remoteDispatch: "NONE",
    committedMediaEffect: false,
    finality: contract.finality,
    retryAuthorized: false,
    contractId: contract.id,
    actionRef: contract.actionRef,
    localDraftSlotRef: contract.localDraftSlotRef,
    expectedDraftRevision: request.expectedDraftRevision,
    nextDraftRevision: request.expectedDraftRevision + 1,
    effect: contract.effect,
    failureRecovery: contract.failureRecovery,
    runtimeAdmission: "NOT_ADMITTED",
  };
}

function isSelectableCandidate(schemaRef, candidate) {
  if (schemaRef.endsWith("/ArtifactVersionCandidate")) {
    return candidate.access === "authorized" && candidate.rightsDisposition === "permitted-with-scope" && candidate.integrityDisposition === "verified";
  }
  if (schemaRef.endsWith("/SourceVersionCandidate")) {
    return candidate.access === "authorized" && candidate.rightsDisposition === "permitted-with-scope";
  }
  if (schemaRef.endsWith("/IntentOption")) return candidate.availability === "available";
  if (schemaRef.endsWith("/CapabilityProfileDisposition")) {
    return candidate.availability === "available" && candidate.qualification === "qualified";
  }
  return schemaRef.endsWith("/VersionedDeliveryProfileRef") && nonEmpty(candidate);
}
