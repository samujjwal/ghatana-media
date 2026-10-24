#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  PDP0_DIRECT_REVIEW_REF, PDP0_MATRIX_REF, PDP0_READINESS_REF, PDP0_STATUS_REF,
  buildPdp0CurrentSourceReviewCandidate, resolveReviewRecordFiles,
} from './lib/media-pdp0-current-source-review-assembler.mjs';
import {buildPdp0ReviewSuccessorPostimage, planPdp0ReviewSuccessor} from './lib/media-pdp0-review-successor-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const folder = 'docs/implementation/observations/media-pdp0-current-source-reviews-2026-10-23';
const refs = {
  candidate: `${folder}/candidate.v4.json`,
  plan: `${folder}/successor-plan.v2.json`,
  decision: `${folder}/source-owner-decision.v3.json`,
  postimage: `${folder}/postimage.v3.json`,
};
const read = ref => fs.readFileSync(path.resolve(root, ref), 'utf8');
const write = (ref, value) => fs.writeFileSync(path.resolve(root, ref), `${JSON.stringify(value, null, 2)}\n`);

export function planMediaPdp0CurrentSourceReviewSuccessor() {
  const status = JSON.parse(read(PDP0_STATUS_REF));
  const readiness = JSON.parse(read(PDP0_READINESS_REF));
  const directReviewText = read(PDP0_DIRECT_REVIEW_REF);
  const directReview = JSON.parse(directReviewText);
  const matrix = JSON.parse(read(PDP0_MATRIX_REF));
  const reviewRecords = resolveReviewRecordFiles({read});
  const candidate = buildPdp0CurrentSourceReviewCandidate({status, readiness, directReview, matrix, reviewRecords, read});
  const candidateText = `${JSON.stringify(candidate, null, 2)}\n`;
  const decisionLogText = read('.product-experience/decision-log.md');
  const plan = planPdp0ReviewSuccessor({candidate, candidateText, directReview, directReviewText, decisionLogText, reviewRecords});
  write(refs.candidate, candidate);
  write(refs.plan, plan);
  if (fs.existsSync(path.resolve(root, refs.decision))) {
    const decision = JSON.parse(read(refs.decision));
    const postimage = buildPdp0ReviewSuccessorPostimage({decision, decisionLogText, plan, candidate, directReview, currentDirectReviewText: directReviewText});
    write(refs.postimage, postimage);
    return {plan, candidate, postimageRef: refs.postimage, postimageSha256: postimage.postimageSha256};
  }
  return {plan, candidate, postimageRef: null, requiredDecisionRef: refs.decision};
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv.includes('--plan')) throw new Error('no effect is performed without explicit --plan');
    const result = planMediaPdp0CurrentSourceReviewSuccessor();
    console.log(JSON.stringify({planDisposition: result.plan.planDisposition, blockers: result.plan.blockers, missingCriterionIds: result.plan.missingCriterionIds, openMeaningFindingIds: result.plan.openMeaningFindingIds, candidateRef: refs.candidate, candidateSha256: result.plan.candidateSha256, postimageRef: result.postimageRef}, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
