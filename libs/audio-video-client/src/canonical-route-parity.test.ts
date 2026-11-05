import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import * as ts from "typescript";
import { canonicalMediaHttpRoutes, legacyCompatibilityRoutes } from "./canonical-routes";
import { MediaOperationClient } from "./operations";
import { MediaCanonicalClient } from "./canonical-operations";
import { AudioVideoClient } from "./index";

const repositoryRoot = resolve(import.meta.dirname, "../../../");
const openApiText = readFileSync(resolve(repositoryRoot, "contracts/openapi/media.yaml"), "utf8");
const pdp1OperationsText = readFileSync(resolve(repositoryRoot, ".product-experience/pdp-1-domain-data/operations.yaml"), "utf8");
const sk01SourceText = readFileSync(resolve(repositoryRoot, "docs/implementation/MEDIA-REMAINING-ONLY-OWNER-EXECUTION-2026-11-02.md"), "utf8");
const manifest = JSON.parse(readFileSync(resolve(repositoryRoot, "config/route-manifest.json"), "utf8")) as {
  routes: { method: string; path: string; operationId: string }[];
};
const rpcSources = [
  "modules/speech/stt-service/src/main/proto/stt_service.proto",
  "modules/speech/tts-service/src/main/proto/tts_service.proto",
  "modules/vision/vision-service/src/main/proto/vision_service.proto",
  "modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto",
].map((path) => readFileSync(resolve(repositoryRoot, path), "utf8"));
const sdkClassSources = {
  AudioVideoClient: readFileSync(resolve(repositoryRoot, "libs/audio-video-client/src/index.ts"), "utf8"),
  MediaOperationClient: readFileSync(resolve(repositoryRoot, "libs/audio-video-client/src/operations.ts"), "utf8"),
  MediaCanonicalClient: readFileSync(resolve(repositoryRoot, "libs/audio-video-client/src/canonical-operations.ts"), "utf8"),
};
const sharedTransportSource = readFileSync(resolve(repositoryRoot, "libs/audio-video-client/src/http-core.ts"), "utf8");
const legacyFacadeSource = readFileSync(resolve(repositoryRoot, "libs/audio-video-client/src/index.ts"), "utf8");

function publicMethodBodies(source: string, className: string): Map<string, string> {
  const file = ts.createSourceFile(`${className}.ts`, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  let target: ts.ClassDeclaration | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isClassDeclaration(node) && node.name?.text === className) target = node;
    ts.forEachChild(node, visit);
  };
  visit(file);
  if (!target) throw new Error(`SDK class ${className} was not found.`);
  const methods = new Map<string, string>();
  for (const member of target.members) {
    if (!ts.isMethodDeclaration(member) || !member.body || !member.name) continue;
    const modifiers = ts.getModifiers(member) ?? [];
    if (modifiers.some((modifier) => modifier.kind === ts.SyntaxKind.PrivateKeyword
      || modifier.kind === ts.SyntaxKind.ProtectedKeyword)) continue;
    const name = ts.isIdentifier(member.name) ? member.name.text : undefined;
    if (name) methods.set(name, member.getText(file));
  }
  return methods;
}

const publicSdkMethods = Object.fromEntries(
  Object.entries(sdkClassSources).map(([className, source]) => [className, publicMethodBodies(source, className)]),
) as Record<keyof typeof sdkClassSources, Map<string, string>>;

type Route = { method: string; path: string; operationId: string; hasResponses?: boolean };

