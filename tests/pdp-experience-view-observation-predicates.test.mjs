import test from "node:test";
import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { readFile } from "node:fs/promises";
import { evaluateArtifactLifecycleObservation, evaluateLocalConnectivity, evaluateLocalDraftSnapshot, evaluateLocalRequestActivity, evaluateLocalUnknownOutcome, evaluateScopedMediaQuery, evaluateScopedStaleness, evaluateStoredJobStatus } from "../scripts/lib/media-view-observation-definition.mjs";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const Ajv2020 = require("ajv/dist/2020").default;
const addFormats = require("ajv-formats").default;
const root = process.cwd();
const dispositions = parse(await readFile(resolve(root, ".product-experience/pdp-3-product-experience/view-state-binding-dispositions.yaml"), "utf8"));
const definitions = parse(await readFile(resolve(root, ".product-experience/pdp-3-product-experience/view-observation-predicates.yaml"), "utf8"));
const inputContracts = parse(await readFile(resolve(root, ".product-experience/pdp-3-product-experience/view-observation-input-contracts.yaml"), "utf8"));
const viewState = parse(await readFile(resolve(root, ".product-experience/pdp-3-product-experience/view-state-binding-dispositions.yaml"), "utf8"));
const actionRegistry = parse(await readFile(resolve(root, ".product-experience/pdp-3-product-experience/action-registry.yaml"), "utf8"));
const sourceActions = new Map([...actionRegistry.actions, ...(actionRegistry.ownerDefinedActions ?? [])].map((action) => [action.id, action]));
const operationDocument = parse(await readFile(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));
const operationSources = new Map();
const addOperationSource = (operationRef, sourceRef) => {
  const rows = operationSources.get(operationRef) ?? new Set();
  rows.add(sourceRef);
  operationSources.set(operationRef, rows);
};
for (const key of ["individualOperationContracts", "ownerDefinedOperationContracts"]) {
  for (const record of operationDocument[key].records) addOperationSource(record.id, `.product-experience/pdp-1-domain-data/operations.yaml#${key}.records.${record.id}`);
}
for (const record of operationDocument.capabilityOperationContracts.records) {
  for (const operationRef of record.operationRefs ?? []) {
    addOperationSource(operationRef, `.product-experience/pdp-1-domain-data/operations.yaml#capabilityOperationContracts.records.${record.id}`);
  }
}
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function find(viewRef, label) {
  return definitions.predicates.find((row) => row.viewRef === viewRef && row.label === label);
}

const trusted = {
  viewRef: "media.view.find-projects",
  operationRef: "media.operation-slice.list-projects",
  tenantId: "tenant:alpha",
  principalId: "principal:operator",
  workspaceId: "workspace:one",
  queryId: "query:req-01",
  readVersion: "read:v4",
  readAuthorityRef: ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation",
  now: "2026-10-08T12:00:00.000Z",
  maxAgeMs: 60_000,
};

function scopedQueryFact(predicate, rows, overrides = {}) {
  return {
    viewRef: predicate.viewRef,
    operationRef: "media.operation-slice.list-projects",
    query: {
      tenantId: trusted.tenantId,
      principalId: trusted.principalId,
      workspaceId: trusted.workspaceId,
      queryId: trusted.queryId,
      rows,
      nextPageToken: null,
      observedAt: "2026-10-08T11:59:45.000Z",
      readVersion: "read:v4",
      readAuthorityRef: trusted.readAuthorityRef,
    },
    ...overrides,
  };
}
const trustedFor = (predicate) => ({ ...trusted, viewRef: predicate.viewRef });

test("all 47 view definitions enumerate every source label without treating a label or source pointer as evidence", () => {
  assert.equal(definitions.viewCount, 47);
  assert.equal(definitions.predicateCount, 364);
  assert.equal(definitions.predicates.length, 364);
  assert.equal(new Set(definitions.predicates.map((row) => row.predicateId)).size, 364);
  const expected = new Set(dispositions.views.flatMap((view) => view.displayedStates.map((label) => `${view.viewRef}:${label}`)));
  const actual = new Set(definitions.predicates.map((row) => `${row.viewRef}:${row.label}`));
  assert.deepEqual(actual, expected);
  assert.equal(viewState.views.length, 47);
  assert.equal(new Set(viewState.views.map((view) => view.dispositionId)).size, 47);
  assert.deepEqual(viewState.views.map((view) => view.id), viewState.views.map((view) => view.dispositionId));
  assert.ok(viewState.views.every((view) => view.dispositionId.startsWith("media.view-state-disposition.")));
  assert.ok(definitions.predicates.every((row) => row.predicateId.startsWith("media.view-observation.")));
  assert.equal(new Set(inputContracts.factSchemas.map((row) => row.id)).size, inputContracts.factSchemas.length);
  assert.ok(inputContracts.factSchemas.every((row) => row.id.startsWith("media.view-observation-schema.")));
  assert.equal(new Set(inputContracts.factSchemas.map((row) => row.factKind)).size, inputContracts.factSchemas.length);
  assert.ok(definitions.predicates.every((row) => row.id === row.predicateId));
  for (const row of definitions.predicates) {
    assert.ok(row.screenSourceRef);
    assert.ok(row.factScope);
    assert.ok(row.truthRules?.TRUE && row.truthRules?.FALSE && row.truthRules?.UNKNOWN);
    assert.equal("expectedValue" in row, false);
    assert.equal("positiveFixture" in row, false);
  }
});

