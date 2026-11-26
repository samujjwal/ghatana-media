import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve, dirname } from "node:path";

const requireTools = createRequire(resolve("../ghatana-tools/package.json"));
const { parse } = requireTools("yaml");
const Ajv2020 = requireTools("ajv/dist/2020").default;
const addFormats = requireTools("ajv-formats").default;
const conventionsPath = ".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml";
const registryPath = ".product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml";
const j25Path = ".product-experience/pdp-3-product-experience/journey-contracts/return-bounded-results-to-integrating-products.yaml";
const operationsPath = ".product-experience/pdp-1-domain-data/operations.yaml";
const domainObjectsPath = ".product-experience/pdp-1-domain-data/domain-objects.yaml";
const root = process.cwd();
const readYaml = (path) => parse(readFileSync(path, "utf8"));
const decisionLog = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");
const conventions = () => readYaml(conventionsPath);
const registry = () => readYaml(registryPath);
let operationsCache;
const operations = () => operationsCache ??= readYaml(operationsPath);
const expected = new Map([
  ["av.speech-to-text", ["media.agent-tool-contract.speech-to-text.v1", "media.operation.transcription", "media.operation.transcription-submission", "operations/@id=media.operation.transcription-submission", "media.capability-bounds.media-speech-transcription-file", "capabilityOperationContracts/records/@id=media.capability-binding.media-speech-transcription-file"]],
  ["av.text-to-speech", ["media.agent-tool-contract.text-to-speech.v1", "media.operation.synthesis", "media.operation.capability.media-speech-synthesis-text-to-speech", "capabilityOperationContracts/records/@id=media.operation.capability.media-speech-synthesis-text-to-speech", "media.capability-bounds.media-speech-synthesis-text-to-speech", "capabilityOperationContracts/records/@id=media.operation.capability.media-speech-synthesis-text-to-speech"]],
  ["av.vision-analysis", ["media.agent-tool-contract.vision-analysis.v1", "media.operation.vision-analysis", "media.operation.capability.media-vision-detect", "capabilityOperationContracts/records/@id=media.operation.capability.media-vision-detect", "media.capability-bounds.media-vision-detect", "capabilityOperationContracts/records/@id=media.operation.capability.media-vision-detect"]],
  ["av.multimodal-inference", ["media.agent-tool-contract.multimodal-inference.v1", "media.operation.multimodal-analysis", "media.operation.capability.media-multimodal-analyze-cross-modal", "capabilityOperationContracts/records/@id=media.operation.capability.media-multimodal-analyze-cross-modal", "media.capability-bounds.media-multimodal-analyze-cross-modal", "capabilityOperationContracts/records/@id=media.operation.capability.media-multimodal-analyze-cross-modal"]],
]);
const genericOperationBindingStatus = "OWNER_DEFINED_OPERATION_CANDIDATE; adapter mapping and runtime admission pending";
const genericRegistryBindingStatus = "owner-defined-operation-candidate; adapter-mapping-and-runtime-pending";
const multimodalOperationBindingStatus = "OWNER_DEFINED_CANONICAL_OPERATION_BINDING; request mapping implemented but not wired, result adapter, independent review, and runtime admission pending";
const multimodalRegistryBindingStatus = "source-bound-by-PXD-238/PXD-240; request-mapping-implemented-but-not-wired; result-and-runtime-pending";
const multimodalOperationRef = "media.operation.capability.media-multimodal-analyze-cross-modal";

