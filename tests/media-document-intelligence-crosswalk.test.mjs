import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const observation = JSON.parse(readFileSync(resolve(root, "docs/migration/external-platform-contract-observation.json"), "utf8"));
const crosswalk = readFileSync(resolve(root, "docs/migration/document-intelligence-media-crosswalk.md"), "utf8");
const source = (repository, path) => {
  const snapshot = observation.sourceSnapshots.find((item) => item.repository === repository);
  return snapshot && existsSync(resolve(snapshot.path, path))
    ? readFileSync(resolve(snapshot.path, path), "utf8")
    : null;
};

test("X-04 crosswalk is bounded by the observed worker v1 client and Media OCR boundary", (t) => {
  const client = source("samujjwal/ghatana", "services/document-intelligence/clients/typescript/src/client.ts");
  const protocol = source("samujjwal/ghatana", "services/document-intelligence/clients/typescript/src/protocol.ts");
  const validators = source("samujjwal/ghatana", "services/document-intelligence/clients/typescript/src/validators.ts");
  const workerContract = source("samujjwal/ghatana", "services/document-intelligence/contracts/protocol-v1.md");
  const packageJson = source("samujjwal/ghatana", "services/document-intelligence/clients/typescript/package.json");
  if (![client, protocol, validators, workerContract, packageJson].every(Boolean)) {
    t.skip("Document Intelligence sibling checkout is unavailable; X-04 source conformance cannot be checked");
    return;
  }

  const packageMetadata = JSON.parse(packageJson);
  assert.equal(packageMetadata.name, "@ghatana/document-intelligence-client");
  assert.equal(packageMetadata.version, "0.1.0");
  assert.equal(packageMetadata.private, false);
  assert.equal(packageMetadata.peerDependencies["@ghatana/document-extraction"], "0.1.0-SNAPSHOT");

  assert.match(client, /async parse\(input: ParseTransportInput\)/u);
  assert.match(client, /form\.append\('metadata'/u);
  assert.match(client, /form\.append\('file'/u);
  assert.match(client, /request\('\/v1\/parse'/u);
  assert.match(client, /async cancel\(operationId: string, operationGeneration: string\)/u);
  assert.match(client, /\/v1\/operations\/\$\{encodeURIComponent\(operationId\)\}/u);
  assert.match(client, /headers: \{ 'x-operation-generation': operationGeneration \}/u);
  assert.match(protocol, /interface WireLine[\s\S]*?text: string[\s\S]*?boundingRegion: WireBox[\s\S]*?confidence\?: number/u);
  assert.match(protocol, /interface WirePage[\s\S]*?pageNumber: number[\s\S]*?blocks: readonly WireBlock/u);
  assert.match(protocol, /interface WireIdentity[\s\S]*?providerRef: string[\s\S]*?providerVersion: string[\s\S]*?modelRef\?: string[\s\S]*?modelVersion\?: string/u);
  assert.match(validators, /Number\(value\.x\) \+ Number\(value\.width\) <= 1[\s\S]*?Number\(value\.y\) \+ Number\(value\.height\) <= 1/u);
  assert.match(workerContract, /zero-based, end-exclusive UTF-16 code-unit offsets/u);
  assert.match(workerContract, /stale token cannot cancel a newer operation/u);

  assert.match(crosswalk, /source-observed conformance crosswalk; no runtime binding or owner/u);
  assert.match(crosswalk, /No tenant or consent propagation is established/u);
  assert.match(crosswalk, /No timestamp or temporal association/u);
  assert.match(crosswalk, /Not a direct field mapping/u);
  assert.match(crosswalk, /do not establish an immutable published\s+artifact/u);
  assert.match(crosswalk, /qualification, deployment/u);
  assert.match(crosswalk, /0\.1\.0-SNAPSHOT/u);
});
