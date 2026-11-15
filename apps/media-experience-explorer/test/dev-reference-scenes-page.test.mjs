import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("reference scene routes are allow-listed with exact methods and canonical spellings", () => {
  const allowed = [
    ["GET", "/dev/v1/reference-scenes/status"],
    ["POST", "/dev/v1/reference-scenes/reference-sets"],
    ["GET", "/dev/v1/reference-scenes/reference-sets/0f8fad5b-d9cb-469f-a165-70867728950e"],
    ["POST", "/dev/v1/reference-scenes/runs"],
    ["GET", "/dev/v1/reference-scenes/runs/0f8fad5b-d9cb-469f-a165-70867728950e"],
    ["POST", "/dev/v1/reference-scenes/runs/0f8fad5b-d9cb-469f-a165-70867728950e/regenerations"],
    ["GET", "/dev/v1/artifacts/artifact-1/content"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["POST", "/dev/v1/reference-scenes/status"],
    ["GET", "/dev/v1/reference-scenes/runs"],
    ["PUT", "/dev/v1/reference-scenes/runs"],
    ["DELETE", "/dev/v1/reference-scenes/runs/abc"],
    ["POST", "/dev/v1/reference-scenes/runs/abc"],
    ["GET", "/dev/v1/reference-scenes/runs/abc/regenerations"],
    ["GET", "/dev/v1/reference-scenes/runs/a/b"],
    ["GET", "/dev/v1/reference-scenes/runs/bad%2fid"],
    ["GET", "/dev/v1/reference-scenes/runs/../projects"],
    ["POST", "/dev/v1/reference-scenes/runs?x=1"],
    ["POST", "/dev/v1/reference-scenes/runs/"],
    ["POST", "/dev/v1//reference-scenes/runs"],
    ["DELETE", "/dev/v1/reference-scenes/reference-sets/abc"],
    ["GET", "/dev/v1/reference-scenes"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/reference-scenes/runs/abc" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/reference-scenes/runs" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("the reference scenes page is DEV_ONLY, memory-token only, same-origin and accessible", async () => {
  const [html, entry, adapter, panel, css] = await Promise.all([
    read("dev-reference-scenes.html"), read("src/dev-reference-scenes.tsx"), read("src/dev-reference-scenes-client.ts"),
    read("src/dev-reference-scenes-panel.tsx"), read("src/dev-reference-scenes.css"),
  ]);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /Local development only/u);
  assert.match(html, /MODEL_UNAVAILABLE/u);
  assert.match(html, /type="password" autocomplete="off"/u);
  assert.match(html, /src="\/src\/dev-reference-scenes\.tsx"/u);
  assert.ok(!/<script(?![^>]*\bsrc=)/u.test(html), "no inline script (strict CSP)");
  assert.ok(!/style=/u.test(html), "no inline style attribute (strict CSP)");
  assert.ok(css.length > 0);
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
    assert.ok(!entry.includes(forbidden) && !adapter.includes(forbidden) && !panel.includes(forbidden), `${forbidden} must not persist the token`);
  }
  assert.ok(!/style=\{/u.test(panel), "no inline style props (strict CSP)");
  assert.match(entry, /window\.location\.origin/u);
  assert.match(adapter, /credentials: "omit"/u);
  assert.match(adapter, /redirect: "error"/u);
  assert.match(adapter, /OUTCOME_UNKNOWN/u);
  assert.match(adapter, /\/dev\/v1\/reference-scenes\/runs/u);
  assert.ok(!/https?:\/\//u.test(adapter), "the adapter never names another origin");
  // Accessibility contracts: labelled inputs, a live region, an alert region that takes focus, captions and scoped headers.
  assert.match(panel, /aria-live="polite"/u);
  assert.match(panel, /role="alert"/u);
  assert.match(panel, /<caption>/u);
  assert.match(panel, /scope="col"/u);
  assert.match(panel, /alt=\{/u);
  assert.match(panel, /data-path=/u);
});
