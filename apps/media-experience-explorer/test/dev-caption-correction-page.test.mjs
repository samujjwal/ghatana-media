import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("caption correction routes are allow-listed with exact methods and canonical spellings only", () => {
  const allowed = [
    ["POST", "/dev/v1/captions/corrections"],
    ["GET", "/dev/v1/captions/artifact-1"],
    ["GET", "/dev/v1/captions/0f8fad5b-d9cb-469f-a165-70867728950e"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["GET", "/dev/v1/captions"],
    ["GET", "/dev/v1/captions/"],
    ["PUT", "/dev/v1/captions/corrections"],
    ["GET", "/dev/v1/captions/corrections/x"],
    ["DELETE", "/dev/v1/captions/artifact-1"],
    ["POST", "/dev/v1/captions/artifact-1"],
    ["POST", "/dev/v1/captions/corrections?x=1"],
    ["POST", "/dev/v1/captions/corrections/"],
    ["GET", "/dev/v1/captions/bad%2fid"],
    ["GET", "/dev/v1/captions/a/b"],
    ["GET", "/dev/v1/captions/../projects"],
    ["GET", "/dev/v1/captions//artifact-1"],
    ["GET", "/dev/v1/captions/a\\b"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/captions/artifact-1" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
});

test("the page is a strict-CSP DEV_ONLY page with an in-memory token, no inline script or style", async () => {
  const html = await read("dev-caption-correction.html");
  assert.match(html, /<title>Correct Captions · Media<\/title>/u);
  assert.match(html, /DEV_ONLY/u);
  assert.match(html, /type="password"/u);
  assert.doesNotMatch(html, /<style|style=|<script(?![^>]*\bsrc=)/u);
  const page = await read("src/dev-caption-correction.tsx");
  assert.doesNotMatch(page, /localStorage|sessionStorage|indexedDB/u);
  assert.match(page, /DevReviewSection/u);
  const client = await read("src/dev-caption-client.ts");
  assert.match(client, /credentials: "omit"/u);
  assert.match(client, /OUTCOME_UNKNOWN/u);
  assert.doesNotMatch(client, /localStorage|sessionStorage/u);
});
