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
const operationById = new Map([
  ...operations.individualOperationContracts.records,
  ...operations.ownerDefinedOperationContracts.records,
].map((operation) => [operation.id, operation]));

const fields = [
  ["media.operation-slice.cancel-job", "ownerDefinition.requestSchema.properties.jobId"],
  ["media.operation-slice.cancel-job", "ownerDefinition.requestSchema.properties.requestId"],
  ["media.operation-slice.retry-job", "ownerDefinition.requestSchema.properties.jobId"],
  ["media.operation-slice.retry-job", "ownerDefinition.requestSchema.properties.priorAttemptId"],
  ["media.operation-slice.retry-job", "ownerDefinition.requestSchema.properties.requestId"],
  ["media.operation-slice.attach-source-asset", "requestSchema.properties.projectId"],
  ["media.operation-slice.attach-source-asset", "requestSchema.properties.artifactId"],
  ["media.operation-slice.attach-source-asset", "requestSchema.properties.requestId"],
  ["media.operation-slice.inspect-artifact-version", "requestSchema.properties.artifactId"],
  ["media.operation-slice.inspect-provenance", "requestSchema.properties.subject.properties.payload.oneOf.0.properties.artifactId"],
];

function atPath(value, path) {
  return path.split(".").reduce((current, segment) => current[Number.isInteger(Number(segment)) ? Number(segment) : segment], value);
}

const ajv = new Ajv({ allErrors: true, strict: false });
ajv.addFormat("opaque-id", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);

test("all converted opaque-id operation fields retain their bounded wire grammar", () => {
  assert.equal(fields.length, 10, "the repair covers exactly the ten identified operation fields");
  for (const [operationId, path] of fields) {
    const operation = operationById.get(operationId);
    assert.ok(operation, `${operationId} exists`);
    const schema = atPath(operation, path);
    assert.deepEqual({
      type: schema.type,
      format: schema.format,
      pattern: schema.pattern,
      minLength: schema.minLength,
      maxLength: schema.maxLength,
    }, {
      type: "string",
      format: "opaque-id",
      pattern: "^[A-Za-z0-9][A-Za-z0-9._:-]*$",
      minLength: 1,
      maxLength: 128,
    }, `${operationId} ${path} declares the original opaque-id constraints`);

    const validate = ajv.compile(schema);
    assert.equal(validate("a"), true, `${operationId} ${path} accepts a minimal valid identifier`);
    assert.equal(validate(`a${"x".repeat(127)}`), true, `${operationId} ${path} accepts 128 characters`);
    assert.equal(validate(""), false, `${operationId} ${path} rejects empty strings`);
    assert.equal(validate(`a${"x".repeat(128)}`), false, `${operationId} ${path} rejects strings over 128 characters`);
    assert.equal(validate("-invalid-start"), false, `${operationId} ${path} rejects invalid initial characters`);
    assert.equal(validate("contains space"), false, `${operationId} ${path} rejects characters outside the grammar`);
  }
});
