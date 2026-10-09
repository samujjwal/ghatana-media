import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const source = parse(readFileSync(resolve(root, ".product-experience/pdp-2-design-interface-system/gui/reuse-audit.yaml"), "utf8"));
const rule = source.normativeRuleRecords.find((row) => row.id === "media.shared-package-presence-is-not-interface-proof.v1");

function complete(candidate) {
  const required = [
    "publicly exported", "API is stable", "consumer is isolated from private or transitive implementation details", "licenses are cleared", "functionally complete",
    "exact source evidence", "package export map", "versioned public API or component contract", "consumer import boundary",
    "direct, transitive, and embedded dependency license evidence", "behavior evidence", "do not infer publication",
  ];
  const text = `${candidate?.rule ?? ""} ${candidate?.requiredEvidence?.join(" ") ?? ""}`;
  return candidate?.id === "media.shared-package-presence-is-not-interface-proof.v1"
    && required.every((phrase) => text.includes(phrase))
    && candidate?.runtimeAdmission === "NOT_ADMITTED"
    && candidate?.acceptanceEffect === "none"
    && candidate?.independentAcceptance === "OPEN"
    && /missing evidence is not evidence/u.test(candidate?.unknownDisposition ?? "");
}

test("package metadata cannot stand in for a public Media component contract", () => {
  assert.ok(rule);
  assert.equal(complete(rule), true);
});

test("removing any required package-evidence boundary or widening admission is rejected", () => {
  const mutations = [
    (candidate) => { candidate.rule = candidate.rule.replace("publicly exported", "present in package"); },
    (candidate) => { candidate.rule = candidate.rule.replace("API is stable for consumers", "API exists"); },
    (candidate) => { candidate.rule = candidate.rule.replace("the actual consumer is isolated from private or transitive implementation details", "the package exists"); },
    (candidate) => { candidate.rule = candidate.rule.replace("transitive licenses are cleared", "license is declared"); },
    (candidate) => { candidate.rule = candidate.rule.replace("functionally complete", "has source files"); },
    (candidate) => { candidate.requiredEvidence = candidate.requiredEvidence.filter((item) => !item.startsWith("behavior evidence")); },
    (candidate) => { candidate.runtimeAdmission = "ADMITTED"; },
    (candidate) => { candidate.acceptanceEffect = "phase-accepted"; },
  ];
  for (const mutate of mutations) {
    const candidate = structuredClone(rule);
    mutate(candidate);
    assert.equal(complete(candidate), false);
  }
});
