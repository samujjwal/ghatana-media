import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  LANES,
  ROOT,
  SCHEMA_VERSION,
  SCOPE_ID,
  assertBuildOutputDirectory,
  commandFor,
  currentSourceFingerprint,
  sha256,
  validateArtifact,
} from '../scripts/project-timeline-local-evidence.mjs';

const schema = JSON.parse(fs.readFileSync(new URL('../scripts/project-timeline-local-evidence.schema.json', import.meta.url), 'utf8'));
const lane = LANES.timelineUnit;
const outputRoot = path.join(ROOT, 'build/project-timeline-local-evidence-test');
const reportProject = {
  'timeline-unit': 'modules/production/timeline',
  'isolated-store': 'providers/aws-postgresql',
  'dev-only-http': 'launcher',
  'dev-only-restart': 'integration-tests',
};

function makeArtifact(selectedLane = lane) {
  fs.mkdirSync(outputRoot, { recursive: true });
  const artifactDirectory = fs.mkdtempSync(path.join(outputRoot, 'case-'));
  const reportDirectory = path.join(artifactDirectory, reportProject[selectedLane.id], 'build/test-results/test');
  fs.mkdirSync(reportDirectory, { recursive: true });
  const reportPaths = selectedLane.expectedTestClasses.map((className) => {
    const methodCase = selectedLane.expectedTestMethods?.map((method) => `<testcase name="${method}" classname="${className}"/>`).join('') ?? '';
    const report = `<testsuite name="${className}" tests="1" failures="0" errors="0" skipped="0">${methodCase}</testsuite>\n`;
    const reportPath = path.join(reportDirectory, `TEST-${className}.xml`);
    fs.writeFileSync(reportPath, report);
    return { reportPath, report };
  });
  const stdout = Buffer.from('Gradle focused selector completed\n');
  const stderr = Buffer.from('');
  fs.writeFileSync(path.join(artifactDirectory, 'stdout.txt'), stdout);
  fs.writeFileSync(path.join(artifactDirectory, 'stderr.txt'), stderr);
  const fingerprint = currentSourceFingerprint();
  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    authority: 'LOCAL_ENGINEERING_ONLY',
    scopeId: SCOPE_ID,
    createdAt: '2026-11-22T12:00:00.000Z',
    sourceFingerprint: fingerprint,
    sourceFingerprintAfter: fingerprint,
    plan: { requiredLanes: Object.values(LANES).map(({ id }) => id), selectedLanes: [selectedLane.id] },
    toolchain: { javaVersionOutput: 'fixture java', gradleVersionOutput: 'fixture gradle', os: `${os.platform()}-${os.arch()}` },
    runs: [{
      laneId: selectedLane.id,
      storeMode: selectedLane.storeMode,
      command: commandFor(selectedLane),
      exitCode: 0,
      signal: null,
      spawnError: null,
      raw: { stdout: { path: 'stdout.txt', sha256: sha256(stdout) }, stderr: { path: 'stderr.txt', sha256: sha256(stderr) } },
      junit: {
        status: 'PRESENT',
        reports: reportPaths.map(({ reportPath, report }) => ({
          path: path.relative(artifactDirectory, reportPath), sha256: sha256(Buffer.from(report)),
        })),
        tests: reportPaths.length, failures: 0, errors: 0, skipped: 0,
      },
    }],
    localGate: 'NOT_A_CLOSURE_OR_CONVERGENCE_DECISION',
    productionAdmission: 'NOT_ADMITTED',
  };
  const cleanup = () => {
    fs.rmSync(artifactDirectory, { recursive: true, force: true });
    for (const { reportPath } of reportPaths) fs.rmSync(reportPath, { force: true });
  };
  return { artifact, artifactDirectory, reportPaths, cleanup };
}

function withArtifact(assertions, selectedLane = lane) {
  const fixture = makeArtifact(selectedLane);
  try { assertions(fixture); } finally { fixture.cleanup(); }
}

