#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {prepareMediaPdp0SourceAmendmentCas} from './plan-media-pdp0-source-amendment-cas.mjs';
import {applyPdp0SourceAmendment} from './lib/media-pdp0-source-amendment-apply.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const authorizationRef = 'docs/implementation/observations/pdp0-semantic-audit-slices/AUD-SPEC-002-source-amendment-apply-authorization.v1.json';

export function applyMediaPdp0SourceAmendment() {
  const prepared = prepareMediaPdp0SourceAmendmentCas();
  const authorization = JSON.parse(fs.readFileSync(path.resolve(root, authorizationRef), 'utf8'));
  return applyPdp0SourceAmendment({root, authorization, ...prepared});
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    if (!process.argv.includes('--apply')) throw new Error('no canonical effect is performed without explicit --apply');
    console.log(JSON.stringify(applyMediaPdp0SourceAmendment(), null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
