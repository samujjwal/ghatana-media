import test from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createHash, sign as signEd25519 } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { validateCatalog, verifyEvidencePacket, SCHEMA } from '../scripts/qualification/verify-wave2-evidence.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture() {
  const folder = mkdtempSync(join(tmpdir(), 'media-evidence-intake-'));
  const root = join(folder, 'private');
  mkdirSync(root);
  const primary = Buffer.from('original synthetic public no-subject model bytes');
  writeFileSync(join(root,'model.bin'), primary);
  const digest = sha(primary);
  const candidate = {
    id:'reference-test',status:'REVIEW_ONLY',proposedUse:'LOCAL_EVALUATION',
    artifactSha256:digest,maxBytes:1024,requiredProofTypes:['MODEL_WEIGHTS_LICENSE','PROVIDER_QUALITY']
  };
  const catalog = {schemaVersion:'ghatana.media.wave2.reference-candidates.v1',
    operationalPolicy:{noCandidateIsAdmitted:true}, candidates:[candidate]};
  const {privateKey,publicKey} = generateKeyPairSync('ed25519');
  const trust = {trustedReviewers:[{id:'test-signer',allowedKinds:candidate.requiredProofTypes,
    publicKeyPem:publicKey.export({format:'pem',type:'spki'}).toString()}]};
  const receipts = [];
  for (const kind of candidate.requiredProofTypes) {
    const claim = {schemaVersion:'ghatana.media.wave2.signed-authorization.v1',
      subjectId:candidate.id,kind,signerId:'test-signer',decision:'ALLOW',scope:'LOCAL_EVALUATION',
      decisionReference:'TEST-ONLY-NOT-REAL-AUTHORITY',evidenceSourceRef:'test-source:original-fixture',
      assetSha256:digest,permittedPurposes:['LOCAL_EVALUATION'],
      validFrom:'2025-01-01T00:00:00Z',validUntil:'2028-01-01T00:00:00Z'};
    const buf=Buffer.from(JSON.stringify(claim));
    writeFileSync(join(root,kind+'.json'),buf);
    writeFileSync(join(root,kind+'.sig'),signEd25519(null,buf,privateKey).toString('base64'));
    receipts.push({kind,signerId:'test-signer',document:kind+'.json',signature:kind+'.sig'});
  }
  const packet={schemaVersion:SCHEMA,candidateId:candidate.id,purpose:'LOCAL_EVALUATION',
    primaryArtifactSha256:digest,artifacts:[{role:'primary',path:'model.bin',sha256:digest}],receipts};
  return {folder,root,packet,catalog,trust,digest};
}

