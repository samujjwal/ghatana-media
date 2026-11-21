/** Public loopback-only client for registered DEV_ONLY creative outputs. */
import {
  MediaHttpTransport,
  safeIdentityHeader,
  type MediaTransportConfig,
} from "./http-core.js";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const OUTPUT_CONTENT_TYPES = new Set(["audio/wav", "application/json", "model/gltf-binary"]);
const OUTPUT_KIND_CONTENT_TYPES = {
  AUDIO_REPAIR_CANDIDATE: "audio/wav",
  SIMULATED_OUTPUT_NOT_MEASUREMENT: "application/json",
  SPATIAL_GLB_EXPORT: "model/gltf-binary",
} as const;
const DEFAULT_MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const ABSOLUTE_MAX_CONTENT_BYTES = 512 * 1024 * 1024;

export type DevCreativeOutputKind = keyof typeof OUTPUT_KIND_CONTENT_TYPES;

export interface DevCreativeOutputSourceVersion {
  readonly tenantId?: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly sha256: string;
  readonly contentType?: string;
}

export type DevCreativeOutputLineage = Readonly<Record<string, unknown>> & {
  readonly kind: DevCreativeOutputKind;
  readonly engine: string;
  readonly requestId: string;
  readonly source?: DevCreativeOutputSourceVersion;
  readonly sources?: readonly DevCreativeOutputSourceVersion[];
  readonly sourceProjectRevisionRef?: string | null;
};

export interface DevCreativeOutputArtifact {
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly artifactPath: string;
}

export interface DevCreativeOutput extends Readonly<Record<string, unknown>> {
  readonly schema: "media.dev.creative-output.v1";
  readonly outputId: string;
  readonly artifact: DevCreativeOutputArtifact;
  readonly lineage: DevCreativeOutputLineage;
  readonly replayed: boolean;
  readonly scope: "DEV_ONLY";
  readonly note: string;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Canonical Media DEV_ONLY creative output ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`Canonical Media DEV_ONLY creative output ${field} is invalid.`);
  }
  return value;
}

function parseSourceVersion(input: unknown, field: string): DevCreativeOutputSourceVersion {
  const value = record(input, field);
  const artifactId = text(value.artifactId, `${field}.artifactId`, 128);
  const artifactVersionId = text(value.artifactVersionId, `${field}.artifactVersionId`, 71);
  const sha256 = text(value.sha256, `${field}.sha256`, 64);
  const tenantId = value.tenantId === undefined ? undefined : text(value.tenantId, `${field}.tenantId`, 255);
  const contentType = value.contentType === undefined ? undefined : text(value.contentType, `${field}.contentType`, 128);
  if (!OPAQUE_ID.test(artifactId) || !SHA256.test(sha256) || artifactVersionId !== `sha256:${sha256}`) {
    throw new TypeError(`Canonical Media DEV_ONLY creative output ${field} does not bind an exact artifact version and digest.`);
  }
  return {
    ...(tenantId === undefined ? {} : { tenantId }),
    artifactId,
    artifactVersionId,
    sha256,
    ...(contentType === undefined ? {} : { contentType }),
  };
}

function parseLineage(input: unknown, contentType: string): DevCreativeOutputLineage {
  const value = record(input, "lineage");
  const kind = text(value.kind, "lineage.kind", 64);
  const expectedType = OUTPUT_KIND_CONTENT_TYPES[kind as DevCreativeOutputKind];
  const engine = text(value.engine, "lineage.engine", 160);
  const requestId = text(value.requestId, "lineage.requestId", 128);
  if (expectedType === undefined || expectedType !== contentType || !OPAQUE_ID.test(requestId)) {
    throw new TypeError("Canonical Media DEV_ONLY creative output kind, content type, or request identity is invalid.");
  }

  if (kind === "AUDIO_REPAIR_CANDIDATE") {
    return { ...value, kind, engine, requestId, source: parseSourceVersion(value.source, "lineage.source") };
  }
  if (kind === "SPATIAL_GLB_EXPORT") {
    if (!Array.isArray(value.sources) || value.sources.length < 1 || value.sources.length > 64) {
      throw new TypeError("Canonical Media DEV_ONLY creative output spatial lineage requires 1..64 source versions.");
    }
    const sources = value.sources.map((source, index) => parseSourceVersion(source, `lineage.sources[${index}]`));
    const revisionRef = value.sourceProjectRevisionRef;
    if (revisionRef !== undefined && revisionRef !== null
      && (typeof revisionRef !== "string" || revisionRef.length === 0 || revisionRef.length > 255)) {
      throw new TypeError("Canonical Media DEV_ONLY creative output source project revision is invalid.");
    }
    return { ...value, kind, engine, requestId, sources } as DevCreativeOutputLineage;
  }
  return { ...value, kind, engine, requestId } as DevCreativeOutputLineage;
}

