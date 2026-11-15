import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("export routes are allow-listed with exact methods and canonical spellings only", () => {
  for (const [method, path] of [
    ["POST", "/dev/v1/exports"], ["GET", "/dev/v1/exports/export-1"], ["POST", "/dev/v1/exports/export-1/reconcile"],
  ]) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  for (const [method, path] of [
    ["DELETE", "/dev/v1/exports/export-1"], ["PUT", "/dev/v1/exports"], ["GET", "/dev/v1/exports"],
    ["GET", "/dev/v1/exports/export-1/reconcile"], ["POST", "/dev/v1/exports/export-1"], ["POST", "/dev/v1/exports/export-1/reconcile/x"],
    ["POST", "/dev/v1/exports//reconcile"], ["POST", "/dev/v1/exports/a%2fb/reconcile"], ["POST", "/dev/v1/exports/../reconcile"],
    ["POST", "/dev/v1/exports/export-1/reconcile?resume=true"], ["POST", "/dev/v1/exports/a/b/reconcile"],
  ]) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/exports/export-1" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
});

test("delivery page is DEV_ONLY, memory-token only, same-origin, accessible, and calls only the export routes", async () => {
  const [html, source, client, css] = await Promise.all([read("dev-delivery.html"), read("src/dev-delivery.tsx"), read("src/dev-delivery-client.ts"), read("src/dev-delivery.css")]);
  assert.match(html, /DEV_ONLY · owner scoped/u);
  assert.match(html, /no third-party publication/u);
  assert.match(html, /never uploads the same bytes twice/u);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /src="\/src\/dev-delivery\.tsx"/u);
  assert.match(source, /bearerToken: \(\) => bearerToken \?\? ""/u);
  assert.match(source, /const origin = window\.location\.origin/u);
  assert.match(source, /role="status" aria-live="polite"/u);
  assert.match(source, /role="alert"/u);
  assert.match(source, /Reconcile \(read destination only\)/u);
  assert.doesNotMatch(source + client, /localStorage|sessionStorage|indexedDB|style=\{/u);
  assert.doesNotMatch(client, /method: "DELETE"|\/api\/v1\//u);
  for (const route of ["\"/dev/v1/exports\"", "/dev/v1/exports/${encodeURIComponent(requestId)}`", "/dev/v1/exports/${encodeURIComponent(requestId)}/reconcile"]) {
    assert.ok(client.includes(route), `client must call ${route}`);
  }
  assert.match(css, /prefers-reduced-motion/u);
  assert.match(css, /:focus-visible/u);
  // The ACK state is conveyed by text and border style, not by color alone.
  assert.doesNotMatch(css, /#[0-9a-f]{3,6}\b.*(green|red)/iu);
});
