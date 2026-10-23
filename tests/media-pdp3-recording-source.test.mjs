import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildMediaPdp3RecordingSource, buildMediaPdp3RecordingSourceV2 } from '../scripts/generate-media-pdp3-recording-source.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const digest = (file) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex')}`;
const sourceSnapshotFingerprint = 'sha256:13d2a1899893a0581dffaf0ae82d3db7b1982d93ebd55171f638ebb2e98cc32a';
function makeReadbackPath(overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-pdp3-recording-source-'));
  const readbackPath = path.join(dir, 'g0-status.json');
  const status = {
    schemaVersion: 'ghatana.lifecycle.media-structured-method-status.v1',
    recordKind: 'GTOOL_METHOD_SOURCE_DEVELOPMENT_PROJECTION_NOT_CLOSURE',
    status: 'SOURCE_DEFINITION_DEV_COMPLETE_CURRENT',
    sourceSnapshotFingerprint,
    rows: [{
      subjectId: 'media.surface.explorer', phase: 'PDP-3', completion: 'COMPLETE', currentness: 'CURRENT',
      knownDefinitionTaskCount: 0, sourceDevelopmentReady: true,
    }],
    ...overrides,
  };
  fs.writeFileSync(readbackPath, `${JSON.stringify(status, null, 2)}\n`);
  return { dir, readbackPath, status };
}

test('Media PDP-3 recording source binds the selected current Explorer scenario as simulated candidate only', () => {
  const fixture = makeReadbackPath();
  try {
    const input = buildMediaPdp3RecordingSource({ readbackPath: fixture.readbackPath });
    assert.equal(input.schemaVersion, 'ghatana.pdp3-demo-recording-source.v1');
    assert.equal(input.methodId, 'ghatana.product-development');
    assert.equal(input.subjectId, 'media.surface.explorer');
    assert.equal(input.phaseId, 'PDP-3');
    assert.equal(input.sourceSnapshotFingerprint, sourceSnapshotFingerprint);
    assert.deepEqual(input.expectedScenarioIds, ['media.demo.j03.corrected-captions.v1']);
    assert.equal(input.recordings.length, 1);
    const [recording] = input.recordings;
    assert.equal(recording.status, 'CANDIDATE');
    assert.equal(recording.sourceScenarioRef,
      '.product-experience/pdp-3-product-experience/demo-recording-standard.yaml#scope');
    assert.deepEqual(recording.fixture, {
      datasetRef: 'libs/media-experience-simulation/src/fixtures.ts',
      fingerprint: digest('libs/media-experience-simulation/src/fixtures.ts'),
    });
    assert.equal(recording.storyboardRef, 'docs/implementation/MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json#storyboard');
    assert.deepEqual(recording.narration, {
      scriptRef: 'docs/implementation/MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json#storyboard/scenes',
      scriptFingerprint: digest('docs/implementation/MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json'),
      audioTrackRef: 'docs/implementation/evidence/media-pdp3-demo/j03-explorer-simulated-2026-10-21-r2/media-pdp3-j03-explorer-simulated-2026-10-21-r2.mov#audioTrack',
      captionTrackRef: 'docs/implementation/evidence/media-pdp3-demo/j03-explorer-simulated-2026-10-21-r2/narration-captions.vtt',
    });
    assert.equal('capture' in recording, false, 'no replay and cleanup evidence exists for a current recording row');
    assert.equal('validation' in recording, false, 'no replay result is claimed');
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('Media source input refuses stale or incomplete G0 currentness', () => {
  const fixture = makeReadbackPath();
  fixture.status.rows[0].knownDefinitionTaskCount = 1;
  fs.writeFileSync(fixture.readbackPath, `${JSON.stringify(fixture.status, null, 2)}\n`);
  try {
    assert.throws(() => buildMediaPdp3RecordingSource({ readbackPath: fixture.readbackPath }), /G0_SELECTED_PDP3_SUBJECT_NOT_CURRENT_COMPLETE_ZERO_TASK/u);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('Media v2 source binds the adopted P3-11 criterion to the exact selected scenario roster', () => {
  const fixture = makeReadbackPath();
  try {
    const input = buildMediaPdp3RecordingSourceV2({ readbackPath: fixture.readbackPath });
    assert.equal(input.schemaVersion, 'ghatana.pdp3-demo-recording-source.v2');
    assert.deepEqual(input.ownerCriteriaBinding, {
      selectorShapeRef: 'pdp3-direct-criteria',
      criterionIds: ['P3-11'],
      sourceRef: '.product-experience/pdp-3-product-experience/demo-recording-standard.yaml#acceptance',
      sourceFingerprint: digest('.product-experience/pdp-3-product-experience/demo-recording-standard.yaml'),
      authorityRef: '.product-experience/decision-log.md#PXD-224',
      owner: 'ghatana-media-product-owners',
      scenarioIds: ['media.demo.j03.corrected-captions.v1'],
      criterionEvidenceRef: 'docs/implementation/pdp-3-phase-dev-status.json#/directDevelopmentCriteria/P3-11',
      criterionEvidenceFingerprint: digest('docs/implementation/pdp-3-phase-dev-status.json'),
      criterionEvidenceStatus: 'PASS',
    });
    assert.deepEqual(input.expectedScenarioIds, input.ownerCriteriaBinding.scenarioIds);
    assert.deepEqual(input.recordings, [{
      scenarioId: 'media.demo.j03.corrected-captions.v1',
      status: 'CANDIDATE',
      sourceScenarioRef: '.product-experience/pdp-3-product-experience/demo-recording-standard.yaml#scope',
      sourceFixtureSelection: {
        authorityRef: '.product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml',
        fixtureIds: [
          'media.scenario.first-use-empty', 'media.scenario.upload-verified-available', 'media.scenario.job-running',
          'media.scenario.transcript-ready', 'media.scenario.job-outcome-unknown',
        ],
        codeRef: 'libs/media-experience-simulation/src/fixtures.ts',
        codeFingerprint: digest('libs/media-experience-simulation/src/fixtures.ts'),
      },
      storyboardRef: 'docs/implementation/MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json#storyboard',
      narration: {
        scriptRef: 'docs/implementation/MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json#storyboard/scenes',
        scriptFingerprint: digest('docs/implementation/MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json'),
        audioTrackRef: 'docs/implementation/evidence/media-pdp3-demo/j03-explorer-simulated-2026-10-21-r2/media-pdp3-j03-explorer-simulated-2026-10-21-r2.mov#audioTrack',
        captionTrackRef: 'docs/implementation/evidence/media-pdp3-demo/j03-explorer-simulated-2026-10-21-r2/narration-captions.vtt',
      },
      captureBoundary: {
        selectedCaptureTruthLabel: 'EXPLORER_SIMULATED',
        productExecutionTruthLabel: 'PRODUCT_EXECUTED',
        productExecutionStatus: 'NOT_RECORDED',
      },
      capture: { status: 'NOT_CAPTURED' },
    }]);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
  }
});

test('Media v2 source refuses criterion evidence that is missing or no longer PASS', () => {
  const fixture = makeReadbackPath();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-pdp3-criterion-status-'));
  const statusPath = path.join(dir, 'pdp-3-phase-dev-status.json');
  const status = JSON.parse(fs.readFileSync(path.join(root, 'docs/implementation/pdp-3-phase-dev-status.json'), 'utf8'));
  status.directDevelopmentCriteria['P3-11'].testStatus = 'NOT_RUN';
  fs.writeFileSync(statusPath, `${JSON.stringify(status, null, 2)}\n`);
  try {
    assert.throws(() => buildMediaPdp3RecordingSourceV2({ readbackPath: fixture.readbackPath, phaseStatusPath: statusPath }), /MEDIA_OWNER_SELECTED_CRITERIA_SCENARIO_BINDING_INVALID/u);
  } finally {
    fs.rmSync(fixture.dir, { recursive: true, force: true });
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
