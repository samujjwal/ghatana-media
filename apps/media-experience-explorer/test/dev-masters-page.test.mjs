import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("master routes are allow-listed with exact methods and canonical spellings", () => {
  const allowed = [
    ["GET", "/dev/v1/masters/status"],
    ["POST", "/dev/v1/masters/stems"],
    ["GET", "/dev/v1/masters/stems/0f8fad5b-d9cb-469f-a165-70867728950e"],
    ["POST", "/dev/v1/masters"],
    ["GET", "/dev/v1/masters/0f8fad5b-d9cb-469f-a165-70867728950e"],
    ["GET", "/dev/v1/artifacts/artifact-1/content"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["POST", "/dev/v1/masters/status"],
    ["GET", "/dev/v1/masters"],
    ["PUT", "/dev/v1/masters"],
    ["DELETE", "/dev/v1/masters/abc"],
    ["POST", "/dev/v1/masters/abc"],
    ["GET", "/dev/v1/masters/stems"],
    ["GET", "/dev/v1/masters/a/b"],
    ["GET", "/dev/v1/masters/bad%2fid"],
    ["GET", "/dev/v1/masters/../projects"],
    ["POST", "/dev/v1/masters?x=1"],
    ["POST", "/dev/v1/masters/"],
    ["POST", "/dev/v1//masters"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/masters/abc" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/masters" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("the masters page is DEV_ONLY, memory-token only and same-origin", async () => {
  const [html, source, adapter, css] = await Promise.all([
    read("dev-masters.html"), read("src/dev-masters.tsx"), read("src/dev-master-client.ts"), read("src/dev-masters.css"),
  ]);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /Local development only/u);
  assert.match(html, /No rights clearance beyond those statements/u);
  assert.match(html, /type="password" autocomplete="off"/u);
  assert.match(html, /src="\/src\/dev-masters\.tsx"/u);
  assert.ok(!/<script(?![^>]*\bsrc=)/u.test(html), "no inline script (strict CSP)");
  assert.ok(!/style=/u.test(html), "no inline style attribute (strict CSP)");
  assert.ok(css.length > 0);
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
    assert.ok(!source.includes(forbidden) && !adapter.includes(forbidden), `${forbidden} must not persist the token`);
  }
  assert.match(source, /window\.location\.origin/u);
  assert.match(source, /DevMasterPanel/u);
  assert.match(adapter, /credentials: "omit"/u);
  assert.match(adapter, /redirect: "error"/u);
  assert.match(adapter, /OUTCOME_UNKNOWN/u);
  assert.match(adapter, /\/dev\/v1\/masters\/status/u);
  assert.match(adapter, /\/dev\/v1\/masters\/stems/u);
  assert.match(adapter, /"\/dev\/v1\/masters"/u);
  assert.ok(!/https?:\/\//u.test(adapter), "the adapter never names another origin");
});
