import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("the provider catalog route is allow-listed read-only with exact spelling only", () => {
  assert.equal(isAllowedDevProjectProxyRequest("GET", "/dev/v1/providers/catalog"), true);
  const rejected = [
    ["POST", "/dev/v1/providers/catalog"],
    ["PUT", "/dev/v1/providers/catalog"],
    ["DELETE", "/dev/v1/providers/catalog"],
    ["GET", "/dev/v1/providers"],
    ["GET", "/dev/v1/providers/"],
    ["GET", "/dev/v1/providers/catalog/"],
    ["GET", "/dev/v1/providers/catalog?x=1"],
    ["GET", "/dev/v1/providers/other"],
    ["GET", "/dev/v1/providers/catalog/extra"],
    ["GET", "/dev/v1/providers/../projects"],
    ["GET", "/dev/v1/providers//catalog"],
    ["GET", "/dev/v1/providers/%63atalog"],
    ["GET", "/dev/v1/providers\\catalog"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/providers/catalog" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  assert.equal(response.headers["Cache-Control"], "no-store");
  calledNext = false;
  artifactProxyGuard({ method: "GET", url: "/dev/v1/providers/catalog" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("the provider page is DEV_ONLY, memory-token only, same-origin and calls only the catalog route", async () => {
  const [html, source, adapter, css] = await Promise.all([
    read("dev-provider-status.html"), read("src/dev-provider-status.tsx"), read("src/dev-provider-status-client.ts"),
    read("src/dev-provider-status.css"),
  ]);
  assert.match(html, /DEV_ONLY · observed readiness/u);
  assert.match(html, /Media does not substitute another model/u);
  assert.match(html, /not a quality, rights, approval or production claim/u);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /aria-live="polite"/u);
  assert.match(source, /DevProviderStatusPanel/u);
  assert.match(source, /\/dev\/v1\/context/u);
  assert.doesNotMatch(source + adapter, /localStorage|sessionStorage|document\.cookie|indexedDB/u);
  assert.match(adapter, /credentials: "omit"/u);
  assert.match(adapter, /redirect: "error"/u);
  assert.match(adapter, /\/dev\/v1\/providers\/catalog/u);
  assert.doesNotMatch(adapter, /method: "(?:POST|PUT|DELETE|PATCH)"/u);
  assert.doesNotMatch(html + source + adapter, /https?:\/\/(?!127\.0\.0\.1)/u);
  assert.doesNotMatch(css, /\sstyle=|@import url\(http/u);
  assert.match(css, /prefers-reduced-motion/u);
});
