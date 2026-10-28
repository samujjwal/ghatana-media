import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { stagePinnedCandidate } from '../scripts/qualification/prepare-wave2-reference-assets.mjs';
const bytes=Buffer.from('local synthetic independent test weight bytes');
const digest=createHash('sha256').update(bytes).digest('hex');
const candidate={id:'reference-test',kind:'MODEL',status:'REVIEW_ONLY',proposedUse:'LOCAL_EVALUATION',
  upstreamUrl:'https://openaipublic.azureedge.net/model.onnx',maxBytes:1024,artifactSha256:digest};
const catalog={schemaVersion:'ghatana.media.wave2.reference-candidates.v1',
  operationalPolicy:{noCandidateIsAdmitted:true},candidates:[candidate]};
const response=(actual=bytes,url=candidate.upstreamUrl)=>({ok:true,url,headers:new Headers({'content-length':String(actual.length)}),
  body:(async function*(){yield actual;})()});
const withTmp=async fn=>{const root=mkdtempSync(join(tmpdir(),'wave2-staging-test-'));try{await fn(root)}finally{rmSync(root,{recursive:true,force:true})}};
test('source download exact digest can stage review-only bytes in private directory',async()=>withTmp(async folder=>{
  const result=await stagePinnedCandidate({id:candidate.id,destination:folder,catalog,fetcher:async()=>response()});
  assert.equal(result.sha256,digest);
  assert.equal(result.status,'BYTE_INTEGRITY_VERIFIED_ONLY_RIGHTS_NOT_ADMITTED');
  assert.equal(readFileSync(join(result.folder,'verified-source.onnx')).toString(),bytes.toString());
  assert.equal(JSON.parse(readFileSync(join(result.folder,'SOURCE-RECEIPT.json'))).status,
    'BYTE_INTEGRITY_VERIFIED_ONLY_RIGHTS_NOT_ADMITTED');
}));
test('wrong artifact digest cannot publish a staged model',async()=>withTmp(async folder=>{
  await assert.rejects(stagePinnedCandidate({id:candidate.id,destination:folder,catalog,fetcher:async()=>response(Buffer.from('wrong'))}),/MODEL_SOURCE_DIGEST_MISMATCH/);
  assert.deepEqual(readdirSync(folder),[]);
}));
test('unanchored candidate refuses download before network',async()=>withTmp(async folder=>{
  let called=false;
  await assert.rejects(stagePinnedCandidate({id:candidate.id,destination:folder,
    catalog:{...catalog,candidates:[{...candidate,artifactSha256:null}]},
    fetcher:async()=>{called=true;return response()}}),/NO_SOURCE_PINNED_EVALUATION_CANDIDATE/);
  assert.equal(called,false);
}));
test('untrusted redirect refuses source response',async()=>withTmp(async folder=>{
  await assert.rejects(stagePinnedCandidate({id:candidate.id,destination:folder,catalog,
    fetcher:async()=>response(bytes,'https://attacker.example/malicious.onnx')}),/MODEL_REDIRECT_NOT_ALLOWLISTED/);
  assert.deepEqual(readdirSync(folder),[]);
}));
test('source pin does not overwrite an existing reviewed directory',async()=>withTmp(async folder=>{
  await stagePinnedCandidate({id:candidate.id,destination:folder,catalog,fetcher:async()=>response()});
  await assert.rejects(stagePinnedCandidate({id:candidate.id,destination:folder,catalog,
    fetcher:async()=>response()}),/REFUSE_TO_OVERWRITE_STAGED_ASSET/);
}));
