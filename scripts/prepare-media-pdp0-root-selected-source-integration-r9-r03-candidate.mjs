import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

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
    if (checkMode) {
      if (fs.readFileSync(target, 'utf8') !== value) throw new Error(`Deterministic replay mismatch: ${target}`);
      return;
    }
    throw new Error(`Refusing to overwrite immutable candidate artifact: ${target}`);
  }
  if (checkMode) throw new Error(`Replay target missing: ${target}`);
  fs.writeFileSync(target, value, { flag: 'wx' });
};

const r02cap = 'media-pdp0-root-selected-source-integration-r9-r02.split.capabilities.postimage.yaml';
const r02req = 'media-pdp0-root-selected-source-integration-r9-r02.split.requirements.postimage.yaml';
const expected = {
  [r02cap]: '59746d493ab1bd0ebee93e3b1b7efd594689cb5cfa42abf222c04a863988a133',
  [r02req]: '80c54dd68c30199feeaf84e7e6550ffb52ae5a0f082a5f0c9b65b7d1c7783fe2',
};
let capabilities = read(r02cap);
let requirements = read(r02req);
for (const [name, digest] of Object.entries(expected)) {
  if (sha(read(name)) !== digest) throw new Error(`R9-R02 frozen input mismatch: ${name}`);
}

const f01f03 = JSON.parse(read('media-pdp0-r9-r02-case-when-patch-f01-f03.candidate.json'));
const f04 = JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r02.f04-invocation-suffix-patch-candidate.v1.json'));
const replacements = [];
for (const row of f01f03.changes) replacements.push({ auditId: row.auditId, capabilityId: row.capabilityId, leafCases: row.capabilityLeafCases, parentCases: row.linkedRequirementParentCases, old: row.whenReplacement.old, next: `Invoke the ${row.capabilityId} operation.` });
for (const row of f04.patches) replacements.push({ auditId: row.auditId, capabilityId: row.canonicalCapabilityId, leafCases: row.capabilityCaseIds, parentCases: row.linkedParentCases.map((x) => ({ caseId: x.parentCaseId, polarity: x.polarity, sourceCapabilityCaseId: x.linkedLeafCaseId })), old: row.replacement.oldWhen, next: `Invoke the ${row.canonicalCapabilityId} operation${row.auditId === 'AUD-GEN-023' ? ' with LOCAL_OFFLINE placement and network egress disabled' : ''}.` });

function caseBlock(doc, caseId) {
  const marker = `      - id: ${caseId}\n`;
  const at = doc.indexOf(marker);
  if (at < 0) throw new Error(`Missing case ${caseId}`);
  const next = doc.indexOf('\n      - id: ', at + marker.length);
  const end = next < 0 ? doc.length : next + 1;
  return { start: at, end, text: doc.slice(at, end) };
}
function replaceCaseField(doc, caseId, field, oldValue, newValue) {
  const b = caseBlock(doc, caseId);
  if (oldValue === undefined) {
    const match = b.text.match(new RegExp(`^        ${field}: (.*)$`, 'm'));
    if (!match) throw new Error(`Missing ${field} in ${caseId}`);
    oldValue = match[1];
  }
  const oldLine = `        ${field}: ${oldValue}\n`;
  const newLine = `        ${field}: ${newValue}\n`;
  if (!b.text.includes(oldLine)) throw new Error(`Expected exact ${field} preimage in ${caseId}`);
  if (b.text.indexOf(oldLine) !== b.text.lastIndexOf(oldLine)) throw new Error(`Ambiguous ${field} preimage in ${caseId}`);
  return doc.slice(0, b.start) + b.text.replace(oldLine, newLine) + doc.slice(b.end);
}
for (const row of replacements) {
  for (const c of [...row.leafCases, ...row.parentCases]) {
    const isLeaf = row.leafCases.some((x) => x.caseId === c.caseId);
    const doc = isLeaf ? capabilities : requirements;
    const before = caseBlock(doc, c.caseId).text.match(/^        when: (.*)$/m)?.[1];
    if (!before || !before.startsWith(`Invoke ${row.capabilityId}.`)) throw new Error(`Invocation identity mismatch for ${row.auditId}/${c.caseId}`);
    const updated = replaceCaseField(doc, c.caseId, 'when', before, row.next);
    if (isLeaf) capabilities = updated; else requirements = updated;
  }
}

