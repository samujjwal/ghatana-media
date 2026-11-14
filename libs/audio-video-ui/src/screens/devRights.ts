/**
 * DEV_ONLY rights and consent host boundary.
 *
 * Owner decision (2026-11-14): "Uploader + reviewer (Recommended): The uploader states rights and consent for each
 * source version. A second person must confirm before any voice or likeness use, or before any external delivery.
 * Every statement records who gave it, when and for which exact file, and can be revoked."
 *
 * The attesting principal is always the host's authenticated caller; nothing here sends a principal id as the actor.
 * These records are statements by DEV_ONLY identities. They are not a legal determination and not human approval.
 */

import { DevOutputsHostError, type DevHostResponse, type Outcome, type OutcomeTone } from "./devProjectOutputs";

export type DevRightsStatementKind = "MEDIA_RIGHTS" | "IDENTIFIABLE_PERSON_CONSENT";
export type DevRightsScope = "PROCESSING" | "VOICE_OR_LIKENESS_USE" | "EXTERNAL_DELIVERY";
export type DevRightsStatus = "PENDING_CONFIRMATION" | "CONFIRMED" | "NOT_REQUIRED_TO_CONFIRM" | "REVOKED" | "EXPIRED";
export type DevRightsVerdict = "ADMITTED" | "DENIED" | "REVOKED" | "STALE" | "MISMATCH" | "UNAVAILABLE";

export const DEV_RIGHTS_STATEMENT_KINDS: readonly DevRightsStatementKind[] = ["MEDIA_RIGHTS", "IDENTIFIABLE_PERSON_CONSENT"];
export const DEV_RIGHTS_SCOPES: readonly DevRightsScope[] = ["PROCESSING", "VOICE_OR_LIKENESS_USE", "EXTERNAL_DELIVERY"];
/** Scopes that are admitted only after a different principal confirms. */
export const DEV_RIGHTS_CONFIRMED_SCOPES: readonly DevRightsScope[] = ["VOICE_OR_LIKENESS_USE", "EXTERNAL_DELIVERY"];

export interface DevRightsAttestRequest {
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly statementKind: DevRightsStatementKind;
  readonly scopes: readonly DevRightsScope[];
  readonly basis: string;
  /** `<artifactId>@<versionId>` of a supporting document the caller can read. */
  readonly supportingDocumentArtifactRef?: string;
  readonly requestedConfirmerPrincipalId?: string;
  /** ISO-8601 UTC instant in the future. */
  readonly expiresAt?: string;
}

/** Host port. A host without the rights lane omits these methods and the UI says so. */
export interface DevRightsPort {
  /** POST /dev/v1/rights/attestations */
  createRightsAttestation(request: DevRightsAttestRequest): Promise<DevHostResponse>;
  /** GET /dev/v1/rights/attestations/{attestationId} */
  getRightsAttestation(attestationId: string): Promise<DevHostResponse>;
  /** POST /dev/v1/rights/attestations/{attestationId}/confirm (a principal other than the attester) */
  confirmRightsAttestation(attestationId: string, request: { readonly note?: string }): Promise<DevHostResponse>;
  /** POST /dev/v1/rights/attestations/{attestationId}/revoke (attester or confirmer) */
  revokeRightsAttestation(attestationId: string, request: { readonly reason: string }): Promise<DevHostResponse>;
  /** GET /dev/v1/rights/artifacts/{artifactId}/versions/{versionId}/attestations (owner scope) */
  listRightsAttestations(artifactId: string, artifactVersionId: string): Promise<DevHostResponse>;
}

export interface DevRightsConfirmation { readonly confirmingPrincipalId: string; readonly confirmedAt: string; readonly note: string | null }
export interface DevRightsRevocation { readonly revokedByPrincipalId: string; readonly revokedAt: string; readonly reason: string }

export interface DevRightsAttestation {
  readonly attestationId: string;
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly contentSha256: string;
  readonly attestingPrincipalId: string;
  readonly attestedAt: string;
  readonly statementKind: DevRightsStatementKind;
  readonly scopes: readonly DevRightsScope[];
  readonly basis: string;
  readonly supportingDocumentArtifactRef: string | null;
  readonly requestedConfirmerPrincipalId: string | null;
  readonly expiresAt: string | null;
  readonly requiresSecondPersonConfirmation: boolean;
  readonly status: DevRightsStatus;
  readonly confirmation: DevRightsConfirmation | null;
  readonly revocation: DevRightsRevocation | null;
}

export interface DevRightsAdmission {
  readonly scope: DevRightsScope;
  readonly verdict: DevRightsVerdict;
  readonly reasons: readonly string[];
}

