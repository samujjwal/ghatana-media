import assert from "node:assert/strict";
import test from "node:test";
import config, { decodeSpecificationRequestPath, resolveServerWatchConfig, resolveWatchOptions } from "../vite.config.mjs";

test("keeps native Vite watchers by default and enables bounded polling only by explicit opt-in", () => {
  assert.equal(resolveWatchOptions({}), null);
  assert.equal(resolveWatchOptions({ MEDIA_DEV_VITE_USE_POLLING: "0" }), null);
  assert.deepEqual(resolveWatchOptions({ MEDIA_DEV_VITE_USE_POLLING: "1" }), {
    usePolling: true,
    interval: 1000,
    binaryInterval: 1000,
  });
  assert.deepEqual(resolveServerWatchConfig({}), {});
  assert.deepEqual(resolveServerWatchConfig({ MEDIA_DEV_VITE_DISABLE_WATCH: "0" }), {});
  assert.deepEqual(resolveServerWatchConfig({ MEDIA_DEV_VITE_DISABLE_WATCH: "1" }), { watch: null });
  assert.deepEqual(resolveServerWatchConfig({
    MEDIA_DEV_VITE_DISABLE_WATCH: "1",
    MEDIA_DEV_VITE_USE_POLLING: "1",
  }), { watch: null }, "disable-watch must take precedence over polling");
  assert.deepEqual(config.server.watch ?? null, resolveServerWatchConfig(process.env).watch ?? null);
});

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
