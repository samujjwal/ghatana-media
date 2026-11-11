/**
 * Browser/Node client for the Media DEV_ONLY project and timeline preview.
 * This transport is deliberately separate from canonical Media operations.
 */

export type DevProjectErrorCode =
  | "INVALID_CONFIGURATION"
  | "INVALID_REQUEST"
  | "INVALID_RESPONSE"
  | "TRANSPORT_ERROR"
  | "OUTCOME_UNKNOWN"
  | string;

export class MediaDevProjectTimelineError extends Error {
  constructor(
    readonly code: DevProjectErrorCode,
    readonly status: number,
    message: string,
    readonly details?: Readonly<Record<string, unknown>>,
  ) {
    super(message);
    this.name = "MediaDevProjectTimelineError";
  }
}

export interface DevProjectTimelineClientOptions {
  /** Absolute loopback host URL. Bearer credentials are never sent to another host. */
  readonly baseUrl: string;
  /** Raw short-lived DEV_ONLY JWT or a callback that reads it from host memory. */
  readonly bearerToken: string | (() => string);
  readonly fetch?: typeof fetch;
}

export interface DevProjectContext {
  readonly tenantId: string;
  readonly principalId: string;
  readonly selectedAuthorizedWorkspaceId: string;
  readonly workspaceName: string;
  readonly authority: string;
  readonly capabilities: DevProjectCapabilities;
  readonly scope: "DEV_ONLY";
}

/** Capabilities projected by the authenticated local Media host from the verified token. */
export interface DevProjectCapabilities {
  readonly artifactUpload: boolean;
  readonly artifactRead: boolean;
}

/** Principal scoped artifact locator exposed for local clip-source selection. */
export interface DevOwnedArtifact {
  readonly tenantId: string;
  readonly principalId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly fileName: string;
  readonly contentType: string;
  readonly sha256: string;
}

/** Runtime transfer bound projected from the authenticated DEV_ONLY Media host. */
export interface DevArtifactUploadPolicy {
  readonly schemaVersion: "media.dev.artifact-upload-policy.v1";
  readonly scope: "DEV_ONLY";
  readonly maxChunkBytes: number;
}

export interface DevProject {
  readonly tenantId: string;
  readonly projectId: string;
  readonly workspaceId: string;
  readonly ownerPrincipalId: string;
  readonly title: string;
  readonly headRevisionId: string;
}

export interface DevTimelineGraph {
  readonly timelineId: string;
  readonly scenes: readonly Readonly<Record<string, unknown>>[];
  readonly tracks: readonly Readonly<Record<string, unknown>>[];
  readonly clips: readonly DevTimelineClip[];
}

/** Lossless decimal-string wire representation of a signed-64-bit rational clock coordinate. */
export interface DevRationalTime {
  readonly ticks: string;
  readonly rateNumerator: string;
  readonly rateDenominator: string;
  readonly clock: "SOURCE_PRESENTATION" | "STORY";
}

export interface DevTimelineSourceVersion {
  readonly artifactId: string;
  readonly artifactVersionId: string;
}

export interface DevTimelineClip {
  readonly clipId: string;
  readonly sceneId: string;
  readonly trackId: string;
  readonly source: DevTimelineSourceVersion;
  readonly sourceIn: DevRationalTime;
  readonly sourceOut: DevRationalTime;
  readonly storyStart: DevRationalTime;
  readonly storyDuration: DevRationalTime;
}

export interface DevTimelineSnapshot {
  readonly semanticVersionId: string;
  readonly graph: DevTimelineGraph;
}

export interface DevProjectRevision {
  readonly tenantId: string;
  readonly projectId: string;
  readonly revisionId: string;
  readonly parentRevisionId: string | null;
  readonly timelines: readonly DevTimelineSnapshot[];
}

export interface DevProjectCreated {
  readonly project: DevProject;
  readonly initialRevision: DevProjectRevision;
  readonly createdNow: boolean;
  readonly scope: "DEV_ONLY";
}

