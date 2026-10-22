#!/usr/bin/env node
/** Fail-closed, read-only source audit; not a Lifecycle authority or receipt. */
import { readFileSync, realpathSync } from 'node:fs';
import { resolve, relative, isAbsolute, sep } from 'node:path';
import crypto from 'node:crypto';
const names=[
 ['PDP-0','media.product-truth.definition-acceptance'],
 ['PDP-1','media.canonical-domain-data.definition-acceptance'],
 ['PDP-2','media.design-interface-system.definition-acceptance'],
 ['PDP-3','media.complete-product-experience.definition-acceptance']
];
const paths={
 topology:'.product-experience/surfaces/media-physical-topology.v1.json',
 consumer:'config/closure/consumer.json',
 surface:'config/closure/media-product-definition/surface.json',
 program:'config/closure/media-product-definition/phase-program.json',
 binding:'config/closure/media-product-definition/phase-binding.json',
 obligations:'config/closure/media-product-definition/obligations.json',
 cases:'config/closure/media-product-definition/l02-source-case-links.json',
 routes:'config/closure/media-product-definition/l03-proof-route-candidates.json',
 pending:'config/closure/media-product-definition/pending-decisions.json'
};
function read(root,path){
 const file=realpathSync(resolve(root,path)),r=relative(root,file);
 if(r==='..'||r.startsWith('..'+sep)||isAbsolute(r))throw Error('SOURCE_PATH_ESCAPE:'+path);
 const bytes=readFileSync(file);
 return {value:JSON.parse(bytes.toString('utf8')),digest:'sha256:'+crypto.createHash('sha256').update(bytes).digest('hex')};
}
const unique=a=>new Set(a).size===a.length;
export function auditMediaClosure(root){
 const canonicalRoot=realpathSync(resolve(root));
 const issues=[],inputs={};const fail=(code,detail={})=>issues.push({code,detail});
 for(const [kind,path]of Object.entries(paths))try{inputs[kind]=read(canonicalRoot,path)}catch(e){fail('SOURCE_UNAVAILABLE',{kind,path,reason:String(e?.message||e)})}
 const t=inputs.topology?.value||{},s=inputs.surface?.value||{},p=inputs.program?.value||{},b=inputs.binding?.value||{},c=inputs.consumer?.value||{},l=inputs.cases?.value||{},r=inputs.routes?.value||{},d=inputs.pending?.value||{};
 const physical=t.manifestCandidates||[],compositions=t.compositions||[],logical=t.consumerCrosswalk||[];
 const identities=[...physical,...compositions,...logical].map(x=>x.surfaceId),ids=new Set(identities);
 if(physical.length!==26||compositions.length!==7||logical.length!==21||identities.length!==54)fail('SOURCE_DENOMINATOR_MISMATCH',{physical:physical.length,compositions:compositions.length,logical:logical.length,total:identities.length});
 if(identities.some(x=>!x)||!unique(identities))fail('SOURCE_IDENTITY_DUPLICATE_OR_MISSING');
 const adj=new Map();
 for(const item of compositions){
   const children=item.children||[];
   if(!Array.isArray(children)||!unique(children))fail('COMPOSITION_MEMBERSHIP_INVALID',{surfaceId:item.surfaceId});
   adj.set(item.surfaceId,children);
   for(const child of children)if(!ids.has(child))fail('COMPOSITION_CHILD_MISSING',{surfaceId:item.surfaceId,child});
 }
 const seen=new Set(),active=new Set();
 function walk(id){if(active.has(id)){fail('COMPOSITION_CYCLE',{surfaceId:id});return;}if(seen.has(id))return;active.add(id);for(const child of adj.get(id)||[])if(adj.has(child))walk(child);active.delete(id);seen.add(id)}
 for(const item of compositions)walk(item.surfaceId);
 for(const item of logical)for(const physicalRef of item.physicalRefs||[])if(!ids.has(physicalRef))fail('CONSUMER_PHYSICAL_REF_MISSING',{surfaceId:item.surfaceId,physicalRef});
 if(!Array.isArray(p.phases)||p.phases.length!==4)fail('PHASE_COUNT_INVALID');
 const phaseMap=new Map((p.phases||[]).map(x=>[x.id,x])),all=[];
 for(const [sourcePhase,phaseId]of names){
  const def=phaseMap.get(phaseId),bound=b.phases?.[phaseId];
  if(!def||!bound){fail('PHASE_OR_BINDING_MISSING',{sourcePhase,phaseId});continue}
  const a=def.obligationIds||[],z=bound.obligationIds||[];
  if(!unique(a)||!unique(z)||a.length!==z.length||a.some(x=>!z.includes(x)))fail('PHASE_OBLIGATION_DRIFT',{phaseId,definition:a.length,binding:z.length});
  all.push(...a);
 }
 const persisted=inputs.obligations?.value;
 if(!Array.isArray(persisted))fail('OBLIGATION_RECORD_ARRAY_REQUIRED');
 const persistedRows=Array.isArray(persisted)?persisted:[];
 const persistedById=new Map(),persistedDuplicates=[],unexpectedObligationIds=[],invalidSourceRows=[],invalidPhaseRows=[];
 const obligationPhaseById=new Map((p.phases||[]).flatMap(x=>(x.obligationIds||[]).map(id=>[id,x.id])));
 for(const row of persistedRows){
  if(!row||typeof row.id!=='string'||!row.id){invalidSourceRows.push(String(row?.id??'unknown'));continue;}
  if(persistedById.has(row.id))persistedDuplicates.push(row.id);
  persistedById.set(row.id,row);
  const expectedPhase=obligationPhaseById.get(row.id);
  if(!expectedPhase){unexpectedObligationIds.push(row.id);continue;}
  if(row.closureSurfaceId!==s.id||row.programId!==p.programId
   ||!Array.isArray(row.phaseSemantics?.applicableIn)
   ||row.phaseSemantics.applicableIn.length!==1
   ||row.phaseSemantics.applicableIn[0]!==expectedPhase)invalidPhaseRows.push(row.id);
  const source=row.extensions?.['media-source'];
  if(typeof source?.recordId!=='string'||!source.recordId
    ||typeof source?.sourceRef!=='string'||!source.sourceRef.includes('#')
    ||!/^sha256:[a-f0-9]{64}$/.test(String(source?.sourceDigest??'')))invalidSourceRows.push(row.id);
 }
 const missingPersisted=all.filter(id=>!persistedById.has(id));
 if(persistedRows.length!==all.length||persistedDuplicates.length||unexpectedObligationIds.length||missingPersisted.length){
  fail('OBLIGATION_REGISTRY_IDENTITY_DRIFT',{records:persistedRows.length,phaseRecords:all.length,duplicateCount:persistedDuplicates.length,unexpectedCount:unexpectedObligationIds.length,missingCount:missingPersisted.length,examples:[...persistedDuplicates,...unexpectedObligationIds,...missingPersisted].slice(0,8)});
 }
 if(invalidPhaseRows.length)fail('OBLIGATION_RECORD_PHASE_OWNER_MISMATCH',{count:invalidPhaseRows.length,examples:invalidPhaseRows.slice(0,8)});
 if(invalidSourceRows.length)fail('OBLIGATION_SOURCE_IDENTITY_INVALID',{count:invalidSourceRows.length,examples:invalidSourceRows.slice(0,8)});
 const surfaceObligations=s.obligationIds||[];
 if(!unique(all)||!unique(surfaceObligations)||all.length!==surfaceObligations.length||all.some(x=>!surfaceObligations.includes(x)))fail('AGGREGATE_OBLIGATION_DRIFT',{phaseTotal:all.length,aggregate:surfaceObligations.length});
 if(s.id!=='media.product-definition'||b.closureSurfaceId!==s.id)fail('CLOSURE_ROOT_ID_MISMATCH');
 if(c.consumerId!=='ghatana-media.product-definition')fail('CONSUMER_ID_MISMATCH');
 if((c.providerBindings||[]).length)fail('CONSUMER_PROOF_PRODUCER_BINDING_UNSUPPORTED');
 const routes=Array.isArray(r.routes)?r.routes:[],receipts=Array.isArray(d.receipts)?d.receipts:[];
 const unmapped=r.l02CaseLinkReview?.unmappedObligationCount??null;
 const caseLinks=Array.isArray(l.links)?l.links:Array.isArray(l.caseLinks)?l.caseLinks:[];
 const candidateLinkCount=Number.isSafeInteger(r.l02CaseLinkReview?.reviewedLinkCount)?r.l02CaseLinkReview.reviewedLinkCount:caseLinks.length;
 const blockers=['AP02_AP03_OWNER_ADMISSION_UNVERIFIED'];
 if(!(s.composition?.childSurfaceIds||[]).length)blockers.push('LEAF_CLOSURE_BOUNDARIES_NOT_ADMITTED');
 if(unmapped===null||unmapped>0||candidateLinkCount===0)blockers.push('SOURCE_CASE_COVERAGE_NOT_ADMITTED');
 if(routes.length===0||!routes.some(x=>x.independentReview==='PASS'&&x.candidateObserver?.admission==='ADMITTED'&&x.candidateOracle?.admission==='ADMITTED'))blockers.push('PROOF_ORACLE_NOT_ADMITTED');
 if(receipts.length===0)blockers.push('NATIVE_RECEIPT_MISSING');
 return {schemaVersion:'media.gtool-closure-readiness-audit.v1',recordKind:'READ_ONLY_NOT_ADMISSION',sourcePopulation:{physical:physical.length,compositions:compositions.length,logical:logical.length,total:identities.length},persistedObligationCount:persistedRows.length,obligationCounts:names.map(([phase,id])=>({phase,phaseId:id,count:phaseMap.get(id)?.obligationIds?.length??0})),sourceFingerprints:Object.fromEntries(Object.entries(inputs).map(([k,v])=>[paths[k],v.digest])),candidate:{surfaceId:s.id,childSurfaceCount:s.composition?.childSurfaceIds?.length??null,unmappedObligations:unmapped,caseLinks:candidateLinkCount,routeCandidates:routes.length,receiptCount:receipts.length},invariants:{passed:issues.length===0,issues},nativeClosure:{status:'NOT_PROVEN',blockers},writesPerformed:false};
}
if(process.argv[1]&&process.argv[1].endsWith('audit-media-closure-readiness.mjs')){
 const ix=process.argv.indexOf('--root'),root=ix===-1?process.cwd():process.argv[ix+1];
 if(!root||root.startsWith('--'))throw Error('Missing --root value');
 const result=auditMediaClosure(realpathSync(root));
 console.log(JSON.stringify(result,null,2));
 process.exit(result.invariants.passed?0:1);
}
