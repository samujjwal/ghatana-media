/**
 * DEV_ONLY verified artifact-content boundary shared by the render and creative-output panels.
 *
 * A host adapter reads `GET /dev/v1/artifacts/{artifactId}/content` for ONE exact artifact version with the bearer
 * token in a header (never in a URL) and resolves with the raw bytes or rejects with {@link DevContentError}.
 * Nothing is shown or saved until the bytes' SHA-256 equals the registered sha256, the byte count equals the
 * registered size (when known) and the content type equals the registered content type.
 */

/** Client-side cap on a single in-memory read. Larger artifacts are refused with a clear message (no ranges here). */
export const DEV_CONTENT_MAX_BYTES = 8 * 1024 * 1024;

export interface DevArtifactContentRequest {
  readonly artifactId: string;
  /** Exact version, `sha256:<64 hex>`. */
  readonly artifactVersionId: string;
  /** The adapter must stop reading and reject with CONTENT_TOO_LARGE once this many bytes would be exceeded. */
  readonly maxBytes: number;
}
export interface DevArtifactContentResponse {
  readonly status: number;
  readonly contentType: string | null;
  readonly bytes: Uint8Array;
}
export interface DevArtifactContentReader {
  readArtifactContent(request: DevArtifactContentRequest): Promise<DevArtifactContentResponse>;
}

/** Typed content failure. `status` 0 means no response was observed. */
export class DevContentError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) {
    super(message);
    this.name = "DevContentError";
  }
}

export interface RegisteredArtifact {
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly contentType: string;
  readonly sizeBytes: number | null;
  readonly sha256: string;
}
export interface VerifiedContent {
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
}

export type DigestFunction = (bytes: Uint8Array) => Promise<string>;

export const sha256Hex: DigestFunction = async (bytes) => {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) throw new DevContentError("CONTENT_VERIFICATION_UNAVAILABLE", 0, "This browser cannot compute SHA-256, so the bytes cannot be verified.");
  const copy = new Uint8Array(bytes.byteLength);
  copy.set(bytes);
  return Array.from(new Uint8Array(await subtle.digest("SHA-256", copy.buffer)), (byte) => byte.toString(16).padStart(2, "0")).join("");
};

const baseType = (value: string): string => value.split(";")[0]!.trim().toLowerCase();

/** Fetch one exact version and accept it only when size, type and SHA-256 all match what was registered. */
export async function readVerifiedContent(
  reader: DevArtifactContentReader, artifact: RegisteredArtifact, options: { readonly maxBytes?: number; readonly digest?: DigestFunction } = {},
): Promise<VerifiedContent> {
  const maxBytes = options.maxBytes ?? DEV_CONTENT_MAX_BYTES;
  if (artifact.sizeBytes !== null && artifact.sizeBytes > maxBytes) {
    throw new DevContentError("CONTENT_TOO_LARGE", 0, `The registered size is ${artifact.sizeBytes} bytes, over the ${maxBytes}-byte limit for this page. Nothing was fetched.`);
  }
  const response = await reader.readArtifactContent({ artifactId: artifact.artifactId, artifactVersionId: artifact.artifactVersionId, maxBytes });
  if (response.status !== 200) throw new DevContentError("INVALID_RESPONSE", response.status, `Unexpected content status ${response.status}.`);
  if (response.bytes.byteLength > maxBytes) {
    throw new DevContentError("CONTENT_TOO_LARGE", 200, `The host returned more than ${maxBytes} bytes. The body was refused.`);
  }
  if (artifact.sizeBytes !== null && response.bytes.byteLength !== artifact.sizeBytes) {
    throw new DevContentError("CONTENT_SIZE_MISMATCH", 200, `The host returned ${response.bytes.byteLength} bytes but ${artifact.sizeBytes} were registered.`);
  }
  if (response.contentType === null || baseType(response.contentType) !== baseType(artifact.contentType)) {
    throw new DevContentError("CONTENT_TYPE_MISMATCH", 200, `The host returned ${response.contentType ?? "no content type"} but ${artifact.contentType} was registered.`);
  }
  const actual = await (options.digest ?? sha256Hex)(response.bytes);
  if (actual !== artifact.sha256) {
    throw new DevContentError("CONTENT_DIGEST_MISMATCH", 200, "The bytes do not match the registered SHA-256. They were discarded and nothing is shown.");
  }
  return { bytes: response.bytes, contentType: artifact.contentType, sha256: actual };
}

const CLIENT_CODES: ReadonlySet<string> = new Set(["CONTENT_TOO_LARGE", "CONTENT_SIZE_MISMATCH", "CONTENT_TYPE_MISMATCH", "CONTENT_DIGEST_MISMATCH", "CONTENT_VERIFICATION_UNAVAILABLE"]);

export interface ContentFailure { readonly code: string; readonly text: string }

/** Plain-language outcome for a failed content read. Never claims a preview or download exists. */
export function describeContentFailure(error: unknown): ContentFailure {
  if (!(error instanceof DevContentError)) {
    return { code: "TRANSPORT_ERROR", text: "The content could not be read. Nothing is shown or saved." };
  }
  const { code, status } = error;
  if (CLIENT_CODES.has(code)) return { code, text: error.message };
  if (status === 404) return { code, text: `Not found (${code}): this exact version is not available to this DEV_ONLY owner. Nothing is shown or saved.` };
  if (status === 403) return { code, text: "Denied: this DEV_ONLY principal lacks permission to read this artifact content. Nothing is shown or saved." };
  if (status === 412) return { code, text: "The exact version no longer matches the host's version (precondition failed). Reopen the output; nothing is shown or saved." };
  if (status === 400) return { code, text: `The host refused the version request (${code}). Nothing is shown or saved.` };
  if (status === 416) return { code, text: "The host could not satisfy the requested byte range. This page reads whole files only; nothing is shown or saved." };
  if (status === 413 || code === "CONTENT_OVER_CEILING" || /CEILING|TOO_LARGE/u.test(code)) {
    return { code, text: "The artifact is over the host's whole-body limit and this page does not read byte ranges. Nothing is shown or saved." };
  }
  if (status === 0) return { code, text: "The local Media host did not return a response. Nothing is shown or saved." };
  return { code, text: `The host refused the content request (${status} ${code}). Nothing is shown or saved.` };
}
