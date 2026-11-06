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
  /** Present only for CAMERA captures; other source adapters keep their existing shape. */
  readonly cameraMetadata?: CameraCaptureMetadata;
  /** Exact device/source presentation time, or an explicit UNKNOWN disposition. */
  readonly sourcePresentationTime?: CameraSourcePresentationTime;
  /** Audio sample clock for a CAMERA source; OTHER source kinds omit it. */
  readonly audioSampleTime?: CameraAudioSampleTime;
}

export type CameraSignal = "VIDEO" | "AUDIO";
/** JSON value shape of the owner-defined PositiveRationalSchema. */
export type CameraPositiveRational = Readonly<{ numerator: string; denominator: string }>;
export type CameraDiscontinuity =
  | { readonly disposition: "NONE" }
  | { readonly disposition: "GAP" | "RESET"; readonly evidenceRef: string }
  | { readonly disposition: "UNKNOWN"; readonly reason: "SOURCE_DISCONTINUITY_NOT_REPORTED" };

export type CameraSourcePresentationTime =
  | { readonly disposition: "KNOWN"; readonly sourceClockRef: string; readonly sourceStreamRef: string;
      readonly sourceOriginRef: string; readonly presentationTicks: string; readonly timeBase: CameraPositiveRational;
      readonly discontinuity: CameraDiscontinuity }
  | { readonly disposition: "UNKNOWN";
      readonly reason: "SOURCE_PTS_NOT_SUPPLIED" | "SOURCE_TIMEBASE_NOT_SUPPLIED" | "SOURCE_CLOCK_IDENTITY_NOT_SUPPLIED" };

export type CameraAudioSampleTime =
  | { readonly disposition: "KNOWN"; readonly sampleIndex: string; readonly sampleRate: CameraPositiveRational;
      readonly sourceStreamRef: string }
  | { readonly disposition: "UNKNOWN"; readonly reason: "AUDIO_SAMPLE_CLOCK_NOT_SUPPLIED" }
  | { readonly disposition: "NOT_SELECTED" };

export interface CameraClockMappingUncertainty {
  readonly sourceDomain: "SOURCE_VIDEO_PRESENTATION";
  readonly destinationDomain: "AUDIO_SAMPLE" | "STORY" | "SIMULATION" | "WALL_CLOCK";
  readonly disposition: "UNKNOWN";
  readonly reason: "NO_QUALIFIED_CLOCK_ALIGNMENT";
}

