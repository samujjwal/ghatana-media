import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("translation and dubbing routes are allow-listed with exact methods and canonical spellings", () => {
  const allowed = [
    ["GET", "/dev/v1/translations/capabilities"],
    ["POST", "/dev/v1/translations"],
    ["POST", "/dev/v1/translations/revisions"],
    ["GET", "/dev/v1/translations/artifact-1"],
    ["POST", "/dev/v1/dubs"],
    ["GET", "/dev/v1/dubs/0f8fad5b-d9cb-469f-a165-70867728950e"],
    ["GET", "/dev/v1/artifacts/artifact-1/content"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["POST", "/dev/v1/translations/capabilities"],
    ["GET", "/dev/v1/translations"],
    ["PUT", "/dev/v1/translations"],
    ["DELETE", "/dev/v1/translations/artifact-1"],
    ["GET", "/dev/v1/translations/revisions/extra"],
    ["GET", "/dev/v1/dubs"],
    ["PUT", "/dev/v1/dubs"],
    ["DELETE", "/dev/v1/dubs/artifact-1"],
    ["POST", "/dev/v1/dubs/artifact-1"],
    ["GET", "/dev/v1/dubs/a/b"],
    ["GET", "/dev/v1/dubs/bad%2fid"],
    ["GET", "/dev/v1/dubs/../projects"],
    ["POST", "/dev/v1/dubs?x=1"],
    ["POST", "/dev/v1/dubs/"],
    ["POST", "/dev/v1//dubs"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/dubs/artifact-1" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/dubs" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("the dubbing page is DEV_ONLY, memory-token only and same-origin", async () => {
  const [html, source, adapter, css] = await Promise.all([
    read("dev-dubbing.html"), read("src/dev-dubbing.tsx"), read("src/dev-dubbing-client.ts"), read("src/dev-dubbing.css"),
  ]);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /Local development only/u);
  assert.match(html, /No voice cloning/u);
  assert.match(html, /type="password" autocomplete="off"/u);
  assert.match(html, /src="\/src\/dev-dubbing\.tsx"/u);
  assert.ok(!/<script(?![^>]*\bsrc=)/u.test(html), "no inline script (strict CSP)");
  assert.ok(!/style=/u.test(html), "no inline style attribute (strict CSP)");
  assert.ok(css.length > 0);
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
    assert.ok(!source.includes(forbidden) && !adapter.includes(forbidden), `${forbidden} must not persist the token`);
  }
  assert.match(source, /window\.location\.origin/u);
  assert.match(source, /DevDubbingPanel/u);
  assert.match(adapter, /credentials: "omit"/u);
  assert.match(adapter, /redirect: "error"/u);
  assert.match(adapter, /OUTCOME_UNKNOWN/u);
  assert.match(adapter, /\/dev\/v1\/translations\/capabilities/u);
  assert.match(adapter, /\/dev\/v1\/translations\/revisions/u);
  assert.match(adapter, /\/dev\/v1\/dubs/u);
  assert.ok(!/https?:\/\//u.test(adapter), "the adapter never names another origin");
});
