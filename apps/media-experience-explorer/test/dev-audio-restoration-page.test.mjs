import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("audio routes are allow-listed with exact methods and canonical spellings", () => {
  const allowed = [
    ["GET", "/dev/v1/audio/status"],
    ["POST", "/dev/v1/audio/restorations"],
    ["POST", "/dev/v1/audio/comparisons"],
    ["GET", "/dev/v1/audio/outputs/artifact-1"],
    ["GET", "/dev/v1/audio/outputs/0f8fad5b-d9cb-469f-a165-70867728950e"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["POST", "/dev/v1/audio/status"],
    ["GET", "/dev/v1/audio/restorations"],
    ["PUT", "/dev/v1/audio/restorations"],
    ["DELETE", "/dev/v1/audio/outputs/artifact-1"],
    ["GET", "/dev/v1/audio/comparisons"],
    ["POST", "/dev/v1/audio/outputs/artifact-1"],
    ["GET", "/dev/v1/audio/outputs"],
    ["GET", "/dev/v1/audio/outputs/"],
    ["GET", "/dev/v1/audio/outputs/a/b"],
    ["GET", "/dev/v1/audio/outputs/bad%2fid"],
    ["GET", "/dev/v1/audio/outputs/../projects"],
    ["POST", "/dev/v1/audio/restorations?x=1"],
    ["POST", "/dev/v1/audio/restorations/"],
    ["POST", "/dev/v1/audio//restorations"],
    ["POST", "/dev/v1/audio/transcriptions"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/audio/outputs/x" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/audio/restorations" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("the audio restoration page is DEV_ONLY, memory-token only and same-origin", async () => {
  const [html, source, adapter] = await Promise.all([
    read("dev-audio-restoration.html"), read("src/dev-audio-restoration.tsx"), read("src/dev-audio-restoration-client.ts"),
  ]);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /Local development only/u);
  assert.match(html, /never modified/u);
  assert.match(html, /type="password" autocomplete="off"/u);
  assert.ok(!/<script(?![^>]*\bsrc=)/u.test(html), "no inline script (strict CSP)");
  assert.ok(!/style=/u.test(html), "no inline style attribute (strict CSP)");
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
    assert.ok(!source.includes(forbidden) && !adapter.includes(forbidden), `${forbidden} must not persist the token`);
  }
  assert.match(source, /window\.location\.origin/u);
  assert.match(adapter, /credentials: "omit"/u);
  assert.match(adapter, /redirect: "error"/u);
  assert.match(adapter, /OUTCOME_UNKNOWN/u);
  assert.ok(!/https?:\/\//u.test(adapter), "the adapter never names another origin");
});