/** Metadata returned by the selected host device/encoder, never inferred by the generic adapter. */
export interface CameraCaptureMetadata {
  readonly captureEpochRef: string;
  readonly captureClockRef: string;
  readonly hostCapturePtsNanos: string;
  readonly sourceIdentity: string;
  readonly sourceVersionRef: string;
  readonly permissionDecisionRef: string;
  readonly allowedSignals: readonly CameraSignal[];
  readonly selectedSignals: readonly CameraSignal[];
  readonly syncPolicyRef: string;
  readonly codecDisposition: "AVAILABLE";
  readonly codecProfileRef: string;
  readonly codecId: string;
  readonly mimeType: string;
  readonly width: number;
  readonly height: number;
  readonly sourceClockRef: string | null;
  readonly sourceStreamRef: string | null;
  readonly sourceOriginRef: string | null;
  readonly sourceTimeBase: CameraPositiveRational | null;
  readonly clockMappings: readonly CameraClockMappingUncertainty[];
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
 * A concrete capture provider bound to exactly one source kind. The host
 * wires adapters; the trusted eligibility seam still decides admission for
 * every request, and the adapter must return real captured bytes — never
 * synthesized frames, device claims or fabricated success.
 */
export interface CaptureSourceAdapter {
  readonly kind: CaptureSourceKind;
  capture(request: CaptureRequest): Promise<CapturedFrame>;
}

/** The admitted capture kind has no wired adapter; nothing was dispatched. */
export class CaptureAdapterNotWiredError extends TypeError {
  public constructor(public readonly kind: string) {
    super("no capture adapter is wired for the admitted source kind");
    this.name = "CaptureAdapterNotWiredError";
  }
}

/**
 * Routes one admitted capture request to the adapter wired for its source
 * kind. Kinds without a wired adapter reject before any capture attempt;
 * callers must still pass the result through `captureWithAdmission` so the
 * trusted eligibility seam and frame binding checks apply. Wiring is
 * validated eagerly so a mislabeled adapter fails at composition time.
 */
export function routedCaptureAdapter(
  adapters: Readonly<Partial<Record<CaptureSourceKind, CaptureSourceAdapter>>>,
): { capture(request: CaptureRequest): Promise<CapturedFrame> } {
  if (!adapters || typeof adapters !== "object" || Array.isArray(adapters)) {
    throw new TypeError("capture adapter registry must be an object");
  }
  for (const [key, adapter] of Object.entries(adapters)) {
    if (adapter === undefined) continue;
    if (!CAPTURE_SOURCE_KINDS.has(key) || adapter.kind !== key
      || typeof adapter.capture !== "function") {
      throw new TypeError("capture adapter registry entries must match their source kind");
    }
  }
  return {
    capture: (request: CaptureRequest): Promise<CapturedFrame> => {
      const kind = request !== null && typeof request === "object" ? request.kind : undefined;
      if (typeof kind !== "string" || !CAPTURE_SOURCE_KINDS.has(kind)) {
        return Promise.reject(new TypeError("capture request kind is outside the supported source enum"));
      }
      const adapter = adapters[kind as CaptureSourceKind];
      if (adapter === undefined) {
        return Promise.reject(new CaptureAdapterNotWiredError(kind));
      }
      return adapter.capture(request);
    },
  };
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
      frameClockRef, bytes, capturedAtEpochMillis, cameraMetadata, sourcePresentationTime, audioSampleTime,
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
    if (admittedRequest.kind === "CAMERA"
      && (!cameraMetadata || !sourcePresentationTime
        || !audioSampleTime
        || cameraMetadata.sourceIdentity !== admittedRequest.sourceIdentity
        || cameraMetadata.sourceVersionRef !== admittedRequest.sourceVersionRef
        || cameraMetadata.captureClockRef !== admittedRequest.frameClockRef
        || typeof cameraMetadata.permissionDecisionRef !== "string" || cameraMetadata.permissionDecisionRef.length === 0
        || typeof cameraMetadata.captureEpochRef !== "string" || cameraMetadata.captureEpochRef.length === 0
        || typeof cameraMetadata.hostCapturePtsNanos !== "string" || !/^(0|[1-9][0-9]*)$/u.test(cameraMetadata.hostCapturePtsNanos)
        || !Array.isArray(cameraMetadata.clockMappings) || cameraMetadata.clockMappings.length !== 4
        || !["KNOWN", "UNKNOWN"].includes(sourcePresentationTime.disposition)
        || !["KNOWN", "UNKNOWN", "NOT_SELECTED"].includes(audioSampleTime.disposition))) {
      throw new CaptureOutcomeUnknownError(admittedRequest.kind, "INVALID_FRAME");
    }
    return {
      sourceIdentity, purposeRef, exactRightsScope, sourceVersionRef, frameClockRef,
      bytes: Uint8Array.from(bytes), capturedAtEpochMillis,
      ...(cameraMetadata === undefined ? {} : { cameraMetadata }),
      ...(sourcePresentationTime === undefined ? {} : { sourcePresentationTime }),
      ...(audioSampleTime === undefined ? {} : { audioSampleTime }),
    };
  } catch {
    // The adapter has already run. Even a malformed/mismatched response does
    // not prove that the source capture had no effect; collapse it to a
    // sanitized UNKNOWN error without provider text or caller-controlled refs.
    throw new CaptureOutcomeUnknownError(admittedRequest.kind, "INVALID_FRAME");
  }
}
