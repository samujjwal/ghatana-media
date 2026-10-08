import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const repoRequire = createRequire(resolve(root, "../ghatana-tools/package.json"));
const { parse: parseYaml } = repoRequire("yaml");
const contractPath = ".product-experience/pdp-3-product-experience/search-inspection-contracts.yaml";
const contractText = readFileSync(resolve(root, contractPath), "utf8");
const contract = parseYaml(contractText);
const bindingsPath = ".product-experience/pdp-3-product-experience/experience-source-bindings.yaml";
const bindingsText = readFileSync(resolve(root, bindingsPath), "utf8");
const bindings = parseYaml(bindingsText);

const domainObjectsText = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/domain-objects.yaml"), "utf8");
const operationsText = readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8");
const declaredTypes = new Set([...domainObjectsText.matchAll(/^\s+- id: (media\.domain\.[\w.-]+)$/gmu)].map(([, id]) => id));
const declaredOperations = new Set([...operationsText.matchAll(/^\s+- id: (media\.operation\.[\w.-]+)$/gmu)].map(([, id]) => id));

function sourcePath(ref) {
  return ref.split("#")[0];
}

test("search and inspection records match the public ExperienceSpecification schema", () => {
  assert.deepEqual(contract.search.map(({ id }) => id), [
    "media.search.authorized-projects",
    "media.search.authorized-artifacts",
    "media.search.authorized-jobs",
  ]);
  assert.deepEqual(contract.search.map(({ searchableTypes }) => searchableTypes), [
    ["media.domain.project"],
    ["media.domain.artifact-version"],
    ["media.domain.processing-job", "media.domain.artifact-verification-job"],
  ]);
  for (const entry of contract.search) {
    assert.deepEqual(Object.keys(entry).sort(), ["description", "id", "name", "searchableTypes"]);
    assert.ok(entry.description);
    for (const type of entry.searchableTypes) assert.ok(declaredTypes.has(type), `${entry.id}: undeclared PDP-1 type ${type}`);
  }

  assert.deepEqual(contract.inspections.map(({ id, projectionKind }) => [id, projectionKind]), [
    ["media.inspection.specification", "specification"],
    ["media.inspection.authority", "authority"],
    ["media.inspection.evidence", "evidence"],
    ["media.inspection.trace", "trace"],
    ["media.inspection.synthetic-simulation", "simulation"],
  ]);
  for (const entry of contract.inspections) {
    assert.deepEqual(Object.keys(entry).sort(), ["description", "id", "projectionKind"]);
    assert.ok(entry.description);
  }
});

test("PXD-027 selects Media search and inspection definitions without admitting runtime or phase acceptance", () => {
  const decisionLog = readFileSync(resolve(root, ".product-experience/decision-log.md"), "utf8");
  assert.ok(decisionLog.includes("### PXD-027 — Approve bounded semantic-source decisions"));
  assert.ok(decisionLog.includes("Approved PDP-3 search/inspection semantics"));
  assert.match(contractText, /^status: OWNER_POLICY_SELECTED; IMPLEMENTATION_AND_INDEPENDENT_ACCEPTANCE_PENDING$/mu);
  assert.match(contractText, /runtimeBinding: NOT_ADMITTED/u);
  assert.match(contractText, /IMPLEMENTATION_AND_INDEPENDENT_ACCEPTANCE_PENDING/u);
  assert.equal(contract.status.includes("ACCEPTED"), false);
});

test("source bindings use exact PDP-1 types and leave unsupported operation semantics unresolved", () => {
  const expectedTypes = new Map([
    ["media.search.authorized-projects", ["media.domain.project"]],
    ["media.search.authorized-artifacts", ["media.domain.artifact-version"]],
    ["media.search.authorized-jobs", ["media.domain.processing-job", "media.domain.artifact-verification-job"]],
  ]);
  assert.deepEqual(bindings.searchBindings.map(({ searchId }) => searchId), [...expectedTypes.keys()]);
  for (const row of bindings.searchBindings) {
    assert.deepEqual(row.searchableTypeRefs, expectedTypes.get(row.searchId));
    assert.ok(row.searchableTypeRefs.every((id) => declaredTypes.has(id)), `${row.searchId} references only declared domain objects`);
    assert.deepEqual(row.pdp1OperationRefs, []);
    assert.equal(row.operationBindingStatus, "unresolved-no-source-explicit-search-operation");
    for (const ref of row.sourceRefs) assert.ok(existsSync(resolve(root, sourcePath(ref))), `${row.searchId} source ${ref} exists`);
  }
  const jobSearch = bindings.searchBindings.find(({ searchId }) => searchId === "media.search.authorized-jobs");
  assert.deepEqual(jobSearch.observedProtocolOperationRefs, ["media.http.listMediaJobs"]);
  assert.match(jobSearch.observedProtocolBindingStatus, /^proposal-only;/u);
  for (const row of bindings.searchBindings) {
    for (const operation of row.pdp1OperationRefs) assert.ok(declaredOperations.has(operation), `${row.searchId} uses only declared PDP-1 operations`);
  }
});

test("negative checks reject invented domain and operation identities", () => {
  const inventedType = structuredClone(bindings.searchBindings);
  inventedType[0].searchableTypeRefs = ["media.domain.project-search-index"];
  assert.ok(inventedType[0].searchableTypeRefs.some((id) => !declaredTypes.has(id)));

  const inventedOperation = structuredClone(bindings.searchBindings);
  inventedOperation[0].pdp1OperationRefs = ["media.operation.search-projects"];
  assert.ok(inventedOperation[0].pdp1OperationRefs.some((id) => !declaredOperations.has(id)));
});

test("inspection identities carry explicit resolvable source authorities", () => {
  assert.deepEqual(bindings.inspectionBindings.map(({ inspectionId }) => inspectionId), [
    "media.inspection.specification", "media.inspection.authority", "media.inspection.evidence",
    "media.inspection.trace", "media.inspection.synthetic-simulation",
  ]);
  for (const row of bindings.inspectionBindings) {
    assert.ok(row.sourceRefs.length, `${row.inspectionId} needs explicit sources`);
    for (const ref of row.sourceRefs) assert.ok(existsSync(resolve(root, sourcePath(ref))), `${row.inspectionId} source ${ref} exists`);
  }
});

test("observed job-search protocol details do not claim unprovided query or continuation semantics", () => {
  const openApi = readFileSync(resolve(root, "contracts/openapi/media.yaml"), "utf8");
  const listJobs = readFileSync(resolve(root, ".product-experience/pdp-3-product-experience/api/operations/listMediaJobs.yaml"), "utf8");
  const jobsCollection = openApi.split("  /api/v1/jobs:\n")[1]?.split("  /api/v1/jobs/{jobId}:")[0];
  assert.ok(jobsCollection);
  assert.match(jobsCollection, /name: limit,[\s\S]*?minimum: 1, maximum: 1000, default: 100/u);
  assert.match(jobsCollection, /required: \[jobs\]/u);
  assert.match(jobsCollection, /requiredAccess: OPERATOR[\s\S]*?requiresAuth: true[\s\S]*?requiresTenant: true/u);
  assert.match(openApi, /name: X-Tenant-Id,[\s\S]*?required: true/u);
  assert.match(listJobs, /logicalOperationRef: null/u);
  assert.match(contractText, /runtimeBinding: NOT_ADMITTED/u);
  assert.deepEqual(bindings.searchBindings.find(({ searchId }) => searchId === "media.search.authorized-jobs").pdp1OperationRefs, []);
});
