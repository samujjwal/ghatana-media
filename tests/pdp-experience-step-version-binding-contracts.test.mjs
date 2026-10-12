import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import test from "node:test";
import { evaluatePdp3CanonicalVersionTuple, evaluatePdp3CaptionPairSourceVersionJoin, evaluatePdp3ConsentRevisionVersionJoin } from "../scripts/lib/pdp3-experience-journey-step-projection.mjs";

const parse = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url))("yaml").parse;
const root = ".product-experience/pdp-3-product-experience";
const versionSource = parse(await readFile(`${root}/step-version-binding-contracts.yaml`, "utf8"));
const purposeSource = parse(await readFile(`${root}/journey-purpose-bindings.yaml`, "utf8"));
const localVersionSource = parse(await readFile(`${root}/local-step-effect-contracts.yaml`, "utf8"));
const oracle = parse(await readFile(`${root}/step-definition-oracles.yaml`, "utf8"));
const identities = parse(await readFile(".product-experience/pdp-1-domain-data/domain-objects.yaml", "utf8"));
const operations = parse(await readFile(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"));
const localEffects = parse(await readFile(`${root}/local-step-effect-contracts.yaml`, "utf8"));
const invocationAdapters = parse(await readFile(`${root}/capability-invocation-adapters.yaml`, "utf8"));
const valueTypes = parse(await readFile(".product-experience/pdp-2-design-interface-system/component-value-types.yaml", "utf8"));
const contracts = new Map();
for (const filename of (await readdir(`${root}/journey-contracts`)).filter((name) => name.endsWith(".yaml"))) {
  const document = parse(await readFile(`${root}/journey-contracts/${filename}`, "utf8"));
  for (const [index, step] of document.steps.entries()) {
    contracts.set(`${root}/journey-contracts/${filename}#/steps/${index}`, { document, step });
  }
}
const oracleSteps = new Map(oracle.journeys.flatMap(({ steps }) => steps.map((step) => [step.sourceRef, step])));
const identityByObject = new Map(identities.ownerTypedIdentityContracts.records.map((row) => [row.objectRef, row]));
const excludedHistoricalIdentityByObject = new Map((identities.canonicalIdentityAdjudication?.excludedHistoricalRecords ?? [])
  .map((row) => [row.objectId, row]));
const operationById = new Map();
for (const collection of [
  ["ownerDefinedOperationContracts/records", operations.ownerDefinedOperationContracts?.records],
  ["individualOperationContracts/records", operations.individualOperationContracts?.records],
  ["capabilityOperationContracts/records", operations.capabilityOperationContracts?.records],
  ["operations", operations.operations],
]) for (const row of collection[1] ?? []) if (row?.id) operationById.set(row.id, { row, collection: collection[0] });
const localBySource = new Map(localEffects.records.map((row) => [row.sourceRef, row]));

function resolveRequestSchema(operationRef) {
  const entry = operationById.get(operationRef);
  if (!entry) return null;
  return entry.row.requestSchema ?? entry.row.ownerWireSchema?.requestSchema ?? entry.row.inputSchema ?? null;
}

function resolveResultSchema(operationRef) {
  const entry = operationById.get(operationRef);
  if (!entry) return null;
  return entry.row.resultSchema ?? entry.row.ownerWireSchema?.resultSchema ?? null;
}

function fieldNameFromPath(path) {
  return path.at(-1);
}

function resolveSourceRef(reference) {
  const [file, selector] = reference.split("#", 2);
  const document = file.endsWith("operations.yaml") ? operations
    : file.endsWith("domain-objects.yaml") ? identities
      : file.endsWith("step-definition-oracles.yaml") ? oracle
        : file.endsWith("local-step-effect-contracts.yaml") ? localEffects
          : file.endsWith("capability-invocation-adapters.yaml") ? invocationAdapters
          : file.endsWith("component-value-types.yaml") ? valueTypes
        : null;
  if (!document || !selector) return null;
  let node = document;
  const parts = selector.split("/").filter(Boolean);
  for (let index = 0; index < parts.length; index += 1) {
    const part = parts[index];
    if (part.startsWith("@id=")) {
      const id = part.slice("@id=".length);
      if (!Array.isArray(node)) return null;
      node = node.find((record) => record?.id === id) ?? null;
    } else {
      node = node?.[part] ?? null;
    }
    if (node === null || node === undefined) return null;
  }
  return node;
}

test("all 130 step version-binding definitions join exact journey and P1 identity sources", () => {
  assert.equal(versionSource.recordCount, 130);
  assert.equal(versionSource.records.length, 130);
  assert.equal(new Set(versionSource.records.map(({ id }) => id)).size, 130);
  assert.equal(new Set(versionSource.records.map(({ stepRef }) => stepRef)).size, 130);
  const versionBindingIds = versionSource.records.flatMap(({ versionFieldBindings }) => versionFieldBindings.map(({ id }) => id));
  assert.equal(new Set(versionBindingIds).size, versionBindingIds.length);
  for (const binding of versionSource.records) {
    const source = contracts.get(binding.stepRef);
    const semantic = oracleSteps.get(binding.stepRef);
    assert.ok(source, `${binding.id}: exact journey contract step resolves`);
    assert.ok(semantic, `${binding.id}: exact owner semantic oracle resolves`);
    assert.equal(binding.journeyRef, source.document.journeyId);
    assert.equal(binding.ordinal, Number(binding.stepRef.match(/#\/steps\/(\d+)$/u)[1]) + 1);
    assert.equal(binding.stepSemanticDefinitionId, semantic.id);
    assert.equal(binding.runtimeAdmission, "NOT_ADMITTED");
    assert.equal(binding.acceptanceEffect, "none");
    assert.match(binding.versionBindingRule, /Missing, stale, foreign-tenant/u);
    assert.deepEqual(binding.objectBindings.map(({ objectRef }) => objectRef), source.step.objectRefs ?? []);
    for (const object of binding.objectBindings) {
      const identity = identityByObject.get(object.objectRef);
      if (!identity) {
        const historical = excludedHistoricalIdentityByObject.get(object.objectRef);
        assert.ok(historical, `${binding.id}: noncanonical object must have an explicit exclusion source`);
        assert.equal(object.disposition, "SOURCE_OBSERVATION_NOT_CANONICAL_MEDIA_IDENTITY");
        assert.equal(object.identityContractRef, null);
        assert.equal(object.identityTupleComponentsRef ?? null, null);
        assert.equal(historical.disposition, "LEGACY_STORAGE_AND_PROVIDER_OBSERVATION_NOT_CANONICAL_TRANSCRIPT_VERSION");
        continue;
      }
      assert.equal(object.identityContractRef,
        `.product-experience/pdp-1-domain-data/domain-objects.yaml#ownerTypedIdentityContracts/records/@id=${identity.id}`);
      assert.deepEqual(object.identityTupleFields, identity.canonicalIdentityTuple);
      assert.deepEqual(object.versionTupleFields,
        identity.canonicalIdentityTuple.filter((field) => /(?:version|revision)/iu.test(field)));
      assert.equal(object.identityTupleComponentsRef, `${object.identityContractRef}/identityComponents`);
      assert.deepEqual(resolveSourceRef(object.identityTupleComponentsRef), identity.identityComponents);
      for (const component of identity.identityComponents) {
        assert.ok(component.origin);
        if (component.scalarTypeRef) assert.ok(resolveSourceRef(component.scalarTypeRef), `${binding.id}: scalar type source resolves`);
      }
    }
  }
});

test("all projected journey steps have exact version semantics or a source-backed UNKNOWN disposition", async () => {
  const candidate = JSON.parse(await readFile(`${root}/generated/experience-specification.candidate.json`, "utf8"));
  const audit = candidate.candidateMappingReview.journeyBindingAudit;
  assert.equal(audit.p3OrderedStepCount, 130);
  assert.equal(audit.projectedStepCount, 130);
  assert.equal(audit.typedStepSemanticsProjected, 130);
  assert.equal(audit.typedStepSemanticsUnresolved, 0);
  assert.deepEqual(audit.stepSemanticsFailures, []);
  const projectedSteps = candidate.candidateModel.journeys.flatMap((journey) => journey.steps);
  assert.equal(projectedSteps.length, 130);
  const projectedSourceSteps = new Set();
  for (const step of projectedSteps) {
    assert.ok(step.semantics, `${step.stepId} carries typed source semantics`);
    const stepSourceRef = step.semantics.sourceRefs.find((ref) => /journey-contracts\/[^#]+\.yaml#\/steps\/\d+$/u.test(ref));
    assert.ok(stepSourceRef, `${step.stepId} retains its exact source step locator`);
    assert.equal(projectedSourceSteps.has(stepSourceRef), false, `${stepSourceRef} is projected once`);
    projectedSourceSteps.add(stepSourceRef);
    for (const ref of step.semantics.objectVersionRefs) {
      const match = ref.match(/step-version-binding-contracts\.yaml#records\/@id=([^/]+)\/versionFieldBindings\/@id=([^/]+)$/u);
      assert.ok(match, `${step.stepId} objectVersionRef is an exact source locator`);
      const record = versionSource.records.find(({ id }) => id === match[1]);
      const binding = record?.versionFieldBindings.find(({ id }) => id === match[2]);
      assert.ok(record && binding, `${step.stepId} objectVersionRef resolves to its source definition`);
      assert.equal(record.stepRef, stepSourceRef);
      assert.equal(record.runtimeAdmission, "NOT_ADMITTED");
      assert.equal(record.acceptanceEffect, "none");
      assert.deepEqual(binding.canonicalVersionIdentityRequirement.missingOrStaleDisposition, "UNKNOWN");
      assert.deepEqual(binding.canonicalVersionIdentityRequirement.foreignTenantOrMixedVersionDisposition, "UNKNOWN");
    }
  }
  assert.equal(projectedSourceSteps.size, 130);

  const expectedLocalSelectionSteps = new Set([
    ".product-experience/pdp-3-product-experience/journey-contracts/upload-import-and-verify-artifact.yaml#/steps/0",
    ".product-experience/pdp-3-product-experience/journey-contracts/transcribe-and-correct-captions.yaml#/steps/0",
    ".product-experience/pdp-3-product-experience/journey-contracts/repair-video-with-measured-quality.yaml#/steps/0",
  ]);
  const localSelectionSteps = new Set();
  const explicitlyUnknownSteps = new Set();
  for (const record of versionSource.records) {
    for (const binding of record.versionFieldBindings) {
      if (binding.coverageDisposition === "VERSIONED_OBJECT_HAS_NO_SOURCE_BOUND_REQUEST_OR_RESULT_VERSION_FIELD; KEEP_VERSION_OBSERVATION_UNKNOWN"
        && binding.fields.length > 0) {
        assert.ok(binding.fields.every((field) => field.direction === "LOCAL_SELECTION"));
        const localContract = resolveSourceRef(binding.fields[0].requestSchemaRef);
        assert.ok(localContract, `${record.id}: exact local selection input resolves`);
        assert.equal(localContract, localBySource.get(record.stepRef).inputContract.mutation.candidateSchemaRef);
        const candidateName = binding.fields[0].candidateSchemaRef.split("/").at(-1);
        assert.ok(valueTypes.$defs[candidateName]);
        assert.deepEqual(valueTypes.$defs.ExactArtifactVersionRef.required, ["tenantId", "artifactId", "versionId"]);
        assert.equal(binding.fields[0].requiredVersionBinding, "LOCAL_EXACT_ARTIFACT_VERSION_IDENTITY_SELECTION; NO_DOMAIN_DISPATCH");
        localSelectionSteps.add(record.stepRef);
      } else if (binding.coverageDisposition === "VERSIONED_OBJECT_HAS_NO_SOURCE_BOUND_REQUEST_OR_RESULT_VERSION_FIELD; KEEP_VERSION_OBSERVATION_UNKNOWN") {
        assert.deepEqual(binding.fields, []);
        assert.ok(binding.exactVersionTupleRequirement.length > 0);
        assert.equal(binding.canonicalVersionIdentityRequirement.missingOrStaleDisposition, "UNKNOWN");
        assert.equal(binding.canonicalVersionIdentityRequirement.foreignTenantOrMixedVersionDisposition, "UNKNOWN");
        explicitlyUnknownSteps.add(record.stepRef);
      }
    }
  }
  assert.deepEqual(localSelectionSteps, expectedLocalSelectionSteps);
  assert.ok(explicitlyUnknownSteps.size > 0, "no-source-version steps remain explicit UNKNOWN rather than inferred complete");
  assert.equal(localVersionSource.records.length, localEffects.records.length);
});

test("local draft steps bind only their host-session revision CAS", () => {
  const localRows = versionSource.records.filter(({ localDraftRevisionContractRef }) => localDraftRevisionContractRef !== null);
  assert.equal(localRows.length, localEffects.records.length);
  for (const binding of localRows) {
    const local = localBySource.get(binding.stepRef);
    assert.ok(local);
    assert.ok(["LOCAL_DRAFT_REVISION_CAS; NOT_CANONICAL_PRODUCT_VERSION", "EXACT_CANONICAL_VERSION_TUPLE_REQUIRED", "EXACT_IMMUTABLE_ARTIFACT_VERSION_REQUEST; DESTINATION_SELECTION_REMAINS_LOCAL"].includes(binding.versionDisposition));
    assert.equal(binding.localDraftRevisionContractRef,
      `${root}/local-step-effect-contracts.yaml#records/@id=${local.id}/localRevisionRule`);
    assert.equal(local.localRevisionRule.source, "HOST_EDITOR_SESSION_CONTEXT");
    assert.match(local.localRevisionRule.precondition, /expectedDraftRevision exactly equals/u);
    assert.equal(local.effect.committedMediaObjects, "unchanged");
    assert.equal(local.effect.remoteDispatch, "none");
  }
});

test("J-02 begin-upload does not require an artifact version before the owner issues one", () => {
  const binding = versionSource.records.find(({ id }) => id === "media.step-version-binding.j-02-02.v1");
  assert.ok(binding);
  const artifactVersion = binding.versionFieldBindings.find(({ objectRef }) => objectRef === "media.domain.artifact-version");
  assert.ok(artifactVersion);
  assert.equal(artifactVersion.applicabilityContract?.disposition, "NOT_YET_ISSUED_AT_THIS_STEP");
  assert.equal(artifactVersion.coverageDisposition,
    "NOT_APPLICABLE_BEFORE_OWNER_ISSUED_ARTIFACT_VERSION; BEGIN_UPLOAD_RETURNS_UPLOAD_SESSION_ONLY; IDENTITY_BINDS_AT_COMPLETE_UPLOAD_STEP");
  assert.equal(binding.versionDisposition, "NOT_APPLICABLE_BEFORE_OWNER_ISSUED_ARTIFACT_VERSION",
    "a not-yet-issued artifact version cannot simultaneously be required as an exact tuple at begin-upload");
});

test("canonical version joins compare a complete trusted tuple and reject valid-looking foreign aliases", () => {
  const binding = versionSource.records.find((row) => row.versionFieldBindings.some((field) => field.objectRef === "media.domain.artifact-version"));
  const fieldBinding = binding.versionFieldBindings.find((field) => field.objectRef === "media.domain.artifact-version");
  const identity = identityByObject.get(fieldBinding.objectRef);
  const tuple = Object.fromEntries(identity.canonicalIdentityTuple.map((field) => [field, `owner-issued-${field}`]));
  const resolve = (ref) => resolveSourceRef(ref);
  const valid = evaluatePdp3CanonicalVersionTuple({ versionFieldBinding: fieldBinding, objectRef: fieldBinding.objectRef,
    candidateTuple: { ...tuple }, expectedTuple: { ...tuple }, trustedTenantId: tuple.tenantId, resolveDefinitionRef: resolve });
  assert.deepEqual(valid, { verdict: "TRUE", reason: "EXACT_OWNER_SELECTED_VERSION_TUPLE_MATCH" });

  const foreignTenant = { ...tuple, tenantId: "tenant-other" };
  assert.equal(evaluatePdp3CanonicalVersionTuple({ versionFieldBinding: fieldBinding, objectRef: fieldBinding.objectRef,
    candidateTuple: foreignTenant, expectedTuple: { ...tuple }, trustedTenantId: tuple.tenantId, resolveDefinitionRef: resolve }).verdict, "UNKNOWN");
  assert.equal(evaluatePdp3CanonicalVersionTuple({ versionFieldBinding: fieldBinding, objectRef: "media.domain.caption-version",
    candidateTuple: { ...tuple }, expectedTuple: { ...tuple }, trustedTenantId: tuple.tenantId, resolveDefinitionRef: resolve }).verdict, "UNKNOWN");
  assert.equal(evaluatePdp3CanonicalVersionTuple({ versionFieldBinding: fieldBinding, objectRef: fieldBinding.objectRef,
    candidateTuple: { ...tuple, versionId: "owner-issued-versionId-stale" }, expectedTuple: { ...tuple }, trustedTenantId: tuple.tenantId,
    resolveDefinitionRef: resolve }).verdict, "UNKNOWN");
  assert.equal(evaluatePdp3CanonicalVersionTuple({ versionFieldBinding: fieldBinding, objectRef: fieldBinding.objectRef,
    candidateTuple: { ...tuple, versionId: "latest" }, expectedTuple: { ...tuple }, trustedTenantId: tuple.tenantId,
    resolveDefinitionRef: resolve }).verdict, "UNKNOWN");
  assert.equal(evaluatePdp3CanonicalVersionTuple({ versionFieldBinding: fieldBinding, objectRef: fieldBinding.objectRef,
    candidateTuple: { ...tuple, artifactId: "artifact-from-another-version" }, expectedTuple: { ...tuple }, trustedTenantId: tuple.tenantId,
    resolveDefinitionRef: resolve }).verdict, "UNKNOWN");
  const missing = { tenantId: tuple.tenantId, artifactId: tuple.artifactId };
  assert.equal(evaluatePdp3CanonicalVersionTuple({ versionFieldBinding: fieldBinding, objectRef: fieldBinding.objectRef,
    candidateTuple: missing, expectedTuple: { ...tuple }, trustedTenantId: tuple.tenantId, resolveDefinitionRef: resolve }).verdict, "UNKNOWN");
});

test("transitive caption reads require both exact caption identities to join the same selected source version", () => {
  const step = versionSource.records.find((row) => row.id === "media.step-version-binding.j-03-08.v1");
  const versionBinding = step.versionFieldBindings.find((field) => field.objectRef === "media.domain.artifact-version");
  const expectedArtifactVersionTuple = { tenantId: "tenant-1", artifactId: "artifact-7", versionId: "artifact-version-4" };
  const makeCaptionTuple = (captionVersionId, sourceArtifactVersionId = expectedArtifactVersionTuple.versionId) => ({
    tenantId: expectedArtifactVersionTuple.tenantId,
    sourceArtifactId: expectedArtifactVersionTuple.artifactId,
    sourceArtifactVersionId,
    captionVersionId,
  });
  const options = {
    versionFieldBinding: versionBinding,
    leftCaptionVersionId: "caption-version-left",
    rightCaptionVersionId: "caption-version-right",
    leftIdentityTuple: makeCaptionTuple("caption-version-left"),
    rightIdentityTuple: makeCaptionTuple("caption-version-right"),
    expectedArtifactVersionTuple,
    trustedTenantId: "tenant-1",
    resolveDefinitionRef: resolveSourceRef,
  };
  assert.deepEqual(evaluatePdp3CaptionPairSourceVersionJoin(options), {
    verdict: "TRUE", reason: "BOTH_EXACT_CAPTION_VERSIONS_JOIN_TO_REQUESTED_ARTIFACT_VERSION",
  });
  assert.equal(evaluatePdp3CaptionPairSourceVersionJoin({ ...options,
    rightIdentityTuple: makeCaptionTuple("caption-version-right", "artifact-version-older"), }).verdict, "UNKNOWN");
  assert.equal(evaluatePdp3CaptionPairSourceVersionJoin({ ...options,
    rightIdentityTuple: { ...makeCaptionTuple("caption-version-right"), tenantId: "tenant-foreign" }, }).verdict, "UNKNOWN");
  assert.equal(evaluatePdp3CaptionPairSourceVersionJoin({ ...options,
    rightIdentityTuple: makeCaptionTuple("caption-version-other"), }).verdict, "UNKNOWN");
  assert.equal(evaluatePdp3CaptionPairSourceVersionJoin({ ...options,
    expectedArtifactVersionTuple: { ...expectedArtifactVersionTuple, versionId: "latest" }, }).verdict, "UNKNOWN");
  assert.equal(evaluatePdp3CaptionPairSourceVersionJoin({ ...options,
    expectedArtifactVersionTuple: { tenantId: "tenant-other", artifactId: "artifact-7", versionId: "artifact-version-4" },
    trustedTenantId: "tenant-1", }).verdict, "UNKNOWN");
  assert.equal(evaluatePdp3CaptionPairSourceVersionJoin({ ...options,
    rightIdentityTuple: { ...makeCaptionTuple("caption-version-right"), unexpected: "extra" }, }).verdict, "UNKNOWN");
});

test("consent revision joins require a current, exact tenant and purpose read plus canonical revision identity", () => {
  const consentRead = operations.ownerConsentRevisionObservationContract;
  assert.equal(consentRead.id, "media.observation-contract.consent-revision-current-read.v1");
  assert.equal(consentRead.queryKind, "DEFINITION_ONLY_TYPED_READ; not-an-endpoint-or-transport-adapter");
  assert.match(consentRead.bindingRules.find(({ id }) => id === "media.consent-read-binding.revision.v1").rule,
    /consentRevisionRef resolves exactly to consentRef plus the same immutable version/u);
  const operationRef = ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.consent-record-inspect.v1";
  const readAuthorityRef = ".product-experience/pdp-1-domain-data/authority.yaml#ownerDefinedPdp10AuthorityScopes/identityScope";
  const request = { queryId: "query-17", consentId: "consent-3", purposeRef: "purpose.voice.synthesis" };
  const trusted = {
    tenantId: "tenant-1", tenantScopeRef: "tenant-scope-1", principalRef: "principal-8",
    expectedRequestFingerprint: `sha256:${"a".repeat(64)}`, expectedOperationRef: operationRef,
    expectedReadAuthorityRef: readAuthorityRef, expectedReadVersion: "read-v12",
  };
  const outcome = {
    kind: "OBSERVED_CONSENT_REVISION", consentId: request.consentId, consentRef: "consent-ref-3",
    consentRevisionRef: "consent-revision-6", tenantScopeRef: trusted.tenantScopeRef, principalRef: trusted.principalRef,
    purposes: [request.purposeRef], allowedRegions: ["region-us"], externalProcessingAllowed: true,
    biometricProcessingAllowed: false, status: "ACTIVE", authorityRef: "authority-4", evidenceRef: "evidence-9",
    grantedAt: "2026-10-08T10:00:00.000Z", version: 6, expiresAt: "2026-10-10T10:00:00.000Z", revokedAt: null,
  };
  const result = {
    queryId: request.queryId, requestFingerprint: trusted.expectedRequestFingerprint, operationRef,
    readAuthorityRef, currentness: "CURRENT", readVersion: trusted.expectedReadVersion,
    observedAt: "2026-10-09T10:00:00.000Z", outcome,
  };
  const resolvedRevision = {
    reference: outcome.consentRevisionRef, consentRef: outcome.consentRef, version: outcome.version,
    identityTuple: { tenantId: trusted.tenantId, consentId: request.consentId, consentRevisionId: outcome.consentRevisionRef },
    readAuthorityRef, readVersion: trusted.expectedReadVersion, currentness: "CURRENT",
    requestFingerprint: trusted.expectedRequestFingerprint,
  };
  const input = { request, result, trusted, resolvedRevision, now: "2026-10-09T10:01:00.000Z" };
  assert.deepEqual(evaluatePdp3ConsentRevisionVersionJoin(input), {
    verdict: "TRUE", reason: "CURRENT_EXACT_CONSENT_REVISION_IDENTITY_JOIN",
  });
  const unknown = (overrides) => evaluatePdp3ConsentRevisionVersionJoin({ ...input, ...overrides }).verdict;
  assert.equal(unknown({ trusted: { ...trusted, tenantId: "tenant-foreign" } }), "UNKNOWN");
  assert.equal(unknown({ request: { ...request, purposeRef: "purpose.other" } }), "UNKNOWN");
  assert.equal(unknown({ result: { ...result, readVersion: "read-v11" } }), "UNKNOWN");
  assert.equal(unknown({ result: { ...result, currentness: "STALE" } }), "UNKNOWN");
  assert.equal(unknown({ result: { ...result, observedAt: "2026-10-09T10:02:00.000Z" } }), "UNKNOWN");
  assert.equal(unknown({ result: { ...result, outcome: { ...outcome, status: "REVOKED" } } }), "UNKNOWN");
  assert.equal(unknown({ result: { ...result, outcome: { ...outcome, expiresAt: "2026-10-09T10:00:30.000Z" } } }), "UNKNOWN");
  assert.equal(unknown({ resolvedRevision: { ...resolvedRevision, identityTuple: { ...resolvedRevision.identityTuple, consentRevisionId: "consent-revision-other" } } }), "UNKNOWN");
  assert.equal(unknown({ resolvedRevision: { ...resolvedRevision, consentRef: "consent-ref-other" } }), "UNKNOWN");
  assert.equal(unknown({ resolvedRevision: { ...resolvedRevision, readAuthorityRef: "foreign-authority" } }), "UNKNOWN");
  assert.equal(unknown({ now: "2026-99-99T00:00:00.000Z" }), "UNKNOWN");
  assert.equal(unknown({ request: { ...request, injected: true } }), "UNKNOWN");
});

test("versioned operation request selectors resolve exact operation fields and expose uncovered inputs", () => {
  let exactBound = 0;
  let explicitlyOpen = 0;
  for (const binding of versionSource.records) {
    const expectedOperations = new Set([
      ...(oracleSteps.get(binding.stepRef).canonicalBindings.primaryOperationRefs ?? []),
      ...(oracleSteps.get(binding.stepRef).canonicalBindings.operationRefs ?? []),
      ...(oracleSteps.get(binding.stepRef).canonicalBindings.supportingObservationOperationRefs ?? []),
    ]);
    assert.deepEqual(new Set(binding.operationBindings.map(({ operationRef }) => operationRef)), expectedOperations);
    for (const operation of binding.operationBindings) {
      const entry = operationById.get(operation.operationRef);
      if (!entry) {
        assert.equal(operation.disposition, "EXACT_OPERATION_CONTRACT_NOT_RESOLVED");
        assert.equal(operation.contractRef, null);
        continue;
      }
        assert.equal(operation.contractRef,
        `.product-experience/pdp-1-domain-data/operations.yaml#${entry.collection}/@id=${operation.operationRef}`);
      if (operation.operationRef === "media.operation.consent-record-inspect.v1") {
        assert.equal(operation.resultSemanticsRef,
          ".product-experience/pdp-1-domain-data/operations.yaml#ownerConsentRevisionObservationContract");
        assert.equal(resolveSourceRef(operation.resultSemanticsRef)?.id,
          "media.observation-contract.consent-revision-current-read.v1");
      }
      const schema = resolveRequestSchema(operation.operationRef);
      const hasRequestSemantics = Boolean(entry.row.inputSemantics);
      const expectedDisposition = operation.operationRef === "media.operation.stream-session.inspect-execution-recovery.v1"
        ? "OWNER_DEFINED_EXACT_SINGLE_SNAPSHOT_QUERY; EXECUTION_NOT_ADMITTED"
        : operation.operationRef === "media.operation.capability.media-multimodal-observe-source-grounded"
        ? "OWNER_REQUEST_SCHEMA_RESOLVED; TARGET_INPUT_ADAPTER_REQUIRED; RUNTIME_NOT_ADMITTED"
        : schema ? "OWNER_REQUEST_SCHEMA_RESOLVED"
          : hasRequestSemantics ? "OWNER_REQUEST_SEMANTICS_RESOLVED" : "OWNER_REQUEST_SCHEMA_NOT_PRESENT";
      assert.equal(operation.disposition, expectedDisposition);
      if (!schema && !hasRequestSemantics) assert.equal(operation.requestSchemaRef, null);
    }
    for (const versionBinding of binding.versionFieldBindings) {
      const matching = versionBinding.fields.filter((field) => {
        const { operationRef, fieldSelector } = field;
        const schema = resolveRequestSchema(operationRef);
        const operationBinding = binding.operationBindings.find((item) => item.operationRef === operationRef);
        if (fieldSelector.includes("/inputSemantics/")) {
          const entry = operationById.get(operationRef);
          assert.ok(fieldSelector.startsWith(operationBinding.contractRef));
          const path = fieldSelector.slice(operationBinding.contractRef.length).split("/").filter(Boolean);
          let node = entry.row;
          for (const part of path) node = node?.[part];
          assert.equal(node, field.fieldName);
          assert.ok(field.boundObjectRefs.includes(versionBinding.objectRef));
        } else if (fieldSelector.includes("/required/")) {
          const entry = operationById.get(operationRef);
          assert.ok(fieldSelector.startsWith(operationBinding.contractRef));
          const path = fieldSelector.slice(operationBinding.contractRef.length).split("/").filter(Boolean);
          let node = entry.row;
          for (const part of path) node = node?.[part];
          assert.equal(node, field.fieldName);
          assert.ok(field.boundObjectRefs.includes(versionBinding.objectRef));
        } else if (field.direction === "LOCAL_SELECTION") {
          const local = localBySource.get(binding.stepRef);
          assert.ok(local);
          assert.equal(field.candidateSchemaRef, local.inputContract.mutation.candidateSchemaRef);
          assert.match(field.candidateSchemaRef, /#\/\$defs\/(ArtifactVersionCandidate|SourceVersionCandidate)$/u);
          assert.equal(field.fieldSelector,
            ".product-experience/pdp-2-design-interface-system/component-value-types.yaml#/$defs/ExactArtifactVersionRef");
          const candidateName = field.candidateSchemaRef.split("/").at(-1);
          const candidateSchema = valueTypes.$defs[candidateName];
          assert.ok(candidateSchema);
          assert.equal(candidateSchema.properties.versionRef.$ref, "media.component-value-types.v1#/$defs/ExactArtifactVersionRef");
          assert.deepEqual(valueTypes.$defs.ExactArtifactVersionRef.required, ["tenantId", "artifactId", "versionId"]);
          assert.ok(field.boundObjectRefs.includes(versionBinding.objectRef));
        } else if (field.direction === "OWNER_RESULT") {
          const entry = operationById.get(operationRef);
          if (field.observationContractRef) {
            const observation = resolveSourceRef(field.observationContractRef);
            assert.equal(observation?.id, "media.observation-contract.consent-revision-current-read.v1");
            const path = fieldSelector.slice(field.observationContractRef.length).split("/").filter(Boolean);
            let node = observation;
            for (const part of path) node = node?.[part];
            assert.equal(node?.type, field.fieldName === "version" ? "integer" : "string");
            assert.equal(path.at(-1), field.fieldName);
            assert.ok(field.boundObjectRefs.includes(versionBinding.objectRef));
            assert.equal(field.semanticDisposition === "EXACT_TYPED_CONSENT_REVISION_FIELD; transport NOT_ADMITTED"
              || field.semanticDisposition === "EXACT_NUMERIC_REVISION_VERSION_FIELD; never substitute for consentRevisionRef", true);
            return true;
          }
          if (field.semanticDisposition) {
            assert.ok(fieldSelector.startsWith(operationBinding.contractRef));
            const path = fieldSelector.slice(operationBinding.contractRef.length).split("/").filter(Boolean);
            let node = entry.row;
            for (const part of path) node = node?.[part];
            assert.equal(node, field.fieldName);
            assert.equal(field.semanticDisposition, "EXACT_OWNER_RESULT_FIELD; IDENTITY_FIELD_TYPE_FROM_CANONICAL_OBJECT_CONTRACT");
            assert.ok(field.boundObjectRefs.includes(versionBinding.objectRef));
            return true;
          }
          const resultSchema = resolveResultSchema(operationRef);
          assert.ok(resultSchema);
          const schemaRef = operationBinding.contractRef;
          assert.ok(fieldSelector.startsWith(schemaRef));
          const path = fieldSelector.slice(schemaRef.length).split("/").filter(Boolean);
          let node = entry.row;
          for (const part of path) node = node?.[part];
          assert.equal(node?.format, "opaque-version-id");
          assert.equal(fieldNameFromPath(path), field.fieldName);
          const outputType = identities.ownerOutputArtifactTypeCrosswalk.records.find(({ artifactType }) => artifactType === field.artifactType);
          assert.ok(outputType, `exact owner output type ${field.artifactType} resolves`);
          assert.deepEqual(field.boundObjectRefs, outputType.domainObjectRefs);
        } else {
          assert.ok(schema);
          const fieldPath = fieldSelector.slice(operationBinding.requestSchemaRef.length).replace(/^\//u, "");
          assert.ok(fieldPath, "selector descends from the exact operation request schema");
          let node = schema;
          for (const part of fieldPath.split("/")) node = node?.[part];
          assert.ok(node, `${fieldSelector} resolves to a schema node`);
          const referenceField = operationBinding.requestReferenceFields.find(({ fieldSelector: suffix }) => suffix === `/${fieldPath}`);
          assert.ok(referenceField, `request reference binding is sourced from the exact schema node: ${fieldSelector}; candidates=${JSON.stringify(operationBinding.requestReferenceFields)}`);
          assert.ok(referenceField.allowedObjectRefs.includes(versionBinding.objectRef));
        }
        return true;
      });
      if (matching.length) exactBound += 1;
      else {
        explicitlyOpen += 1;
        assert.match(versionBinding.coverageDisposition, /^(?:CANONICAL_CONSENT_REVISION_TUPLE_REQUIRED|NOT_APPLICABLE_BEFORE_OWNER_ISSUED_ARTIFACT_VERSION|NO_ARTIFACT_VERSION_EXISTS_AT_BEGIN_UPLOAD|ARTIFACT_VERSION_IS_TRANSITIVE|EXACT_VERSION_RESULT_FIELD_BOUND|VERSIONED_OBJECT_HAS_NO_SOURCE_BOUND)/u);
      }
      for (const ref of versionBinding.sourceBoundaryRefs ?? []) {
        assert.ok(resolveSourceRef(ref), `${binding.id}: exact version boundary source resolves: ${ref}`);
      }
      if (versionBinding.canonicalVersionIdentityRequirement) {
        const requirement = versionBinding.canonicalVersionIdentityRequirement;
        const identity = identityByObject.get(versionBinding.objectRef);
        assert.equal(requirement.identityContractRef,
          `.product-experience/pdp-1-domain-data/domain-objects.yaml#ownerTypedIdentityContracts/records/@id=${identity.id}`);
        assert.ok(resolveSourceRef(requirement.identityContractRef));
        assert.equal(requirement.identityComponentsRef, `${requirement.identityContractRef}/identityComponents`);
        assert.deepEqual(requirement.exactTupleFields, identity.canonicalIdentityTuple);
        assert.deepEqual(resolveSourceRef(requirement.identityComponentsRef), identity.identityComponents);
        assert.deepEqual(requirement.trustedContextFields,
          identity.identityComponents.filter(({ origin }) => origin === "TRUSTED_HOST_CONTEXT").map(({ field }) => field));
        assert.equal(requirement.missingOrStaleDisposition, "UNKNOWN");
        assert.equal(requirement.foreignTenantOrMixedVersionDisposition, "UNKNOWN");
        const wrongIdentity = identities.ownerTypedIdentityContracts.records.find((row) => row.objectRef !== versionBinding.objectRef);
        assert.notEqual(wrongIdentity.objectRef, versionBinding.objectRef, "foreign-object substitution is rejected by exact identity membership");
        assert.notEqual(resolveSourceRef(`.product-experience/pdp-1-domain-data/domain-objects.yaml#ownerTypedIdentityContracts/records/@id=${wrongIdentity.id}`).objectRef,
          versionBinding.objectRef);
      }
      for (const join of versionBinding.transitiveVersionJoins ?? []) {
        assert.equal(join.runtimeAdmission, "NOT_ADMITTED");
        assert.equal(join.absentOrMismatchedDisposition, "UNKNOWN");
        assert.deepEqual(join.exactInputFieldNames, ["leftCaptionVersionId", "rightCaptionVersionId"]);
        assert.equal(resolveSourceRef(join.operationContractRef)?.id, join.operationRef);
        assert.ok(resolveSourceRef(join.selectorBranchRef));
        assert.equal(resolveSourceRef(join.captionVersionIdentityRef)?.objectRef, "media.domain.caption-version");
        assert.equal(resolveSourceRef(join.captionVersionIdentityRef)?.identityComponents
          .find(({ field }) => field === join.sourceArtifactVersionTupleField)?.field, "sourceArtifactVersionId");
        assert.deepEqual(join.resultFieldSelectors.map(resolveSourceRef), ["leftCaptionVersionRef", "rightCaptionVersionRef"]);
        assert.match(join.joinRule, /both exact-caption-version references.*must equal/iu);
        assert.match(join.sourceResultLimitation, /do not type their nested identity payload/u);
      }
      if (versionBinding.logicalVersionJoin?.candidateObservationContractRef) {
        const join = versionBinding.logicalVersionJoin;
        const observation = resolveSourceRef(join.candidateObservationContractRef);
        assert.deepEqual(join.canonicalTuple, ["tenantId", "consentId", "consentRevisionId"]);
        if (join.candidateObservationContractRef.endsWith("#ownerConsentRevisionObservationContract")) {
          assert.equal(observation?.id, "media.observation-contract.consent-revision-current-read.v1");
          assert.ok(resolveSourceRef(join.consentRevisionResultFieldRef));
          assert.ok(resolveSourceRef(join.numericVersionResultFieldRef));
          assert.ok(resolveSourceRef(join.exactRevisionBindingRuleRef));
          assert.match(join.joinRule, /never substitute the numeric version for the revision identity/u);
        } else {
          assert.equal(observation?.id, join.candidateObservationOperationRef);
          assert.match(join.candidateFieldLimitation, /numeric version.*not define it as the opaque consentRevisionId/u);
        }
        assert.match(join.missingOrMismatchedTuple, /^UNKNOWN/u);
        assert.equal(join.runtimeAdmission, "NOT_ADMITTED");
      }
      if (versionBinding.logicalVersionJoin?.supportingJoinId) {
        const join = versionBinding.logicalVersionJoin;
        assert.equal(join.supportingJoinId, "media.step-version-transitive-join.j-03-08.caption-source.v1");
        assert.deepEqual(join.canonicalTuple, ["tenantId", "artifactId", "versionId"]);
        assert.match(join.joinRule, /both exact caption-version refs.*Both source versions must equal/iu);
        assert.match(join.transportLimitation, /without a typed nested identity payload/u);
        assert.equal(join.runtimeAdmission, "NOT_ADMITTED");
      }
      if (versionBinding.applicabilityContract) {
        const applicability = versionBinding.applicabilityContract;
        assert.equal(applicability.disposition, "NOT_YET_ISSUED_AT_THIS_STEP");
        assert.ok(resolveSourceRef(applicability.sourceContractRef));
        const deferredResult = resolveSourceRef(applicability.exactDeferredResultRef);
        assert.ok(deferredResult);
        assert.equal(applicability.exactDeferredOperationRef, "media.operation-slice.complete-upload");
        assert.match(applicability.rule, /only after the exact completion result issues artifactId and versionId/u);
        assert.equal(applicability.runtimeAdmission, "NOT_ADMITTED");
      }
      if (versionBinding.deferredVersionBinding) {
        const deferred = versionBinding.deferredVersionBinding;
        assert.equal(deferred.runtimeAdmission, "NOT_ADMITTED");
        assert.ok(contracts.has(deferred.targetStepRef));
        assert.ok(oracleSteps.has(deferred.targetStepRef));
        assert.equal(deferred.targetStepSemanticDefinitionId, oracleSteps.get(deferred.targetStepRef).id);
        assert.equal(deferred.operationRef, "media.operation-slice.complete-upload");
        assert.ok(resolveSourceRef(deferred.operationContractRef));
        assert.ok(resolveSourceRef(deferred.ownerResultFieldSelector));
      }
    }
  }
  assert.ok(exactBound > 0);
  assert.ok(explicitlyOpen > 0, "unsupported version input joins remain visible for owner follow-up");
  assert.ok(versionSource.records.some(({ objectBindings }) => objectBindings.some(({ disposition }) => disposition === "SOURCE_OBSERVATION_NOT_CANONICAL_MEDIA_IDENTITY")));
  assert.ok(versionSource.records.every(({ versionDisposition }) => versionDisposition !== "CANONICAL_OBJECT_IDENTITY_CONTRACT_NOT_RESOLVED"),
    "legacy transcription observations are explicitly noncanonical, not an unresolved canonical identity");
});

test("J-01 project inspection binds the owner-returned exact head revision", () => {
  const binding = versionSource.records.find(({ id }) => id === "media.step-version-binding.j-01-04.v1");
  assert.ok(binding);
  const versionFieldBinding = binding.versionFieldBindings.find(({ objectRef }) => objectRef === "media.domain.project-revision");
  assert.equal(versionFieldBinding.coverageDisposition, "EXACT_VERSION_RESULT_FIELD_BOUND");
  assert.equal(versionFieldBinding.fields.length, 1);
  const field = versionFieldBinding.fields[0];
  assert.equal(field.operationRef, "media.operation-slice.inspect-project");
  assert.equal(field.fieldName, "headRevisionId");
  assert.equal(resolveSourceRef(field.fieldSelector)?.format, "opaque-version-id");
  assert.equal(field.requiredVersionBinding, "OWNER_OBSERVED_EXACT_IMMUTABLE_VERSION_IDENTITY; NOT_A_RUNTIME_RECEIPT");
  const { step } = contracts.get(binding.stepRef);
  assert.equal(step.stepDefinitionSemantics.versionedObjectObservation.status,
    "OWNER_RESULT_BINDS_EXACT_CURRENT_HEAD_REVISION");
  assert.equal(step.stepDefinitionSemantics.versionedObjectObservation.runtimeAdmission, "NOT_ADMITTED");
});

test("J-02 exact-version inspection joins one owner query and both exact request identities", () => {
  const binding = versionSource.records.find(({ id }) => id === "media.step-version-binding.j-02-05.v1");
  const purpose = purposeSource.records.find(({ id }) => id === "media.pdp3.step-purpose-binding.j02-step-05.v1");
  const semantic = oracleSteps.get(binding.stepRef);
  assert.ok(binding && purpose && semantic);
  assert.equal(binding.actionRef, "media.action.inspect-source");
  assert.deepEqual(binding.operationBindings.map(({ operationRef }) => operationRef), [
    "media.operation-slice.inspect-artifact-version",
  ]);
  const operation = binding.operationBindings[0];
  assert.equal(operation.contractRef,
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation-slice.inspect-artifact-version");
  assert.deepEqual(operation.requestReferenceFields.map(({ fieldSelector, allowedObjectRefs }) => [fieldSelector, allowedObjectRefs]), [
    ["/properties/artifactId", ["media.domain.artifact"]],
    ["/properties/artifactVersionId", ["media.domain.artifact-version"]],
  ]);
  const version = binding.versionFieldBindings.find(({ objectRef }) => objectRef === "media.domain.artifact-version");
  assert.deepEqual(version.canonicalVersionIdentityRequirement.exactTupleFields, ["tenantId", "artifactId", "versionId"]);
  assert.equal(version.fields[0].fieldSelector,
    `${operation.requestSchemaRef}/properties/artifactVersionId`);
  assert.deepEqual(purpose.allowedOperationRefs, ["media.operation-slice.inspect-artifact-version"]);
  assert.deepEqual(purpose.stateRefs, [], "time-scoped recorded disposition does not assert current lifecycle state");
  assert.match(semantic.expectedSemantics.positive.effect, /time-scoped-recorded-integrity-lifecycle-disposition/u);
  assert.equal(semantic.runtimeAdmission, "NOT_ADMITTED");
});

test("J-22 delivery request binds one exact artifact version without claiming destination delivery", () => {
  const binding = versionSource.records.find(({ id }) => id === "media.step-version-binding.j-22-02.v1");
  const semantic = oracleSteps.get(binding.stepRef);
  assert.equal(binding.actionRef, "media.action.deliver-exact-version");
  assert.deepEqual(binding.operationBindings.map(({ operationRef }) => operationRef), ["media.operation.action.deliver-exact-version"]);
  const version = binding.versionFieldBindings.find(({ objectRef }) => objectRef === "media.domain.artifact-version");
  assert.ok(version);
  assert.equal(version.fields[0].fieldSelector,
    ".product-experience/pdp-1-domain-data/operations.yaml#ownerDefinedOperationContracts/records/@id=media.operation.action.deliver-exact-version/requestSchema/properties/artifactVersionId");
  assert.deepEqual(version.canonicalVersionIdentityRequirement.exactTupleFields, ["tenantId", "artifactId", "versionId"]);
  assert.match(semantic.expectedSemantics.positive.finality, /destination acknowledgment is required/u);
  assert.match(semantic.expectedSemantics.positive.completionClaim, /never imply destination receipt/u);
  assert.equal(semantic.canonicalBindings.operationRefs[0], "media.operation.action.deliver-exact-version");
  assert.deepEqual(semantic.canonicalBindings.stateRefs, []);
});
