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
  assert.deepEqual(result.stats,{sourceDocumentsValid:true,logicalSurfaces:4,flowContracts:16,acceptanceCaseSteps:84,manualEditPaths:52,workspaceIntents:13});
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
test('rejects duplicate YAML keys and malformed YAML',()=>{
  expectReject(verifyRecorderStudioExperience({overrides:{p3:source+'\nsourcePhase: PDP-3\n'}}),'invalid or duplicate YAML');
  expectReject(verifyRecorderStudioExperience({overrides:{p3:source+'\ninvalid: [unterminated\n'}}),'invalid or duplicate YAML');
});
