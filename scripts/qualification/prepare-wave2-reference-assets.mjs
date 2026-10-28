#!/usr/bin/env node
/** Explicit, bounded, SHA-pinned model asset staging; NEVER a legal/runtime admission. */
import { createHash, randomBytes } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import { open, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, '../..');
const catalogPath = join(repoRoot,'config/qualification/wave2-reference-candidates.v1.json');
const shaPattern = /^[0-9a-f]{64}$/u;
const acceptedHosts = ['openaipublic.azureedge.net','huggingface.co','raw.githubusercontent.com'];
const allowedFinalHosts = ['openaipublic.azureedge.net','huggingface.co','raw.githubusercontent.com',
    'cdn-lfs.huggingface.co','cdn-lfs-us-1.hf.co','cas-bridge.xethub.hf.co'];
const allowedHuggingFaceStorageHost = host => host.endsWith('.aws.cdn.hf.co') && host.length < 100;
function error(code) {const e=new Error(code);e.code=code;return e;}
const isInRepo = target => {const r=relative(repoRoot,target);return r==='' || (!r.startsWith('..'+sep)&&r!=='..'&&!isAbsolute(r));};
function checkDestination(destination) {
  if (!isAbsolute(destination)) throw error('ABSOLUTE_PRIVATE_ASSET_ROOT_REQUIRED');
  const abs=resolve(destination);
  if (isInRepo(abs)) throw error('REFUSE_TO_STAGE_MODEL_INSIDE_SOURCE_REPOSITORY');
  mkdirSync(abs,{recursive:true,mode:0o700});
  if(lstatSync(abs).isSymbolicLink() || !lstatSync(abs).isDirectory())throw error('UNSAFE_ASSET_ROOT');
  return abs;
}
export async function stagePinnedCandidate({id, destination, fetcher=fetch, catalog=null}) {
  const source=catalog || JSON.parse(readFileSync(catalogPath,'utf8'));
  if(source.schemaVersion!=='ghatana.media.wave2.reference-candidates.v1'
      || source.operationalPolicy?.noCandidateIsAdmitted!==true) throw error('INVALID_SOURCE_CATALOG');
  const candidate=source.candidates?.find(v=>v.id===id);
  if(!candidate || !/^[a-z0-9-]{1,100}$/u.test(id) || candidate.status!=='REVIEW_ONLY'
      || candidate.proposedUse!=='LOCAL_EVALUATION'
      || !shaPattern.test(candidate.artifactSha256||'')
      || !Number.isSafeInteger(candidate.maxBytes)
      || candidate.maxBytes<=0 || candidate.maxBytes>230000000) throw error('NO_SOURCE_PINNED_EVALUATION_CANDIDATE');
  const url=new URL(candidate.upstreamUrl);
  if(url.protocol!=='https:' || !acceptedHosts.includes(url.hostname) || url.username || url.password)
    throw error('UNTRUSTED_MODEL_SOURCE_HOST');
  const root=checkDestination(destination);
  const folder=join(root,id);
  if(existsSync(folder))throw error('REFUSE_TO_OVERWRITE_STAGED_ASSET');
  mkdirSync(folder,{mode:0o700});
  const temp=join(folder,'.download-'+randomBytes(8).toString('hex'));
  let completed=false;let handle;
  try {
    const response=await fetcher(url.toString(),{redirect:'follow',signal:AbortSignal.timeout(180000)});
    if(!response?.ok || !response.body)throw error('MODEL_DOWNLOAD_UNAVAILABLE');
    const finalUrl=new URL(response.url||url.toString());
    const host=finalUrl.hostname;
    if(finalUrl.protocol!=='https:' || (!allowedFinalHosts.includes(host) && !allowedHuggingFaceStorageHost(host)
      && !(host.endsWith('.xethub.hf.co') && host.length<100)))throw error('MODEL_REDIRECT_NOT_ALLOWLISTED');
    const lenHeader=response.headers?.get('content-length');
    const contentEncoding=response.headers?.get('content-encoding');
    if(lenHeader && (!/^\d+$/u.test(lenHeader) || Number(lenHeader)>candidate.maxBytes))
      throw error('MODEL_DOWNLOAD_OVERSIZE');
    handle=await open(temp,'wx',0o600);
    const hash=createHash('sha256');let size=0;
    for await(const raw of response.body){
      const buf=Buffer.from(raw);size+=buf.length;
      if(size>candidate.maxBytes)throw error('MODEL_DOWNLOAD_OVERSIZE');
      hash.update(buf);
      let position=0;while(position<buf.length){let r=await handle.write(buf,position,buf.length-position);if(!r.bytesWritten)throw error('MODEL_WRITE_INCOMPLETE');position+=r.bytesWritten;}
    }
    const digest=hash.digest('hex');
    if(size===0 || digest!==candidate.artifactSha256)throw error('MODEL_SOURCE_DIGEST_MISMATCH');
    // Fetch implementations may transparently decompress a gzip/br response body while
    // retaining the wire Content-Length header. The pinned digest and streamed byte cap
    // validate the decoded artifact; compare lengths only for identity-encoded bodies.
    if(lenHeader && !contentEncoding && size!==Number(lenHeader))throw error('MODEL_TRUNCATED_TRANSFER');
    await handle.sync();await handle.close();handle=null;
    const extension=extname(url.pathname) || '.bin';
    const finalName='verified-source'+extension;
    await rename(temp,join(folder,finalName));
    const record={schemaVersion:'ghatana.media.wave2.reference-asset-staging.v1',
      candidateId:id,sourceUrl:url.toString(),sha256:digest,sizeBytes:size,
      sourceClass:candidate.kind,sourceType:candidate.sourceType||candidate.expectedRuntimeInputs,
      status:'BYTE_INTEGRITY_VERIFIED_ONLY_RIGHTS_NOT_ADMITTED',
      restrictions:'DO_NOT_USE_AS_PRODUCTION_PROVIDER_OR_LEGAL_CONSENT_PROOF'};
    await writeFile(join(folder,'SOURCE-RECEIPT.json'),JSON.stringify(record,null,2)+'\n',{flag:'wx',mode:0o600});
    completed=true;
    return {...record,folder};
  } finally {
    if(handle)await handle.close();
    if(!completed)await rm(folder,{recursive:true,force:true});
  }
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
  const args=process.argv.slice(2);
  const idx=args.indexOf('--candidate'),to=args.indexOf('--private-destination');
  if(idx<0||to<0||!args[idx+1]||!args[to+1]||!args.includes('--acknowledge-review-only')){
    console.error('Usage: node scripts/qualification/prepare-wave2-reference-assets.mjs --candidate ID --private-destination ABSOLUTE_PRIVATE_DIR --acknowledge-review-only');
    process.exitCode=2;
  }else{
    stagePinnedCandidate({id:args[idx+1],destination:args[to+1]}).then(x=>{
      console.log(JSON.stringify({candidateId:x.candidateId,sha256:x.sha256,sizeBytes:x.sizeBytes,
        status:x.status,location:x.folder},null,2));
    }).catch(e=>{console.error(JSON.stringify({status:'BLOCKED',reason:e.code||'SOURCE_FETCH_ERROR'}));process.exitCode=1});
  }
}
