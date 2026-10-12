import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";

const root = resolve(new URL("..", import.meta.url).pathname);
const require = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const Ajv = require("ajv").default;
const readYaml = (path) => parse(readFileSync(resolve(root, path), "utf8"));

const operationsPath = ".product-experience/pdp-1-domain-data/operations.yaml";
const operations = readYaml(operationsPath);
const contract = operations.ownerDefinedOperationContracts.records.find(({ id }) => id === "media.operation-slice.inspect-provenance");
const binding = operations.capabilityOperationContracts.records.find(({ id }) => id === "media.capability-binding.media-provenance-source-lineage-inspect");
const wire = contract.ownerWireSchema;
const typedInput = operations.capabilityOperationContracts.inputPayloadSchemas.find(({ id }) => id === "media.typed-input.artifact-or-execution-reference");
const p0Capability = ".product-experience/pdp-0-product-truth/capabilities.yaml#artifactType:artifact-or-execution-reference";

function branches(schema) {
  return schema.properties.subject.properties.payload.oneOf;
}

function validateRequestSchema(requestSchema, request) {
  if (requestSchema.required.some((key) => !(key in request)) || Object.keys(request).some((key) => !["subject"].includes(key))) return false;
  const subject = request.subject;
  if (!subject || subject.artifactType !== "artifact-or-execution-reference" || Object.keys(subject).some((key) => !["artifactType", "payload"].includes(key))) return false;
  const payload = subject.payload;
  if (!payload || typeof payload !== "object") return false;
  const artifact = payload.kind === "artifact" && typeof payload.artifactId === "string" && payload.artifactId.length > 0
    && typeof payload.versionId === "string" && payload.versionId.length > 0
    && Object.keys(payload).every((key) => ["kind", "artifactId", "versionId", "sourceRef"].includes(key));
  const execution = payload.kind === "execution-reference" && typeof payload.reference === "string" && payload.reference.length > 0
    && Object.keys(payload).every((key) => ["kind", "reference"].includes(key));
  return Number(artifact) + Number(execution) === 1;
}

function validateExecutionBinding(outcome, payload, requestedSubject) {
  if (outcome !== "SUCCEEDED") return false;
  const bindingSubject = payload?.requestBinding?.subject;
  if (!isDeepStrictEqual(bindingSubject, requestedSubject)) return false;
  const requestPayload = bindingSubject?.payload;
  const disposition = payload?.requestBinding?.resolutionDisposition;
  const hasIdentity = Object.hasOwn(payload ?? {}, "resolvedExecutionIdentity");
  const hasArtifactVersion = Object.hasOwn(payload ?? {}, "subjectArtifactVersionId");
  if (requestPayload?.kind === "artifact") return disposition === "ARTIFACT_VERSION" && !hasIdentity
    && typeof requestPayload.versionId === "string" && requestPayload.versionId.length > 0
    && hasArtifactVersion && payload.subjectArtifactVersionId === requestPayload.versionId;
  if (requestPayload?.kind !== "execution-reference" || disposition !== "RESOLVED_EXECUTION" || !hasIdentity || hasArtifactVersion) return false;
  const identity = payload.resolvedExecutionIdentity;
  const allowedFields = {
    ProcessingJob: ["kind", "tenantId", "jobId"],
    JobAttempt: ["kind", "tenantId", "jobId", "attemptId"],
  }[identity?.kind];
  return Boolean(allowedFields && allowedFields.every((key) => typeof identity[key] === "string" && identity[key].length > 0)
    && Object.keys(identity).every((key) => allowedFields.includes(key)));
}

function validateUnknownResolution(outcome, payload, requestedSubject) {
  if (outcome !== "SUCCEEDED" || !payload || payload.kind !== "resolution-unknown"
    || payload.accessDisposition !== "UNKNOWN" || payload.resolutionReason !== "UNRESOLVED_OR_NOT_VISIBLE"
    || Object.keys(payload).some((key) => !["kind", "requestBinding", "accessDisposition", "resolutionReason"].includes(key))) return false;
  const binding = payload.requestBinding;
  const subject = binding?.subject;
  const requestPayload = subject?.payload;
  return isDeepStrictEqual(subject, requestedSubject)
    && subject?.artifactType === "artifact-or-execution-reference"
    && requestPayload?.kind === "execution-reference"
    && typeof requestPayload.reference === "string" && requestPayload.reference.length > 0
    && Object.keys(requestPayload).every((key) => ["kind", "reference"].includes(key))
    && binding.resolutionDisposition === "UNKNOWN"
    && Object.keys(binding).every((key) => ["subject", "resolutionDisposition"].includes(key));
}

