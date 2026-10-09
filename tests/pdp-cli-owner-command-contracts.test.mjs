import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const cli = read(".product-experience/pdp-2-design-interface-system/cli-language.yaml");
const capabilities = read(".product-experience/pdp-0-product-truth/capabilities.yaml");
const leafReview = read(".product-experience/pdp-0-product-truth/capability-leaf-review.yaml");
const operations = read(".product-experience/pdp-1-domain-data/operations.yaml");
const actionRegistry = read(".product-experience/pdp-3-product-experience/action-registry.yaml");

function resolveExact(ref) {
  if (typeof ref !== "string") return undefined;
  const split = ref.indexOf("#");
  if (split < 0) return undefined;
  const file = ref.slice(0, split);
  const pointer = ref.slice(split + 1);
  const sources = {
    ".product-experience/pdp-0-product-truth/capabilities.yaml": capabilities,
    ".product-experience/pdp-0-product-truth/capability-leaf-review.yaml": leafReview,
    ".product-experience/pdp-1-domain-data/operations.yaml": operations,
    ".product-experience/pdp-3-product-experience/action-registry.yaml": actionRegistry,
  };
  let value = sources[file];
  if (!value || !pointer) return undefined;
  for (const part of pointer.split("/")) {
    const selector = /^@(id|capabilityRef)=([^/]+)$/u.exec(part);
    value = selector
      ? (Array.isArray(value) ? value.find((row) => row?.[selector[1]] === selector[2]) : undefined)
      : value?.[part];
    if (value === undefined) return undefined;
  }
  return value;
}

function resolveLocalSchemaRef(rootSchema, ref) {
  if (typeof ref !== "string" || !ref.startsWith("#/")) return undefined;
  return ref.slice(2).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"))
    .reduce((value, part) => value?.[part], rootSchema);
}

function closedObjectSchema(schema, resourceRoot = schema, options = {}) {
  const rootSchema = resourceRoot;
  const seen = new Set();
  const visit = (node, path) => {
    if (!node || typeof node !== "object" || seen.has(node)) return true;
    seen.add(node);
    if (node.$ref) {
      const resolved = resolveLocalSchemaRef(rootSchema, node.$ref);
      if (!resolved) return false;
      const siblings = Object.fromEntries(Object.entries(node).filter(([key]) => key !== "$ref"));
      return visit(resolved, path) && visit(siblings, path);
    }
    if (node.type === "object" && node.additionalProperties !== false) {
      const dynamicParameters = options.dynamicParameters === true
        && ((path === "#/requestSchema/properties/parameters"
          && node.additionalProperties === undefined
          && /mandatory dynamic parameter resolver/u.test(node.description ?? ""))
          || (path === "#/requestSchema/properties/directRequestFields"
            && node.additionalProperties === true
            && /exact target request schema/u.test(node.description ?? "")
            && /reject all other keys/u.test(node.description ?? "")));
      if (!dynamicParameters) return false;
    }
    for (const [name, child] of Object.entries(node.properties ?? {})) if (!visit(child, `${path}/properties/${name}`)) return false;
    for (const [name, child] of Object.entries(node.patternProperties ?? {})) if (!visit(child, `${path}/patternProperties/${name}`)) return false;
    if (node.additionalProperties && node.additionalProperties !== false && !visit(node.additionalProperties, `${path}/additionalProperties`)) return false;
    if (node.items && !visit(node.items, `${path}/items`)) return false;
    for (const [index, child] of (node.prefixItems ?? []).entries()) if (!visit(child, `${path}/prefixItems/${index}`)) return false;
    for (const keyword of ["oneOf", "anyOf", "allOf"]) {
      if (node[keyword] !== undefined && (!Array.isArray(node[keyword]) || node[keyword].length === 0 || !node[keyword].every((child, index) => visit(child, `${path}/${keyword}/${index}`)))) return false;
    }
    return true;
  };
  return Boolean(schema && (schema.type === "object" || ["oneOf", "anyOf", "allOf", "$ref"].some((key) => schema[key] !== undefined)) && visit(schema, "#/requestSchema"));
}

