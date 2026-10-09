import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");
const sourcePath = ".product-experience/pdp-2-design-interface-system/events/conventions.yaml";
const read = () => parse(readFileSync(resolve(root, sourcePath), "utf8"));

function validOwnerEventRules(source) {
  const rules = new Map((source.ownerDefinedEventRules ?? []).map((rule) => [rule.id, rule.rule]));
  const clauses = new Map([
    ["media.events.request-fact-finality-boundary.v1", ["publication attempt", "terminal product effect", "retain unknown"]],
    ["media.events.identity-and-ordering-limits.v1", ["request identity", "not a global ordering clock", "out-of-order observations"]],
    ["media.events.privacy-and-provenance-minimization.v1", ["current classification", "Structural sanitization is not semantic redaction approval", "never emitted as observed facts"]],
    ["media.events.runtime-and-client-notification-separation.v1", ["nine observed server-side lifecycle publisher types", "fifteen in-process client-local notification types", "do not establish canonical event identity"]],
    ["media.events.external-delivery-guarantees-unestablished.v1", ["No durable outbox", "exact accepted platform and event-owner contract", "never derive a guarantee"]],
  ]);
  const records = new Map((source.normativeRuleRecords ?? []).map((record) => [record.ruleRef.split("@id=")[1], record]));
  return [...clauses].every(([id, required]) => {
    const rule = rules.get(id);
    const record = records.get(id);
    return typeof rule === "string" && required.every((phrase) => rule.includes(phrase))
      && record?.acceptanceEffect === "none"
      && record?.sourceAuthority === `${sourcePath}#mediaOwnerDefinitionDecision`;
  }) && source.ownerDefinedEventRules.every((rule) => Array.isArray(rule.negativeCases) && rule.negativeCases.length >= 2);
}

test("event definitions preserve source roles and do not promote observed transport into event acceptance", () => {
  const source = read();
  assert.equal(source.observedPopulations.runtimeLifecyclePublishers.count, 9);
  assert.equal(source.observedPopulations.clientLocalNotifications.count, 15);
  assert.equal(source.mediaOwnerDefinitionDecision.status, "MEDIA_OWNER_DEFINED_DEFINITION_ONLY");
  assert.equal(source.producerAndOwnerAuthority.canonicalTaxonomy, "not-established");
  assert.equal(source.deliveryAndFailure.notEstablished.includes("durable-outbox"), true);
  assert.equal(validOwnerEventRules(source), true);
  assert.equal(source.normativeRuleRecords.length, 5);
});

test("event owner rules reject false durability, role conflation, and privacy weakening", () => {
  const source = read();
  const mutations = [
    (copy) => { copy.ownerDefinedEventRules[4].rule = copy.ownerDefinedEventRules[4].rule.replace("No durable outbox", "Durable outbox"); },
    (copy) => { copy.ownerDefinedEventRules[3].rule = "Client callback names establish canonical event identity and durable publication."; },
    (copy) => { copy.ownerDefinedEventRules[2].rule = copy.ownerDefinedEventRules[2].rule.replace("Structural sanitization is not semantic redaction approval", "Structural sanitization is semantic redaction approval"); },
    (copy) => { copy.normativeRuleRecords[0].acceptanceEffect = "phase acceptance"; },
  ];
  for (const mutate of mutations) {
    const copy = structuredClone(source);
    mutate(copy);
    assert.equal(validOwnerEventRules(copy), false);
  }
});
