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
  "screens": ".product-experience/pdp-3-product-experience/screen-registry.yaml",
  "templates": ".product-experience/pdp-2-design-interface-system/gui/templates/catalog.yaml",
  "layouts": ".product-experience/pdp-2-design-interface-system/gui/layout.yaml",
  "recipes": ".product-experience/pdp-2-design-interface-system/gui/recipes/catalog.yaml",
  "identities": ".product-experience/artifact-identities.yaml",
  "components": ".product-experience/pdp-2-design-interface-system/component-contracts.yaml"
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
  const {p0,p1,p2,p3,req,journeys,screens,templates,layouts,recipes,identities,components}=sources;
  if(!p0 || !p1 || !p2 || !p3 || !req || !journeys || !screens || !templates || !layouts || !recipes || !identities || !components) {
    return {errors:['Missing source document contents'],stats:{sourceDocumentsValid:false}};
  }
  const requiredIdentities=[
    ['.product-experience/pdp-0-product-truth/recorder-studio-extension.yaml','ART-P0-RECORDER-STUDIO-EXTENSION','PRODUCT_TRUTH_AUTHORITY'],
    ['.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml','ART-P1-RECORDER-STUDIO-CONTRACTS','DOMAIN_DATA_AUTHORITY'],
    ['.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml','ART-P2-RECORDER-STUDIO-INTERFACE','DESIGN_INTERFACE_AUTHORITY'],
    ['.product-experience/pdp-3-product-experience/recorder-studio-experience.yaml','ART-P3-RECORDER-STUDIO-EXPERIENCE','PRODUCT_EXPERIENCE_AUTHORITY'],
  ];
  const identityEntries=identities.records??[];
  for(const [sourcePath,sourceId,authorityClass] of requiredIdentities){
    const entry=identityEntries.filter(x=>x.path===sourcePath);
    if(entry.length!==1 || entry[0].artifactId!==sourceId || entry[0].authorityClass!==authorityClass)
      fail('missing or misclassified Recorder Studio manifest identity '+sourcePath);
  }
  if(!uniqueSet(identityEntries.map(x=>x.path)) || !uniqueSet(identityEntries.map(x=>x.artifactId)))
    fail('canonical artifact identities contain duplicate paths or IDs');
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
    if(flow.operationSelectionStatus!=='GROUP_CANDIDATES_ONLY_NOT_STEP_DISPATCH_ADMITTED' ||
       flow.stepDisposition!=='DEFINITION_ONLY_STEP_DISPATCH_UNBOUND_NOT_ADMITTED' ||
       flow.consequencePolicy!=='DENIAL_UNAVAILABLE_ABSTAINED_AND_UNKNOWN_OUTCOME_NEVER_SUCCESS')
      fail(flow.id+': step operation admission or safety not proven');
    if(flow.caseOracleMode!=='LIVE_CANONICAL_PDP0_GIVEN_WHEN_THEN_REJECTION_BY_ACCEPTANCE_CASE_REF')
      fail(flow.id+': canonical case authority must remain the owning PDP0 register');
    if(!sameIds(flow.operationCandidateRefs??[],g1?.proposedPdp1OperationRefs??[]) ||
       !sameIds(flow.operationCandidateRefs??[],g2?.pdp1OperationRefs??[]) ||
       !(flow.operationCandidateRefs??[]).every(x=>operations.has(x)))
      fail(flow.id+': proposed operation candidates drifted from PDP1 and PDP2');
    for(const [index,step] of steps.entries()) {
      allSteps.push(step);
      const source=canonical.get(step.acceptanceCaseRef);
      if(!source || source.surfaceId!==flow.surfaceId || source.group!==groupId || step.order!==index+1)
        fail(step.id+': case step does not match canonical source order/ownership');
      const validCaseId = /^MEDIA-REC-P0-AC-[0-9]{3}$/u.test(String(step.acceptanceCaseRef));
      if(!validCaseId || step.id!=='media.recorder.p3.step.'+step.acceptanceCaseRef.slice(-3)+'.v1')
        fail(String(step.id)+': step identity must derive from canonical acceptance case ID');
      if(!source || !['given','when','then','rejection'].every(k=>typeof source[k]==='string' && source[k].trim()))
        fail(String(step.id)+': canonical PDP0 positive and negative oracles are incomplete');
      if(!sameIds(Object.keys(step),['id','acceptanceCaseRef','order']))
        fail(String(step.id)+': source acceptance and operation meaning must not be shadowed per step');
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
  if(p3.manualEditExperience?.runtimeAdmission!=='NOT_ADMITTED' ||
     p3.manualEditExperience?.parityAndUndoPolicy!=='EACH_CANONICAL_KIND_REQUIRES_SOURCE_REVISION_CAS_KEYBOARD_TEXT_CLI_SDK_API_EQUIVALENCE_AND_LOCK_PRESERVING_INVERSE')
    fail('PDP3 manual editing must not claim runtime admission or weaken parity/undo policy');
  for(const e of editPaths) {
    const origin=manual.find(x=>x.kind===e.kind);
    if(!origin || e.pdp2CanonicalIntentRef!==origin.cliSdkApiIntent ||
       e.pdp2EditorArea!==origin.gui || e.owningProjectMutation!==origin.owningProjectMutation ||
       e.expectedRevisionRequired!==true)
      fail(e.kind+': manual edit identity, editor parity or revision guard drifted');
    if(!sameIds(Object.keys(e),['kind','pdp2CanonicalIntentRef','pdp2EditorArea','owningProjectMutation','expectedRevisionRequired']))
      fail(e.kind+': duplicated manual semantic authority or runtime status');
  }
  const pages=p3.productionStudioWorkspace?.pages??[];
  const workspace=p2.productionStudioNavigation?.workspace??[];
  const declaredGui=(p2.surfaceInterfaces??[]).find(x=>x.surfaceId==='media.surface.production-studio')?.pages??[];
  if(!sameIds(workspace,declaredGui) || !sameIds(pages.map(x=>x.pdp2WorkspaceKey),workspace) ||
     !uniqueSet(pages.map(x=>x.id)) ||
     pages.length!==13)
    fail('PDP2 Studio page inventory and PDP3 scoped workspace differ');
  const p2PageContracts=p2.productionStudioPageCompositionContracts?.pages??[];
  const p2StudioSurface=(p2.surfaceInterfaces??[]).find(x=>x.surfaceId==='media.surface.production-studio');
  const p2StudioComponents=(p2.recorderStudioComponentCompositions?.surfaceContracts??[])
    .find(x=>x.surfaceId==='media.surface.production-studio')?.components??[];
  const componentIds=(components.components??[]).map(x=>x.id);
  const existingScreenIds=(screens.screens??[]).map(x=>x.id);
  if(p2PageContracts.length!==13 || !sameIds(p2PageContracts.map(x=>x.workspaceKey),workspace))
    fail('PDP2 page composition inventory must match all 13 Studio workspace keys');
  if(!uniqueSet(existingScreenIds) || existingScreenIds.length!==47)
    fail('canonical screen baseline must remain unchanged until new candidate admission');
  let reusePageCount=0, newPageCount=0;
  const proposedNewIds=[];
  for(const page of pages) {
    if(!page.semanticIntent || !page.id?.endsWith('.'+page.pdp2WorkspaceKey+'.v1'))
      fail(String(page.id)+': workspace page must retain a named, unique semantic intent');
    if(page.canonicalScreenBinding!=='UNBOUND_PROPOSAL' || page.implementationStatus!=='SOURCE_ONLY' ||
       page.designChainBindingStatus!=='SOURCE_VERIFIED_REUSE_PROPOSAL_SCREEN_INSTANCE_NOT_ADMITTED')
      fail(page.id+': proposed workspace page must not claim canonical screen or implementation admission');
    const template=(templates.templates??[]).find(x=>x.id===page.templateId);
    const layout=(layouts.layouts??[]).find(x=>x.id===page.layoutId);
    const recipe=(recipes.recipes??[]).find(x=>x.id===page.recipeId);
    if(!template || !layout || !recipe ||
       !template.recipeRefs?.includes(page.recipeId) ||
       !template.compatibleLayoutRefs?.includes(page.layoutId) ||
       !layout.compatibleTemplateRefs?.includes(page.templateId) ||
       recipe.templateRef!==page.templateId)
      fail(page.id+': Studio design chain lacks exact compatible template/layout/recipe authority');
    const composition=p2PageContracts.find(x=>x.workspaceKey===page.pdp2WorkspaceKey);
    if(!composition || composition.proposedPdp3WorkspaceId!==page.id ||
       composition.templateRef!==page.templateId ||
       composition.layoutRef!==page.layoutId ||
       composition.recipeRef!==page.recipeId ||
       composition.admission!=='DESIGN_SOURCE_ONLY_NOT_CANONICAL_SCREEN')
      fail(page.id+': PDP2 page composition differs from PDP3 proposed design chain');
    if(!composition || !sameIds(composition.requiredStates??[],p2StudioSurface?.states??[]))
      fail(page.id+': PDP2 page states differ from canonical Studio interface states');
    const ownedComponents=composition?.componentRefs??[];
    if(ownedComponents.length===0 || !uniqueSet(ownedComponents) ||
       !ownedComponents.every(x=>componentIds.includes(x)&&p2StudioComponents.includes(x)))
      fail(page.id+': PDP2 page components missing from existing Studio and Media component authority');
    if(!Array.isArray(composition?.acceptanceCaseRefs) ||
       !composition.acceptanceCaseRefs.length || !uniqueSet(composition.acceptanceCaseRefs) ||
       !composition.acceptanceCaseRefs.every(id=>canonical.has(id)))
      fail(page.id+': PDP2 workspace must bind to real, distinct Recorder acceptance cases');
    for(const name of ['wideIntent','narrowIntent','keyboardAndTextEquivalent','headlessEquivalent','denialAndUnknownRecovery']){
      if(typeof composition?.[name]!=='string' || !composition[name].trim())
        fail(page.id+': PDP2 page missing semantic, accessibility or denial behavior '+name);
    }
    const reuse=page.candidateCanonicalScreenRefs;
    if(!Array.isArray(reuse) || !uniqueSet(reuse) ||
       !reuse.every(ref=>existingScreenIds.includes(ref)) || !page.unresolvedScreenBehavior?.trim())
      fail(page.id+': invalid or ungrounded existing-screen reuse proposal');
    if(page.screenReuseDisposition==='EXISTING_VIEW_SPECIALIZATION_REQUIRED_NOT_ADMITTED') {
      reusePageCount++;
      if(reuse.length===0 || page.proposedNewScreenIntentId)
        fail(page.id+': existing screen reuse cannot mint unregistered screen IDs');
    } else if(page.screenReuseDisposition==='NEW_SCREEN_CANDIDATE_REQUIRED_NOT_REGISTERED') {
      newPageCount++;
      if(reuse.length!==0 || page.proposedNewScreenIntentId!=='media.recorder.p3.screen.interactive-authoring.candidate.v1' ||
         page.pdp2WorkspaceKey!=='interactive-authoring' ||
         existingScreenIds.includes(page.proposedNewScreenIntentId))
        fail(page.id+': unadmitted interactive-authoring screen candidate is not isolated');
      if(page.proposedNewScreenIntentId)proposedNewIds.push(page.proposedNewScreenIntentId);
    } else {
      fail(page.id+': invalid screen reuse disposition');
    }
  }
  if(reusePageCount!==12 || newPageCount!==1 || !uniqueSet(proposedNewIds))
    fail('Recorder Studio 12 reuse vs 1 unadmitted new-screen candidate scope drifted');
  const candidateDefs=p3.pdp3ScreenCandidates;
  const candidateRecords=candidateDefs?.records??[];
  const authoringWorkspace=pages.find(p=>p.pdp2WorkspaceKey==='interactive-authoring');
  const p2AuthoringPage=p2PageContracts.find(p=>p.workspaceKey==='interactive-authoring');
  if(candidateDefs?.status!=='PROPOSED_UNREGISTERED_NO_CANONICAL_SCREEN_CLAIM' ||
     candidateDefs?.proposedCount!==1 || candidateRecords.length!==1)
    fail('unadmitted interactive screen candidate definition census and status missing');
  const candidate=candidateRecords[0];
  if(!candidate || candidate.id!==authoringWorkspace?.proposedNewScreenIntentId ||
     candidate.ownerSurfaceId!=='media.surface.production-studio' ||
     candidate.workspaceRef!==authoringWorkspace?.id ||
     candidate.canonicalScreenRegistryStatus!=='NOT_REGISTERED' ||
     candidate.implementationAdmission!=='NOT_ADMITTED' ||
     candidate.routeStatus!=='NO_PUBLIC_ROUTE_OR_DEPLOYED_VIEW' ||
     existingScreenIds.includes(candidate.id))
    fail('unadmitted interactive screen candidate cannot claim public route or canonical screen');
  const caseRefs=['MEDIA-REC-P0-AC-050','MEDIA-REC-P0-AC-051','MEDIA-REC-P0-AC-052','MEDIA-REC-P0-AC-053'];
  const candidateOps=['media.recorder.operation.edit.commit.v1','media.recorder.operation.interactive.package.v1'];
  const candidateValues=['media.recorder.value.interactive-graph.v1','media.recorder.value.interactive-hotspot.v1'];
  const p1Values=new Set((p1.derivedValueObjects??[]).map(x=>x.id));
  if(!sameIds(candidate?.sourceAcceptanceCaseRefs??[],caseRefs) ||
     !sameIds(candidate?.sourceAcceptanceCaseRefs??[],p2AuthoringPage?.acceptanceCaseRefs??[]) ||
     !sameIds(candidate?.proposedPdp1OperationRefs??[],candidateOps) ||
     !candidateOps.every(x=>operations.has(x)) ||
     !sameIds(candidate?.projectedPdp1ValueRefs??[],candidateValues) ||
     !candidateValues.every(x=>p1Values.has(x)))
    fail('unadmitted interactive screen candidate must have exact case/operation bindings');
  const caseInteractions=candidate?.interactionContracts??[];
  if(!sameIds(caseInteractions.map(x=>x.caseRef),caseRefs) ||
     caseInteractions.some(x=>!['authoringIntent','observation','denial','recovery']
        .every(name=>typeof x[name]==='string' && x[name].trim())))
    fail('interactive screen candidate lacks exact positive, denial or recovery interaction contract');
  if(!sameIds(candidate?.designStates??[],p2StudioSurface?.states??[]) ||
     !Array.isArray(candidate?.plannedRegions) || candidate.plannedRegions.length<7 ||
     !uniqueSet(candidate.plannedRegions) ||
     !Array.isArray(candidate?.accessibility) || candidate.accessibility.length<5 ||
     !Array.isArray(candidate?.headlessEquivalent) || candidate.headlessEquivalent.length<5 ||
     !Array.isArray(candidate?.requiredScenarioFixtures) || candidate.requiredScenarioFixtures.length<6 ||
     !uniqueSet(candidate.requiredScenarioFixtures) ||
     candidate?.finality!=='LOCAL_PREVIEW_NOT_PUBLISHED_AND_NEVER_PRODUCT_EFFECT' ||
     candidate?.acceptanceStatus!=='SOURCE_DEFINITION_ONLY_TESTS_AND_INDEPENDENT_REVIEW_NOT_RUN')
    fail('interactive candidate screen lacks accessible headless fixture and nonfinal preview limits');
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
