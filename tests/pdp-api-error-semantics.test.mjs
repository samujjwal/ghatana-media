import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

function errorSemanticsValid(contract) {
  const rule = contract.ownerDefinedErrorSemantics;
  const text = [...(rule?.rules ?? []), ...(rule?.negativeCases ?? [])].join(" ");
  const required = [
    "stable Media reason code", "caller-safe message", "provider exception text, secrets, credentials, and source media are never exposed",
    "exact operation's idempotency, effect boundary, and current authority",
    "UNKNOWN_OUTCOME", "neither success nor failure", "exact inspectable output-version references",
    "per-output finality and provenance", "input path and safe constraint",
    "HTTP status nor a generic UNAVAILABLE category authorizes retry",
  ];
  return rule?.id === "media.api.error-semantics.v1"
    && required.every((phrase) => text.includes(phrase))
    && contract.normativeRuleRecords?.some((record) => record.id === "media.p2.rule.api-error-semantics.v1"
      && record.ruleRef.endsWith("#ownerDefinedErrorSemantics") && record.acceptanceEffect === "none");
}

test("Media API error semantics bind exact retry, partial-output, and unknown-outcome meanings", () => {
  const errors = readYaml(".product-experience/pdp-2-design-interface-system/api/errors.yaml");
  const openApi = readYaml("contracts/openapi/media.yaml");
  const errorEnvelope = openApi.components.schemas.PlatformErrorEnvelope;
  const platformError = openApi.components.schemas.PlatformError;
  assert.equal(errorEnvelope.required.includes("error"), true);
  assert.equal(errorEnvelope.required.includes("meta"), true);
  assert.deepEqual(platformError.required, ["code", "message", "retryable"]);
  assert.equal(errors.ownerDefinedErrorSemantics.envelopeSourceRef, "contracts/openapi/media.yaml#/components/schemas/PlatformErrorEnvelope");
  assert.equal(errors.ownerDefinedErrorSemantics.runtimeAdmission, "NOT_ADMITTED");
  assert.equal(errorSemanticsValid(errors), true);
});

test("error-semantics validation rejects lost uncertainty, retry, privacy, and partial-output clauses", () => {
  const errors = readYaml(".product-experience/pdp-2-design-interface-system/api/errors.yaml");
  assert.equal(errorSemanticsValid(errors), true);
  const mutations = [
    (rule) => { rule.rules = rule.rules.map((line) => line.replace("neither success nor failure", "ordinary failure")); },
    (rule) => { rule.rules = rule.rules.map((line) => line.replace("HTTP status nor a generic UNAVAILABLE category authorizes retry", "HTTP status authorizes retry")); },
    (rule) => { rule.rules = rule.rules.map((line) => line.replace("provider exception text, secrets, credentials, and source media are never exposed", "provider exception text may be exposed")); },
    (rule) => { rule.rules = rule.rules.map((line) => line.replace("exact inspectable output-version references", "output names")); },
  ];
  for (const [index, mutate] of mutations.entries()) {
    const changed = structuredClone(errors);
    mutate(changed.ownerDefinedErrorSemantics);
    assert.equal(errorSemanticsValid(changed), false, `material error mutation ${index} cannot weaken the rule while retaining its ID`);
  }
});
