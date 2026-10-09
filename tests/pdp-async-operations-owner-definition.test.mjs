import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const sourcePath = ".product-experience/pdp-2-design-interface-system/api/async-operations.yaml";
const documents = new Map();
const read = (path) => {
  if (!documents.has(path)) documents.set(path, parse(readFileSync(resolve(root, path), "utf8")));
  return documents.get(path);
};
function resolveRef(ref) {
  const [path, pointer = ""] = ref.split("#", 2);
  let value = read(path);
  for (const tokenRaw of pointer.split("/").filter(Boolean)) {
    const token = tokenRaw.replaceAll("~1", "/").replaceAll("~0", "~");
    if (token.startsWith("@id=")) value = value.find(({ id }) => id === token.slice(4));
    else if (token.startsWith("@machineId=")) value = value.find(({ machineId }) => machineId === token.slice(11));
    else value = value?.[token];
    assert.notEqual(value, undefined, `source reference resolves: ${ref}`);
  }
  return value;
}

function asyncOwnerRulesValid(source) {
  const requirements = new Map([
    ["media.async.request-ack-job-effect-separation.v1", ["A transport acknowledgement", "is not provider dispatch", "effect finality"]],
    ["media.async.observation-bounds-and-currentness.v1", ["current tenant/principal authority", "scope-safe absence", "resume cursor is not a job or mutation identity"]],
    ["media.async.timeout-and-unknown-finality.v1", ["ends observation only", "report unknown finality", "is not remote cancellation"]],
    ["media.async.parent-child-budget-and-cancellation-scope.v1", ["deadline", "child and does not establish parent completion", "does not create a new job authority"]],
    ["media.async.group-retry-item-finality.v1", ["retains each item's exact original operation and request identity", "Completed eligible items are reused and not resubmitted", "unknown outcome is read-only reconciled", "unresolved ambiguity blocks that item's resubmission", "never mark a partial group complete"]],
    ["media.async.child-output-lifecycle-boundary.v1", ["retains its exact immutable output identity and parent/child operation provenance", "only for the lifecycle and retention scope authorized by its owning Media policy", "Later parent failure does not erase or rewrite a completed child effect", "neither automatically retained forever nor implicitly deleted with its parent"]],
    ["media.async.definition-and-run-state-separation.v1", ["versioned workflow definition", "Each invocation is a separately identified run", "Run status never rewrites the definition", "parameter or policy values never stand in for run state", "workflow graph alone grants no dispatch authority"]],
  ]);
  const ruleMap = new Map((source.ownerDefinedAsyncRules ?? []).map(({ id, rule }) => [id, rule]));
  const records = new Map((source.normativeRuleRecords ?? []).map((row) => [row.ruleRef.split("@id=")[1], row]));
  return [...requirements].every(([id, phrases]) => {
    const rule = ruleMap.get(id);
    const record = records.get(id);
    const definition = source.ownerDefinedAsyncRules.find((entry) => entry.id === id);
    return typeof rule === "string" && phrases.every((phrase) => rule.includes(phrase))
      && definition.negativeCases.length >= 3 && definition.sourceRefs.every((ref) => resolveRef(ref) !== undefined)
      && record?.acceptanceEffect === "none";
  });
}

test("asynchronous Media grammar separates request, job, effect, output, and finality", () => {
  const source = read(sourcePath);
  assert.equal(source.mediaOwnerDefinitionDecision.status, "MEDIA_OWNER_DEFINED_DEFINITION_ONLY");
  assert.equal(source.normativeRuleRecords.length, 7);
  assert.equal(asyncOwnerRulesValid(source), true);
  const submit = resolveRef(source.ownerDefinedAsyncRules[0].sourceRefs[0]);
  const inspect = resolveRef(source.ownerDefinedAsyncRules[1].sourceRefs[0]);
  const machine = resolveRef(source.ownerDefinedAsyncRules[0].sourceRefs[1]);
  assert.equal(submit.id, "media.operation-slice.submit-job");
  assert.equal(inspect.id, "media.operation-slice.inspect-job");
  assert.equal(machine.machineId, "media-job");
});

