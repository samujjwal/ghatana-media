/**
 * DEV_ONLY local provider catalog: strict parsing of `GET /dev/v1/providers/catalog` and the pure helpers the status
 * panel uses. The host derives every state from a real verification or probe; this module never infers readiness,
 * never upgrades an unknown state to READY, and treats `productionEligible` as false unless the host says otherwise
 * (and the host never does for the DEV catalog).
 */

export interface DevProviderCatalogHostResponse { readonly status: number; readonly body: unknown }

export interface DevProviderCatalogPort {
  get(): Promise<DevProviderCatalogHostResponse>;
}

/** Typed host failure. `status` 0 means no response was observed. */
export class DevProviderCatalogHostError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "DevProviderCatalogHostError";
  }
}

export const DEV_PROVIDER_STATES = ["READY", "DEGRADED", "UNAVAILABLE", "NOT_ADMITTED", "WITHDRAWN"] as const;
export type DevProviderState = typeof DEV_PROVIDER_STATES[number];

export interface DevProviderEntry {
  readonly providerId: string;
  readonly kind: string;
  readonly state: DevProviderState;
  readonly reason: string;
  readonly detail: string;
  readonly modelId: string | null;
  readonly revision: string | null;
  readonly licenseSpdx: string | null;
  readonly licenseNotice: string | null;
  readonly noticeRequired: boolean | null;
  readonly digests: Readonly<Record<string, string>>;
  readonly verifiedLanguages: readonly string[];
  readonly voices: readonly string[];
  readonly deviceKind: string;
  readonly deviceName: string;
  readonly deviceReported: boolean;
  readonly productionEligible: boolean;
  readonly lastCheckedAt: string;
}

export interface DevProviderCatalogView {
  readonly checkedAt: string;
  readonly cacheTtlSeconds: number;
  readonly fallbackPolicy: string;
  readonly providers: readonly DevProviderEntry[];
}