export interface DevProjectRead {
  readonly project: DevProject;
  readonly currentRevision: DevProjectRevision;
  readonly scope: "DEV_ONLY";
}

export interface DevRevisionRead {
  readonly revision: DevProjectRevision;
  readonly scope: "DEV_ONLY";
}

export interface CreateDevProjectRequest {
  readonly selectedAuthorizedWorkspaceId: string;
  readonly title: string;
  readonly requestId: string;
}

export interface CreateDevTimelineRequest {
  readonly expectedHeadRevisionId: string;
  readonly timelineId: string;
}

export type DevTimelineTrackKind = "VIDEO" | "AUDIO" | "CAPTION" | "OVERLAY";

export type DevTimelineEdit =
  | { readonly type: "addScene"; readonly sceneId: string; readonly order: number }
  | { readonly type: "removeScene"; readonly sceneId: string }
  | { readonly type: "addTrack"; readonly trackId: string; readonly sceneId: string;
      readonly trackKind: DevTimelineTrackKind; readonly order: number }
  | { readonly type: "removeTrack"; readonly trackId: string }
  | { readonly type: "putClip"; readonly clip: DevTimelineClip }
  | { readonly type: "removeClip"; readonly clipId: string };

export interface EditDevTimelineRequest {
  readonly expectedHeadRevisionId: string;
  readonly edits: readonly DevTimelineEdit[];
}

export interface RestoreDevProjectRevisionRequest {
  readonly expectedHeadRevisionId: string;
  readonly targetRevisionId: string;
}

type JsonRecord = Record<string, unknown>;
type FetchLike = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;
const REQUEST_ID = /^[A-Za-z0-9][A-Za-z0-9._~:-]{0,127}$/u;

/** A small explicit client for the loopback-only, noncanonical DEV_ONLY endpoints. */
export class MediaDevProjectTimelineClient {
  private readonly origin: string;
  private readonly fetcher: FetchLike;

  constructor(private readonly options: DevProjectTimelineClientOptions) {
    this.origin = validateLoopbackOrigin(options.baseUrl);
    this.fetcher = options.fetch ?? globalThis.fetch;
    if (typeof this.fetcher !== "function") {
      throw new MediaDevProjectTimelineError("INVALID_CONFIGURATION", 0, "A Fetch implementation is required.");
    }
  }

  async getContext(signal?: AbortSignal): Promise<DevProjectContext> {
    const value = await this.request("GET", "/dev/v1/context", undefined, signal, false);
    const context = record(value, "context response");
    const capabilities = record(context.capabilities, "context capabilities");
    if (context.scope !== "DEV_ONLY"
      || !isNonEmpty(context.tenantId)
      || !isNonEmpty(context.principalId)
      || !isNonEmpty(context.selectedAuthorizedWorkspaceId)
      || !isNonEmpty(context.workspaceName)
      || !isNonEmpty(context.authority)
      || typeof capabilities.artifactUpload !== "boolean"
      || typeof capabilities.artifactRead !== "boolean") {
      throw invalidResponse("DEV_ONLY context response is incomplete or outside its declared scope.");
    }
    return context as unknown as DevProjectContext;
  }

  async getArtifactUploadPolicy(signal?: AbortSignal): Promise<DevArtifactUploadPolicy> {
    const value = await this.request("GET", "/dev/v1/artifact-upload-policy", undefined, signal, false);
    const policy = record(value, "artifact upload policy response");
    if (Object.keys(policy).length !== 3
      || policy.schemaVersion !== "media.dev.artifact-upload-policy.v1"
      || policy.scope !== "DEV_ONLY"
      || !Number.isSafeInteger(policy.maxChunkBytes)
      || (policy.maxChunkBytes as number) < 1
      || (policy.maxChunkBytes as number) > 32 * 1024 * 1024) {
      throw invalidResponse("Artifact upload policy is malformed or outside its declared DEV_ONLY scope.");
    }
    return policy as unknown as DevArtifactUploadPolicy;
  }

