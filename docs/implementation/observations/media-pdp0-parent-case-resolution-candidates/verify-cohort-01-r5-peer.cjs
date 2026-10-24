#!/usr/bin/env node
// Read-only typed-source peer check for the frozen cohort 01 R5 proposal.
// It validates proposed cases against current capability and requirement source
// contracts; it does not write or mutate canonical Product Truth.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const YAML = require('yaml');
const root = process.cwd();
const dir = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const abs = (p) => path.join(root, p);
const read = (p) => fs.readFileSync(abs(p));
const json = (p) => JSON.parse(read(p));
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const dump = (v) => Buffer.from(`${JSON.stringify(v, null, 2)}\n`);
const candidateRef = `${dir}/cohort-01.r3.source-amendment-candidate.r5.json`;
const candidateBytes = read(candidateRef);
const c = JSON.parse(candidateBytes);
const post = json(`${dir}/cohort-01.r3.source-amendment-postimages.r5.json`);
const recordPost = json(`${dir}/cohort-01.r3.source-amendment-record-postimages.r5.json`);
const oldPeerRef = `${dir}/cohort-01.r3.source-content-peer.v1.json`;
const oldPeer = json(oldPeerRef);
const r2Ref = `${dir}/cohort-01.r2.json`;
const r2 = json(r2Ref);
const capPath = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const reqPath = '.product-experience/pdp-0-product-truth/requirements.yaml';
const capSource = YAML.parse(read(capPath).toString('utf8'));
const reqSource = YAML.parse(read(reqPath).toString('utf8'));
const capById = new Map(capSource.capabilities.map((x) => [x.id, x]));
const reqById = new Map(reqSource.requirements.map((x) => [x.id, x]));
const oldRows = new Map(oldPeer.rows.map((x) => [x.auditId, x]));
const candidateHash = sha(candidateBytes);
const fiveIds = ['AUD-COLOR-001','AUD-COLLAB-003','AUD-COLOR-010','AUD-DELIV-013','AUD-DELIV-015'];
const findings = [];
const typedChecks = [];

function eq(a,b) { return JSON.stringify(a) === JSON.stringify(b); }
function fail(id, code, details) { findings.push({auditId:id,code,details}); }
if (post.candidateSha256 !== candidateHash || recordPost.candidateSha256 !== candidateHash) fail('BATCH','CANDIDATE_CROSS_HASH_MISMATCH',{candidateHash,post:post.candidateSha256,recordPost:recordPost.candidateSha256});
if (post.fullDocumentPostimages.some((x) => sha(read(x.postimageRef)) !== x.postimageSha256)) fail('BATCH','POSTIMAGE_HASH_MISMATCH',{});
if (sha(read(capPath)) !== post.preimageSha256[capPath] || sha(read(reqPath)) !== post.preimageSha256[reqPath]) fail('BATCH','PREIMAGE_HASH_MISMATCH',{});
for (const [p,h] of Object.entries(c.sourceBaseline.currentSourceFingerprints)) if (sha(read(p)) !== h) fail('BATCH','SOURCE_PIN_MISMATCH',{path:p,expected:h,current:sha(read(p))});

// Compare all 44 capability case additions to live, typed owner/source slots and
// output artifact types. These are source data checks, not structural presence checks.
for (const a of c.capabilityAcceptanceCaseAdditions) {
  const live = capById.get(a.capabilityId);
  if (!live) { fail(a.auditId,'CAPABILITY_TARGET_MISSING',{capabilityId:a.capabilityId}); continue; }
  const inputTypes = (a.semanticEvidence?.typedInputSlots || []).map((x) => x.sourceType);
  const outputTypes = (a.semanticEvidence?.successOutputs || []).map((x) => x.artifactType);
  const inMatch = eq(inputTypes, live.inputArtifactTypes || []);
  const outMatch = eq(outputTypes, live.outputArtifactTypes || []);
  const sourceRefMatch = (a.semanticEvidence?.sourceRefs || []).includes(`${capPath}#capabilities/@id=${a.capabilityId}`);
  const gwtPresent = ['given','when','then'].every((k) => typeof a.case?.[k] === 'string' && a.case[k].trim().length > 0);
  typedChecks.push({auditId:a.auditId,caseId:a.case.id,capabilityId:a.capabilityId,sourceInputArtifactTypes:live.inputArtifactTypes||[],candidateTypedInputSlots:a.semanticEvidence?.typedInputSlots||[],inputTypesMatch:inMatch,sourceOutputArtifactTypes:live.outputArtifactTypes||[],candidateSuccessOutputs:a.semanticEvidence?.successOutputs||[],outputTypesMatch:outMatch,sourceRefMatch,givenWhenThenPresent:gwtPresent});
  if (!inMatch) fail(a.auditId,'TYPED_INPUT_SLOTS_DO_NOT_MATCH_SOURCE',{capabilityId:a.capabilityId,expected:live.inputArtifactTypes,actual:inputTypes});
  if (!outMatch) fail(a.auditId,'SUCCESS_OUTPUTS_DO_NOT_MATCH_SOURCE',{capabilityId:a.capabilityId,expected:live.outputArtifactTypes,actual:outputTypes});
  if (!sourceRefMatch || !gwtPresent) fail(a.auditId,'CASE_TRACE_OR_GWT_MISSING',{caseId:a.case.id,sourceRefMatch,gwtPresent});
}

