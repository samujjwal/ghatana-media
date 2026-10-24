import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {buildAudSpec002SourceAmendmentV7, validateAudSpec002V7Metadata} from '../scripts/lib/media-pdp0-aud-spec-002-source-amendment-v7.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder='docs/implementation/observations/pdp0-semantic-audit-slices';
const read=ref=>fs.readFileSync(path.join(root,ref));
const sha=b=>createHash('sha256').update(b).digest('hex');
const Ajv2020=createRequire('/Users/samujjwal/Development/ghatana-tools/package.json')('ajv/dist/2020');
const result=buildAudSpec002SourceAmendmentV7({
  v6CandidateBytes:read(`${folder}/AUD-SPEC-002-source-amendment-candidate.v6.json`),
  v6CandidateSchemaBytes:read(`${folder}/AUD-SPEC-002-source-amendment-candidate.v6.schema.json`),
  v6SourceAmendmentBytes:read(`${folder}/AUD-SPEC-002-source-amendment-postimage.v6.json`),
  v6SourceAmendmentSchemaBytes:read(`${folder}/AUD-SPEC-002-source-amendment-postimage.v6.schema.json`),
  v6ManifestBytes:read(`${folder}/AUD-SPEC-002-source-amendment-v6-freeze-manifest.v1.json`),
});

test('v7 fixes only the stale peer-review blocker and binds v6 predecessor exactly',()=>{
  assert.equal(result.candidate.blockers.filter(value=>value.includes('DISTINCT_TECHNICAL_PEER_REVIEW')).length,1);
  assert.ok(result.candidate.blockers.includes('DISTINCT_TECHNICAL_PEER_REVIEW_OF_THE_EXACT_V7_SIX_SOURCE_POSTIMAGE_REQUIRED'));
  assert.equal(result.candidate.predecessorCandidateRef,`${folder}/AUD-SPEC-002-source-amendment-candidate.v6.json`);
  assert.equal(result.candidate.predecessorCandidateSha256,sha(read(`${folder}/AUD-SPEC-002-source-amendment-candidate.v6.json`)));
  assert.deepEqual(result.candidate.exactFileTargets,result.targetRows);
  assert.deepEqual(result.candidate.population,{historicalBase:462,currentExtension:1,futureProposals:6,currentVersionTotal:463,allDefinitions:469,surfaceIdentityCount:54,phaseCellCount:216});
  assert.equal(validateAudSpec002V7Metadata(result.candidate,result.sourceAmendment),true);
});

test('v7 candidate and amendment satisfy additive v7 schemas without changing six source-postimage hashes',()=>{
  const ajv=new Ajv2020({strict:true});
  const candidate=ajv.compile(result.candidateSchema); const source=ajv.compile(result.sourceAmendmentSchema);
  assert.equal(candidate(result.candidate),true,JSON.stringify(candidate.errors));
  assert.equal(source(result.sourceAmendment),true,JSON.stringify(source.errors));
  assert.equal(result.candidate.canonicalApply,'NOT_PERFORMED');
  assert.equal(result.candidate.effects.sourceCurrentness,'NOT_CLAIMED');
  assert.equal(result.candidate.effects.qualityApplicability,'UNKNOWN_PENDING_REVIEW');
  const forged={...result.candidate,blockers:result.candidate.blockers.map(value=>value=== 'DISTINCT_TECHNICAL_PEER_REVIEW_OF_THE_EXACT_V7_SIX_SOURCE_POSTIMAGE_REQUIRED'?'DISTINCT_TECHNICAL_PEER_REVIEW_OF_THE_EXACT_V5_SIX_SOURCE_POSTIMAGE_REQUIRED':value)};
  assert.equal(candidate(forged),true,'schema structurally permits blocker prose; metadata validator must reject stale version');
  assert.throws(()=>validateAudSpec002V7Metadata(forged,result.sourceAmendment),/exact current v7 postimage/u);
});