function parseOutput(input: unknown, expectedId?: string): DevCreativeOutput {
  const value = record(input, "response");
  const schema = value.schema;
  const outputId = text(value.outputId, "outputId", 128);
  const artifactValue = record(value.artifact, "artifact");
  const artifactId = text(artifactValue.artifactId, "artifact.artifactId", 128);
  const artifactVersionId = text(artifactValue.artifactVersionId, "artifact.artifactVersionId", 71);
  const contentType = text(artifactValue.contentType, "artifact.contentType", 128).toLowerCase();
  const sizeBytes = artifactValue.sizeBytes;
  const sha256 = text(artifactValue.sha256, "artifact.sha256", 64);
  const artifactPath = text(artifactValue.artifactPath, "artifact.artifactPath", 512);
  const lineage = parseLineage(value.lineage, contentType);

  if (schema !== "media.dev.creative-output.v1" || !OPAQUE_ID.test(outputId)
    || (expectedId !== undefined && outputId !== expectedId) || artifactId !== outputId
    || !OPAQUE_ID.test(artifactId) || !SHA256.test(sha256)
    || artifactVersionId !== `sha256:${sha256}` || !OUTPUT_CONTENT_TYPES.has(contentType)
    || !Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 1
    || artifactPath !== `/api/v1/artifacts/${artifactId}` || typeof value.replayed !== "boolean"
    || value.scope !== "DEV_ONLY") {
    throw new TypeError("Canonical Media DEV_ONLY creative output identity or artifact metadata is invalid.");
  }

  return {
    schema,
    outputId,
    artifact: { artifactId, artifactVersionId, contentType, sizeBytes: sizeBytes as number, sha256, artifactPath },
    lineage,
    replayed: value.replayed,
    scope: "DEV_ONLY",
    note: text(value.note, "note", 2_000),
  };
}

/** Loopback-only client; creative-output operations remain DEV_ONLY and outside the production client contract. */
export class MediaDevOnlyCreativeOutputClient {
  private readonly transport: MediaHttpTransport;

  public constructor(config: MediaTransportConfig) {
    const endpoint = new URL(config.baseUrl);
    if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(endpoint.hostname.toLowerCase())) {
      throw new Error("DEV_ONLY creative outputs require a loopback Media endpoint.");
    }
    this.transport = new MediaHttpTransport(config);
    const principal = Object.entries(this.transport.callerDefaultHeaders())
      .find(([name]) => name.toLowerCase() === "x-principal-id")?.[1];
    if (!safeIdentityHeader("principalId", principal)) {
      throw new Error("DEV_ONLY creative outputs require the caller's X-Principal-Id scope header.");
    }
  }

  /** Reads the immutable creative-output record from its owner-scoped DEV_ONLY route. */
  public async getCreativeOutput(outputId: string, signal?: AbortSignal): Promise<DevCreativeOutput> {
    if (!OPAQUE_ID.test(outputId)) throw new Error("creative output id must be a bounded opaque identity.");
    return this.transport.request(
      "GET",
      `/dev/v1/creative-outputs/${encodeURIComponent(outputId)}`,
      undefined,
      { parse: (input) => parseOutput(input, outputId) },
      signal,
    );
  }

  /** Reads only the returned immutable version, enforcing the registered MIME type, size and SHA-256. */
  public async readContent(
    output: DevCreativeOutput,
    maxBytes = DEFAULT_MAX_CONTENT_BYTES,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ABSOLUTE_MAX_CONTENT_BYTES) {
      throw new TypeError(`creative output maxBytes must be within [1, ${ABSOLUTE_MAX_CONTENT_BYTES}].`);
    }
    const checked = parseOutput(output, output?.outputId);
    const artifact = checked.artifact;
    if (artifact.sizeBytes > maxBytes) {
      throw new TypeError(`Creative output is ${artifact.sizeBytes} bytes, over the ${maxBytes}-byte client limit.`);
    }
    const path = `/dev/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/content`;
    const response = await this.transport.fetchRaw(path, {
      method: "GET",
      headers: { Accept: artifact.contentType, "If-Match": artifact.artifactVersionId },
    }, signal);
    if (!response.ok) throw await this.transport.errorFromResponse(response);
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new TypeError(`Canonical Media DEV_ONLY creative content returned unexpected status ${response.status}.`);
    }
    const responseType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (responseType !== artifact.contentType) {
      await response.body?.cancel().catch(() => undefined);
      throw new TypeError("Canonical Media DEV_ONLY creative content type does not match the registered artifact.");
    }
    const declaredLength = response.headers.get("Content-Length");
    if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) !== artifact.sizeBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw new TypeError("Canonical Media DEV_ONLY creative content length does not match the registered artifact.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("Canonical Media DEV_ONLY creative content body is unavailable.");

    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes || total > artifact.sizeBytes) {
          await reader.cancel().catch(() => undefined);
          throw new TypeError("Canonical Media DEV_ONLY creative content exceeds its registered size.");
        }
        chunks.push(value);
      }
    } catch (failure) {
      if (failure instanceof TypeError) throw failure;
      throw new TypeError("Canonical Media DEV_ONLY creative content stream ended unexpectedly.");
    }
    if (total !== artifact.sizeBytes) {
      throw new TypeError("Canonical Media DEV_ONLY creative content size does not match the registered artifact.");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    const actualSha = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actualSha !== artifact.sha256) {
      throw new TypeError("Canonical Media DEV_ONLY creative content digest does not match the registered artifact.");
    }
    return bytes;
  }
}