test("provenance request union is aligned with the exact typed P0 input and canonical identities", () => {
  assert.ok(contract.sourceRefs.includes(p0Capability));
  assert.equal(typedInput.sourceTypeRef, "capabilities.yaml#artifactType:artifact-or-execution-reference");
  assert.deepEqual(branches({ properties: { subject: typedInput.schema } }).map(({ properties }) => properties.kind.const), ["artifact", "execution-reference"]);
  assert.deepEqual(branches(contract.requestSchema).map(({ required, properties }) => ({ required, fields: Object.keys(properties) })), [
    { required: ["kind", "artifactId", "versionId"], fields: ["kind", "artifactId", "versionId", "sourceRef"] },
    { required: ["kind", "reference"], fields: ["kind", "reference"] },
  ]);
  for (const identity of ["processing-job", "job-attempt"]) {
    assert.ok(contract.sourceRefs.some((ref) => ref.endsWith(`/@objectId=media.domain.${identity}`)), `${identity} canonical identity source is referenced`);
  }
  assert.equal(binding.executionReferenceBranchDisposition.status, "ROUTE_OWNER_LOGICAL_CONTRACT_ACCEPTED");
  assert.equal(binding.executionReferenceBranchDisposition.decisionRef, ".product-experience/decision-log.md#PXD-152");
  assert.deepEqual(binding.executionReferenceBranchDisposition.acceptedIdentityRefs, [
    ".product-experience/pdp-1-domain-data/domain-objects.yaml#media.domain.processing-job",
    ".product-experience/pdp-1-domain-data/domain-objects.yaml#media.domain.job-attempt",
  ]);
  assert.deepEqual(binding.executionReferenceBranchDisposition.excludedIdentityRefs, [
    ".product-experience/pdp-1-domain-data/domain-objects.yaml#media.domain.media-run",
  ]);
  assert.match(contract.preconditions.join(" "), /exact opaque reference/u);
  assert.match(contract.preconditions.join(" "), /exactly one owner-authoritative canonical ProcessingJob or JobAttempt identity/u);
  assert.match(contract.preconditions.join(" "), /do not parse or guess/u);
  assert.match(contract.preconditions.join(" "), /authenticated tenant and current principal scope/u);
  assert.match(contract.preconditions.join(" "), /return semantic UNKNOWN/u);
  assert.match(contract.preconditions.join(" "), /if resolved, it must yield exactly one/u);
  assert.match(contract.preconditions.join(" "), /semantic UNKNOWN as a completed SUCCEEDED read/u);
  assert.match(contract.preconditions.join(" "), /resolutionDisposition UNKNOWN and generic UNRESOLVED_OR_NOT_VISIBLE reason/u);
  assert.match(contract.preconditions.join(" "), /no resolved identity, artifact-version identity, manifest, or lineage/u);
  assert.match(contract.preconditions.join(" "), /distinct from transport UNKNOWN_OUTCOME/u);
  assert.match(contract.preconditions.join(" "), /never coerced to artifactId or versionId/u);
  assert.match(contract.scopeStatus, /transport-and-runtime-NOT_ADMITTED/u);
  const decisionLog = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");
  const decision = decisionLog.split("### PXD-152")[1]?.split("### ")[0] ?? "";
  assert.match(decision, /completed `SUCCEEDED` read with `resolutionDisposition: UNKNOWN` and the generic `UNRESOLVED_OR_NOT_VISIBLE` reason/u);
  assert.match(decision, /distinct from transport `UNKNOWN_OUTCOME`/u);
});

