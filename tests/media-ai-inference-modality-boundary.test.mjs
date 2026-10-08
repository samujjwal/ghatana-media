import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const observation = JSON.parse(readFileSync(resolve(root, "docs/migration/external-platform-contract-observation.json"), "utf8"));
const gate = observation.gates.find(({ id }) => id === "X-05");
const inferenceSource = gate.sourceEvidence.find(({ path }) => path === "services/ai-inference/contracts/openapi/ai-inference.yaml");
const inferenceContractPath = resolve(observation.sourceSnapshots.find(({ repository }) => repository === inferenceSource.repository).path, inferenceSource.path);
const readme = readFileSync(resolve(root, "modules/intelligence/multimodal-service/README.md"), "utf8");

test("X-05 records typed opaque media inputs without inferring Media execution or provider qualification", (t) => {
  assert.match(gate.status, /VERSIONED_TYPED_MEDIA_INPUT_CONTRACT_OBSERVED/u);
  assert.match(gate.status, /MEDIA_OPERATION_AND_PROVIDER_QUALIFICATION_UNPROVEN/u);
  assert.ok(gate.mediaWork.includes("does not authorize reference dereferencing or rights/consent"));
  assert.match(readme, /version 1\.1\.0 request schema now accepts either text input or 1–32 opaque `mediaInputs` references/u);
  assert.match(readme, /does not authorize dereferencing, establish rights or consent, or qualify a provider/u);
  assert.match(readme, /Media operations remain unbound to this API/u);
  assert.doesNotMatch(readme, /typed AI Inference gateway for multimodal reasoning/u);

  if (!existsSync(inferenceContractPath)) {
    t.skip("AI Inference sibling checkout is unavailable; API source observation cannot be revalidated");
    return;
  }

  const contract = parse(readFileSync(inferenceContractPath, "utf8"));
  const request = contract.components.schemas.InferenceRequest;
  assert.deepEqual(request.properties.type.enum, ["LLM", "EMBEDDING", "COMPLETION"]);
  assert.equal(request.properties.input.maxLength, 262144);
  assert.deepEqual(request.oneOf, [
    { required: ["input"], not: { required: ["mediaInputs"] } },
    { required: ["mediaInputs"], not: { required: ["input"] } },
  ]);
  const mediaInputs = request.properties.mediaInputs;
  assert.equal(mediaInputs.minItems, 1);
  assert.equal(mediaInputs.maxItems, 32);
  const item = mediaInputs.items;
  assert.equal(item.additionalProperties, false);
  assert.deepEqual(item.required, ["modality", "reference", "mediaType", "role", "purpose", "classification", "expiresAt"]);
  assert.deepEqual(Object.keys(item.properties), item.required);
  assert.deepEqual(item.properties.modality.enum, ["AUDIO", "VIDEO", "IMAGE"]);
  assert.deepEqual(item.properties.role.enum, ["SOURCE", "CONTEXT", "TARGET"]);
  assert.deepEqual(item.properties.classification.enum, ["PUBLIC", "INTERNAL", "CONFIDENTIAL", "RESTRICTED"]);
  assert.equal(item.properties.reference.maxLength, 512);
  assert.match(item.properties.reference.pattern, /sha256:\[0-9a-f\]\{64\}/u);
  assert.equal(item.properties.mediaType.maxLength, 127);
  assert.equal(item.properties.expiresAt.format, "date-time");
  assert.equal(item.allOf.length, 3);
  assert.match(mediaInputs.description, /do not authorize dereferencing[\s\S]*Raw bytes and data URLs are not accepted/u);
  assert.deepEqual(contract.info["x-ghatana-request-families"].map(({ familyId, operationTypes }) => ({ familyId, operationTypes })), [
    { familyId: "TEXT_GENERATION", operationTypes: ["LLM", "COMPLETION"] },
    { familyId: "EMBEDDING", operationTypes: ["EMBEDDING"] },
  ]);
});
