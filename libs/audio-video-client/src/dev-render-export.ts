/**
 * Purpose: DEV_ONLY loopback adapter for the project render and hosted export routes used by the
 * local-development CLI (`media.dev.structured-cli`).
 * Consumers: the local-development CLI and the narrowed `dev-project-render` SDK subpath.
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
  readonly scope: "DEV_ONLY";
  readonly renderId: string;
  readonly artifact: {
    readonly artifactId: string;
    readonly artifactVersionId: string;
    readonly sha256: string;
    readonly contentType: string;
    readonly sizeBytes: number;
    readonly artifactPath: string;
  };
  readonly replayed: boolean;
  readonly lineage: DevProjectRenderLineage;
}

export interface DevRenderSourceVersion {
  readonly clipId: string;
  readonly trackId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly trackKind?: string;
  readonly sha256?: string;
  readonly normalizedFrameSha256?: string;
  readonly startFrame?: number;
  readonly endFrameExclusive?: number;
}

export interface DevProjectRenderLineage extends Readonly<Record<string, unknown>> {
  readonly scope: "DEV_ONLY";
  readonly projectId: string;
  readonly revisionId: string;
  readonly timelineId: string;
  readonly timelineSemanticVersionId: string;
  readonly requestId: string;
  readonly engine: string;
  readonly format: DevRenderFormat;
  readonly width: number;
  readonly height: number;
  readonly framesPerSecond: number;
  readonly frameCount: number;
  readonly sourceCount: number;
  readonly sources: readonly DevRenderSourceVersion[];
}

export interface DevExportRequest {
  readonly requestId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly destinationId: string;
}

export interface DevExportResult {
  readonly scope: "DEV_ONLY";
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
  /** Destination acknowledgement observation, present when the host reports it (DELIVERED only when confirmed). */
  readonly ackState?: string;
  readonly failure?: string | null;
  readonly destinationReceivedBytes?: number | null;
  readonly observedAt?: string | null;
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

function renderSources(input: unknown): readonly DevRenderSourceVersion[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) {
    throw new TypeError("Canonical Media DEV_ONLY render sources are invalid.");
  }
  return input.map((raw) => {
    const source = record(raw, "render source");
    const result: DevRenderSourceVersion = {
      clipId: text(source.clipId, "render source clip id", 128),
      trackId: text(source.trackId, "render source track id", 128),
      artifactId: text(source.artifactId, "render source artifact id", 128),
      artifactVersionId: text(source.artifactVersionId, "render source artifact version", 384),
      ...(typeof source.trackKind === "string" ? { trackKind: text(source.trackKind, "render source track kind", 64) } : {}),
      ...(typeof source.sha256 === "string" ? { sha256: text(source.sha256, "render source sha256", 64) } : {}),
      ...(typeof source.normalizedFrameSha256 === "string"
        ? { normalizedFrameSha256: text(source.normalizedFrameSha256, "normalized frame sha256", 64) } : {}),
      ...(source.startFrame === undefined ? {} : { startFrame: positiveInt(source.startFrame, "render source start frame") }),
      ...(source.endFrameExclusive === undefined ? {} : { endFrameExclusive: positiveInt(source.endFrameExclusive, "render source end frame") }),
    };
    if (!OPAQUE_ID.test(result.clipId) || !OPAQUE_ID.test(result.trackId) || !OPAQUE_ID.test(result.artifactId)
      || result.artifactVersionId === "") {
      throw new TypeError("Canonical Media DEV_ONLY render source lacks an exact artifact version.");
    }
    return result;
  });
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
  const artifactVersionId = text(artifact.artifactVersionId, "render artifact version", 384);
  const artifactPath = text(artifact.artifactPath, "render artifact path", 512);
  if (renderId !== artifactId || !OPAQUE_ID.test(artifactId) || !SHA256.test(sha256)
    || artifactVersionId !== `sha256:${sha256}`
    || artifactPath !== `/api/v1/artifacts/${artifactId}`
    || !Object.values(RENDER_CONTENT_TYPES).includes(contentType)
    || !Number.isSafeInteger(artifact.sizeBytes) || (artifact.sizeBytes as number) < 1
    || (expectedRenderId !== undefined && renderId !== expectedRenderId)) {
    throw new TypeError("Canonical Media DEV_ONLY render artifact identity is invalid.");
  }
  const lineage = record(value.lineage, "render lineage");
  const sources = renderSources(lineage.sources);
  const revisionId = text(lineage.revisionId, "render lineage revisionId", 128);
  const timelineId = text(lineage.timelineId, "render lineage timelineId", 128);
  const timelineSemanticVersionId = text(lineage.timelineSemanticVersionId, "render lineage timelineSemanticVersionId", 128);
  const requestId = text(lineage.requestId, "render lineage requestId", 128);
  const engine = text(lineage.engine, "render lineage engine", 160);
  const format = lineage.format === "gif" || lineage.format === "mp4" ? lineage.format : null;
  const width = positiveInt(lineage.width, "render lineage width");
  const height = positiveInt(lineage.height, "render lineage height");
  const framesPerSecond = positiveInt(lineage.framesPerSecond, "render lineage framesPerSecond");
  const frameCount = positiveInt(lineage.frameCount, "render lineage frameCount");
  if (lineage.scope !== "DEV_ONLY" || lineage.projectId !== projectId
    || format === null || contentType !== RENDER_CONTENT_TYPES[format]
    || width < 1 || height < 1 || framesPerSecond < 1 || frameCount < 1
    || (expected.revisionId !== undefined && revisionId !== expected.revisionId)
    || (expected.timelineId !== undefined && timelineId !== expected.timelineId)
    || (expected.requestId !== undefined && requestId !== expected.requestId)
    || (expected.width !== undefined && width !== expected.width)
    || (expected.height !== undefined && height !== expected.height)
    || (expected.framesPerSecond !== undefined && framesPerSecond !== expected.framesPerSecond)
    || (expected.format !== undefined && format !== expected.format)) {
    throw new TypeError("Canonical Media DEV_ONLY render lineage does not match the requested render.");
  }
  const summary: DevProjectRenderLineage = {
    scope: "DEV_ONLY",
    projectId, revisionId, timelineId,
    format, width, height,
    framesPerSecond, frameCount,
    sourceCount: sources.length, sources,
    timelineSemanticVersionId,
    requestId,
    engine,
  };
  return {
    scope: "DEV_ONLY",
    renderId,
    artifact: { artifactId, artifactVersionId, sha256, contentType, sizeBytes: artifact.sizeBytes as number, artifactPath },
    replayed: value.replayed,
    lineage: summary,
  };
}

