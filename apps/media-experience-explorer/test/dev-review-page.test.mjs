import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { artifactProxyGuard, isAllowedDevProjectProxyRequest } from "../artifact-proxy-guard.mjs";

const root = resolve(import.meta.dirname, "..");
const read = (path) => readFile(resolve(root, path), "utf8");

test("versioned review routes are allow-listed with exact methods and canonical spellings", () => {
  const allowed = [
    ["GET", "/dev/v1/reviews"],
    ["POST", "/dev/v1/reviews"],
    ["GET", "/dev/v1/reviews/devreview.0f8fad5b/versions"],
    ["GET", "/dev/v1/reviews/devreview.0f8fad5b/content"],
    ["GET", "/dev/v1/review-lineages/L1-0f8fad5b"],
    ["POST", "/dev/v1/reviews/devreview.0f8fad5b/comments"],
    ["POST", "/dev/v1/reviews/devreview.0f8fad5b/decisions"],
  ];
  for (const [method, path] of allowed) assert.equal(isAllowedDevProjectProxyRequest(method, path), true, `${method} ${path}`);
  const rejected = [
    ["POST", "/dev/v1/reviews/c1/versions"],
    ["POST", "/dev/v1/reviews/c1/content"],
    ["DELETE", "/dev/v1/reviews/c1"],
    ["PUT", "/dev/v1/reviews/c1/content"],
    ["POST", "/dev/v1/review-lineages/L1"],
    ["GET", "/dev/v1/review-lineages"],
    ["GET", "/dev/v1/review-lineages/a/b"],
    ["GET", "/dev/v1/reviews/c1/content?x=1"],
    ["GET", "/dev/v1/reviews/bad%2fid/versions"],
    ["GET", "/dev/v1/reviews/c1/versions/"],
    ["GET", "/dev/v1/reviews/../projects"],
  ];
  for (const [method, path] of rejected) assert.equal(isAllowedDevProjectProxyRequest(method, path), false, `${method} ${path}`);
  const response = { statusCode: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; }, end(body) { this.body = body; } };
  let calledNext = false;
  artifactProxyGuard({ method: "DELETE", url: "/dev/v1/reviews/c1" }, response, () => { calledNext = true; });
  assert.equal(calledNext, false);
  assert.equal(response.statusCode, 404);
});

test("the review page is DEV_ONLY, memory-token only, same-origin and states it is not an approval", async () => {
  const [html, source, adapter, css] = await Promise.all([
    read("dev-review.html"), read("src/dev-review.tsx"), read("src/dev-review-client.ts"), read("src/dev-review.css"),
  ]);
  assert.match(html, /<html lang="en">/u);
  assert.match(html, /Local development only/u);
  assert.match(html, /not a human, legal or production approval/u);
  assert.match(html, /type="password" autocomplete="off"/u);
  assert.match(html, /src="\/src\/dev-review\.tsx"/u);
  assert.ok(!/<script(?![^>]*\bsrc=)/u.test(html), "no inline script (strict CSP)");
  assert.ok(!/style=/u.test(html) && !/style=\{/u.test(source), "no inline style (strict CSP)");
  assert.ok(css.length > 0);
  for (const forbidden of ["localStorage", "sessionStorage", "indexedDB", "document.cookie"]) {
    assert.ok(!source.includes(forbidden) && !adapter.includes(forbidden), `${forbidden} must not persist the token`);
  }
  assert.match(source, /window\.location\.origin/u);
  assert.match(source, /crypto\.subtle\.digest\("SHA-256"/u, "the player verifies the exact version bytes before playing");
  assert.match(adapter, /credentials: "omit"/u);
  assert.match(adapter, /redirect: "error"/u);
  assert.match(adapter, /OUTCOME_UNKNOWN/u);
  assert.ok(!/https?:\/\//u.test(adapter), "the adapter never names another origin");
});
