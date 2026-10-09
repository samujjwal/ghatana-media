import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const file = ".product-experience/pdp-2-design-interface-system/media-editing-grammar.yaml";
const source = parse(readFileSync(resolve(root, file), "utf8"));
const rule = source.exactContentOverlayRule;

test("exact content uses versioned approved source bindings and deterministic composition", () => {
  assert.equal(rule.id, "media.design.exact-content-overlay.v1");
  assert.deepEqual(rule.appliesTo, [
    "logos-and-brand-marks", "captions-and-subtitles", "legal-copy", "mathematics-and-equations",
    "user-interface-screenshots", "diagrams", "product-labels",
  ]);
  assert.deepEqual(rule.sourceBinding.required, [
    "exactSourceOrApprovedAssetRef", "immutableVersion", "rightsAndUseScope", "localeWhenTextual", "ownerApprovalWhenRequired",
  ]);
  assert.match(rule.sourceBinding.identity, /generative output or visual resemblance is not an authoritative source/u);
  assert.match(rule.composition.method, /declared typography, layout, timing, and output-profile parameters/u);
  assert.ok(rule.composition.prohibit.includes("model-authored-or-rewritten-exact-copy"));
  assert.ok(rule.composition.prohibit.includes("unapproved-equation-reconstruction"));
  assert.match(rule.composition.unknownBehavior, /block the affected composition branch/u);
  assert.match(rule.translationAndDubbing.authority, /duration or timing fit never authorizes mistranslation/u);
  assert.deepEqual(rule.nonClaims, ["no-runtime-rendering-proof", "no-license-clearance", "no-human-meaning-approval", "no-phase-acceptance"]);
  assert.equal(rule.acceptanceEffect, "none");
  assert.equal(rule.status, "OWNER_DEFINED_DESIGN_RULE; rendering and owner review evidence remain separate");
  assert.deepEqual(source.normativeRuleRecords, [{
    id: "media.p2.rule.exact-content-overlay.v1",
    ruleRef: `${file}#exactContentOverlayRule`,
    sourceAuthority: `${file}#authority`,
    acceptanceEffect: "none",
  }]);
});

test("material weakening of exact-content identity, owner authority, or translation review is rejected", () => {
  const valid = (candidate) => candidate.id === "media.design.exact-content-overlay.v1"
    && candidate.appliesTo.length === 7
    && ["logos-and-brand-marks", "captions-and-subtitles", "legal-copy", "mathematics-and-equations", "user-interface-screenshots", "diagrams", "product-labels"].every((item) => candidate.appliesTo.includes(item))
    && ["exactSourceOrApprovedAssetRef", "immutableVersion", "rightsAndUseScope", "localeWhenTextual", "ownerApprovalWhenRequired"].every((field) => candidate.sourceBinding.required.includes(field))
    && candidate.composition.prohibit.includes("model-authored-or-rewritten-exact-copy")
    && candidate.composition.prohibit.includes("unapproved-equation-reconstruction")
    && /not an authoritative source/u.test(candidate.sourceBinding.identity)
    && /never authorizes mistranslation/u.test(candidate.translationAndDubbing.authority)
    && candidate.status.includes("OWNER_DEFINED_DESIGN_RULE");

  const lostAuthority = structuredClone(rule);
  lostAuthority.sourceBinding.required = lostAuthority.sourceBinding.required.filter((field) => field !== "ownerApprovalWhenRequired");
  assert.equal(valid(lostAuthority), false, "owner approval cannot be omitted from the exact-source binding contract");

  const generatedLegalCopy = structuredClone(rule);
  generatedLegalCopy.composition.prohibit = generatedLegalCopy.composition.prohibit.filter((item) => item !== "model-authored-or-rewritten-exact-copy");
  assert.equal(valid(generatedLegalCopy), false, "model-authored text cannot be treated as exact approved copy");

  const missingDiagram = structuredClone(rule);
  missingDiagram.appliesTo = missingDiagram.appliesTo.filter((item) => item !== "diagrams");
  assert.equal(valid(missingDiagram), false, "the finite protected-content population is complete");

  const durationAuthority = structuredClone(rule);
  durationAuthority.translationAndDubbing.authority = "Duration fit authorizes translation approval.";
  assert.equal(valid(durationAuthority), false, "timing fit cannot replace human or domain meaning approval");
});
