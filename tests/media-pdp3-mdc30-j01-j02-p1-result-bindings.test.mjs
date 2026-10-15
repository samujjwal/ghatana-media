import assert from "node:assert/strict";
import test from "node:test";
import { createRequire } from "node:module";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

const require = createRequire(resolve(process.cwd(), "../ghatana-tools/package.json"));
const { parse } = require("yaml");
const p1Path = ".product-experience/pdp-1-domain-data/operations.yaml";
const p3Path = ".product-experience/pdp-3-product-experience";
const purposePath = `${p3Path}/journey-purpose-bindings.yaml`;
const [operationsText, purposesText, projectText, uploadText] = await Promise.all([
  readFile(p1Path, "utf8"),
  readFile(purposePath, "utf8"),
  readFile(`${p3Path}/journey-contracts/first-use-and-project-creation.yaml`, "utf8"),
  readFile(`${p3Path}/journey-contracts/upload-import-and-verify-artifact.yaml`, "utf8"),
]);
const operations = parse(operationsText);
const purposes = new Map(parse(purposesText).records.map((record) => [record.id, record]));
const journeys = new Map([
  ["J-01", parse(projectText)],
  ["J-02", parse(uploadText)],
]);

function resolveSourceRef(ref) {
  assert.ok(ref.startsWith(`${p1Path}#`), `not a P1 operation source ref: ${ref}`);
  const selector = ref.slice(ref.indexOf("#") + 1);
  let value = operations;
  for (const segment of selector.split("/")) {
    if (segment.startsWith("@id=")) {
      assert.ok(Array.isArray(value), `@id selector requires an array in ${ref}`);
      value = value.find((item) => item.id === segment.slice(4));
    } else if (Array.isArray(value) && /^\d+$/u.test(segment)) {
      value = value[Number(segment)];
    } else {
      value = value?.[segment];
    }
    assert.notEqual(value, undefined, `unresolved P1 source ref: ${ref}`);
  }
  return value;
}

function assertJourneyBindings(journeyId, expected) {
  const journey = journeys.get(journeyId);
  const bindings = journey.pdp1ResultEvidence.operationResultBindings;
  assert.equal(bindings.length, expected.length, `${journeyId} must bind every source-backed operation once`);
  assert.deepEqual(bindings.map(({ operationRef }) => operationRef).sort(), expected.map(({ operationRef }) => operationRef).sort());
  for (const expectedBinding of expected) {
    const binding = bindings.find((item) => item.operationRef === expectedBinding.operationRef);
    const purpose = purposes.get(expectedBinding.purposeId);
    assert.ok(purpose, `missing purpose ${expectedBinding.purposeId}`);
    assert.equal(binding.purposeBindingRef, `${purposePath}#records/@id=${purpose.id}`);
    assert.equal(binding.journeyStepRef, purpose.stepRef);
    assert.ok([...(purpose.operationRefs ?? []), ...(purpose.actionExactOperationRefs ?? [])].includes(binding.operationRef));
    assert.equal(binding.operationVersion, 1);
    assert.equal(resolveSourceRef(binding.operationVersionRef), 1);
    assert.ok(resolveSourceRef(binding.resultSchemaRef), `${binding.operationRef} needs an exact typed result schema`);
    assert.ok(binding.authorityRefs.length > 0);
    for (const ref of binding.authorityRefs) assert.ok(resolveSourceRef(ref), `missing authority source ${ref}`);
    for (const field of ["finalityRef", "unknownDispositionRef", "recoveryRef"]) {
      assert.ok(resolveSourceRef(binding[field]), `${binding.operationRef} needs ${field}`);
    }
    assert.ok(binding.exactResult?.trim());
    assert.ok(binding.unknownDisposition?.trim());
    assert.ok(binding.errorsAndRecovery?.trim());
  }
}

test("J-01 project steps bind exact P1 operation results and unknown recovery semantics", () => {
  assertJourneyBindings("J-01", [
    { operationRef: "media.operation-slice.list-projects", purposeId: "media.pdp3.step-purpose-binding.j01-step-02.v1" },
    { operationRef: "media.operation-slice.create-project", purposeId: "media.pdp3.step-purpose-binding.j01-step-03.v1" },
    { operationRef: "media.operation-slice.inspect-project", purposeId: "media.pdp3.step-purpose-binding.j01-step-04.v1" },
  ]);
});

test("J-02 upload and verification steps bind exact P1 operation results and unknown recovery semantics", () => {
  assertJourneyBindings("J-02", [
    { operationRef: "media.operation-slice.begin-upload", purposeId: "media.pdp3.step-purpose-binding.j02-step-02.v1" },
    { operationRef: "media.operation-slice.append-upload-chunk", purposeId: "media.pdp3.step-purpose-binding.j02-step-03.v1" },
    { operationRef: "media.operation-slice.complete-upload", purposeId: "media.pdp3.step-purpose-binding.j02-step-03.v1" },
    { operationRef: "media.operation-slice.inspect-upload", purposeId: "media.pdp3.step-purpose-binding.j02-step-03.v1" },
    { operationRef: "media.operation.action.view-job-status", purposeId: "media.pdp3.step-purpose-binding.j02-step-04.v1" },
    { operationRef: "media.operation-slice.inspect-artifact-version", purposeId: "media.pdp3.step-purpose-binding.j02-step-05.v1" },
  ]);
});
