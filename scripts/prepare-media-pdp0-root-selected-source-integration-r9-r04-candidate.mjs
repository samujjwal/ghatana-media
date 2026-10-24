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

const r03cap = 'media-pdp0-root-selected-source-integration-r9-r03.split.capabilities.postimage.yaml';
const r03req = 'media-pdp0-root-selected-source-integration-r9-r03.split.requirements.postimage.yaml';
const expected = {
  [r03cap]: 'a1024a1297b21525a9f48415638133423177903814d549f67bfbf82262673349',
  [r03req]: 'cb3af786c828621feea57094051c683d7f8c7ccfd600941eb729ddd1ab9bc5b8',
};
let capabilities = read(r03cap);
let requirements = read(r03req);
for (const [name, digest] of Object.entries(expected)) if (sha(read(name)) !== digest) throw new Error(`R9-R03 frozen input mismatch: ${name}`);
const parsedCap = YAML.parse(capabilities);
const parsedReq = YAML.parse(requirements);

const audits = ['AUD-CAP-028','AUD-CLONE-004','AUD-CLONE-006','AUD-CLONE-017','AUD-COLOR-007','AUD-DELIV-007','AUD-COLOR-001'];
const relationSuffix = / Parent relation: .* includes capability .*\.$/;
const parentChanges = [];
function caseBlock(doc, caseId) {
  const marker = `      - id: ${caseId}\n`;
  const start = doc.indexOf(marker);
  if (start < 0) throw new Error(`Missing case ${caseId}`);
  const next = doc.indexOf('\n      - id: ', start + marker.length);
  return { start, end: next < 0 ? doc.length : next + 1, text: doc.slice(start, next < 0 ? doc.length : next + 1) };
}
function setCaseField(doc, caseId, field, expectedValue, value) {
  const b = caseBlock(doc, caseId);
  const match = b.text.match(new RegExp(`^        ${field}: (.*)$`, 'm'));
  if (!match || YAML.parse(`value: ${match[1]}\n`).value !== expectedValue) throw new Error(`Expected one exact ${field} value in ${caseId}`);
  const oldLine = `        ${field}: ${match[1]}\n`;
  const newLine = `        ${field}: ${JSON.stringify(value)}\n`;
  if (b.text.indexOf(oldLine) !== b.text.lastIndexOf(oldLine)) throw new Error(`Ambiguous ${field} line in ${caseId}`);
  return doc.slice(0, b.start) + b.text.replace(oldLine, newLine) + doc.slice(b.end);
}
for (const auditId of audits) {
  const leaves = parsedCap.capabilities.flatMap((cap) => (cap.acceptanceCases ?? []).filter((c) => c.sourceAuditId === auditId).map((c) => ({ capabilityId: cap.id, ...c })));
  for (const leaf of leaves) {
    const parents = parsedReq.requirements.flatMap((req) => (req.acceptanceCases ?? []).filter((c) => c.sourceCapabilityCaseId === leaf.id).map((c) => ({ requirementId: req.id, ...c })));
    if (!parents.length) throw new Error(`No linked parent for ${leaf.id}`);
    for (const parent of parents) {
      if (parent.polarity !== leaf.polarity || parent.given !== leaf.given || parent.then !== leaf.then) throw new Error(`Inherited case fields diverge beyond the reviewed parent when annotation: ${parent.id}`);
      if (!relationSuffix.test(parent.when) || parent.when.replace(relationSuffix, '') !== leaf.when) throw new Error(`Unexpected parent invocation relation annotation: ${parent.id}`);
      requirements = setCaseField(requirements, parent.id, 'when', parent.when, leaf.when);
      parentChanges.push({ auditId, capabilityId: leaf.capabilityId, leafCaseId: leaf.id, parentCaseId: parent.id, requirementId: parent.requirementId, polarity: leaf.polarity, beforeWhen: parent.when, afterWhen: leaf.when });
    }
  }
}

