import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("grounded-answer routes are allow-listed with exact methods and canonical spellings only", () => {
  const allowed = [
    ["POST", "/dev/v1/grounded-answers"],
    ["GET", "/dev/v1/grounded-answers/status"],
    ["GET", "/dev/v1/grounded-answers/artifact-1"],
    ["GET", "/dev/v1/grounded-answers/0f8fad5b-d9cb-469f-a165-70867728950e"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["GET", "/dev/v1/grounded-answers"],
    ["GET", "/dev/v1/grounded-answers/"],
    ["PUT", "/dev/v1/grounded-answers"],
    ["DELETE", "/dev/v1/grounded-answers/artifact-1"],
    ["POST", "/dev/v1/grounded-answers/artifact-1"],
    ["POST", "/dev/v1/grounded-answers/status"],
    ["POST", "/dev/v1/grounded-answers?x=1"],
    ["GET", "/dev/v1/grounded-answers/bad%2fid"],
    ["GET", "/dev/v1/grounded-answers/a/b"],
    ["GET", "/dev/v1/grounded-answers/../projects"],
    ["GET", "/dev/v1/grounded-answers//artifact-1"],
    ["GET", "/dev/v1/grounded-answers/a\\b"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/grounded-answers/artifact-1" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  assert.equal(response.headers["Cache-Control"], "no-store");
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/grounded-answers" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("grounded-answer page is DEV_ONLY, memory-token only, same-origin and calls only the DEV routes", async () => {
  const [html, source, adapter] = await Promise.all([
    read("dev-grounded-answer.html"), read("src/dev-grounded-answer.tsx"), read("src/dev-grounded-answer-client.ts"),
  ]);
  assert.match(html, /DEV_ONLY · owner scoped/u);
  assert.match(html, /no quality, rights, approval or production claim/u);
  assert.match(source, /DevGroundedAnswerPanel/u);
  assert.match(source, /bearerToken: \(\) => bearerToken \?\? ""/u);
  assert.match(source, /const origin = window\.location\.origin/u);
  assert.doesNotMatch(source + adapter, /localStorage|sessionStorage|indexedDB/u);
  for (const route of ["/dev/v1/grounded-answers\"", "/dev/v1/grounded-answers/${encodeURIComponent(outputId)}"]) {
    assert.ok(adapter.includes(route), `adapter must call ${route}`);
  }
  assert.doesNotMatch(adapter, /\/api\/v1\/|vision\/questions/u, "the page never uses a canonical or vision route");
});
