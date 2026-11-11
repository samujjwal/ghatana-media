import type { CaptionVersionRegistered } from "@audio-video/client";

export interface CaptionVersionReadScope {
  readonly tenantId: string;
  readonly principalId: string;
  readonly sourceArtifactId: string;
  readonly sourceArtifactVersionId: string;
}

const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9_.:\-]{0,255}$/u;
const REQUEST_ID = /^[A-Za-z0-9._~-]{1,128}$/u;
const SHA256 = /^[0-9a-f]{64}$/u;

export function hasValidCaptionVersionReadScope(scope: CaptionVersionReadScope): boolean {
  return OPAQUE_ID.test(scope.tenantId) && OPAQUE_ID.test(scope.principalId)
    && OPAQUE_ID.test(scope.sourceArtifactId) && OPAQUE_ID.test(scope.sourceArtifactVersionId);
}

/** Validate and snapshot the entire caller-scoped response before exposing any row. */
export function bindCaptionVersionRows(
  input: unknown,
  scope: CaptionVersionReadScope,
): readonly CaptionVersionRegistered[] | undefined {
  if (!hasValidCaptionVersionReadScope(scope)
    || !Array.isArray(input) || input.length > 4096) return undefined;

  const rows: CaptionVersionRegistered[] = [];
  const ids = new Set<string>();
  for (const value of input) {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const row = value as Partial<CaptionVersionRegistered>;
    const registeredAt = row.registeredAt;
    if (typeof row.requestId !== "string" || !REQUEST_ID.test(row.requestId)
      || typeof row.requestFingerprint !== "string" || !SHA256.test(row.requestFingerprint)
      || typeof row.captionVersionId !== "string" || !OPAQUE_ID.test(row.captionVersionId)
      || ids.has(row.captionVersionId)
      || typeof row.registrationReceiptId !== "string" || !OPAQUE_ID.test(row.registrationReceiptId)
      || row.sourceArtifactId !== scope.sourceArtifactId
      || row.sourceArtifactVersionId !== scope.sourceArtifactVersionId
      || (row.parentVersionKind !== "TRANSCRIPT_VERSION" && row.parentVersionKind !== "CAPTION_VERSION")
      || typeof row.parentVersionId !== "string" || !OPAQUE_ID.test(row.parentVersionId)
      || (row.languageDisposition !== "NOT_SELECTED"
        && row.languageDisposition !== "DECLARED_BY_USER"
        && row.languageDisposition !== "UNCERTAIN")
      || typeof row.sourceClockId !== "string" || !OPAQUE_ID.test(row.sourceClockId)
      || typeof registeredAt !== "number" || !Number.isSafeInteger(registeredAt) || registeredAt < 0) return undefined;
    ids.add(row.captionVersionId);
    rows.push({
      requestId: row.requestId,
      requestFingerprint: row.requestFingerprint,
      captionVersionId: row.captionVersionId,
      registrationReceiptId: row.registrationReceiptId,
      sourceArtifactId: row.sourceArtifactId,
      sourceArtifactVersionId: row.sourceArtifactVersionId,
      parentVersionKind: row.parentVersionKind,
      parentVersionId: row.parentVersionId,
      languageDisposition: row.languageDisposition,
      sourceClockId: row.sourceClockId,
      registeredAt,
    });
  }
  return Object.freeze(rows.map((row) => Object.freeze(row)));
}

export function captionVersionReadScopeKey(scope: CaptionVersionReadScope): string {
  return JSON.stringify([
    scope.tenantId,
    scope.principalId,
    scope.sourceArtifactId,
    scope.sourceArtifactVersionId,
  ]);
}
