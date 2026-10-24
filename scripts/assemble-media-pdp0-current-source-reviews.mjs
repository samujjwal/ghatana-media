#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {
  PDP0_DIRECT_REVIEW_REF, PDP0_MATRIX_REF, PDP0_READINESS_REF, PDP0_STATUS_REF,
  buildPdp0CurrentSourceReviewCandidate, resolveReviewRecordFiles,
} from './lib/media-pdp0-current-source-review-assembler.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const defaultOutput = 'docs/implementation/observations/media-pdp0-current-source-reviews-2026-10-23/candidate.v2.json';
const read = file => fs.readFileSync(path.resolve(root, file), 'utf8');

export function assembleMediaPdp0CurrentSourceReview({outputPath = defaultOutput, check = false} = {}) {
  const status = JSON.parse(read(PDP0_STATUS_REF));
  const readiness = JSON.parse(read(PDP0_READINESS_REF));
  const directReview = JSON.parse(read(PDP0_DIRECT_REVIEW_REF));
  const matrix = JSON.parse(read(PDP0_MATRIX_REF));
  const reviewRecords = resolveReviewRecordFiles({read});
  const candidate = buildPdp0CurrentSourceReviewCandidate({status, readiness, directReview, matrix, reviewRecords, read});
  const output = `${JSON.stringify(candidate, null, 2)}\n`;
  const absolutePath = path.resolve(root, outputPath);
  if (check) {
    if (!fs.existsSync(absolutePath) || fs.readFileSync(absolutePath, 'utf8') !== output) throw new Error(`PDP-0 source review candidate is stale: ${path.relative(root, absolutePath)}`);
  } else {
    fs.mkdirSync(path.dirname(absolutePath), {recursive: true});
    fs.writeFileSync(absolutePath, output);
  }
  return candidate;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const check = process.argv.includes('--check');
    const output = process.argv.find(value => value.startsWith('--output='))?.slice('--output='.length);
    assembleMediaPdp0CurrentSourceReview({check, ...(output ? {outputPath: output} : {})});
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
