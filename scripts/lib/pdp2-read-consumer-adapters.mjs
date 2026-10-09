import { createHash } from "node:crypto";

const nonempty = (value) => typeof value === "string" && value.trim().length > 0;
const TRANSCRIPT_READ_OPERATION = "media.operation.transcript-version-read";
const TRANSCRIPT_READ_AUTHORITY = ".product-experience/pdp-1-domain-data/authority.yaml#ownership/identityAuthenticationAndDelegation";
const TRANSCRIPT_READ_POLICY = ".product-experience/pdp-0-product-truth/policy-authority-model.yaml#productPolicy";
const MAX_READ_RECEIPT_AGE_MS = 30_000;

function stableJson(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON rejects non-finite numbers");
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    if (Object.keys(value).length !== value.length || Object.keys(value).some((key, index) => key !== String(index))) {
      throw new TypeError("Canonical JSON rejects sparse arrays and extra array properties");
    }
    return `[${value.map((item) => {
      if (item === undefined) throw new TypeError("Canonical JSON rejects undefined array entries");
      return stableJson(item);
    }).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Canonical JSON accepts plain objects only");
    const keys = Object.keys(value).sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${keys.map((key) => {
      if (value[key] === undefined) throw new TypeError("Canonical JSON rejects undefined object properties");
      return `${JSON.stringify(key)}:${stableJson(value[key])}`;
    }).join(",")}}`;
  }
  throw new TypeError("Canonical JSON accepts JSON values only");
}

export function canonicalJsonFingerprint(value) {
  return `sha256:${createHash("sha256").update(stableJson(value), "utf8").digest("hex")}`;
}
const sha256 = canonicalJsonFingerprint;

function canonicalUtcMillis(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/u.test(value)) return undefined;
  const millis = Date.parse(value);
  if (!Number.isFinite(millis)) return undefined;
  const roundTrip = new Date(millis).toISOString();
  const canonical = roundTrip.endsWith(".000Z") ? roundTrip.replace(".000Z", "Z") : roundTrip;
  return canonical === value ? millis : undefined;
}

/**
 * Consumer projection for the source-observed getMediaArtifact payload.
 * Validators and host-context authentication are supplied by the owning host;
 * this function does not enrich a legacy Java record into ArtifactVersion.
 */
export function projectLegacyArtifactMetadata({ payload, trustedContext, validateSourcePayload, verifyHostContext }) {
  if (!nonempty(trustedContext?.tenantId) || !nonempty(trustedContext?.principalId)) {
    return { status: "DENIED", reason: "TRUSTED_HOST_CONTEXT_REQUIRED" };
  }
  let observedPayload;
  try {
    if (typeof verifyHostContext !== "function" || verifyHostContext(trustedContext) !== true) {
      return { status: "UNKNOWN", reason: "HOST_CONTEXT_NOT_VERIFIED" };
    }
    if (typeof validateSourcePayload !== "function" || validateSourcePayload(payload) !== true) {
      return { status: "UNKNOWN", reason: "SOURCE_PAYLOAD_INVALID_OR_UNVALIDATED" };
    }
    // The observed endpoint is JSON on the wire. Do not let direct JS callers
    // smuggle functions, undefined, cycles, or class instances through the
    // intentionally open legacy metadata map.
    sha256(payload);
    observedPayload = structuredClone(payload);
  } catch {
    return { status: "UNKNOWN", reason: "SOURCE_PAYLOAD_INVALID_OR_UNVALIDATED" };
  }
  if (payload.tenantId !== trustedContext.tenantId || payload.principalId !== trustedContext.principalId) {
    return { status: "DENIED", reason: "HOST_SCOPE_MISMATCH" };
  }
  return {
    status: "OBSERVED",
    observation: {
      kind: "LEGACY_ARTIFACT_METADATA_OBSERVATION",
      artifact: observedPayload,
    },
  };
}

/**
 * Verify the canonical transcript tuple and project it only when a trusted
 * host verifier authenticates a fresh, exact-read receipt. Any malformed
 * validator, payload, decimal value, or receipt fails closed to UNKNOWN.
 */
