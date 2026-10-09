import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = process.cwd();
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const source = parse(readFileSync(".product-experience/pdp-0-product-truth/goals-jtbd.yaml", "utf8"));
const collection = source.ownerDefinedMigrationRules;
const rules = collection.records;
const byId = new Map(rules.map((record) => [record.id, record]));

const requiredIds = [
  "media.goal-rule.existing-capability-family-scope",
  "media.goal-rule.required-capability-family-scope",
  "media.goal-rule.existing-consumer-contract-boundary",
  "media.goal-rule.common-platform-mechanics-boundary",
  "media.goal-rule.governed-enterprise-context-boundary",
  "media.goal-rule.external-domain-authority-boundary",
  "media.goal-rule.illustrative-render-is-not-validated-simulation",
  "media.goal-rule.explorer-evidence-boundary",
  "media.goal-rule.required-operation-status-retention",
  "media.goal-rule.first-use-intent-launchers",
  "media.goal-rule.capability-reuse-not-business-logic-duplication",
  "media.goal-rule.synthesis-command-families",
  "media.goal-rule.diarization-identity-separation",
  "media.goal-rule.operation-success-finality",
  "media.goal-rule.supported-cli-control-surface",
  "media.goal-rule.authentication-prerequisite",
  "media.goal-rule.simple-default-transparency",
  "media.goal-rule.expert-detail-within-operation",
  "media.goal-rule.quality-cannot-override-policy",
  "media.goal-rule.approval-bound-to-output",
  "media.goal-rule.effect-via-admitted-public-contract",
  "media.goal-rule.accepted-definition-projection",
  "media.goal-rule.shared-workflow-media-job-ownership",
];

function validateRuleSet(records) {
  const index = new Map(records.map((record) => [record.id, record]));
  assert.equal(index.size, requiredIds.length, "rule IDs are unique");
  assert.deepEqual([...index.keys()].sort(), [...requiredIds].sort(), "the complete normative collection is present");
  for (const id of requiredIds) {
    const record = index.get(id);
    assert.equal(typeof record.rule, "string");
    assert.ok(record.rule.trim().length > 0, `${id} has a substantive rule`);
    assert.ok(Array.isArray(record.nonClaims), `${id} declares limits`);
  }
  const text = (id) => index.get(id).rule;
  assert.match(text("media.goal-rule.required-capability-family-scope"), /Every capability family named as required product-definition scope remains/u);
  assert.match(text("media.goal-rule.existing-consumer-contract-boundary"), /versioned compatibility map before changing a supported call shape/u);
  assert.match(text("media.goal-rule.common-platform-mechanics-boundary"), /Shared\/platform owners retain those generic mechanics; Media owns domain-specific intent, state, policy/u);
  assert.match(text("media.goal-rule.governed-enterprise-context-boundary"), /A metadata projection is not canonical Media artifact state/u);
  assert.match(text("media.goal-rule.external-domain-authority-boundary"), /does not establish truth, copyright clearance, lawful use, or scientific accuracy/u);
  assert.match(text("media.goal-rule.illustrative-render-is-not-validated-simulation"), /visual plausibility or a quality score cannot substitute/u);
  assert.match(text("media.goal-rule.explorer-evidence-boundary"), /cannot claim that a fresh remote revocation or policy check occurred/u);
  assert.match(text("media.goal-rule.explorer-evidence-boundary"), /not evidence of production runtime behavior/u);
  assert.match(text("media.goal-rule.required-operation-status-retention"), /does not disappear when implementation is future/u);
  assert.match(text("media.goal-rule.first-use-intent-launchers"), /not seven competing permanently separate workspaces/u);
  assert.match(text("media.goal-rule.diarization-identity-separation"), /diarization success is not identity proof/u);
  assert.match(text("media.goal-rule.operation-success-finality"), /A request acknowledgement cannot replace a completed output/u);
  assert.match(text("media.goal-rule.supported-cli-control-surface"), /do not constitute Media media-processing operations/u);
  assert.match(text("media.goal-rule.authentication-prerequisite"), /First-run creation does not bypass authentication/u);
  assert.match(text("media.goal-rule.simple-default-transparency"), /cannot silently select an unqualified engine/u);
  assert.match(text("media.goal-rule.expert-detail-within-operation"), /disclosure alone does not create a separately executable operation/u);
  assert.match(text("media.goal-rule.quality-cannot-override-policy"), /cannot override safety, rights, consent, privacy/u);
  assert.match(text("media.goal-rule.approval-bound-to-output"), /Material regeneration invalidates only approvals whose approved material changed/u);
  assert.match(text("media.goal-rule.effect-via-admitted-public-contract"), /exact destination owner's admitted public operation and version/u);
  assert.match(text("media.goal-rule.effect-via-admitted-public-contract"), /unknown-outcome reconciliation/u);
  assert.match(text("media.goal-rule.accepted-definition-projection"), /deterministic visual\/interaction projection of already accepted PDP definitions/u);
  assert.match(text("media.goal-rule.accepted-definition-projection"), /standalone Explorer execution\/build is outside the current 38-task mandate/u);
  assert.match(text("media.goal-rule.shared-workflow-media-job-ownership"), /Media owns product-specific job and attempt definitions, durable repository, authority guards, handlers/u);
  assert.match(text("media.goal-rule.shared-workflow-media-job-ownership"), /Persist the accepted job, attempt identity, and dispatch intent before an external effect/u);
  assert.match(text("media.goal-rule.shared-workflow-media-job-ownership"), /no public runtime identity\/version is admitted/u);
}

test("goal migration rules are a finite source-owned normative collection, distinct from acceptance", () => {
  assert.equal(collection.authority, "user-delegated-Media-product-semantic-owner; additive clarification of historical source claims");
  assert.equal(collection.scopeStatus, "OWNER_DEFINED_PRODUCT_TRUTH; definition-only; no implementation, runtime, publication, or acceptance inference");
  assert.equal(rules.length, requiredIds.length);
  validateRuleSet(rules);
});

test("goal rule collection rejects missing material boundaries and duplicate identities", () => {
  for (const [id, pattern] of [
    ["media.goal-rule.required-capability-family-scope", /Every capability family named as required product-definition scope remains/u],
    ["media.goal-rule.existing-consumer-contract-boundary", /versioned compatibility map/u],
    ["media.goal-rule.common-platform-mechanics-boundary", /Media owns domain-specific intent, state, policy/u],
    ["media.goal-rule.explorer-evidence-boundary", /not evidence of production runtime behavior/u],
    ["media.goal-rule.operation-success-finality", /A request acknowledgement cannot replace a completed output/u],
    ["media.goal-rule.authentication-prerequisite", /does not bypass authentication/u],
    ["media.goal-rule.simple-default-transparency", /cannot silently select an unqualified engine/u],
    ["media.goal-rule.approval-bound-to-output", /Material regeneration invalidates only approvals/u],
  ]) {
    const mutation = structuredClone(rules);
    const record = mutation.find((entry) => entry.id === id);
    record.rule = record.rule.replace(pattern, "");
    assert.throws(() => validateRuleSet(mutation), `a removed material phrase in ${id} must fail validation`);
  }
  const duplicate = structuredClone(rules);
  duplicate[1].id = duplicate[0].id;
  assert.throws(() => validateRuleSet(duplicate), /rule IDs are unique/u);
});
