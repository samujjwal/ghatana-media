import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, stringify } from 'yaml';
import { verifyRecorderStudioExperience } from '../scripts/check-media-recorder-studio-experience.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const source=fs.readFileSync(path.join(root,'.product-experience/pdp-3-product-experience/recorder-studio-experience.yaml'),'utf8');
const probe=change=>{ const p3=parse(source);change(p3);return verifyRecorderStudioExperience({overrides:{p3:stringify(p3)}}); };
const expectReject=(report,part)=>assert.ok(report.errors.some(x=>x.includes(part)),report.errors.join('\n'));
test('source-derived Recorder Studio PDP3 exact coverage is 4/16/84/52/13 without runtime claims',()=>{
  const result=verifyRecorderStudioExperience();
  assert.deepEqual(result.errors,[]);
  assert.deepEqual(result.stats,{sourceDocumentsValid:true,logicalSurfaces:4,flowContracts:16,acceptanceCaseSteps:84,exactProposedPrimaryOperationSteps:63,explicitNonInvocationSteps:21,manualEditPaths:52,workspaceIntents:13,reusedCanonicalScreenViews:12,unregisteredScreenCandidates:1,interactiveScreenCaseContracts:4});
});
test('rejects a missing PDP0 step from an otherwise well-shaped flow',()=>{
  expectReject(probe(x=>x.flowContracts[0].stepContracts.pop()),'case-step coverage mismatch');
});
test('rejects a profile moved to another logical consumer with intact population',()=>{
  expectReject(probe(x=>x.flowContracts[0].surfaceId='media.surface.production-studio'),'feature/owner/PDP1/PDP2 group mismatch');
});
test('rejects credible-looking but wrong step operation candidates',()=>{
  expectReject(probe(x=>x.flowContracts[0].operationCandidateRefs=['media.recorder.operation.edit.commit.v1']),'proposed operation candidates drifted');
});
test('rejects shadow copies of PDP0 acceptance meaning in PDP3',()=>{
  expectReject(probe(x=>x.flowContracts[0].stepContracts[0].sourceWhen='invented source behavior'),'must not be shadowed per step');
});
test('rejects incomplete source-owned acceptance oracles',()=>{
  const req=fs.readFileSync(path.join(root,'.product-experience/pdp-0-product-truth/requirements.yaml'),'utf8');
  const at=req.indexOf('    - id: MEDIA-REC-P0-AC-001');
  assert.ok(at>=0);
  const then=req.indexOf('      then: "',at);
  assert.ok(then>=at);
  const ending=req.indexOf('"',then+'      then: "'.length);
  assert.ok(ending>then);
  const invalid=req.slice(0,then)+'      then: ""'+req.slice(ending+1);
  expectReject(verifyRecorderStudioExperience({overrides:{req:invalid}}),'canonical PDP0 positive and negative oracles are incomplete');
});
test('rejects invented step ID without changing its valid acceptance reference',()=>{
  expectReject(probe(x=>x.flowContracts[0].stepContracts[0].id='media.recorder.p3.step.999.v1'),'step identity must derive');
});

