// Fail-closed provider qualification gate (scanner, Document Intelligence, English/Nepali STT).
// Pure decision logic: ADMITTED only when EVERY required evidence kind is present, unexpired, verified by an
// injected independent verifier and bound to the probed provider identity. Anything else is
// NOT_ADMITTED (nothing/insufficient evidence, dev-only adapter) or UNKNOWN (provider or evidence cannot be
// assessed). No default verifier exists, so this module can never self-admit a provider.
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const STATUS = Object.freeze({ ADMITTED: 'ADMITTED', NOT_ADMITTED: 'NOT_ADMITTED', UNKNOWN: 'UNKNOWN' });
const here = path.dirname(fileURLToPath(import.meta.url));
export const loadRequirements = (file = path.join(here, '../../config/provider-qualification/requirements.json')) =>
  JSON.parse(readFileSync(file, 'utf8')).providers;

/**
 * @param {{provider:string, requirements:object, probe?:{reachable:boolean, identity?:string, devOnly?:boolean},
 *          evidence?:Array<{kind:string, subjectIdentity:string, expiresAt:string}>,
 *          verifyEvidence?:(e:object)=>boolean, now?:Date}} input
 */
export function evaluateQualification({ provider, requirements, probe, evidence = [], verifyEvidence, now = new Date() }) {
  const req = requirements?.[provider];
  const result = (status, reasonCode, missing = []) => ({
    provider, status, reasonCode, missing,
    clinicalOutcomeAllowed: status === STATUS.ADMITTED,
  });
  if (!req) return result(STATUS.NOT_ADMITTED, 'UNKNOWN_PROVIDER');
  const missing = req.required.map((r) => r.kind);
  if (!probe || probe.reachable !== true) return result(STATUS.UNKNOWN, 'PROVIDER_UNREACHABLE', missing);
  if (probe.devOnly === true) return result(STATUS.NOT_ADMITTED, 'DEV_ONLY_ADAPTER', missing);
  if (typeof probe.identity !== 'string' || !probe.identity) return result(STATUS.UNKNOWN, 'PROVIDER_IDENTITY_UNKNOWN', missing);
  if (typeof verifyEvidence !== 'function') return result(STATUS.NOT_ADMITTED, 'NO_INDEPENDENT_VERIFIER', missing);

  const unmet = [];
  let unverifiable = false;
  for (const r of req.required) {
    const ok = evidence.some((e) => {
      if (e.kind !== r.kind) return false;
      if (e.subjectIdentity !== probe.identity) return false;
      const exp = Date.parse(e.expiresAt);
      if (!Number.isFinite(exp) || exp <= now.getTime()) return false;
      try { return verifyEvidence(e) === true; } catch { unverifiable = true; return false; }
    });
    if (!ok) unmet.push(r.kind);
  }
  if (unmet.length === 0) return result(STATUS.ADMITTED, 'ALL_EVIDENCE_VERIFIED');
  return result(unverifiable ? STATUS.UNKNOWN : STATUS.NOT_ADMITTED, unverifiable ? 'EVIDENCE_UNVERIFIABLE' : 'EVIDENCE_MISSING_OR_STALE', unmet);
}

/** Guard for any "successful" provider outcome (CLEAN, SUCCEEDED, extracted text...): refuses unless admitted. */
export function guardSuccessfulOutcome(qualification, outcome) {
  if (qualification?.status === STATUS.ADMITTED && qualification.clinicalOutcomeAllowed === true) return outcome;
  return { status: qualification?.status === STATUS.UNKNOWN ? STATUS.UNKNOWN : STATUS.NOT_ADMITTED, reasonCode: qualification?.reasonCode ?? 'NO_QUALIFICATION', outcomeWithheld: true };
}
