import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const parity = readYaml(".product-experience/interface-parity/operation-parity.yaml");
const operations = readYaml(".product-experience/pdp-1-domain-data/operations.yaml");
const methods = parity.typedGrpcMethodContracts;
const canonical = operations.ownerDefinedOperationContracts.records;

const expected = new Map([
  ["STTService.CreateProfile", { id: "media.operation.stt.profile.create.v1", adapterId: "media.interface-adapter.stt-profile-create.v1", role: "DOMAIN_COMMAND", required: ["enrollmentSamples", "consentRef", "requestId"] }],
  ["STTService.GetProfile", { id: "media.operation.stt.profile.get.v1", adapterId: "media.interface-adapter.stt-profile-get.v1", role: "DOMAIN_QUERY", required: ["profileVersionId", "tenantId", "principalId"] }],
  ["STTService.UpdateProfile", { id: "media.operation.stt.profile.update.v1", adapterId: "media.interface-adapter.stt-profile-update.v1", role: "DOMAIN_COMMAND", required: ["expectedProfileVersionId", "requestId", "tenantId", "principalId"] }],
  ["STTService.AdaptModel", { id: "media.operation.stt.profile.adapt.v1", adapterId: "media.interface-adapter.stt-profile-adapt.v1", role: "DOMAIN_COMMAND", required: ["expectedProfileVersionId", "consentRef", "requestId", "sourceTextRef", "userConfirmed"] }],
]);

function validateAdapter(record, expectedRecord, contract) {
  const adapter = record.mediaOwnerSemanticAdapter;
  assert.ok(adapter, `${record.identity} has a source-specific owner adapter disposition`);
  assert.equal(adapter.id, expectedRecord.adapterId);
  assert.equal(adapter.ownerOperationRef, `.product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts.records/@id=${expectedRecord.id}`);
  assert.equal(adapter.observedSourceRole, expectedRecord.role);
  assert.match(adapter.disposition, /^OWNER_DEFINED_ADAPTER_REQUIRED;/u);
  assert.match(adapter.canonicalWireEquivalence, /^NOT_ESTABLISHED(?:;|$)/u);
  assert.equal(adapter.runtimeAdmission, "NOT_ADMITTED");
  assert.ok(adapter.ownerIntent.trim().length > 0);
  const fields = new Set([
    ...(record.inputFieldInventory?.fields ?? []).map(({ name }) => `input.${name}`),
    ...(record.outputFieldInventory?.fields ?? []).map(({ name }) => `output.${name}`),
  ]);
  for (const field of fields) assert.ok(Object.hasOwn(adapter.sourceFieldDisposition, field), `${record.identity} dispositions include exact source field ${field}`);
  for (const [field, disposition] of Object.entries(adapter.sourceFieldDisposition)) {
    assert.ok(fields.has(field), `${record.identity} does not invent a source-field alias ${field}`);
    assert.equal(typeof disposition, "string");
    assert.ok(disposition.trim().length > 0, `${record.identity} gives ${field} a material disposition`);
  }
  const ownerText = JSON.stringify(contract);
  for (const field of expectedRecord.required) assert.ok(ownerText.includes(field), `${record.identity} owner schema requires ${field}`);
  for (const missing of adapter.missingLegacyFields) assert.ok(missing.trim().length > 0);
  const dispositionText = JSON.stringify(adapter.sourceFieldDisposition);
  if (record.identity === "STTService.CreateProfile") {
    assert.match(dispositionText, /does not pass them to engine profile creation/u);
    assert.match(dispositionText, /Raw repeated bytes are not the required immutable sample references/u);
  }
  if (record.identity === "STTService.GetProfile") assert.match(dispositionText, /unversioned lookup/u);
  if (record.identity === "STTService.UpdateProfile") assert.match(dispositionText, /preferred language only/u);
  if (record.identity === "STTService.AdaptModel") assert.match(dispositionText, /corrected_transcript text only/u);
}

test("four STT profile RPCs have exact Media semantic owners and explicit non-equivalent legacy fields", () => {
  assert.equal(expected.size, 4);
  for (const [identity, expectedRecord] of expected) {
    const record = methods.find((entry) => entry.identity === identity);
    const contract = canonical.find((entry) => entry.id === expectedRecord.id);
    assert.ok(record, `${identity} is retained in the source identity census`);
    assert.ok(contract, `${expectedRecord.id} is a canonical Media-owned definition`);
    assert.equal(record.role, expectedRecord.role, "source identity role is distinct from canonical wire equivalence");
    assert.equal(record.bindingStatus, "OWNER_ADAPTER_REQUIRED", "definition exists while exact legacy wire projection remains unbound");
    validateAdapter(record, expectedRecord, contract);
  }
  const grpc = parity.surfaces.find(({ surface }) => surface === "gRPC");
  assert.deepEqual(grpc.ownerAdapterRequired.STTService, ["AdaptModel", "CreateProfile", "GetProfile", "UpdateProfile"]);
  assert.deepEqual(grpc.unresolved.STTService, [], "all source roles are explicit even though wire adapter parity is unresolved");
});

test("profile adapter dispositions fail when a material field, source effect, or exact owner ref is removed", () => {
  for (const [identity, expectedRecord] of expected) {
    const original = methods.find((entry) => entry.identity === identity);
    const contract = canonical.find((entry) => entry.id === expectedRecord.id);
    const mutation = structuredClone(original);
    mutation.mediaOwnerSemanticAdapter.ownerOperationRef = "some similarly named profile method";
    assert.throws(() => validateAdapter(mutation, expectedRecord, contract));
    const sourceDrop = structuredClone(original);
    const field = Object.keys(sourceDrop.mediaOwnerSemanticAdapter.sourceFieldDisposition)[0];
    delete sourceDrop.mediaOwnerSemanticAdapter.sourceFieldDisposition[field];
    assert.throws(() => validateAdapter(sourceDrop, expectedRecord, contract));
    const admissionMutation = structuredClone(original);
    admissionMutation.mediaOwnerSemanticAdapter.runtimeAdmission = "ADMITTED";
    assert.throws(() => validateAdapter(admissionMutation, expectedRecord, contract));
  }
  const create = structuredClone(methods.find(({ identity }) => identity === "STTService.CreateProfile"));
  create.mediaOwnerSemanticAdapter.sourceFieldDisposition["input.settings"] = "settings are applied";
  assert.throws(() => validateAdapter(create, expected.get("STTService.CreateProfile"), canonical.find(({ id }) => id === expected.get("STTService.CreateProfile").id)));
});
