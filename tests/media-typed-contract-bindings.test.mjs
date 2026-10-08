import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const manifestPath = ".product-experience/interface-parity/typed-contract-bindings.json";
const contractsPath = "libs/audio-video-types/src/contracts.ts";
const clientOperationsPath = "libs/audio-video-client/src/operations.ts";
const domainObjectsPath = ".product-experience/pdp-1-domain-data/domain-objects.yaml";
const operationsPath = ".product-experience/pdp-1-domain-data/operations.yaml";

const sourceText = () => readFileSync(contractsPath, "utf8");
const clientOperationsText = () => readFileSync(clientOperationsPath, "utf8");
const catalogIds = (text) => new Set([...text.matchAll(/^  - id: (media\.(?:domain|operation)\.[^\s]+)$/gmu)].map((match) => match[1]));
const typeNames = (source) => [...source.matchAll(/^export type (\w+)\s*=/gmu)].map((match) => match[1]);
const schemaNames = (source) => [...source.matchAll(/^export const (\w+)Schema\s*=/gmu)].map((match) => `${match[1]}Schema`);
const enumValues = (source) => {
  const body = source.match(/^export const MediaOperationKindSchema = z\.enum\(\[([\s\S]*?)\]\);/mu)?.[1] ?? "";
  return [...body.matchAll(/^\s*"([A-Z_]+)",?\s*$/gmu)].map((match) => match[1]);
};

function validateManifest(manifest, source, validPdp1Ids) {
  const errors = [];
  const types = typeNames(source);
  const schemas = schemaNames(source);
  const entries = manifest.bindings ?? [];
  const allowedRoles = new Set([
    "DOMAIN_VALUE_PROJECTION", "DOMAIN_RECORD_PROJECTION", "DOMAIN_RECORD_AND_OPERATION_PROJECTION",
    "OPERATION_KIND_ENUM_PROJECTION", "DOMAIN_STATE_PROJECTION", "COMPATIBILITY_ADAPTER",
    "CAPABILITY_PROJECTION", "DOMAIN_OPERATION_INPUT_PROJECTION", "DOMAIN_OPERATION_RESULT_PROJECTION",
    "DOMAIN_OPERATION_INPUT_COMPONENT", "DOMAIN_OPERATION_ACKNOWLEDGEMENT_PROJECTION", "NOT_ADMITTED",
  ]);
  const allowedStatuses = new Set(["PROPOSAL_ROLE_ONLY", "COMPATIBILITY_SOURCE_ONLY", "NOT_ADMITTED"]);
  const schemaIds = entries.map((entry) => entry.schema);
  const typeIds = entries.flatMap((entry) => entry.type == null ? [] : [entry.type]);
  const duplicate = (items) => [...new Set(items.filter((item, index) => items.indexOf(item) !== index))];

  for (const id of duplicate(schemaIds)) errors.push(`duplicate schema binding: ${id}`);
  for (const id of duplicate(typeIds)) errors.push(`duplicate type binding: ${id}`);
  for (const id of schemas) if (!schemaIds.includes(id)) errors.push(`missing schema binding: ${id}`);
  for (const id of schemaIds) if (!schemas.includes(id)) errors.push(`stale schema binding: ${id}`);
  for (const id of types) if (!typeIds.includes(id)) errors.push(`missing type binding: ${id}`);
  for (const id of typeIds) if (!types.includes(id)) errors.push(`stale type binding: ${id}`);

  for (const entry of entries) {
    if (!allowedRoles.has(entry.role)) errors.push(`${entry.schema}: unsupported role ${entry.role}`);
    if (!allowedStatuses.has(entry.bindingStatus)) errors.push(`${entry.schema}: unsupported binding status ${entry.bindingStatus}`);
    const expectedType = entry.schema === "MultimodalSourceSchema" ? null : entry.schema.replace(/Schema$/u, "");
    if (entry.type !== expectedType) errors.push(`${entry.schema}: type must pair with ${expectedType ?? "no exported type"}`);
    if (!Array.isArray(entry.pdp1Refs)) errors.push(`${entry.schema}: pdp1Refs must be an array`);
    for (const ref of entry.pdp1Refs ?? []) {
      if (!validPdp1Ids.has(ref)) errors.push(`${entry.schema}: unsupported PDP-1 reference ${ref}`);
    }
    if (entry.runtimeSupport !== false) errors.push(`${entry.schema}: runtime support must remain explicitly false`);
    if (entry.role === "NOT_ADMITTED" || entry.bindingStatus === "NOT_ADMITTED") {
      if (entry.pdp1Refs?.length) errors.push(`${entry.schema}: NOT_ADMITTED entry has PDP-1 refs`);
      if (entry.role !== "NOT_ADMITTED" || entry.bindingStatus !== "NOT_ADMITTED") errors.push(`${entry.schema}: NOT_ADMITTED disposition is inconsistent`);
    }
  }
  for (const schema of ["VoiceTrainingRequestSchema", "VoiceConversionRequestSchema", "MediaCanonicalErrorSchema"]) {
    const entry = entries.find((candidate) => candidate.schema === schema);
    if (entry && (entry.role !== "NOT_ADMITTED" || entry.bindingStatus !== "NOT_ADMITTED" || entry.pdp1Refs?.length)) {
      errors.push(`${schema}: source contract must remain NOT_ADMITTED`);
    }
  }

  if (manifest.denominators?.exportedTypes !== types.length) errors.push(`exported type denominator must be ${types.length}`);
  if (manifest.denominators?.publicSchemas !== schemas.length) errors.push(`public schema denominator must be ${schemas.length}`);
  if (manifest.runtimeSupportImplied !== false) errors.push("catalog must not imply runtime support");
  if (manifest.semanticOperationParity !== "UNRESOLVED") errors.push("semantic operation parity must remain independent and unresolved");
  if (manifest.wireParity !== "UNRESOLVED") errors.push("wire parity must remain independent and unresolved");

  const enumBinding = entries.find((entry) => entry.schema === "MediaOperationKindSchema");
  const dispositions = enumBinding?.operationValueDispositions ?? [];
  const enumIds = dispositions.map((item) => item.value);
  for (const id of duplicate(enumIds)) errors.push(`duplicate operation value disposition: ${id}`);
  for (const value of enumValues(source)) if (!enumIds.includes(value)) errors.push(`missing operation value disposition: ${value}`);
  for (const value of enumIds) if (!enumValues(source).includes(value)) errors.push(`stale operation value disposition: ${value}`);
  for (const item of dispositions) {
    if (["SEPARATE_STEMS", "TRAIN_VOICE_MODEL", "CONVERT_VOICE", "EXPORT", "DELETE"].includes(item.value)
      && (item.disposition !== "NOT_ADMITTED" || item.pdp1Ref)) {
      errors.push(`${item.value}: specialized operation must remain NOT_ADMITTED`);
    }
    if (item.disposition === "NOT_ADMITTED" && item.pdp1Ref) errors.push(`${item.value}: non-admitted operation has PDP-1 ref`);
    if (item.disposition !== "NOT_ADMITTED" && (!item.pdp1Ref || !validPdp1Ids.has(item.pdp1Ref))) {
      errors.push(`${item.value}: supported proposal value lacks a valid PDP-1 operation ref`);
    }
  }
  return errors;
}

