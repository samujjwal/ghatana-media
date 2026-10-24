import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';
import {fileURLToPath} from 'node:url';
import {buildAudSpec002QualityApplicabilityOptions} from '../scripts/lib/media-pdp0-aud-spec-002-quality-applicability-options.mjs';

const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const folder='docs/implementation/observations/pdp0-semantic-audit-slices';
const read=ref=>fs.readFileSync(path.join(root,ref));
const require=createRequire('/Users/samujjwal/Development/ghatana-tools/package.json');
const Ajv2020=require('ajv/dist/2020');
const built=buildAudSpec002QualityApplicabilityOptions({
 capabilityBytes:read('.product-experience/pdp-0-product-truth/capabilities.yaml'),
 qualityPolicyBytes:read('.product-experience/pdp-0-product-truth/quality-policy.yaml'),
 pxd225Bytes:read('docs/implementation/verification/pdp-38/p0-quality-current-source-review-pxd225.json'),
 v6ManifestBytes:read(`${folder}/AUD-SPEC-002-source-amendment-v6-freeze-manifest.v1.json`),
 v6CapabilityPostimageBytes:read(`${folder}/AUD-SPEC-002-capabilities-file-postimage.v6.yaml`),
});

test('quality option record pins current capability, quality policy, PXD-225, and exact v6 subject postimage',()=>{
 const validate=new Ajv2020({strict:true}).compile(built.schema);
 assert.equal(validate(built.options),true,JSON.stringify(validate.errors));
 assert.equal(built.options.status,'PENDING_EXPLICIT_ROOT_TECHNICAL_SOURCE_OWNER_CHOICE');
 assert.equal(built.options.proposedSubject.capabilityRef,'media.recipe.specification.compile');
 assert.equal(built.options.predecessorQualityReview.currentRows,462);
 assert.equal(built.options.predecessorQualityReview.excludedExtensions,7);
 assert.equal(built.options.boundaries.candidateCurrentCapabilityPopulation,463);
 assert.equal(built.options.boundaries.historicalQualityReviewReusableForExtension,false);
});

test('option A applies only exact existing applicability predicates without new thresholds or measurement claims',()=>{
 const option=built.options.options[0];
 assert.equal(option.optionId,'APPLY_EXISTING_EXACT_TYPED_APPLICABILITY_RULES');
 assert.equal(option.dimensions.length,6); assert.equal(option.metrics.length,16);
 assert.deepEqual(option.dimensions.map(row=>row.status),['NOT_APPLICABLE','NOT_APPLICABLE','NOT_APPLICABLE','NOT_APPLICABLE','APPLICABLE','NOT_APPLICABLE']);
 assert.ok(option.metrics.every(row=>row.status==='NOT_APPLICABLE'&&row.reason==='NO_EXACT_MEDIA_SUBJECT_IN_REQUIRED_DIRECTION'));
 assert.equal(option.thresholds,'NONE_DEFINED_OR_ADDED');
 assert.equal(option.measurementState,'NOT_EVALUATED');
 assert.equal(option.qualificationState,'NOT_EVALUATED');
 assert.ok(option.dimensions.every(row=>row.sourceRuleRef));
 assert.ok(option.metrics.every(row=>row.sourceRuleRef));
});

test('option B preserves UNKNOWN until explicit owner disposition and does not equate unknown with NOT_APPLICABLE',()=>{
 const option=built.options.options[1];
 assert.equal(option.optionId,'RETAIN_ALL_EXTENSION_QUALITY_APPLICABILITY_UNKNOWN');
 assert.ok(option.dimensions.every(row=>row.status==='UNKNOWN'));
 assert.ok(option.metrics.every(row=>row.status==='UNKNOWN'));
 assert.equal(option.disposition,'PRESERVES_UNKNOWN; DOES_NOT_COMPLETE_THIS_DEFINITION_ITEM');
 assert.equal(built.options.unresolvedDecisions.includes('ROOT_MUST_SELECT_APPLICABILITY_OPTION'),true);
});
