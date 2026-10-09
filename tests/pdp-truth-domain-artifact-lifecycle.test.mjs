import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const statesPath = ".product-experience/pdp-1-domain-data/states.yaml";
const opsPath = ".product-experience/pdp-1-domain-data/operations.yaml";
const stateRoot = `${statesPath}#stateMachines/media-upload-and-artifact/stateDefinitions`;
const operationId = "media.operation.artifact.lifecycle.observe.v1";

test("artifact lifecycle read is a definition-only exact-version query with trusted scope and complete state mapping", () => {
  const operations = read(opsPath);
  const states = read(statesPath);
  const operation = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === operationId);
  assert.ok(operation, "the exact new owner query has a stable operation identity");
  assert.equal(operation.operationKind, "QUERY");
  assert.equal(operation.transportStatus, "NO_EXISTING_ENDPOINT_OR_RUNTIME_BINDING_ASSERTED");
  assert.equal(operation.backendSupport, "PENDING_IMPLEMENTATION");
  assert.match(operation.scopeStatus, /runtime-observation-UNKNOWN-until-implemented/);
  assert.deepEqual(operation.canonicalStateAuthorityAllowlist, [`${statesPath}#stateMachines/media-upload-and-artifact`]);
  assert.deepEqual(operation.stateMappings.map(({ sourceState, canonicalStateRef, meaningSourceRef }) => [sourceState, canonicalStateRef, meaningSourceRef]),
    states.stateMachines.find(({ machineId }) => machineId === "media-upload-and-artifact").stateDefinitions.map(({ id }) => [id, `${stateRoot}/${id}`, `${stateRoot}/${id}/meaning`]));
  assert.deepEqual(operation.ownerWireSchema.requestSchema.required, ["artifactId", "artifactVersionId"]);
  assert.equal(operation.ownerWireSchema.requestSchema.additionalProperties, false);
  assert.equal(operation.ownerWireSchema.trustedContext.tenantId, "host-attested; not request body");
  assert.equal(operation.ownerWireSchema.trustedContext.principalId, "host-attested; not request body");
  assert.equal(operation.ownerWireSchema.resultSchema.properties.observation.oneOf.length, 12);
  assert.equal(operation.ownerWireSchema.resultSchema.allOf.length, 2);
});

test("artifact lifecycle oracle accepts exact state/evidence and rejects mismatched state, authority, caller scope, or fabricated UNKNOWN", () => {
  const Ajv = require("ajv").default;
  const addFormats = require("ajv-formats");
  const operation = read(opsPath).ownerDefinedOperationContracts.records.find(({ id }) => id === operationId);
  const schema = operation.ownerWireSchema.resultSchema;
  const ajv = new Ajv({ allErrors: true, strict: false });
  addFormats(ajv);
  ajv.addFormat("opaque-id", /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/);
  ajv.addFormat("opaque-version-id", /^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/);
  const validate = ajv.compile(schema);
  const availableRef = `${stateRoot}/AVAILABLE`;
  const authorityRef = operation.canonicalStateAuthorityAllowlist[0];
  const exactObservation = {
    artifactId: "artifact-42", artifactVersionId: "artifact-version-9", lifecycleState: "AVAILABLE",
    canonicalStateRef: availableRef, meaningSourceRef: `${availableRef}/meaning`,
    tenantId: "tenant-1", principalId: "principal-1", stateRevision: 3,
    observedAt: "2026-10-08T15:30:00Z", stateAuthorityRef: authorityRef,
    stateEvidenceRef: "media.evidence.artifact-state.read.42", readVersion: 9,
  };
  const valid = { operationRef: operationId, outcome: "OBSERVED", observedAt: exactObservation.observedAt, observation: exactObservation };
  assert.equal(validate(valid), true, JSON.stringify(validate.errors));

  const wrongRef = structuredClone(valid);
  wrongRef.observation.canonicalStateRef = `${stateRoot}/QUARANTINED`;
  assert.equal(validate(wrongRef), false, "state identity and canonical reference must match exactly");
  const falseAuthority = structuredClone(valid);
  falseAuthority.observation.stateAuthorityRef = "caller.supplied.authority";
  assert.equal(validate(falseAuthority), false, "state authority must resolve to the allowlisted canonical owner source");
  const missingEvidence = structuredClone(valid);
  delete missingEvidence.observation.stateEvidenceRef;
  assert.equal(validate(missingEvidence), false, "state labels without exact source evidence are not observations");
  const unknownWithState = { operationRef: operationId, outcome: "UNKNOWN_OUTCOME", observedAt: valid.observedAt, unknownReason: "READ_MODEL_DOES_NOT_EXPOSE_LIFECYCLE_STATE", observation: exactObservation };
  assert.equal(validate(unknownWithState), false, "UNKNOWN cannot smuggle a state observation");
  const unknownWithoutReason = { operationRef: operationId, outcome: "UNKNOWN_OUTCOME", observedAt: valid.observedAt };
  assert.equal(validate(unknownWithoutReason), false, "UNKNOWN requires an explicit reason");
  const unknown = { operationRef: operationId, outcome: "UNKNOWN_OUTCOME", observedAt: valid.observedAt, unknownReason: "AUTHORITATIVE_LIFECYCLE_READ_NOT_IMPLEMENTED" };
  assert.equal(validate(unknown), true, JSON.stringify(validate.errors));

  const requestSchema = operation.ownerWireSchema.requestSchema;
  const validateRequest = ajv.compile(requestSchema);
  assert.equal(validateRequest({ artifactId: "artifact-42", artifactVersionId: "artifact-version-9" }), true);
  assert.equal(validateRequest({ artifactId: "artifact-42", artifactVersionId: "artifact-version-9", tenantId: "tenant-override" }), false,
    "tenant/principal are trusted context and cannot be supplied in the request body");
});
