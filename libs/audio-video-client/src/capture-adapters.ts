/**
 * H-04: capture adapter eligibility — the TypeScript mirror of
 * MediaCaptureSourceContracts. An adapter may capture only when the trusted
 * eligibility seam admits the exact request (source identity + purpose +
 * version + controlled secrets + frame clock). Unadmitted adapters return
 * NOT_ADMITTED; nothing fabricates pixels, device availability or success.
 */

export type CaptureSourceKind =
  | "BROWSER" | "DESKTOP" | "MOBILE" | "TERMINAL"
  | "HTTP_API" | "GRPC_API" | "CAMERA" | "MEDIA_FILE";

export type CaptureEligibility = "ADMITTED" | "NOT_ADMITTED" | "UNAVAILABLE";
/** Exact result variants of PDP-1 media.recorder.operation.capture.probe.v1. */
export type CaptureProbeDisposition = "QUALIFIED" | "NOT_QUALIFIED" | "UNAVAILABLE" | "DENIED";

/** Observation-only request fields defined by PDP-1 capture.probe.v1. */
export interface CaptureProbeRequest {
  readonly tenantId: string;
  readonly sourceId: string;
  readonly providerProfileId: string;
  readonly requestedSignals: readonly string[];
  readonly policyRef: string;
}

export interface CaptureAdapterProbe {
  probe(request: CaptureProbeRequest): Promise<CaptureProbeDisposition>;
}

const CAPTURE_PROBE_DISPOSITIONS: ReadonlySet<string> = new Set([
  "QUALIFIED", "NOT_QUALIFIED", "UNAVAILABLE", "DENIED",
]);
const MAX_CAPTURE_PROBE_SIGNALS = 32;

/** Default probe is explicitly not qualified and can never enable capture. */
export const noCaptureAdapterProbe: CaptureAdapterProbe = {
  probe: async () => "NOT_QUALIFIED",
};

/** Execute only the source-defined observation probe; never starts capture. */
export async function probeCaptureAdapter(
  probe: CaptureAdapterProbe,
  request: CaptureProbeRequest,
): Promise<CaptureProbeDisposition> {
  if (!probe || typeof probe.probe !== "function") {
    throw new TypeError("capture probe is required");
  }
  if (!request || typeof request !== "object" || !Array.isArray(request.requestedSignals)
    || request.requestedSignals.length < 1 || request.requestedSignals.length > MAX_CAPTURE_PROBE_SIGNALS) {
    throw new TypeError("capture probe request must contain 1..32 requested signals");
  }
  const snapshot: CaptureProbeRequest = Object.freeze({
    tenantId: requireRequestField(request.tenantId, "tenantId"),
    sourceId: requireRequestField(request.sourceId, "sourceId"),
    providerProfileId: requireRequestField(request.providerProfileId, "providerProfileId"),
    requestedSignals: Object.freeze(request.requestedSignals.map((signal, index) =>
      requireRequestField(signal, `requestedSignals[${index}]`))),
    policyRef: requireRequestField(request.policyRef, "policyRef"),
  });
  let disposition: CaptureProbeDisposition;
  try {
    disposition = await probe.probe(snapshot);
  } catch {
    return "UNAVAILABLE";
  }
  if (!CAPTURE_PROBE_DISPOSITIONS.has(disposition)) {
    throw new TypeError("capture probe returned an unsupported disposition");
  }
  return disposition;
}

const CAPTURE_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "BROWSER", "DESKTOP", "MOBILE", "TERMINAL", "HTTP_API", "GRPC_API", "CAMERA", "MEDIA_FILE",
]);

/** Bound the result of one capture before it can enter a recorder pipeline. */
export const MAX_CAPTURED_FRAME_BYTES = 64 * 1024 * 1024;

export interface CaptureRequest {
  readonly kind: CaptureSourceKind;
  readonly sourceIdentity: string;
  readonly purposeRef: string;
  /** Exact rights scope resolved by policy; never a caller assertion of admission. */
  readonly exactRightsScope: string;
  readonly sourceVersionRef: string;
  /** Reference to controlled secrets — never the secret value. */
  readonly secretsRef: string;
  readonly frameClockRef: string;
}

