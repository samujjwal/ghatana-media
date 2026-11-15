import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("erasure and legal-hold routes are allow-listed with exact methods and canonical spellings only", () => {
  const allowed = [
    ["GET", "/dev/v1/erasure-plans/artifact-1"],
    ["POST", "/dev/v1/erasures"],
    ["GET", "/dev/v1/erasures/erase-1"],
    ["POST", "/dev/v1/legal-holds"],
    ["GET", "/dev/v1/legal-holds/hold-0f8fad5b-d9cb-469f-a165-70867728950e"],
    ["POST", "/dev/v1/legal-holds/hold-1/release"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["DELETE", "/dev/v1/erasures"], ["DELETE", "/dev/v1/erasures/erase-1"], ["PUT", "/dev/v1/erasures"],
    ["GET", "/dev/v1/erasures"], ["POST", "/dev/v1/erasures/erase-1"], ["POST", "/dev/v1/erasures?x=1"],
    ["POST", "/dev/v1/erasure-plans/artifact-1"], ["GET", "/dev/v1/erasure-plans"], ["GET", "/dev/v1/erasure-plans/"],
    ["GET", "/dev/v1/legal-holds"], ["GET", "/dev/v1/legal-holds?artifactId=a"], ["DELETE", "/dev/v1/legal-holds/hold-1"],
    ["POST", "/dev/v1/legal-holds/hold-1"], ["GET", "/dev/v1/legal-holds/hold-1/release"], ["POST", "/dev/v1/legal-holds/hold-1/release/x"],
    ["GET", "/dev/v1/erasures/bad%2fid"], ["GET", "/dev/v1/erasures/a/b"], ["GET", "/dev/v1/erasures/../projects"],
    ["GET", "/dev/v1/erasures//erase-1"], ["GET", "/dev/v1/erasure-plans/a\\b"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/erasures/erase-1" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  assert.equal(response.headers["Cache-Control"], "no-store");
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/erasures" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("erasure page is DEV_ONLY, memory-token only, same-origin and calls only the DEV erasure routes", async () => {
  const [html, source, adapter] = await Promise.all([read("dev-erasure.html"), read("src/dev-erasure.tsx"), read("src/dev-erasure-client.ts")]);
  assert.match(html, /DEV_ONLY · owner scoped/u);
  assert.match(html, /not the same as revoking a rights statement/u);
  assert.match(html, /No quality, rights, approval or production claim/u);
  assert.match(source, /DevErasurePanel/u);
  assert.match(source, /bearerToken: \(\) => bearerToken \?\? ""/u);
  assert.match(source, /const origin = window\.location\.origin/u);
  assert.doesNotMatch(source + adapter, /localStorage|sessionStorage|indexedDB/u);
  for (const route of ["/dev/v1/erasure-plans/${encodeURIComponent(artifactId)}", "\"/dev/v1/erasures\"", "/dev/v1/erasures/${encodeURIComponent(erasureId)}",
    "\"/dev/v1/legal-holds\"", "/dev/v1/legal-holds/${encodeURIComponent(holdId)}/release"]) {
    assert.ok(adapter.includes(route), `adapter must call ${route}`);
  }
  assert.doesNotMatch(adapter, /\/api\/v1\/|method: "DELETE"/u, "the page never uses a canonical route or DELETE");
});
