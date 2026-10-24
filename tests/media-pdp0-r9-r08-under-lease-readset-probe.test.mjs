import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {R9R08_V2_READ_SET,R9R08_V2_WRITE_TARGETS,R9R08_V2_RECORD_REFS} from '../scripts/lib/media-pdp0-root-selected-source-integration-r9-r08-v2-guard.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const statusRef = 'docs/implementation/pdp-0-phase-dev-status.json';
const journalRoot = 'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-journals';

function createIsolatedRepository() {
  const container = fs.mkdtempSync(path.join(os.tmpdir(), 'media-r9-r08-writer-'));
  const root=path.join(container,'ghatana-media');
  const toolsRoot=path.join(container,'ghatana-tools');
  fs.mkdirSync(root,{recursive:true});
  fs.mkdirSync(toolsRoot,{recursive:true});
  fs.writeFileSync(path.join(toolsRoot,'package.json'),'{}\n');
  fs.symlinkSync(path.join(repoRoot,'node_modules'),path.join(toolsRoot,'node_modules'),'dir');
  fs.mkdirSync(path.join(root,'scripts'),{recursive:true});
  fs.cpSync(path.join(repoRoot,'scripts/lib'),path.join(root,'scripts/lib'),{recursive:true});
  fs.copyFileSync(path.join(repoRoot,'scripts/plan-media-pdp0-root-selected-source-integration-r9-r07-application.mjs'),
    path.join(root,'scripts/plan-media-pdp0-root-selected-source-integration-r9-r07-application.mjs'));
  fs.symlinkSync(path.join(repoRoot,'node_modules'),path.join(root,'node_modules'),'dir');
  const refs = [...new Set([...R9R08_V2_READ_SET,statusRef])];
  const originals = new Map();
  for (const [index,ref] of refs.entries()) {
    const bytes = Buffer.from(`temporary R9-R08 fixture source ${index}`);
    const target = path.join(root,ref);
    fs.mkdirSync(path.dirname(target),{recursive:true});
    fs.writeFileSync(target,bytes);
    originals.set(ref,bytes);
  }
  // Deliberately leave all four owner-controlled authority records absent. The test
  // proves fail-closed behavior; it does not synthesize actor trust or approval.
  for(const ref of R9R08_V2_RECORD_REFS) assert.equal(fs.existsSync(path.join(root,ref)),false,`${ref} must stay absent in the no-authority fixture`);
  return {root,originals,dispose:() => fs.rmSync(container,{recursive:true,force:true})};
}

function assertCanonicalInputsUnchanged(root,originals) {
  for (const [ref,expected] of originals) assert.deepEqual(fs.readFileSync(path.join(root,ref)),expected,`${ref} changed`);
  const journalDir=path.join(root,journalRoot);
  if(fs.existsSync(journalDir)) assert.deepEqual(fs.readdirSync(journalDir),[],'no lock or journal may remain');
  const preimages=path.join(root,'docs/implementation/observations/pdp0-semantic-audit-slices/source-amendment-preimages');
  assert.equal(fs.existsSync(preimages),false,'authority failure must happen before immutable snapshots');
  for(const ref of R9R08_V2_WRITE_TARGETS){
    const parent=path.dirname(path.join(root,ref));
    assert.equal(fs.readdirSync(parent).some(name=>name.includes('.tmp-')),false,`${ref} has an abandoned target temporary`);
  }
}

async function loadIsolatedCasModule(root) {
  return import(pathToFileURL(path.join(root,'scripts/lib/media-pdp0-review-successor-cas.mjs')).href);
}

test('R9-R08 writer refuses missing owner records before creating any apply artifacts',async()=>{
  const fixture=createIsolatedRepository();
  try{
    const cas=await loadIsolatedCasModule(fixture.root);
    assert.throws(()=>cas.commitValidatedPdp0RootSelectedSourceIntegrationR9R08V2({actorTrust:[]}),/accepts only/u,
      'callers cannot supply actor claims to the fixed writer');
    assert.throws(()=>cas.commitValidatedPdp0RootSelectedSourceIntegrationR9R08V2({}),/missing or unreadable/u);
    assertCanonicalInputsUnchanged(fixture.root,fixture.originals);
  }finally{fixture.dispose();}
});

test('R9-R08 read-only under-lease probe reports absent authority and leaves no lock, journal, or snapshot',async()=>{
  const fixture=createIsolatedRepository();
  try{
    const cas=await loadIsolatedCasModule(fixture.root);
    const result=cas.validateMediaPdp0RootSelectedSourceIntegrationR9R08V2ReadSetUnderLease();
    assert.equal(result.blocked,true);
    assert.equal(result.canonicalApply,'NONE');
    assert.equal(result.blocker,'DISTINCT_EXACT_INPUT_APPLY_AUTHORIZATION_NOT_RECORDED');
    assertCanonicalInputsUnchanged(fixture.root,fixture.originals);
  }finally{fixture.dispose();}
});

test('R9-R08 implementation keeps the decision log read-only and its seven-member source set exact',()=>{
  assert.equal(R9R08_V2_READ_SET.length,7);
  assert.equal(R9R08_V2_WRITE_TARGETS.length,4);
  assert.ok(R9R08_V2_READ_SET.includes('.product-experience/decision-log.md'));
  assert.equal(R9R08_V2_WRITE_TARGETS.includes('.product-experience/decision-log.md'),false);
});
