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
const r04cap = 'media-pdp0-root-selected-source-integration-r9-r04.split.capabilities.postimage.yaml';
const r04req = 'media-pdp0-root-selected-source-integration-r9-r04.split.requirements.postimage.yaml';
if (sha(read(r04cap)) !== '15f5336b36881ae628a5c171e97d0deab930f7d6b2ec92e778ea87383463c638') throw new Error('R9-R04 capability preimage hash mismatch');
if (sha(read(r04req)) !== 'e72f96576b1ea6440988f41cc75d306879b94a514c26e371300762abd3580fb4') throw new Error('R9-R04 requirement preimage hash mismatch');
let capabilities = read(r04cap);
let requirements = read(r04req);
const genId = 'media.capability.provider-class-separation';
const capStart = capabilities.indexOf(`  - id: ${genId}\n`);
const capEnd0 = capabilities.indexOf('\n  - id: media.agent.', capStart + 1);
if (capStart < 0 || capEnd0 < 0) throw new Error('GEN-024 capability block missing');
let feature = capabilities.slice(capStart, capEnd0 + 1);
const oldVariantLines = '              - UNAVAILABLE\n              - UNKNOWN\n';
if (!feature.includes(oldVariantLines)) throw new Error('GEN-024 success variant preimage mismatch');
feature = feature.replace(oldVariantLines, '');
capabilities = capabilities.slice(0, capStart) + feature + capabilities.slice(capEnd0 + 1);

function caseBlock(doc, caseId) {
  const marker = `      - id: ${caseId}\n`;
  const start = doc.indexOf(marker);
  if (start < 0) throw new Error(`Missing case ${caseId}`);
  const next = doc.indexOf('\n      - id: ', start + marker.length);
  return { start, end: next < 0 ? doc.length : next + 1, text: doc.slice(start, next < 0 ? doc.length : next + 1) };
}
function replaceField(doc, caseId, fieldName, oldValue, newValue) {
  const b = caseBlock(doc, caseId);
  const match = b.text.match(new RegExp(`^        ${fieldName}: (.*)$`, 'm'));
  if (!match || YAML.parse(`value: ${match[1]}\n`).value !== oldValue) throw new Error(`Unexpected ${fieldName} preimage in ${caseId}`);
  const oldLine = `        ${fieldName}: ${match[1]}\n`;
  const newLine = `        ${fieldName}: ${JSON.stringify(newValue)}\n`;
  return doc.slice(0, b.start) + b.text.replace(oldLine, newLine) + doc.slice(b.end);
}
const oldVariantJson = '"resultVariants":["LICENSE_POLICY_AXIS_RECORDED","PLACEMENT_AXIS_RECORDED","UNAVAILABLE","UNKNOWN"]';
const newVariantJson = '"resultVariants":["LICENSE_POLICY_AXIS_RECORDED","PLACEMENT_AXIS_RECORDED"]';
const newThen = (oldThen) => {
  if (!oldThen.includes(oldVariantJson)) throw new Error('GEN-024 positive case variant list mismatch');
  return oldThen.replace(oldVariantJson, newVariantJson);
};
for (const id of ['MEDIA-P0-COHORT02-AUD-GEN-024-LEAF-POS','MEDIA-P0-COHORT02-AUD-GEN-024-MEDIA-REQ-CAP-CAPABILITY-POS']) {
  const leaf = id.includes('-LEAF-');
  let doc = leaf ? capabilities : requirements;
  const oldThen = caseBlock(doc, id).text.match(/^        then: (.*)$/m)?.[1];
  if (!oldThen) throw new Error(`GEN-024 positive then missing: ${id}`);
  doc = replaceField(doc, id, 'then', oldThen, newThen(oldThen));
  if (leaf) capabilities = doc; else requirements = doc;
}
YAML.parse(capabilities); YAML.parse(requirements);