function readOpenApiRoutes(text: string): Route[] {
  const pathsSection = text.split(/^paths:\s*$/mu)[1]?.split(/^components:\s*$/mu)[0];
  if (!pathsSection) throw new Error("OpenAPI paths section was not found.");
  const routes: Route[] = [];
  let path: string | undefined;
  let method: string | undefined;
  let operationId: string | undefined;
  let hasResponses = false;
  const flush = () => {
    if (path && method && operationId) routes.push({ method: method.toUpperCase(), path, operationId, hasResponses });
    method = undefined;
    operationId = undefined;
    hasResponses = false;
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
    if (/^      responses:/u.test(line) && method) hasResponses = true;
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
  it("accounts for every public method on the three SDK clients and binds each dispatch source", () => {
    const methodDisposition: Record<keyof typeof sdkClassSources, {
      canonicalHttp: string[];
      legacyUnboundHttp: string[];
      unboundNotAdmitted: string[];
      noRoute: string[];
      local: string[];
    }> = {
      AudioVideoClient: {
        canonicalHttp: [],
        legacyUnboundHttp: ["getServiceStatus"],
        unboundNotAdmitted: ["transcribe", "synthesize", "processAIVoice", "processVision", "processMultimodal"],
        noRoute: [],
        local: ["getAllServicesStatus", "addEventListener", "removeEventListener"],
      },
      MediaOperationClient: {
        canonicalHttp: ["createUploadSession", "uploadPart", "getUploadSession", "completeUploadSession", "getArtifact"],
        legacyUnboundHttp: [],
        unboundNotAdmitted: ["listProviderCapabilities", "transcribe", "synthesize", "trainVoiceModel", "convertVoice", "getOperation", "cancelOperation", "getOperationResult"],
        noRoute: ["inspectArtifactVersion", "analyzeMultimodal", "retryOperation"],
        local: [],
      },
      MediaCanonicalClient: {
        canonicalHttp: ["submitJob", "getJob", "listJobs", "cancelJob", "openStream", "getStream", "connectStream", "submitStreamFrame", "closeStream"],
        legacyUnboundHttp: [],
        unboundNotAdmitted: [],
        noRoute: ["watchStream", "checkOutcome", "listJobsPage", "readJobStatusDimensions"],
        local: [],
      },
    };
    for (const [className, disposition] of Object.entries(methodDisposition) as [keyof typeof sdkClassSources, typeof methodDisposition[keyof typeof sdkClassSources]][]) {
      const expected = new Set([
        ...disposition.canonicalHttp, ...disposition.legacyUnboundHttp, ...disposition.unboundNotAdmitted,
        ...disposition.noRoute, ...disposition.local,
      ]);
      expect([...publicSdkMethods[className].keys()].sort(), `${className} public method inventory`)
        .toEqual([...expected].sort());
      for (const method of expected) {
        expect(publicSdkMethods[className].has(method), `${className}.${method} has no disposition`).toBe(true);
      }
    }

    const canonicalDispatchSource: Record<string, Record<string, string>> = {
      AudioVideoClient: {},
      MediaOperationClient: {
        createUploadSession: '"/api/v1/artifacts/uploads"',
        uploadPart: '`/api/v1/artifacts/uploads/${encodeURIComponent(current.uploadId)}/chunks/${chunkIndex}`',
        getUploadSession: '`/api/v1/artifacts/uploads/${encodeURIComponent(requestedUploadId)}`',
        completeUploadSession: '`/api/v1/artifacts/uploads/${encodeURIComponent(requestedId)}/complete`',
        getArtifact: '`/api/v1/artifacts/${encodeURIComponent(requestedArtifactId)}`',
      },
      MediaCanonicalClient: {
        submitJob: "canonicalMediaHttpRoutes.submitJob",
        getJob: "canonicalMediaHttpRoutes.getJob.replace",
        listJobs: "canonicalMediaHttpRoutes.listJobs",
        cancelJob: "canonicalMediaHttpRoutes.cancelJob.replace",
        openStream: '"POST", "/api/v1/streams"',
        getStream: '`/api/v1/streams/${encodeURIComponent(requested)}`',
        connectStream: '`/api/v1/streams/${encodeURIComponent(requested)}/connect`',
        submitStreamFrame: '`${this.transport.baseUrl}/api/v1/streams/${encodeURIComponent(requested)}/frames/${sequence}`',
        closeStream: '`/api/v1/streams/${encodeURIComponent(requested)}/close`',
      },
    };
    const legacyDispatchSource: Record<string, Record<string, string>> = {
      AudioVideoClient: {
        transcribe: "'/api/stt/transcribe'",
        synthesize: "'/api/tts/synthesize'",
        processAIVoice: "'/api/ai-voice/process'",
        processVision: "'/api/vision/analyze'",
        processMultimodal: "'/api/multimodal/process'",
        getServiceStatus: "path: '/health'",
      },
      MediaOperationClient: {
      },
      MediaCanonicalClient: {},
    };
    for (const [className, methods] of Object.entries(canonicalDispatchSource)) {
      for (const [method, sourceNeedle] of Object.entries(methods)) {
        expect(publicSdkMethods[className as keyof typeof sdkClassSources].get(method), `${className}.${method}`)
          .toContain(sourceNeedle);
      }
    }
    for (const [className, methods] of Object.entries(legacyDispatchSource)) {
      for (const [method, sourceNeedle] of Object.entries(methods)) {
        expect(publicSdkMethods[className as keyof typeof sdkClassSources].get(method), `${className}.${method}`)
          .toContain(sourceNeedle);
      }
    }
    for (const method of methodDisposition.MediaOperationClient.unboundNotAdmitted) {
      expect(publicSdkMethods.MediaOperationClient.get(method), `MediaOperationClient.${method}`)
        .toContain("MediaOperationNotAdmittedError");
    }
    for (const path of [
      "/api/v1/media/providers/capabilities", "/api/v1/media/transcriptions",
      "/api/v1/media/syntheses", "/api/v1/media/voice-models:train",
      "/api/v1/media/voice-conversions", "/api/v1/media/operations/",
    ]) {
      expect(sdkClassSources.MediaOperationClient).not.toContain(path);
    }
    expect(sharedTransportSource).toContain('if (path.startsWith("/api/v1/media/"))');
    expect(sharedTransportSource).toContain("throw new MediaOperationNotAdmittedError(operation)");
    expect(legacyFacadeSource).toContain("if (!(method === 'GET' && path === '/health'))");
    expect(legacyFacadeSource).toContain("code: 'NOT_ADMITTED'");
    const legacyHttpRoutes = [
      ["POST", "/api/stt/transcribe"], ["POST", "/api/tts/synthesize"],
      ["POST", "/api/ai-voice/process"], ["POST", "/api/vision/analyze"],
      ["POST", "/api/multimodal/process"],
      ["GET", "/api/v1/media/providers/capabilities"],
      ["POST", "/api/v1/media/transcriptions"], ["POST", "/api/v1/media/syntheses"],
      ["POST", "/api/v1/media/voice-models:train"], ["POST", "/api/v1/media/voice-conversions"],
      ["GET", "/api/v1/media/operations/{operationId}"],
      ["POST", "/api/v1/media/operations/{operationId}:cancel"],
      ["GET", "/api/v1/media/operations/{operationId}/result"],
    ];
    const observedRouteKeys = new Set(openApiRoutes.map(routeKey));
    for (const [method, path] of legacyHttpRoutes) {
      expect(observedRouteKeys, `legacy path unexpectedly appeared in current routes: ${method} ${path}`)
        .not.toContain(`${method} ${path}`);
    }
    // This one path is present but belongs to the operational health API; it
    // does not establish the legacy facade's per-service status semantics.
    expect(openApiRoutes.find((route) => routeKey(route) === "GET /health")?.operationId).toBe("getMediaHealth");
    expect(publicSdkMethods.AudioVideoClient.get("getAllServicesStatus")).toContain("this.getServiceStatus(s)");
    expect(publicSdkMethods.AudioVideoClient.get("addEventListener")).not.toContain("this.callService");
    expect(publicSdkMethods.AudioVideoClient.get("removeEventListener")).not.toContain("this.callService");
    for (const method of methodDisposition.MediaOperationClient.noRoute) {
      expect(publicSdkMethods.MediaOperationClient.get(method)).toContain("MediaOperationNotAdmittedError");
    }
    for (const method of methodDisposition.MediaCanonicalClient.noRoute) {
      expect(publicSdkMethods.MediaCanonicalClient.get(method)).toContain("MediaOperationNotAdmittedError");
    }
    expect(methodDisposition.MediaCanonicalClient.canonicalHttp).toHaveLength(9);
    expect(methodDisposition.MediaOperationClient.canonicalHttp).toHaveLength(5);
    expect(methodDisposition.AudioVideoClient.legacyUnboundHttp).toHaveLength(1);
    expect(methodDisposition.AudioVideoClient.unboundNotAdmitted).toHaveLength(5);
    expect(methodDisposition.MediaOperationClient.legacyUnboundHttp).toHaveLength(0);
    expect(methodDisposition.MediaOperationClient.unboundNotAdmitted).toHaveLength(8);
    expect(Object.values(publicSdkMethods).reduce((total, methods) => total + methods.size, 0)).toBe(38);
    expect(methodDisposition.MediaCanonicalClient.canonicalHttp.length
      + methodDisposition.MediaOperationClient.canonicalHttp.length).toBe(14);
    expect(methodDisposition.AudioVideoClient.legacyUnboundHttp.length
      + methodDisposition.AudioVideoClient.unboundNotAdmitted.length
      + methodDisposition.MediaOperationClient.unboundNotAdmitted.length).toBe(14);
  });

  it("binds every currently implemented canonical SDK transport operation to its exact observed route", () => {
    const sdkMethodByOperationId: Record<string, { owner: object; method: string }> = {
      beginMediaUpload: { owner: MediaOperationClient.prototype, method: "createUploadSession" },
      getMediaUpload: { owner: MediaOperationClient.prototype, method: "getUploadSession" },
      appendMediaChunk: { owner: MediaOperationClient.prototype, method: "uploadPart" },
      completeMediaUpload: { owner: MediaOperationClient.prototype, method: "completeUploadSession" },
      getMediaArtifact: { owner: MediaOperationClient.prototype, method: "getArtifact" },
      submitMediaJob: { owner: MediaCanonicalClient.prototype, method: "submitJob" },
      listMediaJobs: { owner: MediaCanonicalClient.prototype, method: "listJobs" },
      getMediaJob: { owner: MediaCanonicalClient.prototype, method: "getJob" },
      cancelMediaJob: { owner: MediaCanonicalClient.prototype, method: "cancelJob" },
      openMediaStream: { owner: MediaCanonicalClient.prototype, method: "openStream" },
      getMediaStream: { owner: MediaCanonicalClient.prototype, method: "getStream" },
      connectMediaStream: { owner: MediaCanonicalClient.prototype, method: "connectStream" },
      submitMediaStreamFrame: { owner: MediaCanonicalClient.prototype, method: "submitStreamFrame" },
      closeMediaStream: { owner: MediaCanonicalClient.prototype, method: "closeStream" },
    };
    expect(Object.keys(sdkMethodByOperationId)).toHaveLength(clientBoundRoutes.length);
    for (const route of clientBoundRoutes) {
      const binding = sdkMethodByOperationId[route.operationId];
      expect(binding, `SDK operation missing for ${route.operationId}`).toBeDefined();
      expect(binding!.owner).toHaveProperty(binding!.method);
      expect(openApiRoutes.find((candidate) => routeKey(candidate) === routeKey(route))?.operationId)
        .toBe(route.operationId);
    }
    // These observed routes have no corresponding canonical SDK dispatch yet;
    // they remain route observations rather than newly advertised client calls.
    expect(sdkMethodByOperationId).not.toHaveProperty("getMediaProviders");
    expect(sdkMethodByOperationId).not.toHaveProperty("getMediaVersionedHealth");
  });

  it("keeps historical facade operations explicit as unbound legacy HTTP paths", () => {
    const legacyFacadePaths: Record<string, string> = {
      transcribe: "/api/stt/transcribe",
      synthesize: "/api/tts/synthesize",
      processAIVoice: "/api/ai-voice/process",
      processVision: "/api/vision/analyze",
      processMultimodal: "/api/multimodal/process",
      getServiceStatus: "/health",
    };
    const methods = AudioVideoClient.prototype;
    const observedPaths = new Set(openApiRoutes.map((route) => route.path));
    for (const [method, path] of Object.entries(legacyFacadePaths)) {
      expect(methods, `legacy facade method missing: ${method}`).toHaveProperty(method);
      if (method === "getServiceStatus") {
        // The path collision is an operational health probe, not the legacy
        // per-service status operation described by this facade method.
        expect(observedPaths).toContain(path);
        expect(openApiRoutes.find((route) => route.path === path && route.method === "GET")?.operationId)
          .toBe("getMediaHealth");
      } else {
        expect(observedPaths, `legacy facade path unexpectedly mapped: ${method}`).not.toContain(path);
      }
    }
    // The older operation-oriented helper retains exported signatures but
    // unsupported operations reject before transport.
    const operationClientSource = readFileSync(resolve(repositoryRoot, "libs/audio-video-client/src/operations.ts"), "utf8");
    for (const path of [
      "/api/v1/media/providers/capabilities", "/api/v1/media/transcriptions",
      "/api/v1/media/syntheses", "/api/v1/media/operations/",
    ]) {
      expect(operationClientSource).not.toContain(path);
    }
    expect(operationClientSource).toContain("MediaOperationNotAdmittedError(\"media.sdk.listProviderCapabilities\")");
    expect(operationClientSource).toContain("MediaOperationNotAdmittedError(\"media.sdk.getOperation\")");
    expect(operationClientSource).toContain("MediaOperationNotAdmittedError(\"media.sdk.analyzeMultimodal\")");
    expect(operationClientSource).toContain("MediaOperationNotAdmittedError(\"media.operation.retry\")");
    expect(legacyCompatibilityRoutes.operations).toBe("/api/v1/media/operations/{operationId}");
  });

  it("snapshots all 30 observed HTTP route identities and their OpenAPI response declarations", () => {
    expect(openApiRoutes).toHaveLength(30);
    expect(manifestRoutes).toHaveLength(30);
    const openApiByKey = new Map(openApiRoutes.map((route) => [routeKey(route), route]));
    const manifestByKey = new Map(manifestRoutes.map((route) => [routeKey(route), route]));
    expect(new Set(openApiByKey.keys())).toEqual(new Set(manifestByKey.keys()));
    for (const [key, route] of openApiByKey) {
      expect(route.hasResponses, `OpenAPI ${key} (${route.operationId}) has no response declaration`).toBe(true);
      expect(manifestByKey.get(key)?.operationId, `route manifest operationId mismatch for ${key}`)
        .toBe(route.operationId);
    }
  });

  it("maps each observed HTTP route family to its PDP-1 operation identity without upgrading disposition", () => {
    const pdpOperationsByFamily: Record<string, string> = {
      health: "media.operation.health-capability",
      consent: "media.operation.consent",
      artifact: "media.operation.artifact-ingest",
      job: "media.operation.job-lifecycle",
      stream: "media.operation.stream-session",
      captionRead: "media.operation.caption-version-read",
      captionWrite: "media.operation.caption-version-write",
    };
    const familyFor = (route: Route): keyof typeof pdpOperationsByFamily => {
      if (route.path.startsWith("/api/v1/consents")) return "consent";
      if (route.path.startsWith("/api/v1/artifacts")) return "artifact";
      if (route.path.startsWith("/api/v1/jobs")) return "job";
      if (route.path.startsWith("/api/v1/streams")) return "stream";
      if (route.path.startsWith("/api/v1/caption-versions")) {
        return route.method === "GET" ? "captionRead" : "captionWrite";
      }
      return "health";
    };
    for (const route of manifestRoutes) {
      const family = familyFor(route);
      const operationId = pdpOperationsByFamily[family];
      expect(pdp1OperationsText, `PDP-1 operation identity missing for ${routeKey(route)}`)
        .toContain(`operationId: ${operationId}`);
    }
    // These operation families are source definitions/proposals; matching wire
    // identities do not admit their semantics or runtime effects.
    const operationBlock = (operationId: string): string => {
      const start = pdp1OperationsText.indexOf(`  - id: ${operationId}\n`);
      expect(start, `PDP-1 identity missing: ${operationId}`).toBeGreaterThanOrEqual(0);
      const end = pdp1OperationsText.indexOf("\n  - id: ", start + 1);
      return pdp1OperationsText.slice(start, end < 0 ? undefined : end);
    };
    for (const operationId of Object.values(pdpOperationsByFamily)) {
      expect(operationBlock(operationId)).toContain(`operationId: ${operationId}`);
    }
    for (const operationId of [
      "media.operation.health-capability", "media.operation.consent",
      "media.operation.artifact-ingest", "media.operation.job-lifecycle",
      "media.operation.stream-session",
    ]) {
      expect(operationBlock(operationId)).toContain("proposal-only");
    }
    expect(operationBlock("media.operation.caption-version-read")).toContain("NOT_ADMITTED");
    expect(operationBlock("media.operation.caption-version-write")).toContain("NOT_ADMITTED");
  });

  it("keeps the 44 gRPC identities a separate channel and retains scene-text proposal status", () => {
    const rpcNames = rpcSources.flatMap((source) => [...source.matchAll(/^\s*rpc\s+(\w+)\s*\(/gmu)]
      .map((match) => match[1]!));
    expect(rpcNames).toHaveLength(44);
    expect(rpcNames.filter((name) => name === "RecognizeSceneText")).toHaveLength(1);
    expect(sk01SourceText).toContain("VisionService.RecognizeSceneText` proposal-only");
  });

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