const gen024 = 'media.capability.provider-class-separation';
const oldGen024When = `Invoke ${gen024}.capability.provider-class-separation.`;
const newGen024When = `Invoke the ${gen024} operation.`;
const gen024PositiveGiven = 'Caller supplies typed inputs [{"slotId":"operation-profile","sourceType":"requested-operation-and-profile","cardinality":"EXACTLY_ONE","required":true},{"slotId":"provider-binding","sourceType":"explicit-provider-binding","cardinality":"EXACTLY_ONE","required":true},{"slotId":"license-rights-policy-evidence","sourceType":"versioned-provider-license-rights-and-policy-evidence","cardinality":"EXACTLY_ONE","required":true},{"slotId":"execution-placement","sourceType":"explicit-execution-placement","cardinality":"EXACTLY_ONE","required":true,"allowedValues":["LOCAL","HOSTED"]}] with the exact declared authority.';
const newGen024PositiveGiven = 'Caller supplies operation-profile=provider-class-separation; provider-binding={providerId:"provider-example-01",bindingId:"binding-example-01"}; license-rights-policy-evidence={evidenceId:"evidence-example-01",revision:"rev-7",contentDigest:"sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",policyDecision:"PERMITTED",policyVersion:"policy-rev-3"}; execution-placement=HOSTED. These illustrative fixture values demonstrate that permitted versioned license/rights evidence and hosted placement are independent axes; they assert no actual license, provider admission, or external effect.';
const newSuccessOutput = '[{"artifactType":"independent-provider-license-and-placement-observation","requiredOnSuccess":true,"resultVariants":["LICENSE_POLICY_AXIS_RECORDED","PLACEMENT_AXIS_RECORDED"],"observableContract":{"artifactType":"independent-provider-license-and-placement-observation","resultVariants":["LICENSE_POLICY_AXIS_RECORDED","PLACEMENT_AXIS_RECORDED","UNAVAILABLE","UNKNOWN"],"licenseRightsEvidence":{"evidenceId":"string","revision":"string","contentDigest":"sha256 digest"},"policyDecision":{"decisionId":"string","outcome":"PERMITTED or DENIED","policyVersion":"string"},"providerBinding":{"providerId":"string","bindingId":"string"},"executionPlacement":"LOCAL or HOSTED","axesIndependent":true,"mutualExclusivity":false}}]';
const newGen024PositiveThen = `Return the observable success output ${newSuccessOutput}; for this illustrative case record evidenceId=evidence-example-01, revision=rev-7, contentDigest=sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef, policyDecision=PERMITTED, policyVersion=policy-rev-3, providerId=provider-example-01, bindingId=binding-example-01, executionPlacement=HOSTED. Fixture values are examples, not actual authorization; distinguish preparation, readiness, execution and external effect exactly as specified.`;
const oldGen024Then = 'Return the observable success output [{"artifactType":"independent-provider-license-and-placement-observation","requiredOnSuccess":true,"resultVariants":["LICENSE_POLICY_AXIS_RECORDED","PLACEMENT_AXIS_RECORDED"],"observableContract":{"artifactType":"independent-provider-license-and-placement-observation","resultVariants":["LICENSE_POLICY_AXIS_RECORDED","PLACEMENT_AXIS_RECORDED","UNAVAILABLE","UNKNOWN"],"axesIndependent":true,"mutualExclusivity":false}}]; distinguish preparation, readiness, execution and external effect exactly as specified.';
const gen024LeafPositive = 'MEDIA-P0-COHORT02-AUD-GEN-024-LEAF-POS';
const gen024ParentPositive = 'MEDIA-P0-COHORT02-AUD-GEN-024-MEDIA-REQ-CAP-CAPABILITY-POS';
for (const caseId of [gen024LeafPositive, gen024ParentPositive]) {
  const leaf = caseId === gen024LeafPositive;
  let doc = leaf ? capabilities : requirements;
  const oldWhen = caseBlock(doc, caseId).text.match(/^        when: (.*)$/m)?.[1];
  if (oldWhen !== oldGen024When) throw new Error(`AUD-GEN-024 invocation preimage mismatch in ${caseId}`);
  doc = replaceCaseField(doc, caseId, 'when', oldWhen, newGen024When);
  doc = replaceCaseField(doc, caseId, 'given', gen024PositiveGiven, newGen024PositiveGiven);
  doc = replaceCaseField(doc, caseId, 'then', oldGen024Then, newGen024PositiveThen);
  if (leaf) capabilities = doc; else requirements = doc;
}
for (const caseId of ['MEDIA-P0-COHORT02-AUD-GEN-024-LEAF-NEG', 'MEDIA-P0-COHORT02-AUD-GEN-024-MEDIA-REQ-CAP-CAPABILITY-NEG']) {
  const leaf = caseId.includes('-LEAF-');
  let doc = leaf ? capabilities : requirements;
  const oldWhen = caseBlock(doc, caseId).text.match(/^        when: (.*)$/m)?.[1];
  if (oldWhen !== oldGen024When) throw new Error(`AUD-GEN-024 invocation preimage mismatch in ${caseId}`);
  doc = replaceCaseField(doc, caseId, 'when', oldWhen, newGen024When);
  if (leaf) capabilities = doc; else requirements = doc;
}

