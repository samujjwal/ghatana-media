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

test("X-05 documentation does not present text and embedding inference as a typed media modality API", (t) => {
  assert.ok(gate.mediaWork.includes("Do not map Media audio, image, video, speech or multimodal operations"));
  assert.match(readme, /generic inference API; the inspected public request contract supports text generation and embeddings and has no modality field/u);
  assert.match(readme, /Media audio, video, STT, TTS, vision, and multimodal operations remain unbound/u);
  assert.doesNotMatch(readme, /typed AI Inference gateway for multimodal reasoning/u);

  if (!existsSync(inferenceContractPath)) {
    t.skip("AI Inference sibling checkout is unavailable; API source observation cannot be revalidated");
    return;
  }

  const contract = parse(readFileSync(inferenceContractPath, "utf8"));
  const request = contract.components.schemas.InferenceRequest;
  assert.deepEqual(request.properties.type.enum, ["LLM", "EMBEDDING", "COMPLETION"]);
  assert.equal(request.properties.input.maxLength, 262144);
  assert.equal(Object.hasOwn(request.properties, "modality"), false);
  assert.deepEqual(contract.info["x-ghatana-request-families"].map(({ familyId, operationTypes }) => ({ familyId, operationTypes })), [
    { familyId: "TEXT_GENERATION", operationTypes: ["LLM", "COMPLETION"] },
    { familyId: "EMBEDDING", operationTypes: ["EMBEDDING"] },
  ]);
});
