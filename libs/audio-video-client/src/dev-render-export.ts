/**
 * Purpose: DEV_ONLY loopback adapter for the project render and hosted export routes used by the
 * local-development CLI (`media.dev.structured-cli`).
 * Consumers: `cli.ts` local-development channel only; it is not exported from the package index.
 * Non-goals: production admission, canonical manifest/OpenAPI routes, batch semantics, or inferring
 * success (a render/export is reported only from a strictly validated host response).
 * Change policy: response shapes mirror launcher MediaDevProjectRender/MediaDevDelivery routes exactly.
 */
import {
  MediaClientError,
  MediaHttpTransport,
  MediaOperationAmbiguousError,
  safeIdentityHeader,
  type MediaTransportConfig,
} from "./http-core.js";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const EXPORT_STATUSES = new Set(["QUEUED", "SENT", "DESTINATION_CONFIRMED", "OUTCOME_UNKNOWN", "REVOKED", "UNAVAILABLE"]);
const RENDER_CONTENT_TYPES: Readonly<Record<string, string>> = { gif: "image/gif", mp4: "video/mp4" };
const DEFINITIVE_STATUSES = new Set([400, 401, 403, 404, 409, 422, 429, 503]);

export type DevRenderFormat = "gif" | "mp4";

export interface DevRenderRequest {
  readonly requestId: string;
  readonly revisionId: string;
  readonly timelineId: string;
  readonly width: number;
  readonly height: number;
  readonly framesPerSecond: number;
  readonly format?: DevRenderFormat;
}

export interface DevRenderResult {
  readonly renderId: string;
  readonly artifact: {
    readonly artifactId: string;
    readonly artifactVersionId: string;
    readonly sha256: string;
    readonly contentType: string;
    readonly sizeBytes: number;
  };
  readonly replayed: boolean;
  readonly lineage: Readonly<Record<string, unknown>>;
}

export interface DevExportRequest {
  readonly requestId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly destinationId: string;
}

export interface DevExportResult {
  readonly requestId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly artifactDigest: string;
  readonly destinationId: string;
  readonly status: string;
  readonly acknowledgedBytes: number;
  readonly destinationConfirmed: boolean;
  readonly destinationReceiptRef: string | null;
  readonly replayed: boolean;
  /** HTTP status the host used (201 confirmed, 200 replay/read, 202 not yet confirmed). */
  readonly httpStatus: number;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Canonical Media DEV_ONLY ${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  if (Object.keys(value).length !== keys.length || keys.some((key) => !Object.hasOwn(value, key))) {
    throw new TypeError(`Canonical Media DEV_ONLY ${label} fields do not match its declared schema.`);
  }
}

function text(value: unknown, label: string, max = 384): string {
  if (typeof value !== "string" || value.length < 1 || value.length > max || value !== value.trim()
    || /[\u0000-\u001f\u007f]/u.test(value)) {
    throw new TypeError(`Canonical Media DEV_ONLY ${label} is invalid.`);
  }
  return value;
}

function positiveInt(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`Canonical Media DEV_ONLY ${label} is invalid.`);
  }
  return value as number;
}

