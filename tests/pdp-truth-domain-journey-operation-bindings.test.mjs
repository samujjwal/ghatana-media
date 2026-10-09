import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const read = (path) => parse(readFileSync(resolve(root, path), "utf8"));
const operations = read(".product-experience/pdp-1-domain-data/operations.yaml");
const states = read(".product-experience/pdp-1-domain-data/states.yaml");
const domain = read(".product-experience/pdp-1-domain-data/domain-objects.yaml");
const requirements = read(".product-experience/pdp-0-product-truth/requirements.yaml");
const bindings = operations.ownerDefinedJourneyOperationBindings.records;
const opRecords = [
  ...operations.operations,
  ...operations.individualOperationContracts.records,
  ...operations.ownerDefinedOperationContracts.records,
];
const opById = new Map(opRecords.map((row) => [row.id, row]));
const caps = new Set(read(".product-experience/pdp-0-product-truth/capabilities.yaml").capabilities.map((row) => row.id));
const objects = new Set(domain.objects.map((row) => row.id));
const reqById = new Map(requirements.requirements.map((row) => [row.id, row]));
const sourceFiles = new Map([
  [".product-experience/pdp-1-domain-data/authority.yaml", read(".product-experience/pdp-1-domain-data/authority.yaml")],
  [".product-experience/pdp-1-domain-data/privacy.yaml", read(".product-experience/pdp-1-domain-data/privacy.yaml")],
  [".product-experience/pdp-0-product-truth/policy-authority-model.yaml", read(".product-experience/pdp-0-product-truth/policy-authority-model.yaml")],
  [".product-experience/pdp-0-product-truth/requirements.yaml", requirements],
  [".product-experience/pdp-1-domain-data/domain-objects.yaml", domain],
  [".product-experience/pdp-1-domain-data/states.yaml", states],
]);

function resolveRef(ref) {
  if (typeof ref !== "string" || !ref.includes("#")) return undefined;
  const [file, fragment] = ref.split("#", 2);
  let value = sourceFiles.get(file);
  if (!value || !fragment) return undefined;
  for (const part of fragment.split(/[./]/u).filter(Boolean)) {
    if (part.startsWith("@id=")) value = Array.isArray(value) ? value.find((row) => row.id === part.slice(4)) : undefined;
    else if (part.startsWith("@machineId=")) value = Array.isArray(value) ? value.find((row) => row.machineId === part.slice(11)) : undefined;
    else if (part.startsWith("@point=")) value = Array.isArray(value) ? value.find((row) => row.point === part.slice(7)) : undefined;
    else if (Array.isArray(value)) value = value.find((row) => row.id === part || row.machineId === part);
    else value = value && typeof value === "object" ? value[part] : undefined;
    if (value === undefined) return undefined;
  }
  return value;
}