function validateMultimodalResultContract(contract, errors) {
  const input = contract.inputSchema;
  const input1 = input?.properties?.input1;
  const artifact = input1?.properties?.payload;
  const input2 = input?.properties?.input2;
  const analysis = input2?.properties?.payload;
  const criteria = analysis?.properties?.criteria;
  const requiredCriteria = ["subjectRefs", "analysisMethodRef", "profileRef", "configurationDigest", "purposeRef"];
  if (!input?.required?.includes("input1") || !input.required.includes("input2")
      || input1?.properties?.artifactType?.const !== "authorized-media-artifacts"
      || !artifact?.required?.includes("artifactId") || !artifact.required.includes("versionId")
      || input2?.properties?.artifactType?.const !== "analysis-request"
      || !analysis?.required?.includes("dimensions") || !analysis.required.includes("criteria")
      || requiredCriteria.some((field) => !criteria?.required?.includes(field))) {
    errors.push("av.multimodal-inference: input schema must preserve exact PDP-1 typed inputs and required criteria");
  }
  for (const field of ["mediaArtifactId", "inferenceMode", "samplingRateMs", "enableTranscription", "enableVisionAnalysis", "languageCode"]) {
    if (input?.properties?.[field]) errors.push(`av.multimodal-inference: legacy input ${field} must not be accepted`);
  }
  if (criteria?.properties?.profileRef?.default || criteria?.properties?.configurationDigest?.default) {
    errors.push("av.multimodal-inference: profile and configuration cannot have defaults");
  }

  const variants = contract.resultSchema?.oneOf ?? [];
  const variant = (outcome) => variants.find((branch) => branch.properties?.outcome?.const === outcome);
  const accepted = variant("ACCEPTED");
  const acceptedFields = ["operationRef", "operationId", "requestId", "requestFingerprint", "acceptedAt", "statusQueryRef"];
  if (acceptedFields.some((field) => !accepted?.required?.includes(field))
      || accepted?.properties?.operationRef?.const !== multimodalOperationRef) {
    errors.push("av.multimodal-inference: accepted result must preserve canonical receipt and request identity");
  }
  if (accepted?.required?.includes("attemptId")) errors.push("av.multimodal-inference: attemptId must remain optional on ACCEPTED");
  if (!/ACCEPTED -> media\.operation\.job\.submit\.v1 receipt/u.test(contract.resultAdapter?.mappings?.find((mapping) => mapping.startsWith("ACCEPTED")) ?? "")) {
    errors.push("av.multimodal-inference: accepted result must use the canonical job submission receipt");
  }

  const failed = variant("FAILED");
  const rejected = failed?.properties?.canonicalResult;
  if (!failed?.required?.includes("canonicalResult") || rejected?.properties?.outcome?.const !== "REJECTED"
      || !rejected?.required?.includes("outputs") || !rejected?.required?.includes("provenance")) {
    errors.push("av.multimodal-inference: FAILED must preserve the canonical REJECTED result");
  }
  if (failed?.required?.includes("attemptId")) errors.push("av.multimodal-inference: attemptId must remain optional on FAILED");
  if (rejected?.properties?.outputs?.maxItems !== 0) errors.push("av.multimodal-inference: REJECTED canonical result must contain zero outputs");
  if (failed?.properties?.safeErrorCode || failed?.properties?.finalityEvidenceRef) {
    errors.push("av.multimodal-inference: terminal rejection must not synthesize error or finality evidence");
  }

  const success = variant("SUCCEEDED");
  const canonicalResult = success?.properties?.canonicalResult;
  const outputSchema = canonicalResult?.properties?.outputs;
  const outputItem = outputSchema?.items;
  const payload = outputItem?.properties?.payload;
  const provenance = canonicalResult?.properties?.provenance;
  const successFields = ["operationRef", "operationId", "requestId", "requestFingerprint", "completedAt", "canonicalResult"];
  if (successFields.some((field) => !success?.required?.includes(field))
      || success?.properties?.operationRef?.const !== multimodalOperationRef
      || canonicalResult?.properties?.outcome?.const !== "SUCCEEDED") {
    errors.push("av.multimodal-inference: success must preserve the canonical SUCCEEDED result");
  }
  if (outputSchema?.minItems !== 1 || outputSchema?.maxItems !== 1
      || outputItem?.properties?.artifactType?.const !== "source-grounded-cross-modal-result-with-provenance-and-uncertainty"
      || !payload?.required?.includes("artifactId") || !payload?.required?.includes("versionId")
      || !payload?.required?.includes("contentSchemaRef")
      || payload?.properties?.contentSchemaRef?.const !== "media.multimodal.result-content.cross-modal.v1") {
    errors.push("av.multimodal-inference: success must carry one exact typed output artifact version");
  }
  if (!provenance?.required?.includes("operationRef") || provenance?.properties?.operationRef?.const !== multimodalOperationRef
      || !provenance?.required?.includes("observedAt") || !provenance?.required?.includes("sourceRefs")) {
    errors.push("av.multimodal-inference: success must preserve canonical source provenance");
  }
  if (success?.required?.includes("attemptId") || success?.properties?.finalityEvidenceRef || success?.properties?.canonicalPayload) {
    errors.push("av.multimodal-inference: success must not require an attempt or invent generic finality/payload fields");
  }
  if (!/completedAt equals canonicalResult\.observedAt/u.test(contract.resultAdapter?.mappings?.find((mapping) => mapping.startsWith("SUCCEEDED")) ?? "")) {
    errors.push("av.multimodal-inference: success timestamp must follow canonical result observation");
  }
  const contentRef = "media.multimodal.result-content.cross-modal.v1";
  const metadataAssertionMapping = contract.requestAdapter?.mappings?.find((mapping) =>
    mapping.startsWith("optional input1 sourceRef")) ?? "";
  if (contract.requestAdapter?.status !== "SOURCE_BOUND_IMPLEMENTED_NOT_WIRED"
      || contract.requestAdapter?.artifactMetadataDecisionRef !== ".product-experience/decision-log.md#PXD-240"
      || !/untrusted artifact metadata assertions/u.test(metadataAssertionMapping)
      || !/exact owner-authoritative comparison before dispatch/u.test(metadataAssertionMapping)
      || !decisionLog.includes("### PXD-240 — Bind optional multimodal artifact metadata assertions")) {
    errors.push("av.multimodal-inference: optional artifact metadata assertion binding is missing or admitted");
  }
  if (contract.resultContentDecisionRef !== ".product-experience/decision-log.md#PXD-239") {
    errors.push("av.multimodal-inference: PXD-239 result-content decision binding is missing");
  }
  const p1 = operations().capabilityOperationContracts;
  const outputType = p1.outputPayloadSchemas.find((item) => item.id === "media.typed-output.source-grounded-cross-modal-result-with-provenance-and-uncertainty");
  const content = outputType?.contentSchema;
  if (outputType?.contentSchemaRef !== contentRef || content?.id !== contentRef
      || content?.sourceDecisionRef !== ".product-experience/decision-log.md#PXD-239") {
    errors.push("av.multimodal-inference: P1 output type must bind the exact PXD-239 content schema");
  }
  const operation = p1.records.find((record) => record.id === multimodalOperationRef);
  const constraints = operation?.effect?.resultContentConstraints;
  if (operation?.successOutputs?.[0]?.contentSchemaRef !== contentRef
      || constraints?.contentSchemaRef !== contentRef
      || !/exact input2\.payload\.dimensions reference set/u.test(constraints?.dimensionEvidenceKeys ?? "")
      || !/at least two distinct supported modalities/u.test(constraints?.modalityResolution ?? "")
      || !/uncertainty\.scopeRef must equal that exact claimRef/u.test(constraints?.claimBinding ?? "")
      || !/exact admitted input2\.payload\.criteria\.profileRef and analysisMethodRef/u.test(constraints?.claimBinding ?? "")) {
    errors.push("av.multimodal-inference: P1 operation must bind claim dimension keys and owner modality resolution");
  }
  const successMapping = contract.resultAdapter?.mappings?.find((mapping) => mapping.startsWith("SUCCEEDED")) ?? "";
  if (!successMapping.includes(`contentSchemaRef=${contentRef}`) || !/referenced artifact version must conform/u.test(successMapping)) {
    errors.push("av.multimodal-inference: successful result must validate the exact referenced artifact content");
  }

  const unknown = variant("OUTCOME_UNKNOWN");
  if (unknown?.properties?.canonicalResult || unknown?.properties?.canonicalPayload || unknown?.properties?.payloadRef) {
    errors.push("av.multimodal-inference: unknown outcome cannot carry a success result");
  }
}

function resolveSelector(value, selector) {
  let cursor = value;
  for (const part of selector.split("/").filter(Boolean)) {
    const byId = /^@id=(.+)$/u.exec(part);
    if (byId) {
      if (!Array.isArray(cursor)) return undefined;
      cursor = cursor.find((record) => record?.id === byId[1]);
    } else if (Array.isArray(cursor) && /^\d+$/u.test(part)) cursor = cursor[Number(part)];
    else cursor = cursor?.[part];
  }
  return cursor;
}

const sourceCache = new Map();
function resolveSourceRef(ref) {
  if (typeof ref !== "string" || !ref.includes("#")) return undefined;
  const [sourcePath, selector] = ref.split("#", 2);
  const absolute = resolve(root, sourcePath);
  let source;
  try {
    if (!sourceCache.has(absolute)) sourceCache.set(absolute, readYaml(absolute));
    source = sourceCache.get(absolute);
  } catch { return undefined; }
  return resolveSelector(source, selector);
}

function closedSchema(schema, path = "schema") {
  const errors = [];
  if (!schema || typeof schema !== "object" || Array.isArray(schema)) return [`${path}: schema must be an object`];
  if (schema.type === "object" && schema.additionalProperties !== false && !schema.oneOf && !schema.anyOf) errors.push(`${path}: object is not closed`);
  if (schema.oneOf && (!Array.isArray(schema.oneOf) || schema.oneOf.length < 2)) errors.push(`${path}: oneOf must define at least two variants`);
  for (const [key, value] of Object.entries(schema)) {
    if (key === "properties" && value && typeof value === "object") {
      for (const [property, child] of Object.entries(value)) errors.push(...closedSchema(child, `${path}.${property}`));
    } else if (["items", "not", "if", "then", "else"].includes(key) && value && typeof value === "object") errors.push(...closedSchema(value, `${path}.${key}`));
    else if (Array.isArray(value) && ["oneOf", "anyOf", "allOf"].includes(key)) value.forEach((child, index) => errors.push(...closedSchema(child, `${path}.${key}[${index}]`)));
  }
  return errors;
}