export interface CapturedFrame {
  readonly sourceIdentity: string;
  readonly purposeRef: string;
  readonly exactRightsScope: string;
  readonly sourceVersionRef: string;
  readonly frameClockRef: string;
  readonly bytes: Uint8Array;
  readonly capturedAtEpochMillis: number;
}

/** Trusted eligibility seam; caller assertions are never inputs. */
export interface CaptureAdapterEligibility {
  check(request: CaptureRequest): CaptureEligibility;
}

export const noAdmittedCaptureAdapter: CaptureAdapterEligibility = {
  check: () => "NOT_ADMITTED",
};

/**
 * Explicit result for a host that cannot provide a required capture
 * capability. Keep this separate from a deliberately disabled adapter:
 * callers can report UNAVAILABLE without probing for, or simulating, a host
 * API that is not present.
 */
export const unavailableCaptureAdapter: CaptureAdapterEligibility = {
  check: () => "UNAVAILABLE",
};

export class CaptureNotAdmittedError extends Error {
  public constructor(
    public readonly kind: CaptureSourceKind,
    public readonly eligibility: CaptureEligibility,
  ) {
    super(`capture source ${kind} is not admitted: ${eligibility}`);
    this.name = "CaptureNotAdmittedError";
  }
}

/** A host capability is absent; eligibility rejected capture before dispatch. */
export class CaptureUnavailableError extends CaptureNotAdmittedError {
  public constructor(kind: CaptureSourceKind) {
    // Preserve the source distinction: unavailable means eligibility could
    // not be decided, while NOT_ADMITTED is an explicit denial.
    super(kind, "UNAVAILABLE");
    this.name = "CaptureUnavailableError";
  }
}

/**
 * An admitted capture was dispatched, but the adapter rejected or returned a
 * frame that failed validation. The outcome is deliberately not called
 * FAILED: callers must reconcile before deciding whether to recapture. Only
 * a safe enum kind and fixed reason are retained; caller refs and provider
 * error text are omitted.
 */
export class CaptureOutcomeUnknownError extends TypeError {
  public constructor(
    kind: CaptureSourceKind,
    reason: "ADAPTER_REJECTED" | "INVALID_FRAME",
  ) {
    super("capture outcome is unknown after an admitted capture attempt");
    this.name = "CaptureOutcomeUnknownError";
    this.kind = kind;
    this.reason = reason;
  }

  public readonly kind: CaptureSourceKind;
  public readonly reason: "ADAPTER_REJECTED" | "INVALID_FRAME";
}

function requireRequestField(value: string | undefined, field: string): string {
  if (value === undefined || typeof value !== "string"
    || value.trim().length === 0 || value.length > 384 || value !== value.trim()) {
    throw new TypeError(`capture request ${field} is required, canonical and bounded`);
  }
  return value;
}

function hasRequestBinding(value: string | undefined): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Runs one capture through an admitted adapter. Eligibility is checked per
 * request; unadmitted adapters reject before any capture attempt. The
 * adapter itself must return real captured bytes — this wrapper adds no
 * synthetic frames.
 */
