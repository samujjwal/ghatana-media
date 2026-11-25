import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("speech routes are allow-listed for synthesis only, with exact methods and canonical spellings", () => {
  const allowed = [
    ["GET", "/dev/v1/speech/capabilities"],
    ["POST", "/dev/v1/speech/syntheses"],
    ["GET", "/dev/v1/speech/outputs/artifact-1"],
    ["GET", "/dev/v1/speech/outputs/0f8fad5b-d9cb-469f-a165-70867728950e"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["POST", "/dev/v1/speech/capabilities"],
    ["GET", "/dev/v1/speech/syntheses"],
    ["PUT", "/dev/v1/speech/syntheses"],
    ["POST", "/dev/v1/speech/transcriptions"],
    ["POST", "/dev/v1/speech/outputs/artifact-1"],
    ["DELETE", "/dev/v1/speech/outputs/artifact-1"],
    ["GET", "/dev/v1/speech/outputs"],
    ["GET", "/dev/v1/speech/outputs/"],
    ["GET", "/dev/v1/speech/outputs/a/b"],
    ["GET", "/dev/v1/speech/outputs/bad%2fid"],
    ["GET", "/dev/v1/speech/outputs/../projects"],
    ["POST", "/dev/v1/speech/syntheses?x=1"],
    ["POST", "/dev/v1/speech/syntheses/"],
    ["POST", "/dev/v1/speech//syntheses"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/speech/transcriptions" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
  calledNext = false;
  artifactProxyGuard({ method: "POST", url: "/dev/v1/speech/syntheses" }, response, () => { calledNext = true; });
  assert.equal(calledNext, true);
});

test("the voice synthesis page is DEV_ONLY, memory-token only and same-origin", async () => {
  const [html, source, adapter] = await Promise.all([
    read("dev-voice-synthesis.html"), read("src/dev-voice-synthesis.tsx"), read("src/dev-voice-synthesis-client.ts"),
  ]);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /Local development only/u);
  assert.match(html, /No voice cloning/u);
  assert.match(html, /type="password" autocomplete="off"/u);
  assert.ok(!/<script(?![^>]*\bsrc=)/u.test(html), "no inline script (strict CSP)");
  assert.ok(!/style=/u.test(html), "no inline style attribute (strict CSP)");
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
    assert.ok(!source.includes(forbidden) && !adapter.includes(forbidden), `${forbidden} must not persist the token`);
  }
  assert.match(source, /window\.location\.origin/u);
  assert.match(adapter, /credentials: "omit"/u);
  assert.match(adapter, /redirect: "error"/u);
  assert.match(adapter, /OUTCOME_UNKNOWN/u);
  assert.ok(!/https?:\/\//u.test(adapter), "the adapter never names another origin");
});

test("voice timeline mutations preserve bounded request identities across retries", async () => {
  const adapter = await read("src/dev-voice-synthesis-client.ts");
  const addToTimeline = adapter.slice(adapter.indexOf("async function addToTimeline"), adapter.indexOf("\n  return {"));
  assert.match(adapter, /const TIMELINE_CLIP_ID = \/\^\[A-Za-z0-9\]\[A-Za-z0-9\._:-\]\{0,127\}\$\/u/u);
  assert.match(adapter, /const projectCreateRequestId = `voice-project-\$\{randomId\(\)\}`;/u);
  assert.match(adapter, /const timelineCreateRequestId = `voice-timeline-\$\{randomId\(\)\}`;/u);
  assert.match(adapter, /async function timelineEditRequestId\(clipId: string\)/u);
  assert.match(adapter, /crypto\.subtle\.digest\(\s*"SHA-256"/u);
  assert.match(adapter, /media\.dev\.voice\.timeline:edit:\$\{clipId\}/u);
  assert.match(adapter, /return `voice-timeline-edit:\$\{hex\}`;/u);
  assert.match(addToTimeline, /requestId: projectCreateRequestId/u);
  assert.match(addToTimeline, /requestId: timelineCreateRequestId/u);
  assert.equal((addToTimeline.match(/requestId: timelineEditId/gu) ?? []).length, 2);
  assert.doesNotMatch(addToTimeline, /randomId\(/u, "a retry must not mint a fresh project/timeline ID");
});
