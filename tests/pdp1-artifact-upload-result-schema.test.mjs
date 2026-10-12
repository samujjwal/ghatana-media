import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const parse = createRequire(resolve(root, "../ghatana-tools/package.json"))("yaml").parse;
const operations = parse(readFileSync(resolve(root, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8"));

test("begin-upload success carries the exact owner-acknowledged upload state payload", () => {
  const operation = operations.individualOperationContracts.records.find(({ id }) => id === "media.operation-slice.begin-upload");
  const branch = operation?.ownerWireSchema?.resultSchema?.properties?.outputs?.items?.oneOf?.find(
    ({ properties }) => properties?.artifactType?.const === "stable-uploadId-and-owner-acknowledged-transfer-state",
  );
  const payload = branch?.properties?.payload;
  assert.deepEqual(payload?.required, ["value"]);
  assert.deepEqual(payload?.properties?.value?.required, [
    "uploadId",
    "uploadVersionRef",
    "transferState",
    "expectedByteLength",
    "acknowledgedByteRanges",
    "expectedSha256",
    "ownerReceiptRef",
    "observedAt",
  ]);
  assert.equal(payload?.properties?.value?.properties?.expectedByteLength?.maximum, 2_147_483_648);
  assert.equal(payload?.properties?.value?.properties?.verificationRef, undefined);
});
