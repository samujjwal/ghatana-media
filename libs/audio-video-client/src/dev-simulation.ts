/** Public loopback-only client for deterministic DEV_ONLY simulation results and PNG plots. */
import {
  MediaHttpTransport,
  safeIdentityHeader,
  type MediaTransportConfig,
} from "./http-core.js";

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;
const DEFAULT_MAX_CONTENT_BYTES = 64 * 1024 * 1024;
const ABSOLUTE_MAX_CONTENT_BYTES = 256 * 1024 * 1024;
const EVIDENCE_CLASS = "SIMULATED_MODEL_OUTPUT_NOT_MEASUREMENT_EVIDENCE";

export interface DevSimulationArtifact {
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly contentType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
  readonly artifactPath: string;
}

export interface DevSimulationLineage extends Readonly<Record<string, unknown>> {
  readonly simulationSchema: "media.dev.simulation.v1";
  readonly scope: "DEV_ONLY";
  readonly kind: "SIMULATION_RESULT";
  readonly requestId: string;
  readonly scenarioSha256: string;
  readonly outcome: "COMPLETED" | "ABSTAINED";
  readonly evidenceClass: typeof EVIDENCE_CLASS;
  readonly productionEligible: false;
  readonly inputs: readonly unknown[];
}

export interface DevSimulation extends Readonly<Record<string, unknown>> {
  readonly schema: "media.dev.simulation.v1";
  readonly scope: "DEV_ONLY";
  readonly simulationId: string;
  readonly outcome: "COMPLETED" | "ABSTAINED";
  readonly result: Readonly<Record<string, unknown>>;
  readonly resultArtifact: DevSimulationArtifact;
  readonly plotArtifact?: DevSimulationArtifact;
  readonly videoArtifact?: DevSimulationArtifact;
  readonly lineage: DevSimulationLineage;
  readonly replayed: boolean;
  readonly note: string;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`Canonical Media DEV_ONLY simulation ${field} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, field: string, max = 512): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new TypeError(`Canonical Media DEV_ONLY simulation ${field} is invalid.`);
  }
  return value;
}

function parseArtifact(input: unknown, field: string, contentType: string): DevSimulationArtifact {
  const value = record(input, field);
  const artifactId = text(value.artifactId, `${field}.artifactId`, 128);
  const artifactVersionId = text(value.artifactVersionId, `${field}.artifactVersionId`, 71);
  const actualType = text(value.contentType, `${field}.contentType`, 128).toLowerCase();
  const sizeBytes = value.sizeBytes;
  const sha256 = text(value.sha256, `${field}.sha256`, 64);
  const artifactPath = text(value.artifactPath, `${field}.artifactPath`, 512);
  if (!OPAQUE_ID.test(artifactId) || !SHA256.test(sha256) || artifactVersionId !== `sha256:${sha256}`
    || actualType !== contentType || !Number.isSafeInteger(sizeBytes) || (sizeBytes as number) < 1
    || artifactPath !== `/api/v1/artifacts/${artifactId}`) {
    throw new TypeError(`Canonical Media DEV_ONLY simulation ${field} does not identify its exact ${contentType} version.`);
  }
  return { artifactId, artifactVersionId, contentType: actualType, sizeBytes: sizeBytes as number, sha256, artifactPath };
}

function parseSimulation(input: unknown, expectedId?: string): DevSimulation {
  const value = record(input, "response");
  const simulationId = text(value.simulationId, "simulationId", 128);
  const outcome = value.outcome;
  const result = record(value.result, "result");
  const requestId = text(result.requestId, "result.requestId", 128);
  const scenarioSha256 = text(result.scenarioSha256, "result.scenarioSha256", 64);
  const resultArtifact = parseArtifact(value.resultArtifact, "resultArtifact", "application/json");
  const lineageValue = record(value.lineage, "lineage");
  const inputs = lineageValue.inputs;
  const lineage = lineageValue as DevSimulationLineage;

  if (value.schema !== "media.dev.simulation.v1" || value.scope !== "DEV_ONLY"
    || !OPAQUE_ID.test(simulationId) || (expectedId !== undefined && simulationId !== expectedId)
    || (outcome !== "COMPLETED" && outcome !== "ABSTAINED")
    || result.schema !== "media.dev.simulation-result.v1" || result.scope !== "DEV_ONLY"
    || result.outcome !== outcome || !OPAQUE_ID.test(requestId) || !SHA256.test(scenarioSha256)
    || result.productionEligible !== false || resultArtifact.artifactId !== simulationId
    || lineageValue.simulationSchema !== "media.dev.simulation.v1" || lineageValue.scope !== "DEV_ONLY"
    || lineageValue.kind !== "SIMULATION_RESULT" || lineageValue.requestId !== requestId
    || lineageValue.scenarioSha256 !== scenarioSha256 || lineageValue.outcome !== outcome
    || lineageValue.evidenceClass !== EVIDENCE_CLASS || lineageValue.productionEligible !== false
    || !Array.isArray(inputs) || inputs.length < 1 || inputs.length > 128
    || typeof value.replayed !== "boolean") {
    throw new TypeError("Canonical Media DEV_ONLY simulation identity, lineage, or evidence scope is invalid.");
  }

  const plot = value.plotArtifact === undefined
    ? undefined : parseArtifact(value.plotArtifact, "plotArtifact", "image/png");
  const video = value.videoArtifact === undefined
    ? undefined : parseArtifact(value.videoArtifact, "videoArtifact", "video/mp4");
  const siblings = lineageValue.siblings === undefined ? undefined : record(lineageValue.siblings, "lineage.siblings");
  const plotRef = siblings?.plot === undefined ? undefined : record(siblings.plot, "lineage.siblings.plot");
  const videoRef = siblings?.video === undefined ? undefined : record(siblings.video, "lineage.siblings.video");
  if ((plot === undefined && plotRef !== undefined)
    || (plot !== undefined && (outcome !== "COMPLETED" || plotRef === undefined
      || plotRef.artifactId !== plot.artifactId || plotRef.artifactVersionId !== plot.artifactVersionId
      || plotRef.sha256 !== plot.sha256))
    || (video === undefined && videoRef !== undefined)
    || (video !== undefined && (outcome !== "COMPLETED" || videoRef === undefined
      || videoRef.artifactId !== video.artifactId || videoRef.artifactVersionId !== video.artifactVersionId
      || videoRef.sha256 !== video.sha256))) {
    throw new TypeError("Canonical Media DEV_ONLY simulation media outputs are not bound to their exact result sibling versions.");
  }

  return {
    schema: "media.dev.simulation.v1",
    scope: "DEV_ONLY",
    simulationId,
    outcome,
    result,
    resultArtifact,
    ...(plot === undefined ? {} : { plotArtifact: plot }),
    ...(video === undefined ? {} : { videoArtifact: video }),
    lineage,
    replayed: value.replayed,
    note: text(value.note, "note", 2_000),
  };
}

/**
 * Authenticated SDK access to deterministic DEV_ONLY simulation output. The PNG reader only returns a plot whose
 * exact immutable version is bound as a sibling of the persisted result; the data remains simulated, not measurement.
 */
export class MediaDevOnlySimulationClient {
  private readonly transport: MediaHttpTransport;

  public constructor(config: MediaTransportConfig) {
    const endpoint = new URL(config.baseUrl);
    if (!new Set(["localhost", "127.0.0.1", "[::1]"]).has(endpoint.hostname.toLowerCase())) {
      throw new Error("DEV_ONLY simulations require a loopback Media endpoint.");
    }
    this.transport = new MediaHttpTransport(config);
    const principal = Object.entries(this.transport.callerDefaultHeaders())
      .find(([name]) => name.toLowerCase() === "x-principal-id")?.[1];
    if (!safeIdentityHeader("principalId", principal)) {
      throw new Error("DEV_ONLY simulations require the caller's X-Principal-Id scope header.");
    }
  }

  /** Reads the owner-scoped durable simulation record by its result artifact identity. */
  public getSimulation(simulationId: string, signal?: AbortSignal): Promise<DevSimulation> {
    if (!OPAQUE_ID.test(simulationId)) throw new Error("simulationId must be a bounded opaque identity.");
    return this.transport.request(
      "GET",
      `/dev/v1/simulations/${encodeURIComponent(simulationId)}`,
      undefined,
      { parse: (input) => parseSimulation(input, simulationId) },
      signal,
    );
  }

  /** Reads and verifies the exact registered PNG plot version. */
  public async readPlotContent(
    simulation: DevSimulation,
    maxBytes = DEFAULT_MAX_CONTENT_BYTES,
    signal?: AbortSignal,
  ): Promise<Uint8Array> {
    if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > ABSOLUTE_MAX_CONTENT_BYTES) {
      throw new TypeError(`simulation plot maxBytes must be within [1, ${ABSOLUTE_MAX_CONTENT_BYTES}].`);
    }
    const checked = parseSimulation(simulation, simulation?.simulationId);
    const artifact = checked.plotArtifact;
    if (!artifact) throw new TypeError("Canonical Media DEV_ONLY simulation has no registered PNG plot.");
    if (artifact.sizeBytes > maxBytes) {
      throw new TypeError(`Simulation plot is ${artifact.sizeBytes} bytes, over the ${maxBytes}-byte client limit.`);
    }
    const path = `/dev/v1/artifacts/${encodeURIComponent(artifact.artifactId)}/content`;
    const response = await this.transport.fetchRaw(path, {
      method: "GET",
      headers: { Accept: "image/png", "If-Match": artifact.artifactVersionId },
    }, signal);
    if (!response.ok) throw await this.transport.errorFromResponse(response);
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => undefined);
      throw new TypeError(`Canonical Media DEV_ONLY simulation plot returned unexpected status ${response.status}.`);
    }
    const responseType = response.headers.get("Content-Type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (responseType !== "image/png") {
      await response.body?.cancel().catch(() => undefined);
      throw new TypeError("Canonical Media DEV_ONLY simulation plot MIME type does not match its registered artifact.");
    }
    const declaredLength = response.headers.get("Content-Length");
    if (declaredLength !== null && (!/^\d+$/u.test(declaredLength) || Number(declaredLength) !== artifact.sizeBytes)) {
      await response.body?.cancel().catch(() => undefined);
      throw new TypeError("Canonical Media DEV_ONLY simulation plot length does not match its registered artifact.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new TypeError("Canonical Media DEV_ONLY simulation plot body is unavailable.");
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes || total > artifact.sizeBytes) {
          await reader.cancel().catch(() => undefined);
          throw new TypeError("Canonical Media DEV_ONLY simulation plot exceeds its registered size.");
        }
        chunks.push(value);
      }
    } catch (failure) {
      if (failure instanceof TypeError) throw failure;
      throw new TypeError("Canonical Media DEV_ONLY simulation plot stream ended unexpectedly.");
    }
    if (total !== artifact.sizeBytes) {
      throw new TypeError("Canonical Media DEV_ONLY simulation plot size does not match its registered artifact.");
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    const digest = new Uint8Array(await globalThis.crypto.subtle.digest("SHA-256", bytes));
    const actualSha = Array.from(digest, (byte) => byte.toString(16).padStart(2, "0")).join("");
    if (actualSha !== artifact.sha256) {
      throw new TypeError("Canonical Media DEV_ONLY simulation plot digest does not match its registered artifact.");
    }
    return bytes;
  }
}
