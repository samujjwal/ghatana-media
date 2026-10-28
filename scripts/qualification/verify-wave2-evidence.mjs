#!/usr/bin/env node
/**
 * Offline Wave 2 evidence intake integrity checker. NOT a policy/consent authority,
 * model admission system or proof of scientific quality. Uses Node built-ins only.
 */
import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';
import { createReadStream, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const sourceRoot = resolve(here, '../..');
const catalogPath = join(sourceRoot, 'config/qualification/wave2-reference-candidates.v1.json');
const trustPath = join(sourceRoot, 'config/qualification/wave2-trusted-reviewers.v1.json');
const SHA = /^[a-f0-9]{64}$/u;
const ALLOWED_PURPOSES = new Set(['LOCAL_EVALUATION', 'BENCHMARK_WITH_USAGE_RIGHTS', 'DEVELOPMENT_TEST_ONLY', 'PRODUCTION']);
export const SCHEMA = 'ghatana.media.wave2.evidence-packet.v1';

function err(code) { const e = new Error(code); e.code = code; return e; }
function parseJsonFile(path, limit = 2_000_000) {
  const file = lstatSync(path);
  if (!file.isFile() || file.isSymbolicLink() || file.size > limit) throw err('UNTRUSTED_OR_OVERSIZED_JSON');
  return JSON.parse(readFileSync(path, 'utf8'));
}
function textField(value, max = 512) {
  return typeof value === 'string' && value.length > 0 && value.length <= max
    && !/[\x00-\x1F\x7F]/u.test(value);
}
function safePath(root, relativePath) {
  if (!textField(relativePath, 400) || isAbsolute(relativePath)
      || relativePath.includes('\\') || relativePath.includes('\0')) throw err('INVALID_PRIVATE_RELATIVE_PATH');
  const segments = relativePath.split('/');
  if (segments.some(v => !v || v === '.' || v === '..')) throw err('INVALID_PRIVATE_RELATIVE_PATH');
  const base = realpathSync(root);
  let current = base;
  for (const segment of segments) {
    current = join(current, segment);
    const stat = lstatSync(current);
    if (stat.isSymbolicLink()) throw err('SYMLINKED_PRIVATE_EVIDENCE_PATH');
  }
  if (relative(base, current).startsWith('..' + sep) || relative(base, current) === '..') {
    throw err('PRIVATE_EVIDENCE_ESCAPES_ROOT');
  }
  if (!lstatSync(current).isFile()) throw err('PRIVATE_EVIDENCE_NOT_REGULAR_FILE');
  return current;
}
async function hashFile(file, maxBytes) {
  const stat = lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maxBytes) throw err('EVIDENCE_FILE_TOO_LARGE_OR_UNSAFE');
  const digest = createHash('sha256');
  let bytes = 0;
  for await (const block of createReadStream(file, { highWaterMark: 64 * 1024 })) {
    bytes += block.length;
    if (bytes > maxBytes) throw err('EVIDENCE_FILE_EXCEEDED_BYTE_BOUND');
    digest.update(block);
  }
  const after = lstatSync(file);
  if (after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ino !== stat.ino) {
    throw err('EVIDENCE_FILE_CHANGED_DURING_READ');
  }
  return { sizeBytes: bytes, sha256: digest.digest('hex') };
}
export function validateCatalog(catalog) {
  if (catalog?.schemaVersion !== 'ghatana.media.wave2.reference-candidates.v1'
      || catalog?.operationalPolicy?.noCandidateIsAdmitted !== true
      || !Array.isArray(catalog?.candidates) || catalog.candidates.length === 0) {
    throw err('INVALID_CANDIDATE_CATALOG');
  }
  const ids = new Set();
  for (const candidate of catalog.candidates) {
    if (!textField(candidate.id, 100) || ids.has(candidate.id)
        || candidate.status !== 'REVIEW_ONLY'
        || !ALLOWED_PURPOSES.has(candidate.proposedUse)
        || candidate.proposedUse === 'PRODUCTION'
        || !Array.isArray(candidate.requiredProofTypes)
        || !Number.isSafeInteger(candidate.maxBytes) || candidate.maxBytes <= 0
        || candidate.maxBytes > 230_000_000
        || (candidate.artifactSha256 !== null && !SHA.test(candidate.artifactSha256))) {
      throw err('INVALID_SOURCE_RESEARCH_CANDIDATE');
    }
    ids.add(candidate.id);
  }
  return { candidates: catalog.candidates.length, candidateIds: [...ids].sort(),
    currentStatus: 'SOURCE_CANDIDATES_ONLY', productionAdmitted: false };
}
function verifyReceipt(receipt, packet, candidate, trust, privateRoot, now) {
  if (!textField(receipt.kind, 100) || !textField(receipt.signerId, 100)) throw err('INVALID_RECEIPT_IDENTITY');
  const signer = trust.trustedReviewers.find(item => item.id === receipt.signerId);
  if (!signer || !Array.isArray(signer.allowedKinds) || !signer.allowedKinds.includes(receipt.kind)
      || typeof signer.publicKeyPem !== 'string' || signer.publicKeyPem.length > 8192
      || !signer.publicKeyPem.includes('-----BEGIN PUBLIC KEY-----')) throw err('UNTRUSTED_EVIDENCE_SIGNER');
  const messagePath = safePath(privateRoot, receipt.document);
  const signaturePath = safePath(privateRoot, receipt.signature);
  const bytes = readFileSync(messagePath);
  if (bytes.length > 64_000) throw err('RECEIPT_TOO_LARGE');
  const rawSig = readFileSync(signaturePath, 'utf8').trim();
  if (!/^[A-Za-z0-9+/]{86}==?$/u.test(rawSig)) throw err('MALFORMED_RECEIPT_SIGNATURE');
  const signature = Buffer.from(rawSig, 'base64');
  if (signature.length !== 64 || !verifySignature(null, bytes,
      createPublicKey(signer.publicKeyPem), signature)) throw err('INVALID_RECEIPT_SIGNATURE');
  const body = JSON.parse(bytes.toString('utf8'));
  if (body.schemaVersion !== 'ghatana.media.wave2.signed-authorization.v1'
      || body.subjectId !== packet.candidateId || body.kind !== receipt.kind
      || body.signerId !== receipt.signerId || body.decision !== 'ALLOW'
      || body.scope !== packet.purpose || !textField(body.decisionReference)
      || !textField(body.evidenceSourceRef) || body.assetSha256 !== packet.primaryArtifactSha256
      || !Array.isArray(body.permittedPurposes) || !body.permittedPurposes.includes(packet.purpose)) {
    throw err('RECEIPT_SUBJECT_OR_SCOPE_MISMATCH');
  }
  const validFrom = Date.parse(body.validFrom);
  const validUntil = Date.parse(body.validUntil);
  if (!Number.isFinite(validFrom) || !Number.isFinite(validUntil)
      || validFrom > now || validUntil <= now) throw err('EXPIRED_OR_NOT_YET_VALID_RECEIPT');
  if (receipt.kind === 'VOICE_LIKENESS_RIGHTS' || receipt.kind === 'RECORDING_SOURCE_RIGHTS'
      || receipt.kind === 'HUMAN_BIOMETRIC_CONSENT') {
    if (!textField(body.revocationAuthorityRef)
        || !textField(body.privateConsentDocumentSha256)
        || !SHA.test(body.privateConsentDocumentSha256)) throw err('MISSING_REVOCABLE_SOURCE_CONSENT');
  }
  return { kind: receipt.kind, signer: signer.id, decisionRef: body.decisionReference,
    expiresAt: body.validUntil };
}
export async function verifyEvidencePacket(packet, { catalog, trust, privateRoot, now = Date.now() }) {
  validateCatalog(catalog);
  if (packet?.schemaVersion !== SCHEMA || !textField(packet.candidateId, 100)
      || !ALLOWED_PURPOSES.has(packet.purpose)
      || !Array.isArray(packet.artifacts) || !Array.isArray(packet.receipts)
      || !SHA.test(packet.primaryArtifactSha256)) throw err('INVALID_QUALIFICATION_PACKET');
  const candidate = catalog.candidates.find(item => item.id === packet.candidateId);
  if (!candidate) throw err('UNKNOWN_SOURCE_CANDIDATE');
  if (packet.purpose !== candidate.proposedUse) throw err('UNSUPPORTED_CANDIDATE_PURPOSE');
  if (!Array.isArray(trust?.trustedReviewers) || trust.trustedReviewers.length === 0) {
    throw err('NO_PINNED_TRUST_ANCHORS');
  }
  if (!existsSync(privateRoot)) throw err('MISSING_PRIVATE_EVIDENCE_ROOT');
  if (candidate.artifactSha256 === null || candidate.artifactSha256 !== packet.primaryArtifactSha256) {
    throw err('ARTIFACT_NEEDS_INDEPENDENT_UPSTREAM_SHA256_PIN');
  }
  if (!packet.artifacts.some(item => item.role === 'primary'
      && item.sha256 === packet.primaryArtifactSha256)) throw err('MISSING_ANCHORED_PRIMARY_ASSET');
  const verifiedFiles = [];
  const roles = new Set();
  for (const asset of packet.artifacts) {
    if (!textField(asset.role, 100) || roles.has(asset.role)
        || !SHA.test(asset.sha256)) throw err('INVALID_PACKET_ARTIFACT');
    roles.add(asset.role);
    const file = safePath(privateRoot, asset.path);
    const h = await hashFile(file, candidate.maxBytes);
    if (h.sha256 !== asset.sha256) throw err('PACKET_ARTIFACT_DIGEST_MISMATCH');
    verifiedFiles.push({ role: asset.role, sha256: h.sha256, sizeBytes: h.sizeBytes });
  }
  const receipts = [];
  for (const receipt of packet.receipts) {
    receipts.push(verifyReceipt(receipt, packet, candidate, trust, privateRoot, now));
  }
  const kinds = new Set(receipts.map(r => r.kind));
  for (const kind of candidate.requiredProofTypes) {
    if (!kinds.has(kind)) throw err('MISSING_REQUIRED_SIGNED_PROOF_' + kind);
  }
  return {
    candidateId: packet.candidateId, sourceBytesVerified: true,
    exactSignedReceiptTypes: [...kinds].sort(), verifiedFiles,
    status: 'INTEGRITY_CHECKED_INDEPENDENT_OWNER_REVIEW_REQUIRED',
    productionAdmitted: false,
    note: 'This tool never approves legal rights, voice identity, source permission or provider quality; production dispatch must re-evaluate current Shared policy and Media consent.'
  };
}

async function cli() {
  const args = process.argv.slice(2);
  const input = args.indexOf('--packet');
  const privateFlag = args.indexOf('--private-root');
  const catalog = parseJsonFile(catalogPath);
  const summary = validateCatalog(catalog);
  if (input < 0) { console.log(JSON.stringify(summary, null, 2)); return; }
  if (privateFlag < 0 || !args[input + 1] || !args[privateFlag + 1]) throw err('MISSING_PRIVATE_PACKET_INPUT');
  const packet = parseJsonFile(resolve(args[input + 1]));
  const trust = parseJsonFile(trustPath);
  const result = await verifyEvidencePacket(packet,
    { catalog, trust, privateRoot: resolve(args[privateFlag + 1]) });
  console.log(JSON.stringify(result, null, 2));
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  cli().catch(e => { console.error(JSON.stringify({ status:'BLOCKED', reason:e.code || 'MALFORMED_EVIDENCE' })); process.exitCode = 1; });
}
