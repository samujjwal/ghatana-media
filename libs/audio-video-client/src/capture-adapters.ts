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
    || value.trim().length === 0 || value.length > 384) {
    throw new TypeError(`capture request ${field} is required and bounded`);
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
  requireRequestField(request.sourceIdentity, "sourceIdentity");
  requireRequestField(request.purposeRef, "purposeRef");
  requireRequestField(request.sourceVersionRef, "sourceVersionRef");
  requireRequestField(request.secretsRef, "secretsRef");
  requireRequestField(request.frameClockRef, "frameClockRef");
  const decision = eligibility.check(request);
  if (decision !== "ADMITTED") {
    throw new CaptureNotAdmittedError(request.kind, decision);
  }
  const frame = await adapter.capture(request);
  // A captured frame must bind the exact requested source and clock — an
  // adapter returning bytes for another source is rejected, not relabeled.
  if (frame.sourceIdentity !== request.sourceIdentity
    || frame.frameClockRef !== request.frameClockRef) {
    throw new TypeError("captured frame does not bind the requested source identity and clock");
  }
  return frame;
}