function validateDefinitions(source) {
  const errors = [];
  const contracts = source.mediaOwnedToolDefinitionContracts?.contracts ?? [];
  const ids = contracts.map((item) => item.id);
  if (contracts.length !== 4 || new Set(ids).size !== 4) errors.push("expected four unique versioned tool contracts");
  if (source.mediaOwnedToolDefinitionContracts?.status !== "MEDIA_OWNER_DEFINITION_ONLY; public-runtime-binding-pending") errors.push("Media definition-only status missing");
  for (const [toolId, tuple] of expected) {
    const [contractId, familyRef, operationId, selector, boundId, budgetOwnerSelector] = tuple;
    const contract = contracts.find((item) => item.id === contractId);
    if (!contract) { errors.push(`${toolId}: missing ${contractId}`); continue; }
    const sourceOperation = resolveSourceRef(`.product-experience/pdp-1-domain-data/operations.yaml#${selector}`);
    if (!sourceOperation || sourceOperation.id !== operationId) errors.push(`${toolId}: canonical operation record selector does not resolve exactly`);
    if (contract.toolId !== toolId || contract.operationFamilyRef !== familyRef || contract.canonicalOperationRef !== `.product-experience/pdp-1-domain-data/operations.yaml#${selector}`) errors.push(`${toolId}: identity/canonical operation mismatch`);
    const isMultimodal = toolId === "av.multimodal-inference";
    const expectedBindingStatus = isMultimodal ? multimodalOperationBindingStatus : genericOperationBindingStatus;
    if (contract.operationBindingStatus !== expectedBindingStatus) errors.push(`${toolId}: operation binding status mismatch`);
    if (contract.runtimeAdmission !== "NOT_ADMITTED") errors.push(`${toolId}: runtime admission promoted`);
    if (contract.executionBudgetBoundsRef !== `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/bounds/@id=${boundId}`) errors.push(`${toolId}: execution budget must bind its exact PDP-1 capability bound`);
    const bound = resolveSourceRef(contract.executionBudgetBoundsRef);
    const budgetOwner = resolveSourceRef(`.product-experience/pdp-1-domain-data/operations.yaml#${budgetOwnerSelector}`);
    if (!bound || bound.id !== boundId || !budgetOwner || budgetOwner.boundsRef !== boundId) errors.push(`${toolId}: execution budget bound does not resolve through its applicable PDP-1 operation binding`);
    if (!/owner-selected conservative definition limits; not measured capacity, model quality, scientific accuracy, license, or runtime admission/u.test(bound?.basis ?? "")) errors.push(`${toolId}: capability bound must remain definition-only, not a runtime or pricing claim`);
    if (contract.resultSchemaRole !== "CLOSED_DISCRIMINATED_RESULT_AND_ERROR_UNION") errors.push(`${toolId}: closed result/error union role is not explicit`);
    if (contract.inputSchema?.$schema !== "https://json-schema.org/draft/2020-12/schema" || !contract.inputSchema.$id?.endsWith(":v1")) errors.push(`${toolId}: input schema is not versioned Draft 2020-12`);
    if (contract.resultSchema?.$schema !== "https://json-schema.org/draft/2020-12/schema" || !contract.resultSchema.$id?.endsWith(":v1")) errors.push(`${toolId}: result schema is not versioned Draft 2020-12`);
    errors.push(...closedSchema(contract.inputSchema, `${toolId}.inputSchema`), ...closedSchema(contract.resultSchema, `${toolId}.resultSchema`));
    if (!contract.resultSchema.oneOf.some((b) => b.properties?.outcome?.const === "REJECTED_PRE_DISPATCH")) errors.push(`${toolId}: pre-dispatch failure variant missing`);
    if (!contract.resultSchema.oneOf.some((b) => b.properties?.outcome?.const === "ACCEPTED")) errors.push(`${toolId}: accepted receipt variant missing`);
    if (!contract.resultSchema.oneOf.some((b) => b.properties?.outcome?.const === "OUTCOME_UNKNOWN")) errors.push(`${toolId}: unknown outcome variant missing`);
    const accepted = contract.resultSchema.oneOf.find((b) => b.properties?.outcome?.const === "ACCEPTED");
    if (accepted?.required?.includes("attemptId")) errors.push(`${toolId}: accepted receipt cannot require an unprovided attempt ID`);
    const predispatch = contract.resultSchema.oneOf.find((b) => b.properties?.outcome?.const === "REJECTED_PRE_DISPATCH");
    if (predispatch?.properties?.operationId || predispatch?.required?.includes("operationId")) errors.push(`${toolId}: pre-dispatch failure invents an operation identity`);
    const unknown = contract.resultSchema.oneOf.find((b) => b.properties?.outcome?.const === "OUTCOME_UNKNOWN");
    if (!unknown?.oneOf || unknown.oneOf.length !== 2) errors.push(`${toolId}: unknown result must distinguish known and unresolved operation identity`);
    if (unknown?.properties?.payloadRef || unknown?.properties?.canonicalPayload) errors.push(`${toolId}: unknown outcome carries success payload`);
    const success = contract.resultSchema.oneOf.find((b) => b.properties?.outcome?.const === "SUCCEEDED");
    if (isMultimodal) validateMultimodalResultContract(contract, errors);
    else if (success) {
      const payload = success.properties?.canonicalPayload;
      for (const field of ["attemptId", "operationId", "canonicalPayload"]) if (!success.required?.includes(field)) errors.push(`${toolId}: success omits required ${field}`);
      for (const field of ["payloadTypeRef", "payloadSchemaRef", "subjectObjectRef", "subjectVersionRef", "producerRef", "profileRef", "profileVersionRef", "provenanceRef", "evidenceRefs", "observedAt"]) if (!payload?.required?.includes(field)) errors.push(`${toolId}: success payload omits ${field}`);
    }
    const fields = new Set(Object.keys(contract.inputSchema?.properties ?? {}));
    for (const forbidden of ["tenantId", "principalId", "delegation", "policyDecision", "idempotencyKey", "deadline", "cancellationToken", "executionBudget", "budgetRef", "capabilityBoundsRef"]) if (fields.has(forbidden)) errors.push(`${toolId}: trusted context field ${forbidden} must not be model supplied`);
    for (const ref of contract.authorityRefs ?? []) if (!resolveSourceRef(ref)) errors.push(`${toolId}: authority source reference does not resolve: ${ref}`);
    for (const ref of [contract.canonicalOperationRef, contract.requestAdapter?.canonicalContractRef]) {
      if (!resolveSourceRef(ref)) errors.push(`${toolId}: canonical source reference does not resolve: ${ref}`);
    }
    const requestSource = resolveSourceRef(contract.requestAdapter?.canonicalContractRef);
    if (!requestSource || typeof requestSource !== "object") errors.push(`${toolId}: exact canonical request schema selector does not resolve`);
    const registryTool = (registry().tools ?? []).find((item) => item.id === toolId);
    if (!registryTool || registryTool.mediaDefinitionContractRef !== `.product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml#mediaOwnedToolDefinitionContracts/contracts/@id=${contractId}`) errors.push(`${toolId}: registry contract ref mismatch`);
    const expectedRegistryStatus = isMultimodal ? multimodalRegistryBindingStatus : genericRegistryBindingStatus;
    if (registryTool?.operationBinding?.value !== operationId || registryTool.operationBinding.status !== expectedRegistryStatus) errors.push(`${toolId}: registry binding scope mismatch`);
    const requestAdapterPending = contract.requestAdapter?.status === (isMultimodal ? "SOURCE_BOUND_IMPLEMENTED_NOT_WIRED" : "NOT_IMPLEMENTED");
    const resultAdapterPending = contract.resultAdapter?.status === (isMultimodal ? "SOURCE_BOUND_NOT_IMPLEMENTED" : "NOT_IMPLEMENTED");
    if (registryTool?.executionAdmitted !== false || !requestAdapterPending || !resultAdapterPending) errors.push(`${toolId}: adapter or runtime admission boundary mismatch`);
  }
  const host = source.mediaOwnedToolDefinitionContracts?.hostInvocationContext?.schema;
  if (!host?.required?.includes("executionBudget")) errors.push("host invocation context must require an execution budget disposition");
  const resultErrorContract = source.mediaOwnedToolDefinitionContracts?.invocationSemantics?.resultErrorContract;
  if (resultErrorContract?.id !== "media.agent-tool-result-error-union.v1" || resultErrorContract.schemaRef !== "each-contract-resultSchema") errors.push("closed result/error union contract is not explicit");
  return errors;
}

