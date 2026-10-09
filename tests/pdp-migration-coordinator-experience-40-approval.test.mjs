import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';
import { resolvePdp3BindingSourceRef } from './helpers/pdp-migration-source-selector.mjs';
const {parse}=createRequire(path.resolve('../ghatana-tools/package.json'))('yaml');
const p='docs/implementation/verification/pdp-38/migration-coordinator-experience-review-40.json';
const approval=JSON.parse(fs.readFileSync(p,'utf8'));
const hash=x=>crypto.createHash('sha256').update(x).digest('hex');
const jsonHash=x=>hash(JSON.stringify(x));
const ledger=parse(fs.readFileSync('.product-experience/pdp-0-product-truth/migration-semantics-review.yaml','utf8')).pdp38ClaimReconciliation;
const leaves=ledger.records.flatMap(r=>r.claims??[]).flatMap(c=>c.subclaims??[c]);
const proposalText=fs.readFileSync(approval.proposalArtifactRef,'utf8');
const proposal=JSON.parse(proposalText);
const correctionPath='docs/implementation/verification/pdp-38/migration-experience-40-cross-owner-correction.json';
const correctionText=fs.readFileSync(correctionPath,'utf8');
assert.equal(hash(correctionText),'206bf5f37e8e0ab248802bed93bae0c801d6a438cf8c21154defa41acc11d36f');
const correction=JSON.parse(correctionText);
assert.equal(correction.baseArtifactRef,p);assert.equal(correction.baseArtifactSha256,hash(fs.readFileSync(p)));
assert.deepEqual(correction.records.map(r=>r.claimId),['MPSEM-0458-C002','MPSEM-0458-C006']);
const docs={};
function resolveRef(ref){const source=ref.split('#')[0]; docs[source]??=parse(fs.readFileSync(source,'utf8'));const value=resolvePdp3BindingSourceRef(ref,docs);assert.notEqual(value,undefined,ref);return value;}
test('PXD-097 reviews exactly the unchanged 40-claim proposal with current source meanings',()=>{
 assert.equal(approval.decisionRef,'.product-experience/decision-log.md#PXD-097');
 assert.equal(approval.reviewedRecordCount,40);assert.equal(approval.records.length,40);
 assert.equal(new Set(approval.records.map(r=>r.claimId)).size,40);
 assert.equal(hash(proposalText),approval.proposalArtifactSha256);assert.equal(proposal.rootReviewStatus,'PENDING');
 for(const row of approval.records){const input=proposal.records.find(r=>r.claimId===row.claimId),current=leaves.find(r=>r.claimId===row.claimId);
 assert.equal(jsonHash(input),row.proposalRecordSha256);assert.equal(row.exactSourceText,current.exactSourceText);assert.equal(hash(current.exactSourceText),row.sourceTextSha256);
 assert.equal(current.semanticReviewRef,`${p}#/records/@claimId=${row.claimId}`);assert.equal(current.targetRef,row.currentTargetRef);
 assert.equal(current.targetTextSha256,row.currentTargetValueSha256);assert.equal(jsonHash(resolveRef(current.targetRef)),row.currentTargetValueSha256);
 assert.equal(current.semanticReviewStatus,'CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED');assert.equal(current.acceptanceEffect,'none');
 for(const [ref,fingerprint]of Object.entries(row.sourceAuthorityTargetFingerprints)){
 const supplemental=correction.records.find(r=>r.claimId===row.claimId&&r.sourceRef===ref);
 if(!supplemental){assert.equal(jsonHash(resolveRef(ref)),fingerprint);continue;}
 assert.equal(supplemental.priorValueSha256,fingerprint);
 const current=resolveRef(ref);const {processIsolationDoesNotWaiveLicenseRule:added,...prior}=current;
 assert.equal(jsonHash(prior),fingerprint,'all prior authority fields remain exact');
 assert.deepEqual(added,correction.reviewedChange.current);
 assert.equal(jsonHash(current),supplemental.currentValueSha256);
 }
 }
});
test('migration counters remain derived and no other claim was promoted by the bounded approval',()=>{
 const ids=new Set(approval.records.map(r=>r.claimId));
 const verified=leaves.filter(r=>r.semanticReviewStatus==='CLAIM_SPECIFIC_SEMANTIC_PARITY_VERIFIED');
 const pending=leaves.filter(r=>r.semanticReviewStatus==='OWNER_TARGET_LOCATOR_ONLY_PENDING_CLAIM_PARITY');
 assert.equal(verified.length,ledger.semanticParityVerifiedClaimUnitCount);assert.equal(pending.length,ledger.candidateTargetPendingSemanticParityCount);
 assert.equal(verified.filter(r=>ids.has(r.claimId)).length,40);
 assert.equal(leaves.filter(r=>r.semanticReviewRef?.startsWith(p)).length,40);
});
