import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { canonicalMediaHttpRoutes, legacyCompatibilityRoutes } from "./canonical-routes";

const repositoryRoot = resolve(import.meta.dirname, "../../../");
const openApiText = readFileSync(resolve(repositoryRoot, "contracts/openapi/media.yaml"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "config/route-manifest.json"), "utf8")) as {
  routes: { method: string; path: string; operationId: string }[];
};

type Route = { method: string; path: string; operationId: string };

function readOpenApiRoutes(text: string): Route[] {
  const pathsSection = text.split(/^paths:\s*$/mu)[1]?.split(/^components:\s*$/mu)[0];
  if (!pathsSection) throw new Error("OpenAPI paths section was not found.");
  const routes: Route[] = [];
  let path: string | undefined;
  let method: string | undefined;
  let operationId: string | undefined;
  const flush = () => {
    if (path && method && operationId) routes.push({ method: method.toUpperCase(), path, operationId });
    method = undefined;
    operationId = undefined;
  };
  for (const line of pathsSection.split(/\r?\n/u)) {
    const pathMatch = /^  (\/[^:]+):\s*$/u.exec(line);
    if (pathMatch) {
      flush();
      path = pathMatch[1]!;
      continue;
    }
    const methodMatch = /^    (get|post|put|delete|patch|options|head|trace):\s*$/u.exec(line);
    if (methodMatch) {
      flush();
      method = methodMatch[1]!.toUpperCase();
      continue;
    }
    const operationMatch = /^      operationId:\s*([A-Za-z0-9_]+)\s*$/u.exec(line);
    if (operationMatch && method) operationId = operationMatch[1]!;
  }
  flush();
  return routes;
}

const openApiRoutes = readOpenApiRoutes(openApiText);
const manifestRoutes = manifest.routes.map((route) => ({
  method: route.method.toUpperCase(), path: route.path, operationId: route.operationId,
}));

// These are the operations implemented by createMediaCanonicalClient today.
// Keep this inventory limited to actual transport dispatches in canonical-operations.ts.
const clientBoundRoutes: Route[] = [
  { method: "POST", path: "/api/v1/artifacts/uploads", operationId: "beginMediaUpload" },
  { method: "GET", path: "/api/v1/artifacts/uploads/{uploadId}", operationId: "getMediaUpload" },
  { method: "PUT", path: "/api/v1/artifacts/uploads/{uploadId}/chunks/{chunkIndex}", operationId: "appendMediaChunk" },
  { method: "POST", path: "/api/v1/artifacts/uploads/{uploadId}/complete", operationId: "completeMediaUpload" },
  { method: "GET", path: "/api/v1/artifacts/{artifactId}", operationId: "getMediaArtifact" },
  { method: "POST", path: "/api/v1/jobs", operationId: "submitMediaJob" },
  { method: "GET", path: "/api/v1/jobs", operationId: "listMediaJobs" },
  { method: "GET", path: "/api/v1/jobs/{jobId}", operationId: "getMediaJob" },
  { method: "POST", path: "/api/v1/jobs/{jobId}/cancel", operationId: "cancelMediaJob" },
  { method: "POST", path: "/api/v1/streams", operationId: "openMediaStream" },
  { method: "GET", path: "/api/v1/streams/{sessionId}", operationId: "getMediaStream" },
  { method: "POST", path: "/api/v1/streams/{sessionId}/connect", operationId: "connectMediaStream" },
  { method: "POST", path: "/api/v1/streams/{sessionId}/frames/{sequence}", operationId: "submitMediaStreamFrame" },
  { method: "POST", path: "/api/v1/streams/{sessionId}/close", operationId: "closeMediaStream" },
];

const observedRouteMethods: Record<keyof typeof canonicalMediaHttpRoutes, string> = {
  beginUpload: "POST", getUpload: "GET", appendChunk: "PUT", completeUpload: "POST",
  getArtifact: "GET", submitJob: "POST", listJobs: "GET", getJob: "GET", cancelJob: "POST",
  openStream: "POST", getStream: "GET", connectStream: "POST", submitStreamFrame: "POST", closeStream: "POST",
  listProviders: "GET", health: "GET",
};

function routeKey(route: Pick<Route, "method" | "path">): string {
  return `${route.method} ${route.path}`;
}

describe("SK-01 canonical Media route parity", () => {
  it("keeps every currently bound canonical client operation present in both route sources", () => {
    const openApiKeys = new Set(openApiRoutes.map(routeKey));
    const manifestKeys = new Set(manifestRoutes.map(routeKey));
    for (const route of clientBoundRoutes) {
      expect(openApiKeys, `OpenAPI missing ${routeKey(route)} (${route.operationId})`).toContain(routeKey(route));
      expect(manifestKeys, `runtime manifest missing ${routeKey(route)} (${route.operationId})`).toContain(routeKey(route));
      expect(openApiRoutes.find((candidate) => routeKey(candidate) === routeKey(route))?.operationId)
        .toBe(route.operationId);
      expect(manifestRoutes.find((candidate) => routeKey(candidate) === routeKey(route))?.operationId)
        .toBe(route.operationId);
    }
    // Reverse direction within the client-bound scope: neither route source may declare
    // a bound client operation that is absent from the other source.
    const boundKeys = new Set(clientBoundRoutes.map(routeKey));
    const openApiBound = openApiRoutes.filter((route) => boundKeys.has(routeKey(route)));
    const manifestBound = manifestRoutes.filter((route) => boundKeys.has(routeKey(route)));
    expect(new Set(openApiBound.map((route) => `${routeKey(route)} ${route.operationId}`)))
      .toEqual(new Set(manifestBound.map((route) => `${routeKey(route)} ${route.operationId}`)));
  });

  it("keeps each exported observed route value in both route sources, in both directions", () => {
    const observed = Object.entries(canonicalMediaHttpRoutes).map(([name, path]) => ({
      method: observedRouteMethods[name as keyof typeof observedRouteMethods], path,
    }));
    const openApiKeys = new Set(openApiRoutes.map(routeKey));
    const manifestKeys = new Set(manifestRoutes.map(routeKey));
    for (const route of observed) {
      expect(openApiKeys, `OpenAPI missing observed route ${routeKey(route)}`).toContain(routeKey(route));
      expect(manifestKeys, `runtime manifest missing observed route ${routeKey(route)}`).toContain(routeKey(route));
    }
  });

  it("reports legacy compatibility routes as a separate namespace, not canonical routes", () => {
    const compatibilityPaths = Object.values(legacyCompatibilityRoutes);
    expect(compatibilityPaths).toHaveLength(6);
    for (const path of compatibilityPaths) {
      expect(path).toMatch(/^\/api\/v1\/media\//u);
      expect(Object.values(canonicalMediaHttpRoutes)).not.toContain(path);
    }
  });
});
