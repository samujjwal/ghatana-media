import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';

const root = process.cwd();
const dir = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates';
const packetRef = path.join(root, dir, 'media-pdp0-root-selected-source-integration-r9-r07.guarded-application-packet.v1.json');
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');

test('guarded R9-R07 application packet is deterministic and authority-blocked', () => {
  const run = spawnSync(process.execPath, ['scripts/prepare-media-pdp0-root-selected-source-integration-r9-r07-guarded-application-packet.mjs', '--check'], { cwd: root, encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr || run.stdout);
  const packet = JSON.parse(fs.readFileSync(packetRef, 'utf8'));
  assert.equal(packet.packetStatus, 'PREPARED_READ_ONLY_BLOCKED_AWAITING_AUTHORITY_INPUTS');
  assert.equal(packet.candidate.actualHReviewStatus, 'PASS');
  assert.equal(packet.sourceReadSet.count, 7);
  assert.equal(packet.sourceReadSet.allSevenLivePreimagesMatch, true);
  assert.equal(packet.selectedTargets.length, 4);
  assert.equal(packet.selectedTargets.every((x) => x.postimageHashMatches), true);
  assert.equal(packet.readOnlyPreimages.length, 3);
  assert.equal(packet.blockers.length, 4);
  assert.equal(packet.effectBoundary.canonicalApply, 'NONE');
  assert.equal(packet.effectBoundary.phaseStatusEffect, 'NONE');
  assert.equal(packet.campaignDenominator.registeredIdentities, 54);
  assert.equal(packet.campaignDenominator.phaseCells, 216);
  assert.equal(packet.campaignDenominator.historicalOwnerRows, 462);
  assert.equal(sha(fs.readFileSync(path.join(root, 'docs/implementation/pdp-0-phase-dev-status.json'))), packet.phase.liveStatusSha256);
});