const record = (value: unknown, field: string): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${field} must be an object`);
  return value as Record<string, unknown>;
};
const text = (value: unknown, field: string, max = 4000): string => {
  if (typeof value !== "string" || value.length > max) throw new TypeError(`${field} must be a string of at most ${max} characters`);
  return value;
};
const optionalText = (value: unknown, field: string, max = 4000): string | null => value === null || value === undefined ? null : text(value, field, max);
const strings = (value: unknown, field: string): readonly string[] => {
  if (!Array.isArray(value) || value.length > 256) throw new TypeError(`${field} must be a bounded list`);
  return value.map((item, index) => text(item, `${field}[${index}]`, 128));
};

/** Parses one provider row; an unknown state is refused rather than shown as healthy. */
export function parseDevProviderEntry(raw: unknown): DevProviderEntry {
  const row = record(raw, "provider");
  const state = row.state;
  if (typeof state !== "string" || !(DEV_PROVIDER_STATES as readonly string[]).includes(state)) {
    throw new TypeError("provider state is not one of the catalog states");
  }
  const license = row.license === undefined ? {} : record(row.license, "license");
  const digestsRaw = row.digests === undefined ? {} : record(row.digests, "digests");
  const digests: Record<string, string> = {};
  for (const [key, value] of Object.entries(digestsRaw)) digests[text(key, "digest name", 64)] = text(value, `digests.${key}`, 128);
  const device = row.device === undefined ? {} : record(row.device, "device");
  return {
    providerId: text(row.providerId, "providerId", 64),
    kind: text(row.kind, "kind", 64),
    state: state as DevProviderState,
    reason: text(row.reason, "reason", 128),
    detail: row.detail === undefined ? "" : text(row.detail, "detail", 256),
    modelId: optionalText(row.modelId, "modelId", 256),
    revision: optionalText(row.revision, "revision", 128),
    licenseSpdx: optionalText(license.spdx, "license.spdx", 128),
    licenseNotice: optionalText(license.notice, "license.notice", 4000),
    noticeRequired: typeof license.noticeRequired === "boolean" ? license.noticeRequired : null,
    digests,
    verifiedLanguages: row.verifiedLanguages === undefined ? [] : strings(row.verifiedLanguages, "verifiedLanguages"),
    voices: row.voices === undefined ? [] : strings(row.voices, "voices"),
    deviceKind: typeof device.kind === "string" ? device.kind : "UNREPORTED",
    deviceName: typeof device.name === "string" ? device.name : "",
    deviceReported: device.reported === true,
    // The DEV catalog never asserts production eligibility; anything but an explicit boolean true is false.
    productionEligible: row.productionEligible === true,
    lastCheckedAt: text(row.lastCheckedAt, "lastCheckedAt", 64),
  };
}

export function parseDevProviderCatalog(body: unknown): DevProviderCatalogView {
  const root = record(body, "catalog");
  if (root.schema !== "media.dev.provider-catalog.v1" || root.scope !== "DEV_ONLY") {
    throw new TypeError("not a DEV_ONLY provider catalog");
  }
  if (!Array.isArray(root.providers) || root.providers.length > 32) throw new TypeError("providers must be a bounded list");
  const seen = new Set<string>();
  const providers = root.providers.map((row) => {
    const parsed = parseDevProviderEntry(row);
    if (seen.has(parsed.providerId)) throw new TypeError("duplicate provider id");
    seen.add(parsed.providerId);
    return parsed;
  });
  const ttl = typeof root.cacheTtlSeconds === "number" && Number.isFinite(root.cacheTtlSeconds) ? root.cacheTtlSeconds : 0;
  return {
    checkedAt: text(root.checkedAt, "checkedAt", 64),
    cacheTtlSeconds: ttl,
    fallbackPolicy: root.fallbackPolicy === undefined ? "" : text(root.fallbackPolicy, "fallbackPolicy", 256),
    providers,
  };
}

export const DEV_PROVIDER_LABELS: Readonly<Record<string, string>> = {
  whisper: "Whisper speech-to-text",
  kokoro: "Kokoro text-to-speech",
  florence: "Florence-2 vision",
  qwen: "Qwen2.5-VL multimodal",
  ffmpeg: "FFmpeg render and encode",
};

const STATE_TEXT: Readonly<Record<DevProviderState, string>> = {
  READY: "Ready: verified and answered a live probe",
  DEGRADED: "Degraded: answering slowly or only partly checkable",
  UNAVAILABLE: "Unavailable: the process, port, binary or worker is not answering",
  NOT_ADMITTED: "Not admitted: a manifest, identity, licence or digest check failed",
  WITHDRAWN: "Withdrawn: it was verified and a file changed afterwards",
};

export function describeDevProviderState(state: DevProviderState): string { return STATE_TEXT[state]; }

const REASON_TEXT: Readonly<Record<string, string>> = {
  VERIFIED_AND_PROBED: "Manifest digests verified and the live probe succeeded.",
  NOT_CONFIGURED: "This provider is not configured on this host.",
  MODEL_NOT_INSTALLED: "No model manifest is installed.",
  MODEL_MANIFEST_INVALID: "The model manifest is unreadable or malformed.",
  MODEL_IDENTITY_MISMATCH: "The manifest describes a different model.",
  MODEL_MANIFEST_MISSING_OR_INVALID: "The model manifest is missing or invalid.",
  MODEL_DIGEST_MISMATCH: "A model file does not match its pinned digest.",
  MODEL_FILE_MISSING: "A model file is missing.",
  MODEL_LICENSE_MISMATCH: "The model licence is not the admitted one.",
  MODEL_OWNER_DECISION_MISMATCH: "The recorded owner decision does not match.",
  MODEL_FILES_CHANGED: "Model files changed after verification.",
  BINARY_MISSING: "The runtime binary is missing.",
  BINARY_CHANGED: "The runtime binary changed after verification.",
  BINARY_DIGEST_MISMATCH: "The runtime binary does not match its pinned digest.",
  BINARY_NOT_EXECUTABLE: "The runtime binary cannot be started.",
  BINARY_PROBE_TIMEOUT: "The runtime binary did not answer its probe in time.",
  FFMPEG_BINARY_MISSING: "The ffmpeg binary is missing.",
  FFPROBE_BINARY_MISSING: "The ffprobe binary is missing.",
  ENCODER_UNAVAILABLE: "A required encoder is missing from the build.",
  WORKER_NOT_RUNNING: "The persistent worker process is not running.",
  WORKER_HEALTH_UNREACHABLE: "The worker is running but did not answer its health check.",
  WORKER_REFUSED: "The worker refuses to serve (its files changed).",
  SIDECAR_UNREACHABLE: "The sidecar port is closed; nothing is listening.",
  SIDECAR_HEALTH_TIMEOUT: "The sidecar accepted the connection but did not answer in time.",
  SIDECAR_REJECTED: "The sidecar rejected the health probe.",
  PROBE_SLOW: "The provider answered, but slower than the probe budget.",
  PROBE_TIMEOUT: "The probe exceeded its hard deadline.",
  PROBE_FAILED: "The probe itself failed.",
  RUNTIME_NOT_CONFIGURED: "The runtime executable is not configured.",
  RUNTIME_NOT_READY: "The verified runtime is not ready.",
  NO_PERSISTENT_WORKER_TO_PROBE: "There is no persistent worker, so nothing can be probed.",
};

export function describeDevProviderReason(reason: string): string {
  return REASON_TEXT[reason] ?? "See the reason code.";
}

/** Short text for a digest: the algorithm-less first 12 hex characters, never the whole value as a heading. */
export function shortDigest(value: string): string { return value.length > 16 ? `${value.slice(0, 12)}…` : value; }

export interface DevProviderChange { readonly providerId: string; readonly from: DevProviderState; readonly to: DevProviderState }

/** The providers whose state differs between two views (a new provider is not a change). */
export function diffDevProviderStates(previous: DevProviderCatalogView | null, next: DevProviderCatalogView): readonly DevProviderChange[] {
  if (!previous) return [];
  const before = new Map(previous.providers.map((p) => [p.providerId, p.state]));
  const changes: DevProviderChange[] = [];
  for (const provider of next.providers) {
    const was = before.get(provider.providerId);
    if (was && was !== provider.state) changes.push({ providerId: provider.providerId, from: was, to: provider.state });
  }
  return changes;
}

export interface DevProviderFailure { readonly code: string; readonly text: string }

export function describeDevProviderFailure(error: DevProviderCatalogHostError): DevProviderFailure {
  switch (error.code) {
    case "PROVIDER_CATALOG_BUSY": return { code: error.code, text: "The host is refreshing the catalog. Try again in a moment." };
    case "TRANSPORT_ERROR": return { code: error.code, text: "The local Media host did not answer. The previous view, if any, is stale." };
    case "INVALID_RESPONSE": return { code: error.code, text: "The host returned a catalog this page cannot trust, so nothing is shown as ready." };
    default: return { code: error.code, text: error.message };
  }
}
