import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const p0 = read(".product-experience/pdp-0-product-truth/capabilities.yaml").capabilities;
const p1Source = read(".product-experience/pdp-1-domain-data/operations.yaml");
const p1 = p1Source.capabilityOperationContracts;

function requiredFields(schema) {
  return [...(schema?.required ?? [])].sort();
}

test("canonical P0/P1 input slots preserve requiredness and rights evidence payload requiredness", () => {
  const canonical = p1.records.filter(({ recordKind }) =>
    recordKind === "CANONICAL_OWNER_DEFINED_CAPABILITY_OPERATION");
  const operationsByCapability = new Map(canonical.map((operation) => [operation.capabilityRef, operation]));

  for (const capability of p0) {
    const operation = operationsByCapability.get(capability.id);
    if (!operation) continue;
    const p0SlotsById = new Map(capability.ownerDefinition.typedInputSlots.map((slot) => [slot.slotId, slot]));
    for (const target of operation.inputSlots) {
      const source = p0SlotsById.get(target.slotId);
      if (!source) continue;
      assert.equal(target.required, source.required, `${capability.id} ${target.slotId} requiredness matches P0`);
      assert.equal(operation.requestSchema.required.includes(target.slotId), target.required,
        `${capability.id} request schema ${target.slotId} requiredness matches its P1 slot`);
    }
  }

  const rightsOperation = operationsByCapability.get("media.rights.attestation.record");
  assert.ok(rightsOperation, "rights attestation has its canonical operation");
  const input2 = rightsOperation.requestSchema.properties.input2;
  const reusable = p1.inputPayloadSchemas.find(({ id }) => id === "media.typed-input.rights-evidence-reference");
  assert.ok(reusable, "rights evidence reusable input schema exists");
  assert.deepEqual(requiredFields(input2), requiredFields(reusable.schema), "input2 and reusable schema require the same envelope fields");
  assert.deepEqual(requiredFields(input2.properties.payload), requiredFields(reusable.schema.properties.payload),
    "inline input2 payload and reusable rights evidence payload require the same fields");
});

test("stream-session-open inline request inputs match their referenced typed input schemas", () => {
  const operation = p1.records.find(({ id }) => id === "media.operation.capability.media-stream-session-open");
  assert.ok(operation, "stream-session-open has its canonical operation");

  const sessionInput = p1.inputPayloadSchemas.find(({ id }) => id === "media.typed-input.stream-session-request");
  assert.ok(sessionInput, "canonical stream-session input schema exists");
  assert.equal(sessionInput.decisionRef, ".product-experience/decision-log.md#PXD-258");
  const clockDomain = sessionInput.schema.properties.payload.properties.clockDomainRef;
  assert.equal(clockDomain.pattern, "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$");
  assert.equal(clockDomain.maxLength, 128);

  const reconnectInput = p1.inputPayloadSchemas.find(({ id }) => id === "media.typed-input.stream-session-reconnect-request");
  assert.ok(reconnectInput, "canonical reconnect input schema exists");
  assert.equal(reconnectInput.decisionRef, sessionInput.decisionRef);
  assert.deepEqual(reconnectInput.schema.properties.payload.properties.clockDomainRef, clockDomain,
    "reconnect preserves the exact immutable session clock-domain identity");

  for (const slotId of ["input1", "input2"]) {
    const slot = operation.inputSlots.find(({ slotId: candidate }) => candidate === slotId);
    assert.ok(slot?.payloadSchemaRef, `${slotId} declares a typed input schema reference`);

    const typedInput = p1.inputPayloadSchemas.find(({ id }) => id === slot.payloadSchemaRef);
    assert.ok(typedInput, `${slotId} referenced typed input schema exists`);

    let inlineSchema = operation.requestSchema.properties[slotId];
    if (slotId === "input1") {
      const sessionIdSchema = inlineSchema.properties.payload.properties.streamSessionId;
      assert.equal(sessionIdSchema.pattern, "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
        "inline streamSessionId retains its operation-specific opaque ID pattern");
      inlineSchema = {
        ...inlineSchema,
        properties: {
          ...inlineSchema.properties,
          payload: {
            ...inlineSchema.properties.payload,
            properties: {
              ...inlineSchema.properties.payload.properties,
              streamSessionId: Object.fromEntries(
                Object.entries(sessionIdSchema).filter(([key]) => key !== "pattern")),
            },
          },
        },
      };
    }

    assert.deepEqual(inlineSchema, typedInput.schema,
      `${slotId} inline request schema matches ${slot.payloadSchemaRef}`);
  }
});


test("job-list readVersion and observedAt bind one coherent bounded store snapshot", () => {
  const operation = p1Source.ownerDefinedOperationContracts.records.find(
    ({ id }) => id === "media.operation.job-list.v1",
  );
  assert.ok(operation, "job-list is an owner-defined query");
  assert.equal(operation.decisionRef, ".product-experience/decision-log.md#PXD-242");
  assert.match(operation.readSemantics, /one coherent store snapshot for the exact bounded query/u);
  assert.match(operation.readSemantics, /host-attested tenant\/principal/u);
  assert.match(operation.readSemantics, /readVersion is an opaque token issued by that store snapshot/u);
  assert.match(operation.readSemantics, /not a cursor, page token, observedAt timestamp, response digest, or maximum job\.version/u);
  assert.match(operation.readSemantics, /observedAt is server-generated for the same query observation/u);
  assert.match(operation.readSemantics, /UNKNOWN_OBSERVATION with no partial job list/u);
  assert.match(operation.readSemantics, /store is unavailable, return UNAVAILABLE/u);
});