  async getOwnedArtifact(artifactId: string, signal?: AbortSignal): Promise<DevOwnedArtifact> {
    const id = validateOpaqueId(artifactId, "artifactId");
    const context = await this.getContext(signal);
    if (!context.capabilities.artifactRead) {
      throw new MediaDevProjectTimelineError(
        "ARTIFACT_READ_PERMISSION_REQUIRED", 403,
        "The verified DEV_ONLY identity does not have permission to inspect source artifacts.",
      );
    }
    const value = await this.request("GET", `/api/v1/artifacts/${id}`, undefined, signal, false);
    const artifact = record(value, "owned artifact response");
    if (artifact.tenantId !== context.tenantId || artifact.principalId !== context.principalId
      || artifact.artifactId !== artifactId || !isNonEmpty(artifact.fileName) || !isNonEmpty(artifact.contentType)
      || typeof artifact.sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(artifact.sha256)) {
      throw invalidResponse("Artifact response does not match the authenticated DEV_ONLY owner identity.");
    }
    return {
      tenantId: context.tenantId,
      principalId: context.principalId,
      artifactId,
      artifactVersionId: `sha256:${artifact.sha256}`,
      fileName: artifact.fileName,
      contentType: artifact.contentType,
      sha256: artifact.sha256,
    };
  }

  async createProject(request: CreateDevProjectRequest, signal?: AbortSignal): Promise<DevProjectCreated> {
    validateProjectRequest(request);
    const value = await this.request("POST", "/dev/v1/projects", request, signal, true, request.requestId);
    const result = record(value, "project creation response");
    const project = parseProject(result.project);
    const initialRevision = parseRevision(result.initialRevision);
    if (result.scope !== "DEV_ONLY" || typeof result.createdNow !== "boolean"
      || initialRevision.projectId !== project.projectId || initialRevision.tenantId !== project.tenantId
      || project.workspaceId !== request.selectedAuthorizedWorkspaceId || initialRevision.timelines.length !== 0) {
      throw invalidResponse("Project creation response does not match the requested DEV_ONLY workspace and empty initial revision.");
    }
    return result as unknown as DevProjectCreated;
  }

  async getProject(projectId: string, signal?: AbortSignal): Promise<DevProjectRead> {
    const value = await this.request("GET", `/dev/v1/projects/${validateOpaqueId(projectId, "projectId")}`, undefined, signal, false);
    const result = record(value, "project read response");
    const project = parseProject(result.project);
    const currentRevision = parseRevision(result.currentRevision);
    if (result.scope !== "DEV_ONLY" || project.projectId !== projectId || currentRevision.projectId !== project.projectId
      || currentRevision.tenantId !== project.tenantId || currentRevision.revisionId !== project.headRevisionId) {
      throw invalidResponse("Project read response does not match its current revision head.");
    }
    return result as unknown as DevProjectRead;
  }

  async createTimeline(projectId: string, request: CreateDevTimelineRequest, signal?: AbortSignal): Promise<DevRevisionRead> {
    const id = validateOpaqueId(projectId, "projectId");
    validateOpaqueId(request.expectedHeadRevisionId, "expectedHeadRevisionId");
    validateOpaqueId(request.timelineId, "timelineId");
    const value = await this.request("POST", `/dev/v1/projects/${id}/timelines`, request, signal, true);
    const result = record(value, "timeline creation response");
    const revision = parseRevision(result.revision);
    const matchingTimelines = revision.timelines.filter((timeline) => timeline.graph.timelineId === request.timelineId);
    if (result.scope !== "DEV_ONLY" || revision.projectId !== projectId
      || revision.parentRevisionId !== request.expectedHeadRevisionId || matchingTimelines.length !== 1
      || matchingTimelines[0]!.graph.scenes.length !== 0
      || matchingTimelines[0]!.graph.tracks.length !== 0
      || matchingTimelines[0]!.graph.clips.length !== 0) {
      throw invalidResponse("Timeline creation response does not match the requested project head and empty timeline graph.");
    }
    return result as unknown as DevRevisionRead;
  }

