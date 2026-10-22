#!/usr/bin/env node
/**
 * Produce a real, reproducible AP-03 source membership candidate from tracked Media files.
 * Does not issue AP-03, register a verifier or assert Lifecycle admission.
 * Usage: node scripts/prepare-media-ap03-snapshot.mjs --archive <actual-archive> --output <relative-in-repo.json> [--check]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {spawnSync} from 'node:child_process';
const SOURCE=[
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
 ...[0,1,2,3].flatMap(i=>[
  'docs/implementation/pdp-'+i+'-phase-dev-status.json',
  'docs/implementation/verification/pdp-38/pdp'+i+'-surface-phase-status-matrix.json'
 ])
];
const sha=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
function relativeSafe(name){
 return typeof name==='string'&&name.length>0&&!path.isAbsolute(name)&&!name.includes('\\')&&name.split('/').every(x=>x!==''&&x!=='.'&&x!=='..');
}
function cmd(root,args){const r=spawnSync('git',args,{cwd:root,encoding:'utf8',timeout:10000,maxBuffer:1024*1024});if(r.error||r.status!==0)throw Error('GIT_TRACKED_SOURCE_REQUIRED:'+args.join(' '));return r.stdout.trim()}
function readOwned(root,name){
 if(!relativeSafe(name))throw Error('INVALID_SOURCE_PATH:'+name);
 const file=path.join(root,name),st=fs.lstatSync(file);
 if(!st.isFile()||st.isSymbolicLink()||st.nlink!==1)throw Error('UNSAFE_SOURCE_MEMBER:'+name);
 const real=fs.realpathSync(file);
 if(path.relative(root,real).startsWith('..'))throw Error('SOURCE_ESCAPE:'+name);
 cmd(root,['ls-files','--error-unmatch','--',name]);
 const dirty=spawnSync('git',['diff','--quiet','HEAD','--',name],{cwd:root,timeout:10000});
 if(dirty.error||dirty.status!==0)throw Error('SOURCE_NOT_COMMITTED_CURRENT:'+name);
 return fs.readFileSync(real);
}
export function createSnapshotCandidate({root,archivePath,outputPath,check=false}){
 const r=fs.realpathSync(root);
 if(!relativeSafe(outputPath)||SOURCE.includes(outputPath))throw Error('SNAPSHOT_OUTPUT_PATH_INVALID');
 const archive=fs.realpathSync(archivePath),archiveStat=fs.statSync(archive);
 if(!archiveStat.isFile()||archiveStat.size===0)throw Error('ACTUAL_ARCHIVE_REQUIRED');
 const obligations=JSON.parse(readOwned(r,'config/closure/media-product-definition/obligations.json'));
 if(!Array.isArray(obligations))throw Error('OBLIGATION_ARRAY_REQUIRED');
 const sourceRefs=obligations.map(o=>o?.extensions?.['media-source']?.sourceRef).filter(x=>typeof x==='string').map(x=>x.split('#')[0]);
 const consumer=JSON.parse(readOwned(r,'config/closure/consumer.json'));
 const consumerRefs=Object.values(consumer.sources||{}).flatMap(x=>Array.isArray(x)?x:[x]).map(x=>{
  if(x?.kind!=='file'||typeof x.ref!=='string')throw Error('UNEXPANDED_CONSUMER_SOURCE_SELECTOR');
  return x.ref;
 });
 const members=[...new Set([...SOURCE,...sourceRefs,...consumerRefs])].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
 if(members.length>8191)throw Error('TRACKED_SNAPSHOT_MEMBER_LIMIT');
 const files=members.map(name=>({path:name,sha256:sha(readOwned(r,name))}));
 const material=crypto.createHash('sha256');
 for(const member of files)material.update(member.path+'\0'+member.sha256+'\n','utf8');
 const snapshot={
   schemaVersion:'ghatana.shared.tools-source-snapshot-membership.v1',
   workspaceRoot:r,
   archiveSha256:sha(fs.readFileSync(archive)),
   sourceMaterialSha256:material.digest('hex'),
   files
 };
 const body=JSON.stringify(snapshot,null,2)+'\n';
 const target=path.join(r,outputPath);
 if(check){
  if(!fs.existsSync(target)||fs.readFileSync(target,'utf8')!==body)throw Error('SNAPSHOT_CANDIDATE_DRIFT');
 }else{
  fs.mkdirSync(path.dirname(target),{recursive:true});
  fs.writeFileSync(target,body,{flag:'wx',mode:0o600});
 }
 return {status:'SOURCE_MEMBERSHIP_CANDIDATE_ONLY',manifestPath:outputPath,manifestFingerprint:'sha256:'+sha(Buffer.from(body)),archiveFingerprint:'sha256:'+snapshot.archiveSha256,materialFingerprint:'sha256:'+snapshot.sourceMaterialSha256,memberCount:files.length,writesPerformed:!check,ap03Authority:'NOT_ISSUED',canonicalAdmission:'NOT_PERFORMED'};
}
if(process.argv[1]&&process.argv[1].endsWith('prepare-media-ap03-snapshot.mjs')){
 const arg=k=>{const i=process.argv.indexOf(k);return i===-1?null:process.argv[i+1]};
 const archivePath=arg('--archive'),outputPath=arg('--output'),root=arg('--root')||process.cwd();
 if(!archivePath||!outputPath)throw Error('Supply actual --archive and repo-relative --output');
 console.log(JSON.stringify(createSnapshotCandidate({root,archivePath,outputPath,check:process.argv.includes('--check')}),null,2));
}
