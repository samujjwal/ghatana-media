import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const { parse } = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml");

const runtime = readFileSync(resolve(root, "runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java"), "utf8");
const openApi = parse(readFileSync(resolve(root, "contracts/openapi/media.yaml"), "utf8"));

function responseSchema(path, method, status) {
  return openApi.paths[path][method].responses[String(status)].content["application/json"].schema;
}

test("ProcessingJob HTTP schema mirrors the serialized runtime record without claiming canonical equivalence", () => {
  const recordFields = runtime.match(/public record ProcessingJob\(([\s\S]*?)\)\s*\{/u)?.[1]
    .split("\n")
    .map((line) => line.trim().replace(/,$/u, ""))
    .filter(Boolean)
    .map((line) => {
      const match = line.match(/^(.+?)\s+(\w+)$/u);
      assert.ok(match, `unexpected ProcessingJob record field declaration: ${line}`);
      return { type: match[1], name: match[2] };
    });
  assert.ok(recordFields?.length, "runtime ProcessingJob record is present");
  const runtimeValues = runtime.match(/public enum JobStatus \{([^}]+)\}/u)?.[1]
    .split(",").map((value) => value.trim());
  const runtimeJobTypes = runtime.match(/public enum JobType \{([^}]+)\}/u)?.[1]
    .split(",").map((value) => value.trim());
  assert.ok(runtimeValues?.length, "runtime JobStatus enum is present");
  assert.ok(runtimeJobTypes?.length, "runtime JobType enum is present");

  const schema = openApi.components.schemas.ProcessingJob;
  assert.deepEqual(Object.keys(schema.properties), recordFields.map(({ name }) => name), "OpenAPI describes each record field in source order");
  for (const { type, name } of recordFields) {
    const property = schema.properties[name];
    if (type === "String") {
      assert.deepEqual(property.type, ["providerId", "failureCode"].includes(name) ? ["string", "null"] : "string", name);
    } else if (type === "JobType" || type === "JobStatus") {
      assert.equal(property.type, "string", name);
    } else if (type === "Instant") {
      assert.deepEqual(property.type, ["startedAt", "completedAt"].includes(name) ? ["string", "null"] : "string", name);
      assert.equal(property.format, "date-time", name);
    } else if (type === "Map<String, Object>") {
      assert.equal(property.type, "object", name);
      assert.equal(property.additionalProperties, true, name);
    } else if (type === "long") {
      assert.equal(property.type, "integer", name);
      assert.equal(property.format, "int64", name);
      assert.equal(property.minimum, 1, name);
    } else {
      assert.fail(`unreviewed ProcessingJob field type: ${type} ${name}`);
    }
  }
  assert.deepEqual(schema.properties.jobType.enum, runtimeJobTypes);
  assert.deepEqual(schema.properties.status.enum, runtimeValues);
  assert.match(schema.description, /observed transport contract, not a canonical/u);
  assert.match(schema.properties.status.description, /equivalence remains unresolved/u);
  assert.ok(schema.additionalProperties, "the status observation does not narrow unrelated legacy response fields");

  assert.deepEqual(responseSchema("/api/v1/jobs", "post", 202), { $ref: "#/components/schemas/ProcessingJob" });
  assert.deepEqual(
    responseSchema("/api/v1/jobs", "get", 200).properties.jobs.items,
    { $ref: "#/components/schemas/ProcessingJob" },
  );
  assert.deepEqual(responseSchema("/api/v1/jobs/{jobId}", "get", 200), { $ref: "#/components/schemas/ProcessingJob" });
  assert.deepEqual(responseSchema("/api/v1/jobs/{jobId}/cancel", "post", 200), { $ref: "#/components/schemas/ProcessingJob" });

  const platformOperation = openApi.components.schemas.PlatformOperation;
  assert.ok(!platformOperation.properties.state.enum.includes("OUTCOME_UNKNOWN"),
    "the separate PlatformOperation enum remains distinct until its owner mapping is decided");
});

test("principal-scoped upload, artifact, and job routes declare the principal header", () => {
  const routes = [
    ["/api/v1/artifacts/uploads", "post"],
    ["/api/v1/artifacts/uploads/{uploadId}", "get"],
    ["/api/v1/artifacts/uploads/{uploadId}/chunks/{chunkIndex}", "put"],
    ["/api/v1/artifacts/uploads/{uploadId}/complete", "post"],
    ["/api/v1/artifacts/{artifactId}", "get"],
    ["/api/v1/jobs", "post"],
    ["/api/v1/jobs", "get"],
    ["/api/v1/jobs/{jobId}", "get"],
    ["/api/v1/jobs/{jobId}/cancel", "post"],
  ];
  for (const [path, method] of routes) {
    assert.ok(openApi.paths[path][method].parameters.some(
      (parameter) => parameter.$ref === "#/components/parameters/PrincipalHeader",
    ), `${method.toUpperCase()} ${path} declares PrincipalHeader`);
  }
});

test("UploadRequest mirrors the runtime body identity fields and requires its principal", () => {
  const record = runtime.match(/public record UploadRequest\(([\s\S]*?)\)\s*\{/u)?.[1];
  assert.ok(record, "runtime UploadRequest record is present");
  const fields = record.split("\n").map((field) => field.trim().replace(/,$/u, "")).filter(Boolean)
    .map((field) => field.match(/^(.+?)\s+(\w+)$/u));
  assert.ok(fields.every(Boolean), "UploadRequest fields have supported record declarations");
  const names = fields.map((match) => match[2]);
  const schema = openApi.components.schemas.UploadRequest;
  assert.deepEqual(Object.keys(schema.properties), names, "OpenAPI describes the exact UploadRequest record fields");
  assert.deepEqual(schema.required, names, "all UploadRequest constructor fields are required on the HTTP request");
  assert.equal(schema.properties.principalId.type, "string");
});
