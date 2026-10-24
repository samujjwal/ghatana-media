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
const r05cap = 'media-pdp0-root-selected-source-integration-r9-r05.split.capabilities.postimage.yaml';
const r05req = 'media-pdp0-root-selected-source-integration-r9-r05.split.requirements.postimage.yaml';
if (sha(read(r05cap)) !== 'aecfc640fb688b01fe6ab04531569bc8d36eee0662b2de62f189dd0179dd61d5') throw new Error('R9-R05 capability input mismatch');
if (sha(read(r05req)) !== '35997271261b547e39c79002fcd28596a2a670845adeba48085e0d6fa7cc84d9') throw new Error('R9-R05 requirement input mismatch');
let capabilities = read(r05cap);
let requirements = read(r05req);
const yamlCap = YAML.parse(capabilities);
const gen = yamlCap.capabilities.find((x) => x.id === 'media.capability.provider-class-separation');
const oldCondition = gen.ownerDefinition.semanticOutcomeContract.conditions.find((x) => x.includes('missing/stale evidence stays UNKNOWN'));
if (!oldCondition) throw new Error('GEN-024 semantic condition preimage missing');
const newCondition = oldCondition.replace('missing/stale evidence stays UNKNOWN', 'missing/stale evidence yields UNKNOWN_OUTCOME');
const oldConditionLine = `          - ${oldCondition}\n`;
const newConditionLine = `          - ${newCondition}\n`;
if (!capabilities.includes(oldConditionLine)) throw new Error('GEN-024 semantic condition raw text mismatch');
capabilities = capabilities.replace(oldConditionLine, newConditionLine);

function caseBlock(doc, id) {
  const marker = `      - id: ${id}\n`;
  const start = doc.indexOf(marker);
  if (start < 0) throw new Error(`Missing case ${id}`);
  const next = doc.indexOf('\n      - id: ', start + marker.length);
  return { start, end: next < 0 ? doc.length : next + 1, text: doc.slice(start, next < 0 ? doc.length : next + 1) };
}
function replaceField(doc, id, key, oldValue, newValue) {
  const b = caseBlock(doc, id);
  const match = b.text.match(new RegExp(`^        ${key}: (.*)$`, 'm'));
  if (!match || YAML.parse(`value: ${match[1]}\n`).value !== oldValue) throw new Error(`GEN-024 ${key} preimage mismatch: ${id}`);
  const oldLine = `        ${key}: ${match[1]}\n`;
  const newLine = `        ${key}: ${JSON.stringify(newValue)}\n`;
  return doc.slice(0, b.start) + b.text.replace(oldLine, newLine) + doc.slice(b.end);
}
const negativeIds = ['MEDIA-P0-COHORT02-AUD-GEN-024-LEAF-NEG','MEDIA-P0-COHORT02-AUD-GEN-024-MEDIA-REQ-CAP-CAPABILITY-NEG'];
for (const id of negativeIds) {
  const leaf = id.includes('-LEAF-');
  const doc = leaf ? capabilities : requirements;
  const oldGiven = caseBlock(doc, id).text.match(/^        given: (.*)$/m)?.[1];
  if (!oldGiven || !oldGiven.includes('returns UNKNOWN.') || !oldGiven.includes('evidence stays UNKNOWN.')) throw new Error(`GEN-024 negative given preimage mismatch: ${id}`);
  const newGiven = oldGiven.replaceAll('returns UNKNOWN.', 'returns UNKNOWN_OUTCOME.').replaceAll('evidence stays UNKNOWN.', 'evidence stays UNKNOWN_OUTCOME.');
  if (leaf) capabilities = replaceField(capabilities, id, 'given', oldGiven, newGiven);
  else requirements = replaceField(requirements, id, 'given', oldGiven, newGiven);
}
YAML.parse(capabilities); YAML.parse(requirements);

