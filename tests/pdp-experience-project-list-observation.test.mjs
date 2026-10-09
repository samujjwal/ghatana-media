import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { evaluateProjectListObservation } from "../scripts/lib/pdp3-project-list-observation.mjs";

const require = createRequire(new URL("../../ghatana-tools/package.json", import.meta.url));
const { parse } = require("yaml");
const definition = parse(await readFile(".product-experience/pdp-3-product-experience/project-list-observation-contracts.yaml", "utf8")).records[0];
const journey = parse(await readFile(".product-experience/pdp-3-product-experience/journey-contracts/first-use-and-project-creation.yaml", "utf8"));
const operationSource = parse(await readFile(".product-experience/pdp-1-domain-data/operations.yaml", "utf8"));
const scenarioSource = parse(await readFile(".product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml", "utf8"));
function resolveRef(reference) {
  const [path, selector] = reference.split("#", 2);
  let value = path === ".product-experience/pdp-1-domain-data/operations.yaml" ? operationSource : undefined;
  for (const segment of selector.split("/")) {
    if (Array.isArray(value)) value = value.find((entry) => entry?.id === segment);
    else value = value?.[segment];
  }
  return value;
}
const trusted = () => ({
  tenantId: "tenant-01",
  principalId: "principal-01",
  selectedAuthorizedWorkspaceId: "workspace-01",
  projectReadAuthorityRef: ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation",
  authorityObservation: {
    disposition: "CURRENT_ALLOWED", subjectTenantId: "tenant-01", subjectPrincipalId: "principal-01",
    workspaceId: "workspace-01", authorityRef: ".product-experience/pdp-1-domain-data/authority.yaml#ownership.identityAuthenticationAndDelegation",
    evidenceRef: "fixture:host-authority-observation:01",
  },
  serverComputedQueryFingerprint: `sha256:${"a".repeat(64)}`,
  snapshotRefForPageToken: null,
});
const request = { workspaceId: "workspace-01" };
const result = (overrides = {}) => ({
  operationRef: "media.operation-slice.list-projects", outcome: "OBSERVED", tenantId: "tenant-01",
  principalId: "principal-01", workspaceId: "workspace-01", queryFingerprint: `sha256:${"a".repeat(64)}`,
  snapshotRef: "snapshot-01", observedAt: "2026-10-09T12:00:00.000Z", records: [], nextPageToken: null,
  ...overrides,
});

test("J-01 project list observation resolves the exact owner query and page-scoped meaning", () => {
  assert.equal(definition.operationRef, "media.operation-slice.list-projects");
  assert.equal(definition.operationWireSchemaRef, ".product-experience/pdp-1-domain-data/operations.yaml#individualOperationContracts/records/media.operation-slice.list-projects/ownerWireSchema");
  const step = journey.steps[1].stepDefinitionSemantics;
  const operation = operationSource.individualOperationContracts.records.find(({ id }) => id === definition.operationRef);
  assert.equal(resolveRef(definition.operationSourceRef), operation);
  assert.equal(resolveRef(definition.operationWireSchemaRef), operation.ownerWireSchema);
  assert.equal(step.observationDefinitionRef, ".product-experience/pdp-3-product-experience/project-list-observation-contracts.yaml#records/media.project-list-observation.v1");
  assert.equal(step.operationContractBinding.operationRef, definition.operationRef);
  const scenarioById = new Map(scenarioSource.fixtures.map((fixture) => [fixture.id, fixture]));
  assert.deepEqual(definition.scenarioRefs, [
    "media.scenario.first-use-empty", "media.scenario.workspace-access-denied", "media.scenario.identity-required",
  ]);
  assert.match(scenarioById.get("media.scenario.first-use-empty").expected, /first-use-state/u);
  assert.match(scenarioById.get("media.scenario.workspace-access-denied").expected, /no-protected-project-data/u);
  assert.match(scenarioById.get("media.scenario.identity-required").expected, /hide-protected-project-data/u);
  assert.equal(operation.operationKind, "QUERY");
  assert.equal(operation.ownerWireSchema.id, "media.operation-wire-schema.list-projects.v1");
  assert.deepEqual(definition.result.closedFields, Object.keys(operation.ownerWireSchema.resultSchema.oneOf[0].properties));
  assert.match(definition.status, /RUNTIME_NOT_ADMITTED/u);

  const terminalEmpty = evaluateProjectListObservation(definition, request, result(), trusted());
  assert.equal(terminalEmpty.disposition, "AUTHORIZED_QUERY_PAGE_EMPTY_TERMINAL");
  assert.equal(terminalEmpty.projectMutation, "NONE");
  assert.equal(terminalEmpty.runtimeAdmission, "NOT_ADMITTED");
  assert.match(terminalEmpty.reason, /NOT_GLOBAL_ABSENCE/u);

  const morePages = evaluateProjectListObservation(definition, request, result({ nextPageToken: "page-2" }), trusted());
  assert.equal(morePages.disposition, "AUTHORIZED_QUERY_PAGE_EMPTY_MORE_RESULTS_POSSIBLE");

  const projects = evaluateProjectListObservation(definition, request, result({ records: [{
    projectId: "project-01", workspaceId: "workspace-01", title: "Project", headRevisionId: "revision-01", projectState: "ACTIVE",
  }] }), trusted());
  assert.equal(projects.disposition, "AUTHORIZED_QUERY_PAGE_NONEMPTY");
  assert.deepEqual(projects.projectRefs, ["media.domain.project:project-01"]);
});

