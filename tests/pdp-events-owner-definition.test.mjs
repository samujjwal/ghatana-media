import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const { parse } = createRequire(resolve(root, "package.json"))("yaml");
const sourcePath = ".product-experience/pdp-2-design-interface-system/events/conventions.yaml";
const eventContractPath = ".product-experience/pdp-1-domain-data/events.yaml";
const read = () => parse(readFileSync(resolve(root, sourcePath), "utf8"));
const readEventContracts = () => parse(readFileSync(resolve(root, eventContractPath), "utf8"));

function validOwnerEventRules(source) {
  const rules = new Map((source.ownerDefinedEventRules ?? []).map((rule) => [rule.id, rule.rule]));
  const clauses = new Map([
    ["media.events.request-fact-finality-boundary.v1", ["publication attempt", "terminal product effect", "retain unknown"]],
    ["media.events.identity-and-ordering-limits.v1", ["request identity", "not a global ordering clock", "out-of-order observations"]],
    ["media.events.privacy-and-provenance-minimization.v1", ["current classification", "Structural sanitization is not semantic redaction approval", "never emitted as observed facts"]],
    ["media.events.runtime-and-client-notification-separation.v1", ["nine observed server-side lifecycle event identities", "fifteen in-process client-local notification types", "do not establish canonical event identity"]],
    ["media.events.external-delivery-guarantees-unestablished.v1", ["transactional V016 outbox is source-bound for the canonical media.job.accepted event only", "does not establish end-to-end durable Event Plane delivery", "never derive them"]],
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
  assert.equal(source.deliveryAndFailure.notEstablished.includes("durable-outbox"), false);
  assert.equal(source.deliveryAndFailure.notEstablished.includes("consumer-acknowledgement"), true);
  assert.equal(validOwnerEventRules(source), true);
  assert.equal(source.normativeRuleRecords.length, 5);

  const accepted = readEventContracts().ownerEventContracts.records.find(({ eventType }) => eventType === "media.job.accepted");
  assert.match(accepted.delegatedTechnicalOwnerDecision.decision, /Persist the canonical V016 intent in the same transaction as the job row/u);
  assert.equal(accepted.executionAdmission, "NOT_ADMITTED");
});

test("event owner rules reject false durability, role conflation, and privacy weakening", () => {
  const source = read();
  const mutations = [
    (copy) => { copy.ownerDefinedEventRules[4].rule = copy.ownerDefinedEventRules[4].rule.replace("transactional V016 outbox is source-bound", "end-to-end durable Event Plane delivery is established"); },
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