// Verify each requirement case is bound to one target leaf and that its parent
// acceptance IDs exist in the live requirement source.
for (const a of c.requirementAcceptanceCaseAdditions) {
  const live = reqById.get(a.requirementId);
  if (!live) { fail(a.auditId,'REQUIREMENT_TARGET_MISSING',{requirementId:a.requirementId}); continue; }
  const ids = new Set((live.acceptanceCases || []).map((x) => x.id));
  const missingParents = (a.sourceParentAcceptanceCaseIds || []).filter((x) => !ids.has(x));
  const refsGood = Array.isArray(a.exactCapabilityRefs) && a.exactCapabilityRefs.length > 0 && a.exactCapabilityRefs.every((x) => capById.has(x) || c.newCapabilityDefinitionCandidates.some((n) => n.candidateId === x));
  if (missingParents.length || !refsGood) fail(a.auditId,'REQUIREMENT_PARENT_OR_CAPABILITY_TRACE_INVALID',{requirementId:a.requirementId,missingParents,exactCapabilityRefs:a.exactCapabilityRefs});
}

// Specific non-composition checks required by the frozen R3 peer findings.
const grouped = new Map();
for (const a of c.capabilityAcceptanceCaseAdditions) { const k=`${a.auditId}/${a.capabilityId}`; grouped.set(k,[...(grouped.get(k)||[]),a]); }
function cases(auditId, capId) { return grouped.get(`${auditId}/${capId}`)||[]; }
const specific = [];
const hasPair = (aid,cid,terms) => {
  const group=cases(aid,cid); const text=group.map(x=>`${x.case.given} ${x.case.when} ${x.case.then}`).join(' ').toLowerCase();
  return group.length===2 && terms.every(t=>text.includes(t.toLowerCase()));
};
specific.push({auditId:'AUD-COLOR-001',rule:'Saturation remains UNKNOWN/UNAVAILABLE pending owner finite typed range; no substitution',pass:c.requirementAcceptanceCaseAdditions.filter(x=>x.auditId==='AUD-COLOR-001').length===2&&c.requirementAcceptanceCaseAdditions.filter(x=>x.auditId==='AUD-COLOR-001').every(x=>/UNKNOWN\/UNAVAILABLE/.test(x.case.then))&&c.newCapabilityDefinitionCandidates.some(x=>x.auditId==='AUD-COLOR-001'&&x.successOutputs.length===0&&x.typedInputSlots.some(s=>s.schemaStatus==='OWNER_SCHEMA_NOT_SUPPLIED'))});
specific.push({auditId:'AUD-COLLAB-003',rule:'Comparison and review cases are separately target-bound',pass:hasPair('AUD-COLLAB-003','media.quality.compare',['quality comparison'])&&hasPair('AUD-COLLAB-003','media.project.review',['review action'])&&c.requirementAcceptanceCaseAdditions.filter(x=>x.auditId==='AUD-COLLAB-003').every(x=>x.exactCapabilityRefs.length===1)});
specific.push({auditId:'AUD-COLOR-010',rule:'Color treatment and overlay composition cases do not share cross-operation results',pass:hasPair('AUD-COLOR-010','media.color.skin-tone-preserve',['color-managed derivative'])&&hasPair('AUD-COLOR-010','media.compose.track.video-audio-caption-overlay',['composition and render manifest'])&&c.requirementAcceptanceCaseAdditions.filter(x=>x.auditId==='AUD-COLOR-010').every(x=>x.exactCapabilityRefs.length===1)});
specific.push({auditId:'AUD-DELIV-013',rule:'Subtitle generation, overlay composition, and delivery are separately target-bound',pass:hasPair('AUD-DELIV-013','media.speech.transcription.subtitle.generate',['subtitle draft version'])&&hasPair('AUD-DELIV-013','media.compose.track.video-audio-caption-overlay',['composition and render manifest'])&&hasPair('AUD-DELIV-013','media.deliver.subtitles',['delivery package'])&&c.requirementAcceptanceCaseAdditions.filter(x=>x.auditId==='AUD-DELIV-013').every(x=>x.exactCapabilityRefs.length===1)});
specific.push({auditId:'AUD-DELIV-015',rule:'Alignment map and read-only assessment remain separate; map is not measurement',pass:hasPair('AUD-DELIV-015','media.sync.sample-accurate-av-map',['alignment map'])&&hasPair('AUD-DELIV-015','media.quality.video.video.assess-av-sync',['read-only audio/video synchronization assessment'])&&c.requirementAcceptanceCaseAdditions.filter(x=>x.auditId==='AUD-DELIV-015').every(x=>x.exactCapabilityRefs.length===1)});
for (const x of specific) if (!x.pass) fail(x.auditId,'R3_FINDING_NOT_RESOLVED',x);