test('rejects an operation which is valid PDP1 but not selected by the owning step feature',()=>{
  expectReject(probe(x=>x.flowContracts[0].stepContracts[0].primaryPdp1OperationRef=
    'media.recorder.operation.edit.commit.v1'),
    'exact operation choice is not a matching unadmitted PDP1 candidate');
});
test('rejects falsified PDP1 effect class or runtime admission',()=>{
  expectReject(probe(x=>x.flowContracts[0].stepContracts[0].inheritedEffectBoundary='CANONICAL_PRODUCT_STATE_CHANGE'),
    'exact operation choice is not a matching unadmitted PDP1 candidate');
  const p1text=fs.readFileSync(path.join(root,'.product-experience/pdp-1-domain-data/recorder-studio-contracts.yaml'),'utf8');
  const changed=parse(p1text);
  changed.canonicalOperationProposals.records.find(x=>x.id==='media.recorder.operation.project.plan.evaluate.v1').runtimeStatus='ADMITTED';
  expectReject(verifyRecorderStudioExperience({overrides:{p1:stringify(changed)}}),
    'exact operation choice is not a matching unadmitted PDP1 candidate');
});
test('rejects a no-invocation policy presented as a direct product effect',()=>{
  expectReject(probe(x=>{
    const step=x.flowContracts.flatMap(f=>f.stepContracts).find(s=>s.acceptanceCaseRef==='MEDIA-REC-P0-AC-050');
    step.primaryPdp1OperationRef='media.recorder.operation.interactive.package.v1';
  }),'non-invocation cannot smuggle in a product operation or effect');
  expectReject(probe(x=>{
    const step=x.flowContracts.flatMap(f=>f.stepContracts).find(s=>s.acceptanceCaseRef==='MEDIA-REC-P0-AC-047');
    step.noDirectInvocationReason='';
  }),'explicit no-operation disposition needs a case-specific reason');
});
test('rejects evidence invention, missing binding or 63/21 semantic census drift',()=>{
  expectReject(probe(x=>x.flowContracts[0].stepContracts[0].requiredSourceEvidenceClass='MOCKED_PASS'),
    'missing or unrecognized source evidence class');
  expectReject(probe(x=>x.flowContracts[0].stepContracts[0].bindingDisposition='RUNTIME_ADMITTED'),
    'missing explicit step operation or no-direct-invocation disposition');
  expectReject(probe(x=>x.population.explicitNonInvocationSteps=0),
    'Recorder Studio 63 proposed operations and 21 non-invocations have drifted');
});
test('rejects duplicated per-kind policy that can drift from canonical parity',()=>{
  expectReject(probe(x=>x.manualEditExperience.editPaths[0].runtimeStatus='ADMITTED'),'duplicated manual semantic authority');
  expectReject(probe(x=>x.manualEditExperience.runtimeAdmission='ADMITTED'),'must not claim runtime admission');
});
test('rejects a missing manual edit kind or implicit revision bypass',()=>{
  expectReject(probe(x=>x.manualEditExperience.editPaths.pop()),'PDP3 edit path');
  expectReject(probe(x=>x.manualEditExperience.editPaths[0].expectedRevisionRequired=false),'manual edit identity');
});
test('rejects a source-valid but wrong page ID or label',()=>{
  expectReject(probe(x=>x.productionStudioWorkspace.pages[0].id='media.recorder.p3.workspace.fake-id.v1'),'named, unique semantic intent');
  expectReject(probe(x=>x.productionStudioWorkspace.pages[0].semanticIntent=''),'named, unique semantic intent');
});
test('rejects missing or mutually incompatible PDP2 design chain',()=>{
  expectReject(probe(x=>x.productionStudioWorkspace.pages[0].templateId='media.gui.template.workbench'),'Studio design chain lacks exact compatible template/layout/recipe authority');
  expectReject(probe(x=>x.productionStudioWorkspace.pages[0].layoutId='media.gui.layout.render'),'Studio design chain lacks exact compatible template/layout/recipe authority');
  expectReject(probe(x=>x.productionStudioWorkspace.pages[0].designChainBindingStatus='ADMITTED'),'proposed workspace page');
});
test('rejects a fabricated production-ready page or Explorer claim',()=>{
  expectReject(probe(x=>x.productionStudioWorkspace.pages[0].implementationStatus='IMPLEMENTED'),'proposed workspace page');
  expectReject(probe(x=>x.explorerProjection.status='VERIFIED'),'cannot claim DEV_COMPLETE');
});
test('rejects fictional upstream journeys and invented operation admissions',()=>{
  expectReject(probe(x=>x.flowContracts[0].reuseExistingJourneyRefs=['J-99']),'missing or invented existing PDP3 journey');
  expectReject(probe(x=>x.flowContracts[0].operationSelectionStatus='ADMITTED'),'step operation admission not proven');
});
test('rejects dropped canonical journey or screen registry identities',()=>{
  const screenSource=fs.readFileSync(path.join(root,'.product-experience/pdp-3-product-experience/screen-registry.yaml'),'utf8');
  expectReject(verifyRecorderStudioExperience({overrides:{screens:screenSource.replace(/^- id: media.view.resume-work$/m,'- id: media.view.find-projects')}}),'historical PDP3 journey/screen inventory');
  const journeySource=fs.readFileSync(path.join(root,'.product-experience/pdp-3-product-experience/journey-registry.yaml'),'utf8');
  expectReject(verifyRecorderStudioExperience({overrides:{journeys:journeySource.replace(/^  - id: J-01$/m,'  - id: J-02')}}),'historical PDP3 journey/screen inventory');
});
test('rejects missing and incorrectly classified canonical Recorder Studio artifact identities',()=>{
  const registry=fs.readFileSync(path.join(root,'.product-experience/artifact-identities.yaml'),'utf8');
  const correct='    authorityClass: "PRODUCT_EXPERIENCE_AUTHORITY"';
  const suffix='  - path: ".product-experience/pdp-3-product-experience/recorder-studio-experience.yaml"';
  const pos=registry.indexOf(suffix);
  assert.ok(pos>=0,'PDP3 source must have stable identity');
  const bad=registry.slice(0,pos)+registry.slice(pos).replace(correct,'    authorityClass: "OBSERVATION_ONLY_SOURCE"');
  assert.notEqual(bad,registry);
  expectReject(verifyRecorderStudioExperience({overrides:{identities:bad}}),'missing or misclassified Recorder Studio manifest identity');
  const missing=registry.slice(0,pos)+registry.slice(pos).replace(/  - path: ".product-experience\/pdp-3-product-experience\/recorder-studio-experience.yaml"\n    artifactId: "ART-P3-RECORDER-STUDIO-EXPERIENCE"\n    authorityClass: "PRODUCT_EXPERIENCE_AUTHORITY"\n?/,'');
  assert.notEqual(missing,registry);
  expectReject(verifyRecorderStudioExperience({overrides:{identities:missing}}),'missing or misclassified Recorder Studio manifest identity');
});
test('rejects duplicate YAML keys and malformed YAML',()=>{
  expectReject(verifyRecorderStudioExperience({overrides:{p3:source+'\nsourcePhase: PDP-3\n'}}),'invalid or duplicate YAML');
  expectReject(verifyRecorderStudioExperience({overrides:{p3:source+'\ninvalid: [unterminated\n'}}),'invalid or duplicate YAML');
});

