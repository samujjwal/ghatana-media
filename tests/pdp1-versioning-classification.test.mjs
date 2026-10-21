import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const versioning = parse(readFileSync(".product-experience/pdp-1-domain-data/versioning.yaml", "utf8"));

const expectedStatuses = new Map([
  ["authored-specification-versioning", "MEDIA_LOGICAL_MEANING_RESOLVED; RUNTIME_PERSISTENCE_AND_CONCURRENT_WRITE_IMPLEMENTATION_DEFERRED"],
  ["resolved-plan-versioning", "MEDIA_LOGICAL_MEANING_RESOLVED; RUNTIME_PLAN_REGISTRY_PERSISTENCE_AND_EXECUTION_ADMISSION_DEFERRED"],
  ["run-and-attempt-history", "MEDIA_LOGICAL_MEANING_RESOLVED; DURABLE_HISTORY_DEFERRED"],
  ["source-artifact-immutability", "MEDIA_LOGICAL_MEANING_RESOLVED; STORAGE_ENFORCEMENT_DEFERRED"],
  ["derived-artifact-identity", "MEDIA_LOGICAL_MEANING_RESOLVED; STORAGE_ENFORCEMENT_DEFERRED"],
  ["transcript-caption-ancestry", "MEDIA_LOGICAL_MEANING_RESOLVED; PRODUCER_AND_CONSUMER_BINDINGS_DEFERRED"],
  ["output-finality-and-reconciliation", "MEDIA_LOGICAL_MEANING_RESOLVED; PROVIDER_FINALITY_AND_DURABILITY_DEFERRED"],
  ["cross-boundary-references", "MEDIA_LOGICAL_MEANING_RESOLVED; EXTERNAL_CONSUMER_MAPPING_DEFERRED"],
  ["wire-compatibility", "MEDIA_SOURCE_PRESERVATION_RULE_DEFINED; ADAPTER_AND_CONSUMER_ACCEPTANCE_DEFERRED"],
]);

test("PDP-1 versioning statuses classify definition meaning separately from deferred runtime and owner evidence", () => {
  assert.match(versioning.statusSemantics, /DEFINITION_CLASSIFICATION/u);
  assert.match(versioning.statusSemantics, /observed.*gaps.*notEstablished/u);

  const rules = versioning.rules;
  const dispositions = versioning.definitionAdjudication.ruleDispositions;
  assert.deepEqual(rules.map(({ id }) => id), [...expectedStatuses.keys()]);
  assert.deepEqual(dispositions.map(({ ruleId }) => ruleId), rules.map(({ id }) => id));

  for (const rule of rules) {
    const disposition = dispositions.find(({ ruleId }) => ruleId === rule.id);
    assert.equal(rule.status, expectedStatuses.get(rule.id), `${rule.id} has the explicit definition/deferment classification`);
    assert.ok(rule.status.startsWith(disposition.classification), `${rule.id} matches its lower-level classification`);
    assert.match(rule.status, /(?:DEFERRED|DEFINED)/u, `${rule.id} states its deferred boundary`);
    assert.ok(disposition.notEstablished.length > 20, `${rule.id} retains its precise not-established boundary`);
    if (disposition.classification.includes("MEDIA_LOGICAL_MEANING_RESOLVED")) {
      assert.doesNotMatch(rule.status, /unresolved/iu, `${rule.id} does not relabel resolved meaning as unresolved`);
    }
  }
});
