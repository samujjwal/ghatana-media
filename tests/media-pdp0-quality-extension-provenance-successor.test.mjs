import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const require=createRequire(path.resolve(root,'../ghatana-tools/package.json'));
const sha=value=>createHash('sha256').update(value).digest('hex');
const read=ref=>fs.readFileSync(path.join(root,ref));
const manifestRef='docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-source-candidate-v2-provenance-successor.v2.json';
const schemaRef='docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-source-candidate-v2-provenance-successor.v2.schema.json';
const oldRef='docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-quality-extension-source-candidate-v2-freeze-manifest.v1.json';

test('metadata successor preserves the exact frozen candidate and target postimages while separating implementation evidence',()=>{
  const row=JSON.parse(read(manifestRef));
  const schema=JSON.parse(read(schemaRef));
  const Ajv2020=require('ajv/dist/2020');
  assert.equal(new Ajv2020({strict:true}).compile(schema)(row),true);
  const old=JSON.parse(read(oldRef));
  const candidate=read(row.candidate.ref);
  const candidateSchema=read(row.candidate.schemaRef);
  assert.equal(row.predecessorFreezeManifest.sha256,sha(read(oldRef)));
  assert.equal(row.candidate.sha256,sha(candidate));
  assert.equal(row.candidate.schemaSha256,sha(candidateSchema));
  assert.deepEqual(row.targetPostimages,old.targets.map(({targetRef,preimageSha256,postimageRef,postimageSha256})=>({targetRef,preimageSha256,postimageRef,postimageSha256})));
  for(const target of row.targetPostimages){
    const predecessor=old.targets.find(item=>item.targetRef===target.targetRef);
    assert.equal(sha(read(predecessor.preimageRef)),target.preimageSha256,`${target.targetRef} predecessor bytes`);
    assert.equal(sha(read(target.postimageRef)),target.postimageSha256,`${target.targetRef} candidate postimage bytes`);
  }
  for(const [ref,expected] of Object.entries(row.semanticProducerPins))assert.equal(sha(read(ref)),expected,`${ref} semantic producer pin`);
  assert.equal(row.implementationEvidence.adapterSha256,sha(read(row.implementationEvidence.adapterRef)));
  assert.equal(row.implementationEvidence.testSha256,sha(read(row.implementationEvidence.testRef)));
  assert.equal(row.implementationEvidence.sha256,sha(read(row.implementationEvidence.ref)));
  assert.equal(row.equivalence.meaningChange,'NONE');
  assert.equal(row.equivalence.oldFreezeManifestCurrentness,'NOT_CLAIMED');
  assert.equal(row.authorityBoundary.canonicalApply,'NOT_PERFORMED');
});