const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const source = sourceText();
const pdp1Ids = new Set([
  ...catalogIds(readFileSync(domainObjectsPath, "utf8")),
  ...catalogIds(readFileSync(operationsPath, "utf8")),
]);

test("typed contract binding catalog exhaustively covers source roles without implying support", () => {
  assert.deepEqual(typeNames(source).length, 19);
  assert.deepEqual(schemaNames(source).length, 20);
  assert.deepEqual(validateManifest(manifest, source, pdp1Ids), []);
  assert.equal(manifest.bindings.filter((entry) => entry.type == null).length, 1);
  assert.equal(manifest.bindings.find((entry) => entry.type == null)?.schema, "MultimodalSourceSchema");
});

test("catalog negative checks reject duplicate and stale schema identities", () => {
  const duplicate = structuredClone(manifest);
  duplicate.bindings.push({ ...duplicate.bindings[0] });
  assert.ok(validateManifest(duplicate, source, pdp1Ids).some((error) => error.includes("duplicate schema binding")));

  const stale = structuredClone(manifest);
  stale.bindings[0].schema = "RemovedSchema";
  assert.ok(validateManifest(stale, source, pdp1Ids).some((error) => error.includes("stale schema binding: RemovedSchema")));
  assert.ok(validateManifest(stale, source, pdp1Ids).some((error) => error.includes("missing schema binding: MediaClassificationSchema")));

  const duplicateType = structuredClone(manifest);
  duplicateType.bindings[1].type = duplicateType.bindings[0].type;
  assert.ok(validateManifest(duplicateType, source, pdp1Ids).some((error) => error.includes("duplicate type binding")));
});

