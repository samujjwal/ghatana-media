#!/usr/bin/env node
/**
 * Verify the local contract projections agree on the canonical wire surface.
 * This is a source-parity check, not runtime interoperability or publication
 * evidence. Legacy client routes are allowed only in the explicit compatibility
 * projection.
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const failures = [];
const read = (relativePath) => readFileSync(join(root, relativePath), "utf8");
const fail = (message) => failures.push(message);

const routeManifest = JSON.parse(read("config/route-manifest.json"));
const routes = new Map(routeManifest.routes.map((route) => [`${route.method} ${route.path}`, route]));
if (routeManifest.routes.length !== 27) fail(`route manifest exposes ${routeManifest.routes.length} routes; expected 27`);

const registry = read(".product-experience/pdp-3-product-experience/api/api-registry.yaml");
const registryRows = [...registry.matchAll(/    method: (GET|POST|PUT|PATCH|DELETE)\n    path: "([^"]+)"\n    operationId: ([^\n]+)/g)].map((match) => ({ method: match[1], path: match[2], operationId: match[3] }));
if (registryRows.length !== 27) fail(`PDP-3 API registry exposes ${registryRows.length} operations; expected 27`);
for (const row of registryRows) {
  const route = routes.get(`${row.method} ${row.path}`);
  if (!route) fail(`PDP-3 API registry route is absent from runtime route manifest: ${row.method} ${row.path}`);
  else if (route.operationId !== row.operationId) fail(`operation ID drift for ${row.method} ${row.path}: ${row.operationId} vs ${route.operationId}`);
}
for (const route of routeManifest.routes) {
  if (!registryRows.some((row) => row.method === route.method && row.path === route.path && row.operationId === route.operationId)) {
    fail(`runtime route manifest entry is absent from PDP-3 API registry: ${route.id}`);
  }
}

const canonicalRoutes = read("libs/audio-video-client/src/canonical-routes.ts");
if (!canonicalRoutes.includes('mediaHttpRouteAuthority = "contracts/openapi/media.yaml + config/route-manifest.json"')) {
  fail("SDK route projection does not identify OpenAPI and route-manifest authority");
}
const canonicalSection = canonicalRoutes.split("export const legacyCompatibilityRoutes")[0];
const canonicalRouteValues = [...canonicalSection.matchAll(/:\s*"(\/api\/v1\/[^"{}]+(?:\{[^}]+\}[^"{}]*)*)"/g)].map((match) => match[1]);
for (const path of canonicalRouteValues) {
  if (!routeManifest.routes.some((route) => route.path === path)) fail(`canonical SDK route is absent from runtime route manifest: ${path}`);
}
if (!canonicalRoutes.includes("legacyCompatibilityRoutes")) fail("SDK route projection does not isolate legacy compatibility routes");
if (!canonicalRoutes.includes("/api/v1/media/")) fail("legacy SDK route projection is not explicit");

const requiredProjectionPaths = [
  ".product-experience/pdp-3-product-experience/api/api-registry.yaml",
  ".product-experience/pdp-3-product-experience/grpc/service-registry.yaml",
  ".product-experience/pdp-3-product-experience/sdk/operation-registry.yaml",
  ".product-experience/pdp-3-product-experience/events/event-registry.yaml",
  ".product-experience/pdp-3-product-experience/agent-tools/tool-registry.yaml",
  ".product-experience/pdp-3-product-experience/services/service-registry.yaml",
];
for (const path of requiredProjectionPaths) if (!existsSync(join(root, path))) fail(`missing PDP-3 projection: ${path}`);

if (failures.length) {
  console.error(`Media contract parity check failed (${failures.length} failures)`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log("Media contract parity check passed");
  console.log("  27 runtime routes match the PDP-3 HTTP registry and canonical SDK projection");
  console.log("  legacy SDK routes remain isolated as compatibility-only material");
  console.log("  gRPC, SDK, event, Agent Tool, and service projections are present");
}