test("no view-label enum is treated as an observation schema; unsupported fact families fail closed", () => {
  for (const contract of inputContracts.factSchemas) assert.equal("allowedValues" in contract, false, contract.id);
  const executable = new Set(inputContracts.factSchemas.filter((contract) => contract.closedSchema).map(({ factKind }) => factKind));
  assert.deepEqual([...executable].sort(), ["LOCAL_CONNECTIVITY", "LOCAL_DRAFT", "LOCAL_DRAFT_CLEAN", "LOCAL_INFLIGHT", "LOCAL_QUERY", "LOCAL_STALENESS", "LOCAL_UNKNOWN", "OWNER_ARTIFACT_STATE", "OWNER_JOB_STATE"]);
  for (const row of definitions.predicates) {
    if (!executable.has(row.factKind) && row.factKind !== "LOCAL_QUERY_EMPTY") {
      assert.equal(row.sourceStatus, "MEDIA_OWNER_DEFINITION; RUNTIME_NOT_ADMITTED");
    }
  }
});

test("project list labels derive from a fresh trusted query result, not a label or self-asserted currentness", () => {
  const populated = find("media.view.find-projects", "projects-available");
  const empty = find("media.view.find-projects", "workspace-empty");
  const querySchema = inputContracts.factSchemas.find(({ factKind }) => factKind === "LOCAL_QUERY").closedSchema;
  assert.equal(querySchema.additionalProperties, false);
  assert.equal(querySchema.properties.operationRef.const, "media.operation-slice.list-projects");
  assert.equal(querySchema.properties.query.properties.rows.items.additionalProperties, false);
  assert.deepEqual(querySchema.properties.query.properties.rows.items.properties.projectState.enum, ["ACTIVE", "ARCHIVED"]);
  const validateQuery = ajv.compile(querySchema);
  const schemaFact = scopedQueryFact(populated, [{ projectId: "project:1", workspaceId: trusted.workspaceId, title: "Project 1", headRevisionId: "revision:4", projectState: "ACTIVE" }]);
  assert.equal(validateQuery(schemaFact), true);
  assert.equal(validateQuery({ ...schemaFact, query: { ...schemaFact.query, extra: true } }), false);
  assert.ok(populated.factScope.operationRefs.includes("media.operation-slice.list-projects"));
  const project = { projectId: "project:1", workspaceId: trusted.workspaceId, title: "Project 1", headRevisionId: "revision:4", projectState: "ACTIVE" };
  assert.equal(evaluateScopedMediaQuery(populated, scopedQueryFact(populated, [project]), trustedFor(populated)).truth, "TRUE");
  assert.equal(evaluateScopedMediaQuery(populated, scopedQueryFact(populated, []), trustedFor(populated)).truth, "FALSE");
  assert.equal(evaluateScopedMediaQuery(empty, scopedQueryFact(empty, []), trustedFor(empty)).truth, "TRUE");
  assert.equal(evaluateScopedMediaQuery(empty, scopedQueryFact(empty, [project]), trustedFor(empty)).truth, "FALSE");
});

test("in-flight labels derive only from a fresh exact local request tuple and never assert remote finality", () => {
  const predicate = find("media.view.resume-work", "loading");
  const schema = inputContracts.factSchemas.find(({ factKind }) => factKind === "LOCAL_INFLIGHT");
  assert.deepEqual(schema.closedSchema.required, ["viewRef", "actionRef", "operationRef", "requestId", "activityState", "localStartedAt"]);
  assert.equal(schema.closedSchema.additionalProperties, false);
  assert.equal("allowedValues" in schema, false);
  const validateActivity = ajv.compile(schema.closedSchema);
  const context = {
    viewRef: predicate.viewRef, actionRef: null,
    operationRef: "media.operation-slice.list-projects", requestId: "request:local-01",
    now: trusted.now, maxAgeMs: 30_000,
  };
  const fact = {
    viewRef: predicate.viewRef, actionRef: null,
    operationRef: context.operationRef, requestId: context.requestId,
    activityState: "REQUEST_PENDING", localStartedAt: "2026-10-08T11:59:45.000Z",
  };
  assert.equal(validateActivity(fact), true);
  assert.equal(validateActivity({ ...fact, requestId: undefined }), false);
  assert.deepEqual(evaluateLocalRequestActivity(predicate, fact, context), {
    truth: "TRUE", reason: "EXACT_LOCAL_REQUEST_PENDING", remoteFinality: "NOT_ASSERTED",
  });
  assert.equal(evaluateLocalRequestActivity(predicate, { ...fact, activityState: "SETTLED" }, context).truth, "FALSE");
  assert.equal(evaluateLocalRequestActivity(predicate, { ...fact, requestId: "request:other" }, context).truth, "UNKNOWN");
  assert.equal(evaluateLocalRequestActivity(predicate, { ...fact, extra: true }, context).truth, "UNKNOWN");
  assert.equal(evaluateLocalRequestActivity(predicate, { ...fact, operationRef: "media.operation.forged" }, context).truth, "UNKNOWN");
  assert.equal(evaluateLocalRequestActivity(predicate, fact, { ...context, now: "2026-10-08T12:01:00.000Z" }).truth, "UNKNOWN");
  assert.equal(evaluateLocalRequestActivity(predicate, fact, { ...context, actionRef: "media.action.forged" }).truth, "UNKNOWN");
});

