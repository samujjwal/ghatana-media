import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("vision routes are allow-listed with exact methods and canonical spellings only", () => {
  const allowed = [
    ["POST", "/dev/v1/vision/tracks"],
    ["POST", "/dev/v1/vision/roi-analyses"],
    ["GET", "/dev/v1/vision/outputs/artifact-1"],
    ["GET", "/dev/v1/vision/outputs/0f8fad5b-d9cb-469f-a165-70867728950e"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["GET", "/dev/v1/vision/tracks"],
    ["PUT", "/dev/v1/vision/tracks"],
    ["DELETE", "/dev/v1/vision/outputs/artifact-1"],
    ["POST", "/dev/v1/vision/outputs/artifact-1"],
    ["POST", "/dev/v1/vision/tracks/"],
    ["POST", "/dev/v1/vision/tracks?x=1"],
    ["POST", "/dev/v1/vision/tracks/extra"],
    ["POST", "/dev/v1/vision/roi-analyses/extra"],
    ["GET", "/dev/v1/vision/outputs"],
    ["GET", "/dev/v1/vision/outputs/"],
    ["GET", "/dev/v1/vision/outputs/a/b"],
    ["GET", "/dev/v1/vision/outputs/bad%2fid"],
    ["GET", "/dev/v1/vision/outputs/../status"],
    ["GET", "/dev/v1/vision/outputs//artifact-1"],
    ["GET", "/dev/v1/vision/outputs/a\\b"],
    // The earlier lanes are deliberately not exposed by this page.
    ["POST", "/dev/v1/vision/analyses"],
    ["POST", "/dev/v1/vision/questions"],
    ["GET", "/dev/v1/vision/status"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/vision/tracks" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/vision/tracks" }, { setHeader() {}, end() {} }, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("the page is a strict-CSP, token-in-memory host that renders only the tracking panel", async () => {
  const html = await read("dev-vision-tracks.html");
  const script = await read("src/dev-vision-tracks.tsx");
  const client = await read("src/dev-vision-tracks-client.ts");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/u, "no inline script");
  assert.doesNotMatch(html, /\sstyle=/u, "no inline style attribute");
  assert.match(html, /type="password"/u);
  assert.match(script, /DevVisionTracksPanel/u);
  assert.doesNotMatch(script + client, /localStorage|sessionStorage|document\.cookie/u, "the token is never persisted");
  assert.match(client, /credentials: "omit"/u);
  assert.match(client, /\/dev\/v1\/vision\/tracks/u);
  assert.match(client, /\/dev\/v1\/vision\/outputs\//u);
  assert.match(client, /OUTCOME_UNKNOWN/u);
});
