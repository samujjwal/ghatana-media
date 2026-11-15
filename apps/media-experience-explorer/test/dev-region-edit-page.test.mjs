import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("region edit routes are allow-listed with exact methods and canonical spellings", () => {
  const allowed = [
    ["GET", "/dev/v1/region-edits/status"],
    ["POST", "/dev/v1/region-edits/lineages"],
    ["GET", "/dev/v1/region-edits/lineages/L1-0f8fad5b"],
    ["POST", "/dev/v1/region-edits/lineages/L1-0f8fad5b/edits"],
    ["POST", "/dev/v1/region-edits/lineages/L1-0f8fad5b/undo"],
    ["GET", "/dev/v1/artifacts/artifact-1/content"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["POST", "/dev/v1/region-edits/status"],
    ["GET", "/dev/v1/region-edits/lineages"],
    ["PUT", "/dev/v1/region-edits/lineages"],
    ["DELETE", "/dev/v1/region-edits/lineages/L1"],
    ["POST", "/dev/v1/region-edits/lineages/L1"],
    ["GET", "/dev/v1/region-edits/lineages/L1/edits"],
    ["GET", "/dev/v1/region-edits/lineages/L1/undo"],
    ["POST", "/dev/v1/region-edits/lineages/L1/redo"],
    ["POST", "/dev/v1/region-edits/lineages/a/b/edits"],
    ["GET", "/dev/v1/region-edits/lineages/bad%2fid"],
    ["GET", "/dev/v1/region-edits/lineages/../projects"],
    ["POST", "/dev/v1/region-edits/lineages/L1/edits?x=1"],
    ["POST", "/dev/v1/region-edits/lineages/L1/undo/"],
    ["POST", "/dev/v1//region-edits/lineages"],
    ["GET", "/dev/v1/region-edits"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/region-edits/lineages/L1" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/region-edits/lineages/L1/undo" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("the region edit page is DEV_ONLY, memory-token only and same-origin", async () => {
  const [html, source, adapter, css] = await Promise.all([
    read("dev-region-edit.html"), read("src/dev-region-edit.tsx"), read("src/dev-region-edit-client.ts"), read("src/dev-region-edit.css"),
  ]);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /Local development only/u);
  assert.match(html, /new version/u);
  assert.match(html, /type="password" autocomplete="off"/u);
  assert.match(html, /src="\/src\/dev-region-edit\.tsx"/u);
  assert.ok(!/<script(?![^>]*\bsrc=)/u.test(html), "no inline script (strict CSP)");
  assert.ok(!/style=/u.test(html), "no inline style attribute (strict CSP)");
  assert.ok(css.length > 0);
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
    assert.ok(!source.includes(forbidden) && !adapter.includes(forbidden), `${forbidden} must not persist the token`);
  }
  assert.match(source, /window\.location\.origin/u);
  assert.match(source, /DevRegionEditPanel/u);
  assert.match(adapter, /credentials: "omit"/u);
  assert.match(adapter, /redirect: "error"/u);
  assert.match(adapter, /OUTCOME_UNKNOWN/u);
  for (const route of ["status", "lineages", "/edits", "/undo"]) assert.ok(adapter.includes(route), route);
  assert.ok(!/https?:\/\//u.test(adapter), "the adapter never names another origin");
});
