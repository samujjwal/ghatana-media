import assert from "node:assert/strict";
import test from "node:test";
import config, { decodeSpecificationRequestPath } from "../vite.config.mjs";

function invokeSourceMiddleware(url) {
  let middleware;
  const plugin = config.plugins.find((candidate) => candidate.name === "media-specification-source");
  plugin.configureServer({ middlewares: { use: (_route, handler) => { middleware = handler; } } });

  const response = {
    statusCode: 200,
    headers: {},
    body: "",
    setHeader(name, value) { this.headers[name] = value; },
    end(value) { this.body = value; },
  };
  let forwarded = false;
  middleware({ url }, response, () => { forwarded = true; });
  return { response, forwarded };
}

test("decodes a source request path without its query string", () => {
  assert.equal(
    decodeSpecificationRequestPath("/pdp-3-product-experience/screen-registry.yaml?view=source"),
    "pdp-3-product-experience/screen-registry.yaml",
  );
});

test("rejects malformed percent encoding during path decoding", () => {
  assert.equal(decodeSpecificationRequestPath("/pdp-3-product-experience/%E0%A4%A"), null);
});

test("keeps decoded traversal text available for the exact manifest allowlist to reject", () => {
  assert.equal(decodeSpecificationRequestPath("/%2e%2e/secrets.yaml"), "../secrets.yaml");
});

test("returns a bounded 400 response for malformed source URLs", () => {
  const { response, forwarded } = invokeSourceMiddleware("/pdp-3-product-experience/%E0%A4%A");
  assert.equal(response.statusCode, 400);
  assert.equal(response.body, "Malformed specification path.");
  assert.equal(forwarded, false);
});

for (const [label, url] of [
  ["encoded traversal", "/%2e%2e/secrets.yaml"],
  ["unlisted source", "/not-in-the-manifest.yaml"],
]) {
  test(`forwards ${label} without reading or serving a file`, () => {
    const { response, forwarded } = invokeSourceMiddleware(url);
    assert.equal(forwarded, true);
    assert.equal(response.body, "");
    assert.deepEqual(response.headers, {});
  });
}