  async editTimeline(projectId: string, timelineId: string, request: EditDevTimelineRequest,
                     signal?: AbortSignal): Promise<DevRevisionRead> {
    const project = validateOpaqueId(projectId, "projectId");
    const timeline = validateOpaqueId(timelineId, "timelineId");
    validateOpaqueId(request.expectedHeadRevisionId, "expectedHeadRevisionId");
    validateTimelineEdits(request.edits);
    const value = await this.request("POST", `/dev/v1/projects/${project}/timelines/${timeline}/edits`,
      request, signal, true);
    const result = record(value, "timeline edit response");
    const revision = parseRevision(result.revision);
    const matchingTimelines = revision.timelines.filter((snapshot) => snapshot.graph.timelineId === timelineId);
    if (result.scope !== "DEV_ONLY" || revision.projectId !== projectId
      || revision.parentRevisionId !== request.expectedHeadRevisionId || matchingTimelines.length !== 1
      || revision.revisionId === request.expectedHeadRevisionId) {
      throw invalidResponse("Timeline edit response does not match the requested project head and timeline.");
    }
    const clips = matchingTimelines[0]!.graph.clips;
    const finalClipEdits = new Map<string, DevTimelineClip | null>();
    for (const edit of request.edits) {
      if (edit.type === "putClip") {
        finalClipEdits.set(edit.clip.clipId, edit.clip);
      } else if (edit.type === "removeClip") {
        finalClipEdits.set(edit.clipId, null);
      }
    }
    for (const [clipId, expected] of finalClipEdits) {
      const matches = clips.filter((clip) => clip.clipId === clipId);
      if (expected === null ? matches.length !== 0
        : matches.length !== 1 || !sameClip(matches[0]!, expected)) {
        throw invalidResponse("Timeline edit response does not preserve the requested clip operation identity and exact source/time values.");
      }
    }
    return result as unknown as DevRevisionRead;
  }

