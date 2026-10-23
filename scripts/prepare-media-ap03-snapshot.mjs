#!/usr/bin/env node
/**
 * Produce a real, reproducible AP-03 source membership candidate from tracked Media files.
 * Does not issue AP-03, register a verifier or assert Lifecycle admission.
 * Usage: node scripts/prepare-media-ap03-snapshot.mjs --create-archive --archive <new-outside-repo.tar> --output <relative-in-repo.json> [--check]
 * --create-archive packages exactly the selected committed source members using git archive; no shell.
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
function collectSourcePaths(value, paths=[]){
 if(Array.isArray(value)){for(const item of value)collectSourcePaths(item,paths);return paths;}
 if(!value||typeof value!=='object')return paths;
 for(const [key,item] of Object.entries(value)){
  if(['sourcePath','sourceRef','sourcePopulationRef'].includes(key)&&typeof item==='string')paths.push(item.split('#')[0]);
  else collectSourcePaths(item,paths);
 }
 return paths;
}
const ARCHIVE_VALIDATOR=String.raw`import hashlib,json,sys,tarfile
archive_path=sys.argv[1]
request=json.load(sys.stdin)
expected=request['files']
expected_directories=set(request['directories'])
max_entries=request['maxEntries']
seen=set()
regular=set()
try:
    with tarfile.open(archive_path, mode='r:') as archive:
        for count,entry in enumerate(archive, start=1):
            if count>max_entries:
                raise SystemExit('ARCHIVE_MEMBER_COUNT_LIMIT')
            name=entry.name
            if entry.type == tarfile.DIRTYPE and name.endswith('/'):
                name=name[:-1]
            if not name or name.startswith('/') or '\\' in name or any(part in ('', '.', '..') for part in name.split('/')):
                raise SystemExit('ARCHIVE_UNSAFE_MEMBER_PATH:'+entry.name)
            if name in seen:
                raise SystemExit('ARCHIVE_DUPLICATE_MEMBER:'+name)
            seen.add(name)
            if entry.type == tarfile.DIRTYPE:
                if name not in expected_directories:
                    raise SystemExit('ARCHIVE_UNEXPECTED_DIRECTORY:'+name)
                if entry.size != 0:
                    raise SystemExit('ARCHIVE_DIRECTORY_SIZE_MISMATCH:'+name)
                continue
            if entry.type not in (tarfile.REGTYPE, tarfile.AREGTYPE):
                raise SystemExit('ARCHIVE_UNSAFE_MEMBER_TYPE:'+name)
            if name not in expected:
                raise SystemExit('ARCHIVE_UNEXPECTED_MEMBER:'+name)
            regular.add(name)
            if entry.size != expected[name]['size']:
                raise SystemExit('ARCHIVE_MEMBER_SIZE_MISMATCH:'+name)
            stream=archive.extractfile(entry)
            if stream is None:
                raise SystemExit('ARCHIVE_MEMBER_CONTENT_UNREADABLE:'+name)
            digest=hashlib.sha256()
            for chunk in iter(lambda: stream.read(1024*1024), b''):
                digest.update(chunk)
            if digest.hexdigest()!=expected[name]['sha256']:
                raise SystemExit('ARCHIVE_MEMBER_CONTENT_MISMATCH:'+name)
except tarfile.ReadError as error:
    raise SystemExit('ARCHIVE_PLAIN_TAR_REQUIRED:'+str(error))
if regular != set(expected):
    missing=sorted(set(expected)-regular)
    raise SystemExit('ARCHIVE_MEMBER_SET_MISMATCH:'+','.join(missing[:10]))
`;
function validateArchive(archivePath,files){
 const expected=Object.fromEntries(files.map(f=>[f.path,{sha256:f.sha256,size:f.size}]));
 const directories=new Set();
 for(const file of files){const parts=file.path.split('/');parts.pop();while(parts.length){directories.add(parts.join('/'));parts.pop()}}
 const maxEntries=files.length+directories.size;
 const expectedBytes=files.reduce((sum,file)=>sum+file.size,0);
 const pathBytes=files.reduce((sum,file)=>sum+Buffer.byteLength(file.path),0)+[...directories].reduce((sum,name)=>sum+Buffer.byteLength(name),0);
 const maxArchiveBytes=expectedBytes+maxEntries*4096+pathBytes*2+1024;
 if(!Number.isSafeInteger(maxArchiveBytes)||fs.statSync(archivePath).size>maxArchiveBytes)throw Error('ARCHIVE_SIZE_LIMIT_EXCEEDED');
 const result=spawnSync('python3',['-c',ARCHIVE_VALIDATOR,archivePath],{input:JSON.stringify({files:expected,directories:[...directories],maxEntries}),encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
 if(result.error?.code==='ENOENT')throw Error('PYTHON3_REQUIRED_FOR_ARCHIVE_VALIDATION: install Python 3 and ensure python3 is on PATH');
 if(result.error||result.status!==0)throw Error(String(result.stderr||result.stdout||result.error||'ARCHIVE_VALIDATION_FAILED').trim());
}
export function createSnapshotCandidate({root,archivePath,outputPath,check=false,createArchive=false}){
 const r=fs.realpathSync(root);
 if(!relativeSafe(outputPath)||SOURCE.includes(outputPath))throw Error('SNAPSHOT_OUTPUT_PATH_INVALID');
 if(createArchive&&check)throw Error('ARCHIVE_CREATE_AND_CHECK_INCOMPATIBLE');
 const obligations=JSON.parse(readOwned(r,'config/closure/media-product-definition/obligations.json'));
 if(!Array.isArray(obligations))throw Error('OBLIGATION_ARRAY_REQUIRED');
 const sourceRefs=obligations.map(o=>o?.extensions?.['media-source']?.sourceRef).filter(x=>typeof x==='string').map(x=>x.split('#')[0]);
 const caseLinks=JSON.parse(readOwned(r,'config/closure/media-product-definition/l02-source-case-links.json'));
 const proofRoutes=JSON.parse(readOwned(r,'config/closure/media-product-definition/l03-proof-route-candidates.json'));
 const proofRefs=[...collectSourcePaths(caseLinks),...collectSourcePaths(proofRoutes)];
 const consumer=JSON.parse(readOwned(r,'config/closure/consumer.json'));
 const consumerRefs=Object.values(consumer.sources||{}).flatMap(x=>Array.isArray(x)?x:[x]).map(x=>{
  if(x?.kind!=='file'||typeof x.ref!=='string')throw Error('UNEXPANDED_CONSUMER_SOURCE_SELECTOR');
  return x.ref;
 });
 const members=[...new Set([...SOURCE,...sourceRefs,...proofRefs,...consumerRefs])].sort((a,b)=>Buffer.compare(Buffer.from(a),Buffer.from(b)));
 if(members.length>8191)throw Error('TRACKED_SNAPSHOT_MEMBER_LIMIT');
 const files=members.map(name=>{const bytes=readOwned(r,name);return {path:name,sha256:sha(bytes),size:bytes.length}});
 const headBefore=cmd(r,['rev-parse','HEAD']);
 if(createArchive){
  const absoluteArchive=path.resolve(archivePath),relation=path.relative(r,absoluteArchive);
  if(relation===''||(!relation.startsWith('..'+path.sep)&&relation!=='..'&&!path.isAbsolute(relation)))throw Error('ARCHIVE_OUTPUT_MUST_BE_OUTSIDE_REPOSITORY');
  if(fs.existsSync(absoluteArchive))throw Error('ARCHIVE_ALREADY_EXISTS');
  fs.mkdirSync(path.dirname(absoluteArchive),{recursive:true});
  const result=spawnSync('git',['archive','--format=tar','--output='+absoluteArchive,'HEAD','--',...members],{cwd:r,encoding:'utf8',timeout:120000,maxBuffer:1024*1024});
  if(result.error||result.status!==0)throw Error('EXACT_SOURCE_ARCHIVE_FAILED:'+String(result.stderr||result.error||result.status));
 }
 const archive=fs.realpathSync(archivePath),archiveStat=fs.statSync(archive);
 if(!archiveStat.isFile()||archiveStat.size===0)throw Error('ACTUAL_ARCHIVE_REQUIRED');
 if(cmd(r,['rev-parse','HEAD'])!==headBefore)throw Error('SOURCE_HEAD_CHANGED_DURING_ARCHIVE');
 for(const member of files)if(sha(readOwned(r,member.path))!==member.sha256)throw Error('SOURCE_MEMBER_CHANGED_DURING_ARCHIVE:'+member.path);
 validateArchive(archive,files);
 const material=crypto.createHash('sha256');
 for(const member of files)material.update(member.path+'\0'+member.sha256+'\n','utf8');
 const snapshot={
   schemaVersion:'ghatana.shared.tools-source-snapshot-membership.v1',
   workspaceRoot:r,
   archiveSha256:sha(fs.readFileSync(archive)),
   sourceMaterialSha256:material.digest('hex'),
   files:files.map(({path,sha256})=>({path,sha256}))
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
 console.log(JSON.stringify(createSnapshotCandidate({root,archivePath,outputPath,check:process.argv.includes('--check'),createArchive:process.argv.includes('--create-archive')}),null,2));
}