const r05cap = 'media-pdp0-root-selected-source-integration-r9-r05.split.capabilities.postimage.yaml';
const r05req = 'media-pdp0-root-selected-source-integration-r9-r05.split.requirements.postimage.yaml';
const r05leaf = 'media-pdp0-root-selected-source-integration-r9-r05.split.capability-leaf-review.postimage.yaml';
const r05cross = 'media-pdp0-root-selected-source-integration-r9-r05.split.pdp0-501-disposition-crosswalk.postimage.json';
const leafBytes = read('media-pdp0-root-selected-source-integration-r9-r04.split.capability-leaf-review.postimage.yaml');
const crossBytes = read('media-pdp0-root-selected-source-integration-r9-r04.split.pdp0-501-disposition-crosswalk.postimage.json');
writeCreateOnly(r05cap, capabilities); writeCreateOnly(r05req, requirements); writeCreateOnly(r05leaf, leafBytes); writeCreateOnly(r05cross, crossBytes);

const r04BundleRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r04.successor-bundle.candidate.v1.json`;
const r04BundleSha = sha(read(path.basename(r04BundleRef)));
const r04FreezeRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r04.freeze.v1.json`;
const r04FreezeSha = sha(read(path.basename(r04FreezeRef)));
const hR04Ref = `${dir}/media-pdp0-root-selected-source-integration-r9-r04.independent-peer.actual-h-r04-full.json`;
const hR04Sha = sha(read(path.basename(hR04Ref)));
const oldBundle = JSON.parse(read(path.basename(r04BundleRef)));
const oldFreeze = JSON.parse(read(path.basename(r04FreezeRef)));
const selectedPostimages = oldFreeze.selectedPostimages.map((row) => {
  const mapping = {
    '.product-experience/pdp-0-product-truth/capabilities.yaml': [r05cap, sha(capabilities)],
    '.product-experience/pdp-0-product-truth/requirements.yaml': [r05req, sha(requirements)],
    '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml': [r05leaf, sha(leafBytes)],
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json': [r05cross, sha(crossBytes)],
  };
  const [ref, digest] = mapping[row.targetRef];
  return { targetRef: row.targetRef, postimageRef: `${dir}/${ref}`, postimageSha256: digest };
});
const repairMapRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r05.repair-map.v1.json`;
const repairMapBytes = json({ schemaVersion: 'media.pdp0.root-selected-source-integration-r9-r05.repair-map.v1', status: 'CANDIDATE_REPAIR_MAP_ONLY', predecessor: { freezeRef: r04FreezeRef, freezeSha256: r04FreezeSha, bundleRef: r04BundleRef, bundleSha256: r04BundleSha, actualHReviewRef: hR04Ref, actualHReviewSha256: hR04Sha }, findingId: 'F-08', auditId: 'AUD-GEN-024', change: 'successOutputs.observableContract.resultVariants now contains only LICENSE_POLICY_AXIS_RECORDED and PLACEMENT_AXIS_RECORDED; non-success UNAVAILABLE and UNKNOWN_OUTCOME remain separately defined in nonSuccessOutputs; mirrored positive leaf/parent then values are identical.', canonicalApply: 'NONE', phaseStatusEffect: 'NONE' });
writeCreateOnly(path.basename(repairMapRef), repairMapBytes);
const bundle = structuredClone(oldBundle);
bundle.candidateRevision = 'R9-R05';
bundle.predecessor = { ref: r04BundleRef, sha256: r04BundleSha, freezeRef: r04FreezeRef, freezeSha256: r04FreezeSha, actualHReviewRef: hR04Ref, actualHReviewSha256: hR04Sha, actualHDisposition: 'REQUEST_CHANGES' };
bundle.selectedPostimages = selectedPostimages;
bundle.candidateRepairs = { repairMapRef, repairMapSha256: sha(repairMapBytes), findingId: 'F-08', auditId: 'AUD-GEN-024', successOutcomeVariants: ['LICENSE_POLICY_AXIS_RECORDED','PLACEMENT_AXIS_RECORDED'], nonSuccessOutcomesRemainSeparate: ['UNKNOWN_OUTCOME','UNAVAILABLE'] };
const bundleRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r05.successor-bundle.candidate.v1.json`;
const bundleBytes = json(bundle);
writeCreateOnly(path.basename(bundleRef), bundleBytes);

const verificationRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r05.rebuild-verification.v1.json`;
const verificationBytes = json({ schemaVersion: 'media.pdp0.root-selected-source-integration-r9-r05-rebuild-verification.v1', status: 'R9_R05_CANDIDATE_REPLAY_VERIFIED', predecessor: { freezeRef: r04FreezeRef, freezeSha256: r04FreezeSha, hReviewRef: hR04Ref, hReviewSha256: hR04Sha }, candidateBundle: { ref: bundleRef, sha256: sha(bundleBytes) }, repairMap: { ref: repairMapRef, sha256: sha(repairMapBytes) }, postimages: selectedPostimages.map((x) => ({ ref: x.postimageRef, sha256: x.postimageSha256 })), focusedTest: 'node --test tests/media-pdp0-root-selected-source-integration-r9-r05.test.mjs', replayCommand: 'node scripts/prepare-media-pdp0-root-selected-source-integration-r9-r05-candidate.mjs --check', campaignDenominator: { registeredIdentities: 54, phaseCells: 216, historicalOwnerRows: 462, pdp0AuditRows: 501 }, canonicalApply: 'NONE', phaseStatusEffect: 'NONE' });
writeCreateOnly(path.basename(verificationRef), verificationBytes);
const freeze = structuredClone(oldFreeze);
freeze.schemaVersion = 'media.pdp0.root-selected-source-integration-freeze.r9-r05.v1';
freeze.artifactId = 'MEDIA-PDP0-ROOT-SELECTED-SOURCE-INTEGRATION-R9-R05-FREEZE-2026-10-23';
freeze.freezeStatus = 'FROZEN_FOR_ACTUAL_H_R05_REVIEW_ONLY';
freeze.predecessor = { ref: r04FreezeRef, sha256: r04FreezeSha, candidateBundleRef: r04BundleRef, candidateBundleSha256: r04BundleSha, actualHReviewRef: hR04Ref, actualHReviewSha256: hR04Sha, actualHDisposition: 'REQUEST_CHANGES' };
freeze.actualHReviewR04 = { ref: hR04Ref, sha256: hR04Sha, reviewStatus: 'REQUEST_CHANGES', findings: ['F-08'] };
delete freeze.actualHReviewR03;
freeze.candidateBundle = { ref: bundleRef, sha256: sha(bundleBytes) };
freeze.repairMap = { ref: repairMapRef, sha256: sha(repairMapBytes) };
freeze.rebuildVerification = { ref: verificationRef, sha256: sha(verificationBytes) };
freeze.selectedPostimages = selectedPostimages;
freeze.priorHFindingsRepaired = ['F-01','F-02','F-03','F-04','F-05','F-06','F-07','F-08'];
freeze.canonicalApply = 'NONE'; freeze.phaseStatusEffect = 'NONE';
const freezeRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r05.freeze.v1.json`;
const freezeBytes = json(freeze);
writeCreateOnly(path.basename(freezeRef), freezeBytes);
console.log(JSON.stringify({ status: checkMode ? 'R9_R05_DETERMINISTIC_REPLAY_PASS' : 'R9_R05_CANDIDATE_FROZEN_FOR_H_REVIEW', findingId: 'F-08', auditId: 'AUD-GEN-024', outputs: { capabilities: { ref: `${dir}/${r05cap}`, sha256: sha(capabilities) }, requirements: { ref: `${dir}/${r05req}`, sha256: sha(requirements) }, bundle: { ref: bundleRef, sha256: sha(bundleBytes) }, freeze: { ref: freezeRef, sha256: sha(freezeBytes) } }, canonicalApply: 'NONE', phaseStatusEffect: 'NONE' }, null, 2));
