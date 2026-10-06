import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const source = readFileSync(new URL("../apps/media-experience-explorer/src/main.ts", import.meta.url), "utf8");
const artifacts = JSON.parse(readFileSync(new URL("../apps/media-experience-explorer/specification-artifacts.json", import.meta.url), "utf8"));

test("Verify has no durable task-local pass or blocked result claim", () => {
  const start = source.indexOf("function verificationSurface(): string {");
  const end = source.indexOf("\ninterface IndexedInterfaceRow", start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const verifyView = source.slice(start, end);
  assert.doesNotMatch(verifyView, /\b(?:PASS|BLOCKED)\b/u);
  assert.match(verifyView, /NOT SUPPLIED/u);
  assert.match(verifyView, /No durable run report is indexed/u);
  assert.match(verifyView, /data-artifact=/u);
});

test("HTTP and gRPC contractFile references resolve to exact indexed operation artifacts", () => {
  const sources = [
    [".product-experience/pdp-3-product-experience/api/api-registry.yaml", "api/operations/", 27],
    [".product-experience/pdp-3-product-experience/grpc/service-registry.yaml", "grpc/operations/", 43],
  ];
  for (const [registryPath, operationDirectory, expectedCount] of sources) {
    const registry = readFileSync(new URL(`../${registryPath}`, import.meta.url), "utf8");
    const contractFiles = [...registry.matchAll(/^[ \t]+contractFile:[ \t]*(operations\/[A-Za-z0-9._-]+\.ya?ml)[ \t]*$/gmu)].map((match) => match[1]);
    assert.equal(contractFiles.length, expectedCount, `${registryPath} contract reference denominator`);
    const prefix = registryPath.slice(0, registryPath.lastIndexOf("/") + 1);
    for (const contractFile of contractFiles) {
      const exactPath = `${prefix}${contractFile}`;
      assert.ok(artifacts.some((artifact) => artifact.path === exactPath), `missing exact indexed contract: ${exactPath}`);
    }
  }
  assert.match(source, /function indexedOperationContractPath/u);
  assert.match(source, /specificationArtifacts\.some\(\(artifact\) => artifact\.path === candidate\)/u);
  assert.ok(source.includes('data-artifact="${escapeHtml(row.contractPath)}"'));
  assert.match(source, /Open matching indexed operation contract/u);
});

test("non-contract interface rows are explicitly registry-only and scalar projection is qualified", () => {
  assert.match(source, /REGISTRY VIEW ONLY/u);
  assert.match(source, /Partial registry scalar observations \(not a full contract\)/u);
  assert.match(source, /SDK, CLI, event, and Agent Tool rows without a per-operation contract remain registry-only/u);
  assert.match(source, /Per-operation contract reference/u);
  assert.match(source, /exact contractFile value remains visible/u);
  assert.match(source, /row\.contractPath \? .*Open matching indexed operation contract/su);
});