function hasBoundDynamicParameters(operation, ownerWireSchema) {
  const rule = operation?.parameterBindingRule;
  const parameters = ownerWireSchema?.requestSchema?.properties?.parameters;
  return Boolean(operation?.id === "media.operation.job.submit.v1"
    && rule?.id === "media.job-submit.operation-parameters.v1"
    && rule.definitionValidator?.module === "scripts/lib/pdp-job-submit-parameter-contract.mjs"
    && rule.definitionValidator?.export === "validateJobSubmitParameterContract"
    && rule.selection?.includes("request.capabilityRef")
    && rule.selection?.includes("request.targetOperationRef")
    && rule.schemaResolution?.includes("exact matching canonical source operation")
    && rule.validation?.includes("Unknown properties")
    && rule.validation?.includes("before")
    && rule.fingerprint?.includes("targetOperationVersion")
    && rule.fingerprint?.includes("source closure SHA-256")
    && parameters?.type === "object"
    && parameters.additionalProperties === undefined
    && /mandatory dynamic parameter resolver/u.test(parameters.description ?? ""));
}

function exactActionTriple(record) {
  if (!record.canonicalActionRef) return false;
  const action = resolveExact(`${".product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id="}${record.canonicalActionRef}`);
  const leaf = resolveExact(record.ownerLeafAdjudicationRef);
  const sourceOperations = (record.canonicalSourceContractRefs ?? []).map(resolveExact);
  const operationRefs = action?.actionDefinitionSemantics?.exactOperationRefs
    ?? (action?.actionDefinitionSemantics?.operationRef ? [action.actionDefinitionSemantics.operationRef] : []);
  return action?.capabilityRefs?.includes(record.capabilityRef) === true
    && operationRefs.length > 0
    && operationRefs.some((operationRef) => leaf?.operationRefs?.includes(operationRef) === true
      && sourceOperations.some((operation) => operation?.id === operationRef || operation?.operationRef === operationRef));
}

