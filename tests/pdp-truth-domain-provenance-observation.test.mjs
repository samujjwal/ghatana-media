import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const Ajv = require("ajv").default;
const addFormats = require("ajv-formats");
const operations = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const operationId = "media.operation-slice.inspect-provenance";
const operation = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === operationId);
const schema = operation.ownerWireSchema.resultSchema;
const ajv = new Ajv({ allErrors: true, strict: false });
addFormats(ajv);
ajv.addFormat("opaque-id", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u);
ajv.addFormat("opaque-version-id", /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u);
ajv.addFormat("opaque-versioned-reference", /^[A-Za-z0-9][A-Za-z0-9._:+/#-]{0,383}$/u);
const validate = ajv.compile(schema);

const success = {
  operationRef: operationId,
  outcome: "SUCCEEDED",
  observedAt: "2026-10-08T15:30:00Z",
  outputs: [{
    artifactType: "minimized-provenance-record-or-disclosure",
    payload: {
      kind: "lineage-observation",
      subjectArtifactVersionId: "artifact-version-9",
      scopeRef: ".product-experience/pdp-1-domain-data/domain-objects.yaml#media.domain.provenance-manifest",
      completeness: "COMPLETE_FOR_CALLER_VISIBLE_SCOPE",
      completenessReason: "ALL_VISIBLE_MANIFESTS_AND_EDGES_RETURNED",
      accessDisposition: "VISIBLE",
      manifestRefs: [{ manifestId: "manifest-42", manifestVersion: "manifest-v1" }],
      lineageEdges: [{
        relation: "DERIVED_FROM",
        sourceArtifactVersionId: "source-version-1",
        targetArtifactVersionId: "artifact-version-9",
        evidenceRef: "media.evidence.provenance-edge.42",
      }],
    },
  }],
};

test("provenance observation schema carries exact caller-scoped version, lineage, access, and completeness", () => {
  assert.ok(operation, "the canonical provenance query exists");
  assert.equal(operation.operationKind, "QUERY");
  assert.equal(operation.ownerWireSchema.requestSchema.additionalProperties, false);
  assert.deepEqual(operation.ownerWireSchema.requestSchema.required, ["subjectArtifactVersionId"]);
  assert.equal(validate(success), true, JSON.stringify(validate.errors));

  const missingEdgeIdentity = structuredClone(success);
  delete missingEdgeIdentity.outputs[0].payload.lineageEdges[0].targetArtifactVersionId;
  assert.equal(validate(missingEdgeIdentity), false, "a lineage relation without an exact target version is unusable");

  const wrongSubject = structuredClone(success);
  wrongSubject.outputs[0].payload.subjectArtifactVersionId = "another-version";
  assert.equal(validate(wrongSubject), true, "structural schema cannot assert equality to request; caller oracle must bind exact requested subject");
  assert.equal(operation.requestResultBinding.subjectArtifactVersionId, "EXACT_REQUEST_SUBJECT_ARTIFACT_VERSION_ID");

  const falseGlobalCompleteness = structuredClone(success);
  falseGlobalCompleteness.outputs[0].payload.completeness = "COMPLETE_FOR_CALLER_VISIBLE_SCOPE";
  falseGlobalCompleteness.outputs[0].payload.accessDisposition = "PARTIALLY_REDACTED";
  falseGlobalCompleteness.outputs[0].payload.completenessReason = "ACCESS_REDACTION_LIMITS_SCOPE";
  assert.equal(validate(falseGlobalCompleteness), false, "redaction cannot be presented as a complete visible-scope result");

  const partial = structuredClone(success);
  partial.outputs[0].payload.completeness = "PARTIAL_FOR_CALLER_VISIBLE_SCOPE";
  partial.outputs[0].payload.accessDisposition = "PARTIALLY_REDACTED";
  partial.outputs[0].payload.completenessReason = "ACCESS_REDACTION_LIMITS_SCOPE";
  assert.equal(validate(partial), true, JSON.stringify(validate.errors));

  const unknownWithOutput = {
    operationRef: operationId,
    outcome: "UNKNOWN_OUTCOME",
    observedAt: success.observedAt,
    outputs: success.outputs,
  };
  assert.equal(validate(unknownWithOutput), false, "unknown outcome cannot carry fabricated lineage evidence");
  const unknown = {
    operationRef: operationId,
    outcome: "UNKNOWN_OUTCOME",
    observedAt: success.observedAt,
    outputs: [],
    uncertainty: "AUTHORITY_READ_UNAVAILABLE",
  };
  assert.equal(validate(unknown), true, JSON.stringify(validate.errors));
});
