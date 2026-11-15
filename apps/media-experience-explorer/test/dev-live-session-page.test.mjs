import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("live session routes are allow-listed with exact methods and canonical spellings", () => {
  const allowed = [
    ["GET", "/dev/v1/live-sessions/status"],
    ["POST", "/dev/v1/live-sessions"],
    ["GET", "/dev/v1/live-sessions/ls-0123456789abcdef01234567"],
    ["POST", "/dev/v1/live-sessions/ls-0123456789abcdef01234567/frames"],
    ["POST", "/dev/v1/live-sessions/ls-0123456789abcdef01234567/eos"],
    ["POST", "/dev/v1/live-sessions/ls-0123456789abcdef01234567/abort"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["POST", "/dev/v1/live-sessions/status"],
    ["GET", "/dev/v1/live-sessions"],
    ["PUT", "/dev/v1/live-sessions"],
    ["DELETE", "/dev/v1/live-sessions/ls-1"],
    ["GET", "/dev/v1/live-sessions/ls-1/frames"],
    ["POST", "/dev/v1/live-sessions/ls-1/restart"],
    ["POST", "/dev/v1/live-sessions/ls-1/frames?x=1"],
    ["POST", "/dev/v1/live-sessions/a/b/frames"],
    ["POST", "/dev/v1/live-sessions/bad%2fid/frames"],
    ["POST", "/dev/v1/live-sessions/../projects"],
    ["POST", "/dev/v1/live-sessions/"],
    ["POST", "/dev/v1//live-sessions"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/live-sessions/ls-1" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  artifactProxyGuard({ method: "POST", url: "/dev/v1/live-sessions/ls-1/frames" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("the live page is accessible, strict-CSP clean and never stores the token", async () => {
  const html = await read("dev-live-session.html");
  const script = await read("src/dev-live-session.ts");
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /<title>[^<]+<\/title>/u);
  assert.match(html, /<h1>Live capture session<\/h1>/u);
  for (const label of ["dev-token", "live-consent-id", "live-consent-version", "live-scope", "live-frequency", "live-lease"]) {
    assert.match(html, new RegExp(`<label for="${label}">`, "u"), `a visible label for ${label}`);
  }
  assert.ok((html.match(/aria-live="polite"/gu) ?? []).length >= 2, "status regions are announced");
  assert.match(html, /role="alert"/u);
  assert.doesNotMatch(html, /\sstyle=/u, "strict CSP forbids style attributes");
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/u, "no inline script");
  assert.doesNotMatch(script, /localStorage|sessionStorage|indexedDB|document\.cookie/u, "the token stays in page memory");
  assert.doesNotMatch(script, /getUserMedia/u, "no microphone is opened by this page");
  assert.match(script, /credentials: "omit"/u);
  assert.match(script, /bearerToken = null/u);
  assert.match(await read("src/dev-live-capture-worklet.js"), /registerProcessor\("live-capture"/u);
});