const withFixture=async f=>{let x=fixture();try{await f(x)}finally{rmSync(x.folder,{recursive:true,force:true})}};
test('catalog is source observation, never provider qualification',()=>{
  const f=fixture();try{
    let check=validateCatalog(f.catalog);
    assert.equal(check.productionAdmitted,false);
    assert.equal(check.currentStatus,'SOURCE_CANDIDATES_ONLY');
    assert.throws(()=>validateCatalog({...f.catalog,candidates:[{...f.catalog.candidates[0],status:'ADMITTED'}]}),/INVALID_SOURCE_RESEARCH_CANDIDATE/);
  }finally{rmSync(f.folder,{recursive:true,force:true})}
});
test('authentic signed private packet proves integrity but never grants provider production admission',async()=>withFixture(async f=>{
  const result=await verifyEvidencePacket(f.packet,{catalog:f.catalog,trust:f.trust,privateRoot:f.root,
    now:Date.parse('2026-10-28T00:00:00Z')});
  assert.equal(result.productionAdmitted,false);
  assert.equal(result.status,'INTEGRITY_CHECKED_INDEPENDENT_OWNER_REVIEW_REQUIRED');
  assert.deepEqual(result.exactSignedReceiptTypes,['MODEL_WEIGHTS_LICENSE','PROVIDER_QUALITY']);
  assert.equal(result.verifiedFiles[0].sha256,f.digest);
}));
test('unknown signer fails even if packet claims approval',async()=>withFixture(async f=>{
  await assert.rejects(verifyEvidencePacket(f.packet,{catalog:f.catalog,trust:{trustedReviewers:[]},
    privateRoot:f.root}),/NO_PINNED_TRUST_ANCHORS/);
}));
test('signed document tamper is rejected',async()=>withFixture(async f=>{
  writeFileSync(join(f.root,'MODEL_WEIGHTS_LICENSE.json'),JSON.stringify({decision:'ALLOW'}));
  await assert.rejects(verifyEvidencePacket(f.packet,{catalog:f.catalog,trust:f.trust,
    privateRoot:f.root}),/INVALID_RECEIPT_SIGNATURE/);
}));
test('no substitute for independent source digest',async()=>withFixture(async f=>{
  const unknown={...f.catalog,candidates:[{...f.catalog.candidates[0],artifactSha256:null}]};
  await assert.rejects(verifyEvidencePacket(f.packet,{catalog:unknown,trust:f.trust,
    privateRoot:f.root}),/ARTIFACT_NEEDS_INDEPENDENT_UPSTREAM_SHA256_PIN/);
}));
test('packet path traversal and symlink are rejected',async()=>withFixture(async f=>{
  const traversal={...f.packet,artifacts:[{role:'primary',path:'../outside.bin',sha256:f.digest}]};
  await assert.rejects(verifyEvidencePacket(traversal,{catalog:f.catalog,trust:f.trust,
    privateRoot:f.root}),/INVALID_PRIVATE_RELATIVE_PATH/);
  symlinkSync(join(f.root,'model.bin'),join(f.root,'alias.bin'));
  const alias={...f.packet,artifacts:[{role:'primary',path:'alias.bin',sha256:f.digest}]};
  await assert.rejects(verifyEvidencePacket(alias,{catalog:f.catalog,trust:f.trust,
    privateRoot:f.root}),/SYMLINKED_PRIVATE_EVIDENCE_PATH/);
}));
test('unearned proof kind cannot pass',async()=>withFixture(async f=>{
  const packet={...f.packet,receipts:f.packet.receipts.slice(0,1)};
  await assert.rejects(verifyEvidencePacket(packet,{catalog:f.catalog,trust:f.trust,
    privateRoot:f.root,now:Date.parse('2026-10-28T00:00:00Z')}),/MISSING_REQUIRED_SIGNED_PROOF_PROVIDER_QUALITY/);
}));
test('expired scope is refused',async()=>withFixture(async f=>{
  await assert.rejects(verifyEvidencePacket(f.packet,{catalog:f.catalog,trust:f.trust,
    privateRoot:f.root,now:Date.parse('2029-01-01T00:00:00Z')}),/EXPIRED_OR_NOT_YET_VALID_RECEIPT/);
}));

test('public candidate catalog and 36-row evidence map remain nonauthoritative and exhaustive',()=>{
  const root = new URL('../',import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL('../config/qualification/wave2-reference-candidates.v1.json',import.meta.url),'utf8'));
  const map = JSON.parse(readFileSync(new URL('../config/qualification/wave2-evidence-to-task-map.v1.json',import.meta.url),'utf8'));
  const r8 = JSON.parse(readFileSync(new URL('../docs/implementation/MEDIA-WAVE2-R8-FULL-ACCEPTANCE-MATRIX.json',import.meta.url),'utf8'));
  assert.equal(validateCatalog(catalog).productionAdmitted,false);
  const ours=new Set(map.remainingTaskRouting.map(x=>x.taskId));
  assert.equal(ours.size,36);
  assert.deepEqual([...ours].sort(), r8.rows.map(x=>x.id).sort());
  assert.equal(map.counts.locallyVerified,22);
  assert.equal(map.counts.ownerExternal,6);
  assert.equal(map.workPackages.length,10);
  assert.ok(map.remainingTaskRouting.every(x=>x.canPromoteAutomatically===false));
});