const gen024CapId = 'media.capability.provider-class-separation';
const capStart = capabilities.indexOf(`  - id: ${gen024CapId}\n`);
const capEnd0 = capabilities.indexOf('\n  - id: media.agent.', capStart + 1);
if (capStart < 0 || capEnd0 < 0) throw new Error('Cannot locate AUD-GEN-024 definition block');
let genDef = capabilities.slice(capStart, capEnd0 + 1);
const oldOutputs = `      nonSuccessOutputs:\n        REJECTED:\n          conditions:\n            - Missing, stale, or ambiguous provider-class evidence returns UNKNOWN.\n            - No provider class is inferred from generic capability declarations; no silent cross-class fallback.\n            - Permissive license and hosted placement are not mutually exclusive classes. Require versioned license/rights policy evidence and explicit LOCAL/HOSTED placement/provider binding; missing/stale evidence stays UNKNOWN. No license, provider admission, egress or cross-provider fallback inferred from labels.\n            - Define typed inputs, actual observable output, failures/unknowns, authority references, feature-specific positive and adverse leaf/parent cases. Missing actual authority/evidence remains explicit and cannot be fabricated.\n        UNKNOWN_OUTCOME:\n          conditions:\n            - External or internal finality cannot be confirmed; reconcile without blind redispatch.\n        UNAVAILABLE:\n          conditions:\n            - Required authority, profile, model, provider or control equivalent is unavailable.\n`;
const newOutputs = `      nonSuccessOutputs:\n        REJECTED:\n          conditions:\n            - Request is explicitly invalid, unsupported, or denied by the applicable operation-specific policy or rights decision.\n        UNKNOWN_OUTCOME:\n          conditions:\n            - Required provider, license, rights, or policy evidence is missing, stale, or ambiguous; do not infer a provider class or cross-class fallback.\n            - External or internal finality cannot be confirmed; reconcile without blind redispatch.\n        UNAVAILABLE:\n          conditions:\n            - Required authority, profile, model, provider or control equivalent is unavailable.\n`;
if (!genDef.includes(oldOutputs)) throw new Error('AUD-GEN-024 nonSuccessOutputs preimage mismatch');
genDef = genDef.replace(oldOutputs, newOutputs);
capabilities = capabilities.slice(0, capStart) + genDef + capabilities.slice(capEnd0 + 1);

const newNegativeThen = 'Return only bounded non-success outcomes {"REJECTED":{"conditions":["Request is explicitly invalid, unsupported, or denied by the applicable operation-specific policy or rights decision."]},"UNKNOWN_OUTCOME":{"conditions":["Required provider, license, rights, or policy evidence is missing, stale, or ambiguous; do not infer a provider class or cross-class fallback.","External or internal finality cannot be confirmed; reconcile without blind redispatch."]},"UNAVAILABLE":{"conditions":["Required authority, profile, model, provider or control equivalent is unavailable."]}} using errors ["INVALID_REQUEST","ACCESS_DENIED","RIGHTS_OR_CONSENT_DENIED","UNSUPPORTED_PROFILE","BOUNDS_EXCEEDED","CONFLICT","UNAVAILABLE","UNKNOWN_OUTCOME","STALE_REVISION","SCOPE_DENIED"] and authority ["identity-and-tenant-context","operation-specific-policy-and-rights","artifact-read-or-write-permission-as-applicable","governed-egress-or-publishing-authority-when-applicable"]; never claim unsupported success.';
for (const caseId of ['MEDIA-P0-COHORT02-AUD-GEN-024-LEAF-NEG','MEDIA-P0-COHORT02-AUD-GEN-024-MEDIA-REQ-CAP-CAPABILITY-NEG']) {
  const isLeaf = caseId.includes('-LEAF-');
  const doc = isLeaf ? capabilities : requirements;
  const oldThen = caseBlock(doc, caseId).text.match(/^        then: (.*)$/m)?.[1];
  if (!oldThen?.includes('"Missing, stale, or ambiguous provider-class evidence returns UNKNOWN."')) throw new Error(`AUD-GEN-024 negative then preimage mismatch: ${caseId}`);
  if (isLeaf) capabilities = setCaseField(capabilities, caseId, 'then', oldThen, newNegativeThen);
  else requirements = setCaseField(requirements, caseId, 'then', oldThen, newNegativeThen);
}