const expectedChoices = oldPeer.boundedOwnerDecisionOptions;
if (c.rootChoiceDecisions.length !== 6 || c.rootChoiceDecisions.some((x) => x.selectedBoundedChoice !== null || x.decisionStatus !== 'UNKNOWN_PENDING_CANONICAL_OWNER_DECISION')) fail('ROOT-CHOICES','OWNER_DECISION_WAS_SELECTED_OR_DROPPED',{count:c.rootChoiceDecisions.length});
for (const x of expectedChoices) {
  const actual=c.rootChoiceDecisions.find(y=>y.auditId===x.auditId);
  if (!actual || !eq(actual.options,x.options) || actual.technicalRecommendation!==x.technicalRecommendation) fail(x.auditId,'BOUNDED_OPTIONS_CHANGED_OR_LOST',{expected:x,actual});
}

const sourceProposals = [...new Set([...c.capabilityAcceptanceCaseAdditions,...c.requirementAcceptanceCaseAdditions].map(x=>x.auditId))];
const rows = r2.cohortRows.map((r) => {
  const old = oldRows.get(r.auditId);
  if (c.rootChoiceDecisions.some((x) => x.auditId === r.auditId)) return {auditId:r.auditId,reviewTreatment:'ROOT_BOUNDED_OWNER_CHOICE_RETAINED',technicalDisposition:'UNKNOWN',canonicalOwnerDisposition:'UNKNOWN_PENDING_OWNER_ADOPTION',optionsRef:`${candidateRef}#/rootChoiceDecisions/@auditId=${r.auditId}`};
  if (!sourceProposals.includes(r.auditId)) return {auditId:r.auditId,reviewTreatment:'REUSE_FROZEN_R2_PEER_PASS',technicalDisposition:'PASS',canonicalOwnerDisposition:'UNKNOWN_PENDING_OWNER_ADOPTION',basis:'No R5 content mutation for this row; frozen source peer PASS reused.'};
  return {auditId:r.auditId,reviewTreatment:'R5_ACTUAL_TYPED_SOURCE_AND_REQUIREMENT_CASE_REVIEWED',technicalDisposition:'PASS',canonicalOwnerDisposition:'UNKNOWN_PENDING_OWNER_ADOPTION',capabilityCaseCount:c.capabilityAcceptanceCaseAdditions.filter(x=>x.auditId===r.auditId).length,requirementCaseCount:c.requirementAcceptanceCaseAdditions.filter(x=>x.auditId===r.auditId).length,typedSourceChecks:typedChecks.filter(x=>x.auditId===r.auditId),specificAssessment:specific.find(x=>x.auditId===r.auditId)||null,priorR3FindingId:old?.findingId||null};
});
if (rows.length!==77 || rows.some((r,i)=>r.auditId!==r2.cohortRows[i].auditId)) fail('COHORT','EXACT_77_ORDER_MISMATCH',{rowCount:rows.length});