function validateHostExecutionBudget(toolId, hostContext) {
  const source = conventions();
  const tuple = expected.get(toolId);
  if (!tuple) return false;
  const [contractId, , , operationSelector, , boundsOwnerSelector] = tuple;
  const contract = source.mediaOwnedToolDefinitionContracts.contracts.find((item) => item.id === contractId);
  const operation = resolveSourceRef(`.product-experience/pdp-1-domain-data/operations.yaml#${operationSelector}`);
  const boundsOwner = resolveSourceRef(`.product-experience/pdp-1-domain-data/operations.yaml#${boundsOwnerSelector}`);
  const budget = hostContext?.executionBudget;
  if (!contract || !operation || !boundsOwner || !boundsOwner.boundsRef || budget?.disposition !== "BOUNDED") return false;
  const canonicalBoundsRef = `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/bounds/@id=${boundsOwner.boundsRef}`;
  const resolvedBounds = resolveSourceRef(budget.capabilityBoundsRef);
  return contract.canonicalOperationRef === `.product-experience/pdp-1-domain-data/operations.yaml#${operationSelector}`
    && contract.executionBudgetBoundsRef === canonicalBoundsRef
    && budget.capabilityBoundsRef === contract.executionBudgetBoundsRef
    && resolvedBounds?.id === boundsOwner.boundsRef;
}

const makeAjv = () => { const ajv = new Ajv2020({strict:false, validateFormats:true, allErrors:true}); addFormats(ajv); return ajv; };
const schemaCache = new WeakMap();
const compile = (schema) => { if (!schemaCache.has(schema)) schemaCache.set(schema, makeAjv().compile(schema)); return schemaCache.get(schema); };
const baseFor = (contract, outcome) => ({contractId:contract.id, toolId:contract.toolId, outcome});

test("Media Agent Tool contracts resolve exact canonical source records and stay definition-only", () => {
  const source = conventions();
  assert.deepEqual(validateDefinitions(source), []);
  const media = source.mediaOwnedToolDefinitionContracts;
  assert.equal(media.hostInvocationContext.id, "media.agent-tool-host-context.v1");
  assert.equal(media.invocationSemantics.id, "media.agent-tool-invocation-policy.v1");
  assert.equal(media.sharedBinding.status, "NOT_BOUND");
  assert.equal(media.sharedBinding.adapterStatus, "NOT_IMPLEMENTED; no Media adapter currently maps the proposed Media result schemas to the installed Tools SPI.");
  assert.equal(media.status, "MEDIA_OWNER_DEFINITION_ONLY; public-runtime-binding-pending");
});

