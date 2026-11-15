import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedArtifactProxyRequest, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");
const UPLOAD = "0f8fad5b-d9cb-469f-a165-70867728950e";

test("the resumable upload page reaches only the canonical upload routes and the exact intake routes", () => {
  for (const [method, path] of [
    ["POST", "/api/v1/artifacts/uploads"], ["GET", `/api/v1/artifacts/uploads/${UPLOAD}`],
    ["PUT", `/api/v1/artifacts/uploads/${UPLOAD}/chunks/12`], ["POST", `/api/v1/artifacts/uploads/${UPLOAD}/complete`],
  ]) assert.equal(isAllowedArtifactProxyRequest(method, path), true, `${method} ${path}`);
  for (const [method, path] of [["POST", "/dev/v1/intakes"], ["GET", "/dev/v1/intakes/my-media"], ["GET", "/dev/v1/artifact-upload-policy"]]) {
    assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  }
  for (const [method, path] of [
    ["DELETE", "/dev/v1/intakes/my-media"], ["PUT", "/dev/v1/intakes/my-media"], ["GET", "/dev/v1/intakes"], ["POST", "/dev/v1/intakes/my-media"],
    ["GET", "/dev/v1/intakes/a/b"], ["GET", "/dev/v1/intakes/bad%2fid"], ["GET", "/dev/v1/intakes/../projects"], ["POST", "/dev/v1/intakes?x=1"],
    ["DELETE", `/api/v1/artifacts/uploads/${UPLOAD}`], ["PUT", `/api/v1/artifacts/uploads/${UPLOAD}/chunks/-1`],
  ]) {
    const allowed = isAllowedDevProjectProxyRequest(method, path) || isAllowedArtifactProxyRequest(method, path);
    assert.equal(allowed, false, `${method} ${path}`);
  }
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/intakes/my-media" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
});

test("the page is DEV_ONLY, accessible, memory-token only, same-origin and sends a digest with every chunk", async () => {
  const [html, source, css] = await Promise.all([
    read("dev-resumable-upload.html"), read("src/dev-resumable-upload.ts"), read("src/dev-resumable-upload.css"),
  ]);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /Local development only/u);
  assert.match(html, /type="password" autocomplete="off"/u);
  assert.match(html, /<progress id="progress"/u);
  assert.match(html, /<label for="progress">/u);
  assert.match(html, /id="progress-text" role="status" aria-live="polite"/u);
  assert.match(html, /id="upload-error" role="alert"/u);
  assert.match(html, /<caption>/u);
  assert.match(html, /scope="col"/u);
  assert.match(html, /class="skip-link"/u);
  assert.match(html, /src="\/src\/dev-resumable-upload\.ts"/u);
  assert.ok(!/<script(?![^>]*\bsrc=)/u.test(html), "no inline script (strict CSP)");
  assert.ok(!/style=/u.test(html), "no inline style attribute (strict CSP)");
  assert.match(css, /:focus-visible/u);
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
    assert.ok(!source.includes(forbidden), `${forbidden} must not persist the token`);
  }
  assert.match(source, /window\.location\.origin/u);
  assert.match(source, /credentials: "omit"/u);
  assert.match(source, /redirect: "error"/u);
  assert.match(source, /X-Chunk-SHA256/u);
  assert.match(source, /nextChunkIndex/u, "continues from the server's offset");
  assert.match(source, /Idempotency-Key/u);
  assert.ok(!/https?:\/\//u.test(source), "the page never names another origin");
});