function validateContract(record) {
  const capability = resolveExact(record.capabilitySourceRef);
  const leaf = resolveExact(record.ownerLeafAdjudicationRef);
  const operation = resolveExact(record.operationContractRef);
  const ownerLogicalOperation = record.definitionKind === "OWNER_DEFINED_LOGICAL_OPERATION";
  const requestSchema = record.requestSchemaRef ? resolveExact(record.requestSchemaRef) : undefined;
  const resultSchema = record.resultSchemaRef ? resolveExact(record.resultSchemaRef) : undefined;
  const sourceContracts = (record.canonicalSourceContractRefs ?? []).map(resolveExact);
  const ownerWireSchemaRef = operation.canonicalWireSchemaRefs?.length === 1
    ? operation.canonicalWireSchemaRefs[0]
    : operation.ownerWireSchema ? `${record.operationContractRef}/ownerWireSchema`
      : (record.canonicalSourceContractRefs ?? []).find((ref) => resolveExact(ref)?.ownerWireSchema)
        ? `${(record.canonicalSourceContractRefs ?? []).find((ref) => resolveExact(ref)?.ownerWireSchema)}/ownerWireSchema` : undefined;
  const ownerWireSchema = ownerWireSchemaRef ? resolveExact(ownerWireSchemaRef) : undefined;
  const dynamicParameters = hasBoundDynamicParameters(operation, ownerWireSchema)
    || sourceContracts.some((source) => hasBoundDynamicParameters(source, source.ownerWireSchema));
  const action = record.canonicalActionRef === null ? undefined : resolveExact(`${".product-experience/pdp-3-product-experience/action-registry.yaml#actions/@id="}${record.canonicalActionRef}`);
  const semanticRefs = record.commandSpecificSemanticRefs ?? {};
  const semanticTargets = Object.fromEntries(Object.entries(semanticRefs).map(([key, ref]) => [key, ref === "NOT_APPLICABLE_READ_ONLY" ? ref : resolveExact(ref)]));
  const semanticSourcePrefixes = [record.operationContractRef, ...(record.canonicalSourceContractRefs ?? [])].map((ref) => `${ref}/`);
  const argumentContract = record.argumentContract;
  const hasExactActionTriple = exactActionTriple(record);
  return Boolean(
    record.id?.startsWith("media.cli.command.")
    && Array.isArray(record.argvPrefix) && record.argvPrefix.length >= 2
    && new Set(record.argvPrefix).size === record.argvPrefix.length
    && (ownerLogicalOperation
      ? record.capabilityRef === null && record.capabilitySourceRef === null && record.ownerLeafAdjudicationRef === null
      : capability?.id === record.capabilityRef && leaf?.capabilityRef === record.capabilityRef)
    && operation?.id
    && Number.isInteger(record.operationVersion) && record.operationVersion === (operation.operationVersion ?? operation.contractVersion)
    && (ownerLogicalOperation || leaf.operationContractRef === record.operationContractRef)
    && (record.typedSchemaBindingStatus === "EXACT_OPERATION_TYPED_REQUEST_AND_RESULT_SCHEMAS"
      ? record.requestSchemaRef === `${record.operationContractRef}/requestSchema` && record.resultSchemaRef === `${record.operationContractRef}/resultSchema`
        && closedObjectSchema(requestSchema, requestSchema, { dynamicParameters })
        && closedObjectSchema(resultSchema, resultSchema)
      : record.typedSchemaBindingStatus === "EXACT_CANONICAL_OWNER_WIRE_REQUEST_AND_RESULT_SCHEMAS"
        ? Boolean(ownerWireSchemaRef)
          && record.requestSchemaRef === `${ownerWireSchemaRef}/requestSchema`
          && record.resultSchemaRef === `${ownerWireSchemaRef}/resultSchema`
          && closedObjectSchema(requestSchema, requestSchema, { dynamicParameters })
          && closedObjectSchema(resultSchema, resultSchema)
        : record.typedSchemaBindingStatus === "EXACT_OWNER_DEFINED_TYPED_REQUEST_AND_RESULT_SCHEMAS"
          ? ownerLogicalOperation
            && record.requestSchemaRef === `${record.operationContractRef}/requestSchema`
            && record.resultSchemaRef === `${record.operationContractRef}/resultSchema`
            && closedObjectSchema(requestSchema, requestSchema)
            && closedObjectSchema(resultSchema, resultSchema)
        : false)
    && JSON.stringify(record.canonicalSourceContractRefs ?? []) === JSON.stringify(operation.canonicalSourceContractRefs ?? [])
    && (record.canonicalActionRef === null
      ? record.actionBindingStatus === "MACHINE_ONLY_NO_EXACT_UI_ACTION"
        && record.actionApplicability === "MACHINE_ONLY_NO_EXACT_UI_ACTION"
        && typeof record.actionBindingBasis === "string" && /machine-only CLI intent/u.test(record.actionBindingBasis)
      : action?.id === record.canonicalActionRef
        && record.actionBindingStatus === "EXACT_ACTION_CANDIDATE_REQUIRES_CROSS_CHANNEL_REVIEW"
        && hasExactActionTriple)
    && record.admissionState === "NOT_ADMITTED"
    && record.runtimeState === "NOT_EVALUATED"
    && argumentContract?.encoding === "ONE_CLOSED_JSON_REQUEST_OBJECT"
    && argumentContract.option === "--request-json"
    && argumentContract.schemaRef === record.requestSchemaRef
    && argumentContract.positionalData === "FORBIDDEN"
    && argumentContract.additionalProperties === "REJECT"
    && argumentContract.validationOrder === "BEFORE_AUTHORIZED_EFFECT_OR_DISPATCH"
    && semanticRefs.authority === `${record.operationContractRef}/${ownerLogicalOperation ? "authority" : "canonicalAuthorityRefs"}`
    && (ownerLogicalOperation ? Object.keys(semanticTargets.authority ?? {}).length > 0 : semanticTargets.authority?.length > 0)
    && typeof semanticRefs.errors === "string" && semanticTargets.errors !== undefined
    && semanticSourcePrefixes.some((prefix) => semanticRefs.errors.startsWith(prefix))
    && typeof semanticRefs.finality === "string" && semanticTargets.finality !== undefined
    && semanticSourcePrefixes.some((prefix) => semanticRefs.finality.startsWith(prefix))
    && typeof semanticRefs.idempotency === "string"
    && (["NOT_APPLICABLE_READ_ONLY", "NOT_APPLICABLE_READ_ONLY_QUERY"].includes(semanticRefs.idempotency)
      ? operation.operationKind === "QUERY"
      : semanticTargets.idempotency !== undefined && semanticSourcePrefixes.some((prefix) => semanticRefs.idempotency.startsWith(prefix)))
    && typeof semanticRefs.recovery === "string" && semanticTargets.recovery !== undefined
    && semanticSourcePrefixes.some((prefix) => semanticRefs.recovery.startsWith(prefix))
    && semanticRefs.waitDisposition === `${record.operationContractRef}/${ownerLogicalOperation ? "wait" : "asyncSubmissionDisposition"}`
    && semanticTargets.waitDisposition !== undefined
    && typeof record.argumentSemantics === "string" && /requestSchemaRef/u.test(record.argumentSemantics)
    && typeof record.resultSemantics === "string" && /UNKNOWN_OUTCOME/u.test(record.resultSemantics)
    && typeof record.idempotencySemantics === "string" && /owner operation/u.test(record.idempotencySemantics)
    && typeof record.hostContextSemantics === "string" && /Host supplies authenticated tenant/u.test(record.hostContextSemantics)
    && (!ownerLogicalOperation || (
      record.hostContextAssembly?.sourceAuthorityRef === `${record.operationContractRef}/authority`
      && Array.isArray(record.hostContextAssembly.callerForbiddenFields)
      && ["tenantId", "principalId", "authorityRef", "authorizationDecision", "consentDecision"].every((field) => record.hostContextAssembly.callerForbiddenFields.includes(field))
      && Array.isArray(record.hostContextAssembly.userSelectableFields)
      && JSON.stringify([...record.hostContextAssembly.userSelectableFields].sort()) === JSON.stringify(Object.keys(requestSchema?.properties ?? {}).sort())
      && record.hostContextAssembly.callerBodySchemaRef === record.requestSchemaRef
      && record.hostContextAssembly.canonicalRequestAssembly === "HOST_CONTEXT_SEPARATE_FROM_CALLER_BODY"
      && typeof record.hostContextAssembly.resolutionRule === "string"
      && /resolve.*under.*authenticated/iu.test(record.hostContextAssembly.resolutionRule)
      && /not.*authority/u.test(record.hostContextAssembly.selectionIsNotAuthority)
      && !["tenantId", "principalId", "authorityRef", "authorizationDecision", "consentDecision"].some((field) => Object.hasOwn(requestSchema?.properties ?? {}, field))
    ))
  );
}