  async restoreRevision(projectId: string, request: RestoreDevProjectRevisionRequest,
                        signal?: AbortSignal): Promise<DevRevisionRead> {
    const project = validateOpaqueId(projectId, "projectId");
    if (!request || typeof request !== "object") {
      throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, "A revision restore request is required.");
    }
    validateOpaqueId(request.expectedHeadRevisionId, "expectedHeadRevisionId");
    validateOpaqueId(request.targetRevisionId, "targetRevisionId");
    if (!exactKeys(request, ["expectedHeadRevisionId", "targetRevisionId"])) {
      throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, "Restore request fields do not match its declared type.");
    }
    const target = await this.getRevision(projectId, request.targetRevisionId, signal);
    const value = await this.request("POST", `/dev/v1/projects/${project}/restore`, request, signal, true);
    const result = record(value, "revision restore response");
    const revision = parseRevision(result.revision);
    if (result.scope !== "DEV_ONLY" || revision.projectId !== projectId
      || revision.tenantId !== target.revision.tenantId
      || revision.parentRevisionId !== request.expectedHeadRevisionId
      || revision.revisionId === request.expectedHeadRevisionId
      || !sameTimelineGraphState(revision, target.revision)) {
      throw invalidResponse("Restore response does not match the requested target revision and project head.");
    }
    return result as unknown as DevRevisionRead;
  }

  async getRevision(projectId: string, revisionId: string, signal?: AbortSignal): Promise<DevRevisionRead> {
    const project = validateOpaqueId(projectId, "projectId");
    const revision = validateOpaqueId(revisionId, "revisionId");
    const value = await this.request("GET", `/dev/v1/projects/${project}/revisions/${revision}`, undefined, signal, false);
    const result = record(value, "revision read response");
    const snapshot = parseRevision(result.revision);
    if (result.scope !== "DEV_ONLY" || snapshot.projectId !== projectId || snapshot.revisionId !== revisionId) {
      throw invalidResponse("Revision read response does not match the requested identity.");
    }
    return result as unknown as DevRevisionRead;
  }

  private async request(method: "GET" | "POST", path: string, body: unknown,
                        signal: AbortSignal | undefined, mutating: boolean, requestId?: string): Promise<unknown> {
    let token: string;
    try { token = typeof this.options.bearerToken === "function" ? this.options.bearerToken() : this.options.bearerToken; }
    catch { throw new MediaDevProjectTimelineError("INVALID_CONFIGURATION", 0, "The DEV_ONLY bearer token is unavailable."); }
    if (!isNonEmpty(token) || token.startsWith("Bearer ")) {
      throw new MediaDevProjectTimelineError("INVALID_CONFIGURATION", 0, "A raw DEV_ONLY bearer token is required.");
    }
    let response: Response;
    try {
      response = await this.fetcher.call(globalThis, `${this.origin}${path}`, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        credentials: "omit",
        redirect: "error",
        cache: "no-store",
        signal,
      });
    } catch {
      throw new MediaDevProjectTimelineError(
        mutating ? "OUTCOME_UNKNOWN" : "TRANSPORT_ERROR",
        0,
        mutating
          ? "The project mutation outcome is unknown; read the exact project before retrying."
          : "The local Media development host did not return a response.",
        requestId ? { requestId } : undefined,
      );
    }
    let parsed: unknown;
    try { parsed = await response.json(); }
    catch {
      if (mutating) {
        throw new MediaDevProjectTimelineError(
          "OUTCOME_UNKNOWN", response.status,
          "The Media host returned an unreadable response to a mutation; read the exact project head before retrying.",
        );
      }
      throw invalidResponse("The Media development host returned a non-JSON response.");
    }
    if (!response.ok) {
      if (mutating && (response.status === 408 || response.status === 425
          || response.status === 429 || response.status >= 500)) {
        const payload = parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? parsed as JsonRecord
          : undefined;
        const error = payload?.error && typeof payload.error === "object" && !Array.isArray(payload.error)
          ? payload.error as JsonRecord
          : undefined;
        const responseCode = error && isNonEmpty(error.code) ? error.code : "HTTP_ERROR";
        const details = error?.details && typeof error.details === "object" && !Array.isArray(error.details)
          ? error.details as Readonly<Record<string, unknown>>
          : undefined;
        throw new MediaDevProjectTimelineError(
          "OUTCOME_UNKNOWN", response.status,
          "The Media host did not confirm whether the mutation committed; read the exact project head before retrying.",
          { responseCode, ...(details ?? {}) },
        );
      }
      const payload = record(parsed, "error response");
      const error = record(payload.error, "error response body");
      const code = isNonEmpty(error.code) ? error.code : "HTTP_ERROR";
      const message = isNonEmpty(error.message) ? error.message : "The local Media request failed.";
      const details = error.details && typeof error.details === "object" && !Array.isArray(error.details)
        ? error.details as Readonly<Record<string, unknown>>
        : undefined;
      throw new MediaDevProjectTimelineError(code, response.status, message, details);
    }
    return parsed;
  }
}

function validateLoopbackOrigin(value: string): string {
  let url: URL;
  try { url = new URL(value); }
  catch { throw new MediaDevProjectTimelineError("INVALID_CONFIGURATION", 0, "The DEV_ONLY host URL must be absolute."); }
  const host = url.hostname.toLowerCase();
  if (!(host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1")
    || !(url.protocol === "http:" || url.protocol === "https:")
    || url.username || url.password || url.pathname !== "/" || url.search || url.hash) {
    throw new MediaDevProjectTimelineError(
      "INVALID_CONFIGURATION", 0,
      "DEV_ONLY credentials can be used only with an absolute loopback origin without path or URL credentials.",
    );
  }
  return url.origin;
}

function validateProjectRequest(request: CreateDevProjectRequest): void {
  validateOpaqueId(request.selectedAuthorizedWorkspaceId, "selectedAuthorizedWorkspaceId");
  if (typeof request.title !== "string" || !/\S/u.test(request.title) || [...request.title].length > 200) {
    throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, "Project title must be nonblank and at most 200 Unicode code points.");
  }
  if (typeof request.requestId !== "string" || !REQUEST_ID.test(request.requestId)) {
    throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, "Project requestId must be a 1-128 character opaque request identity.");
  }
}

