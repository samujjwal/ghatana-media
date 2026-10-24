#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {buildAudSpec002SourceAmendmentV7} from './lib/media-pdp0-aud-spec-002-source-amendment-v7.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder='docs/implementation/observations/pdp0-semantic-audit-slices';
const sha=b=>createHash('sha256').update(b).digest('hex');
const read=ref=>fs.readFileSync(path.join(root,ref));
const immutable=(ref,content)=>{const full=path.join(root,ref);fs.mkdirSync(path.dirname(full),{recursive:true});if(fs.existsSync(full)){if(!fs.readFileSync(full).equals(content))throw new Error(`refusing to overwrite frozen v7 artifact: ${ref}`);return;}const fd=fs.openSync(full,'wx',0o600);try{fs.writeFileSync(fd,content);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}};
const v6Refs={candidate:`${folder}/AUD-SPEC-002-source-amendment-candidate.v6.json`,candidateSchema:`${folder}/AUD-SPEC-002-source-amendment-candidate.v6.schema.json`,source:`${folder}/AUD-SPEC-002-source-amendment-postimage.v6.json`,sourceSchema:`${folder}/AUD-SPEC-002-source-amendment-postimage.v6.schema.json`,manifest:`${folder}/AUD-SPEC-002-source-amendment-v6-freeze-manifest.v1.json`};