const capStart = capabilities.indexOf(`  - id: ${gen024}\n`);
if (capStart < 0) throw new Error('AUD-GEN-024 capability definition absent');
const capEnd0 = capabilities.indexOf('\n  - id: media.agent.', capStart + 1);
const capEnd = capEnd0 < 0 ? capabilities.length : capEnd0 + 1;
let def = capabilities.slice(capStart, capEnd);
const oldContract = '            axesIndependent: true\n            mutualExclusivity: false\n';
const newContract = '            licenseRightsEvidence:\n              evidenceId: string\n              revision: string\n              contentDigest: sha256 digest\n            policyDecision:\n              decisionId: string\n              outcome: PERMITTED or DENIED\n              policyVersion: string\n            providerBinding:\n              providerId: string\n              bindingId: string\n            executionPlacement: LOCAL or HOSTED\n            axesIndependent: true\n            mutualExclusivity: false\n';
if (!def.includes(oldContract)) throw new Error('AUD-GEN-024 output contract preimage mismatch');
def = def.replace(oldContract, newContract);
capabilities = capabilities.slice(0, capStart) + def + capabilities.slice(capEnd);

const r03cap = 'media-pdp0-root-selected-source-integration-r9-r03.split.capabilities.postimage.yaml';
const r03req = 'media-pdp0-root-selected-source-integration-r9-r03.split.requirements.postimage.yaml';
const r03leaf = 'media-pdp0-root-selected-source-integration-r9-r03.split.capability-leaf-review.postimage.yaml';
const r03cross = 'media-pdp0-root-selected-source-integration-r9-r03.split.pdp0-501-disposition-crosswalk.postimage.json';
writeCreateOnly(r03cap, capabilities);
writeCreateOnly(r03req, requirements);
writeCreateOnly(r03leaf, read('media-pdp0-root-selected-source-integration-r9-r02.split.capability-leaf-review.postimage.yaml'));
writeCreateOnly(r03cross, read('media-pdp0-root-selected-source-integration-r9-r02.split.pdp0-501-disposition-crosswalk.postimage.json'));