test("all 27 in-flight labels bind pending observations to a source action-operation tuple", () => {
  const rows = definitions.predicates.filter(({ factKind }) => factKind === "LOCAL_INFLIGHT");
  assert.equal(rows.length, 27);
  for (const predicate of rows) {
    const operationRef = predicate.factScope.operationRefs[0];
    const actionRef = predicate.factScope.actionRefs.length
      ? predicate.factScope.actionRefs.find((ref) => {
        const action = sourceActions.get(ref);
        return action && (action.operationRef === operationRef || action.actionDefinitionSemantics?.typedDefinition?.exactOperationRefs?.includes(operationRef));
      })
      : null;
    if (predicate.factScope.actionRefs.length) assert.ok(actionRef, `${predicate.id} has exact source action-operation pair`);
    const trustedContext = {
      viewRef: predicate.viewRef, actionRef, operationRef, requestId: `request:${predicate.id}`,
      now: "2026-10-08T12:00:00.000Z", maxAgeMs: 60_000,
    };
    const fact = {
      viewRef: predicate.viewRef, actionRef, operationRef, requestId: trustedContext.requestId,
      activityState: "REQUEST_PENDING", localStartedAt: "2026-10-08T11:59:45.000Z",
    };
    assert.deepEqual(evaluateLocalRequestActivity(predicate, fact, trustedContext), {
      truth: "TRUE", reason: "EXACT_LOCAL_REQUEST_PENDING", remoteFinality: "NOT_ASSERTED",
    }, predicate.id);
    assert.equal(evaluateLocalRequestActivity(predicate, { ...fact, activityState: "SETTLED" }, trustedContext).truth, "FALSE", predicate.id);
    assert.equal(evaluateLocalRequestActivity(predicate, { ...fact, operationRef: "media.operation.forged" }, trustedContext).truth, "UNKNOWN", predicate.id);
    assert.equal(evaluateLocalRequestActivity(predicate, fact, { ...trustedContext, now: "2026-10-08T12:01:00.000Z" }).truth, "UNKNOWN", predicate.id);
  }
});

test("offline labels derive from fresh exact client-local availability signals, not remote state", () => {
  const rows = definitions.predicates.filter((predicate) => predicate.factKind === "LOCAL_CONNECTIVITY");
  assert.equal(rows.length, 10);
  const schema = inputContracts.factSchemas.find(({ factKind }) => factKind === "LOCAL_CONNECTIVITY").closedSchema;
  const validate = ajv.compile(schema);
  for (const predicate of rows) {
    const trustedContext = {
      viewRef: predicate.viewRef, clientInstanceRef: "client:local-1",
      now: "2026-10-08T12:00:00.000Z", maxAgeMs: 30_000,
    };
    const fact = {
      viewRef: predicate.viewRef, clientInstanceRef: trustedContext.clientInstanceRef,
      observationId: "observation:network-1", reportedState: "CLIENT_NETWORK_UNAVAILABLE",
      observedAt: "2026-10-08T11:59:45.000Z",
    };
    assert.equal(validate(fact), true, predicate.id);
    assert.deepEqual(evaluateLocalConnectivity(predicate, fact, trustedContext), {
      truth: "TRUE", reason: "EXACT_FRESH_CLIENT_NETWORK_UNAVAILABLE_SIGNAL", remoteServiceState: "NOT_ASSERTED",
    });
    assert.equal(evaluateLocalConnectivity(predicate, { ...fact, reportedState: "CLIENT_NETWORK_AVAILABLE" }, trustedContext).truth, "FALSE");
    assert.equal(evaluateLocalConnectivity(predicate, { ...fact, reportedState: "UNKNOWN" }, trustedContext).truth, "UNKNOWN");
    assert.equal(evaluateLocalConnectivity(predicate, { ...fact, clientInstanceRef: "client:other" }, trustedContext).truth, "UNKNOWN");
    assert.equal(evaluateLocalConnectivity(predicate, { ...fact, observedAt: "2026-10-08T11:00:00.000Z" }, trustedContext).truth, "UNKNOWN");
    assert.equal(evaluateLocalConnectivity(predicate, { ...fact, extra: true }, trustedContext).truth, "UNKNOWN");
    assert.equal(evaluateLocalConnectivity({ ...predicate, connectivityObservation: { ...predicate.connectivityObservation, expectedReportedState: "CLIENT_NETWORK_AVAILABLE" } }, fact, trustedContext).truth, "UNKNOWN");
  }
});

test("stale labels compare an exact object/version snapshot against trusted currentness and age policy", () => {
  const predicate = find("media.view.find-projects", "stale-results");
  const staleSchema = inputContracts.factSchemas.find(({ factKind }) => factKind === "LOCAL_STALENESS").closedSchema;
  const validateStaleness = ajv.compile(staleSchema);
  const trustedContext = {
    viewRef: predicate.viewRef, operationRef: "media.operation-slice.list-projects", objectRef: "workspace:one",
    currentVersionRef: "read:v5", now: trusted.now, maxAgeMs: 60_000,
  };
  const fact = {
    viewRef: predicate.viewRef, operationRef: trustedContext.operationRef, objectRef: trustedContext.objectRef,
    snapshotVersionRef: "read:v4", observedAt: "2026-10-08T11:59:45.000Z",
  };
  assert.equal(validateStaleness(fact), true);
  assert.equal(validateStaleness({ ...fact, extra: true }), false);
  assert.deepEqual(evaluateScopedStaleness(predicate, fact, trustedContext), { truth: "TRUE", reason: "EXACT_VERSION_SUPERSEDED" });
  assert.equal(evaluateScopedStaleness(predicate, { ...fact, snapshotVersionRef: "read:v5" }, trustedContext).truth, "FALSE");
  assert.equal(evaluateScopedStaleness(predicate, { ...fact, snapshotVersionRef: "read:v5", observedAt: "2026-10-08T11:00:00.000Z" }, trustedContext).truth, "TRUE");
  assert.equal(evaluateScopedStaleness(predicate, { ...fact, objectRef: "workspace:other" }, trustedContext).truth, "UNKNOWN");
  assert.equal(evaluateScopedStaleness(predicate, { ...fact, currentness: "CURRENT" }, trustedContext).truth, "UNKNOWN");
});

