import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { analyzeTypedContractBindings } from "../scripts/check-media-contract-parity.mjs";

const read = (p) => readFileSync(new URL(`../${p}`, import.meta.url), "utf8");
const typedSource = read("libs/audio-video-types/src/contracts.ts");
const typeNames = [...typedSource.matchAll(/^export type (\w+)\s*=/gm)].map((x) => x[1]);
const schemaNames = [...typedSource.matchAll(/^export const (\w+)Schema\s*=/gm)].map((x) => x[1]);
const sourceManifest = JSON.parse(read(".product-experience/interface-parity/typed-contract-bindings.json")).legacySourceRoleManifest;
const inputs = {
  typeNames, schemaNames, typedContractBindings: sourceManifest,
  domainObjectSource: read(".product-experience/pdp-1-domain-data/domain-objects.yaml"),
  stateModelSource: read(".product-experience/pdp-0-product-truth/state-models.yaml"),
  operationSource: read(".product-experience/pdp-1-domain-data/operations.yaml"),
};
const cloned = () => structuredClone(sourceManifest);

test("every publicly exported TS type and schema has one explicit and source-grounded role", () => {
  const failures = analyzeTypedContractBindings(inputs);
  assert.deepEqual(failures, [], failures.join("\n"));
  assert.equal(new Set(typeNames).size, 19);
  assert.equal(new Set(schemaNames).size, 20);
});

test("new exported type requires a new role binding", () => {
  const errors = analyzeTypedContractBindings({ ...inputs, typeNames: [...typeNames, "UnmappedNewType"] });
  assert.ok(errors.some((x) => x.includes("UnmappedNewType")));
});

test("typos in canonical operation and machine identities fail", () => {
  const changed = cloned();
  changed.bindings.find((x) => x.type === "TranscriptionRequest").semanticRef = "media.operation.fake";
  changed.bindings.find((x) => x.type === "MediaJobState").semanticRef = "media-fake";
  const errors = analyzeTypedContractBindings({ ...inputs, typedContractBindings: changed });
  assert.ok(errors.some((x) => x.includes("TranscriptionRequest")));
  assert.ok(errors.some((x) => x.includes("MediaJobState")));
});

test("no undeclared or reused schema role can hide source inventory drift", () => {
  const changed = cloned();
  changed.bindings.find((x) => x.type === "UploadSession").schema = "MediaArtifactSchema";
  changed.schemaOnly = [];
  const errors = analyzeTypedContractBindings({ ...inputs, typedContractBindings: changed });
  assert.ok(errors.some((x) => x.includes("schema reused ambiguously")));
  assert.ok(errors.some((x) => x.includes("MultimodalSourceSchema")));
});

test("specialized unadmitted model operations cannot masquerade as accepted canonical operations", () => {
  const changed = cloned();
  changed.bindings.find((x) => x.type === "VoiceTrainingRequest").semanticRef = "media.operation.synthesis";
  const errors = analyzeTypedContractBindings({ ...inputs, typedContractBindings: changed });
  assert.ok(errors.some((x) => x.includes("unadmitted")));
});