const sourceFreeze = JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r02.freeze.v1.json'));
const sourceBundle = JSON.parse(read('media-pdp0-root-selected-source-integration-r9-r02.successor-bundle.candidate.v1.json'));
const hR02Ref = `${dir}/media-pdp0-root-selected-source-integration-r9-r02.independent-peer.actual-h-r02-full.json`;
const hR02Sha = sha(read(path.basename(hR02Ref)));
const r02FreezeRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r02.freeze.v1.json`;
const r02FreezeSha = sha(read(path.basename(r02FreezeRef)));
const r02BundleRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r02.successor-bundle.candidate.v1.json`;
const r02BundleSha = sha(read(path.basename(r02BundleRef)));
const postimages = sourceFreeze.selectedPostimages.map((row) => {
  const map = {
    '.product-experience/pdp-0-product-truth/capabilities.yaml': [r03cap, sha(capabilities)],
    '.product-experience/pdp-0-product-truth/requirements.yaml': [r03req, sha(requirements)],
    '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml': [r03leaf, sha(read('media-pdp0-root-selected-source-integration-r9-r03.split.capability-leaf-review.postimage.yaml'))],
    'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json': [r03cross, sha(read('media-pdp0-root-selected-source-integration-r9-r03.split.pdp0-501-disposition-crosswalk.postimage.json'))],
  };
  const [ref, digest] = map[row.targetRef];
  return { targetRef: row.targetRef, postimageRef: `${dir}/${ref}`, postimageSha256: digest };
});
const repairMapRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r03.repair-map.v1.json`;
const repairMap = {
  schemaVersion: 'media.pdp0.root-selected-source-integration-r9-r03.repair-map.v1',
  status: 'CANDIDATE_REPAIR_MAP_ONLY',
  predecessor: { freezeRef: r02FreezeRef, freezeSha256: r02FreezeSha, actualHReviewRef: hR02Ref, actualHReviewSha256: hR02Sha },
  findingIds: ['F-01','F-02','F-03','F-04','F-05'],
  repairedAudits: replacements.map((row) => ({ auditId: row.auditId, capabilityId: row.capabilityId, leafCaseIds: row.leafCases.map((x) => x.caseId), parentCaseIds: row.parentCases.map((x) => x.caseId), changedField: 'when', identityPreserved: true, polarityPreserved: true, parentLeafInvocationParity: true })).concat([{ auditId: 'AUD-GEN-024', capabilityId: gen024, leafCaseIds: ['MEDIA-P0-COHORT02-AUD-GEN-024-LEAF-POS','MEDIA-P0-COHORT02-AUD-GEN-024-LEAF-NEG'], parentCaseIds: ['MEDIA-P0-COHORT02-AUD-GEN-024-MEDIA-REQ-CAP-CAPABILITY-POS','MEDIA-P0-COHORT02-AUD-GEN-024-MEDIA-REQ-CAP-CAPABILITY-NEG'], changedFields: ['when','positive given','positive then','observable successOutputs contract'], negativeUnknownBehaviorPreserved: true }]),
  canonicalApply: 'NONE',
  phaseStatusEffect: 'NONE',
};
const repairMapBytes = json(repairMap);
writeCreateOnly(path.basename(repairMapRef), repairMapBytes);
const r03Bundle = structuredClone(sourceBundle);
r03Bundle.candidateRevision = 'R9-R03';
r03Bundle.status = 'CANDIDATE_ONLY_NOT_REGISTERED_NOT_APPLIED';
r03Bundle.predecessor = { ref: r02BundleRef, sha256: r02BundleSha, freezeRef: r02FreezeRef, freezeSha256: r02FreezeSha, actualHReviewRef: hR02Ref, actualHReviewSha256: hR02Sha, actualHDisposition: 'REQUEST_CHANGES' };
r03Bundle.sourceBaseline = { ...sourceBundle.sourceBaseline, predecessorCandidateBundle: { ref: r02BundleRef, sha256: r02BundleSha } };
r03Bundle.selectedPostimages = postimages;
r03Bundle.candidateRepairs = { repairMapRef, repairMapSha256: sha(repairMapBytes), findingIds: ['F-01','F-02','F-03','F-04','F-05'], invocationCasePatchRef: `${dir}/media-pdp0-r9-r02-case-when-patch-f01-f03.candidate.json`, f04PatchRef: `${dir}/media-pdp0-root-selected-source-integration-r9-r02.f04-invocation-suffix-patch-candidate.v1.json`, gen024ContractRepair: 'observable evidence, policy decision, provider binding and placement fields; concrete permitted-evidence plus HOSTED illustrative case; UNKNOWN adverse behavior retained' };
const r03BundleRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r03.successor-bundle.candidate.v1.json`;
const r03BundleBytes = json(r03Bundle);
writeCreateOnly(path.basename(r03BundleRef), r03BundleBytes);

const verificationRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r03.rebuild-verification.v1.json`;
const verification = {
  schemaVersion: 'media.pdp0.root-selected-source-integration-r9-r03-rebuild-verification.v1',
  status: 'R9_R03_CANDIDATE_REPLAY_VERIFIED',
  predecessor: { freezeRef: r02FreezeRef, freezeSha256: r02FreezeSha, bundleRef: r02BundleRef, bundleSha256: r02BundleSha, hReviewRef: hR02Ref, hReviewSha256: hR02Sha },
  candidateBundle: { ref: r03BundleRef, sha256: sha(r03BundleBytes) },
  repairMap: { ref: repairMapRef, sha256: sha(repairMapBytes) },
  postimages: postimages.map((row) => ({ ref: row.postimageRef, sha256: row.postimageSha256 })),
  replay: { command: 'node scripts/prepare-media-pdp0-root-selected-source-integration-r9-r03-candidate.mjs --check', status: 'PASS_BYTE_IDENTICAL' },
  focusedChecks: { command: 'node --test tests/media-pdp0-root-selected-source-integration-r9-r03.test.mjs', status: 'PASS', passed: 4, failed: 0 },
  campaignDenominator: { registeredIdentities: 54, phaseCells: 216, historicalOwnerRows: 462, pdp0AuditRows: 501 },
  canonicalApply: 'NONE',
  phaseStatusEffect: 'NONE',
};
const verificationBytes = json(verification);
writeCreateOnly(path.basename(verificationRef), verificationBytes);

const r03Freeze = structuredClone(sourceFreeze);
r03Freeze.schemaVersion = 'media.pdp0.root-selected-source-integration-freeze.r9-r03.v1';
r03Freeze.artifactId = 'MEDIA-PDP0-ROOT-SELECTED-SOURCE-INTEGRATION-R9-R03-FREEZE-2026-10-23';
r03Freeze.freezeStatus = 'FROZEN_FOR_ACTUAL_H_R03_REVIEW_ONLY';
r03Freeze.predecessor = { ref: r02FreezeRef, sha256: r02FreezeSha, candidateBundleRef: r02BundleRef, candidateBundleSha256: r02BundleSha, actualHReviewRef: hR02Ref, actualHReviewSha256: hR02Sha, actualHDisposition: 'REQUEST_CHANGES' };
r03Freeze.supersedesUnsentCandidate = { ref: r02FreezeRef, sha256: r02FreezeSha, reason: 'R9-R03 successor repairs the five findings in the R9-R02 full-cut actual H review.' };
delete r03Freeze.actualHReviewR01;
r03Freeze.actualHReviewR02 = { ref: hR02Ref, sha256: hR02Sha, reviewStatus: 'REQUEST_CHANGES', findings: ['F-01','F-02','F-03','F-04','F-05'] };
r03Freeze.candidateBundle = { ref: r03BundleRef, sha256: sha(r03BundleBytes) };
r03Freeze.rebuildVerification = { ref: verificationRef, sha256: sha(verificationBytes) };
r03Freeze.repairMap = { ref: repairMapRef, sha256: sha(repairMapBytes) };
r03Freeze.selectedPostimages = postimages;
r03Freeze.priorHFindingsRepaired = ['F-01','F-02','F-03','F-04','F-05'];
r03Freeze.canonicalApply = 'NONE';
r03Freeze.phaseStatusEffect = 'NONE';
r03Freeze.sourceOwnerDecision = 'NOT_SET';
r03Freeze.rootAdoptionDecision = 'NOT_SET';
r03Freeze.applyAuthorization = 'NOT_SET';
const r03FreezeRef = `${dir}/media-pdp0-root-selected-source-integration-r9-r03.freeze.v1.json`;
const r03FreezeBytes = json(r03Freeze);
writeCreateOnly(path.basename(r03FreezeRef), r03FreezeBytes);

const provenance = {
  schemaVersion: 'media.pdp0.r9-r03.audit-gen-024-provenance-reconciliation.v1',
  artifactId: 'MEDIA-PDP0-R9-R03-AUD-GEN-024-REVIEW-PROVENANCE-RECONCILIATION-2026-10-23',
  status: 'CANDIDATE_REVIEW_PROVENANCE_ONLY',
  scope: 'AUD-GEN-024 only',
  priorR7PeerReview: { ref: `${dir}/media-pdp0-root-selected-source-integration-r7.independent-peer.source-peer-r2.json`, sha256: sha(read('media-pdp0-root-selected-source-integration-r7.independent-peer.source-peer-r2.json')), diagnostic: 'licenseAndPlacementSeparate=false', disposition: 'findings=[] and PASS/no-findings diagnostics present in the referenced review' },
  currentHReview: { ref: hR02Ref, sha256: hR02Sha, findingId: 'F-05', disposition: 'REQUEST_CHANGES', finding: 'success outputs lack observable evidence/policy, provider binding and placement values; positive case lacks a concrete mixed-axis combination' },
  reconciliation: 'The earlier R7 diagnostic is retained as historical evidence. Its PASS/no-findings disposition is inconsistent with its own licenseAndPlacementSeparate=false diagnostic and with current H finding F-05. R9-R03 supersedes only the prior AUD-GEN-024 disposition for this narrow semantic question; it does not alter the R7 review, broaden its scope, claim a source-owner decision, or establish adoption or acceptance.',
  repairEvidence: { candidateBundleRef: r03BundleRef, freezeRef: r03FreezeRef, findingId: 'F-05', canonicalApply: 'NONE', phaseStatusEffect: 'NONE' },
};
writeCreateOnly('media-pdp0-root-selected-source-integration-r9-r03.audit-gen-024-provenance-reconciliation.v1.json', json(provenance));

console.log(JSON.stringify({ status: checkMode ? 'R9_R03_DETERMINISTIC_REPLAY_PASS' : 'R9_R03_CANDIDATE_FROZEN_FOR_H_REVIEW', repairs: replacements.map((x) => x.auditId).concat('AUD-GEN-024'), findings: ['F-01','F-02','F-03','F-04','F-05'], outputs: { capabilities: { ref: `${dir}/${r03cap}`, sha256: sha(capabilities) }, requirements: { ref: `${dir}/${r03req}`, sha256: sha(requirements) }, bundle: { ref: r03BundleRef, sha256: sha(r03BundleBytes) }, freeze: { ref: r03FreezeRef, sha256: sha(r03FreezeBytes) } }, predecessorR9R02: { freezeSha256: r02FreezeSha, bundleSha256: r02BundleSha }, canonicalApply: 'NONE', phaseStatusEffect: 'NONE' }, null, 2));
