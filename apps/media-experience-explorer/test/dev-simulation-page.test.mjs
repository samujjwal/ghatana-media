import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("simulation routes are allow-listed with exact methods and canonical spellings", () => {
  const allowed = [
    ["GET", "/dev/v1/simulations/status"],
    ["POST", "/dev/v1/simulations"],
    ["GET", "/dev/v1/simulations/0f8fad5b-d9cb-469f-a165-70867728950e"],
    ["GET", "/dev/v1/artifacts/artifact-1/content"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["POST", "/dev/v1/simulations/status"],
    ["GET", "/dev/v1/simulations"],
    ["PUT", "/dev/v1/simulations"],
    ["DELETE", "/dev/v1/simulations/abc"],
    ["POST", "/dev/v1/simulations/abc"],
    ["GET", "/dev/v1/simulations/a/b"],
    ["GET", "/dev/v1/simulations/bad%2fid"],
    ["GET", "/dev/v1/simulations/../projects"],
    ["POST", "/dev/v1/simulations?x=1"],
    ["POST", "/dev/v1/simulations/"],
    ["POST", "/dev/v1//simulations"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/simulations/abc" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/simulations" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("the simulation page is DEV_ONLY, memory-token only, same-origin and strict-CSP clean", async () => {
  const [html, source, panel, adapter, css] = await Promise.all([
    read("dev-simulation.html"), read("src/dev-simulation.tsx"), read("src/dev-simulation-panel.tsx"), read("src/dev-simulation-client.ts"), read("src/dev-simulation.css"),
  ]);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /Local development only/u);
  assert.match(html, /never a measurement/u);
  assert.match(html, /type="password" autocomplete="off"/u);
  assert.match(html, /src="\/src\/dev-simulation\.tsx"/u);
  assert.ok(!/<script(?![^>]*\bsrc=)/u.test(html), "no inline script (strict CSP)");
  assert.ok(!/style=/u.test(html), "no inline style attribute (strict CSP)");
  assert.ok(!/style=\{/u.test(panel), "the panel sets no style attribute (strict CSP style-src-attr 'none')");
  assert.ok(css.length > 0);
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
    assert.ok(!source.includes(forbidden) && !adapter.includes(forbidden) && !panel.includes(forbidden), `${forbidden} must not persist the token`);
  }
  assert.match(source, /window\.location\.origin/u);
  assert.match(source, /DevSimulationPanel/u);
  assert.match(adapter, /credentials: "omit"/u);
  assert.match(adapter, /redirect: "error"/u);
  assert.match(adapter, /OUTCOME_UNKNOWN/u);
  assert.match(adapter, /\/dev\/v1\/simulations\/status/u);
  assert.ok(!/https?:\/\//u.test(adapter), "the adapter never names another origin");
  // an abstained pass renders reasons and never a value; the plot and video are shown only after SHA-256 verification
  assert.match(panel, /readVerifiedContent/u);
  assert.match(panel, /No trace and no observable value is shown/u);
  assert.match(panel, /role="alert"/u);
  assert.match(panel, /aria-live="polite"/u);
});
