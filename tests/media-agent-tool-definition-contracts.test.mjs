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
const root = process.cwd();
const readYaml = (path) => parse(readFileSync(path, "utf8"));
const conventions = () => readYaml(conventionsPath);
const registry = () => readYaml(registryPath);
const expected = new Map([
  ["av.speech-to-text", ["media.agent-tool-contract.speech-to-text.v1", "media.operation.transcription", "media.operation.transcription-submission", "operations/@id=media.operation.transcription-submission"]],
  ["av.text-to-speech", ["media.agent-tool-contract.text-to-speech.v1", "media.operation.synthesis", "media.operation.capability.media-speech-synthesis-text-to-speech", "capabilityOperationContracts/records/@id=media.operation.capability.media-speech-synthesis-text-to-speech"]],
  ["av.vision-analysis", ["media.agent-tool-contract.vision-analysis.v1", "media.operation.vision-analysis", "media.operation.capability.media-vision-detect", "capabilityOperationContracts/records/@id=media.operation.capability.media-vision-detect"]],
  ["av.multimodal-inference", ["media.agent-tool-contract.multimodal-inference.v1", "media.operation.multimodal-analysis", "media.operation.capability.media-multimodal-analyze-cross-modal", "capabilityOperationContracts/records/@id=media.operation.capability.media-multimodal-analyze-cross-modal"]],
]);

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
    const [contractId, familyRef, operationId, selector] = tuple;
    const contract = contracts.find((item) => item.id === contractId);
    if (!contract) { errors.push(`${toolId}: missing ${contractId}`); continue; }
    const sourceOperation = resolveSourceRef(`.product-experience/pdp-1-domain-data/operations.yaml#${selector}`);
    if (!sourceOperation || sourceOperation.id !== operationId) errors.push(`${toolId}: canonical operation record selector does not resolve exactly`);
    if (contract.toolId !== toolId || contract.operationFamilyRef !== familyRef || contract.canonicalOperationRef !== `.product-experience/pdp-1-domain-data/operations.yaml#${selector}`) errors.push(`${toolId}: identity/canonical operation mismatch`);
    if (contract.operationBindingStatus !== "OWNER_DEFINED_OPERATION_CANDIDATE; adapter mapping and runtime admission pending") errors.push(`${toolId}: candidate binding promoted`);
    if (contract.runtimeAdmission !== "NOT_ADMITTED") errors.push(`${toolId}: runtime admission promoted`);
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
    if (success) {
      const payload = success.properties?.canonicalPayload;
      for (const field of ["attemptId", "operationId", "canonicalPayload"]) if (!success.required?.includes(field)) errors.push(`${toolId}: success omits required ${field}`);
      for (const field of ["payloadTypeRef", "payloadSchemaRef", "subjectObjectRef", "subjectVersionRef", "producerRef", "profileRef", "profileVersionRef", "provenanceRef", "evidenceRefs", "observedAt"]) if (!payload?.required?.includes(field)) errors.push(`${toolId}: success payload omits ${field}`);
    }
    const fields = new Set(Object.keys(contract.inputSchema?.properties ?? {}));
    for (const forbidden of ["tenantId", "principalId", "delegation", "policyDecision", "idempotencyKey", "deadline", "cancellationToken"]) if (fields.has(forbidden)) errors.push(`${toolId}: trusted context field ${forbidden} must not be model supplied`);
    for (const ref of contract.authorityRefs ?? []) if (!resolveSourceRef(ref)) errors.push(`${toolId}: authority source reference does not resolve: ${ref}`);
    for (const ref of [contract.canonicalOperationRef, contract.requestAdapter?.canonicalContractRef]) if (!resolveSourceRef(ref)) errors.push(`${toolId}: canonical source reference does not resolve: ${ref}`);
    const requestSource = resolveSourceRef(contract.requestAdapter?.canonicalContractRef);
    if (!requestSource || typeof requestSource !== "object") errors.push(`${toolId}: exact canonical request schema selector does not resolve`);
    const registryTool = (registry().tools ?? []).find((item) => item.id === toolId);
    if (!registryTool || registryTool.mediaDefinitionContractRef !== `.product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml#mediaOwnedToolDefinitionContracts/contracts/@id=${contractId}`) errors.push(`${toolId}: registry contract ref mismatch`);
    if (registryTool?.operationBinding?.value !== operationId || registryTool.operationBinding.status !== "owner-defined-operation-candidate; adapter-mapping-and-runtime-pending") errors.push(`${toolId}: registry binding scope mismatch`);
    if (registryTool?.executionAdmitted !== false || contract.requestAdapter?.status !== "NOT_IMPLEMENTED" || contract.resultAdapter?.status !== "NOT_IMPLEMENTED") errors.push(`${toolId}: candidate admission/adapter boundary promoted`);
  }
  return errors;
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
  const tuple={principalRef:"principal:1",tenantRef:"tenant:1",delegationChainRef:"delegation:1",purposeRef:"purpose:transcription",resourceBindings:[{objectRef:"media.domain.artifact",versionRef:"artifact-version:1",tenantRef:"tenant:1",purposeRef:"purpose:transcription",authorityDecisionRef:"decision:1",decision:"AUTHORIZED",evidenceRef:"evidence:1",observedAt:"2026-10-09T12:00:00Z",validUntil:"2026-10-09T13:00:00Z"}],invocationId:"invocation:1",deadline:"2026-10-09T12:30:00Z",idempotencyDisposition:"REQUIRED_SCOPED_KEY",idempotencyKeyRef:"key:1",cancellationRef:"cancel:1"};
  const tupleValid=(x,now="2026-10-09T12:01:00Z")=>check(x)&&x.resourceBindings.every(b=>b.tenantRef===x.tenantRef&&b.purposeRef===x.purposeRef&&b.decision==="AUTHORIZED"&&Date.parse(b.observedAt)<=Date.parse(now)&&Date.parse(now)<Date.parse(b.validUntil));
  assert.equal(tupleValid(tuple),true);
  assert.equal(check({...tuple,resourceBindings:[{...tuple.resourceBindings[0],decision:"DENIED"}]}),false,"denied resource tuples are not invocation context");
  assert.equal(check({...tuple,deadline:"2026-02-31T12:30:00Z"}),false,"host deadline uses a validated date-time");
  assert.equal(check({...tuple,idempotencyDisposition:"READ_ONLY_NO_KEY",idempotencyKeyRef:"key:1"}),false,"read-only calls cannot carry mutation idempotency keys");
  assert.equal(check({...tuple,idempotencyDisposition:"REQUIRED_SCOPED_KEY",idempotencyKeyRef:undefined}),false,"effectful calls require a scoped key");
  assert.equal(tupleValid({...tuple,resourceBindings:["artifact:1"]}),false);
  assert.equal(tupleValid({...tuple,resourceBindings:[{...tuple.resourceBindings[0],tenantRef:"tenant:other"}]}),false);
  assert.equal(tupleValid({...tuple,resourceBindings:[{...tuple.resourceBindings[0],decision:"UNKNOWN"}]}),false);
  assert.equal(tupleValid({...tuple,resourceBindings:[{...tuple.resourceBindings[0],validUntil:"2026-10-09T12:00:00Z"}]}),false);
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
  for(const c of conventions().mediaOwnedToolDefinitionContracts.contracts.filter(c=>c.toolId!=="av.speech-to-text")){
    const schema=compile(c.resultSchema), success=c.resultSchema.oneOf.find(b=>b.properties?.outcome?.const==="SUCCEEDED");
    const op=success.properties.operationRef.const;
    const payload={payloadTypeRef:"media.typed-output.example",payloadSchemaRef:"schema:typed-output:v1",payloadRef:"payload:1",subjectObjectRef:"media.domain.artifact",subjectVersionRef:"artifact-version:1",producerRef:"producer:1",profileRef:"profile:1",profileVersionRef:"profile-version:1",provenanceRef:"provenance:1",evidenceRefs:["evidence:1"],observedAt:"2026-10-09T12:00:00Z"};
    const good={...baseFor(c,"SUCCEEDED"),operationRef:op,operationId:"op-1",attemptId:"attempt-1",completedAt:"2026-10-09T12:01:00Z",finalityEvidenceRef:"finality:1",canonicalPayload:payload};
    assert.equal(schema(good),true,`${c.toolId}: typed result identity/provenance/finality accepted`);
    assert.equal(schema({...good,canonicalPayload:{...payload,subjectVersionRef:undefined}}),false,`${c.toolId}: result without exact subject version rejected`);
    assert.equal(schema({...good,canonicalPayload:{...payload,provenanceRef:undefined}}),false,`${c.toolId}: result without provenance rejected`);
    assert.equal(schema({...good,attemptId:undefined}),false,`${c.toolId}: completed result without attempt evidence rejected`);
  }
});