test("query predicates fail closed on absent scope, stale reads, incomplete empty pages, malformed facts, or wrong source", () => {
  const row = find("media.view.find-projects", "workspace-empty");
  const base = scopedQueryFact(row, []);
  const context = trustedFor(row);
  assert.equal(evaluateScopedMediaQuery(row, { ...base, query: { ...base.query, nextPageToken: "page:next" } }, context).truth, "UNKNOWN");
  assert.equal(evaluateScopedMediaQuery(row, { ...base, query: { ...base.query, observedAt: "2026-10-08T11:00:00.000Z" } }, context).truth, "UNKNOWN");
  assert.equal(evaluateScopedMediaQuery(row, { ...base, query: { ...base.query, workspaceId: "workspace:other" } }, context).truth, "UNKNOWN");
  assert.equal(evaluateScopedMediaQuery(row, { ...base, operationRef: "media.operation.forged" }, context).truth, "UNKNOWN");
  assert.equal(evaluateScopedMediaQuery(row, { ...base, viewRef: "media.view.forged" }, context).truth, "UNKNOWN");
  assert.equal(evaluateScopedMediaQuery(row, { ...base, extra: "forged" }, context).truth, "UNKNOWN");
  assert.equal(evaluateScopedMediaQuery(row, { ...base, query: { ...base.query, extra: true } }, context).truth, "UNKNOWN");
  assert.equal(evaluateScopedMediaQuery(row, scopedQueryFact(row, [null]), context).truth, "UNKNOWN");
  assert.equal(evaluateScopedMediaQuery(row, scopedQueryFact(row, [{ projectId: "project:1", workspaceId: "workspace:other", title: "x", headRevisionId: "r1", projectState: "ACTIVE" }]), context).truth, "UNKNOWN");
  assert.equal(evaluateScopedMediaQuery(row, base, { ...context, operationRef: "media.operation.forged" }).truth, "UNKNOWN");
  assert.equal(evaluateScopedMediaQuery(row, base, { ...context, readVersion: "read:v5" }).truth, "UNKNOWN");
  assert.equal(evaluateScopedMediaQuery(row, { ...base, query: { ...base.query, readAuthorityRef: "forged" } }, context).truth, "UNKNOWN");
  assert.equal(evaluateScopedMediaQuery(row, { ...base, query: { ...base.query, rows: null } }, context).truth, "UNKNOWN");
  assert.equal(evaluateScopedMediaQuery(row, base, { ...context, now: "2026-02-31T12:00:00.000Z" }).truth, "UNKNOWN");
  assert.equal(evaluateScopedMediaQuery(row, null, trusted).truth, "UNKNOWN");
});

test("labels whose current owner query schema cannot support a state remain explicitly unsupported", () => {
  const job = find("media.view.job-status", "completed");
  assert.equal(job.sourceStatus, "MEDIA_OWNER_DEFINITION; RUNTIME_NOT_ADMITTED");
  assert.equal(job.jobStatusObservation.runtimeStatus, "COMPLETED");
  assert.equal(job.jobStatusObservation.mappingDisposition, "NOT_MAPPED_RUNTIME_ONLY");
  assert.match(job.jobStatusObservation.nonMappingReason, /registered outputs/i);
  const unknownJob = find("media.view.job-status", "outcome-unknown");
  assert.equal(unknownJob.jobStatusObservation.mappingDisposition, "EXACT_CANONICAL_STATE");
  assert.match(unknownJob.jobStatusObservation.canonicalStateRef, /media-job\/stateDefinitions\/OUTCOME_UNKNOWN/);
  const artifact = find("media.view.inspect-media", "available");
  assert.match(artifact.sourceFieldStatus, /TYPED_LIFECYCLE_QUERY_DEFINITION_ONLY/);
  assert.match(artifact.canonicalObservationLimitation, /runtime route and support are not admitted/i);
});