function parseRender(input: unknown, projectId: string, expected: Partial<DevRenderRequest>,
  expectedRenderId?: string): DevRenderResult {
  const value = record(input, "render result");
  exactKeys(value, ["renderId", "artifact", "lineage", "replayed", "scope"], "render result");
  if (value.scope !== "DEV_ONLY" || typeof value.replayed !== "boolean") {
    throw new TypeError("Canonical Media DEV_ONLY render result scope is invalid.");
  }
  const artifact = record(value.artifact, "render artifact");
  exactKeys(artifact, ["artifactId", "artifactVersionId", "contentType", "sizeBytes", "sha256", "artifactPath"], "render artifact");
  const artifactId = text(artifact.artifactId, "render artifact id", 128);
  const renderId = text(value.renderId, "render id", 128);
  const sha256 = text(artifact.sha256, "render sha256", 64);
  const contentType = text(artifact.contentType, "render content type", 127);
  if (renderId !== artifactId || !OPAQUE_ID.test(artifactId) || !SHA256.test(sha256)
    || !Object.values(RENDER_CONTENT_TYPES).includes(contentType)
    || !Number.isSafeInteger(artifact.sizeBytes) || (artifact.sizeBytes as number) < 1
    || (expectedRenderId !== undefined && renderId !== expectedRenderId)) {
    throw new TypeError("Canonical Media DEV_ONLY render artifact identity is invalid.");
  }
  const artifactVersionId = text(artifact.artifactVersionId, "render artifact version", 384);
  const lineage = record(value.lineage, "render lineage");
  if (lineage.scope !== "DEV_ONLY" || lineage.projectId !== projectId
    || typeof lineage.revisionId !== "string" || typeof lineage.timelineId !== "string"
    || (lineage.format !== "gif" && lineage.format !== "mp4")
    || contentType !== RENDER_CONTENT_TYPES[lineage.format]
    || !Number.isSafeInteger(lineage.width) || !Number.isSafeInteger(lineage.height)
    || !Number.isSafeInteger(lineage.framesPerSecond) || !Number.isSafeInteger(lineage.frameCount)
    || !Array.isArray(lineage.sources)
    || (expected.revisionId !== undefined && lineage.revisionId !== expected.revisionId)
    || (expected.timelineId !== undefined && lineage.timelineId !== expected.timelineId)
    || (expected.requestId !== undefined && lineage.requestId !== expected.requestId)
    || (expected.width !== undefined && lineage.width !== expected.width)
    || (expected.height !== undefined && lineage.height !== expected.height)
    || (expected.framesPerSecond !== undefined && lineage.framesPerSecond !== expected.framesPerSecond)
    || (expected.format !== undefined && lineage.format !== expected.format)) {
    throw new TypeError("Canonical Media DEV_ONLY render lineage does not match the requested render.");
  }
  const summary: Record<string, unknown> = {
    projectId, revisionId: lineage.revisionId, timelineId: lineage.timelineId,
    format: lineage.format, width: lineage.width, height: lineage.height,
    framesPerSecond: lineage.framesPerSecond, frameCount: lineage.frameCount,
    sourceCount: lineage.sources.length,
  };
  for (const key of ["timelineSemanticVersionId", "engine", "requestId"] as const) {
    if (lineage[key] !== undefined) summary[key] = text(lineage[key], `render lineage ${key}`);
  }
  return {
    renderId,
    artifact: { artifactId, artifactVersionId, sha256, contentType, sizeBytes: artifact.sizeBytes as number },
    replayed: value.replayed,
    lineage: summary,
  };
}

function parseExport(input: unknown, expected: Partial<DevExportRequest>, httpStatus: number, createRoute: boolean): DevExportResult {
  const value = record(input, "export result");
  exactKeys(value, ["requestId", "artifactId", "artifactVersionId", "artifactDigest", "destinationId", "status",
    "acknowledgedBytes", "destinationConfirmed", "destinationReceiptRef", "replayed", "scope"], "export result");
  const status = text(value.status, "export status", 32);
  if (value.scope !== "DEV_ONLY" || typeof value.replayed !== "boolean"
    || typeof value.destinationConfirmed !== "boolean" || !EXPORT_STATUSES.has(status)) {
    throw new TypeError("Canonical Media DEV_ONLY export result scope or status is invalid.");
  }
  const receipt = value.destinationReceiptRef === null ? null : text(value.destinationReceiptRef, "export receipt");
  const confirmed = value.destinationConfirmed;
  // Confirmation is only ever the combination of the confirmed status and a non-empty receipt.
  if (confirmed !== (status === "DESTINATION_CONFIRMED") || confirmed !== (receipt !== null)
    || (createRoute && confirmed !== (httpStatus !== 202))) {
    throw new TypeError("Canonical Media DEV_ONLY export confirmation contradicts its status or receipt.");
  }
  const result: DevExportResult = {
    requestId: text(value.requestId, "export request id", 128),
    artifactId: text(value.artifactId, "export artifact id"),
    artifactVersionId: text(value.artifactVersionId, "export artifact version"),
    artifactDigest: text(value.artifactDigest, "export artifact digest"),
    destinationId: text(value.destinationId, "export destination"),
    status, acknowledgedBytes: positiveInt(value.acknowledgedBytes, "export acknowledged bytes"),
    destinationConfirmed: confirmed, destinationReceiptRef: receipt, replayed: value.replayed, httpStatus,
  };
  if (!OPAQUE_ID.test(result.requestId)
    || (expected.requestId !== undefined && result.requestId !== expected.requestId)
    || (expected.artifactId !== undefined && result.artifactId !== expected.artifactId)
    || (expected.artifactVersionId !== undefined && result.artifactVersionId !== expected.artifactVersionId)
    || (expected.destinationId !== undefined && result.destinationId !== expected.destinationId)) {
    throw new TypeError("Canonical Media DEV_ONLY export result does not match the requested export.");
  }
  return result;
}

