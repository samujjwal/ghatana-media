#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRef = 'docs/implementation/evidence/media-pdp3-demo/pdp3-demo-recording-source.v1.json';
const outputRefV2 = 'docs/implementation/evidence/media-pdp3-demo/pdp3-demo-recording-source.v2.json';
const standardRef = '.product-experience/pdp-3-product-experience/demo-recording-standard.yaml';
const phaseStatusRef = 'docs/implementation/pdp-3-phase-dev-status.json';
const profileRef = 'docs/implementation/MEDIA-EARLY-BUSINESS-DEMO-RECORDING.v1.json';
const expectedMethodId = 'ghatana.product-development';
const expectedSubjectId = 'media.surface.explorer';
const pdp3CriteriaSelectorShapeRef = 'pdp3-direct-criteria';
const sha256 = (value) => `sha256:${crypto.createHash('sha256').update(value).digest('hex')}`;
const require = createRequire(path.join(root, 'package.json'));
const parseYaml = require('yaml').parse;

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function argument(name) {
  const index = process.argv.indexOf(name);
  return index < 0 ? null : process.argv[index + 1] ?? null;
}

function readJson(ref) {
  return JSON.parse(fs.readFileSync(path.join(root, ref), 'utf8'));
}

function sourceSnapshotFingerprint(readbackPath) {
  if (!readbackPath) throw new Error('G0_STATUS_INPUT_REQUIRED: pass --g0-status <fresh Lifecycle MEDIA_PHASE_STATUS_IO JSON>');
  const status = JSON.parse(fs.readFileSync(path.resolve(readbackPath), 'utf8'));
  if (status.schemaVersion !== 'ghatana.lifecycle.media-structured-method-status.v1'
      || status.recordKind !== 'GTOOL_METHOD_SOURCE_DEVELOPMENT_PROJECTION_NOT_CLOSURE'
      || status.status !== 'SOURCE_DEFINITION_DEV_COMPLETE_CURRENT') {
    throw new Error('G0_STATUS_NOT_SOURCE_CURRENT');
  }
  const subject = status.rows?.find((row) => row.subjectId === expectedSubjectId && row.phase === 'PDP-3');
  if (!subject || subject.completion !== 'COMPLETE' || subject.currentness !== 'CURRENT'
      || subject.knownDefinitionTaskCount !== 0 || subject.sourceDevelopmentReady !== true) {
    throw new Error('G0_SELECTED_PDP3_SUBJECT_NOT_CURRENT_COMPLETE_ZERO_TASK');
  }
  if (!/^sha256:[a-f0-9]{64}$/u.test(status.sourceSnapshotFingerprint ?? '')) {
    throw new Error('G0_SOURCE_SNAPSHOT_FINGERPRINT_MISSING');
  }
  return status.sourceSnapshotFingerprint;
}

export function buildMediaPdp3RecordingSource({ readbackPath }) {
  const sourceFingerprint = sourceSnapshotFingerprint(readbackPath);
  const standard = parseYaml(fs.readFileSync(path.join(root, standardRef), 'utf8'));
  const profile = readJson(profileRef);
  const explorer = standard.captures?.explorer;
  const profileExplorer = profile.recordingEvidence?.explorer;
  const scenarioId = standard.scope?.scenarioId;
  if (standard.standardId !== 'media.pdp3.demo-recording.v1'
      || standard.scope?.edition !== 'media-pdp3-demo-v1'
      || !scenarioId || explorer?.truthLabel !== 'EXPLORER_SIMULATED'
      || explorer?.status !== 'RECORDED_SIMULATED_CONTENT_REVIEWED; FILM_APPROVAL_NOT_CLAIMED'
      || profileExplorer?.status !== 'RECORDED_SIMULATED_CONTENT_REVIEWED; FILM_APPROVAL_NOT_CLAIMED'
      || profile.recordingEvidence?.build?.status !== 'NOT_RECORDED'
      || profile.recordingEvidence?.semanticEquivalence?.status !== 'NOT_VERIFIED') {
    throw new Error('MEDIA_SELECTED_J03_SIMULATED_SOURCE_NOT_IN_EXPECTED_STATE');
  }
  if (profileExplorer.manifest !== explorer.manifestRef
      || profileExplorer.video !== explorer.videoRef
      || profileExplorer.captions !== explorer.captionRef) {
    throw new Error('MEDIA_EXPLORER_EVIDENCE_REFS_DISAGREE');
  }

  const fixtureRef = 'libs/media-experience-simulation/src/fixtures.ts';
  const fixtureDigest = sha256(fs.readFileSync(path.join(root, fixtureRef)));
  const profileDigest = sha256(fs.readFileSync(path.join(root, profileRef)));
  const selectedScenarioRef = `${standardRef}#scope`;
  return {
    schemaVersion: 'ghatana.pdp3-demo-recording-source.v1',
    methodId: expectedMethodId,
    subjectId: expectedSubjectId,
    phaseId: 'PDP-3',
    sourceSnapshotFingerprint: sourceFingerprint,
    expectedScenarioIds: [scenarioId],
    recordings: [{
      scenarioId,
      // This is a candidate for the new OOB source binding. The existing r2
      // Explorer capture is simulated evidence; no replay/cleanup result is
      // supplied, so it cannot be promoted to RECORDED_CURRENT here.
      status: 'CANDIDATE',
      sourceScenarioRef: selectedScenarioRef,
      fixture: { datasetRef: fixtureRef, fingerprint: fixtureDigest },
      storyboardRef: `${profileRef}#storyboard`,
      narration: {
        scriptRef: `${profileRef}#storyboard/scenes`,
        scriptFingerprint: profileDigest,
        audioTrackRef: `${explorer.videoRef}#audioTrack`,
        captionTrackRef: explorer.captionRef,
      },
    }],
  };
}