export interface DevRightsVersionView {
  readonly artifactId: string;
  readonly artifactVersionId: string;
  readonly attestations: readonly DevRightsAttestation[];
  readonly admission: readonly DevRightsAdmission[];
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json => !!value && typeof value === "object" && !Array.isArray(value);
const bad = (message: string): never => { throw new DevOutputsHostError("INVALID_RESPONSE", 200, message); };
const str = (value: unknown, field: string): string => typeof value === "string" && value.length > 0 ? value : bad(`Missing ${field}.`);
const optStr = (value: unknown, field: string): string | null => value === null || value === undefined ? null : str(value, field);
const oneOf = <T extends string>(value: unknown, allowed: readonly T[], field: string): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? value as T : bad(`Unrecognised ${field}.`);

const STATUSES: readonly DevRightsStatus[] = ["PENDING_CONFIRMATION", "CONFIRMED", "NOT_REQUIRED_TO_CONFIRM", "REVOKED", "EXPIRED"];
const VERDICTS: readonly DevRightsVerdict[] = ["ADMITTED", "DENIED", "REVOKED", "STALE", "MISMATCH", "UNAVAILABLE"];

/** Accepts an attestation only when the host marks it DEV_ONLY and never an approval. */
export function parseRightsAttestation(raw: unknown): DevRightsAttestation {
  if (!isRecord(raw)) return bad("Attestation must be an object.");
  if (raw.scope !== "DEV_ONLY" || raw.establishesApproval !== false) return bad("Attestation is not a DEV_ONLY non-approval statement.");
  const scopes = Array.isArray(raw.scopes) ? raw.scopes.map((scope) => oneOf(scope, DEV_RIGHTS_SCOPES, "scope")) : bad("Missing scopes.");
  if (scopes.length === 0) bad("Missing scopes.");
  const confirmation = raw.confirmation === null || raw.confirmation === undefined ? null : (() => {
    if (!isRecord(raw.confirmation)) return bad("Invalid confirmation.");
    return { confirmingPrincipalId: str(raw.confirmation.confirmingPrincipalId, "confirmingPrincipalId"),
      confirmedAt: str(raw.confirmation.confirmedAt, "confirmedAt"), note: optStr(raw.confirmation.note, "note") };
  })();
  const revocation = raw.revocation === null || raw.revocation === undefined ? null : (() => {
    if (!isRecord(raw.revocation)) return bad("Invalid revocation.");
    return { revokedByPrincipalId: str(raw.revocation.revokedByPrincipalId, "revokedByPrincipalId"),
      revokedAt: str(raw.revocation.revokedAt, "revokedAt"), reason: str(raw.revocation.reason, "reason") };
  })();
  const attestingPrincipalId = str(raw.attestingPrincipalId, "attestingPrincipalId");
  if (confirmation && confirmation.confirmingPrincipalId === attestingPrincipalId) return bad("A confirmation by the attester is not valid.");
  return {
    attestationId: str(raw.attestationId, "attestationId"), artifactId: str(raw.artifactId, "artifactId"),
    artifactVersionId: str(raw.artifactVersionId, "artifactVersionId"), contentSha256: str(raw.contentSha256, "contentSha256"),
    attestingPrincipalId, attestedAt: str(raw.attestedAt, "attestedAt"),
    statementKind: oneOf(raw.statementKind, DEV_RIGHTS_STATEMENT_KINDS, "statementKind"), scopes,
    basis: str(raw.basis, "basis"), supportingDocumentArtifactRef: optStr(raw.supportingDocumentArtifactRef, "supportingDocumentArtifactRef"),
    requestedConfirmerPrincipalId: optStr(raw.requestedConfirmerPrincipalId, "requestedConfirmerPrincipalId"),
    expiresAt: optStr(raw.expiresAt, "expiresAt"), requiresSecondPersonConfirmation: raw.requiresSecondPersonConfirmation === true,
    status: oneOf(raw.status, STATUSES, "status"), confirmation, revocation,
  };
}

/** Accepts a listing only when it is bound to exactly the requested artifact version. */
export function parseRightsVersionView(raw: unknown, expected: { readonly artifactId: string; readonly artifactVersionId: string }): DevRightsVersionView {
  if (!isRecord(raw) || raw.scope !== "DEV_ONLY" || raw.establishesApproval !== false) return bad("Listing is not a DEV_ONLY non-approval view.");
  if (raw.artifactId !== expected.artifactId || raw.artifactVersionId !== expected.artifactVersionId) return bad("Listing is for a different artifact version.");
  const attestations = Array.isArray(raw.attestations) ? raw.attestations.map(parseRightsAttestation) : bad("Missing attestations.");
  for (const attestation of attestations) {
    if (attestation.artifactId !== expected.artifactId || attestation.artifactVersionId !== expected.artifactVersionId) bad("Attestation is for a different version.");
  }
  const admissionRaw = isRecord(raw.admission) ? raw.admission : bad("Missing admission.");
  const admission = DEV_RIGHTS_SCOPES.map((scope): DevRightsAdmission => {
    const entry = admissionRaw[scope];
    if (!isRecord(entry) || entry.scope !== scope) return bad(`Missing admission for ${scope}.`);
    return { scope, verdict: oneOf(entry.verdict, VERDICTS, "verdict"),
      reasons: Array.isArray(entry.reasons) ? entry.reasons.filter((reason): reason is string => typeof reason === "string") : [] };
  });
  return { artifactId: expected.artifactId, artifactVersionId: expected.artifactVersionId, attestations, admission };
}

export type RightsGate =
  | { readonly allowed: true }
  | { readonly allowed: false; readonly reason: string };

/** Whether this principal may confirm. The host enforces the same rules; this only explains a disabled control. */
export function confirmGate(attestation: DevRightsAttestation, principalId: string | undefined): RightsGate {
  if (attestation.status === "REVOKED") return { allowed: false, reason: "This statement is revoked." };
  if (attestation.status === "EXPIRED") return { allowed: false, reason: "This statement has expired." };
  if (attestation.confirmation) return { allowed: false, reason: "Already confirmed." };
  if (!attestation.requiresSecondPersonConfirmation) return { allowed: false, reason: "No scope of this statement needs a second-person confirmation." };
  if (!principalId) return { allowed: false, reason: "The identity of this page is not known, so confirmation stays disabled." };
  if (principalId === attestation.attestingPrincipalId) return { allowed: false, reason: "You gave this statement. A second person must confirm it." };
  if (attestation.requestedConfirmerPrincipalId && attestation.requestedConfirmerPrincipalId !== principalId) {
    return { allowed: false, reason: "The uploader asked a different person to confirm this statement." };
  }
  return { allowed: true };
}

/** Attester or confirmer may revoke an unrevoked statement. */
export function revokeGate(attestation: DevRightsAttestation, principalId: string | undefined): RightsGate {
  if (attestation.status === "REVOKED") return { allowed: false, reason: "Already revoked." };
  if (!principalId) return { allowed: false, reason: "The identity of this page is not known, so revocation stays disabled." };
  if (principalId === attestation.attestingPrincipalId || attestation.confirmation?.confirmingPrincipalId === principalId) return { allowed: true };
  return { allowed: false, reason: "Only the person who gave the statement or the person who confirmed it can revoke it." };
}

/** Maps a typed host failure to an honest message. Nothing is ever reported as admitted on failure. */
export function describeRightsFailure(error: unknown): Outcome {
  const make = (tone: OutcomeTone, code: string, text: string): Outcome => ({ tone, code, text, retrySameRequest: false, discardRequest: false });
  if (!(error instanceof DevOutputsHostError)) {
    return make("unknown", "OUTCOME_UNKNOWN", "The outcome is unknown. Re-read the statement before trying again; a duplicate statement is harmless but is a second record.");
  }
  const { status, code } = error;
  if (status === 0 || code === "OUTCOME_UNKNOWN" || code === "INVALID_RESPONSE") {
    return make("unknown", code, "The outcome is unknown. Re-read the statement before trying again; a duplicate statement is harmless but is a second record.");
  }
  if (code === "SELF_CONFIRMATION_REFUSED") return make("denied", code, "Refused: the person who gave a statement cannot confirm it. A second person must confirm.");
  if (code === "ATTESTATION_NOT_DESIGNATED_CONFIRMER") return make("denied", code, "Refused: the uploader asked a different person to confirm this statement.");
  if (code === "ATTESTATION_NOT_PERMITTED_TO_REVOKE") return make("denied", code, "Refused: only the person who gave the statement or the person who confirmed it can revoke it.");
  if (code === "ARTIFACT_PERMISSION_REQUIRED" || status === 403) return make("denied", code, "Denied: this DEV_ONLY identity lacks the permission for this rights action (project write, plus artifact read to state rights).");
  if (code === "ARTIFACT_VERSION_NOT_FOUND") return make("error", code, "The exact artifact version is not available to this DEV_ONLY identity, so nothing was recorded. Only the owner of a version can state rights for it.");
  if (code === "ATTESTATION_NOT_FOUND") return make("error", code, "No statement with this id is visible to this identity.");
  if (status === 409) return make("error", code, code === "ATTESTATION_ALREADY_CONFIRMED" ? "This statement is already confirmed."
    : code === "ATTESTATION_ALREADY_REVOKED" ? "This statement is already revoked."
    : code === "ATTESTATION_REVOKED" ? "This statement is revoked and can no longer be confirmed."
    : code === "ATTESTATION_EXPIRED" ? "This statement has expired."
    : "This statement does not need, or cannot take, that action.");
  if (status === 400 || status === 422) return make("error", code, "The host refused the statement as malformed. Nothing was recorded.");
  if (status === 404) return make("unavailable", code, "The rights lane is not available on this host. Nothing was recorded.");
  if (status === 503 || status >= 500) return make("unavailable", code, "The rights authority is unavailable. Nothing was recorded or changed that you can rely on; re-read before retrying.");
  return make("error", code, `The host refused the request (${status} ${code}).`);
}