function validBinding(row) {
  if (!row || typeof row.id !== "string" || !row.id.startsWith("media.pdp1.journey-operation-binding.")) return false;
  const [file, fragment] = row.journeyStepRef?.split("#", 2) ?? [];
  if (!file?.startsWith(".product-experience/pdp-3-product-experience/journey-contracts/") || !fragment?.startsWith("steps/")) return false;
  let journey;
  try { journey = read(file); } catch { return false; }
  const index = Number(fragment.slice("steps/".length));
  if (!Number.isInteger(index) || index < 0) return false;
  const step = journey.steps?.[index];
  if (!step || (row.journeyStepId && row.journeyStepId !== step.stepId)) return false;
  const operationRefs = row.operationRefs ?? [row.operationRef];
  if (!Array.isArray(operationRefs) || operationRefs.length === 0 || operationRefs.some((id) => !opById.has(id))) return false;
  if (operationRefs.length === 1 && step.canonicalOperationRef !== operationRefs[0]) return false;
  if (operationRefs.length > 1 && !(step.stepId === "J02-3" && step.action === "media.action.resume-artifact-upload"
    && operationRefs.join(",") === "media.operation-slice.append-upload-chunk,media.operation-slice.complete-upload")) return false;
  if (row.actionRef && row.actionRef !== (step.action ?? step.actionRef)) return false;
  if (!Array.isArray(row.capabilityRefs) || row.capabilityRefs.some((id) => !caps.has(id))) return false;
  if (!Array.isArray(row.domainObjectRefs) || row.domainObjectRefs.length === 0 || row.domainObjectRefs.some((id) => !objects.has(id))) return false;
  if (!Array.isArray(row.stateRefs) || row.stateRefs.some((ref) => !resolveRef(ref))) return false;
  if (!Array.isArray(row.authorityRefs) || row.authorityRefs.length === 0 || row.authorityRefs.some((ref) => !resolveRef(ref))) return false;
  if (!Array.isArray(row.requirementRefs) || row.requirementRefs.length === 0) return false;
  for (const ref of row.requirementRefs) {
    const req = resolveRef(ref);
    if (!req || !row.capabilityRefs.some((cap) => req.capabilityIds.includes(cap))) return false;
  }
  if (!row.ownerResultSemantics || !row.stateBindingDisposition || !Array.isArray(row.failClosedCases) || row.failClosedCases.length < 2) return false;
  if (!/NOT_ADMITTED/u.test(row.scopeStatus) || !/NOT_EVALUATED/u.test(row.scopeStatus)) return false;
  return true;
}

test("the 19 exact PDP-3 operation joins resolve to source-owned object, state, authority, requirement, and result contracts", () => {
  assert.equal(bindings.length, 19);
  assert.equal(new Set(bindings.map((row) => row.id)).size, 19);
  assert.equal(new Set(bindings.map((row) => row.journeyStepRef)).size, 19);
  for (const row of bindings) {
    assert.ok(validBinding(row), `${row.id} resolves its exact journey and owner joins`);
    for (const operationRef of row.operationRefs ?? [row.operationRef]) {
      const operation = opById.get(operationRef);
      assert.ok(operation, `${operationRef} exists`);
      assert.ok(row.sourceEvidenceRefs.includes(row.operationDefinitionRef ?? row.operationDefinitionRefs?.[0])
        || row.operationDefinitionRefs?.length, `${row.id} cites source operation evidence`);
    }
    assert.equal(row.scopeStatus.includes("ACCEPTED"), false, `${row.id} does not claim independent acceptance`);
  }
  const noState = bindings.filter((row) => row.stateRefs.length === 0);
  assert.ok(noState.length > 0);
  assert.ok(noState.every((row) => /NO_STATE|READ_ONLY|SESSION_LOCAL|APPEND_ONLY/u.test(row.stateBindingDisposition)),
    "absence of a state link is reasoned, not a silent omission");
  const artifactReads = bindings.filter((row) => row.operationRef === "media.operation-slice.inspect-artifact");
  assert.ok(artifactReads.length >= 3);
  assert.ok(artifactReads.every((row) => row.supportingObservationOperationRefs.includes("media.operation.artifact.lifecycle.observe.v1")));
});

test("binding resolution fails closed for substituted operations, foreign state/authority refs, and requirement drift", () => {
  const row = bindings.find((item) => item.journeyStepId === "J01-3");
  assert.ok(row);
  assert.equal(validBinding({ ...row, operationRef: "media.operation.unknown" }), false);
  assert.equal(validBinding({ ...row, stateRefs: [".product-experience/pdp-1-domain-data/states.yaml#stateMachines/media-job/stateDefinitions/NOT_A_STATE"] }), false);
  assert.equal(validBinding({ ...row, authorityRefs: [".product-experience/pdp-1-domain-data/authority.yaml#attacker.tenant"] }), false);
  assert.equal(validBinding({ ...row, requirementRefs: [".product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-FAKE"] }), false);
  assert.equal(validBinding({ ...row, domainObjectRefs: ["media.domain.unregistered"] }), false);
});