export async function captureWithAdmission(
  eligibility: CaptureAdapterEligibility,
  adapter: { capture(request: CaptureRequest): Promise<CapturedFrame> },
  request: CaptureRequest,
): Promise<CapturedFrame> {
  if (!request || typeof request !== "object") {
    throw new TypeError("capture request must be an object");
  }
  if (!CAPTURE_SOURCE_KINDS.has(request.kind)) {
    throw new TypeError("capture request kind is outside the supported source enum");
  }
  // Snapshot before crossing either callback boundary. A caller may retain
  // and mutate its input while capture is pending, and callbacks must not be
  // able to relabel the request that the trusted eligibility seam admitted.
  const admittedRequest: CaptureRequest = Object.freeze({
    kind: request.kind,
    sourceIdentity: request.sourceIdentity,
    purposeRef: request.purposeRef,
    exactRightsScope: request.exactRightsScope,
    sourceVersionRef: request.sourceVersionRef,
    secretsRef: request.secretsRef,
    frameClockRef: request.frameClockRef,
  });
  // Validate the captured value too: accessor-backed inputs can change between
  // the initial guard read and the snapshot read.
  if (!CAPTURE_SOURCE_KINDS.has(admittedRequest.kind)) {
    throw new TypeError("capture request kind is outside the supported source enum");
  }
  if (![admittedRequest.sourceIdentity, admittedRequest.purposeRef,
    admittedRequest.exactRightsScope, admittedRequest.sourceVersionRef,
    admittedRequest.secretsRef, admittedRequest.frameClockRef].every(hasRequestBinding)) {
    throw new CaptureNotAdmittedError(admittedRequest.kind, "NOT_ADMITTED");
  }
  requireRequestField(admittedRequest.sourceIdentity, "sourceIdentity");
  requireRequestField(admittedRequest.purposeRef, "purposeRef");
  requireRequestField(admittedRequest.exactRightsScope, "exactRightsScope");
  requireRequestField(admittedRequest.sourceVersionRef, "sourceVersionRef");
  requireRequestField(admittedRequest.secretsRef, "secretsRef");
  requireRequestField(admittedRequest.frameClockRef, "frameClockRef");
  const decision = eligibility.check(admittedRequest);
  if (decision !== "ADMITTED" && decision !== "NOT_ADMITTED" && decision !== "UNAVAILABLE") {
    throw new TypeError("capture eligibility returned an unsupported decision");
  }
  if (decision !== "ADMITTED") {
    if (decision === "UNAVAILABLE") {
      throw new CaptureUnavailableError(admittedRequest.kind);
    }
    throw new CaptureNotAdmittedError(admittedRequest.kind, decision);
  }
  let frame: CapturedFrame;
  try {
    frame = await adapter.capture(admittedRequest);
  } catch {
    // A rejected transport/promise does not prove that the source did not
    // capture. Do not invite an automatic retry or expose a provider error
    // that may contain request data or credentials.
    throw new CaptureOutcomeUnknownError(admittedRequest.kind, "ADAPTER_REJECTED");
  }
  try {
    if (!frame || typeof frame !== "object") {
      throw new TypeError("captured frame must be an object");
    }
    // Read each provider-owned field once, then detach the byte storage. The
    // adapter may reuse or mutate its result after this promise resolves.
    const {
      sourceIdentity, purposeRef, exactRightsScope, sourceVersionRef,
      frameClockRef, bytes, capturedAtEpochMillis,
    } = frame;
    if (!(bytes instanceof Uint8Array)
      || bytes.byteLength < 1 || bytes.byteLength > MAX_CAPTURED_FRAME_BYTES) {
      throw new TypeError("captured frame bytes must be non-empty and within the capture bound");
    }
    if (!Number.isSafeInteger(capturedAtEpochMillis) || capturedAtEpochMillis < 0) {
      throw new TypeError("captured frame timestamp must be a non-negative safe integer");
    }
    if (sourceIdentity !== admittedRequest.sourceIdentity
      || purposeRef !== admittedRequest.purposeRef
      || exactRightsScope !== admittedRequest.exactRightsScope
      || sourceVersionRef !== admittedRequest.sourceVersionRef
      || frameClockRef !== admittedRequest.frameClockRef) {
      throw new TypeError("captured frame does not bind the authorized source and clock");
    }
    return {
      sourceIdentity, purposeRef, exactRightsScope, sourceVersionRef, frameClockRef,
      bytes: Uint8Array.from(bytes), capturedAtEpochMillis,
    };
  } catch {
    // The adapter has already run. Even a malformed/mismatched response does
    // not prove that the source capture had no effect; collapse it to a
    // sanitized UNKNOWN error without provider text or caller-controlled refs.
    throw new CaptureOutcomeUnknownError(admittedRequest.kind, "INVALID_FRAME");
  }
}
