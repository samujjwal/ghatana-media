#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath, pathToFileURL} from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputDir = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const frozen = new Map([
  [`${outputDir}/AUD-SPEC-002-source-amendment-candidate.v2.json`, 'ab9c5455c50df60c33066b0253f996f67885f78429047a6afa995e845b65d867'],
  [`${outputDir}/AUD-SPEC-002-source-amendment-postimage.v2.json`, '7aa677ad4907818d0ca2ea140ab285de39298ba116de9704ce51f91e1781b2f0'],
  [`${outputDir}/AUD-SPEC-002-crosswalk-postimage.v2.json`, 'cbdf13712ea57f11b1efa98c9932141a89e7f26cdc4a121ec124e464ddd2cc35'],
]);
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function planMediaPdp0AudSpec002Rebind({check = false} = {}) {
  if (!check) throw new Error('AUD-SPEC-002 v2 outputs are frozen; use the additive v3 source-amendment producer');
  for (const [ref, expected] of frozen) {
    const file = path.join(root, ref);
    if (!fs.existsSync(file) || sha256(fs.readFileSync(file)) !== expected) {
      throw new Error(`frozen AUD-SPEC-002 v2 bytes are unavailable or differ from their peer-reviewed pins: ${ref}`);
    }
  }
  return {schemaVersion: 'media.pdp0.aud-spec-002-frozen-v2-check.v1', status: 'FROZEN_V2_BYTES_MATCH_PEER_REVIEW'};
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const result = planMediaPdp0AudSpec002Rebind({check: process.argv.includes('--check')});
    process.stdout.write(`${result.status}\n`);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