test("execution lookup is restricted to the canonical identity allowlist and result binding", () => {
  const identities = wire.resultSchema.properties.outputs.items.oneOf[0].properties.payload.oneOf[0].properties.resolvedExecutionIdentity.oneOf;
  assert.deepEqual(identities.map(({ properties }) => properties.kind.const), ["ProcessingJob", "JobAttempt"]);
  assert.deepEqual(identities.map(({ required }) => required), [
    ["kind", "tenantId", "jobId"],
    ["kind", "tenantId", "jobId", "attemptId"],
  ]);
  const lineagePayload = wire.resultSchema.properties.outputs.items.oneOf[0].properties.payload.oneOf[0];
  const disclosurePayload = wire.resultSchema.properties.outputs.items.oneOf[0].properties.payload.oneOf[1];
  for (const payloadSchema of [lineagePayload, disclosurePayload]) {
    assert.ok(payloadSchema.required.includes("requestBinding"));
    assert.ok(payloadSchema.properties.resolvedExecutionIdentity.oneOf.length === 2);
    const artifactRule = payloadSchema.allOf.find(({ if: condition }) => condition?.properties?.requestBinding?.properties?.subject?.properties?.payload?.properties?.kind?.const === "artifact");
    const resolvedExecutionRule = payloadSchema.allOf.find(({ if: condition }) => condition?.properties?.requestBinding?.properties?.resolutionDisposition?.const === "RESOLVED_EXECUTION");
    const invalidExecutionRule = payloadSchema.allOf.find(({ if: condition }) => condition?.properties?.requestBinding?.properties?.resolutionDisposition?.const === "ARTIFACT_VERSION"
      && condition?.properties?.requestBinding?.properties?.subject?.properties?.payload?.properties?.kind?.const === "execution-reference");
    assert.ok(artifactRule?.then?.required?.includes("subjectArtifactVersionId"), "artifact results require an artifact-version identity");
    assert.ok(artifactRule?.then?.properties?.requestBinding?.properties?.resolutionDisposition?.const === "ARTIFACT_VERSION");
    assert.ok(artifactRule?.then?.not?.required?.includes("resolvedExecutionIdentity"));
    assert.ok(resolvedExecutionRule?.then?.required?.includes("resolvedExecutionIdentity"), "resolved execution results require their canonical identity");
    assert.ok(resolvedExecutionRule?.then?.not?.required?.includes("subjectArtifactVersionId"), "execution results forbid a subject artifact version");
    assert.deepEqual(invalidExecutionRule?.then?.not, {}, "execution references cannot be represented as ARTIFACT_VERSION results");
    assert.ok(payloadSchema.properties.subjectArtifactVersionId, "artifact version remains available for artifact branch binding");
  }
  const unknownPayload = wire.resultSchema.properties.outputs.items.oneOf[0].properties.payload.oneOf[2];
  assert.deepEqual(unknownPayload.required, ["kind", "requestBinding", "accessDisposition", "resolutionReason"]);
  assert.equal(unknownPayload.properties.kind.const, "resolution-unknown");
  assert.equal(unknownPayload.properties.requestBinding.properties.resolutionDisposition.const, "UNKNOWN");
  assert.equal(unknownPayload.properties.accessDisposition.const, "UNKNOWN");
  assert.equal(unknownPayload.properties.resolutionReason.const, "UNRESOLVED_OR_NOT_VISIBLE");
  assert.equal(unknownPayload.additionalProperties, false, "unknown resolution cannot carry identity, manifest, or lineage fields");
  assert.equal(unknownPayload.properties.requestBinding.properties.subject.$ref, "#/$defs/subject",
    "unknown results use the exact shared tagged subject definition");
  const requestSubjectBranches = contract.requestSchema.properties.subject.properties.payload.oneOf;
  const resultSubjectBranches = wire.resultSchema.$defs.subject.properties.payload.oneOf;
  const branchShape = (branches) => branches.map(({ required, properties }) => ({
    required,
    kind: properties.kind.const,
    fields: Object.keys(properties),
  }));
  assert.deepEqual(branchShape(resultSubjectBranches), branchShape(requestSubjectBranches),
    "the shared result subject definition preserves the request tags, fields, and branch requiredness");
  const artifactUnknownRule = unknownPayload.allOf.find(({ if: condition }) =>
    condition?.properties?.requestBinding?.properties?.subject?.properties?.payload?.properties?.kind?.const === "artifact");
  assert.deepEqual(artifactUnknownRule?.then?.not, {}, "artifact requests cannot use semantic unknown resolution");
  assert.match(contract.requestResultBinding.subjectArtifactVersionId, /EXACT_REQUEST_ARTIFACT_VERSION_ID/u);
  assert.match(contract.requestResultBinding.requestSubject, /EXACT_REQUEST_TAGGED_UNION/u);
  assert.match(contract.requestResultBinding.resolvedExecutionIdentity, /EXACTLY_ONE_AUTHORITATIVE/u);
  assert.ok(contract.resultSchema.fields.includes("requestSubject"));
  assert.match(contract.resultSchema.absence, /not proof that no lineage exists elsewhere/u);
  assert.match(contract.resultSchema.absence, /never disclose global absence/u);
  assert.match(contract.resultSchema.unresolvedExecutionReference, /distinct from transport UNKNOWN_OUTCOME/u);
  assert.match(contract.resultSchema.unresolvedExecutionReference, /no resolved identity, artifact-version identity, manifest, or lineage/u);
  assert.match(contract.finality, /read-only/u);
  assert.match(contract.authority.rights, /grants no processing/u);
  assert.match(contract.scopeStatus, /runtime-NOT_ADMITTED/u);
});

