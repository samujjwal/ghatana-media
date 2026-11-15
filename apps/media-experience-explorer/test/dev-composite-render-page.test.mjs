import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("composite render routes are allow-listed with exact methods and canonical spellings", () => {
  const allowed = [
    ["GET", "/dev/v1/composite-renders/capabilities"],
    ["POST", "/dev/v1/composite-renders"],
    ["POST", "/dev/v1/composite-renders/composite-0f8fad5b/cancel"],
    ["GET", "/dev/v1/composite-renders/0f8fad5b-d9cb-469f-a165-70867728950e"],
    ["POST", "/dev/v1/projects/project-1/timelines/timeline-main/edits"],
    ["GET", "/dev/v1/artifacts/artifact-1/content"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["POST", "/dev/v1/composite-renders/capabilities"],
    ["GET", "/dev/v1/composite-renders"],
    ["PUT", "/dev/v1/composite-renders"],
    ["DELETE", "/dev/v1/composite-renders/artifact-1"],
    ["GET", "/dev/v1/composite-renders/a/cancel"],
    ["GET", "/dev/v1/composite-renders/a/b"],
    ["POST", "/dev/v1/composite-renders/a"],
    ["POST", "/dev/v1/composite-renders/bad%2fid/cancel"],
    ["POST", "/dev/v1/composite-renders/../projects/cancel"],
    ["POST", "/dev/v1/composite-renders?x=1"],
    ["POST", "/dev/v1/composite-renders/"],
    ["POST", "/dev/v1//composite-renders"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/composite-renders/artifact-1" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/composite-renders" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("the composite render page is DEV_ONLY, memory-token only and same-origin", async () => {
  const [html, source, adapter, css] = await Promise.all([
    read("dev-composite-render.html"), read("src/dev-composite-render.tsx"), read("src/dev-composite-render-client.ts"), read("src/dev-composite-render.css"),
  ]);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /Local development only/u);
  assert.match(html, /Every source needs its own rights statement/u);
  assert.match(html, /type="password" autocomplete="off"/u);
  assert.match(html, /src="\/src\/dev-composite-render\.tsx"/u);
  assert.ok(!/<script(?![^>]*\bsrc=)/u.test(html), "no inline script (strict CSP)");
  assert.ok(!/style=/u.test(html), "no inline style attribute (strict CSP)");
  assert.ok(css.length > 0);
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
    assert.ok(!source.includes(forbidden) && !adapter.includes(forbidden), `${forbidden} must not persist the token`);
  }
  assert.match(source, /window\.location\.origin/u);
  assert.match(source, /DevCompositeRenderPanel/u);
  assert.match(adapter, /credentials: "omit"/u);
  assert.match(adapter, /redirect: "error"/u);
  assert.match(adapter, /OUTCOME_UNKNOWN/u);
  assert.match(adapter, /\/dev\/v1\/composite-renders\/capabilities/u);
  assert.match(adapter, /\/dev\/v1\/composite-renders/u);
  assert.match(adapter, /\/cancel/u);
  assert.ok(!/https?:\/\//u.test(adapter), "the adapter never names another origin");
});