/**
 * Bind the Media owner's versioned demo selection to the opt-in generic PDP-3
 * v2 input. This is source-selection plumbing only; the single recording stays
 * a candidate until current replay and cleanup evidence exists.
 */
export function buildMediaPdp3RecordingSourceV2({ readbackPath, phaseStatusPath = path.join(root, phaseStatusRef) }) {
  const sourceV1 = buildMediaPdp3RecordingSource({ readbackPath });
  const standardBytes = fs.readFileSync(path.join(root, standardRef));
  const standard = parseYaml(standardBytes.toString('utf8'));
  const scenarioId = standard.scope?.scenarioId;
  const criterionId = standard.acceptance?.criterionId;
  const decisionRef = standard.authority?.ownerDecisionRef;
  const owner = standard.authority?.evidenceOwner;
  const phaseStatusBytes = fs.readFileSync(phaseStatusPath);
  const phaseStatus = JSON.parse(phaseStatusBytes.toString('utf8'));
  const selectedCriterionEvidence = phaseStatus.directDevelopmentCriteria?.[criterionId];
  if (standard.status !== 'MEDIA_OWNER_ADOPTED_VERSIONED_DEMO_SCOPE; CROSS_REPOSITORY_KERNEL_TOOLS_LIFECYCLE_ADMISSION_PENDING'
      || standard.scope?.edition !== 'media-pdp3-demo-v1'
      || !scenarioId || !criterionId || !decisionRef || !owner
      || phaseStatus.status !== 'DEV_COMPLETE' || selectedCriterionEvidence?.testStatus !== 'PASS'
      || sourceV1.expectedScenarioIds.length !== 1 || sourceV1.expectedScenarioIds[0] !== scenarioId) {
    throw new Error('MEDIA_OWNER_SELECTED_CRITERIA_SCENARIO_BINDING_INVALID');
  }
  const explorer = standard.captures?.explorer;
  const build = standard.captures?.build;
  const sourceFixtureSelection = standard.scope?.fixtureIds;
  if (!Array.isArray(sourceFixtureSelection) || sourceFixtureSelection.length === 0
      || new Set(sourceFixtureSelection).size !== sourceFixtureSelection.length
      || !standard.scope?.staticFixtureAuthority || explorer?.truthLabel !== 'EXPLORER_SIMULATED'
      || build?.truthLabel !== 'PRODUCT_EXECUTED' || build?.status !== 'NOT_RECORDED') {
    throw new Error('MEDIA_SELECTED_FIXTURE_OR_EXECUTION_BOUNDARY_INVALID');
  }
  const sourceV1Recording = sourceV1.recordings[0];
  return {
    schemaVersion: 'ghatana.pdp3-demo-recording-source.v2',
    methodId: sourceV1.methodId,
    subjectId: sourceV1.subjectId,
    phaseId: sourceV1.phaseId,
    sourceSnapshotFingerprint: sourceV1.sourceSnapshotFingerprint,
    ownerCriteriaBinding: {
      selectorShapeRef: pdp3CriteriaSelectorShapeRef,
      criterionIds: [criterionId],
      sourceRef: `${standardRef}#acceptance`,
      sourceFingerprint: sha256(standardBytes),
      authorityRef: decisionRef,
      owner,
      scenarioIds: [scenarioId],
      criterionEvidenceRef: `${phaseStatusRef}#/directDevelopmentCriteria/${criterionId}`,
      criterionEvidenceFingerprint: sha256(phaseStatusBytes),
      criterionEvidenceStatus: 'PASS',
    },
    expectedScenarioIds: [scenarioId],
    recordings: sourceV1.recordings.map(({ scenarioId: selectedScenarioId, status }) => ({
      scenarioId: selectedScenarioId,
      status,
      sourceScenarioRef: `${standardRef}#scope`,
      sourceFixtureSelection: {
        authorityRef: standard.scope.staticFixtureAuthority,
        fixtureIds: [...sourceFixtureSelection],
        codeRef: sourceV1Recording.fixture.datasetRef,
        codeFingerprint: sourceV1Recording.fixture.fingerprint,
      },
      storyboardRef: sourceV1Recording.storyboardRef,
      narration: { ...sourceV1Recording.narration },
      captureBoundary: {
        selectedCaptureTruthLabel: explorer.truthLabel,
        productExecutionTruthLabel: build.truthLabel,
        productExecutionStatus: build.status,
      },
      capture: { status: 'NOT_CAPTURED' },
    })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const v2 = process.argv.includes('--v2');
    const result = v2
      ? buildMediaPdp3RecordingSourceV2({ readbackPath: argument('--g0-status') })
      : buildMediaPdp3RecordingSource({ readbackPath: argument('--g0-status') });
    const rendered = `${JSON.stringify(result, null, 2)}\n`;
    const selectedOutputRef = v2 ? outputRefV2 : outputRef;
    const outputPath = path.join(root, selectedOutputRef);
    if (process.argv.includes('--check')) {
      if (!fs.existsSync(outputPath) || fs.readFileSync(outputPath, 'utf8') !== rendered) {
        fail(`PDP-3 recording source drift: ${selectedOutputRef}`);
      } else {
        process.stdout.write(`PDP-3 v${v2 ? '2' : '1'} recording source is current: ${result.expectedScenarioIds.length} selected scenario; simulated candidate only.\n`);
      }
    } else {
      fs.mkdirSync(path.dirname(outputPath), { recursive: true });
      fs.writeFileSync(outputPath, rendered);
      process.stdout.write(`Wrote ${selectedOutputRef}: candidate source binding only; no replay, cleanup, live effect, qualification, or owner review claimed.\n`);
    }
  } catch (error) {
    fail(error.message);
  }
}