/** Loopback-only adapter; keeps these DEV_ONLY operations out of the canonical production client. */
export class MediaDevOnlyRenderExportClient {
  private readonly transport: MediaHttpTransport;
  private lastStatus = 0;

  public constructor(config: MediaTransportConfig) {
    const endpoint = new URL(config.baseUrl);
    if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(endpoint.hostname.toLowerCase())) {
      throw new Error("DEV_ONLY render and export require a loopback Media endpoint.");
    }
    const inner = config.fetchImpl ?? globalThis.fetch;
    this.transport = new MediaHttpTransport({
      ...config,
      fetchImpl: async (input, init) => {
        const response = await inner(input, init);
        this.lastStatus = response.status;
        return response;
      },
    });
    const principal = Object.entries(this.transport.callerDefaultHeaders())
      .find(([name]) => name.toLowerCase() === "x-principal-id")?.[1];
    if (!safeIdentityHeader("principalId", principal)) {
      throw new Error("DEV_ONLY render and export require the caller's X-Principal-Id scope header.");
    }
  }

  private async mutate<T>(path: string, body: unknown, requestId: string,
    parse: (input: unknown) => T, signal?: AbortSignal): Promise<T> {
    let dispatched = false;
    try {
      this.lastStatus = 0;
      return await this.transport.request("POST", path, body, { parse }, signal, {}, () => { dispatched = true; });
    } catch (failure) {
      const definitive = failure instanceof MediaClientError && DEFINITIVE_STATUSES.has(failure.statusCode ?? 0);
      if (dispatched && !definitive && !(failure instanceof TypeError && failure.message.startsWith("Canonical Media DEV_ONLY")) && !(failure instanceof SyntaxError)) {
        throw new MediaOperationAmbiguousError(path, failure, { requestId });
      }
      throw failure;
    }
  }

  public renderProject(projectId: string, request: DevRenderRequest, signal?: AbortSignal): Promise<DevRenderResult> {
    if (!OPAQUE_ID.test(projectId) || !OPAQUE_ID.test(request.requestId)) {
      throw new Error("projectId and render requestId must be bounded opaque identities.");
    }
    const body = { requestId: request.requestId, revisionId: request.revisionId, timelineId: request.timelineId,
      width: request.width, height: request.height, framesPerSecond: request.framesPerSecond,
      ...(request.format === undefined ? {} : { format: request.format }) };
    const expected = { ...request, format: request.format ?? "gif" };
    return this.mutate(`/dev/v1/projects/${encodeURIComponent(projectId)}/renders`, body, request.requestId,
      (input) => parseRender(input, projectId, expected), signal);
  }

  public getRender(projectId: string, renderId: string, signal?: AbortSignal): Promise<DevRenderResult> {
    if (!OPAQUE_ID.test(projectId) || !OPAQUE_ID.test(renderId)) {
      throw new Error("projectId and renderId must be bounded opaque identities.");
    }
    return this.transport.request("GET",
      `/dev/v1/projects/${encodeURIComponent(projectId)}/renders/${encodeURIComponent(renderId)}`, undefined,
      { parse: (input) => parseRender(input, projectId, {}, renderId) }, signal);
  }

  public createExport(request: DevExportRequest, signal?: AbortSignal): Promise<DevExportResult> {
    if (!OPAQUE_ID.test(request.requestId)) throw new Error("export requestId must be a bounded opaque identity.");
    return this.mutate("/dev/v1/exports", { ...request }, request.requestId,
      (input) => parseExport(input, request, this.lastStatus, true), signal);
  }

  public getExport(requestId: string, signal?: AbortSignal): Promise<DevExportResult> {
    if (!OPAQUE_ID.test(requestId)) throw new Error("export requestId must be a bounded opaque identity.");
    return this.transport.request("GET", `/dev/v1/exports/${encodeURIComponent(requestId)}`, undefined,
      { parse: (input) => parseExport(input, { requestId }, 200, false) }, signal);
  }
}