function parseExport(input: unknown, expected: Partial<DevExportRequest>, httpStatus: number, createRoute: boolean): DevExportResult {
  const value = record(input, "export result");
  // The host (J-22) also reports the destination ack observation; those four keys are all-or-none so a
  // host that predates them and a current host are both accepted, and no other key ever is.
  const ACK_KEYS = ["ackState", "failure", "destinationReceivedBytes", "observedAt"] as const;
  const withAck = ACK_KEYS.every((key) => Object.hasOwn(value, key));
  exactKeys(value, ["requestId", "artifactId", "artifactVersionId", "artifactDigest", "destinationId", "status",
    "acknowledgedBytes", "destinationConfirmed", "destinationReceiptRef", "replayed", "scope",
    ...(withAck ? ACK_KEYS : [])], "export result");
  if (withAck) {
    if (!["DELIVERED", "NOT_DELIVERED", "UNKNOWN"].includes(value.ackState as string)
      || (value.failure !== null && typeof value.failure !== "string")
      || (value.destinationReceivedBytes !== null && positiveInt(value.destinationReceivedBytes, "export received bytes") < 0)
      || (value.observedAt !== null && typeof value.observedAt !== "string")) {
      throw new TypeError("Canonical Media DEV_ONLY export acknowledgement observation is invalid.");
    }
  }
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
    scope: "DEV_ONLY",
    requestId: text(value.requestId, "export request id", 128),
    artifactId: text(value.artifactId, "export artifact id"),
    artifactVersionId: text(value.artifactVersionId, "export artifact version"),
    artifactDigest: text(value.artifactDigest, "export artifact digest"),
    destinationId: text(value.destinationId, "export destination"),
    status, acknowledgedBytes: positiveInt(value.acknowledgedBytes, "export acknowledged bytes"),
    destinationConfirmed: confirmed, destinationReceiptRef: receipt, replayed: value.replayed, httpStatus,
    ...(withAck ? { ackState: value.ackState as string, failure: value.failure as string | null,
      destinationReceivedBytes: value.destinationReceivedBytes as number | null, observedAt: value.observedAt as string | null } : {}),
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

  /** Reads the exact registered render version, then verifies its byte count, MIME type and SHA-256. */
  public async readRenderContent(render: DevRenderResult, maxBytes = 64 * 1024 * 1024,
    signal?: AbortSignal): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 512 * 1024 * 1024) {
      throw new TypeError("Render content maxBytes must be within [1, 536870912].");
    }
    const artifact = render?.artifact;
    if (!artifact || !OPAQUE_ID.test(artifact.artifactId) || artifact.artifactVersionId !== `sha256:${artifact.sha256}`
      || !SHA256.test(artifact.sha256) || !Number.isSafeInteger(artifact.sizeBytes) || artifact.sizeBytes < 1
      || !Object.values(RENDER_CONTENT_TYPES).includes(artifact.contentType)) {
      throw new TypeError("Canonical Media DEV_ONLY render artifact identity is invalid.");
    }
    if (artifact.sizeBytes > maxBytes) {
      throw new TypeError(`Render artifact is ${artifact.sizeBytes} bytes, over the ${maxBytes}-byte client limit.`);
    }
    const path = `/dev/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/content`;
    const response = await this.transport.fetchRaw(path, {
      method: "GET",
      headers: { Accept: artifact.contentType, "If-Match": artifact.artifactVersionId },
    }, signal);
    if (!response.ok) throw await this.transport.errorFromResponse(response);
    if (response.status !== 200) throw new TypeError(`Canonical Media DEV_ONLY content returned unexpected status ${response.status}.`);
    const responseType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (responseType !== artifact.contentType.toLowerCase()) {
      await response.body?.cancel().catch(() => undefined);
      throw new TypeError("Canonical Media DEV_ONLY render content type does not match the registered artifact.");
    }
    const declaredLength = response.headers.get("Content-Length");
    if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) !== artifact.sizeBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw new TypeError("Canonical Media DEV_ONLY render content length does not match the registered artifact.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("Canonical Media DEV_ONLY render content body is unavailable.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes || total > artifact.sizeBytes) {
          await reader.cancel().catch(() => undefined);
          throw new TypeError("Canonical Media DEV_ONLY render content exceeds its registered size.");
        }
        chunks.push(value);
      }
    } catch (failure) {
      if (failure instanceof TypeError) throw failure;
      throw new TypeError("Canonical Media DEV_ONLY render content stream ended unexpectedly.");
    }
    if (total !== artifact.sizeBytes) throw new TypeError("Canonical Media DEV_ONLY render content size does not match the registered artifact.");
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    const actualSha = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actualSha !== artifact.sha256) throw new TypeError("Canonical Media DEV_ONLY render content digest does not match the registered artifact.");
    return bytes;
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