test("artifact lifecycle predicates bind the exact proposed read model, immutable version, evidence and currentness", () => {
  const predicate = find("media.view.inspect-media", "available");
  const state = "AVAILABLE";
  const base = ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-upload-and-artifact/stateDefinitions";
  const trustedContext = {
    viewRef: predicate.viewRef,
    operationRef: "media.operation.artifact.lifecycle.observe.v1",
    tenantId: "tenant:alpha", principalId: "principal:operator", artifactId: "artifact:one",
    artifactVersionId: "artifact-version:4", stateRevision: 7, readVersion: 12,
    stateAuthorityRef: ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-upload-and-artifact",
    stateEvidenceRef: ".product-experience/pdp-1-domain-data/events.yaml#artifact-lifecycle-state-evidence/record-77",
    now: trusted.now, maxAgeMs: 60_000,
  };
  const observation = {
    artifactId: trustedContext.artifactId, artifactVersionId: trustedContext.artifactVersionId,
    lifecycleState: state, canonicalStateRef: `${base}/${state}`, meaningSourceRef: `${base}/${state}/meaning`,
    tenantId: trustedContext.tenantId, principalId: trustedContext.principalId,
    stateRevision: trustedContext.stateRevision, observedAt: "2026-10-08T11:59:45.000Z",
    stateAuthorityRef: trustedContext.stateAuthorityRef, stateEvidenceRef: trustedContext.stateEvidenceRef,
    readVersion: trustedContext.readVersion,
  };
  const fact = { viewRef: predicate.viewRef, queryResult: {
    operationRef: "media.operation.artifact.lifecycle.observe.v1", outcome: "OBSERVED",
    observedAt: observation.observedAt, observation,
  } };
  assert.equal(predicate.artifactLifecycleObservation.queryOperationRef, trustedContext.operationRef);
  assert.deepEqual(predicate.factScope.operationRefs, [trustedContext.operationRef]);
  const schema = inputContracts.factSchemas.find(({ factKind }) => factKind === "OWNER_ARTIFACT_STATE").closedSchema;
  assert.equal(schema.additionalProperties, false);
  assert.deepEqual(schema.properties.queryResult.$ref,
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts.records.media.operation.artifact.lifecycle.observe.v1.ownerWireSchema.resultSchema");
  assert.deepEqual(evaluateArtifactLifecycleObservation(predicate, fact, trustedContext), {
    truth: "TRUE", reason: "EXACT_SCOPED_ARTIFACT_LIFECYCLE_OBSERVATION", canonicalStateRef: `${base}/${state}`,
  });
  const differentState = { ...fact, queryResult: { ...fact.queryResult, observation: {
    ...observation, lifecycleState: "QUARANTINED", canonicalStateRef: `${base}/QUARANTINED`,
    meaningSourceRef: `${base}/QUARANTINED/meaning`,
  } } };
  assert.deepEqual(evaluateArtifactLifecycleObservation(predicate, differentState, trustedContext), {
    truth: "FALSE", reason: "EXACT_SCOPED_ARTIFACT_LIFECYCLE_STATE_DIFFERS", canonicalStateRef: `${base}/QUARANTINED`,
  });
  const unknown = { viewRef: predicate.viewRef, queryResult: {
    operationRef: trustedContext.operationRef, outcome: "UNKNOWN_OUTCOME", observedAt: observation.observedAt,
    unknownReason: "AUTHORITATIVE_LIFECYCLE_READ_NOT_IMPLEMENTED",
  } };
  assert.equal(evaluateArtifactLifecycleObservation(predicate, unknown, trustedContext).truth, "UNKNOWN");
  for (const [badFact, badContext] of [
    [{ ...fact, queryResult: { ...fact.queryResult, observation: { ...observation, tenantId: "tenant:other" } } }, trustedContext],
    [fact, { ...trustedContext, artifactVersionId: "artifact-version:other" }],
    [fact, { ...trustedContext, stateEvidenceRef: "evidence:other" }],
    [fact, { ...trustedContext, stateAuthorityRef: "authority:other" }],
    [{ ...fact, queryResult: { ...fact.queryResult, observation: { ...observation, canonicalStateRef: `${base}/REJECTED` } } }, trustedContext],
    [{ ...fact, queryResult: { ...fact.queryResult, observation: { ...observation, stateRevision: 8 } } }, trustedContext],
    [{ ...fact, queryResult: { ...fact.queryResult, observedAt: "2026-10-08T11:00:00.000Z" } }, trustedContext],
    [{ ...fact, queryResult: { ...fact.queryResult, observation: { ...observation, extra: true } } }, trustedContext],
    [{ ...fact, queryResult: { ...fact.queryResult, observation: { ...observation, observedAt: "2026-02-31T11:59:45.000Z" } } }, trustedContext],
    [fact, { ...trustedContext, now: "2026-10-08T12:01:00.000Z" }],
  ]) assert.equal(evaluateArtifactLifecycleObservation(predicate, badFact, badContext).truth, "UNKNOWN");
});

test("stored job observations bind exact owner read scope and map only OUTCOME_UNKNOWN", () => {
  const predicate = find("media.view.job-status", "outcome-unknown");
  const unknownStateRef = ".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-job/stateDefinitions/OUTCOME_UNKNOWN";
  const queryTrusted = {
    viewRef: predicate.viewRef,
    operationRef: "media.operation-slice.inspect-job",
    tenantId: "tenant:alpha",
    principalId: "principal:operator",
    jobId: "job:one",
    requestId: "request:one",
    requestFingerprint: "sha256:" + "a".repeat(64),
    readVersion: 4,
    readAuthorityRef: ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation",
    now: trusted.now,
    maxAgeMs: 60_000,
  };
  const result = {
    outcome: "OBSERVED",
    operationRef: queryTrusted.operationRef,
    operationVersion: 1,
    tenantId: queryTrusted.tenantId,
    principalId: queryTrusted.principalId,
    job: {
      jobId: queryTrusted.jobId, requestId: "request:one", tenantId: queryTrusted.tenantId,
      principalId: queryTrusted.principalId, artifactId: "artifact:one", jobType: "TRANSCODE", providerId: null,
      status: "OUTCOME_UNKNOWN", createdAt: "2026-10-08T11:58:00.000Z", startedAt: "2026-10-08T11:58:01.000Z",
      completedAt: null, result: {}, failureCode: null, version: 7, requestFingerprint: "sha256:" + "a".repeat(64),
    },
    readObservation: {
      tenantId: queryTrusted.tenantId, principalId: queryTrusted.principalId, readVersion: queryTrusted.readVersion,
      observedAt: "2026-10-08T11:59:45.000Z", readAuthorityRef: queryTrusted.readAuthorityRef,
      effectFinality: "OUTCOME_UNKNOWN",
      canonicalStateMapping: {
        sourceStatus: "OUTCOME_UNKNOWN", disposition: "EXACT_CANONICAL_STATE", canonicalStateRef: unknownStateRef,
        reason: "Both source and PDP-1 explicitly preserve uncertainty that an external effect may have occurred without a known result; this does not establish completion, failure, replay safety, or provider reconciliation.",
      },
    },
  };
  const fact = { viewRef: predicate.viewRef, queryResult: result };
  const wrapperSchema = inputContracts.factSchemas.find(({ factKind }) => factKind === "OWNER_JOB_STATE").closedSchema;
  assert.equal(wrapperSchema.additionalProperties, false);
  assert.deepEqual(wrapperSchema.properties.queryResult.$ref,
    ".product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts.records.media.operation-slice.inspect-job.ownerWireSchema.resultSchema");
  assert.deepEqual(evaluateStoredJobStatus(predicate, fact, queryTrusted), {
    truth: "TRUE", reason: "EXACT_TYPED_JOB_STATUS_AND_CANONICAL_MAPPING", canonicalStateRef: unknownStateRef, runtimeStatus: "OUTCOME_UNKNOWN",
  });
  for (const [badFact, badTrusted] of [
    [{ ...fact, extra: true }, queryTrusted],
    [fact, { ...queryTrusted, tenantId: "tenant:other" }],
    [fact, { ...queryTrusted, principalId: "principal:other" }],
    [fact, { ...queryTrusted, jobId: "job:other" }],
    [fact, { ...queryTrusted, readVersion: 6 }],
    [fact, { ...queryTrusted, readAuthorityRef: "forged" }],
    [fact, { ...queryTrusted, now: "2026-02-31T12:00:00.000Z" }],
    [{ ...fact, queryResult: { ...result, operationRef: "media.operation.forged" } }, queryTrusted],
    [{ ...fact, queryResult: { ...result, job: { ...result.job, status: "COMPLETED" } } }, queryTrusted],
    [{ ...fact, queryResult: { ...result, readObservation: { ...result.readObservation, canonicalStateMapping: { ...result.readObservation.canonicalStateMapping, canonicalStateRef: "forged" } } } }, queryTrusted],
    [{ ...fact, queryResult: { ...result, readObservation: { ...result.readObservation, effectFinality: "NOT_TERMINAL" } } }, queryTrusted],
    [{ ...fact, queryResult: { ...result, job: { ...result.job, extra: true } } }, queryTrusted],
    [fact, { ...queryTrusted, now: "2026-10-08T12:01:00.000Z" }],
  ]) assert.equal(evaluateStoredJobStatus(predicate, badFact, badTrusted).truth, "UNKNOWN");

  const completed = structuredClone(result);
  completed.job.status = "COMPLETED";
  completed.readObservation.effectFinality = "OUTPUT_REGISTRATION_UNVERIFIED";
  completed.readObservation.canonicalStateMapping = {
    sourceStatus: "COMPLETED", disposition: "NOT_MAPPED_RUNTIME_ONLY",
    reason: "The stored response does not establish verified outputs are registered and satisfy the accepted result contract required by PDP-1 COMPLETED.",
  };
  assert.equal(evaluateStoredJobStatus(predicate, { ...fact, queryResult: completed }, queryTrusted).truth, "UNKNOWN");
});

test("local draft observations compare exact current snapshot and base across every typed draft label", () => {
  const rows = definitions.predicates.filter(({ factKind }) => ["LOCAL_DRAFT", "LOCAL_DRAFT_CLEAN"].includes(factKind));
  assert.equal(rows.length, 21);
  for (const predicate of rows) {
    const expected = predicate.factKind === "LOCAL_DRAFT" ? "DIFFERENT" : "EQUAL";
    assert.equal(predicate.draftObservation.expectedStructuralRelation, expected);
    assert.equal(predicate.draftObservation.comparison, "CANONICAL_JSON_STRUCTURAL_EQUALITY");
    assert.equal(predicate.draftObservation.persistenceClaim, "NONE; owner receipt/read required to assert stored state");
    assert.equal(predicate.factSchemaRef,
      `.product-experience/pdp-3-product-experience/view-observation-input-contracts.yaml#factSchemas.media.view-observation-schema.local-draft${predicate.factKind === "LOCAL_DRAFT_CLEAN" ? "-clean" : ""}.v1`);
    const schema = inputContracts.factSchemas.find(({ factKind }) => factKind === predicate.factKind).closedSchema;
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ["viewRef", "sessionId", "draftId", "draftRevision", "baseVersionRef", "draftValue", "baseValue", "observedAt"]);
    const trustedContext = {
      viewRef: predicate.viewRef, sessionId: "session:exact", draftId: "draft:exact", baseVersionRef: "version:base",
      now: "2026-10-08T12:00:00.000Z", maxAgeMs: 60_000,
    };
    const dirtyFact = {
      viewRef: predicate.viewRef, sessionId: trustedContext.sessionId, draftId: trustedContext.draftId,
      draftRevision: 2, baseVersionRef: trustedContext.baseVersionRef,
      draftValue: { title: "edited", nested: { b: 2, a: 1 } },
      baseValue: { nested: { a: 1, b: 2 }, title: "base" }, observedAt: "2026-10-08T11:59:45.000Z",
    };
    const cleanFact = { ...dirtyFact, draftValue: { title: "same", nested: [1, 2] }, baseValue: { nested: [1, 2], title: "same" } };
    const trueFact = expected === "DIFFERENT" ? dirtyFact : cleanFact;
    const falseFact = expected === "DIFFERENT" ? cleanFact : dirtyFact;
    const validateDraftFact = ajv.compile(schema);
    assert.equal(validateDraftFact(trueFact), true, predicate.id);
    assert.equal(validateDraftFact({ ...trueFact, extra: true }), false, predicate.id);
    assert.deepEqual(evaluateLocalDraftSnapshot(predicate, trueFact, trustedContext), {
      truth: "TRUE", reason: "EXACT_LOCAL_DRAFT_BASE_COMPARISON", structuralRelation: expected, persistedState: "NOT_ASSERTED",
    }, predicate.id);
    assert.equal(evaluateLocalDraftSnapshot(predicate, falseFact, trustedContext).truth, "FALSE", predicate.id);
    for (const [badFact, badTrusted] of [
      [null, trustedContext],
      [{ ...trueFact, sessionId: "session:other" }, trustedContext],
      [trueFact, { ...trustedContext, baseVersionRef: "version:other" }],
      [{ ...trueFact, draftValue: Number.NaN }, trustedContext],
      [{ ...trueFact, draftValue: { self: null, extra: undefined } }, trustedContext],
      [{ ...trueFact, observedAt: "2026-02-31T11:59:45.000Z" }, trustedContext],
      [trueFact, { ...trustedContext, now: "2026-10-08T12:01:00.000Z" }],
      [trueFact, { ...trustedContext, extra: true }],
    ]) assert.equal(evaluateLocalDraftSnapshot(predicate, badFact, badTrusted).truth, "UNKNOWN", predicate.id);
    const accessorFact = { ...trueFact };
    Object.defineProperty(accessorFact, "draftValue", { enumerable: true, get: () => trueFact.draftValue });
    assert.equal(evaluateLocalDraftSnapshot(predicate, accessorFact, trustedContext).truth, "UNKNOWN", predicate.id);
    const symbolFact = { ...trueFact, [Symbol("untrusted")]: true };
    assert.equal(evaluateLocalDraftSnapshot(predicate, symbolFact, trustedContext).truth, "UNKNOWN", predicate.id);
  }
});