test("unknown query responses do not become empty results", () => {
  const unknown = evaluateProjectListObservation(definition, request, {
    operationRef: "media.operation-slice.list-projects", outcome: "UNKNOWN_OBSERVATION", reason: "SNAPSHOT_UNAVAILABLE",
  }, trusted());
  assert.equal(unknown.disposition, "HOLD_UNKNOWN");
  assert.deepEqual(unknown.projectRefs, []);
  for (const malformed of [
    { operationRef: "media.operation-slice.list-projects", outcome: "UNKNOWN_OBSERVATION", reason: "QUERY_UNAVAILABLE", records: [] },
    { ...result(), outcome: "UNKNOWN_OBSERVATION" },
    { ...result(), outcome: "OBSERVED", extra: "forged" },
    { ...result(), observedAt: "2026-02-31T12:00:00.000Z" },
    { ...result(), operationRef: "media.operation-slice.inspect-project" },
  ]) assert.equal(evaluateProjectListObservation(definition, request, malformed, trusted()).disposition, "HOLD_UNKNOWN");
});

test("the list query fails closed on trusted-scope, fingerprint, snapshot and row mismatches", () => {
  const foreignTenant = trusted(); foreignTenant.tenantId = "tenant-foreign";
  assert.equal(evaluateProjectListObservation(definition, request, result(), foreignTenant).disposition, "HOLD_UNKNOWN");

  const wrongFingerprint = trusted(); wrongFingerprint.serverComputedQueryFingerprint = `sha256:${"b".repeat(64)}`;
  assert.equal(evaluateProjectListObservation(definition, request, result(), wrongFingerprint).disposition, "HOLD_UNKNOWN");

  const tokenRequest = { workspaceId: "workspace-01", pageToken: "page-2" };
  const staleSnapshotContext = trusted(); staleSnapshotContext.snapshotRefForPageToken = "snapshot-old";
  assert.equal(evaluateProjectListObservation(definition, tokenRequest, result(), staleSnapshotContext).disposition, "HOLD_UNKNOWN");
  const foreignRecord = result({ records: [{
    projectId: "project-foreign", workspaceId: "workspace-foreign", title: "Foreign", headRevisionId: "revision-foreign", projectState: "ACTIVE",
  }] });
  assert.equal(evaluateProjectListObservation(definition, request, foreignRecord, trusted()).disposition, "HOLD_UNKNOWN");

  const invalidAuthority = trusted(); invalidAuthority.authorityObservation.disposition = "UNKNOWN";
  assert.equal(evaluateProjectListObservation(definition, request, result(), invalidAuthority).disposition, "HOLD_UNKNOWN");
  const deniedAuthority = trusted(); deniedAuthority.authorityObservation.disposition = "DENIED";
  const denied = evaluateProjectListObservation(definition, request, result(), deniedAuthority);
  assert.equal(denied.disposition, "DENIED");
  assert.deepEqual(denied.projectRefs, []);
  const noIdentity = trusted(); noIdentity.authorityObservation.disposition = "UNKNOWN";
  assert.equal(evaluateProjectListObservation(definition, request, result(), noIdentity).disposition, "HOLD_UNKNOWN");
  assert.equal(evaluateProjectListObservation(definition, { ...request, tenantId: "injected" }, result(), trusted()).disposition, "HOLD_UNKNOWN");
});
