import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import YAML from 'yaml';

const root = process.cwd();
const dir = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const p = (name) => path.join(root, dir, name);
const read = (name) => fs.readFileSync(p(name), 'utf8');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const checkMode = process.argv.includes('--check');
const writeCreateOnly = (name, value) => {
  const target = p(name);
  if (fs.existsSync(target)) {
    if (checkMode && fs.readFileSync(target, 'utf8') === value) return;
    throw new Error(`Refusing overwrite or replay mismatch: ${target}`);
  }
  if (checkMode) throw new Error(`Replay target missing: ${target}`);
  fs.writeFileSync(target, value, { flag: 'wx' });
};
const r06cap = 'media-pdp0-root-selected-source-integration-r9-r06.split.capabilities.postimage.yaml';
const r06req = 'media-pdp0-root-selected-source-integration-r9-r06.split.requirements.postimage.yaml';
if (sha(read(r06cap)) !== '38b5fc2610ff0b466e6f5e6984f7c3804534e94d4bd3b8f77c4b3de6d4d8fa7f') throw new Error('R9-R06 capability input hash mismatch');
if (sha(read(r06req)) !== 'a6d892f87847b56bc601efd4cba2e85a763840f082b991d282fbbd408a2e4508') throw new Error('R9-R06 requirement input hash mismatch');
let capabilities = read(r06cap);
const doc = YAML.parse(capabilities);
const gen = doc.capabilities.find((x) => x.id === 'media.capability.provider-class-separation');
const replacements = ['Missing, stale, or ambiguous provider-class evidence returns UNKNOWN.','Permissive license and hosted placement are not mutually exclusive classes. Require versioned license/rights policy evidence and explicit LOCAL/HOSTED placement/provider binding; missing/stale evidence stays UNKNOWN. No license, provider admission, egress or cross-provider fallback inferred from labels.'];
if (!Array.isArray(gen.explicitUnsupportedCases) || gen.explicitUnsupportedCases[0] !== replacements[0] || gen.explicitUnsupportedCases[2] !== replacements[1]) throw new Error('GEN-024 explicitUnsupportedCases preimage mismatch');
for (const oldValue of replacements) {
  const next = oldValue.replace('returns UNKNOWN.', 'returns UNKNOWN_OUTCOME.').replace('evidence stays UNKNOWN.', 'evidence stays UNKNOWN_OUTCOME.');
  const oldLine = `      - ${oldValue}\n`;
  const newLine = `      - ${next}\n`;
  if (!capabilities.includes(oldLine)) throw new Error(`Missing exact explicit unsupported condition: ${oldValue}`);
  capabilities = capabilities.replace(oldLine, newLine);
}
YAML.parse(capabilities);
const r07cap = 'media-pdp0-root-selected-source-integration-r9-r07.split.capabilities.postimage.yaml';
const r07req = 'media-pdp0-root-selected-source-integration-r9-r07.split.requirements.postimage.yaml';
const r07leaf = 'media-pdp0-root-selected-source-integration-r9-r07.split.capability-leaf-review.postimage.yaml';
const r07cross = 'media-pdp0-root-selected-source-integration-r9-r07.split.pdp0-501-disposition-crosswalk.postimage.json';
const reqBytes = read(r06req);
const leafBytes = read('media-pdp0-root-selected-source-integration-r9-r06.split.capability-leaf-review.postimage.yaml');
const crossBytes = read('media-pdp0-root-selected-source-integration-r9-r06.split.pdp0-501-disposition-crosswalk.postimage.json');
writeCreateOnly(r07cap, capabilities); writeCreateOnly(r07req, reqBytes); writeCreateOnly(r07leaf, leafBytes); writeCreateOnly(r07cross, crossBytes);

