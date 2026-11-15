import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("video routes are allow-listed with exact methods and canonical spellings only", () => {
  const allowed = [
    ["POST", "/dev/v1/video/enhancements"],
    ["POST", "/dev/v1/video/comparisons"],
    ["GET", "/dev/v1/video/enhancements/artifact-1"],
    ["GET", "/dev/v1/video/comparisons/0f8fad5b-d9cb-469f-a165-70867728950e"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["GET", "/dev/v1/video/enhancements"],
    ["GET", "/dev/v1/video/comparisons"],
    ["PUT", "/dev/v1/video/comparisons"],
    ["DELETE", "/dev/v1/video/comparisons/artifact-1"],
    ["POST", "/dev/v1/video/comparisons/artifact-1"],
    ["POST", "/dev/v1/video/enhancements/artifact-1"],
    ["POST", "/dev/v1/video/comparisons/"],
    ["POST", "/dev/v1/video/comparisons?x=1"],
    ["POST", "/dev/v1/video/comparisons/extra/more"],
    ["GET", "/dev/v1/video/comparisons/"],
    ["GET", "/dev/v1/video/comparisons/a/b"],
    ["GET", "/dev/v1/video/comparisons/bad%2fid"],
    ["GET", "/dev/v1/video/comparisons/../status"],
    ["GET", "/dev/v1/video/comparisons//artifact-1"],
    ["GET", "/dev/v1/video/comparisons/a\\b"],
    ["POST", "/dev/v1/video"],
    ["POST", "/dev/v1/video/other"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/video/comparisons" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/video/comparisons" }, { setHeader() {}, end() {} }, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("the page is a strict-CSP, token-in-memory host that renders only the comparison panel", async () => {
  const html = await read("dev-video-comparison.html");
  const script = await read("src/dev-video-comparison.tsx");
  const client = await read("src/dev-video-comparison-client.ts");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/u, "no inline script");
  assert.doesNotMatch(html, /\sstyle=/u, "no inline style attribute");
  assert.match(html, /type="password"/u);
  assert.match(script, /DevVideoComparisonPanel/u);
  assert.doesNotMatch(script + client, /localStorage|sessionStorage|document\.cookie/u, "the token is never persisted");
  assert.match(client, /credentials: "omit"/u);
  assert.match(client, /\/dev\/v1\/video\/comparisons/u);
  assert.match(client, /OUTCOME_UNKNOWN/u);
});