export function classifyTranscriptReadResult({
  payload,
  request,
  trustedContext,
  trustedRead,
  expectedRead,
  validateExpectedRead,
  validateTrustedRead,
  verifyExpectedRead,
  hostNow,
  validateRequest,
  validateCanonical,
  validateLegacy,
  verifyTrustedRead,
}) {
  const transcriptVersionId = request?.transcriptVersionId;
  if (!nonempty(transcriptVersionId)
    || !nonempty(trustedContext?.tenantId)
    || !nonempty(trustedContext?.principalId)) {
    return { status: "DENIED", reason: "EXACT_SELECTOR_AND_TRUSTED_HOST_CONTEXT_REQUIRED" };
  }

  try {
    if (typeof validateRequest !== "function" || validateRequest(request) !== true) {
      return { status: "DENIED", reason: "REQUEST_SCHEMA_INVALID" };
    }
    if (typeof validateCanonical === "function" && validateCanonical(payload) === true) {
      if (payload.tenantId !== trustedContext.tenantId
        || payload.transcriptVersionId !== transcriptVersionId
        || !nonempty(payload.sourceArtifactId)
        || !nonempty(payload.sourceArtifactVersionId)) {
        return { status: "UNKNOWN", reason: "CANONICAL_IDENTITY_OR_SOURCE_VERSION_MISMATCH" };
      }

      const canonicalRequest = {
        operationRef: TRANSCRIPT_READ_OPERATION,
        tenantId: trustedContext.tenantId,
        principalId: trustedContext.principalId,
        transcriptVersionId,
      };
      if (typeof validateExpectedRead !== "function" || validateExpectedRead(expectedRead) !== true
        || typeof validateTrustedRead !== "function" || validateTrustedRead(trustedRead) !== true
        || !expectedRead
        || expectedRead.queryId !== TRANSCRIPT_READ_OPERATION
        || expectedRead.method !== "EXACT_TRANSCRIPT_VERSION_READ"
        || expectedRead.tenantId !== trustedContext.tenantId
        || expectedRead.principalId !== trustedContext.principalId
        || expectedRead.transcriptVersionId !== transcriptVersionId
        || expectedRead.sourceArtifactId !== payload.sourceArtifactId
        || expectedRead.sourceArtifactVersionId !== payload.sourceArtifactVersionId
        || !nonempty(expectedRead.readVersion)
        || !nonempty(expectedRead.policyRevision)
        || expectedRead.authorityRef !== TRANSCRIPT_READ_AUTHORITY
        || expectedRead.policyDecisionRef !== TRANSCRIPT_READ_POLICY
        || trustedRead?.queryId !== TRANSCRIPT_READ_OPERATION
        || trustedRead?.method !== expectedRead.method
        || trustedRead?.currentness !== "CURRENT"
        || trustedRead.tenantId !== expectedRead.tenantId
        || trustedRead.principalId !== expectedRead.principalId
        || trustedRead.transcriptVersionId !== expectedRead.transcriptVersionId
        || trustedRead.sourceArtifactId !== expectedRead.sourceArtifactId
        || trustedRead.sourceArtifactVersionId !== expectedRead.sourceArtifactVersionId
        || trustedRead.readVersion !== expectedRead.readVersion
        || trustedRead.policyRevision !== expectedRead.policyRevision
        || trustedRead.authorityRef !== expectedRead.authorityRef
        || trustedRead.policyDecisionRef !== expectedRead.policyDecisionRef
        || trustedRead.requestFingerprint !== sha256(canonicalRequest)
        || trustedRead.payloadFingerprint !== sha256(payload)
        || !nonempty(trustedRead.readVersion)
        || !nonempty(trustedRead.hostIssuedProof)) {
        return { status: "UNKNOWN", reason: "READ_RECEIPT_IDENTITY_OR_DIGEST_MISMATCH" };
      }

      const nowMs = canonicalUtcMillis(hostNow);
      const checkedAtMs = canonicalUtcMillis(trustedRead.checkedAt);
      const expiresAtMs = canonicalUtcMillis(trustedRead.expiresAt);
      if (nowMs === undefined || checkedAtMs === undefined || expiresAtMs === undefined
        || checkedAtMs > nowMs || expiresAtMs <= nowMs || expiresAtMs <= checkedAtMs
        || expiresAtMs - checkedAtMs > MAX_READ_RECEIPT_AGE_MS
        || nowMs - checkedAtMs > MAX_READ_RECEIPT_AGE_MS) {
        return { status: "UNKNOWN", reason: "READ_RECEIPT_STALE_OR_INVALID" };
      }

      const segments = payload.segments ?? [];
      const segmentIds = new Set(segments.map((segment) => segment.segmentId));
      if (segmentIds.size !== segments.length) return { status: "UNKNOWN", reason: "DUPLICATE_SEGMENT_ID" };
      const maxSafe = BigInt(Number.MAX_SAFE_INTEGER);
      if (payload.sourceDurationTicks !== undefined) {
        if (!/^(?:0|[1-9][0-9]*)$/u.test(payload.sourceDurationTicks)
          || BigInt(payload.sourceDurationTicks) > maxSafe) {
          return { status: "UNKNOWN", reason: "SOURCE_DURATION_UNSAFE_OR_INVALID" };
        }
      }
      for (const timing of payload.timingObservations ?? []) {
        if (!segmentIds.has(timing.segmentId)) return { status: "UNKNOWN", reason: "TIMING_SEGMENT_REFERENCE_UNRESOLVED" };
        if (!/^(?:0|[1-9][0-9]*)$/u.test(timing.start) || !/^(?:0|[1-9][0-9]*)$/u.test(timing.end)) {
          return { status: "UNKNOWN", reason: "TIMING_DECIMAL_ENCODING_INVALID" };
        }
        const start = BigInt(timing.start);
        const end = BigInt(timing.end);
        if (start > maxSafe || end > maxSafe || end <= start) {
          return { status: "UNKNOWN", reason: "TIMING_INTERVAL_INVALID_OR_UNSAFE" };
        }
        if (timing.unit === "SOURCE_TICKS" && payload.sourceDurationTicks !== undefined
          && end > BigInt(payload.sourceDurationTicks)) {
          return { status: "UNKNOWN", reason: "TIMING_EXCEEDS_EXACT_SOURCE_DURATION" };
        }
      }
      if (payload.ticksPerSecond !== undefined && BigInt(payload.ticksPerSecond) > maxSafe) {
        return { status: "UNKNOWN", reason: "SOURCE_CLOCK_RATE_UNSAFE" };
      }

      if (typeof verifyExpectedRead !== "function"
        || verifyExpectedRead(expectedRead, { trustedContext, request: canonicalRequest }) !== true) {
        return { status: "UNKNOWN", reason: "EXPECTED_HOST_READ_TUPLE_NOT_VERIFIED" };
      }

      // This callback authenticates the host-issued receipt (for example, by
      // validating an authenticated host channel or signed proof). It does not
      // replace the exact local identity, digest, schema, or freshness checks.
      if (typeof verifyTrustedRead !== "function"
        || verifyTrustedRead(trustedRead, { trustedContext, request: canonicalRequest, payload, expectedRead }) !== true) {
        return { status: "UNKNOWN", reason: "HOST_READ_RECEIPT_AUTHENTICATION_FAILED" };
      }
      return { status: "OBSERVED", observation: structuredClone(payload) };
    }

    if (typeof validateLegacy === "function" && validateLegacy(payload) === true) {
      // Source shape can be recognized without establishing current read
      // authority. Do not expose content to a consumer on this branch.
      return {
        status: "LEGACY_UNSCOPED_OBSERVATION",
        kind: "LEGACY_TRANSCRIPTION_RESULT",
        canonicalTranscriptVersion: "NOT_ESTABLISHED",
        displayAuthorization: "NOT_ESTABLISHED",
      };
    }
    return { status: "UNKNOWN", reason: "NO_VALID_CANONICAL_OR_LEGACY_BRANCH" };
  } catch {
    return { status: "UNKNOWN", reason: "MALFORMED_OR_UNVERIFIABLE_READ" };
  }
}