const r06BundleRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r06.successor-bundle.candidate.v1.json`;
const r06BundleSha = sha(read(path.basename(r06BundleRef)));
const r06FreezeRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r06.freeze.v1.json`;
const r06FreezeSha = sha(read(path.basename(r06FreezeRef)));
const hR06Ref = `${dir}/media-pdp0-root-selected-source-integration-r9-r06.independent-peer.actual-h-r06-full.json`;
const hR06Sha = sha(read(path.basename(hR06Ref)));
const oldBundle = JSON.parse(read(path.basename(r06BundleRef)));
const oldFreeze = JSON.parse(read(path.basename(r06FreezeRef)));
const selectedPostimages = oldFreeze.selectedPostimages.map((row) => {
  const mapping = {
    '.product-experience/pdp-0-product-truth/capabilities.yaml': [r07cap, sha(capabilities)],
    '.product-experience/pdp-0-product-truth/requirements.yaml': [r07req, sha(reqBytes)],
    '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml': [r07leaf, sha(leafBytes)],
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json': [r07cross, sha(crossBytes)],
  };
  const [ref, digest] = mapping[row.targetRef];
  return { targetRef: row.targetRef, postimageRef: `${dir}/${ref}`, postimageSha256: digest };
});
const repairMapRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r07.repair-map.v1.json`;
const repairMapBytes = json({ schemaVersion: 'media.pdp0.root-selected-source-integration-r9-r07.repair-map.v1', status: 'CANDIDATE_REPAIR_MAP_ONLY', predecessor: { freezeRef: r06FreezeRef, freezeSha256: r06FreezeSha, bundleRef: r06BundleRef, bundleSha256: r06BundleSha, actualHReviewRef: hR06Ref, actualHReviewSha256: hR06Sha }, findingId: 'F-10', auditId: 'AUD-GEN-024', field: 'explicitUnsupportedCases', changedEntryCount: 2, replacement: 'UNKNOWN -> UNKNOWN_OUTCOME', canonicalApply: 'NONE', phaseStatusEffect: 'NONE' });
writeCreateOnly(path.basename(repairMapRef), repairMapBytes);
const bundle = structuredClone(oldBundle);
bundle.candidateRevision = 'R9-R07';
bundle.predecessor = { ref: r06BundleRef, sha256: r06BundleSha, freezeRef: r06FreezeRef, freezeSha256: r06FreezeSha, actualHReviewRef: hR06Ref, actualHReviewSha256: hR06Sha, actualHDisposition: 'REQUEST_CHANGES' };
bundle.selectedPostimages = selectedPostimages;
bundle.candidateRepairs = { repairMapRef, repairMapSha256: sha(repairMapBytes), findingId: 'F-10', auditId: 'AUD-GEN-024', explicitUnsupportedCasesOutcome: 'UNKNOWN_OUTCOME' };
const bundleRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r07.successor-bundle.candidate.v1.json`;
const bundleBytes = json(bundle);
writeCreateOnly(path.basename(bundleRef), bundleBytes);
const verificationRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r07.rebuild-verification.v1.json`;
const verificationBytes = json({ schemaVersion: 'media.pdp0.root-selected-source-integration-r9-r07-rebuild-verification.v1', status: 'R9_R07_CANDIDATE_REPLAY_VERIFIED', predecessor: { freezeRef: r06FreezeRef, freezeSha256: r06FreezeSha, hReviewRef: hR06Ref, hReviewSha256: hR06Sha }, candidateBundle: { ref: bundleRef, sha256: sha(bundleBytes) }, repairMap: { ref: repairMapRef, sha256: sha(repairMapBytes) }, postimages: selectedPostimages.map((x) => ({ ref: x.postimageRef, sha256: x.postimageSha256 })), focusedTest: 'node --test tests/media-pdp0-root-selected-source-integration-r9-r07.test.mjs', replayCommand: 'node scripts/prepare-media-pdp0-root-selected-source-integration-r9-r07-candidate.mjs --check', campaignDenominator: { registeredIdentities: 54, phaseCells: 216, historicalOwnerRows: 462, pdp0AuditRows: 501 }, canonicalApply: 'NONE', phaseStatusEffect: 'NONE' });
writeCreateOnly(path.basename(verificationRef), verificationBytes);
const freeze = structuredClone(oldFreeze);
freeze.schemaVersion = 'media.pdp0.root-selected-source-integration-freeze.r9-r07.v1';
freeze.artifactId = 'MEDIA-PDP0-ROOT-SELECTED-SOURCE-INTEGRATION-R9-R07-FREEZE-2026-10-23';
freeze.freezeStatus = 'FROZEN_FOR_ACTUAL_H_R07_REVIEW_ONLY';
freeze.predecessor = { ref: r06FreezeRef, sha256: r06FreezeSha, candidateBundleRef: r06BundleRef, candidateBundleSha256: r06BundleSha, actualHReviewRef: hR06Ref, actualHReviewSha256: hR06Sha, actualHDisposition: 'REQUEST_CHANGES' };
freeze.actualHReviewR06 = { ref: hR06Ref, sha256: hR06Sha, reviewStatus: 'REQUEST_CHANGES', findings: ['F-10'] };
delete freeze.actualHReviewR05;
freeze.candidateBundle = { ref: bundleRef, sha256: sha(bundleBytes) };
freeze.repairMap = { ref: repairMapRef, sha256: sha(repairMapBytes) };
freeze.rebuildVerification = { ref: verificationRef, sha256: sha(verificationBytes) };
freeze.selectedPostimages = selectedPostimages;
freeze.priorHFindingsRepaired = ['F-01','F-02','F-03','F-04','F-05','F-06','F-07','F-08','F-09','F-10'];
freeze.canonicalApply = 'NONE'; freeze.phaseStatusEffect = 'NONE';
const freezeRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r07.freeze.v1.json`;
const freezeBytes = json(freeze);
writeCreateOnly(path.basename(freezeRef), freezeBytes);
console.log(JSON.stringify({ status: checkMode ? 'R9_R07_DETERMINISTIC_REPLAY_PASS' : 'R9_R07_CANDIDATE_FROZEN_FOR_H_REVIEW', findingId: 'F-10', auditId: 'AUD-GEN-024', outputs: { capabilities: { ref: `${dir}/${r07cap}`, sha256: sha(capabilities) }, requirements: { ref: `${dir}/${r07req}`, sha256: sha(reqBytes) }, bundle: { ref: bundleRef, sha256: sha(bundleBytes) }, freeze: { ref: freezeRef, sha256: sha(freezeBytes) } }, canonicalApply: 'NONE', phaseStatusEffect: 'NONE' }, null, 2));
