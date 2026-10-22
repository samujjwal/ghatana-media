import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {auditMediaClosure} from '../scripts/audit-media-closure-readiness.mjs';
const phases=['media.product-truth.definition-acceptance','media.canonical-domain-data.definition-acceptance','media.design-interface-system.definition-acceptance','media.complete-product-experience.definition-acceptance'];
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'media-gtool-'));
 const write=(name,x)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(x))};
 const physical=Array.from({length:26},(_,i)=>({surfaceId:'phys-'+i}));
 const compositions=Array.from({length:7},(_,i)=>({surfaceId:'comp-'+i,children:i===0?['phys-0']:[]}));
 const logical=Array.from({length:21},(_,i)=>({surfaceId:'logical-'+i,physicalRefs:['phys-0']}));
 write('.product-experience/surfaces/media-physical-topology.v1.json',{manifestCandidates:physical,compositions,consumerCrosswalk:logical});
 write('config/closure/consumer.json',{consumerId:'ghatana-media.product-definition',providerBindings:[]});
 write('config/closure/media-product-definition/surface.json',{id:'media.product-definition',obligationIds:phases.map((_,i)=>'o-'+i),composition:{childSurfaceIds:[]}});
 write('config/closure/media-product-definition/phase-program.json',{programId:'media.product-definition.v1',phases:phases.map((id,i)=>({id,obligationIds:['o-'+i]}))});
 write('config/closure/media-product-definition/phase-binding.json',{closureSurfaceId:'media.product-definition',phases:Object.fromEntries(phases.map((id,i)=>[id,{obligationIds:['o-'+i]}]))});
 write('config/closure/media-product-definition/obligations.json',phases.map((id,i)=>({
  id:'o-'+i,closureSurfaceId:'media.product-definition',programId:'media.product-definition.v1',
  phaseSemantics:{applicableIn:[id]},extensions:{'media-source':{
   sourceRef:'.product-experience/pdp-'+i+'-product-truth/PRODUCT-TRUTH.md#/requirements/'+i,
   recordId:'requirement-'+i,sourceDigest:'sha256:'+'0'.repeat(64)
  }}
 })));
 write('config/closure/media-product-definition/l02-source-case-links.json',{links:[]});
 write('config/closure/media-product-definition/l03-proof-route-candidates.json',{routes:[],l02CaseLinkReview:{unmappedObligationCount:4}});
 write('config/closure/media-product-definition/pending-decisions.json',{receipts:[]});
 return {root,write,compositions,physical,logical};
}
test('canonicalized temporary fixture root keeps 54 source identities distinct from native closure',()=>{
 const f=fixture();try{const result=auditMediaClosure(f.root);assert.equal(result.invariants.passed,true);assert.equal(result.sourcePopulation.total,54);assert.equal(result.nativeClosure.status,'NOT_PROVEN');assert.equal(result.writesPerformed,false);assert.ok(result.nativeClosure.blockers.includes('AP02_AP03_OWNER_ADMISSION_UNVERIFIED'))}finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
test('reject symlinked source that escapes the canonicalized temporary root',()=>{
 const f=fixture(),outside=fs.mkdtempSync(path.join(os.tmpdir(),'media-gtool-outside-'));
 try{
  const source=path.join(outside,'consumer.json');fs.writeFileSync(source,JSON.stringify({consumerId:'ghatana-media.product-definition',providerBindings:[]}));
  const linked=path.join(f.root,'config/closure/consumer.json');fs.unlinkSync(linked);fs.symlinkSync(source,linked);
  const result=auditMediaClosure(f.root);
  const issue=result.invariants.issues.find(x=>x.code==='SOURCE_UNAVAILABLE'&&x.detail.kind==='consumer');
  assert.ok(issue);assert.match(issue.detail.reason,/SOURCE_PATH_ESCAPE:config\/closure\/consumer\.json/);
 }finally{fs.rmSync(f.root,{recursive:true,force:true});fs.rmSync(outside,{recursive:true,force:true})}
});
test('reject orphan child and unsupported consumer proof-producer binding',()=>{
 const f=fixture();try{f.compositions[0].children=['missing'];f.write('.product-experience/surfaces/media-physical-topology.v1.json',{manifestCandidates:f.physical,compositions:f.compositions,consumerCrosswalk:f.logical});f.write('config/closure/consumer.json',{consumerId:'ghatana-media.product-definition',providerBindings:[{}]});const result=auditMediaClosure(f.root);assert.ok(result.invariants.issues.some(x=>x.code==='COMPOSITION_CHILD_MISSING'));assert.ok(result.invariants.issues.some(x=>x.code==='CONSUMER_PROOF_PRODUCER_BINDING_UNSUPPORTED'))}finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
test('reject changed phase binding without opening PDP',()=>{
 const f=fixture();try{f.write('config/closure/media-product-definition/phase-binding.json',{closureSurfaceId:'media.product-definition',phases:Object.fromEntries(phases.map((id,i)=>[id,{obligationIds:i===0?[]:['o-'+i]}]))});assert.ok(auditMediaClosure(f.root).invariants.issues.some(x=>x.code==='PHASE_OBLIGATION_DRIFT'))}finally{fs.rmSync(f.root,{recursive:true,force:true})}
});

test('reject missing persisted source obligation, despite green phase lists',()=>{
 const f=fixture();try{
  f.write('config/closure/media-product-definition/obligations.json',[]);
  const result=auditMediaClosure(f.root);
  assert.equal(result.invariants.passed,false);
  assert.ok(result.invariants.issues.some(x=>x.code==='OBLIGATION_REGISTRY_IDENTITY_DRIFT'));
 }finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
test('reject wrong owner and source meaning on persisted requirement',()=>{
 const f=fixture();try{
  const rows=phases.map((phase,i)=>({
   id:'o-'+i,closureSurfaceId:i?'media.product-definition':'other-writer',programId:'media.product-definition.v1',
   phaseSemantics:{applicableIn:[phase]},extensions:{'media-source':{
    sourceRef:'.product-experience/pdp-'+i+'-product-truth/PRODUCT-TRUTH.md#/requirements/'+i,
    recordId:'requirement-'+i,sourceDigest:'sha256:'+'0'.repeat(64)
   }}
  }));
  f.write('config/closure/media-product-definition/obligations.json',rows);
  const result=auditMediaClosure(f.root);
  assert.ok(result.invariants.issues.some(x=>x.code==='OBLIGATION_RECORD_PHASE_OWNER_MISMATCH'));
 }finally{fs.rmSync(f.root,{recursive:true,force:true})}
});