const cases = [
['schema pins local-only authority and forbids production admission claims', () => {
  assert.equal(schema.$id, SCHEMA_VERSION);
  assert.equal(schema.additionalProperties, false);
  assert.equal(schema.properties.authority.const, 'LOCAL_ENGINEERING_ONLY');
  assert.equal(schema.properties.scopeId.const, SCOPE_ID);
  assert.equal(schema.properties.productionAdmission.const, 'NOT_ADMITTED');
  assert.equal(schema.properties.localGate.const, 'NOT_A_CLOSURE_OR_CONVERGENCE_DECISION');
  assert.ok(schema.required.includes('sourceFingerprintAfter'));
  assert.ok(schema.properties.runs.items.required.includes('spawnError'));
  assert.throws(() => assertBuildOutputDirectory(os.tmpdir()), /under repository build/);
  assert.deepEqual(LANES.devOnlyRestart.expectedTestMethods, [
    'realExplorerBrowserCreatesReplaysAndReopensExactTimelineAcrossLauncherRestart',
  ]);
}],

['exact source, command, raw streams and JUnit report validate as local engineering provenance', () => withArtifact(({ artifact, artifactDirectory }) => {
  assert.deepEqual(validateArtifact(artifact, artifactDirectory, artifactDirectory, ROOT), { valid: true, errors: [] });
})],

['method-level lane requires the exact selected restart test and rejects extra or wrong cases', () => withArtifact(({ artifact, artifactDirectory, reportPaths }) => {
  assert.deepEqual(validateArtifact(artifact, artifactDirectory, artifactDirectory, ROOT), { valid: true, errors: [] });
  const reportPath = reportPaths[0].reportPath;
  const wrongMethod = '<testsuite name="com.ghatana.media.integration.MediaDevProjectTimelineRestartIT" tests="1" failures="0" errors="0" skipped="0"><testcase name="otherRestartTest" classname="com.ghatana.media.integration.MediaDevProjectTimelineRestartIT"/></testsuite>\n';
  fs.writeFileSync(reportPath, wrongMethod);
  artifact.runs[0].junit.reports[0].sha256 = sha256(Buffer.from(wrongMethod));
  assert.ok(validateArtifact(artifact, artifactDirectory, artifactDirectory, ROOT).errors.some((error) => error.includes('JUnit methods differ')));
}, LANES.devOnlyRestart)],

['stale source, altered Gradle selector and attempted production admission fail closed', () => withArtifact(({ artifact, artifactDirectory }) => {
  const stale = structuredClone(artifact);
  stale.sourceFingerprint.digest = '0'.repeat(64);
  assert.ok(validateArtifact(stale, artifactDirectory, artifactDirectory, ROOT).errors.some((error) => error.includes('stale')));

  const wrongSelector = structuredClone(artifact);
  wrongSelector.runs[0].command.args.push('--tests', '*OtherTest');
  assert.ok(validateArtifact(wrongSelector, artifactDirectory, artifactDirectory, ROOT).errors.some((error) => error.includes('command/filter mismatch')));

  const productionClaim = structuredClone(artifact);
  productionClaim.productionAdmission = 'ADMITTED';
  assert.ok(validateArtifact(productionClaim, artifactDirectory, artifactDirectory, ROOT).errors.some((error) => error.includes('NOT_ADMITTED')));
})],

['modified raw output, wrong-scope reports, and skipped or failed tests fail closed', () => withArtifact(({ artifact, artifactDirectory, reportPaths }) => {
  fs.appendFileSync(path.join(artifactDirectory, 'stdout.txt'), 'tampered\n');
  assert.ok(validateArtifact(artifact, artifactDirectory, artifactDirectory, ROOT).errors.some((error) => error.includes('stdout digest mismatch')));

  const wrongReport = structuredClone(artifact);
  wrongReport.runs[0].junit.reports[0].path = 'launcher/build/test-results/test/TEST-wrong.xml';
  assert.ok(validateArtifact(wrongReport, artifactDirectory, artifactDirectory, ROOT).errors.some((error) => error.includes('wrong-scope JUnit')));

  const failed = structuredClone(artifact);
  failed.runs[0].junit.failures = 1;
  const failedReport = '<testsuite name="com.ghatana.media.production.timeline.ProjectTimelineRevisionModelTest" tests="1" failures="1" errors="0" skipped="0"></testsuite>\n';
  fs.writeFileSync(reportPaths[0].reportPath, failedReport);
  failed.runs[0].junit.reports[0].sha256 = sha256(fs.readFileSync(reportPaths[0].reportPath));
  assert.ok(validateArtifact(failed, artifactDirectory, artifactDirectory, ROOT).errors.some((error) => error.includes('failed, or skipped')));
})],
];

for (const [name, run] of cases) {
  run();
  process.stdout.write(`PASS ${name}\n`);
}
