import test from "node:test";
import assert from "node:assert/strict";
import { createServer as createHttpServer, request as httpRequest } from "node:http";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";

const listen = (server) => new Promise((resolve, reject) => server.once("error", reject).listen(0, "127.0.0.1", resolve));
const close = (server) => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));

test("Vite forwards only exact owner-scoped GET item path and blocks job writes/other shapes", async () => {
  const upstreamRequests = [];
  const upstream = createHttpServer((request, response) => {
    upstreamRequests.push({ method: request.method, url: request.url });
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify({ received: request.url }));
  });
  await listen(upstream);
  const upstreamPort = upstream.address().port;
  const previousProxyPort = process.env.MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT;
  process.env.MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT = String(upstreamPort);
  const vite = await createViteServer({
    configFile: fileURLToPath(new URL("../vite.config.mjs", import.meta.url)),
    server: { host: "127.0.0.1", port: 0, strictPort: false },
    logLevel: "silent",
  });
  try {
    await vite.listen();
    const address = vite.httpServer.address();
    const origin = `http://127.0.0.1:${address.port}`;
    const allowed = await fetch(`${origin}/api/v1/jobs/job-safe_01`);
    assert.equal(allowed.status, 200);
    assert.deepEqual(await allowed.json(), { received: "/api/v1/jobs/job-safe_01" });
    const blocked = [
      ["POST", "/api/v1/jobs/job-safe_01"],
      ["GET", "/api/v1/jobs"],
      ["POST", "/api/v1/jobs/job-safe_01/cancel"],
      ["GET", "/api/v1/jobs/job-safe_01?requestId=query"],
      ["GET", "/api/v1/jobs/job%2Fother"],
      ["GET", "/api/v1/jobs/."],
      ["GET", "/api/v1/jobs/.."],
    ];
    for (const [method, path] of blocked) {
      const responseStatus = path.endsWith("/..")
        ? await requestRawPath(origin, path, method)
        : (await fetch(`${origin}${path}`, { method })).status;
      assert.equal(responseStatus, 404, `${method} ${path} should be blocked by local middleware`);
    }
    const encodedColon = await fetch(`${origin}/api/v1/jobs/job%3Acanonical`);
    assert.equal(encodedColon.status, 200, "canonical SDK encoding of a colon must remain readable");
    assert.deepEqual(await encodedColon.json(), { received: "/api/v1/jobs/job%3Acanonical" });
    assert.deepEqual(upstreamRequests, [
      { method: "GET", url: "/api/v1/jobs/job-safe_01" },
      { method: "GET", url: "/api/v1/jobs/job%3Acanonical" },
    ],
      "blocked operations must never reach the Media host proxy");
  } finally {
    await vite.close();
    await close(upstream);
    if (previousProxyPort === undefined) delete process.env.MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT;
    else process.env.MEDIA_DEV_PROJECT_TIMELINE_PROXY_PORT = previousProxyPort;
  }
});

function requestRawPath(origin, path, method) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest({ hostname: target.hostname, port: target.port, path, method }, (response) => {
      response.resume();
      response.on("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.end();
  });
}