function validateTimelineEdits(edits: readonly DevTimelineEdit[]): void {
  if (!Array.isArray(edits) || edits.length < 1 || edits.length > 10_000) {
    throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, "Timeline edits must contain between one and 10000 operations.");
  }
  for (const edit of edits) {
    if (!edit || typeof edit !== "object") {
      throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, "Every timeline edit must be an object.");
    }
    switch (edit.type) {
      case "addScene":
        if (!exactKeys(edit, ["type", "sceneId", "order"])) throw invalidEditFields();
        validateOpaqueId(edit.sceneId, "sceneId");
        validateOrder(edit.order, "scene order");
        break;
      case "removeScene":
        if (!exactKeys(edit, ["type", "sceneId"])) throw invalidEditFields();
        validateOpaqueId(edit.sceneId, "sceneId");
        break;
      case "addTrack":
        if (!exactKeys(edit, ["type", "trackId", "sceneId", "trackKind", "order"])) throw invalidEditFields();
        validateOpaqueId(edit.trackId, "trackId");
        validateOpaqueId(edit.sceneId, "sceneId");
        if (!["VIDEO", "AUDIO", "CAPTION", "OVERLAY"].includes(edit.trackKind)) {
          throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, "Track kind must be VIDEO, AUDIO, CAPTION, or OVERLAY.");
        }
        validateOrder(edit.order, "track order");
        break;
      case "removeTrack":
        if (!exactKeys(edit, ["type", "trackId"])) throw invalidEditFields();
        validateOpaqueId(edit.trackId, "trackId");
        break;
      case "putClip":
        if (!exactKeys(edit, ["type", "clip"])) throw invalidEditFields();
        validateClip(edit.clip);
        break;
      case "removeClip":
        if (!exactKeys(edit, ["type", "clipId"])) throw invalidEditFields();
        validateOpaqueId(edit.clipId, "clipId");
        break;
      default:
        throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, "Timeline edit type is not supported by this DEV_ONLY client.");
    }
  }
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function validateOrder(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 2_147_483_647) {
    throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, `${label} must be a non-negative 32-bit integer.`);
  }
}

function invalidEditFields(): MediaDevProjectTimelineError {
  return new MediaDevProjectTimelineError("INVALID_REQUEST", 0, "Timeline edit fields do not match its declared type.");
}

function sameTimelineGraphState(left: DevProjectRevision, right: DevProjectRevision): boolean {
  if (left.timelines.length !== right.timelines.length) return false;
  const leftById = new Map(left.timelines.map((snapshot) => [snapshot.graph.timelineId, snapshot.graph]));
  const rightById = new Map(right.timelines.map((snapshot) => [snapshot.graph.timelineId, snapshot.graph]));
  if (leftById.size !== rightById.size) return false;
  return [...leftById.entries()].every(([timelineId, graph]) => {
    const target = rightById.get(timelineId);
    return target !== undefined && canonicalJson(graph) === canonicalJson(target);
  });
}

function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
    return `{${entries.map(([key, nested]) => `${JSON.stringify(key)}:${canonicalJson(nested)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function validateOpaqueId(value: string, field: string): string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) {
    throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, `${field} must be a 1-128 character opaque identifier.`);
  }
  return value;
}

function parseProject(value: unknown): DevProject {
  const project = record(value, "project");
  for (const field of ["tenantId", "projectId", "workspaceId", "ownerPrincipalId", "title", "headRevisionId"] as const) {
    if (!isNonEmpty(project[field])) throw invalidResponse(`Project response is missing ${field}.`);
  }
  return project as unknown as DevProject;
}

