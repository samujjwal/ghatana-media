import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {
  writePdp0DevStatus,
  writePdp1DevStatus,
  writePdp2DevStatus,
  writePdp3DevStatus,
} from '../scripts/report-media-pdp-readiness.mjs';

const phaseWriters = [
  {phase: 'PDP-0', write: writePdp0DevStatus, statusPath: 'docs/implementation/pdp-0-phase-dev-status.json'},
  {phase: 'PDP-1', write: writePdp1DevStatus, statusPath: 'docs/implementation/pdp-1-phase-dev-status.json'},
  {phase: 'PDP-2', write: writePdp2DevStatus, statusPath: 'docs/implementation/pdp-2-phase-dev-status.json'},
  {phase: 'PDP-3', write: writePdp3DevStatus, statusPath: 'docs/implementation/pdp-3-phase-dev-status.json'},
];

test('partial PDP phase verification with --write fails before changing any phase status record', () => {
  const statusRecords = phaseWriters.map(({statusPath}) => ({statusPath, before: fs.readFileSync(statusPath)}));
  const criterion = {'PDP-0': 'P0-01', 'PDP-1': 'P1-01', 'PDP-2': 'P2-01', 'PDP-3': 'P3-01'};
  for (const {phase} of phaseWriters) {
    const result = spawnSync(process.execPath, ['scripts/report-media-pdp-readiness.mjs', '--verify', `--phase-dev-status=${phase}`, `--verify-tasks=${criterion[phase]}`, '--write'], {
      cwd: process.cwd(), encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
    });
    assert.equal(result.status, 1, `${phase}: ${result.stderr || result.stdout}`);
    assert.match(result.stderr, /full-suite verification; subset verification cannot persist phase status/u, phase);
    for (const {statusPath, before} of statusRecords) {
      assert.deepEqual(fs.readFileSync(statusPath), before, `${phase} subset write rejection leaves ${statusPath} byte-for-byte unchanged`);
    }
  }
});

test('all PDP phase writers block unsupported downgrades and accept changed material pins', () => {
  for (const {phase, write, statusPath: relativeStatusPath} of phaseWriters) {
    const repositoryRoot = fs.mkdtempSync(path.join(os.tmpdir(), `media-${phase.toLowerCase()}-status-`));
    const statusPath = path.join(repositoryRoot, relativeStatusPath);
    const sourceShaSet = {'owner.yaml': 'a'.repeat(64), 'domain.yaml': 'b'.repeat(64)};
    const complete = {phase, status: 'DEV_COMPLETE', sourceShaSet};
    try {
      fs.mkdirSync(path.dirname(statusPath), {recursive: true});
      fs.writeFileSync(statusPath, JSON.stringify(complete));
      assert.throws(() => write({...complete, status: 'IN_PROGRESS', sourceShaSet: {...sourceShaSet}}, repositoryRoot),
        /Refusing to downgrade .*DEV_COMPLETE status while sourceShaSet is unchanged/u, `${phase} rejects same-pin downgrade`);
      assert.throws(() => write({...complete, status: 'IN_PROGRESS', sourceShaSet: {}}, repositoryRoot),
        /without valid nonempty sourceShaSet pins/u, `${phase} rejects empty new pins`);
      const {sourceShaSet: omittedPins, ...withoutPins} = complete;
      assert.equal(omittedPins, sourceShaSet);
      assert.throws(() => write({...withoutPins, status: 'IN_PROGRESS'}, repositoryRoot),
        /without valid nonempty sourceShaSet pins/u, `${phase} rejects missing new pins`);
      assert.deepEqual(JSON.parse(fs.readFileSync(statusPath, 'utf8')), complete, `${phase} rejected writes leave status unchanged`);

      const reopened = {...complete, status: 'IN_PROGRESS', sourceShaSet: {...sourceShaSet, 'domain.yaml': 'c'.repeat(64)}};
      assert.equal(write(reopened, repositoryRoot), statusPath);
      assert.deepEqual(JSON.parse(fs.readFileSync(statusPath, 'utf8')), reopened, `${phase} allows reopening after a valid material pin change`);
    } finally {
      fs.rmSync(repositoryRoot, {recursive: true, force: true});
    }
  }
});
