import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("quality optimization routes are allow-listed with exact methods and canonical spellings", () => {
  const allowed = [
    ["GET", "/dev/v1/quality/status"],
    ["POST", "/dev/v1/quality/optimizations"],
    ["POST", "/dev/v1/quality/optimizations/opt-1/cancel"],
    ["GET", "/dev/v1/quality/optimizations/0f8fad5b-d9cb-469f-a165-70867728950e"],
    ["GET", "/dev/v1/quality/lineages/lineage-1"],
    ["POST", "/dev/v1/quality/lineages/lineage-1/undo"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["POST", "/dev/v1/quality/status"],
    ["GET", "/dev/v1/quality/optimizations"],
    ["PUT", "/dev/v1/quality/optimizations"],
    ["DELETE", "/dev/v1/quality/optimizations/opt-1"],
    ["GET", "/dev/v1/quality/optimizations/opt-1/cancel"],
    ["POST", "/dev/v1/quality/optimizations/opt-1"],
    ["DELETE", "/dev/v1/quality/lineages/lineage-1"],
    ["POST", "/dev/v1/quality/lineages/lineage-1"],
    ["GET", "/dev/v1/quality/lineages/lineage-1/undo"],
    ["GET", "/dev/v1/quality/lineages/a/b"],
    ["GET", "/dev/v1/quality/lineages/bad%2fid"],
    ["GET", "/dev/v1/quality/lineages/../projects"],
    ["POST", "/dev/v1/quality/optimizations?x=1"],
    ["POST", "/dev/v1/quality//optimizations"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/quality/lineages/lineage-1" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/quality/optimizations" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("the quality optimization page is DEV_ONLY, memory-token only, same-origin and accessible by construction", async () => {
  const [html, page, panel, adapter, css] = await Promise.all([
    read("dev-quality-optimization.html"), read("src/dev-quality-optimization.tsx"),
    read("src/dev-quality-optimization-panel.tsx"), read("src/dev-quality-optimization-client.ts"),
    read("src/dev-quality-optimization.css"),
  ]);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /Local development only/u);
  assert.match(html, /type="password" autocomplete="off"/u);
  assert.match(html, /src="\/src\/dev-quality-optimization\.tsx"/u);
  assert.ok(!/<script(?![^>]*\bsrc=)/u.test(html), "no inline script (strict CSP)");
  assert.ok(!/style=/u.test(html), "no inline style attribute (strict CSP)");
  assert.ok(!/style=\{/u.test(panel), "the panel sets no inline style (style-src-attr none)");
  assert.ok(css.length > 0);
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
    assert.ok(!page.includes(forbidden) && !adapter.includes(forbidden) && !panel.includes(forbidden), `${forbidden} must not persist the token`);
  }
  assert.match(page, /window\.location\.origin/u);
  assert.match(adapter, /credentials: "omit"/u);
  assert.match(adapter, /redirect: "error"/u);
  assert.match(adapter, /OUTCOME_UNKNOWN/u);
  for (const route of ["/dev/v1/quality/status", "/dev/v1/quality/optimizations", "/dev/v1/quality/lineages"]) {
    assert.ok(adapter.includes(route), route);
  }
  assert.ok(!/https?:\/\//u.test(adapter), "the adapter never names another origin");
  // Accessibility: a caption, column headers with scope, a live status region, labelled controls, a failure alert, a
  // focusable result heading and a verdict that is text, not colour.
  assert.match(panel, /<caption>Every attempt/u);
  assert.match(panel, /scope="col"/u);
  assert.match(panel, /aria-live="polite"/u);
  assert.match(panel, /role="alert"/u);
  assert.match(panel, /tabIndex=\{-1\}/u);
  assert.match(panel, /htmlFor="quality-threshold"/u);
  assert.match(panel, /Chosen/u);
  assert.match(css, /:focus-visible/u);
});
