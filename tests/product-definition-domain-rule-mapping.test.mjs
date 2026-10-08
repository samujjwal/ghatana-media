import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { resolveAcceptedDomainRuleRecords } from "../scripts/lib/product-definition-domain-rule-mapping.mjs";

const root = process.cwd();
const toolsRequire = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = toolsRequire("yaml");
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

test("ProductDefinition domain rules resolve only the six exact PXD-035 accepted PDP-1 decisions", () => {
  const constitution = readYaml(".product-experience/pdp-0-product-truth/constitution.yaml");
  const adjudication = readYaml(".product-experience/pdp-1-domain-data/state-adjudication.yaml");
  const mapped = resolveAcceptedDomainRuleRecords(constitution.domainRules.records, adjudication.ownerAcceptedPolicyDecisions);
  assert.equal(mapped.length, 6);
  assert.ok(mapped.every(({ sourceRef }) => sourceRef.startsWith(
    ".product-experience/pdp-1-domain-data/state-adjudication.yaml#/ownerAcceptedPolicyDecisions/",
  )));
});

test("rejects a forged PDP-1 source key even when the projection row claims owner acceptance", () => {
  const constitution = readYaml(".product-experience/pdp-0-product-truth/constitution.yaml");
  const adjudication = readYaml(".product-experience/pdp-1-domain-data/state-adjudication.yaml");
  const records = structuredClone(constitution.domainRules.records);
  records[0].sourceRef = ".product-experience/pdp-1-domain-data/state-adjudication.yaml#/ownerAcceptedPolicyDecisions/fictionalApproval";
  assert.throws(() => resolveAcceptedDomainRuleRecords(records, adjudication.ownerAcceptedPolicyDecisions), /missing, forged/u);
});

test("rejects stale decision polarity and non-admitted PDP-1 decisions", () => {
  const constitution = readYaml(".product-experience/pdp-0-product-truth/constitution.yaml");
  const adjudication = readYaml(".product-experience/pdp-1-domain-data/state-adjudication.yaml");
  const records = structuredClone(constitution.domainRules.records);
  records[1].expectedDecisionValue = true;
  assert.throws(() => resolveAcceptedDomainRuleRecords(records, adjudication.ownerAcceptedPolicyDecisions), /value-mismatched/u);
  assert.throws(() => resolveAcceptedDomainRuleRecords(records, { ...adjudication.ownerAcceptedPolicyDecisions, policyStatus: "PENDING" }), /require the accepted PDP-1/u);
});

test("rejects an accepted decision key attached to the wrong rule ID", () => {
  const constitution = readYaml(".product-experience/pdp-0-product-truth/constitution.yaml");
  const adjudication = readYaml(".product-experience/pdp-1-domain-data/state-adjudication.yaml");
  const records = structuredClone(constitution.domainRules.records);
  records[0].sourceRef = records[1].sourceRef;
  records[0].expectedDecisionValue = records[1].expectedDecisionValue;
  assert.throws(() => resolveAcceptedDomainRuleRecords(records, adjudication.ownerAcceptedPolicyDecisions), /missing, forged/u);
});
