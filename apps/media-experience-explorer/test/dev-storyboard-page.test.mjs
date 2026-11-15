import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("storyboard routes are allow-listed with exact methods and canonical spellings", () => {
  const allowed = [
    ["GET", "/dev/v1/storyboards/capabilities"],
    ["POST", "/dev/v1/storyboards"],
    ["GET", "/dev/v1/storyboards/sb-1"],
    ["GET", "/dev/v1/storyboards/sb-1/versions"],
    ["POST", "/dev/v1/storyboards/sb-1/versions"],
    ["GET", "/dev/v1/storyboards/sb-1/versions/12"],
    ["GET", "/dev/v1/storyboards/sb-1/readiness"],
    ["POST", "/dev/v1/storyboards/sb-1/renders"],
    ["GET", "/dev/v1/storyboards/sb-1/versions/2/render"],
    ["GET", "/dev/v1/storyboards/sb-1/versions/2/review"],
    ["POST", "/dev/v1/storyboards/sb-1/versions/2/review"],
    ["POST", "/dev/v1/rights/attestations"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["GET", "/dev/v1/storyboards"],
    ["PUT", "/dev/v1/storyboards"],
    ["DELETE", "/dev/v1/storyboards/sb-1"],
    ["POST", "/dev/v1/storyboards/sb-1"],
    ["POST", "/dev/v1/storyboards/capabilities"],
    ["POST", "/dev/v1/storyboards/sb-1/readiness"],
    ["GET", "/dev/v1/storyboards/sb-1/renders"],
    ["POST", "/dev/v1/storyboards/sb-1/versions/2"],
    ["POST", "/dev/v1/storyboards/sb-1/versions/2/render"],
    ["GET", "/dev/v1/storyboards/sb-1/versions/x"],
    ["GET", "/dev/v1/storyboards/a/b/c/d"],
    ["POST", "/dev/v1/storyboards/bad%2fid/renders"],
    ["POST", "/dev/v1/storyboards/../projects/renders"],
    ["POST", "/dev/v1/storyboards?x=1"],
    ["POST", "/dev/v1//storyboards"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/storyboards/sb-1" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/storyboards/sb-1/renders" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("the storyboard page is DEV_ONLY, memory-token only, same-origin and accessible by construction", async () => {
  const [html, source, adapter, panel, css] = await Promise.all([
    read("dev-storyboard.html"), read("src/dev-storyboard.tsx"), read("src/dev-storyboard-client.ts"),
    read("src/dev-storyboard-panel.tsx"), read("src/dev-storyboard.css"),
  ]);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /Local development only/u);
  assert.match(html, /Placeholders and shots without rights never render/u);
  assert.match(html, /type="password" autocomplete="off"/u);
  assert.match(html, /src="\/src\/dev-storyboard\.tsx"/u);
  assert.ok(!/<script(?![^>]*\bsrc=)/u.test(html), "no inline script (strict CSP)");
  assert.ok(!/style=/u.test(html), "no inline style attribute (strict CSP)");
  assert.ok(css.length > 0);
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
    assert.ok(!source.includes(forbidden) && !adapter.includes(forbidden) && !panel.includes(forbidden), `${forbidden} must not persist the token`);
  }
  assert.match(source, /window\.location\.origin/u);
  assert.match(adapter, /credentials: "omit"/u);
  assert.match(adapter, /redirect: "error"/u);
  assert.match(adapter, /OUTCOME_UNKNOWN/u);
  assert.ok(!/https?:\/\//u.test(adapter), "the adapter never names another origin");
  assert.ok(!/style=\{/u.test(panel), "no inline style props (strict CSP)");
  // no fake readiness in the UI: the render button is enabled only from the host's readiness verdict for the head version
  assert.match(panel, /readiness\?\.renderable === true && isHead/u);
  assert.match(panel, /disabled=\{!renderable \|\| busy\}/u);
  // a rights statement is the user's own act: an explicit checkbox and a basis, never a pre-filled approval
  assert.match(panel, /I am the rights holder/u);
  assert.match(panel, /establishesApproval|Establishes approval/u);
  for (const label of ["Brief title", "Scene id", "Duration (ms)", "Source kind", "Save new version", "Render storyboard", "Open render for review"]) {
    assert.ok(panel.includes(label), `${label} is a labelled control`);
  }
});
