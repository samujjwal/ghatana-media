// Source-only PDP-3 Recorder/Studio consistency checker. Not a phase/Build gate.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const defaultRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const paths = {
  "p0": ".product-experience/pdp-0-product-truth/recorder-studio-extension.yaml",
  "req": ".product-experience/pdp-0-product-truth/requirements.yaml",
  "p1": ".product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml",
  "p2": ".product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml",
  "p3": ".product-experience/pdp-3-product-experience/recorder-studio-experience.yaml",
  "journeys": ".product-experience/pdp-3-product-experience/journey-registry.yaml",
  "screens": ".product-experience/pdp-3-product-experience/screen-registry.yaml"
};
const uniqueSet = xs => new Set(xs).size === xs.length;
const sameIds = (a,b) => Array.isArray(a) && Array.isArray(b) && a.length===b.length && uniqueSet(a) && uniqueSet(b) && a.every(x=>b.includes(x));
const lowerGroup = id => typeof id==='string' ? id.match(/profile\.([a-z0-9]+)\.v1$/u)?.[1]?.toUpperCase() : undefined;
export function verifyRecorderStudioExperience({ root=defaultRoot, overrides={} }={}) {
  const errors=[]; const fail = s=>errors.push(s);
  const sources={};
  for (const [k,filename] of Object.entries(paths)) {
    try {
      const raw=Object.hasOwn(overrides,k) ? overrides[k] : fs.readFileSync(path.join(root,filename),'utf8');
      const parsed=parseDocument(raw,{uniqueKeys:true,strict:true});
      if(parsed.errors.length) {
        for(const error of parsed.errors)fail(k+': invalid or duplicate YAML: '+error.message);
      } else sources[k]=parsed.toJS();
    } catch(error) {fail(k+': unreadable source: '+error.message);}
  }
  if(errors.length)return { errors, stats:{sourceDocumentsValid:false} };
  const {p0,p1,p2,p3,req,journeys,screens}=sources;
  if(!p0 || !p1 || !p2 || !p3 || !req || !journeys || !screens) {
    return {errors:['Missing source document contents'],stats:{sourceDocumentsValid:false}};
  }
  const expectedSurfaces=p0.surfaces??[];
  const surfaceDefs=p3.surfaceExperiences??[];
  if(!sameIds(surfaceDefs.map(x=>x.surfaceId),expectedSurfaces.map(x=>x.id)))
    fail('PDP3 logical surface identities differ from PDP0');
  for(const source of expectedSurfaces) {
    const p=surfaceDefs.find(x=>x.surfaceId===source.id);
    const interfaceDef=(p2.surfaceInterfaces??[]).find(x=>x.surfaceId===source.id);
    if(!p || p.parentSurfaceId!==source.parent || p.channel!==source.channel ||
       p.pdp2Kind!==interfaceDef?.kind || p.hostAdapterStatus!=='CONTRACT_ONLY_NOT_ADMITTED')
      fail(source.id+': parent/channel/interface/runtime-admission mismatch');
  }
  const cases=req.recorderStudioProfile?.acceptanceClauses??[];
  const canonical=new Map(cases.map(x=>[x.id,x]));
  const features=p0.featureProfiles??[];
  const flows=p3.flowContracts??[];
  const groupP1=p1.pdp0CaseOperationCrosswalk?.groups??[];
  const groupP2=p2.pdp0AcceptanceCaseProjection?.groups??[];
  const operations=new Set((p1.canonicalOperationProposals?.records??[]).map(x=>x.id));
  if(!sameIds(flows.map(x=>x.sourceProfileRef),features.map(x=>x.id)))
    fail('PDP3 flows must exactly cover the sixteen canonical PDP0 feature profiles');
  if(flows.length!==16||cases.length!==84||features.length!==16)
    fail('Recorder Studio scoped source denominators drifted');
  const allSteps=[];
  const allowedJourneyIds=new Set((journeys.journeys??[]).map(x=>x.id));
  const canonicalScreenIds=(screens.screens??[]).map(x=>x.id);
  if(allowedJourneyIds.size!==30 || (journeys.journeys??[]).length!==30 ||
     !uniqueSet(canonicalScreenIds) || canonicalScreenIds.length!==47)
    fail('historical PDP3 journey/screen inventory has drifted from the proposed successor reference');
  for(const flow of flows) {
    const profile=features.find(x=>x.id===flow.sourceProfileRef);
    if(!profile)continue;
    const groupId=lowerGroup(profile.id);
    const g1=groupP1.find(x=>x.groupId===groupId);
    const g2=groupP2.find(x=>x.id==='media.recorder.p2.group.'+String(groupId??'').toLowerCase()+'.v1');
    const steps=flow.stepContracts??[];
    if(!groupId || flow.sourceFeatureGroup!==groupId || flow.surfaceId!==profile.ownerSurface || 
      !g1 || !g2 || flow.pdp2InterfaceGroupRef!==g2.id || g2.surfaceId!==flow.surfaceId)
      fail(flow.id+': feature/owner/PDP1/PDP2 group mismatch');
    if(!sameIds(steps.map(x=>x.acceptanceCaseRef),profile.acceptanceCaseRefs??[]))
      fail(flow.id+': case-step coverage mismatch');
    if(!Array.isArray(flow.reuseExistingJourneyRefs) || flow.reuseExistingJourneyRefs.length===0 ||
       !flow.reuseExistingJourneyRefs.every(x=>allowedJourneyIds.has(x)))
      fail(flow.id+': missing or invented existing PDP3 journey reference');
    if(flow.operationSelectionStatus!=='GROUP_CANDIDATES_ONLY_NOT_STEP_DISPATCH_ADMITTED')
      fail(flow.id+': step operation admission not proven');
    for(const [index,step] of steps.entries()) {
      allSteps.push(step);
      const source=canonical.get(step.acceptanceCaseRef);
      if(!source || source.surfaceId!==flow.surfaceId || source.group!==groupId || step.order!==index+1)
        fail(step.id+': case step does not match canonical source order/ownership');
      if(step.sourceWhen!==source?.when)
        fail(step.id+': source presentation text drifted from canonical PDP0 when');
      if(step.positiveOracle!==paths.req+'#recorderStudioProfile/acceptanceClauses/'+step.acceptanceCaseRef+'/then' ||
         step.negativeOracle!==paths.req+'#recorderStudioProfile/acceptanceClauses/'+step.acceptanceCaseRef+'/rejection')
        fail(step.id+': oracle reference must bind exact source acceptance clause');
      if(!sameIds(step.operationCandidateRefs,g1?.proposedPdp1OperationRefs??[]) ||
         !sameIds(step.operationCandidateRefs,g2?.pdp1OperationRefs??[]) ||
         !step.operationCandidateRefs.every(x=>operations.has(x)))
        fail(step.id+': proposed operation candidates drifted from PDP1 and PDP2');
      if(step.interfaceGroupRef!==g2?.id || step.dispatchStatus!=='NOT_ADMITTED_REQUIRES_EXACT_STEP_OPERATION_AND_HOST_BINDING')
        fail(step.id+': invented or mismatched step-to-operation dispatch');
      if(step.safetyState!=='DENIED_UNAVAILABLE_UNKNOWN_ARE_VISIBLE_AND_NEVER_SUCCESS')
        fail(step.id+': missing denied/unavailable/unknown UX contract');
    }
  }
  if(cases.length!==84 || !sameIds(allSteps.map(x=>x.acceptanceCaseRef),cases.map(x=>x.id)) ||
     !uniqueSet(allSteps.map(x=>x.id)))
    fail('PDP3 acceptance-case step coverage is not one-to-one 84 of 84');
  const manual=p2.manualOperationParity?.operations??[];
  const editPaths=p3.manualEditExperience?.editPaths??[];
  if(!sameIds(editPaths.map(x=>x.kind),manual.map(x=>x.kind)) || editPaths.length!==52)
    fail('PDP3 edit path does not match all 52 PDP2/PDP1 manual operation kinds');
  const p1Kinds=(p1.objects??[]).find(x=>x.id==='media.recorder.edit-operation')?.operationKinds??[];
  if(!sameIds(editPaths.map(x=>x.kind),p1Kinds))
    fail('PDP3 manual edit paths differ from canonical PDP1 discriminants');
  for(const e of editPaths) {
    const origin=manual.find(x=>x.kind===e.kind);
    if(!origin || e.pdp2CanonicalIntentRef!==origin.cliSdkApiIntent ||
       e.pdp2EditorArea!==origin.gui || e.owningProjectMutation!==origin.owningProjectMutation ||
       e.expectedRevisionRequired!==true || e.runtimeStatus!=='NOT_ADMITTED')
      fail(e.kind+': manual edit identity, editor parity or revision guard drifted');
  }
  const pages=p3.productionStudioWorkspace?.pages??[];
  const workspace=p2.productionStudioNavigation?.workspace??[];
  const declaredGui=(p2.surfaceInterfaces??[]).find(x=>x.surfaceId==='media.surface.production-studio')?.pages??[];
  if(!sameIds(workspace,declaredGui) || !sameIds(pages.map(x=>x.pdp2WorkspaceKey),workspace) ||
     !uniqueSet(pages.map(x=>x.id)) ||
     pages.length!==13)
    fail('PDP2 Studio page inventory and PDP3 scoped workspace differ');
  for(const page of pages) {
    if(!page.semanticIntent || !page.id?.endsWith('.'+page.pdp2WorkspaceKey+'.v1'))
      fail(String(page.id)+': workspace page must retain a named, unique semantic intent');
    if(page.canonicalScreenBinding!=='UNBOUND_PROPOSAL' || page.implementationStatus!=='SOURCE_ONLY')
      fail(page.id+': proposed workspace page must not claim canonical screen or implementation admission');
  }
  if(p3.status!=='SOURCE_AUTHORED_SUCCESSOR_PENDING_NATIVE_VALIDATION_AND_CURRENTNESS' ||
     p3.explorerProjection?.status!=='SPECIFICATION_ONLY_NOT_VERIFIED' ||
     (p3.nonClaims??[]).indexOf('not-PDP3-dev-complete')<0)
    fail('PDP3 successor cannot claim DEV_COMPLETE, Explorer verification or runtime admission');
  const population=p3.population??{};
  for(const [name,value] of Object.entries({logicalSurfaces:4,featureProfiles:16,acceptanceCaseSteps:84,manualEditPaths:52,studioWorkspaceProposals:13,existingTopLevelJourneysPreserved:30,existingCanonicalScreensPreserved:47,physicalPackagesAdded:0}))
    if(population[name]!==value)fail('declared PDP3 population mismatch: '+name);
  return {errors,stats:{sourceDocumentsValid:true,logicalSurfaces:surfaceDefs.length,flowContracts:flows.length,acceptanceCaseSteps:allSteps.length,manualEditPaths:editPaths.length,workspaceIntents:pages.length}};
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  const report=verifyRecorderStudioExperience();
  console.log(JSON.stringify(report,null,2));
  if(report.errors.length)process.exitCode=1;
}
