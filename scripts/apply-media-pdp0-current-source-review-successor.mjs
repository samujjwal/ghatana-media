#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {applyPdp0ReviewSuccessorPostimage} from './lib/media-pdp0-review-successor-plan.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authorizationRef = 'docs/implementation/observations/media-pdp0-current-source-reviews-2026-10-23/apply-authorization.v3.json';

export function applyMediaPdp0CurrentSourceReviewSuccessor({fsOps = fs} = {}) {
  const authorization = JSON.parse(fsOps.readFileSync(path.resolve(root, authorizationRef), 'utf8'));
  return applyPdp0ReviewSuccessorPostimage({root, authorization, fsOps});
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv.includes('--apply')) throw new Error('no effect is performed without the explicit --apply flag');
    const result = applyMediaPdp0CurrentSourceReviewSuccessor();
    console.log(JSON.stringify(result, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
