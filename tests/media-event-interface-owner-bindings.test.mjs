import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const readYaml = (path) => parse(readFileSync(resolve(process.cwd(), path), "utf8"));
const parity = readYaml(".product-experience/interface-parity/operation-parity.yaml");
const domainEvents = readYaml(".product-experience/pdp-1-domain-data/events.yaml");
const source = readFileSync(resolve(process.cwd(), "libs/audio-video-client/src/index.ts"), "utf8");
const eventSurface = parity.surfaces.find(({ surface }) => surface === "internal runtime events");
const notificationSurface = parity.surfaces.find(({ surface }) => surface === "lifecycle event names");

function validateOwnerEventBindings(bindings, ownerContracts) {
  const errors = [];
  const registry = new Map(ownerContracts.map((record) => [record.id, record]));
  const types = bindings.records.map(({ eventType }) => eventType);
  if (bindings.records.length !== 9 || new Set(types).size !== 9) errors.push("event binding population must contain nine unique event types");
  if (ownerContracts.length !== 9) errors.push("the canonical Media owner event population changed");
  for (const binding of bindings.records) {
    const record = registry.get(binding.contractId);
    if (!record || record.eventType !== binding.eventType) errors.push(`${binding.eventType}: exact owner event contract is missing or mismatched`);
    if (!record?.schema || record.schema.type !== "object" || record.schema.additionalProperties !== false) errors.push(`${binding.eventType}: owner schema must be a closed object`);
    if (!record?.producer?.sourceRef || !record?.producer?.identity || !record?.aggregate?.aggregateType) errors.push(`${binding.eventType}: producer and aggregate semantics are required`);
  }
  if (bindings.admission !== "NOT_ADMITTED") errors.push("event source definitions cannot imply runtime admission");
  return errors;
}

function validateLocalNotifications(binding, inventory) {
  const errors = [];
  const expected = new Map(inventory.records.map((row) => [row.eventName, row]));
  const seen = new Set();
  for (const row of binding.records) {
    const exact = expected.get(row.eventName);
    if (!exact || seen.has(row.eventName)) errors.push(`${row.eventName}: notification identity is absent or duplicated`);
    else {
      if (row.publisher !== exact.publisherCallSite) errors.push(`${row.eventName}: publisher differs from observed client method`);
      if (JSON.stringify(row.payloadFields) !== JSON.stringify(exact.observedPayloadFields)) errors.push(`${row.eventName}: payload fields differ from the observed client notification`);
    }
    seen.add(row.eventName);
  }
  if (binding.records.length !== 3 || seen.size !== 3) errors.push("the exact unresolved AI voice notification cohort must contain three records");
  if (!/in-process/u.test(binding.delivery) || !/not-durable/u.test(binding.delivery) || binding.admission !== "NOT_ADMITTED") errors.push("local notification definition must remain non-durable and unadmitted");
  return errors;
}

test("all nine runtime event identities bind exact owner schema and producer contracts", () => {
  const bindings = eventSurface.currentOwnerEventDefinitionBindings;
  const contracts = domainEvents.ownerEventContracts.records;
  assert.deepEqual(validateOwnerEventBindings(bindings, contracts), []);
  assert.equal(new Set(bindings.records.map((row) => row.contractId)).size, 9);
  const observedTypes = new Set(domainEvents.observedEnvelope.lifecyclePublisherInventory.records.map(({ eventType }) => eventType));
  assert.deepEqual(new Set(bindings.records.map(({ eventType }) => eventType)), observedTypes);
});

test("three AI voice client notifications retain exact local publisher and payload meaning", () => {
  const inventory = domainEvents.observedEnvelope.clientNotificationInventory;
  const binding = notificationSurface.currentNotificationDefinitions;
  assert.deepEqual(validateLocalNotifications(binding, inventory), []);
  for (const row of binding.records) {
    assert.ok(source.includes(row.publisher.split("#")[1]), `${row.publisher} exists in source`);
    assert.ok(row.payloadFields.every((field) => source.includes(field)), `${row.eventName} payload fields exist in source`);
  }
  assert.match(binding.boundary, /no-trigger-operation-or-canonical-event-equivalence/u);
});

test("event bindings reject omitted, substituted, or falsely admitted meanings", () => {
  const ownerContracts = domainEvents.ownerEventContracts.records;
  const omitted = structuredClone(eventSurface.currentOwnerEventDefinitionBindings);
  omitted.records.pop();
  assert.ok(validateOwnerEventBindings(omitted, ownerContracts).some((error) => error.includes("nine unique")));

  const substituted = structuredClone(eventSurface.currentOwnerEventDefinitionBindings);
  substituted.records[0].contractId = substituted.records[1].contractId;
  assert.ok(validateOwnerEventBindings(substituted, ownerContracts).some((error) => error.includes("mismatched")));

  const admitted = structuredClone(eventSurface.currentOwnerEventDefinitionBindings);
  admitted.admission = "ADMITTED";
  assert.ok(validateOwnerEventBindings(admitted, ownerContracts).some((error) => error.includes("cannot imply runtime admission")));

  const notificationMutation = structuredClone(notificationSurface.currentNotificationDefinitions);
  notificationMutation.records[1].payloadFields = ["request"];
  assert.ok(validateLocalNotifications(notificationMutation, domainEvents.observedEnvelope.clientNotificationInventory).some((error) => error.includes("payload fields differ")));
});