test("exclusive branches, malformed references, scope failures, and result mismatches fail closed", () => {
  const schema = contract.requestSchema;
  const validArtifact = { subject: { artifactType: "artifact-or-execution-reference", payload: { kind: "artifact", artifactId: "a1", versionId: "v1" } } };
  const validExecution = { subject: { artifactType: "artifact-or-execution-reference", payload: { kind: "execution-reference", reference: "opaque:job-ref" } } };
  assert.equal(validateRequestSchema(schema, validArtifact), true);
  assert.equal(validateRequestSchema(schema, validExecution), true);
  for (const invalid of [
    {},
    { subject: { artifactType: "artifact-or-execution-reference", payload: { kind: "artifact", artifactId: "a1", versionId: "v1", reference: "opaque:job-ref" } } },
    { subject: { artifactType: "artifact-or-execution-reference", payload: { kind: "artifact", artifactId: "a1" } } },
    { subject: { artifactType: "artifact-or-execution-reference", payload: { kind: "execution-reference", reference: "" } } },
    { subject: { artifactType: "artifact-or-execution-reference", payload: { kind: "job", reference: "opaque:job-ref" } } },
    { subject: { artifactType: "artifact-or-execution-reference", payload: { kind: "execution-reference", reference: "opaque:job-ref", artifactId: "a1" } } },
    { subject: { artifactType: "artifact-or-execution-reference", payload: { kind: "artifact", artifactId: "a1", versionId: "v1" } }, extra: true },
  ]) assert.equal(validateRequestSchema(schema, invalid), false);

  for (const negative of [
    "wrong-kind-execution-reference", "ambiguous-execution-reference", "unresolved-execution-reference-without-global-absence-disclosure",
    "cross-tenant-or-foreign-principal-execution-reference", "result-bound-to-different-request-or-different-execution-identity",
    "disclose-redacted-manifest-or-source-identifiers", "treat-absent-manifest-as-proof-of-no-lineage",
    "parse-or-guess-opaque-execution-reference-as-canonical-identity", "return-excluded-MediaRun-identity",
  ]) assert.ok(contract.negativeCases.includes(negative), `${negative} is an explicit negative case`);
  assert.match(contract.preconditions.join(" "), /unresolved, ambiguous, stale, foreign-scope, or wrong-kind/u);
  assert.match(contract.resultSchema.absence, /UNKNOWN/u);
  assert.ok(wire.resultSchema.properties.outputs.items.oneOf[0].properties.payload.oneOf[0].properties.completeness.enum.includes("PARTIAL_FOR_CALLER_VISIBLE_SCOPE"));
  assert.ok(wire.resultSchema.properties.outputs.items.oneOf[0].properties.payload.oneOf[0].properties.accessDisposition.enum.includes("PARTIALLY_REDACTED"));
});

