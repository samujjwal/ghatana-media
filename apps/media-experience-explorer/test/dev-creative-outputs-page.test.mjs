import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("creative-output routes are allow-listed with exact methods and canonical spellings only", () => {
  const allowed = [
    ["POST", "/dev/v1/creative-outputs/audio-repairs"],
    ["POST", "/dev/v1/creative-outputs/simulations"],
    ["POST", "/dev/v1/creative-outputs/spatial-glb"],
    ["GET", "/dev/v1/creative-outputs/artifact-1"],
    ["GET", "/dev/v1/creative-outputs/0f8fad5b-d9cb-469f-a165-70867728950e"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["GET", "/dev/v1/creative-outputs"],
    ["GET", "/dev/v1/creative-outputs/"],
    ["PUT", "/dev/v1/creative-outputs/audio-repairs"],
    ["DELETE", "/dev/v1/creative-outputs/artifact-1"],
    ["POST", "/dev/v1/creative-outputs/artifact-1"],
    ["PATCH", "/dev/v1/creative-outputs/artifact-1"],
    ["POST", "/dev/v1/creative-outputs/audio-repairs/extra"],
    ["POST", "/dev/v1/creative-outputs/simulations?x=1"],
    ["POST", "/dev/v1/creative-outputs/spatial-glb/"],
    ["GET", "/dev/v1/creative-outputs/bad%2fid"],
    ["GET", "/dev/v1/creative-outputs/a/b"],
    ["GET", "/dev/v1/creative-outputs/../projects"],
    ["GET", "/dev/v1/creative-outputs//artifact-1"],
    ["GET", "/dev/v1/creative-outputs/a\\b"],
    ["POST", "/dev/v1/creative-outputs/other"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/creative-outputs/artifact-1" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  assert.equal(response.headers["Cache-Control"], "no-store");
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/creative-outputs/audio-repairs" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("creative outputs page is DEV_ONLY, memory-token only, same-origin, and not a production build input", async () => {
  const [html, source, adapter, vite, main] = await Promise.all([
    read("dev-creative-outputs.html"), read("src/dev-creative-outputs.tsx"), read("src/dev-creative-outputs-client.ts"),
    read("vite.config.mjs"), read("src/main.ts"),
  ]);
  assert.match(html, /DEV_ONLY · owner scoped/u);
  assert.match(html, /no quality, measurement, approval, production-rights or delivery claim/u);
  assert.match(source, /DevCreativeOutputsPanel/u);
  assert.match(source, /bearerToken: \(\) => bearerToken \?\? ""/u);
  assert.match(source, /const origin = window\.location\.origin/u);
  assert.doesNotMatch(source + adapter, /localStorage|sessionStorage|indexedDB/u);
  for (const route of ["/dev/v1/creative-outputs/audio-repairs", "/dev/v1/creative-outputs/simulations", "/dev/v1/creative-outputs/spatial-glb", "/dev/v1/creative-outputs/${encodeURIComponent(outputId)}"]) {
    assert.ok(adapter.includes(route), `adapter must call ${route}`);
  }
  assert.match(adapter, /credentials:\s*"omit"/u);
  assert.match(adapter, /redirect:\s*"error"/u);
  assert.match(adapter, /OUTCOME_UNKNOWN/u);
  assert.doesNotMatch(adapter, /readSimulationDocument\s*[:=(]\s*[^/\n]*=>/u, "no host content route exists, so the adapter must not fabricate a document reader");
  assert.doesNotMatch(vite, /dev-creative-outputs\.html/u, "the DEV_ONLY page must not be a production build input");
  assert.doesNotMatch(main, /dev-creative-outputs/u);
});
