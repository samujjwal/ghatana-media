import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const Ajv = require("ajv").default;
const operations = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const operation = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation-slice.inspect-provenance");
const schema = operation.ownerWireSchema.requestSchema;
const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat("opaque-id", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
ajv.addFormat("opaque-version-id", /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u);
ajv.addFormat("opaque-versioned-reference", /^[A-Za-z0-9][A-Za-z0-9._:+/#-]{0,383}$/u);
const validate = ajv.compile(schema);

test("execution-reference lookup key uses the bounded opaque reference wire format", () => {
  const referenceSchema = schema.properties.subject.properties.payload.oneOf[1].properties.reference;
  assert.deepEqual(referenceSchema, {
    type: "string",
    format: "opaque-versioned-reference",
    minLength: 1,
    maxLength: 384,
  });

  const request = (reference) => ({
    subject: {
      artifactType: "artifact-or-execution-reference",
      payload: { kind: "execution-reference", reference },
    },
  });
  assert.equal(validate(request("opaque:job-ref/v1")), true);
  assert.equal(validate(request(`r${"x".repeat(383)}`)), true, "the declared 384-character maximum is inclusive");
  assert.equal(validate(request("")), false, "empty lookup keys are rejected");
  assert.equal(validate(request(`r${"x".repeat(384)}`)), false, "overlong lookup keys are rejected");
  assert.equal(validate(request(" opaque:job-ref")), false, "whitespace-prefixed values are not valid opaque references");
  assert.equal(validate(request("opaque value")), false, "whitespace is not accepted as part of the declared opaque format");
});