test("all unknown-outcome labels bind exact action-operation tuples to local loss-of-response facts only", () => {
  const rows = definitions.predicates.filter(({ factKind }) => factKind === "LOCAL_UNKNOWN");
  assert.equal(rows.length, 18);
  const schema = inputContracts.factSchemas.find(({ factKind }) => factKind === "LOCAL_UNKNOWN");
  assert.equal(schema.closedSchema.additionalProperties, false);
  const validate = ajv.compile(schema.closedSchema);
  for (const predicate of rows) {
    const pairs = predicate.unknownOutcomeObservation.allowedActionOperationPairs;
    assert.doesNotMatch(predicate.unknownOutcomeObservation.negativeCondition ?? '', /response was received/u, predicate.id);
    if (pairs.length === 0) {
      assert.equal(predicate.factScope.actionRefs.length, 0, predicate.id);
      const queryRef = predicate.unknownOutcomeObservation.unsupportedQueryFinality.operationRef;
      const querySourceRef = predicate.unknownOutcomeObservation.unsupportedQueryFinality.operationSourceRef;
      assert.deepEqual(predicate.factScope.operationRefs, [queryRef], predicate.id);
      assert.equal(predicate.unknownOutcomeObservation.unsupportedQueryFinality.outcome, "UNKNOWN_UNTIL_EXACT_TYPED_QUERY_RESULT", predicate.id);
      assert.equal(predicate.unknownOutcomeObservation.positiveCondition.startsWith("none;"), true, predicate.id);
      assert.match(predicate.meaning, /does not establish|does not prove|preserve UNKNOWN|stays UNKNOWN|Keep this label UNKNOWN/u, predicate.id);
      assert.equal(predicate.sourceStatus, "QUERY_LABEL_BINDING_PENDING_EXACT_TYPED_RESULT; RUNTIME_NOT_ADMITTED", predicate.id);
      assert.ok(operationSources.get(queryRef)?.has(querySourceRef), predicate.id);
      assert.equal(evaluateLocalUnknownOutcome(predicate, {}, {}).truth, "UNKNOWN", predicate.id);
      assert.equal(evaluateLocalUnknownOutcome(predicate, {}, {}).reason, "MALFORMED_OR_NONCLOSED_UNKNOWN_OUTCOME_INPUT", predicate.id);
      continue;
    }
    assert.match(predicate.unknownOutcomeObservation.negativeCondition, /NOT_SENT together with NOT_WAITED/u, predicate.id);
    assert.match(predicate.unknownOutcomeObservation.unknownCondition, /response received but not validated/u, predicate.id);
    const pair = pairs[0];
    assert.ok(sourceActions.has(pair.actionRef), predicate.id);
    assert.equal(pair.actionSourceRef, `.product-experience/pdp-3-product-experience/action-registry.yaml#${pair.actionRef}`);
    assert.ok(operationSources.get(pair.operationRef)?.has(pair.operationSourceRef));
    assert.ok(predicate.unknownOutcomeObservation.sourceRefs.includes(pair.actionSourceRef));
    assert.ok(predicate.unknownOutcomeObservation.sourceRefs.includes(pair.operationSourceRef));
    const action = sourceActions.get(pair.actionRef);
    assert.ok(action.actionDefinitionSemantics.typedDefinition.exactOperationRefs.includes(pair.operationRef), predicate.id);
    assert.ok(predicate.factScope.actionRefs.includes(pair.actionRef) && predicate.factScope.operationRefs.includes(pair.operationRef), predicate.id);
    const trustedContext = {
      viewRef: predicate.viewRef, actionRef: pair.actionRef, operationRef: pair.operationRef,
      requestId: `request:${predicate.id}`, requestFingerprint: `sha256:${"a".repeat(64)}`,
      sendObservationRef: `local-send-observation:${predicate.id}`,
      now: "2026-10-08T12:00:00.000Z", maxAgeMs: 60_000,
    };
    const fact = {
      viewRef: predicate.viewRef, actionRef: pair.actionRef, operationRef: pair.operationRef,
      requestId: trustedContext.requestId, requestFingerprint: trustedContext.requestFingerprint,
      sendObservationRef: trustedContext.sendObservationRef, sendDisposition: "TRANSPORT_WRITE_CONFIRMED",
      waitDisposition: "TIMEOUT", sendObservedAt: "2026-10-08T11:59:40.000Z", waitObservedAt: "2026-10-08T11:59:45.000Z",
    };
    assert.equal(validate(fact), true, predicate.id);
    assert.deepEqual(evaluateLocalUnknownOutcome(predicate, fact, trustedContext), {
      truth: "TRUE", reason: "LOCAL_SENT_REQUEST_RESPONSE_NOT_OBSERVED", serverOutcome: "UNKNOWN_NOT_ASSERTED", retryAuthorization: "NONE",
    }, predicate.id);
    assert.equal(evaluateLocalUnknownOutcome(predicate, { ...fact, sendDisposition: "NOT_SENT", waitDisposition: "NOT_WAITED" }, trustedContext).truth, "FALSE", predicate.id);
    assert.equal(evaluateLocalUnknownOutcome(predicate, { ...fact, sendDisposition: "NOT_SENT", waitDisposition: "TIMEOUT" }, trustedContext).truth, "UNKNOWN", predicate.id);
    assert.equal(evaluateLocalUnknownOutcome(predicate, { ...fact, waitDisposition: "RESPONSE_RECEIVED" }, trustedContext).truth, "UNKNOWN", predicate.id);
    assert.equal(evaluateLocalUnknownOutcome(predicate, { ...fact, waitDisposition: "ACK_PENDING" }, trustedContext).truth, "UNKNOWN", predicate.id);
    assert.equal(validate({ ...fact, waitDisposition: "ACK_PENDING" }), false, predicate.id);
    assert.equal(evaluateLocalUnknownOutcome(predicate, { ...fact, responseRef: "foreign:response" }, trustedContext).truth, "UNKNOWN", predicate.id);
    assert.equal(evaluateLocalUnknownOutcome(predicate, { ...fact, sendDisposition: "WRITE_IN_PROGRESS", waitDisposition: "INTERRUPTED" }, trustedContext).truth, "UNKNOWN", predicate.id);
    assert.equal(evaluateLocalUnknownOutcome(predicate, { ...fact, waitDisposition: "INTERRUPTED", sendDisposition: "UNKNOWN" }, trustedContext).truth, "UNKNOWN", predicate.id);
    assert.equal(evaluateLocalUnknownOutcome(predicate, { ...fact, sendDisposition: "UNKNOWN" }, trustedContext).truth, "UNKNOWN", predicate.id);
    assert.equal(evaluateLocalUnknownOutcome(predicate, { ...fact, responseDisposition: "OUTCOME_UNKNOWN" }, trustedContext).truth, "UNKNOWN", predicate.id);
    assert.equal(validate({ ...fact, responseDisposition: "ACCEPTED" }), false, predicate.id);
    assert.equal(evaluateLocalUnknownOutcome(predicate, { ...fact, operationRef: "media.operation.forged" }, trustedContext).truth, "UNKNOWN", predicate.id);
    assert.equal(evaluateLocalUnknownOutcome(predicate, fact, { ...trustedContext, requestFingerprint: `sha256:${"b".repeat(64)}` }).truth, "UNKNOWN", predicate.id);
    assert.equal(evaluateLocalUnknownOutcome(predicate, { ...fact, waitObservedAt: "2026-02-31T11:59:45.000Z" }, trustedContext).truth, "UNKNOWN", predicate.id);
    assert.equal(evaluateLocalUnknownOutcome(predicate, fact, { ...trustedContext, now: "2026-10-08T12:01:00.000Z" }).truth, "UNKNOWN", predicate.id);
  }
});