test("finite owner CLI commands resolve exact capability, operation, and schema contracts", () => {
  const source = cli.ownerDefinedCanonicalCommandContracts;
  assert.equal(source.id, "media.cli.owner-defined-canonical-command-contracts.v1");
  assert.equal(source.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(source.acceptanceEffect, "none");
  const contractIds = source.contracts.map((row) => row.id);
  const historicalCommandIds = source.explicitlyUnboundHistoricalCommands.map((row) => row.commandId);
  assert.equal(source.contracts.length, 47, "all current canonical CLI commands have exact owner definitions");
  assert.equal(source.requiredCommandIds.length, 47, "the complete Media command requirement inventory is explicit");
  assert.equal(new Set(source.requiredCommandIds).size, 47);
  assert.deepEqual([...contractIds].sort(), [...source.requiredCommandIds].sort(), "every required command has a current owner definition");
  assert.equal(new Set(contractIds).size, 47, "no command requirement is silently omitted or duplicated");
  assert.equal(new Set(historicalCommandIds).size, 5, "historical dependency observations remain separately preserved");
  assert.equal(new Set(source.contracts.map((row) => row.id)).size, source.contracts.length);
  assert.equal(new Set(source.contracts.map((row) => row.argvPrefix.join(" "))).size, source.contracts.length);
  const invalidContracts = source.contracts.filter((row) => !validateContract(row)).map((row) => row.id);
  assert.deepEqual(invalidContracts, [], "each command must resolve its own exact closed request/result and owner semantics");
  const rule = cli.normativeRuleRecords.find((row) => row.id === "media.p2.rule.cli-owner-canonical-command-contracts.v1");
  assert.equal(rule?.ruleRef, ".product-experience/pdp-2-design-interface-system/cli-language.yaml#ownerDefinedCanonicalCommandContracts");
});

test("CLI host context keeps authority separate while preserving request-schema selections", () => {
  const boundary = cli.ownerDefinedCanonicalCommandContracts.hostContextBoundary;
  assert.equal(boundary.id, "media.cli.host-context-separation.v1");
  assert.deepEqual(boundary.trustedHostOnlyFields, ["tenantId", "principalId", "authorityRef", "authenticatedPrincipal", "authorizationDecision", "consentDecision", "operationIdentity", "finality"]);
  assert.deepEqual(boundary.callerForbiddenOverrides, boundary.trustedHostOnlyFields);
  assert.equal(boundary.selectionIsNotAuthority, true);
  assert.match(boundary.resolutionRule, /authenticated tenant and principal/u);
  assert.match(boundary.jsonRequestBoundary, /reject trusted-host-only fields/u);
  for (const field of ["tenantId", "principalId", "authorityRef", "authorizationDecision", "consentDecision"]) {
    const mutated = structuredClone(boundary);
    mutated.callerForbiddenOverrides = mutated.callerForbiddenOverrides.filter((item) => item !== field);
    assert.notDeepEqual(mutated.callerForbiddenOverrides, mutated.trustedHostOnlyFields, `${field} remains host-only`);
  }
  assert.equal(cli.ownerDefinedCanonicalCommandContracts.schemaRule.includes("User-selected purpose"), true);
});

test("CLI command contracts fail closed on guessed operations, untyped flags, and false action bindings", () => {
  const original = cli.ownerDefinedCanonicalCommandContracts.contracts[0];
  const wrongOperation = structuredClone(original);
  wrongOperation.operationContractRef = cli.ownerDefinedCanonicalCommandContracts.contracts[1].operationContractRef;
  wrongOperation.requestSchemaRef = `${wrongOperation.operationContractRef}/requestSchema`;
  wrongOperation.resultSchemaRef = `${wrongOperation.operationContractRef}/resultSchema`;
  assert.equal(validateContract(wrongOperation), false, "a valid but unrelated operation cannot replace the exact leaf binding");

  const guessedSchema = structuredClone(original);
  guessedSchema.requestSchemaRef = `${guessedSchema.operationContractRef}/parameters`;
  assert.equal(validateContract(guessedSchema), false, "CLI arguments cannot use a guessed schema path");

  const falseAction = structuredClone(original);
  falseAction.canonicalActionRef = "media.action.not-registered";
  falseAction.actionBindingStatus = "EXACT_ACTION_CANDIDATE_REQUIRES_CROSS_CHANNEL_REVIEW";
  assert.equal(validateContract(falseAction), false, "an invented action ID cannot satisfy the P3 action binding");

  const admitted = structuredClone(original);
  admitted.admissionState = "ADMITTED";
  assert.equal(validateContract(admitted), false, "source command definitions do not establish CLI admission");

  const alteredHost = structuredClone(original);
  alteredHost.hostContextSemantics = "Accept trusted tenant and principal from caller flags.";
  assert.equal(validateContract(alteredHost), false, "caller flags cannot assert trusted host identity");

  const missingErrorContract = structuredClone(original);
  delete missingErrorContract.commandSpecificSemanticRefs.errors;
  assert.equal(validateContract(missingErrorContract), false, "every command binds its exact owner error semantics");

  if (original.definitionKind === "OWNER_DEFINED_LOGICAL_OPERATION") {
    const callerAuthority = structuredClone(original);
    callerAuthority.hostContextAssembly.userSelectableFields.push("tenantId");
    assert.equal(validateContract(callerAuthority), false, "caller JSON cannot override host identity or authorization fields");

    const callerPurposeDropped = structuredClone(original);
    callerPurposeDropped.hostContextAssembly.userSelectableFields = callerPurposeDropped.hostContextAssembly.userSelectableFields.filter((field) => field !== "purposeRef");
    if (resolveExact(original.requestSchemaRef)?.properties?.purposeRef) {
      assert.equal(validateContract(callerPurposeDropped), false, "permitted purpose selection remains explicit in the caller schema projection");
    }

    const hostBodyMerged = structuredClone(original);
    hostBodyMerged.hostContextAssembly.canonicalRequestAssembly = "PASS_CALLER_BODY_AS_TRUSTED_HOST_CONTEXT";
    assert.equal(validateContract(hostBodyMerged), false, "the host reconstructs trusted context separately from JSON input");
  }

  const wrongFinality = structuredClone(original);
  wrongFinality.commandSpecificSemanticRefs.finality = cli.ownerDefinedCanonicalCommandContracts.contracts[1].commandSpecificSemanticRefs.finality;
  assert.equal(validateContract(wrongFinality), false, "finality cannot be borrowed from a neighboring command");

  const alteredArgumentEncoding = structuredClone(original);
  alteredArgumentEncoding.argumentContract.schemaRef = `${original.operationContractRef}/parameters`;
  assert.equal(validateContract(alteredArgumentEncoding), false, "CLI JSON arguments bind only to the exact closed request schema");
});

test("historical CLI dependency observations remain immutable while current owner operations are separately bound", () => {
  const rows = cli.ownerDefinedCanonicalCommandContracts.explicitlyUnboundHistoricalCommands;
  assert.deepEqual(rows.map((row) => row.command), [
    ["project", "export"], ["voice", "train"], ["voice", "convert"], ["audio", "master"], ["provider", "list|health|capabilities"],
  ]);
  for (const row of rows) {
    assert.ok(cli.ownerDefinedCanonicalCommandContracts.requiredCommandIds.includes(row.commandId));
    assert.match(row.claimId, /^MPSEM-03[23]/u);
    assert.ok(row.disposition.endsWith("REQUIRED") || row.disposition.endsWith("NOT_YET_DEFINED"));
    assert.ok(row.reason.length > 40);
    assert.ok(!Object.hasOwn(row, "operationContractRef"), "no nearby operation is silently substituted");
    const current = cli.ownerDefinedCanonicalCommandContracts.contracts.find((command) => command.id === row.commandId);
    assert.ok(current?.definitionKind === "OWNER_DEFINED_LOGICAL_OPERATION", "current canonical owner operation is separate from the historical unbound observation");
    assert.equal(row.currentDefinitionStatus.startsWith("CANONICAL_"), true, "historical gap wording does not remain the current definition disposition");
    assert.equal(row.currentOperationContractRef, current.operationContractRef, "current source binding is exact and separately recorded from the historical observation");
    assert.equal(current.operationContractRef.startsWith(".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id="), true);
  }
});

test("finite CLI command inventory rejects omissions and same-count substitutions", () => {
  const source = cli.ownerDefinedCanonicalCommandContracts;
  const omitted = source.contracts.slice(1).map((row) => row.id);
  assert.notDeepEqual([...omitted].sort(), [...source.requiredCommandIds].sort(), "dropping an authored command cannot pass on a count floor");

  const substituted = [...source.contracts.map((row) => row.id)];
  substituted[substituted.indexOf("media.cli.command.job-watch.v1")] = "media.cli.command.job-watch-foreign.v1";
  assert.notDeepEqual([...substituted].sort(), [...source.requiredCommandIds].sort(), "a foreign command ID cannot replace a required source identity");
});

test("CLI action candidates require an exact action, capability, and leaf-operation triple", () => {
  const source = cli.ownerDefinedCanonicalCommandContracts.contracts;
  const exactCandidates = source.filter((row) => row.canonicalActionRef).map((row) => row.id).sort();
  assert.deepEqual(exactCandidates, [
    "media.cli.command.artifact-upload.v1",
    "media.cli.command.job-cancel.v1",
    "media.cli.command.job-retry.v1",
    "media.cli.command.project-create.v1",
    "media.cli.command.project-get.v1",
    "media.cli.command.speech-transcribe.v1",
  ].sort());
  for (const row of source) {
    if (row.canonicalActionRef) assert.equal(exactActionTriple(row), true, row.id);
    else {
      assert.equal(row.actionBindingStatus, "MACHINE_ONLY_NO_EXACT_UI_ACTION", row.id);
      assert.equal(row.actionApplicability, "MACHINE_ONLY_NO_EXACT_UI_ACTION", row.id);
    }
  }
  const artifact = source.find((row) => row.id === "media.cli.command.artifact-provenance.v1");
  const borrowed = structuredClone(artifact);
  borrowed.canonicalActionRef = "media.action.inspect-provenance";
  assert.equal(exactActionTriple(borrowed), false, "read-only provenance inspection cannot bind a provenance-export effect");
  const watch = source.find((row) => row.id === "media.cli.command.job-watch.v1");
  const statusAction = structuredClone(watch);
  statusAction.canonicalActionRef = "media.action.view-job-status";
  assert.equal(exactActionTriple(statusAction), false, "watch and status remain separate leaf operation identities");
});

test("job-submit CLI accepts open parameters only through the exact closed target-schema resolver", () => {
  const row = cli.ownerDefinedCanonicalCommandContracts.contracts.find((item) => item.id === "media.cli.command.job-submit.v1");
  const owner = resolveExact(row.canonicalSourceContractRefs[0]);
  const wire = resolveExact(`${row.canonicalSourceContractRefs[0]}/ownerWireSchema`);
  assert.equal(hasBoundDynamicParameters(owner, wire), true);
  assert.equal(closedObjectSchema(wire.requestSchema, wire.requestSchema, { dynamicParameters: hasBoundDynamicParameters(owner, wire) }), true);

  const noFingerprint = structuredClone(owner);
  delete noFingerprint.parameterBindingRule.fingerprint;
  assert.equal(hasBoundDynamicParameters(noFingerprint, wire), false, "dynamic parameters require schema-bound request fingerprints");

  const noClosedResolver = structuredClone(owner);
  noClosedResolver.parameterBindingRule.schemaResolution = "Trust caller schema selector.";
  assert.equal(hasBoundDynamicParameters(noClosedResolver, wire), false, "caller-selected schemas cannot close open parameters");

  const descriptionOnly = structuredClone(wire);
  descriptionOnly.requestSchema.properties.parameters.description = "A free-form map of arbitrary values.";
  assert.equal(closedObjectSchema(descriptionOnly.requestSchema, descriptionOnly.requestSchema, { dynamicParameters: true }), false,
    "a descriptive note cannot substitute for the executable owner parameter validator");

  const arbitraryDirectFields = structuredClone(wire);
  arbitraryDirectFields.requestSchema.properties.directRequestFields.description = "A free-form map of arbitrary caller values.";
  assert.equal(closedObjectSchema(arbitraryDirectFields.requestSchema, arbitraryDirectFields.requestSchema, { dynamicParameters: true }), false,
    "direct fields require the exact selected operation adapter, not an arbitrary caller map");
});