function parseRevision(value: unknown): DevProjectRevision {
  const revision = record(value, "project revision");
  if (!isNonEmpty(revision.tenantId) || !isNonEmpty(revision.projectId) || !isNonEmpty(revision.revisionId)
    || !(revision.parentRevisionId === null || isNonEmpty(revision.parentRevisionId))
    || !Array.isArray(revision.timelines)) {
    throw invalidResponse("Project revision response is incomplete.");
  }
  for (const value of revision.timelines) {
    const timeline = record(value, "timeline snapshot");
    const graph = record(timeline.graph, "timeline graph");
    if (!isNonEmpty(timeline.semanticVersionId) || !isNonEmpty(graph.timelineId)
      || !Array.isArray(graph.scenes) || !Array.isArray(graph.tracks) || !Array.isArray(graph.clips)) {
      throw invalidResponse("Project timeline snapshot is incomplete.");
    }
    for (const clip of graph.clips) parseClip(clip);
  }
  return revision as unknown as DevProjectRevision;
}

function validateClip(clip: DevTimelineClip): void {
  if (!clip || typeof clip !== "object" || !exactKeys(clip, [
    "clipId", "sceneId", "trackId", "source", "sourceIn", "sourceOut", "storyStart", "storyDuration",
  ])) throw invalidEditFields();
  validateOpaqueId(clip.clipId, "clipId");
  validateOpaqueId(clip.sceneId, "sceneId");
  validateOpaqueId(clip.trackId, "trackId");
  if (!clip.source || typeof clip.source !== "object" || !exactKeys(clip.source, ["artifactId", "artifactVersionId"])) {
    throw invalidEditFields();
  }
  validateOpaqueId(clip.source.artifactId, "artifactId");
  if (typeof clip.source.artifactVersionId !== "string"
    || !/^[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}$/u.test(clip.source.artifactVersionId)) {
    throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, "artifactVersionId must be a 1-128 character opaque version identity.");
  }
  for (const [name, time, clock] of [
    ["sourceIn", clip.sourceIn, "SOURCE_PRESENTATION"],
    ["sourceOut", clip.sourceOut, "SOURCE_PRESENTATION"],
    ["storyStart", clip.storyStart, "STORY"],
    ["storyDuration", clip.storyDuration, "STORY"],
  ] as const) validateRationalTime(time, name, clock);
  if (compareTimes(clip.sourceIn, clip.sourceOut) >= 0 || BigInt(clip.storyDuration.ticks) === 0n) {
    throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, "Clip source interval and story duration must be positive.");
  }
}

function validateRationalTime(value: DevRationalTime, field: string, clock: DevRationalTime["clock"]): void {
  if (!value || typeof value !== "object" || !exactKeys(value, ["ticks", "rateNumerator", "rateDenominator", "clock"])) {
    throw invalidEditFields();
  }
  if (value.clock !== clock) {
    throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, `${field} must use the ${clock} clock domain.`);
  }
  const ticks = decimalInt64(value.ticks, `${field}.ticks`, false);
  const numerator = decimalInt64(value.rateNumerator, `${field}.rateNumerator`, true);
  const denominator = decimalInt64(value.rateDenominator, `${field}.rateDenominator`, true);
  if (ticks < 0n || numerator < 1n || denominator < 1n) {
    throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, `${field} ticks and rates are outside the rational-time bounds.`);
  }
}

function decimalInt64(value: string, field: string, positive: boolean): bigint {
  const pattern = positive ? /^[1-9][0-9]*$/u : /^(0|[1-9][0-9]*)$/u;
  if (typeof value !== "string" || !pattern.test(value) || BigInt(value) > 9_223_372_036_854_775_807n) {
    throw new MediaDevProjectTimelineError("INVALID_REQUEST", 0, `${field} must be a canonical signed-64-bit decimal integer.`);
  }
  return BigInt(value);
}

