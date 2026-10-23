import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {gzipSync} from 'node:zlib';
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
function tarEntry(name,content,type='0',linkName=''){
 const data=Buffer.from(content),header=Buffer.alloc(512);
 header.write(name,0,100,'utf8');header.write('0000644\0',100,8,'ascii');header.write('0000000\0',108,8,'ascii');header.write('0000000\0',116,8,'ascii');header.write(data.length.toString(8).padStart(11,'0')+'\0',124,12,'ascii');header.write('00000000000\0',136,12,'ascii');header.fill(32,148,156);header.write(type,156,1,'ascii');header.write(linkName,157,100,'utf8');header.write('ustar\0',257,6,'ascii');header.write('00',263,2,'ascii');
 const checksum=header.reduce((sum,byte)=>sum+byte,0);header.write(checksum.toString(8).padStart(6,'0')+'\0 ',148,8,'ascii');
 const padding=Buffer.alloc((512-data.length%512)%512);return Buffer.concat([header,data,padding]);
}
function writeExplicitDirectoryTar(fileMap,archivePath){
 const dirs=new Set();for(const name of fileMap.keys()){const parts=name.split('/');parts.pop();while(parts.length){dirs.add(parts.join('/'));parts.pop()}}
 const entries=[...([...dirs].sort().map(name=>tarEntry(name+'/',Buffer.alloc(0),'5'))),...[...fileMap].sort(([a],[b])=>a.localeCompare(b)).map(([name,data])=>tarEntry(name,data))];
 fs.writeFileSync(archivePath,Buffer.concat([...entries,Buffer.alloc(1024)]));
 return Buffer.concat([...entries,Buffer.alloc(1024)]);
}
function fixture(){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'media-ap03-source-'));
 const external=fs.mkdtempSync(path.join(os.tmpdir(),'media-ap03-owner-'));
 const write=(name,content)=>{const file=path.join(root,name);fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,typeof content==='string'?content:JSON.stringify(content))};
 for(const rel of BASE)write(rel,{fixture:true});
 write('config/closure/consumer.json',{sources:{surfaces:[{kind:'file',ref:'config/closure/media-product-definition/surface.json'}]}});
 write('config/closure/media-product-definition/obligations.json',[{id:'o1',extensions:{'media-source':{sourceRef:'.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md#heading'}}}]);
 write('config/closure/media-product-definition/l02-source-case-links.json',{candidateLinks:[{sourcePath:'tests/linked-case.test.mjs'}]});
 write('config/closure/media-product-definition/l03-proof-route-candidates.json',{candidates:[{sourceRef:'scripts/proof/producer.json#/producerId'}]});
 write('.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md','# source truth');
 write('tests/linked-case.test.mjs','// L02 case source');
 write('scripts/proof/producer.json','{}');
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
  assert.equal(manifest.files.length,BASE.length+3);
  assert.ok(manifest.files.some(x=>x.path==='.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md'));
  assert.ok(manifest.files.some(x=>x.path==='tests/linked-case.test.mjs'));
  assert.ok(manifest.files.some(x=>x.path==='scripts/proof/producer.json'));
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
test('rejects a symlink in the selected source set',()=>{
 const f=fixture();try{
  const member=path.join(f.root,'config/closure/consumer.json');
  const target=path.join(f.external,'linked-source.json');
  fs.writeFileSync(target,'{}');
  fs.unlinkSync(member);
  fs.symlinkSync(target,member);
  assert.throws(()=>createSnapshotCandidate({root:f.root,archivePath:f.archive,outputPath:f.output}),/UNSAFE_SOURCE_MEMBER:config\/closure\/consumer\.json/);
 }finally{f.cleanup()}
});
test('will not overwrite an existing archive',()=>{
 const f=fixture();try{
  fs.writeFileSync(f.archive,'preexisting');
  assert.throws(()=>createSnapshotCandidate({root:f.root,archivePath:f.archive,outputPath:f.output,createArchive:true}),/ARCHIVE_ALREADY_EXISTS/);
 }finally{f.cleanup()}
});
test('rejects an archive with matching membership but mismatched source bytes',()=>{
 const f=fixture();try{
  const mirror=path.join(f.external,'archive-tree');fs.mkdirSync(mirror,{recursive:true});
  const listing=spawnSync('git',['ls-files','-z'],{cwd:f.root,encoding:'buffer'});assert.equal(listing.status,0);
  const paths=listing.stdout.toString('utf8').split('\0').filter(Boolean);
  for(const rel of paths){const dest=path.join(mirror,rel);fs.mkdirSync(path.dirname(dest),{recursive:true});fs.copyFileSync(path.join(f.root,rel),dest)}
  fs.writeFileSync(path.join(mirror,'tests/linked-case.test.mjs'),'// L02 case forged');
  const archived=spawnSync('tar',['-cf',f.archive,'-C',mirror,...paths],{encoding:'utf8',env:{...process.env,COPYFILE_DISABLE:'1'}});
  if(archived.error?.code==='ENOENT')throw Error('TAR_REQUIRED_FOR_ARCHIVE_TEST: install tar and ensure tar is on PATH');
  assert.equal(archived.status,0,String(archived.stderr));
  assert.throws(()=>createSnapshotCandidate({root:f.root,archivePath:f.archive,outputPath:f.output}),/ARCHIVE_MEMBER_CONTENT_MISMATCH:tests\/linked-case\.test\.mjs/);
  assert.equal(fs.existsSync(path.join(f.root,f.output)),false);
 }finally{f.cleanup()}
});
test('rejects a symlink entry inside the archive',()=>{
 const f=fixture();try{
  const names=[...BASE,'.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md','tests/linked-case.test.mjs','scripts/proof/producer.json'];
  const files=new Map(names.map(name=>[name,fs.readFileSync(path.join(f.root,name))]));
  const dirs=new Set();for(const name of names){const parts=name.split('/');parts.pop();while(parts.length){dirs.add(parts.join('/'));parts.pop()}}
  const entries=[...([...dirs].sort().map(name=>tarEntry(name+'/',Buffer.alloc(0),'5')))];
  for(const [name,data] of [...files].sort(([a],[b])=>a.localeCompare(b))){
   entries.push(name==='config/closure/consumer.json'
    ?tarEntry(name,Buffer.alloc(0),'2','../../outside.json')
    :tarEntry(name,data));
  }
  fs.writeFileSync(f.archive,Buffer.concat([...entries,Buffer.alloc(1024)]));
  assert.throws(()=>createSnapshotCandidate({root:f.root,archivePath:f.archive,outputPath:f.output}),/ARCHIVE_UNSAFE_MEMBER_TYPE:config\/closure\/consumer\.json/);
 }finally{f.cleanup()}
});
test('rejects compressed archives because the candidate producer emits plain tar',()=>{
 const f=fixture();try{
  const names=[...BASE,'.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md','tests/linked-case.test.mjs','scripts/proof/producer.json'];
  const files=new Map(names.map(name=>[name,fs.readFileSync(path.join(f.root,name))]));
  fs.writeFileSync(f.archive,gzipSync(writeExplicitDirectoryTar(files,f.archive)));
  assert.throws(()=>createSnapshotCandidate({root:f.root,archivePath:f.archive,outputPath:f.output}),/ARCHIVE_PLAIN_TAR_REQUIRED/);
 }finally{f.cleanup()}
});
test('accepts explicit zero-size parent directory entries in a plain tar archive',()=>{
 const f=fixture();try{
  const names=[...BASE,'.product-experience/pdp-0-product-truth/PRODUCT-TRUTH.md','tests/linked-case.test.mjs','scripts/proof/producer.json'];
  const files=new Map(names.map(name=>[name,fs.readFileSync(path.join(f.root,name))]));
  writeExplicitDirectoryTar(files,f.archive);
  const r=createSnapshotCandidate({root:f.root,archivePath:f.archive,outputPath:f.output});
  assert.equal(r.status,'SOURCE_MEMBERSHIP_CANDIDATE_ONLY');
  assert.equal(r.memberCount,names.length);
 }finally{f.cleanup()}
});
