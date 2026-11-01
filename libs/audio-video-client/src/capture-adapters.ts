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

const CAPTURE_SOURCE_KINDS: ReadonlySet<string> = new Set([
  "BROWSER", "DESKTOP", "MOBILE", "TERMINAL", "HTTP_API", "GRPC_API", "CAMERA", "MEDIA_FILE",
]);

/** Bound the result of one capture before it can enter a recorder pipeline. */
export const MAX_CAPTURED_FRAME_BYTES = 64 * 1024 * 1024;

export interface CaptureRequest {
  readonly kind: CaptureSourceKind;
  readonly sourceIdentity: string;
  readonly purposeRef: string;
  readonly sourceVersionRef: string;
  /** Reference to controlled secrets — never the secret value. */
  readonly secretsRef: string;
  readonly frameClockRef: string;
}

export interface CapturedFrame {
  readonly sourceIdentity: string;
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

export class CaptureNotAdmittedError extends Error {
  public constructor(
    public readonly kind: CaptureSourceKind,
    public readonly eligibility: CaptureEligibility,
  ) {
    super(`capture source ${kind} is not admitted: ${eligibility}`);
    this.name = "CaptureNotAdmittedError";
  }
}

function requireRequestField(value: string | undefined, field: string): string {
  if (value === undefined || typeof value !== "string"
    || value.trim().length === 0 || value.length > 384 || value !== value.trim()) {
    throw new TypeError(`capture request ${field} is required, canonical and bounded`);
  }
  return value;
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
    sourceVersionRef: request.sourceVersionRef,
    secretsRef: request.secretsRef,
    frameClockRef: request.frameClockRef,
  });
  // Validate the captured value too: accessor-backed inputs can change between
  // the initial guard read and the snapshot read.
  if (!CAPTURE_SOURCE_KINDS.has(admittedRequest.kind)) {
    throw new TypeError("capture request kind is outside the supported source enum");
  }
  requireRequestField(admittedRequest.sourceIdentity, "sourceIdentity");
  requireRequestField(admittedRequest.purposeRef, "purposeRef");
  requireRequestField(admittedRequest.sourceVersionRef, "sourceVersionRef");
  requireRequestField(admittedRequest.secretsRef, "secretsRef");
  requireRequestField(admittedRequest.frameClockRef, "frameClockRef");
  const decision = eligibility.check(admittedRequest);
  if (decision !== "ADMITTED" && decision !== "NOT_ADMITTED" && decision !== "UNAVAILABLE") {
    throw new TypeError("capture eligibility returned an unsupported decision");
  }
  if (decision !== "ADMITTED") {
    throw new CaptureNotAdmittedError(admittedRequest.kind, decision);
  }
  const frame = await adapter.capture(admittedRequest);
  if (!frame || typeof frame !== "object" || !(frame.bytes instanceof Uint8Array)
    || frame.bytes.byteLength < 1 || frame.bytes.byteLength > MAX_CAPTURED_FRAME_BYTES) {
    throw new TypeError("captured frame bytes must be non-empty and within the capture bound");
  }
  if (!Number.isSafeInteger(frame.capturedAtEpochMillis) || frame.capturedAtEpochMillis < 0) {
    throw new TypeError("captured frame timestamp must be a non-negative safe integer");
  }
  // A captured frame must bind the exact requested source and clock — an
  // adapter returning bytes for another source is rejected, not relabeled.
  if (frame.sourceIdentity !== admittedRequest.sourceIdentity
    || frame.frameClockRef !== admittedRequest.frameClockRef) {
    throw new TypeError("captured frame does not bind the requested source identity and clock");
  }
  return frame;
}