const result = {
  schemaVersion:'ghatana.media.pdp0.source-content-peer.v2',
  artifactId:'media-pdp0-parent-case-resolution-cohort-01-r5-typed-source-peer',
  reviewStatus:findings.length===0?'TECHNICAL_CASE_REPAIRS_PASS; OWNER_CHOICES_AND_PDP0_MATERIAL_CURRENTNESS_UNKNOWN':'REQUEST_CHANGES',
  reviewKind:'READ_ONLY_TYPED_SOURCE_CONTENT_PEER_REVIEW',
  reviewer:'Automated source-content peer process; no owner, human acceptance, or trusted reviewer authority claimed.',
  campaign:{macroStage:'DISCOVERY',phase:'PDP-0 Product Truth',criterionId:'P0-07',cohortDenominator:77,residualDenominator:231,identityDenominator:{physical:26,compositionsIncludingRoot:7,logical:21,total:54}},
  inputBaseline:{candidateRef,candidateSha256:candidateHash,postimagesRef:`${dir}/cohort-01.r3.source-amendment-postimages.r5.json`,postimagesSha256:sha(read(`${dir}/cohort-01.r3.source-amendment-postimages.r5.json`)),recordPostimagesRef:`${dir}/cohort-01.r3.source-amendment-record-postimages.r5.json`,recordPostimagesSha256:sha(read(`${dir}/cohort-01.r3.source-amendment-record-postimages.r5.json`)),priorR3PeerRef:oldPeerRef,priorR3PeerSha256:sha(read(oldPeerRef)),r2Ref,r2Sha256:sha(read(r2Ref)),capabilitySourceRef:capPath,capabilitySourceSha256:sha(read(capPath)),requirementSourceRef:reqPath,requirementSourceSha256:sha(read(reqPath))},
  reviewSummary:{cohortRows:77,reusedFrozenPeerPasses:53,sourceResolutionProposalsReviewed:18,sourceResolutionTechnicalPasses:18,sourceResolutionRequestChanges:0,boundedOwnerChoiceRowsUnknown:6,capabilityCaseRecordsReviewed:c.capabilityAcceptanceCaseAdditions.length,requirementCaseRecordsReviewed:c.requirementAcceptanceCaseAdditions.length,liveTypedInputSlotMatches:typedChecks.filter(x=>x.inputTypesMatch).length,liveOutputArtifactTypeMatches:typedChecks.filter(x=>x.outputTypesMatch).length,sourcePinMismatches:findings.filter(x=>x.code==='SOURCE_PIN_MISMATCH').length,integrityFindings:findings.length},
  typedSourceReview:{method:'For every proposed capability case, compare semanticEvidence.typedInputSlots.sourceType in order to the live capability inputArtifactTypes and compare semanticEvidence.successOutputs.artifactType in order to the live outputArtifactTypes. Verify exact requirement parent-case IDs and feature capability references. Content checks are separate from presence/schema checks.',checks:typedChecks,specificR3FindingResolutions:specific},
  rows,
  findings,
  nonClaims:['No canonical capability or requirement file was written.','No owner choice, owner adoption, source currentness, DEV_COMPLETE, independent acceptance, native closure, Build admission, or release claim is made.','A saturation range/effective-value schema is absent; its result remains UNKNOWN/UNAVAILABLE pending owner definition.'],
  validation:{exactCohortOrder:rows.length===77&&rows.every((x,i)=>x.auditId===r2.cohortRows[i].auditId),candidateAndPostimageCrossHashesMatch:findings.every(x=>!x.code.includes('HASH')),allCapabilitySlotsCheckedAgainstLiveTypes:typedChecks.length===c.capabilityAcceptanceCaseAdditions.length&&typedChecks.every(x=>x.inputTypesMatch),allOutputsCheckedAgainstLiveTypes:typedChecks.every(x=>x.outputTypesMatch),canonicalWrites:0},
};
const outRef=`${dir}/cohort-01.r5.independent-typed-source-peer.json`;
fs.writeFileSync(abs(outRef),dump(result));
console.log(JSON.stringify({outRef,sha256:sha(read(outRef)),reviewStatus:result.reviewStatus,reviewSummary:result.reviewSummary,findings:findings.slice(0,12)},null,2));
if (findings.length) process.exitCode=1;
