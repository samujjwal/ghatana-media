import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createSnapshotCandidate} from '../scripts/prepare-media-ap03-snapshot.mjs';
const BASE=[
 'config/closure/consumer.json',
 'config/closure/media-product-definition/surface.json',
 'config/closure/media-product-definition/phase-program.json',
 'config/closure/media-product-definition/phase-binding.json',
 'config/closure/media-product-definition/obligations.json',
 'config/closure/media-product-definition/l02-source-case-links.json',
 'config/closure/media-product-definition/l03-proof-route-candidates.json',
 'config/closure/media-product-definition/pending-decisions.json',
 '.product-experience/source-manifest.yaml',
 '.product-experience/surfaces/media-physical-topology.v1.json',
 ...[0,1,2,3].flatMap(i=>['docs/implementation/pdp-'+i+'-phase-dev-status.json','docs/implementation/verification/pdp-38/pdp'+i+'-surface-phase-status-matrix.json'])
];
function run(cwd,args){const x=spawnSync('git',args,{cwd,encoding:'utf8'});assert.equal(x.status,0,String(x.stderr))}
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'media-ap03-source-'));
 const external=fs.mkdtempSync(path.join(os.tmpdir(),'media-ap03-owner-'));
 const write=(name,content)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof content==='string'?content:JSON.stringify(content))};
 for(const rel of BASE)write(rel,{fixture:true});
 write('config/closure/consumer.json',{sources:{surfaces:[{kind:'file',ref:'config/closure/media-product-definition/surface.json'}]}});
 write('config/closure/media-product-definition/obligations.json',[{id:'o1',extensions:{'media-source':{sourceRef:'.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md#heading'}}}]);
 write('.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md','# source truth');
 run(root,['init','--quiet']);run(root,['config','user.email','gtool-fixture@example.invalid']);run(root,['config','user.name','gtool-fixture']);
 run(root,['add','.']);run(root,['commit','--quiet','-m','fixture source']);
 return {root,external,write,archive:path.join(external,'source.tar'),output:'config/closure/admission/source-snapshot.json',cleanup(){fs.rmSync(root,{recursive:true,force:true});fs.rmSync(external,{recursive:true,force:true})}};
}
test('prepare real archive and source membership but never confer owner admission',()=>{
 const f=fixture();try{
  const r=createSnapshotCandidate({root:f.root,archivePath:f.archive,outputPath:f.output,createArchive:true});
  assert.equal(r.status,'SOURCE_MEMBERSHIP_CANDIDATE_ONLY');
  assert.equal(r.canonicalAdmission,'NOT_PERFORMED');
  assert.equal(r.ap03Authority,'NOT_ISSUED');
  assert.ok(fs.statSync(f.archive).size>0);
  const manifest=JSON.parse(fs.readFileSync(path.join(f.root,f.output),'utf8'));
  assert.equal(manifest.workspaceRoot,fs.realpathSync(f.root));
  assert.equal(manifest.files.length,BASE.length+1);
  assert.ok(manifest.files.some(x=>x.path==='.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md'));
  assert.deepEqual(manifest.files.map(x=>x.path),[...manifest.files.map(x=>x.path)].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b))));
  const readback=createSnapshotCandidate({root:f.root,archivePath:f.archive,outputPath:f.output,check:true});
  assert.equal(readback.writesPerformed,false);
 }finally{f.cleanup()}
});
test('uncommitted mutation of a selected source fails closed',()=>{
 const f=fixture();try{
  f.write('config/closure/media-product-definition/surface.json',{dirty:true});
  assert.throws(()=>createSnapshotCandidate({root:f.root,archivePath:f.archive,outputPath:f.output,createArchive:true}),/SOURCE_NOT_COMMITTED_CURRENT/);
 }finally{f.cleanup()}
});
test('will not overwrite an existing archive',()=>{
 const f=fixture();try{
  fs.writeFileSync(f.archive,'preexisting');
  assert.throws(()=>createSnapshotCandidate({root:f.root,archivePath:f.archive,outputPath:f.output,createArchive:true}),/ARCHIVE_ALREADY_EXISTS/);
 }finally{f.cleanup()}
});