test("result identity is required only for resolved execution references and cannot leak into other outcomes", () => {
  const requestedExecutionSubject = {
    artifactType: "artifact-or-execution-reference",
    payload: { kind: "execution-reference", reference: "opaque:exec-ref" },
  };
  const artifactResult = {
    requestBinding: {
      subject: { artifactType: "artifact-or-execution-reference", payload: { kind: "artifact", artifactId: "a1", versionId: "v1" } },
      resolutionDisposition: "ARTIFACT_VERSION",
    },
    subjectArtifactVersionId: "v1",
  };
  const executionResult = {
    requestBinding: {
      subject: { artifactType: "artifact-or-execution-reference", payload: { kind: "execution-reference", reference: "opaque:exec-ref" } },
      resolutionDisposition: "RESOLVED_EXECUTION",
    },
    resolvedExecutionIdentity: { kind: "JobAttempt", tenantId: "t1", jobId: "j1", attemptId: "at1" },
  };
  assert.equal(validateExecutionBinding("SUCCEEDED", artifactResult, artifactResult.requestBinding.subject), true);
  assert.equal(validateExecutionBinding("SUCCEEDED", executionResult, requestedExecutionSubject), true);
  const differentOpaqueReference = structuredClone(executionResult);
  differentOpaqueReference.requestBinding.subject.payload.reference = "opaque:other-ref";
  assert.equal(validateExecutionBinding("SUCCEEDED", differentOpaqueReference, requestedExecutionSubject), false,
    "a resolved result cannot be rebound to a different opaque request reference");
  const differentTag = structuredClone(executionResult);
  differentTag.requestBinding.subject.payload.kind = "artifact";
  assert.equal(validateExecutionBinding("SUCCEEDED", differentTag, requestedExecutionSubject), false,
    "a resolved result cannot change the request union tag");
  const unknownResolution = {
    kind: "resolution-unknown",
    requestBinding: {
      subject: { artifactType: "artifact-or-execution-reference", payload: { kind: "execution-reference", reference: "opaque:missing-ref" } },
      resolutionDisposition: "UNKNOWN",
    },
    accessDisposition: "UNKNOWN",
    resolutionReason: "UNRESOLVED_OR_NOT_VISIBLE",
  };
  assert.equal(validateUnknownResolution("SUCCEEDED", unknownResolution, {
    artifactType: "artifact-or-execution-reference",
    payload: { kind: "execution-reference", reference: "opaque:missing-ref" },
  }), true);
  assert.equal(validateUnknownResolution("SUCCEEDED", unknownResolution, requestedExecutionSubject), false,
    "an unresolved result must bind the exact original opaque reference");
  for (const invalid of [
    { ...unknownResolution, resolvedExecutionIdentity: { kind: "ProcessingJob", tenantId: "t1", jobId: "j1" } },
    { ...unknownResolution, manifestRefs: [] },
    { ...unknownResolution, lineageEdges: [] },
    { ...unknownResolution, subjectArtifactVersionId: "v1" },
    { ...unknownResolution, requestBinding: { ...unknownResolution.requestBinding, resolutionDisposition: "RESOLVED_EXECUTION" } },
    { ...unknownResolution, requestBinding: { subject: { artifactType: "artifact-or-execution-reference", payload: { kind: "artifact", artifactId: "a1", versionId: "v1" } }, resolutionDisposition: "UNKNOWN" } },
    { ...unknownResolution, requestBinding: { ...unknownResolution.requestBinding, subject: { artifactType: "artifact-or-execution-reference", payload: { kind: "execution-reference", reference: "opaque:missing-ref", artifactId: "a1" } } } },
  ]) assert.equal(validateUnknownResolution("SUCCEEDED", invalid, {
    artifactType: "artifact-or-execution-reference",
    payload: { kind: "execution-reference", reference: "opaque:missing-ref" },
  }), false);
  assert.equal(validateUnknownResolution("UNKNOWN_OUTCOME", unknownResolution, {
    artifactType: "artifact-or-execution-reference",
    payload: { kind: "execution-reference", reference: "opaque:missing-ref" },
  }), false, "transport uncertainty remains distinct");
  const artifactWithoutVersion = structuredClone(artifactResult);
  delete artifactWithoutVersion.subjectArtifactVersionId;
  for (const [outcome, payload] of [
    ["SUCCEEDED", { ...artifactResult, resolvedExecutionIdentity: { kind: "ProcessingJob", tenantId: "t1", jobId: "j1" } }],
    ["SUCCEEDED", artifactWithoutVersion],
    ["SUCCEEDED", { ...artifactResult, subjectArtifactVersionId: "v2" }],
    ["SUCCEEDED", { requestBinding: { ...executionResult.requestBinding } }],
    ["SUCCEEDED", { ...executionResult, requestBinding: { ...executionResult.requestBinding, resolutionDisposition: "ARTIFACT_VERSION" } }],
    ["SUCCEEDED", { ...executionResult, subjectArtifactVersionId: "v1" }],
    ["SUCCEEDED", { ...executionResult, resolvedExecutionIdentity: { kind: "MediaRun", tenantId: "t1", runId: "r1" } }],
    ["SUCCEEDED", { ...executionResult, requestBinding: { subject: executionResult.requestBinding.subject } }],
    ["SUCCEEDED", { ...executionResult, requestBinding: { ...executionResult.requestBinding, resolutionDisposition: "UNKNOWN" } }],
    ["SUCCEEDED", { ...executionResult, resolvedExecutionIdentity: { ...executionResult.resolvedExecutionIdentity, extra: "not-allowed" } }],
    ["UNKNOWN_OUTCOME", executionResult],
    ["REJECTED", executionResult],
  ]) assert.equal(validateExecutionBinding(outcome, payload), false);
  const rootOutcomes = wire.resultSchema.allOf;
  assert.ok(rootOutcomes.some(({ if: condition, then }) => condition?.properties?.outcome?.const === "REJECTED" && then?.properties?.outputs?.maxItems === 0));
  assert.ok(rootOutcomes.some(({ if: condition, then }) => condition?.properties?.outcome?.const === "UNKNOWN_OUTCOME" && then?.properties?.outputs?.maxItems === 0));
});