function parseClip(value: unknown): DevTimelineClip {
  const clip = record(value, "timeline clip");
  if (!exactKeys(clip, ["clipId", "sceneId", "trackId", "source", "sourceIn", "sourceOut", "storyStart", "storyDuration"])) {
    throw invalidResponse("Timeline clip response contains unexpected or missing fields.");
  }
  const source = record(clip.source, "timeline clip source");
  if (!exactKeys(source, ["artifactId", "artifactVersionId"])
    || !isNonEmpty(source.artifactId) || !isNonEmpty(source.artifactVersionId)) {
    throw invalidResponse("Timeline clip source response is malformed.");
  }
  const parsed: DevTimelineClip = {
    clipId: requiredResponseString(clip.clipId, "clipId"),
    sceneId: requiredResponseString(clip.sceneId, "sceneId"),
    trackId: requiredResponseString(clip.trackId, "trackId"),
    source: { artifactId: source.artifactId, artifactVersionId: source.artifactVersionId },
    sourceIn: parseRationalTime(clip.sourceIn, "sourceIn"),
    sourceOut: parseRationalTime(clip.sourceOut, "sourceOut"),
    storyStart: parseRationalTime(clip.storyStart, "storyStart"),
    storyDuration: parseRationalTime(clip.storyDuration, "storyDuration"),
  };
  try { validateClip(parsed); }
  catch { throw invalidResponse("Timeline clip response violates its exact identity or clock contract."); }
  return parsed;
}

function parseRationalTime(value: unknown, field: string): DevRationalTime {
  const time = record(value, `timeline clip ${field}`);
  if (!exactKeys(time, ["ticks", "rateNumerator", "rateDenominator", "clock"])
    || !["SOURCE_PRESENTATION", "STORY"].includes(String(time.clock))) {
    throw invalidResponse(`Timeline clip ${field} response is malformed.`);
  }
  const result = {
    ticks: requiredResponseString(time.ticks, `${field}.ticks`),
    rateNumerator: requiredResponseString(time.rateNumerator, `${field}.rateNumerator`),
    rateDenominator: requiredResponseString(time.rateDenominator, `${field}.rateDenominator`),
    clock: time.clock as DevRationalTime["clock"],
  };
  try { validateRationalTime(result, field, result.clock); }
  catch { throw invalidResponse(`Timeline clip ${field} response violates its exact rational-time contract.`); }
  return result;
}

function sameClip(left: DevTimelineClip, right: DevTimelineClip): boolean {
  return left.clipId === right.clipId && left.sceneId === right.sceneId && left.trackId === right.trackId
    && left.source.artifactId === right.source.artifactId
    && left.source.artifactVersionId === right.source.artifactVersionId
    && sameTime(left.sourceIn, right.sourceIn) && sameTime(left.sourceOut, right.sourceOut)
    && sameTime(left.storyStart, right.storyStart) && sameTime(left.storyDuration, right.storyDuration);
}

function sameTime(left: DevRationalTime, right: DevRationalTime): boolean {
  return left.clock === right.clock
    && BigInt(left.ticks) * BigInt(left.rateDenominator) * BigInt(right.rateNumerator)
      === BigInt(right.ticks) * BigInt(right.rateDenominator) * BigInt(left.rateNumerator);
}

function compareTimes(left: DevRationalTime, right: DevRationalTime): number {
  return BigInt(left.ticks) * BigInt(left.rateDenominator) * BigInt(right.rateNumerator)
    < BigInt(right.ticks) * BigInt(right.rateDenominator) * BigInt(left.rateNumerator) ? -1 : 1;
}

function requiredResponseString(value: unknown, field: string): string {
  if (!isNonEmpty(value)) throw invalidResponse(`Timeline clip response is missing ${field}.`);
  return value;
}

function record(value: unknown, label: string): JsonRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidResponse(`${label} must be an object.`);
  return value as JsonRecord;
}

function isNonEmpty(value: unknown): value is string { return typeof value === "string" && value.length > 0; }

function invalidResponse(message: string): MediaDevProjectTimelineError {
  return new MediaDevProjectTimelineError("INVALID_RESPONSE", 0, message);
}