const r04cap = 'media-pdp0-root-selected-source-integration-r9-r04.split.capabilities.postimage.yaml';
const r04req = 'media-pdp0-root-selected-source-integration-r9-r04.split.requirements.postimage.yaml';
const r03leaf = 'media-pdp0-root-selected-source-integration-r9-r03.split.capability-leaf-review.postimage.yaml';
const r03cross = 'media-pdp0-root-selected-source-integration-r9-r03.split.pdp0-501-disposition-crosswalk.postimage.json';
const r04leaf = 'media-pdp0-root-selected-source-integration-r9-r04.split.capability-leaf-review.postimage.yaml';
const r04cross = 'media-pdp0-root-selected-source-integration-r9-r04.split.pdp0-501-disposition-crosswalk.postimage.json';
const leafBytes = read(r03leaf);
const crossBytes = read('media-pdp0-root-selected-source-integration-r9-r03.split.pdp0-501-disposition-crosswalk.postimage.json');
YAML.parse(capabilities); YAML.parse(requirements);
writeCreateOnly(r04cap, capabilities);
writeCreateOnly(r04req, requirements);
writeCreateOnly(r04leaf, leafBytes);
writeCreateOnly(r04cross, crossBytes);

const r03BundleRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r03.successor-bundle.candidate.v1.json`;
const r03BundleSha = sha(read(path.basename(r03BundleRef)));
const r03FreezeRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r03.freeze.v1.json`;
const r03FreezeSha = sha(read(path.basename(r03FreezeRef)));
const hR03Ref = `${dir}/media-pdp0-root-selected-source-integration-r9-r03.independent-peer.actual-h-r03-full.json`;
const hR03Sha = sha(read(path.basename(hR03Ref)));
const oldBundle = JSON.parse(read(path.basename(r03BundleRef)));
const oldFreeze = JSON.parse(read(path.basename(r03FreezeRef)));
const selectedPostimages = oldFreeze.selectedPostimages.map((row) => {
  const map = {
    '.product-experience/pdp-0-product-truth/capabilities.yaml': [r04cap, sha(capabilities)],
    '.product-experience/pdp-0-product-truth/requirements.yaml': [r04req, sha(requirements)],
    '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml': [r04leaf, sha(leafBytes)],
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json': [r04cross, sha(crossBytes)],
  };
  const [ref, digest] = map[row.targetRef];
  return { targetRef: row.targetRef, postimageRef: `${dir}/${ref}`, postimageSha256: digest };
});
const repairMapRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r04.repair-map.v1.json`;
const repairMap = { schemaVersion: 'media.pdp0.root-selected-source-integration-r9-r04.repair-map.v1', status: 'CANDIDATE_REPAIR_MAP_ONLY', predecessor: { freezeRef: r03FreezeRef, freezeSha256: r03FreezeSha, bundleRef: r03BundleRef, bundleSha256: r03BundleSha, actualHReviewRef: hR03Ref, actualHReviewSha256: hR03Sha }, repairs: [{ findingId: 'F-06', audits, changedParentWhenCount: parentChanges.length, parentChanges }, { findingId: 'F-07', auditId: 'AUD-GEN-024', branchRepair: { missingStaleAmbiguousEvidence: 'UNKNOWN_OUTCOME only', rejected: 'explicit invalid, unsupported, or denied request only', mirroredLeafParentThen: true } }], canonicalApply: 'NONE', phaseStatusEffect: 'NONE' };
const repairMapBytes = json(repairMap);
writeCreateOnly(path.basename(repairMapRef), repairMapBytes);

const bundle = structuredClone(oldBundle);
bundle.candidateRevision = 'R9-R04';
bundle.predecessor = { ref: r03BundleRef, sha256: r03BundleSha, freezeRef: r03FreezeRef, freezeSha256: r03FreezeSha, actualHReviewRef: hR03Ref, actualHReviewSha256: hR03Sha, actualHDisposition: 'REQUEST_CHANGES' };
bundle.selectedPostimages = selectedPostimages;
bundle.candidateRepairs = { repairMapRef, repairMapSha256: sha(repairMapBytes), findingIds: ['F-06','F-07'], exactParentLeafWhenParityAudits: audits, gen024NegativeOutcomeDisposition: 'MISSING_STALE_AMBIGUOUS_EVIDENCE_TO_UNKNOWN_OUTCOME; REJECTED_ONLY_FOR_EXPLICIT_INVALID_UNSUPPORTED_OR_DENIED' };
const bundleRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r04.successor-bundle.candidate.v1.json`;
const bundleBytes = json(bundle);
writeCreateOnly(path.basename(bundleRef), bundleBytes);

const verificationRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r04.rebuild-verification.v1.json`;
const verification = { schemaVersion: 'media.pdp0.root-selected-source-integration-r9-r04-rebuild-verification.v1', status: 'R9_R04_CANDIDATE_REPLAY_VERIFIED', predecessor: { freezeRef: r03FreezeRef, freezeSha256: r03FreezeSha, hReviewRef: hR03Ref, hReviewSha256: hR03Sha }, candidateBundle: { ref: bundleRef, sha256: sha(bundleBytes) }, repairMap: { ref: repairMapRef, sha256: sha(repairMapBytes) }, postimages: selectedPostimages.map((x) => ({ ref: x.postimageRef, sha256: x.postimageSha256 })), exactParity: { audits, parentCaseCountNormalized: parentChanges.length, caseFields: ['polarity','given','when','then'] }, gen024NegativeOutcomes: { unknownOutcomeForMissingStaleAmbiguous: true, rejectedOnlyExplicitInvalidUnsupportedDenied: true, leafParentThenEqual: true }, campaignDenominator: { registeredIdentities: 54, phaseCells: 216, historicalOwnerRows: 462, pdp0AuditRows: 501 }, replayCommand: 'node scripts/prepare-media-pdp0-root-selected-source-integration-r9-r04-candidate.mjs --check', focusedTest: 'node --test tests/media-pdp0-root-selected-source-integration-r9-r04.test.mjs', canonicalApply: 'NONE', phaseStatusEffect: 'NONE' };
const verificationBytes = json(verification);
writeCreateOnly(path.basename(verificationRef), verificationBytes);

const freeze = structuredClone(oldFreeze);
freeze.schemaVersion = 'media.pdp0.root-selected-source-integration-freeze.r9-r04.v1';
freeze.artifactId = 'MEDIA-PDP0-ROOT-SELECTED-SOURCE-INTEGRATION-R9-R04-FREEZE-2026-10-23';
freeze.freezeStatus = 'FROZEN_FOR_ACTUAL_H_R04_REVIEW_ONLY';
freeze.predecessor = { ref: r03FreezeRef, sha256: r03FreezeSha, candidateBundleRef: r03BundleRef, candidateBundleSha256: r03BundleSha, actualHReviewRef: hR03Ref, actualHReviewSha256: hR03Sha, actualHDisposition: 'REQUEST_CHANGES' };
freeze.actualHReviewR03 = { ref: hR03Ref, sha256: hR03Sha, reviewStatus: 'REQUEST_CHANGES', findings: ['F-06','F-07'] };
delete freeze.actualHReviewR02;
freeze.candidateBundle = { ref: bundleRef, sha256: sha(bundleBytes) };
freeze.repairMap = { ref: repairMapRef, sha256: sha(repairMapBytes) };
freeze.rebuildVerification = { ref: verificationRef, sha256: sha(verificationBytes) };
freeze.selectedPostimages = selectedPostimages;
freeze.priorHFindingsRepaired = ['F-01','F-02','F-03','F-04','F-05','F-06','F-07'];
freeze.canonicalApply = 'NONE'; freeze.phaseStatusEffect = 'NONE';
const freezeRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r04.freeze.v1.json`;
const freezeBytes = json(freeze);
writeCreateOnly(path.basename(freezeRef), freezeBytes);

console.log(JSON.stringify({ status: checkMode ? 'R9_R04_DETERMINISTIC_REPLAY_PASS' : 'R9_R04_CANDIDATE_FROZEN_FOR_H_REVIEW', findingIds: ['F-06','F-07'], normalizedParentCases: parentChanges.length, auditIds: audits, outputs: { capabilities: { ref: `${dir}/${r04cap}`, sha256: sha(capabilities) }, requirements: { ref: `${dir}/${r04req}`, sha256: sha(requirements) }, bundle: { ref: bundleRef, sha256: sha(bundleBytes) }, freeze: { ref: freezeRef, sha256: sha(freezeBytes) } }, canonicalApply: 'NONE', phaseStatusEffect: 'NONE' }, null, 2));