test("rejected provenance results bind the request and unresolved execution is never NOT_FOUND", () => {
  const validate = new Ajv({ allErrors: true, strict: false, validateFormats: false }).compile(wire.resultSchema);
  const base = {
    operationRef: "media.operation-slice.inspect-provenance",
    outcome: "REJECTED",
    observedAt: "2026-10-11T12:00:00Z",
    outputs: [],
    error: { code: "NOT_FOUND_IN_CALLER_SCOPE" },
  };
  const executionSubject = {
    artifactType: "artifact-or-execution-reference",
    payload: { kind: "execution-reference", reference: "opaque:missing-ref" },
  };
  const artifactSubject = {
    artifactType: "artifact-or-execution-reference",
    payload: { kind: "artifact", artifactId: "a1", versionId: "v1" },
  };
  assert.equal(validate({ ...base, requestSubject: executionSubject }), false,
    "an unresolved execution reference cannot be disguised as a not-found rejection");
  assert.equal(validate({ ...base, requestSubject: artifactSubject }), true,
    `artifact-version not-found behavior remains available: ${JSON.stringify(validate.errors)}`);
  assert.equal(validate({ ...base, requestSubject: executionSubject, error: { code: "ACCESS_DENIED" } }), true,
    "access denial remains distinct from unresolved execution lookup");
  assert.equal(validate(base), false, "rejected results must bind the exact tagged request subject");

  const unknownSuccess = {
    operationRef: "media.operation-slice.inspect-provenance",
    outcome: "SUCCEEDED",
    observedAt: "2026-10-11T12:00:00Z",
    outputs: [{
      artifactType: "minimized-provenance-record-or-disclosure",
      payload: {
        kind: "resolution-unknown",
        requestBinding: { subject: executionSubject, resolutionDisposition: "UNKNOWN" },
        accessDisposition: "UNKNOWN",
        resolutionReason: "UNRESOLVED_OR_NOT_VISIBLE",
      },
    }],
  };
  assert.equal(validate(unknownSuccess), true, `semantic UNKNOWN success remains valid: ${JSON.stringify(validate.errors)}`);
});