export function prepareAudSpec002V7(){
 const built=buildAudSpec002SourceAmendmentV7({v6CandidateBytes:read(v6Refs.candidate),v6CandidateSchemaBytes:read(v6Refs.candidateSchema),v6SourceAmendmentBytes:read(v6Refs.source),v6SourceAmendmentSchemaBytes:read(v6Refs.sourceSchema),v6ManifestBytes:read(v6Refs.manifest)});
 const candidateSchemaBytes=Buffer.from(`${JSON.stringify(built.candidateSchema,null,2)}\n`);const sourceSchemaBytes=Buffer.from(`${JSON.stringify(built.sourceAmendmentSchema,null,2)}\n`);
 const producerRefs=['scripts/lib/media-pdp0-aud-spec-002-source-amendment-v7.mjs','scripts/plan-media-pdp0-aud-spec-002-source-amendment-v7.mjs','tests/media-pdp0-aud-spec-002-source-amendment-v7.test.mjs','scripts/lib/media-pdp0-aud-spec-002-source-amendment-v6.mjs','scripts/plan-media-pdp0-aud-spec-002-source-amendment-v6.mjs','tests/media-pdp0-aud-spec-002-source-amendment-v6.test.mjs'];
 const producerPins=Object.fromEntries(producerRefs.map(ref=>[ref,sha(read(ref))]));
 const outputs=new Map([[`${folder}/AUD-SPEC-002-source-amendment-candidate.v7.schema.json`,candidateSchemaBytes],[`${folder}/AUD-SPEC-002-source-amendment-postimage.v7.schema.json`,sourceSchemaBytes],[`${folder}/AUD-SPEC-002-source-amendment-candidate.v7.json`,built.candidateBytes],[`${folder}/AUD-SPEC-002-source-amendment-postimage.v7.json`,built.sourceAmendmentBytes]]);
 const Ajv2020=createRequire(path.resolve(root,'../ghatana-tools/package.json'))('ajv/dist/2020');const ajv=new Ajv2020({strict:true});
 if(!ajv.compile(built.candidateSchema)(built.candidate))throw new Error('v7 candidate fails v7 candidate schema');
 if(!ajv.compile(built.sourceAmendmentSchema)(built.sourceAmendment))throw new Error('v7 amendment fails v7 amendment schema');
 const priorManifest=JSON.parse(read(v6Refs.manifest).toString('utf8'));
 const reconciliation={schemaVersion:'media.pdp0.aud-spec-002-source-amendment-metadata-reconciliation.v1',artifactKind:'EXACT_BLOCKER_REFERENCE_CORRECTION',status:'NON_SEMANTIC_METADATA_SUCCESSOR',predecessorCandidateRef:v6Refs.candidate,predecessorCandidateSha256:sha(read(v6Refs.candidate)),currentCandidateRef:`${folder}/AUD-SPEC-002-source-amendment-candidate.v7.json`,
  finding:{field:'blockers[0]',predecessorValue:'DISTINCT_TECHNICAL_PEER_REVIEW_OF_THE_EXACT_V5_SIX_SOURCE_POSTIMAGE_REQUIRED',correctedValue:'DISTINCT_TECHNICAL_PEER_REVIEW_OF_THE_EXACT_V7_SIX_SOURCE_POSTIMAGE_REQUIRED',reason:'Peer review must bind the exact current six-source postimage version.'},
  sixTargetPostimagesUnchanged:built.candidate.exactFileTargets.every((row,i)=>row.postimageSha256===JSON.parse(read(v6Refs.candidate).toString('utf8')).exactFileTargets[i].postimageSha256),
  previousFrozenV5TestBytes:'UNAVAILABLE_AS_PREIMAGE; current validation is pinned separately; no test-byte equivalence claimed',sourceOwnerChoice:'NO_CHANGE',canonicalApply:'NOT_PERFORMED',sourceCurrentness:'NOT_CLAIMED',phaseStatus:'UNCHANGED'};
 const reconciliationBytes=Buffer.from(`${JSON.stringify(reconciliation,null,2)}\n`);
 const priorV6TargetArtifacts=Object.entries(priorManifest.exactArtifactPins).filter(([ref])=>/-(?:capabilities-file|requirements-file|crosswalk|capability-leaf-review|campaign-extensions|decision-log)-postimage\.v6\./u.test(ref));
 const manifest={schemaVersion:'media.pdp0.aud-spec-002-source-amendment-v7-freeze-manifest.v1',status:'CANDIDATE_ONLY_PENDING_DISTINCT_TECHNICAL_PEER_AND_ROOT_SOURCE_OWNER_REVIEW',predecessorV6:{candidateRef:v6Refs.candidate,candidateSha256:sha(read(v6Refs.candidate)),manifestRef:v6Refs.manifest,manifestSha256:sha(read(v6Refs.manifest))},candidateSha256:sha(built.candidateBytes),candidatePostimageSha256:built.candidate.candidatePostimageSha256,candidateSchemaSha256:sha(candidateSchemaBytes),sourceAmendmentSha256:sha(built.sourceAmendmentBytes),sourceAmendmentSchemaSha256:sha(sourceSchemaBytes),targetPostimages:built.targetRows,postimageArtifactRefs:priorV6TargetArtifacts.map(([ref,hash])=>({ref,sha256:hash})),reconciliationRef:`${folder}/AUD-SPEC-002-source-amendment-v7-metadata-reconciliation.v1.json`,reconciliationSha256:sha(reconciliationBytes),producerPins,canonicalApply:'NOT_PERFORMED',boundary:{qualityApplicability:'UNKNOWN_PENDING_SEPARATE_SOURCE_BOUND_REVIEW',pdp1Handoff:'HISTORICAL_462_ONLY',phaseStatus:'UNCHANGED',independentAcceptance:'NOT_CLAIMED',nativeProof:'NOT_CLAIMED',runtimeAdmission:'NOT_ADMITTED'}};
 const manifestBytes=Buffer.from(`${JSON.stringify(manifest,null,2)}\n`);
 outputs.set(`${folder}/AUD-SPEC-002-source-amendment-v7-metadata-reconciliation.v1.json`,reconciliationBytes);
 return{outputs,manifest,manifestBytes};
}
export function writeAudSpec002V7({check=false}={}){const out=prepareAudSpec002V7();const all=new Map([...out.outputs,[`${folder}/AUD-SPEC-002-source-amendment-v7-freeze-manifest.v1.json`,out.manifestBytes]]);if(check){for(const[ref,content]of all)if(!fs.existsSync(path.join(root,ref))||!read(ref).equals(content))throw new Error(`frozen v7 artifact differs from current inputs: ${ref}`);}else for(const[ref,content]of all)immutable(ref,content);return out.manifest;}
if(process.argv[1]&&pathToFileURL(path.resolve(process.argv[1])).href===import.meta.url){try{process.stdout.write(`${JSON.stringify(writeAudSpec002V7({check:process.argv.includes('--check')}),null,2)}\n`);}catch(error){console.error(error.message);process.exitCode=1;}}