const r06cap = 'media-pdp0-root-selected-source-integration-r9-r06.split.capabilities.postimage.yaml';
const r06req = 'media-pdp0-root-selected-source-integration-r9-r06.split.requirements.postimage.yaml';
const r06leaf = 'media-pdp0-root-selected-source-integration-r9-r06.split.capability-leaf-review.postimage.yaml';
const r06cross = 'media-pdp0-root-selected-source-integration-r9-r06.split.pdp0-501-disposition-crosswalk.postimage.json';
const leafBytes = read('media-pdp0-root-selected-source-integration-r9-r05.split.capability-leaf-review.postimage.yaml');
const crossBytes = read('media-pdp0-root-selected-source-integration-r9-r05.split.pdp0-501-disposition-crosswalk.postimage.json');
writeCreateOnly(r06cap, capabilities); writeCreateOnly(r06req, requirements); writeCreateOnly(r06leaf, leafBytes); writeCreateOnly(r06cross, crossBytes);

const r05BundleRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r05.successor-bundle.candidate.v1.json`;
const r05BundleSha = sha(read(path.basename(r05BundleRef)));
const r05FreezeRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r05.freeze.v1.json`;
const r05FreezeSha = sha(read(path.basename(r05FreezeRef)));
const hR05Ref = `${dir}/media-pdp0-root-selected-source-integration-r9-r05.independent-peer.actual-h-r05-full.json`;
const hR05Sha = sha(read(path.basename(hR05Ref)));
const oldBundle = JSON.parse(read(path.basename(r05BundleRef)));
const oldFreeze = JSON.parse(read(path.basename(r05FreezeRef)));
const selectedPostimages = oldFreeze.selectedPostimages.map((row) => {
  const mapping = {
    '.product-experience/pdp-0-product-truth/capabilities.yaml': [r06cap, sha(capabilities)],
    '.product-experience/pdp-0-product-truth/requirements.yaml': [r06req, sha(requirements)],
    '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml': [r06leaf, sha(leafBytes)],
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json': [r06cross, sha(crossBytes)],
  };
  const [ref, digest] = mapping[row.targetRef];
  return { targetRef: row.targetRef, postimageRef: `${dir}/${ref}`, postimageSha256: digest };
});
const repairMapRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r06.repair-map.v1.json`;
const repairMapBytes = json({ schemaVersion: 'media.pdp0.root-selected-source-integration-r9-r06.repair-map.v1', status: 'CANDIDATE_REPAIR_MAP_ONLY', predecessor: { freezeRef: r05FreezeRef, freezeSha256: r05FreezeSha, bundleRef: r05BundleRef, bundleSha256: r05BundleSha, actualHReviewRef: hR05Ref, actualHReviewSha256: hR05Sha }, findingId: 'F-09', auditId: 'AUD-GEN-024', changedFields: ['ownerDefinition.semanticOutcomeContract.conditions','positive-to-unknown outcome wording in negative leaf given','positive-to-unknown outcome wording in linked negative parent given'], replacement: { from: 'UNKNOWN', to: 'UNKNOWN_OUTCOME' }, exactLeafParentGivenParity: true, canonicalApply: 'NONE', phaseStatusEffect: 'NONE' });
writeCreateOnly(path.basename(repairMapRef), repairMapBytes);
const bundle = structuredClone(oldBundle);
bundle.candidateRevision = 'R9-R06';
bundle.predecessor = { ref: r05BundleRef, sha256: r05BundleSha, freezeRef: r05FreezeRef, freezeSha256: r05FreezeSha, actualHReviewRef: hR05Ref, actualHReviewSha256: hR05Sha, actualHDisposition: 'REQUEST_CHANGES' };
bundle.selectedPostimages = selectedPostimages;
bundle.candidateRepairs = { repairMapRef, repairMapSha256: sha(repairMapBytes), findingId: 'F-09', auditId: 'AUD-GEN-024', onlyUnknownOutcomeToken: 'UNKNOWN_OUTCOME', parentLeafGivenParity: true };
const bundleRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r06.successor-bundle.candidate.v1.json`;
const bundleBytes = json(bundle);
writeCreateOnly(path.basename(bundleRef), bundleBytes);
const verificationRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r06.rebuild-verification.v1.json`;
const verificationBytes = json({ schemaVersion: 'media.pdp0.root-selected-source-integration-r9-r06-rebuild-verification.v1', status: 'R9_R06_CANDIDATE_REPLAY_VERIFIED', predecessor: { freezeRef: r05FreezeRef, freezeSha256: r05FreezeSha, hReviewRef: hR05Ref, hReviewSha256: hR05Sha }, candidateBundle: { ref: bundleRef, sha256: sha(bundleBytes) }, repairMap: { ref: repairMapRef, sha256: sha(repairMapBytes) }, postimages: selectedPostimages.map((x) => ({ ref: x.postimageRef, sha256: x.postimageSha256 })), focusedTest: 'node --test tests/media-pdp0-root-selected-source-integration-r9-r06.test.mjs', replayCommand: 'node scripts/prepare-media-pdp0-root-selected-source-integration-r9-r06-candidate.mjs --check', campaignDenominator: { registeredIdentities: 54, phaseCells: 216, historicalOwnerRows: 462, pdp0AuditRows: 501 }, canonicalApply: 'NONE', phaseStatusEffect: 'NONE' });
writeCreateOnly(path.basename(verificationRef), verificationBytes);
const freeze = structuredClone(oldFreeze);
freeze.schemaVersion = 'media.pdp0.root-selected-source-integration-freeze.r9-r06.v1';
freeze.artifactId = 'MEDIA-PDP0-ROOT-SELECTED-SOURCE-INTEGRATION-R9-R06-FREEZE-2026-10-23';
freeze.freezeStatus = 'FROZEN_FOR_ACTUAL_H_R06_REVIEW_ONLY';
freeze.predecessor = { ref: r05FreezeRef, sha256: r05FreezeSha, candidateBundleRef: r05BundleRef, candidateBundleSha256: r05BundleSha, actualHReviewRef: hR05Ref, actualHReviewSha256: hR05Sha, actualHDisposition: 'REQUEST_CHANGES' };
freeze.actualHReviewR05 = { ref: hR05Ref, sha256: hR05Sha, reviewStatus: 'REQUEST_CHANGES', findings: ['F-09'] };
delete freeze.actualHReviewR04;
freeze.candidateBundle = { ref: bundleRef, sha256: sha(bundleBytes) };
freeze.repairMap = { ref: repairMapRef, sha256: sha(repairMapBytes) };
freeze.rebuildVerification = { ref: verificationRef, sha256: sha(verificationBytes) };
freeze.selectedPostimages = selectedPostimages;
freeze.priorHFindingsRepaired = ['F-01','F-02','F-03','F-04','F-05','F-06','F-07','F-08','F-09'];
freeze.canonicalApply = 'NONE'; freeze.phaseStatusEffect = 'NONE';
const freezeRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r06.freeze.v1.json`;
const freezeBytes = json(freeze);
writeCreateOnly(path.basename(freezeRef), freezeBytes);
console.log(JSON.stringify({ status: checkMode ? 'R9_R06_DETERMINISTIC_REPLAY_PASS' : 'R9_R06_CANDIDATE_FROZEN_FOR_H_REVIEW', findingId: 'F-09', auditId: 'AUD-GEN-024', outputs: { capabilities: { ref: `${dir}/${r06cap}`, sha256: sha(capabilities) }, requirements: { ref: `${dir}/${r06req}`, sha256: sha(requirements) }, bundle: { ref: bundleRef, sha256: sha(bundleBytes) }, freeze: { ref: freezeRef, sha256: sha(freezeBytes) } }, canonicalApply: 'NONE', phaseStatusEffect: 'NONE' }, null, 2));