test('rejects a valid but PDP2-inconsistent Studio template and recipe chain',()=>{
  expectReject(probe(x=>{
    const page=x.productionStudioWorkspace.pages.find(p=>p.pdp2WorkspaceKey==='scene-storyboard');
    page.templateId='media.gui.template.workbench';
    page.recipeId='media.gui.recipe.workbench';
  }),'PDP2 page composition differs from PDP3 proposed design chain');
  expectReject(probe(x=>{
    const page=x.productionStudioWorkspace.pages.find(p=>p.pdp2WorkspaceKey==='delivery');
    page.templateId='media.gui.template.render-preparation-and-review';
    page.layoutId='media.gui.layout.render';
    page.recipeId='media.gui.recipe.render-preparation-and-review';
  }),'PDP2 page composition differs from PDP3 proposed design chain');
});
test('rejects a missing or fabricated PDP2 page composition',()=>{
  const p2source=fs.readFileSync(path.join(root,'.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml'),'utf8');
  const mutate=fn=>{const p2=parse(p2source);fn(p2);return verifyRecorderStudioExperience({overrides:{p2:stringify(p2)}});};
  expectReject(mutate(x=>x.productionStudioPageCompositionContracts.pages.pop()),
    'PDP2 page composition inventory');
  expectReject(mutate(x=>x.productionStudioPageCompositionContracts.pages[0].componentRefs[0]='media.component.nonexistent'),
    'PDP2 page components missing');
  expectReject(mutate(x=>x.productionStudioPageCompositionContracts.pages[0].acceptanceCaseRefs=['MEDIA-REC-P0-AC-999']),
    'PDP2 workspace must bind to real');
  expectReject(mutate(x=>x.productionStudioPageCompositionContracts.pages[0].requiredStates=['READY']),
    'PDP2 page states differ');
});
test('rejects missing or malformed screen reuse arrays without throwing',()=>{
  expectReject(probe(x=>delete x.productionStudioWorkspace.pages[0].candidateCanonicalScreenRefs),
    'invalid or ungrounded existing-screen reuse proposal');
});
test('rejects absent, invented or accidentally admitted canonical screen reuse',()=>{
  expectReject(probe(x=>x.productionStudioWorkspace.pages[0].candidateCanonicalScreenRefs=['media.view.nonexistent']),
    'invalid or ungrounded existing-screen reuse proposal');
  expectReject(probe(x=>x.productionStudioWorkspace.pages[0].candidateCanonicalScreenRefs=[]),
    'existing screen reuse cannot mint unregistered screen IDs');
  expectReject(probe(x=>{
    const page=x.productionStudioWorkspace.pages.find(p=>p.pdp2WorkspaceKey==='interactive-authoring');
    page.proposedNewScreenIntentId='media.view.compose-scene';
  }),'unadmitted interactive-authoring screen candidate');
  expectReject(probe(x=>{
    const page=x.productionStudioWorkspace.pages.find(p=>p.pdp2WorkspaceKey==='interactive-authoring');
    page.screenReuseDisposition='ADMITTED';
  }),'invalid screen reuse disposition');
});