test("async contract tests reject false completion, unbounded observation, and parent-child authority leakage", () => {
  const source = read(sourcePath);
  const mutations = [
    (copy) => { copy.ownerDefinedAsyncRules[0].rule = copy.ownerDefinedAsyncRules[0].rule.replace("is not provider dispatch", "is provider dispatch"); },
    (copy) => { copy.ownerDefinedAsyncRules[1].rule = "Status lookup does not require current authority and all cursors may be reused as mutation identities."; },
    (copy) => { copy.ownerDefinedAsyncRules[2].rule = copy.ownerDefinedAsyncRules[2].rule.replace("ends observation only", "cancels the remote job"); },
    (copy) => { copy.ownerDefinedAsyncRules[3].rule = "Child success establishes parent completion and creates a new job authority."; },
    (copy) => { copy.normativeRuleRecords[0].acceptanceEffect = "runtime acceptance"; },
    (copy) => { copy.ownerDefinedAsyncRules.find(({ id }) => id === "media.async.group-retry-item-finality.v1").rule = "Retry every item with a new request identity; an ambiguous result is failure and a partial group is complete."; },
    (copy) => { copy.ownerDefinedAsyncRules.find(({ id }) => id === "media.async.child-output-lifecycle-boundary.v1").rule = "Parent failure deletes all child output and immutable identity means content is retained forever."; },
    (copy) => { copy.normativeRuleRecords.find(({ id }) => id === "media.p2.rule.async-group-retry-item-finality.v1").acceptanceEffect = "runtime acceptance"; },
    (copy) => { copy.ownerDefinedAsyncRules.find(({ id }) => id === "media.async.definition-and-run-state-separation.v1").rule = "Run status is stored in the shared definition and graph presence grants dispatch authority."; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(source);
    mutate(copy);
    assert.equal(asyncOwnerRulesValid(copy), false);
  }
});

test("group retry and child lifecycle rules preserve per-item identity, ambiguity, and owner retention scope", () => {
  const source = read(sourcePath);
  const byId = new Map(source.ownerDefinedAsyncRules.map((rule) => [rule.id, rule]));
  const retry = byId.get("media.async.group-retry-item-finality.v1");
  const child = byId.get("media.async.child-output-lifecycle-boundary.v1");
  assert.ok(retry && child);
  assert.deepEqual(retry.negativeCases, [
    "resubmit-completed-item", "blindly-resubmit-ambiguous-item", "retry-with-changed-request-identity",
    "report-partial-group-as-complete", "inherit-eligibility-from-another-item",
  ]);
  assert.deepEqual(child.negativeCases, [
    "parent-failure-rewrites-completed-child-effect", "retain-personal-content-forever-by-immutability",
    "erase-child-without-lifecycle-authority", "child-output-access-after-rights-revocation",
  ]);
  for (const rule of [retry, child]) {
    assert.ok(rule.sourceRefs.length >= 2);
    rule.sourceRefs.forEach((ref) => resolveRef(ref));
    assert.match(rule.scopeStatus, /OWNER_DEFINED/);
  }
  assert.match(retry.scopeStatus, /no batch execution, durable storage, or runtime retry is admitted/u);
  assert.match(child.scopeStatus, /durable retention and erasure implementation remain unestablished/u);
  const retryClauses = [
    "Completed eligible items are reused and not resubmitted",
    "unresolved ambiguity blocks that item's resubmission",
    "never mark a partial group complete",
  ];
  for (const clause of retryClauses) {
    const weakened = retry.rule.replace(clause, "condition omitted");
    assert.equal(retryClauses.every((required) => weakened.includes(required)), false, `group retry cannot pass without ${clause}`);
  }
  const childClauses = [
    "Later parent failure does not erase or rewrite a completed child effect",
    "only for the lifecycle and retention scope authorized by its owning Media policy",
    "neither automatically retained forever nor implicitly deleted with its parent",
  ];
  for (const clause of childClauses) {
    const weakened = child.rule.replace(clause, "condition omitted");
    assert.equal(childClauses.every((required) => weakened.includes(required)), false, `child lifecycle cannot pass without ${clause}`);
  }
});