test("multimodal Agent Tool experience binds J-25 without admitting runtime execution", () => {
  const tool = registry().tools.find((item) => item.id === "av.multimodal-inference");
  assert.equal(tool.experienceBinding, "source-bound-to-J-25-by-PXD-241; independent-experience-review-pending");
  assert.equal(tool.experienceContract?.decisionRef, ".product-experience/decision-log.md#PXD-241");
  assert.equal(tool.experienceContract?.journeyRef, "J-25");
  assert.equal(tool.experienceContract?.channelRef, "media.channel.agent");
  assert.equal(tool.experienceContract?.consumerSurfaceId, "media.surface.agent-tools");
  assert.equal(tool.experienceContract?.status, "SOURCE_BOUND_DEFINITION_ONLY; INDEPENDENT_REVIEW_PENDING");
  assert.equal(tool.experienceContract?.runtimeAdmission, "NOT_ADMITTED");
  assert.deepEqual(tool.experienceContract?.actingPersonRefs, ["media.creator", "media.editor", "media.reviewer"]);
  assert.match(tool.experienceContract?.requestBoundary ?? "", /profileRef, configurationDigest, and purposeRef/u);
  assert.match(tool.experienceContract?.outcomeSemantics?.accepted ?? "", /jobId, requestId, requestFingerprint, and exact statusQueryRef/u);
  assert.match(tool.experienceContract?.outcomeSemantics?.unknown ?? "", /same request identity before retry/u);
  const journey = readYaml(j25Path);
  const journeyToolBinding = journey.agentToolBindings?.find((binding) => binding.toolId === "av.multimodal-inference");
  assert.ok(journey.channels.includes("media.channel.agent"));
  assert.equal(journey.pdp1ResultEvidence.channelAndRuntimeBoundary.intendedChannels.includes("media.channel.agent"), true);
  assert.equal(journeyToolBinding?.sourceDecisionRef, ".product-experience/decision-log.md#PXD-241");
  assert.equal(journeyToolBinding?.consumerSurfaceId, "media.surface.agent-tools");
  assert.equal(journeyToolBinding?.channelTransport, "UNBOUND");
  assert.equal(journeyToolBinding?.runtimeAdmission, "NOT_ADMITTED");
  assert.match(decisionLog, /### PXD-241 — Bind the cross-modal Agent Tool experience to J-25/u);
  assert.equal(tool.executionAdmitted, false);
});

test("cross-modal artifact content is version-bound, source-scoped, uncertainty-complete, and admits explicit unknown", () => {
  const p1 = operations().capabilityOperationContracts;
  const outputType = p1.outputPayloadSchemas.find((item) => item.id === "media.typed-output.source-grounded-cross-modal-result-with-provenance-and-uncertainty");
  const contentSchema = outputType.contentSchema.schema;
  const dimensionEvidenceMatchesRequest = (content, requestedDimensions) => content.claims.every((claim) => {
    const actual = Object.keys(claim.dimensionEvidence).sort();
    return claim.uncertainty.scopeRef === claim.claimRef
      && JSON.stringify(actual) === JSON.stringify([...requestedDimensions].sort());
  });
  assert.match(outputType.contentSchema.ownerDefinition, /uncertainty\.scopeRef must equal that exact claimRef/u);
  assert.match(outputType.contentSchema.ownerDefinition, /exact requested dimension set/u);
  const validContent = {
    resultDisposition: "REPORTED",
    sourceRefs: ["source:artifact:version-1"],
    claims: [{
      claimRef: "profile:claim:version-1",
      disposition: "REPORTED",
      dimensionEvidence: {
        "dimension:audio": { sourceRef: "source:artifact:version-1", evidenceDisposition: "PRESENT", evidenceRefs: ["evidence:audio:version-1"], reasonRefs: [] },
        "dimension:visual": { sourceRef: "source:artifact:version-1", evidenceDisposition: "PRESENT", evidenceRefs: ["evidence:visual:version-1"], reasonRefs: [] },
      },
      uncertainty: {
        scopeRef: "profile:claim:version-1",
        disposition: "QUALITATIVE",
        evidenceDisposition: "PRESENT",
        evidenceRefs: ["uncertainty:evidence:version-1"],
        limitationRefs: [],
        reasonRefs: [],
      },
    }],
    reasonRefs: [],
  };
  const validateContent = compile(contentSchema);
  assert.equal(validateContent(validContent), true, "reported claims retain exact source and scoped uncertainty evidence");
  assert.equal(dimensionEvidenceMatchesRequest(validContent, ["dimension:audio", "dimension:visual"]), true,
    "claim uncertainty scope and dimension refs join to the exact request");
  const wrongScope = structuredClone(validContent);
  wrongScope.claims[0].uncertainty.scopeRef = "profile:another-claim:version-1";
  assert.equal(dimensionEvidenceMatchesRequest(wrongScope, ["dimension:audio", "dimension:visual"]), false,
    "a claim cannot reuse another claim's uncertainty scope");
  assert.equal(dimensionEvidenceMatchesRequest(validContent, ["dimension:audio", "dimension:depth"]), false,
    "a claim cannot substitute a requested dimension key");
  assert.equal(validateContent({ ...validContent, claims: [] }), false, "REPORTED cannot silently omit every claim");
  const unknownWithoutReason = { resultDisposition: "UNKNOWN", sourceRefs: validContent.sourceRefs, claims: [], reasonRefs: [] };
  assert.equal(validateContent(unknownWithoutReason), false, "empty UNKNOWN output requires an explicit reason");
  assert.equal(validateContent({ ...unknownWithoutReason, reasonRefs: ["reason:unknown:version-1"] }), true,
    "explicit UNKNOWN with no fabricated claim is representable");
  const unknownClaim = structuredClone(validContent);
  unknownClaim.claims[0].disposition = "UNKNOWN";
  unknownClaim.claims[0].uncertainty.disposition = "UNKNOWN";
  unknownClaim.claims[0].uncertainty.evidenceDisposition = "UNKNOWN";
  unknownClaim.claims[0].uncertainty.evidenceRefs = [];
  unknownClaim.claims[0].uncertainty.reasonRefs = ["reason:unknown-claim:version-1"];
  assert.equal(validateContent(unknownClaim), true, "UNKNOWN claim is explicit, scoped, and reasoned");
  const oneDimension = structuredClone(validContent);
  delete oneDimension.claims[0].dimensionEvidence["dimension:visual"];
  assert.equal(validateContent(oneDimension), false, "a claim cannot carry fewer than two dimension evidence entries");
  const missingClaimReason = structuredClone(validContent);
  missingClaimReason.claims[0].disposition = "ABSTAINED";
  missingClaimReason.claims[0].uncertainty.reasonRefs = [];
  assert.equal(validateContent(missingClaimReason), false, "ABSTAINED claim requires a reason");
  const missingEvidence = structuredClone(validContent);
  missingEvidence.claims[0].dimensionEvidence["dimension:audio"].evidenceRefs = [];
  assert.equal(validateContent(missingEvidence), false, "PRESENT evidence disposition requires evidence references");
  const unknownEvidenceWithoutReason = structuredClone(validContent);
  unknownEvidenceWithoutReason.claims[0].dimensionEvidence["dimension:audio"].evidenceDisposition = "UNKNOWN";
  unknownEvidenceWithoutReason.claims[0].dimensionEvidence["dimension:audio"].evidenceRefs = [];
  assert.equal(validateContent(unknownEvidenceWithoutReason), false, "UNKNOWN evidence disposition requires a reason");
  const unknownUncertaintyWithoutReason = structuredClone(validContent);
  unknownUncertaintyWithoutReason.claims[0].uncertainty.disposition = "UNKNOWN";
  unknownUncertaintyWithoutReason.claims[0].uncertainty.evidenceDisposition = "UNKNOWN";
  unknownUncertaintyWithoutReason.claims[0].uncertainty.evidenceRefs = [];
  assert.equal(validateContent(unknownUncertaintyWithoutReason), false, "UNKNOWN uncertainty requires a reason");
  const reportedWithoutUncertaintyEvidence = structuredClone(validContent);
  reportedWithoutUncertaintyEvidence.claims[0].uncertainty.disposition = "UNKNOWN";
  reportedWithoutUncertaintyEvidence.claims[0].uncertainty.evidenceDisposition = "UNKNOWN";
  reportedWithoutUncertaintyEvidence.claims[0].uncertainty.evidenceRefs = [];
  reportedWithoutUncertaintyEvidence.claims[0].uncertainty.reasonRefs = ["reason:uncertainty-unknown:version-1"];
  assert.equal(validateContent(reportedWithoutUncertaintyEvidence), false,
    "REPORTED claim cannot pass when uncertainty is UNKNOWN or unsupported by evidence");

  const contract = conventions().mediaOwnedToolDefinitionContracts.contracts.find((item) => item.toolId === "av.multimodal-inference");
  const observedAt = "2026-11-26T12:00:00Z";
  const successfulToolResult = {
    contractId: contract.id,
    toolId: contract.toolId,
    outcome: "SUCCEEDED",
    operationRef: multimodalOperationRef,
    operationId: "job:exact-1",
    requestId: "request:exact-1",
    requestFingerprint: `sha256:${"a".repeat(64)}`,
    completedAt: observedAt,
    canonicalResult: {
      outcome: "SUCCEEDED",
      observedAt,
      outputs: [{
        artifactType: "source-grounded-cross-modal-result-with-provenance-and-uncertainty",
        payload: { artifactId: "artifact:result-1", versionId: "version:1", contentSchemaRef: outputType.contentSchemaRef },
      }],
      provenance: { operationRef: multimodalOperationRef, observedAt, sourceRefs: ["source:artifact:version-1"] },
      implementationState: "UNKNOWN",
      qualificationState: "NOT_EVALUATED",
      runtimeAvailability: "UNKNOWN",
    },
  };
  const validateToolResult = compile(contract.resultSchema);
  assert.equal(validateToolResult(successfulToolResult), true, "success binds the exact output content schema");
  const missingRef = structuredClone(successfulToolResult);
  delete missingRef.canonicalResult.outputs[0].payload.contentSchemaRef;
  assert.equal(validateToolResult(missingRef), false, "success cannot omit the artifact content schema ref");
  const substitutedRef = structuredClone(successfulToolResult);
  substitutedRef.canonicalResult.outputs[0].payload.contentSchemaRef = "media.multimodal.result-content.other.v1";
  assert.equal(validateToolResult(substitutedRef), false, "success cannot substitute a different content schema");
  const outputTypeMapping = readYaml(domainObjectsPath).ownerOutputArtifactTypeCrosswalk.records.find(
    (item) => item.artifactType === "source-grounded-cross-modal-result-with-provenance-and-uncertainty",
  );
  assert.equal(outputTypeMapping.contentSchemaRef, outputType.contentSchemaRef, "P1 domain mapping binds the exact content schema");
  assert.equal(outputTypeMapping.contentSchemaSourceRef,
    ".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/outputPayloadSchemas/@id=media.typed-output.source-grounded-cross-modal-result-with-provenance-and-uncertainty/contentSchema");
  assert.equal(outputTypeMapping.sourceDecisionRef, ".product-experience/decision-log.md#PXD-239");
});

test("host execution budget capability bounds join exactly to each selected canonical operation", () => {
  const contracts = conventions().mediaOwnedToolDefinitionContracts.contracts;
  const budgetRefFor = (contract) => contract.executionBudgetBoundsRef;
  for (const [toolId, [contractId]] of expected) {
    const contract = contracts.find((item) => item.id === contractId);
    assert.ok(contract, `${toolId}: expected contract exists`);
    const invocation = { executionBudget: { disposition: "BOUNDED", capabilityBoundsRef: budgetRefFor(contract) } };
    assert.equal(validateHostExecutionBudget(toolId, invocation), true, `${toolId}: exact operation/bounds join is accepted`);

    const otherContract = contracts.find((item) => item.id !== contractId);
    assert.equal(validateHostExecutionBudget(toolId, { executionBudget: { disposition: "BOUNDED", capabilityBoundsRef: budgetRefFor(otherContract) } }), false,
      `${toolId}: cross-tool bounds reference is rejected`);
    assert.equal(validateHostExecutionBudget(toolId, { executionBudget: { disposition: "BOUNDED", capabilityBoundsRef: `${budgetRefFor(contract)}-stale` } }), false,
      `${toolId}: stale bounds reference is rejected`);
    assert.equal(validateHostExecutionBudget(toolId, { executionBudget: { disposition: "BOUNDED", capabilityBoundsRef: budgetRefFor(contract).replace(/media\.capability-bounds\./u, "media.capability-bounds.substituted-") } }), false,
      `${toolId}: substituted bounds reference is rejected`);
  }
  const media = conventions().mediaOwnedToolDefinitionContracts;
  assert.equal(media.status, "MEDIA_OWNER_DEFINITION_ONLY; public-runtime-binding-pending");
  assert.equal(media.sharedBinding.status, "NOT_BOUND");
});

test("contract validator rejects exact-ref substitutions, admitted bindings, missing unknown semantics, and weak success evidence", () => {
  const original = conventions();
  const swap = structuredClone(original);
  [swap.mediaOwnedToolDefinitionContracts.contracts[0].toolId,swap.mediaOwnedToolDefinitionContracts.contracts[1].toolId]=[swap.mediaOwnedToolDefinitionContracts.contracts[1].toolId,swap.mediaOwnedToolDefinitionContracts.contracts[0].toolId];
  assert.ok(validateDefinitions(swap).some(e=>/identity\/canonical operation mismatch/u.test(e)));
  const wrongRef=structuredClone(original); wrongRef.mediaOwnedToolDefinitionContracts.contracts[0].canonicalOperationRef=wrongRef.mediaOwnedToolDefinitionContracts.contracts[1].canonicalOperationRef;
  assert.ok(validateDefinitions(wrongRef).some(e=>/canonical source reference does not resolve|canonical operation mismatch/u.test(e)));
  const admitted=structuredClone(original); admitted.mediaOwnedToolDefinitionContracts.contracts[0].runtimeAdmission="ADMITTED";
  assert.ok(validateDefinitions(admitted).some(e=>/runtime admission promoted/u.test(e)));
  const missing=structuredClone(original); missing.mediaOwnedToolDefinitionContracts.contracts[0].resultSchema.oneOf=missing.mediaOwnedToolDefinitionContracts.contracts[0].resultSchema.oneOf.filter(b=>b.properties?.outcome?.const!=="OUTCOME_UNKNOWN");
  assert.ok(validateDefinitions(missing).some(e=>/unknown outcome variant missing/u.test(e)));
  const weak=structuredClone(original); const good=weak.mediaOwnedToolDefinitionContracts.contracts[1].resultSchema.oneOf.find(b=>b.properties?.outcome?.const==="SUCCEEDED"); good.properties.canonicalPayload.required=good.properties.canonicalPayload.required.filter(x=>x!=="provenanceRef");
  assert.ok(validateDefinitions(weak).some(e=>/success payload omits provenanceRef/u.test(e)));
});

test("input schemas enforce bounds, formats, and decoded byte counts at the exact 20 MiB boundary", () => {
  const contracts = new Map(conventions().mediaOwnedToolDefinitionContracts.contracts.map(c=>[c.toolId,c]));
  const stt=contracts.get("av.speech-to-text"), tts=contracts.get("av.text-to-speech"), vision=contracts.get("av.vision-analysis"), mm=contracts.get("av.multimodal-inference");
  const validSchema=(schema,value)=>compile(schema)(value);
  const decodedByteBound=(contract,value)=>{
    const limit=conventions().mediaOwnedToolDefinitionContracts.binaryInputBounds.tools[contract.toolId];
    if (!limit) return true;
    const field=limit.field.split(".").reduce((x,k)=>x?.[k],value);
    if (field===undefined) return true;
    let decoded; try { decoded=Buffer.from(field,"base64"); } catch { return false; }
    return decoded.toString("base64")===field && decoded.byteLength<=limit.maximumDecodedBytes;
  };
  const validateCandidate=(contract,value)=>validSchema(contract.inputSchema,value)&&decodedByteBound(contract,value);
  assert.equal(validateCandidate(stt,{audioSource:{mediaArtifactId:"artifact-1"},languageCode:"en-US"}),true);
  assert.equal(validateCandidate(stt,{audioSource:{mediaArtifactId:"artifact-1",audioBytes:"YWJj"}}),false);
  assert.equal(validateCandidate(stt,{audioSource:{audioBytes:"%%%%"}}),false);
  assert.equal(validSchema(tts.inputSchema,{text:"hello",speakingRate:1.25,pitch:-2,audioEncoding:"WAV"}),true);
  assert.equal(validSchema(tts.inputSchema,{text:"   "}),false);
  assert.equal(validSchema(tts.inputSchema,{text:"hello",speakingRate:4.01}),false);
  assert.equal(validSchema(vision.inputSchema,{mediaSource:{mediaArtifactId:"image-1"}}),true);
  assert.equal(validSchema(vision.inputSchema,{mediaSource:{imageBytes:"YWJj",mimeType:"image/png"},analysisTypes:["CUSTOM_MODEL"],customModelId:"m"}),true);
  assert.equal(validSchema(vision.inputSchema,{mediaSource:{mediaArtifactId:"image-1",other:true}}),false);
  assert.equal(validSchema(mm.inputSchema,{mediaArtifactId:"a",enableTranscription:false,enableVisionAnalysis:false}),false);
  const result=contracts.get("av.text-to-speech").resultSchema;
  const accepted=baseFor(contracts.get("av.text-to-speech"),"ACCEPTED");
  Object.assign(accepted,{operationRef:"media.operation.capability.media-speech-synthesis-text-to-speech",operationId:"op-1",acceptedAt:"2026-10-09T12:00:00Z",statusQueryRef:"query:op-1",requestFingerprint:`sha256:${"a".repeat(64)}`});
  assert.equal(validSchema(result,accepted),true,"accepted receipt does not require attemptId");
  assert.equal(validSchema(result,{...accepted,acceptedAt:"2026-02-31T12:00:00Z"}),false,"date-time format rejects normalized impossible dates");
  assert.equal(validSchema(result,{...accepted,acceptedAt:"not-a-date"}),false,"date-time format is actually applied");

  const exactBytes=Buffer.alloc(20*1024*1024);
  const plusOne=Buffer.alloc(20*1024*1024+1);
  const exactEncoded=exactBytes.toString("base64"), plusEncoded=plusOne.toString("base64");
  const sttExact={audioSource:{audioBytes:exactEncoded}}, sttPlus={audioSource:{audioBytes:plusEncoded}};
  const visionExact={mediaSource:{imageBytes:exactEncoded,mimeType:"image/png"}}, visionPlus={mediaSource:{imageBytes:plusEncoded,mimeType:"image/png"}};
  assert.equal(decodedByteBound(stt,sttExact),true,"20 MiB STT payload is accepted by the decoded-byte boundary");
  assert.equal(plusEncoded.length,exactEncoded.length,"20 MiB and 20 MiB + 1 have the same encoded length");
  const sttMax=stt.inputSchema.properties.audioSource.oneOf[1].properties.audioBytes.maxLength;
  assert.ok(plusEncoded.length<=sttMax,"JSON Schema length alone cannot distinguish the same-length over-bound value");
  assert.equal(decodedByteBound(stt,sttPlus),false,"decoded-byte guard rejects one extra decoded byte");
  assert.equal(decodedByteBound(vision,visionExact),true,"20 MiB Vision payload matches the inspected Java source bound");
  const visionMax=vision.inputSchema.properties.mediaSource.oneOf[1].properties.imageBytes.maxLength;
  assert.ok(plusEncoded.length<=visionMax,"Vision JSON Schema length alone cannot distinguish the over-bound payload");
  assert.equal(decodedByteBound(vision,visionPlus),false,"Vision decoded-byte guard rejects one extra decoded byte");
});

test("host context requires exact object/version/tenant/purpose authority evidence, not opaque resource refs", () => {
  const host=conventions().mediaOwnedToolDefinitionContracts.hostInvocationContext;
  const schema=host.schema; const check=compile(schema);
  const tuple={principalRef:"principal:1",tenantRef:"tenant:1",delegationChainRef:"delegation:1",purposeRef:"purpose:transcription",resourceBindings:[{objectRef:"media.domain.artifact",versionRef:"artifact-version:1",tenantRef:"tenant:1",purposeRef:"purpose:transcription",authorityDecisionRef:"decision:1",decision:"AUTHORIZED",evidenceRef:"evidence:1",observedAt:"2026-10-09T12:00:00Z",validUntil:"2026-10-09T13:00:00Z"}],policyDecisionRefs:["decision:1"],invocationId:"invocation:1",deadline:"2026-10-09T12:30:00Z",idempotencyDisposition:"REQUIRED_SCOPED_KEY",idempotencyKeyRef:"key:1",cancellationRef:"cancel:1",executionBudget:{disposition:"BOUNDED",budgetRef:"budget:1",policyVersionRef:"policy:v1",capabilityBoundsRef:".product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts/bounds/@id=media.capability-bounds.media-speech-transcription-file"}};
  const tupleValid=(x,now="2026-10-09T12:01:00Z")=>check(x)&&x.resourceBindings.every(b=>b.tenantRef===x.tenantRef&&b.purposeRef===x.purposeRef&&b.decision==="AUTHORIZED"&&Date.parse(b.observedAt)<=Date.parse(now)&&Date.parse(now)<Date.parse(b.validUntil));
  assert.equal(tupleValid(tuple),true);
  assert.equal(check({...tuple,resourceBindings:[{...tuple.resourceBindings[0],decision:"DENIED"}]}),false,"denied resource tuples are not invocation context");
  assert.equal(check({...tuple,policyDecisionRefs:undefined}),false,"invocation context requires explicit current policy decision evidence");
  assert.equal(check({...tuple,policyDecisionRefs:[]}),false,"invocation context cannot omit policy decision evidence");
  assert.equal(check({...tuple,deadline:"2026-02-31T12:30:00Z"}),false,"host deadline uses a validated date-time");
  assert.equal(check({...tuple,idempotencyDisposition:"READ_ONLY_NO_KEY",idempotencyKeyRef:"key:1"}),false,"read-only calls cannot carry mutation idempotency keys");
  assert.equal(check({...tuple,idempotencyDisposition:"REQUIRED_SCOPED_KEY",idempotencyKeyRef:undefined}),false,"effectful calls require a scoped key");
  assert.equal(tupleValid({...tuple,resourceBindings:["artifact:1"]}),false);
  assert.equal(tupleValid({...tuple,resourceBindings:[{...tuple.resourceBindings[0],tenantRef:"tenant:other"}]}),false);
  assert.equal(tupleValid({...tuple,resourceBindings:[{...tuple.resourceBindings[0],decision:"UNKNOWN"}]}),false);
  assert.equal(tupleValid({...tuple,resourceBindings:[{...tuple.resourceBindings[0],validUntil:"2026-10-09T12:00:00Z"}]}),false);
  assert.equal(check({...tuple,executionBudget:{disposition:"BOUNDED",budgetRef:"budget:1"}}),false,"bounded invocation requires host budget, policy, and source-bound refs");
  assert.equal(check({...tuple,executionBudget:{disposition:"UNSUPPORTED_NO_DISPATCH",budgetRef:"budget:1"}}),false,"unsupported budget disposition cannot carry a usable allocation");
  const unsupported={...tuple,executionBudget:{disposition:"UNSUPPORTED_NO_DISPATCH"}};
  assert.equal(check(unsupported),true,"unsupported budget can be represented as a closed no-dispatch context");
  assert.notEqual(unsupported.executionBudget.disposition,"BOUNDED","unsupported budget is never dispatchable");
});

test("closed result/error union uses bounded error codes and keeps unknown non-final", () => {
  const definition=conventions().mediaOwnedToolDefinitionContracts;
  assert.match(definition.invocationSemantics.resultErrorContract.rule,/one discriminated result\/error contract/u);
  assert.match(definition.invocationSemantics.resultErrorContract.rule,/arbitrary error details are forbidden/u);
  for(const contract of definition.contracts){
    assert.equal(contract.resultSchemaRole,"CLOSED_DISCRIMINATED_RESULT_AND_ERROR_UNION");
    for(const outcome of ["REJECTED_PRE_DISPATCH","FAILED"]){
      const variant=contract.resultSchema.oneOf.find((branch)=>branch.properties?.outcome?.const===outcome);
      assert.ok(variant,`${contract.toolId}: ${outcome} error variant exists`);
      assert.equal(variant.additionalProperties,false,`${contract.toolId}: ${outcome} rejects undeclared error detail`);
      if(contract.toolId==="av.multimodal-inference"&&outcome==="FAILED"){
        assert.ok(variant.required.includes("canonicalResult"),"multimodal terminal failure preserves the canonical result");
        assert.equal(variant.properties.canonicalResult.properties.outcome.const,"REJECTED");
        assert.equal(variant.properties.canonicalResult.properties.outputs.maxItems,0,"canonical rejection carries zero outputs");
        assert.equal(variant.properties.safeErrorCode,undefined,"canonical rejection does not synthesize a safe error code");
        assert.equal(variant.properties.finalityEvidenceRef,undefined,"canonical rejection does not invent finality evidence");
      }else{
        assert.ok(variant.required.includes("safeErrorCode"),`${contract.toolId}: ${outcome} requires safeErrorCode`);
        assert.ok(variant.properties.safeErrorCode.pattern,`${contract.toolId}: error code is bounded`);
      }
      assert.equal(variant.properties.message,undefined,`${contract.toolId}: error message is not exposed`);
    }
    const unknown=contract.resultSchema.oneOf.find((branch)=>branch.properties?.outcome?.const==="OUTCOME_UNKNOWN");
    assert.ok(unknown);
    assert.equal(unknown.properties.canonicalPayload,undefined,`${contract.toolId}: unknown cannot carry success payload`);
    assert.equal(unknown.properties.payloadRef,undefined,`${contract.toolId}: unknown cannot carry a success reference`);
  }
});

test("pre-dispatch failure, accepted receipt, unknown dispatch, and completion remain distinct", () => {
  const contract=conventions().mediaOwnedToolDefinitionContracts.contracts.find(c=>c.toolId==="av.speech-to-text");
  const validate=compile(contract.resultSchema);
  const common=baseFor(contract,"REJECTED_PRE_DISPATCH");
  assert.equal(validate({...common,invocationId:"inv-1",safeErrorCode:"INVALID_INPUT",rejectedAt:"2026-10-09T12:00:00Z"}),true);
  assert.equal(validate({...common,invocationId:"inv-1",operationId:"invented",safeErrorCode:"INVALID_INPUT",rejectedAt:"2026-10-09T12:00:00Z"}),false);
  const accepted={...baseFor(contract,"ACCEPTED"),operationRef:"media.operation.transcription-submission",operationId:"op-1",acceptedAt:"2026-10-09T12:00:00Z",statusQueryRef:"query:op-1",requestFingerprint:`sha256:${"b".repeat(64)}`};
  assert.equal(validate(accepted),true,"submission receipt can exist before attempt claim and is not a transcript");
  const unknown={...baseFor(contract,"OUTCOME_UNKNOWN"),identityDisposition:"DISPATCHED_IDENTITY_UNRESOLVED",invocationId:"inv-2",requestFingerprint:`sha256:${"c".repeat(64)}`,observedAt:"2026-10-09T12:00:00Z"};
  assert.equal(validate(unknown),true);
  assert.equal(validate({...unknown,operationId:"invented"}),false);
  assert.equal(validate({...unknown,payloadRef:"fake-success"}),false);
  assert.equal(contract.resultSchema.oneOf.some(b=>b.properties?.outcome?.const==="SUCCEEDED"),false,"STT submission schema cannot claim transcript completion");
  for(const c of conventions().mediaOwnedToolDefinitionContracts.contracts.filter(c=>c.toolId!=="av.speech-to-text"&&c.toolId!=="av.multimodal-inference")){
    const schema=compile(c.resultSchema), success=c.resultSchema.oneOf.find(b=>b.properties?.outcome?.const==="SUCCEEDED");
    const op=success.properties.operationRef.const;
    const payload={payloadTypeRef:"media.typed-output.example",payloadSchemaRef:"schema:typed-output:v1",payloadRef:"payload:1",subjectObjectRef:"media.domain.artifact",subjectVersionRef:"artifact-version:1",producerRef:"producer:1",profileRef:"profile:1",profileVersionRef:"profile-version:1",provenanceRef:"provenance:1",evidenceRefs:["evidence:1"],observedAt:"2026-10-09T12:00:00Z"};
    const good={...baseFor(c,"SUCCEEDED"),operationRef:op,operationId:"op-1",attemptId:"attempt-1",completedAt:"2026-10-09T12:01:00Z",finalityEvidenceRef:"finality:1",canonicalPayload:payload};
    assert.equal(schema(good),true,`${c.toolId}: typed result identity/provenance/finality accepted`);
    assert.equal(schema({...good,canonicalPayload:{...payload,subjectVersionRef:undefined}}),false,`${c.toolId}: result without exact subject version rejected`);
    assert.equal(schema({...good,canonicalPayload:{...payload,provenanceRef:undefined}}),false,`${c.toolId}: result without provenance rejected`);
    assert.equal(schema({...good,attemptId:undefined}),false,`${c.toolId}: completed result without attempt evidence rejected`);
  }

  const mm=conventions().mediaOwnedToolDefinitionContracts.contracts.find(c=>c.toolId==="av.multimodal-inference");
  const mmSchema=compile(mm.resultSchema);
  const mmBase=(outcome)=>baseFor(mm,outcome);
  const requestId=`agtool-${"d".repeat(64)}`;
  const requestFingerprint=`sha256:${"e".repeat(64)}`;
  const operationRef=multimodalOperationRef;
  const mmAccepted={...mmBase("ACCEPTED"),operationRef,operationId:"job-1",requestId,requestFingerprint,acceptedAt:"2026-10-09T12:00:00Z",statusQueryRef:"inspect-job:job-1"};
  assert.equal(mmSchema(mmAccepted),true,"accepted result is the canonical job receipt without an attempt claim");
  assert.equal(mmSchema({...mmAccepted,attemptId:"attempt-1"}),true,"accepted receipt preserves an optional exact attempt identity");
  assert.equal(mmSchema({...mmAccepted,canonicalResult:{outcome:"SUCCEEDED"}}),false,"accepted receipt cannot carry an output result");

  const mmUnknown={...mmBase("OUTCOME_UNKNOWN"),identityDisposition:"DISPATCHED_IDENTITY_UNRESOLVED",invocationId:"inv-mm-1",requestId,requestFingerprint,observedAt:"2026-10-09T12:00:00Z"};
  assert.equal(mmSchema(mmUnknown),true,"unknown dispatch keeps request correlation without claiming success");
  assert.equal(mmSchema({...mmUnknown,canonicalResult:{outcome:"SUCCEEDED"}}),false,"unknown result cannot carry a canonical success payload");
  assert.equal(mmSchema({...mmUnknown,payloadRef:"fake-success"}),false,"unknown result cannot carry a success reference");

  const rejected={outcome:"REJECTED",observedAt:"2026-10-09T12:00:00Z",outputs:[],provenance:{operationRef,observedAt:"2026-10-09T12:00:00Z",sourceRefs:[]},implementationState:"UNKNOWN",qualificationState:"NOT_EVALUATED",runtimeAvailability:"UNKNOWN"};
  const failed={...mmBase("FAILED"),operationRef,operationId:"job-1",requestId,requestFingerprint,observedAt:"2026-10-09T12:00:00Z",canonicalResult:rejected};
  assert.equal(mmSchema(failed),true,"terminal FAILED preserves the exact canonical REJECTED result");
  assert.equal(mmSchema({...failed,attemptId:"attempt-1"}),true,"terminal failure preserves an optional exact attempt identity");
  assert.equal(mmSchema({...failed,safeErrorCode:"INTERNAL_ERROR"}),false,"terminal FAILED does not add a synthetic error code");
  assert.equal(mmSchema({...failed,finalityEvidenceRef:"invented"}),false,"terminal FAILED does not add a synthetic finality reference");
  assert.equal(mmSchema({...failed,canonicalResult:{...rejected,outputs:[{artifactType:"unexpected"} ]}}),false,"terminal REJECTED result must have zero outputs");

  const observedAt="2026-10-09T12:01:00Z";
  const canonicalResult={outcome:"SUCCEEDED",observedAt,outputs:[{artifactType:"source-grounded-cross-modal-result-with-provenance-and-uncertainty",payload:{artifactId:"artifact-1",versionId:"version-1",contentSchemaRef:"media.multimodal.result-content.cross-modal.v1"}}],provenance:{operationRef,observedAt,sourceRefs:[]},implementationState:"UNKNOWN",qualificationState:"NOT_EVALUATED",runtimeAvailability:"UNKNOWN"};
  const succeeded={...mmBase("SUCCEEDED"),operationRef,operationId:"job-1",requestId,requestFingerprint,completedAt:observedAt,canonicalResult};
  assert.equal(mmSchema(succeeded),true,"success preserves one typed source-grounded artifact and canonical provenance without requiring attemptId");
  assert.equal(mmSchema({...succeeded,attemptId:"attempt-1"}),true,"success preserves an optional exact attempt identity when present");
  assert.equal(mmSchema({...succeeded,canonicalResult:{...canonicalResult,outputs:[...canonicalResult.outputs,...canonicalResult.outputs]}}),false,"success must carry exactly one output artifact");
  assert.equal(mmSchema({...succeeded,canonicalResult:{...canonicalResult,outputs:[{artifactType:"source-grounded-cross-modal-result-with-provenance-and-uncertainty",payload:{artifactId:"artifact-1"}}]}}),false,"success artifact must preserve its immutable versionId");
  assert.equal(mmSchema({...succeeded,canonicalResult:{...canonicalResult,provenance:undefined}}),false,"success must preserve source provenance");
  assert.equal(mmSchema({...succeeded,finalityEvidenceRef:"invented"}),false,"success does not invent a separate finality reference");
});