test('rejects an interactive authoring screen claiming deployment or unverified effects',()=>{
  expectReject(probe(x=>x.pdp3ScreenCandidates.records[0].implementationAdmission='ADMITTED'),
    'unadmitted interactive screen candidate cannot claim public route');
  expectReject(probe(x=>x.pdp3ScreenCandidates.records[0].routeStatus='PUBLIC_RUNTIME_ROUTE'),
    'unadmitted interactive screen candidate cannot claim public route');
  expectReject(probe(x=>x.pdp3ScreenCandidates.records[0].finality='PRODUCT_EFFECT_CONFIRMED'),
    'interactive candidate screen lacks accessible headless fixture and nonfinal preview limits');
});
test('rejects missing exact interactive case, operation or P1 source value',()=>{
  expectReject(probe(x=>x.pdp3ScreenCandidates.records[0].sourceAcceptanceCaseRefs.pop()),
    'unadmitted interactive screen candidate must have exact case/operation bindings');
  expectReject(probe(x=>x.pdp3ScreenCandidates.records[0].proposedPdp1OperationRefs=['media.recorder.operation.run.submit.v1']),
    'unadmitted interactive screen candidate must have exact case/operation bindings');
  expectReject(probe(x=>x.pdp3ScreenCandidates.records[0].projectedPdp1ValueRefs=['media.recorder.value.not-real.v1']),
    'unadmitted interactive screen candidate must have exact case/operation bindings');
});
test('rejects ungrounded branch behavior or missing denial/recovery accessibility',()=>{
  expectReject(probe(x=>x.pdp3ScreenCandidates.records[0].interactionContracts[0].denial=''),
    'interactive screen candidate lacks exact positive, denial or recovery interaction contract');
  expectReject(probe(x=>x.pdp3ScreenCandidates.records[0].interactionContracts.pop()),
    'interactive screen candidate lacks exact positive, denial or recovery interaction contract');
  expectReject(probe(x=>x.pdp3ScreenCandidates.records[0].preconditions=[]),
    'interactive candidate screen lacks accessible headless fixture and nonfinal preview limits');
  expectReject(probe(x=>x.pdp3ScreenCandidates.records[0].nonhappyConsequences=[]),
    'interactive candidate screen lacks accessible headless fixture and nonfinal preview limits');
  expectReject(probe(x=>x.pdp3ScreenCandidates.records[0].accessibility=[]),
    'interactive candidate screen lacks accessible headless fixture and nonfinal preview limits');
  expectReject(probe(x=>x.pdp3ScreenCandidates.records[0].requiredScenarioFixtures=[]),
    'interactive candidate screen lacks accessible headless fixture and nonfinal preview limits');
});