test("catalog negative checks reject unsupported PDP-1 references and missing new bindings", () => {
  const unsupportedRef = structuredClone(manifest);
  unsupportedRef.bindings[0].pdp1Refs.push("media.operation.not-in-pdp1");
  assert.ok(validateManifest(unsupportedRef, source, pdp1Ids).some((error) => error.includes("unsupported PDP-1 reference")));

  const futureSource = `${source}\nexport const NewlyAddedSchema = z.string();\nexport type NewlyAdded = z.infer<typeof NewlyAddedSchema>;\n`;
  assert.ok(validateManifest(manifest, futureSource, pdp1Ids).some((error) => error.includes("missing schema binding: NewlyAddedSchema")));
  assert.ok(validateManifest(manifest, futureSource, pdp1Ids).some((error) => error.includes("missing type binding: NewlyAdded")));
});

test("catalog negative checks prevent admission of specialized unqualified operations", () => {
  for (const schema of ["VoiceTrainingRequestSchema", "VoiceConversionRequestSchema"]) {
    const admitted = structuredClone(manifest);
    const entry = admitted.bindings.find((binding) => binding.schema === schema);
    entry.role = "DOMAIN_OPERATION_INPUT_PROJECTION";
    entry.bindingStatus = "PROPOSAL_ROLE_ONLY";
    entry.pdp1Refs = ["media.operation.synthesis"];
    assert.ok(validateManifest(admitted, source, pdp1Ids).some((error) => error.includes(`${schema}: source contract must remain NOT_ADMITTED`)));
  }

  const values = structuredClone(manifest);
  const specialized = values.bindings.find((binding) => binding.schema === "MediaOperationKindSchema")
    .operationValueDispositions.find((item) => item.value === "TRAIN_VOICE_MODEL");
  specialized.disposition = "PROPOSAL_REF_ONLY";
  specialized.pdp1Ref = "media.operation.synthesis";
  assert.ok(validateManifest(values, source, pdp1Ids).some((error) => error.includes("TRAIN_VOICE_MODEL: specialized operation must remain NOT_ADMITTED")));
});

test("client contract imports resolve to the same catalog without upgrading legacy routes", () => {
  const clientSource = clientOperationsText();
  const importBlock = clientSource.match(/import\s*\{([\s\S]*?)\}\s*from\s*["']@audio-video\/types\/contracts["'];/u)?.[1];
  assert.ok(importBlock, "client operations must import its public contracts from the shared type module");
  const imported = [...importBlock.matchAll(/^\s*(type\s+)?([A-Za-z_]\w*)\s*,?\s*$/gmu)]
    .map((match) => ({ kind: match[1] ? "type" : "schema", id: match[2] }));
  const sourceTypes = new Set(typeNames(source));
  const sourceSchemas = new Set(schemaNames(source));
  const duplicateIds = imported.filter((entry, index) => imported.findIndex((other) => other.id === entry.id) !== index);
  assert.deepEqual(duplicateIds, [], "client import identities must not be duplicated");
  for (const entry of imported) {
    assert.ok(entry.kind === "type" ? sourceTypes.has(entry.id) : sourceSchemas.has(entry.id), `${entry.id} must exist in the shared source contract`);
    const binding = manifest.bindings.find((candidate) => candidate[entry.kind] === entry.id);
    assert.ok(binding, `${entry.id} must have one typed-catalog binding`);
  }

  const parity = readFileSync(".product-experience/interface-parity/operation-parity.yaml", "utf8");
  for (const [method, path] of [
    ["trainVoiceModel", "/api/v1/media/voice-models:train"],
    ["convertVoice", "/api/v1/media/voice-conversions"],
  ]) {
    const sdkId = `media.sdk.${method}`;
    const sdkEntry = parity.split(`- identity: ${sdkId}\n`)[1]?.split("\n- identity: ")[0];
    assert.ok(sdkEntry, `${sdkId} must retain its source disposition`);
    assert.match(sdkEntry, /type: NOT_ADMITTED/u);
    assert.match(sdkEntry, /openApiBindingDisposition: NOT_ADMITTED/u);
    assert.match(clientSource, new RegExp(`public ${method}\\(`, "u"));
    assert.ok(parity.includes(`path: '${path}'`), `${path} must remain visible as a legacy compatibility finding`);
  }
});
