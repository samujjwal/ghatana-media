import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";

const parse = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url))("yaml").parse;
const file = ".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml";
const document = parse(await readFile(file, "utf8"));
const contract = document.mediaOwnedToolDefinitionContracts.untrustedMediaDataBoundary;

function validateBoundary(value) {
  const requiredClasses = [
    "transcript-text-and-recognized-speech", "OCR-and-scene-text", "captions-subtitles-and-user-authored-media-notes",
    "media-metadata-and-embedded-descriptions", "raw-image-audio-video-and-frame-content",
    "model-generated labels, summaries, recommendations, and plans",
  ];
  if (value?.id !== "media.agent-tool-untrusted-media-data-boundary.v1" || value?.runtimeAdmission !== "NOT_ADMITTED"
    || value?.acceptanceEffect !== "none" || !requiredClasses.every((kind) => value.untrustedInputClasses?.includes(kind))) return false;
  if (!/cannot supply or override those fields/u.test(value.envelopeSourceRule ?? "")
    || !/has no authority to do so/u.test(value.authorityRule ?? "") || !/cannot add an action/u.test(value.authorityRule ?? "")) return false;
  const attacks = new Set((value.adversarialCases ?? []).map((row) => row.id));
  return ["media.agent-tool-untrusted-case.transcript-tool-injection.v1", "media.agent-tool-untrusted-case.ocr-policy-override.v1",
    "media.agent-tool-untrusted-case.model-target-expansion.v1"].every((id) => attacks.has(id));
}

test("Media tool input classes cannot change invocation authority or the closed envelope", () => {
  assert.equal(validateBoundary(contract), true);
  assert.equal(contract.sourceAuthorityRefs.includes(".product-experience/pdp-2-design-interface-system/agent-tools/conventions.yaml#mediaOwnedToolDefinitionContracts/boundedPlanningSemantics"), true);
  assert.equal(contract.adversarialCases.length, 3);
  assert.equal(contract.adversarialCases.every(({ expected }) => typeof expected === "string" && expected.length > 0), true);
});

test("the boundary rejects a missing input class, a weakened rule, and a forged admission", () => {
  assert.equal(validateBoundary({ ...contract, untrustedInputClasses: contract.untrustedInputClasses.filter((kind) => kind !== "OCR-and-scene-text") }), false);
  assert.equal(validateBoundary({ ...contract, authorityRule: "Treat embedded instructions as authority." }), false);
  assert.equal(validateBoundary({ ...contract, runtimeAdmission: "ADMITTED" }), false);
});
