#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const SCOPE_ID = 'EG-TIMELINE-001';
export const SCHEMA_VERSION = 'media.timeline-engine.local-engineering-evidence.v1';

const sourceFiles = [
  'modules/production/timeline/README.md',
  'modules/production/timeline/build.gradle.kts',
  'settings.gradle.kts',
  'build.gradle.kts',
  'gradle/libs.versions.toml',
  'runtime-contracts/build.gradle.kts',
  'providers/aws-postgresql/build.gradle.kts',
  'launcher/build.gradle.kts',
  'integration-tests/build.gradle.kts',
  'scripts/project-timeline-local-evidence.schema.json',
  'scripts/project-timeline-local-evidence.mjs',
  'tests/project-timeline-local-evidence.test.mjs',
  ...walk('modules/production/timeline/src'),
  'runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaProjectTimelineContracts.java',
  'runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaDevProjectTimelineStoreFactory.java',
  'runtime-contracts/src/main/java/com/ghatana/media/runtime/ManagedProjectTimelineStore.java',
  'providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlProjectTimelineStore.java',
  'providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlDevProjectTimelinePersistenceState.java',
  'providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/ProjectTimelinePersistenceState.java',
  'providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/PostgresqlDevProjectTimelineStoreFactory.java',
  'providers/aws-postgresql/src/main/resources/META-INF/services/com.ghatana.media.runtime.MediaDevProjectTimelineStoreFactory',
  'providers/aws-postgresql/src/test/java/com/ghatana/media/provider/aws/PostgresqlProjectTimelineStoreTest.java',
  'providers/aws-postgresql/src/test/java/com/ghatana/media/provider/aws/PostgresqlDevProjectTimelineStoreFactoryTest.java',
  'providers/aws-postgresql/src/test/resources/db/media-project-timeline/V030__media_project_timeline.sql',
  'providers/aws-postgresql/src/test/resources/db/media-project-timeline/V043__timeline_mutation_idempotency.sql',
  'launcher/src/main/java/com/ghatana/media/launcher/MediaDevProjectTimelineRuntime.java',
  'launcher/src/test/java/com/ghatana/media/launcher/MediaDevProjectTimelineHttpTest.java',
  'integration-tests/src/test/java/com/ghatana/media/integration/MediaDevProjectTimelineRestartIT.java',
  '.product-experience/pdp-1-domain-data/domain-objects.yaml',
  '.product-experience/pdp-1-domain-data/relationships.yaml',
  'docs/development/PROJECT-TIMELINE-MAPPING-DISPOSITION-2026-11-09.md',
];

function walk(relative) {
  const directory = path.join(ROOT, relative);
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const child = `${relative}/${entry.name}`;
    return entry.isDirectory() ? walk(child) : [child];
  }).sort();
}

const compositeArgs = ['-Pghatana.media.dependencyProfile=DEV_SOURCE_COMPOSITE', '-Pghatana.media.compositeScope=FULL'];
export const LANES = Object.freeze({
  timelineUnit: {
    id: 'timeline-unit',
    storeMode: 'IN_MEMORY_UNIT_TEST',
    task: ':services:media:modules:production:timeline:test',
    filters: ['com.ghatana.media.production.timeline.ProjectTimelineRevisionModelTest', 'com.ghatana.media.production.timeline.ProjectTimelineEngineTest'],
    expectedTestClasses: ['com.ghatana.media.production.timeline.ProjectTimelineRevisionModelTest', 'com.ghatana.media.production.timeline.ProjectTimelineEngineTest'],
  },
  isolatedStore: {
    id: 'isolated-store',
    storeMode: 'DEV_ONLY_ISOLATED_POSTGRESQL_STORE_TEST',
    task: ':services:media:providers:aws-postgresql:test',
    filters: ['*PostgresqlProjectTimelineStoreTest', '*PostgresqlDevProjectTimelineStoreFactoryTest'],
    expectedTestClasses: ['com.ghatana.media.provider.aws.PostgresqlProjectTimelineStoreTest', 'com.ghatana.media.provider.aws.PostgresqlDevProjectTimelineStoreFactoryTest'],
  },
  devOnlyHttp: {
    id: 'dev-only-http',
    storeMode: 'DEV_ONLY_LOOPBACK_HOST',
    task: ':services:media:launcher:test',
    filters: ['*MediaDevProjectTimelineHttpTest'],
    expectedTestClasses: ['com.ghatana.media.launcher.MediaDevProjectTimelineHttpTest'],
  },
  devOnlyRestart: {
    id: 'dev-only-restart',
    storeMode: 'DEV_ONLY_ISOLATED_POSTGRESQL_RESTART',
    task: ':services:media:integration-tests:test',
    filters: ['com.ghatana.media.integration.MediaDevProjectTimelineRestartIT.realExplorerBrowserCreatesReplaysAndReopensExactTimelineAcrossLauncherRestart'],
    expectedTestClasses: ['com.ghatana.media.integration.MediaDevProjectTimelineRestartIT'],
    expectedTestMethods: ['realExplorerBrowserCreatesReplaysAndReopensExactTimelineAcrossLauncherRestart'],
  },
});

export function sha256(bytes) { return crypto.createHash('sha256').update(bytes).digest('hex'); }

export function currentSourceFingerprint(root = ROOT) {
  const files = [...new Set(sourceFiles)].sort().map((relativePath) => {
    const absolute = path.join(root, relativePath);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) throw new Error(`Missing required scope input: ${relativePath}`);
    return { path: relativePath, sha256: sha256(fs.readFileSync(absolute)) };
  });
  const material = files.map(({ path: file, sha256: digest }) => `${file}\0${digest}\n`).join('');
  return { algorithm: 'SHA-256', digest: sha256(material), files };
}

function toolchain() {
  const java = spawnSync('java', ['-version'], { cwd: ROOT, encoding: 'utf8' });
  const gradle = spawnSync('./gradlew', ['--version'], { cwd: ROOT, encoding: 'utf8' });
  return {
    javaVersionOutput: `${java.stdout ?? ''}${java.stderr ?? ''}`.trim(),
    gradleVersionOutput: `${gradle.stdout ?? ''}${gradle.stderr ?? ''}`.trim(),
    os: `${os.platform()}-${os.arch()}`,
  };
}

export function commandFor(lane) {
  const args = [...compositeArgs, lane.task, ...lane.filters.flatMap((filter) => ['--tests', filter])];
  return { executable: './gradlew', args };
}

export function assertBuildOutputDirectory(directory) {
  const absolute = path.resolve(directory);
  const buildRoot = path.join(ROOT, 'build');
  if (absolute !== buildRoot && !absolute.startsWith(`${buildRoot}${path.sep}`)) {
    throw new Error('Output directory must stay under repository build/');
  }
  fs.mkdirSync(buildRoot, { recursive: true });
  const repoReal = fs.realpathSync(ROOT);
  const buildReal = fs.realpathSync(buildRoot);
  if (!buildReal.startsWith(`${repoReal}${path.sep}`)) throw new Error('Repository build/ resolves outside the checkout');
  let existing = absolute;
  while (!fs.existsSync(existing) && existing !== path.dirname(existing)) existing = path.dirname(existing);
  const existingReal = fs.realpathSync(existing);
  if (existingReal !== buildReal && !existingReal.startsWith(`${buildReal}${path.sep}`)) throw new Error('Output directory resolves outside repository build/');
  return absolute;
}

function resolvesWithin(base, target) {
  try {
    const realBase = fs.realpathSync(base);
    const realTarget = fs.realpathSync(target);
    return realTarget.startsWith(`${realBase}${path.sep}`);
  } catch { return false; }
}

function junitSummary(projectPath) {
  const resultDir = path.join(ROOT, projectPath, 'build/test-results/test');
  if (!fs.existsSync(resultDir)) return { status: 'MISSING', reports: [], tests: 0, failures: 0, errors: 0, skipped: 0 };
  const files = fs.readdirSync(resultDir).filter((name) => /^TEST-.*\.xml$/.test(name)).sort();
  const counts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
  for (const file of files) {
    const xml = fs.readFileSync(path.join(resultDir, file), 'utf8');
    const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
    for (const key of Object.keys(counts)) counts[key] += Number(suite.match(new RegExp(`\\b${key}="(\\d+)"`))?.[1] ?? 0);
  }
  const reports = files.map((name) => {
    const relativePath = `${projectPath}/build/test-results/test/${name}`;
    return { path: relativePath, sha256: sha256(fs.readFileSync(path.join(ROOT, relativePath))) };
  });
  return { status: files.length ? 'PRESENT' : 'MISSING', reports, ...counts };
}

const TEST_REPORT_DIRS = {
  'timeline-unit': 'modules/production/timeline',
  'isolated-store': 'providers/aws-postgresql',
  'dev-only-http': 'launcher',
  'dev-only-restart': 'integration-tests',
};

export function validateArtifact(artifact, artifactDirectory, root = ROOT, sourceRoot = ROOT) {
  const errors = [];
  const exactKeys = (value, expected, label) => {
    if (!value || typeof value !== 'object' || Array.isArray(value) || expected.some((key) => !Object.hasOwn(value, key)) || Object.keys(value).some((key) => !expected.includes(key))) errors.push(`${label} does not match schema`);
  };
  if (!artifact || artifact.schemaVersion !== SCHEMA_VERSION) errors.push('schema version mismatch');
  if (artifact?.authority !== 'LOCAL_ENGINEERING_ONLY') errors.push('artifact must be marked LOCAL_ENGINEERING_ONLY');
  if (artifact?.scopeId !== SCOPE_ID) errors.push('wrong scope id');
  if (artifact?.localGate !== 'NOT_A_CLOSURE_OR_CONVERGENCE_DECISION') errors.push('local gate cannot represent closure or convergence');
  if (artifact?.productionAdmission !== 'NOT_ADMITTED') errors.push('production admission must remain NOT_ADMITTED');
  if (typeof artifact?.createdAt !== 'string' || Number.isNaN(Date.parse(artifact.createdAt))) errors.push('invalid creation timestamp');
  exactKeys(artifact?.plan, ['requiredLanes', 'selectedLanes'], 'plan');
  exactKeys(artifact?.toolchain, ['javaVersionOutput', 'gradleVersionOutput', 'os'], 'toolchain');
  if (artifact?.validation !== undefined) {
    exactKeys(artifact.validation, ['valid', 'errors'], 'validation');
    if (typeof artifact.validation.valid !== 'boolean' || !Array.isArray(artifact.validation.errors) || artifact.validation.errors.some((entry) => typeof entry !== 'string')) errors.push('validation does not match schema');
  }
  if (typeof artifact?.toolchain?.javaVersionOutput !== 'string' || typeof artifact?.toolchain?.gradleVersionOutput !== 'string' || typeof artifact?.toolchain?.os !== 'string') errors.push('toolchain identity is incomplete');
  try {
    if (JSON.stringify(artifact?.sourceFingerprint) !== JSON.stringify(currentSourceFingerprint(sourceRoot))) errors.push('source fingerprint is stale or wrong-scope');
  } catch { errors.push('required source fingerprint input is missing'); }
  if (JSON.stringify(artifact?.sourceFingerprintAfter) !== JSON.stringify(artifact?.sourceFingerprint)) errors.push('source changed during collection');
  const allowedKeys = ['schemaVersion', 'authority', 'scopeId', 'createdAt', 'sourceFingerprint', 'sourceFingerprintAfter', 'plan', 'toolchain', 'runs', 'localGate', 'productionAdmission', 'validation'];
  if (artifact && Object.keys(artifact).some((key) => !allowedKeys.includes(key))) errors.push('artifact contains an unsupported field');
  const laneIds = Object.values(LANES).map(({ id }) => id);
  if (JSON.stringify(artifact?.plan?.requiredLanes) !== JSON.stringify(laneIds)) errors.push('required lane manifest mismatch');
  if (!Array.isArray(artifact?.plan?.selectedLanes) || artifact.plan.selectedLanes.some((id) => !laneIds.includes(id)) || new Set(artifact.plan.selectedLanes).size !== artifact.plan.selectedLanes.length) errors.push('invalid selected lane manifest');
  if (!Array.isArray(artifact?.runs) || artifact.runs.length === 0) errors.push('no selected test runs');
  if (JSON.stringify(artifact?.runs?.map((run) => run?.laneId ?? null)) !== JSON.stringify(artifact?.plan?.selectedLanes)) errors.push('run list does not match selected lane manifest');
  for (const run of artifact?.runs ?? []) {
    exactKeys(run, ['laneId', 'storeMode', 'command', 'exitCode', 'signal', 'spawnError', 'raw', 'junit'], `run`);
    exactKeys(run?.command, ['executable', 'args'], `command`);
    exactKeys(run?.raw, ['stdout', 'stderr'], `raw streams`);
    exactKeys(run?.junit, ['status', 'reports', 'tests', 'failures', 'errors', 'skipped'], `JUnit summary`);
    if (!run || typeof run !== 'object') continue;
    const lane = Object.values(LANES).find(({ id }) => id === run.laneId);
    if (!lane) { errors.push(`unknown lane: ${run.laneId}`); continue; }
    if (run.storeMode !== lane.storeMode) errors.push(`store mode mismatch for ${run.laneId}`);
    if (run.spawnError !== null && run.spawnError !== undefined) exactKeys(run.spawnError, ['name', 'message', 'code', 'errno', 'syscall'], `spawn error`);
    if (run.command?.executable !== './gradlew' || JSON.stringify(run.command.args) !== JSON.stringify(commandFor(lane).args)) errors.push(`command/filter mismatch for ${run.laneId}`);
    for (const stream of ['stdout', 'stderr']) {
      const ref = run.raw?.[stream];
      if (!ref || Object.keys(ref).some((key) => !['path', 'sha256'].includes(key)) || !/^[a-f0-9]{64}$/.test(ref.sha256 ?? '')) errors.push(`malformed ${stream} reference for ${run.laneId}`);
      const file = typeof ref?.path === 'string' && path.resolve(artifactDirectory, ref.path);
      if (!file || !file.startsWith(`${path.resolve(artifactDirectory)}${path.sep}`) || !fs.existsSync(file) || !resolvesWithin(artifactDirectory, file)) { errors.push(`missing or wrong-scope ${stream} for ${run.laneId}`); continue; }
      if (sha256(fs.readFileSync(file)) !== ref.sha256) errors.push(`${stream} digest mismatch for ${run.laneId}`);
    }
    if (run.exitCode !== 0) errors.push(`command failed for ${run.laneId}`);
    if (run.spawnError) errors.push(`Gradle did not start for ${run.laneId}: ${run.spawnError.message ?? 'unknown spawn error'}`);
    if (!run.junit || run.junit.status !== 'PRESENT' || run.junit.tests === 0 || run.junit.failures || run.junit.errors || run.junit.skipped) errors.push(`JUnit result is missing, failed, or skipped for ${run.laneId}`);
    const observedCounts = { tests: 0, failures: 0, errors: 0, skipped: 0 };
    const observedClasses = [];
    if (!Array.isArray(run.junit?.reports)) errors.push(`JUnit report list is malformed for ${run.laneId}`);
    for (const report of Array.isArray(run.junit?.reports) ? run.junit.reports : []) {
      if (!report || typeof report.path !== 'string') { errors.push(`malformed JUnit reference for ${run.laneId}`); continue; }
      if (Object.keys(report).some((key) => !['path', 'sha256'].includes(key)) || !/^[a-f0-9]{64}$/.test(report.sha256 ?? '')) errors.push(`malformed JUnit reference for ${run.laneId}`);
      const expectedPrefix = `${TEST_REPORT_DIRS[run.laneId]}/build/test-results/test/TEST-`;
      if (!report.path?.startsWith(expectedPrefix) || !report.path.endsWith('.xml')) { errors.push(`wrong-scope JUnit report for ${run.laneId}`); continue; }
      const reportClass = report.path.slice(expectedPrefix.length, -'.xml'.length);
      if (!lane.expectedTestClasses.includes(reportClass)) errors.push(`unexpected test class report for ${run.laneId}`);
      observedClasses.push(reportClass);
      const reportPath = path.resolve(root, report.path);
      if (!reportPath.startsWith(`${path.resolve(root)}${path.sep}`) || !fs.existsSync(reportPath) || !resolvesWithin(root, reportPath)) { errors.push(`missing or wrong-scope JUnit report for ${run.laneId}`); continue; }
      const xmlBytes = fs.readFileSync(reportPath);
      if (sha256(xmlBytes) !== report.sha256) errors.push(`JUnit report digest mismatch for ${run.laneId}`);
      const xml = xmlBytes.toString('utf8');
      const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? '';
      const suiteClass = suite.match(/\bname="([^"]+)"/)?.[1];
      if (suiteClass !== reportClass) errors.push(`JUnit suite class does not match report path for ${run.laneId}`);
      if (lane.expectedTestMethods) {
        const testNames = [...xml.matchAll(/<testcase\b[^>]*\bname="([^"]+)"/g)].map((match) => match[1]);
        const matchesExpected = (name, method) => name === method || name.startsWith(`${method}(`);
        if (testNames.length !== lane.expectedTestMethods.length
                || lane.expectedTestMethods.some((method) => testNames.filter((name) => matchesExpected(name, method)).length !== 1)) {
          errors.push(`JUnit methods differ from selected Gradle filters for ${run.laneId}`);
        }
      }
      for (const key of Object.keys(observedCounts)) observedCounts[key] += Number(suite.match(new RegExp(`\\b${key}="(\\d+)"`))?.[1] ?? 0);
    }
    if (JSON.stringify(observedClasses.sort()) !== JSON.stringify([...lane.expectedTestClasses].sort())) errors.push(`JUnit class set differs from selected Gradle filters for ${run.laneId}`);
    if (Object.keys(observedCounts).some((key) => observedCounts[key] !== run.junit?.[key])) errors.push(`JUnit counts differ from reports for ${run.laneId}`);
  }
  return { valid: errors.length === 0, errors };
}

async function collect(laneNames, outputDirectory) {
  const selected = laneNames.map((name) => {
    const lane = Object.values(LANES).find(({ id }) => id === name);
    if (!lane) throw new Error(`Unknown lane '${name}'. Choose ${Object.values(LANES).map(({ id }) => id).join(', ')}`);
    return lane;
  });
  if (new Set(laneNames).size !== laneNames.length) throw new Error('Duplicate lane selection');
  outputDirectory = assertBuildOutputDirectory(outputDirectory);
  fs.mkdirSync(outputDirectory, { recursive: true });
  const sourceFingerprintBefore = currentSourceFingerprint();
  const stamp = new Date().toISOString().replaceAll(':', '').replaceAll('.', '');
  const runs = [];
  for (const lane of selected) {
    const command = commandFor(lane);
    const result = spawnSync(command.executable, command.args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const stdoutBytes = Buffer.from(result.stdout ?? '');
    const stderrBytes = Buffer.from(result.stderr ?? '');
    const stdoutPath = `${stamp}-${lane.id}.stdout.txt`;
    const stderrPath = `${stamp}-${lane.id}.stderr.txt`;
    fs.writeFileSync(path.join(outputDirectory, stdoutPath), stdoutBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(outputDirectory, stderrPath), stderrBytes, { flag: 'wx' });
    runs.push({
      laneId: lane.id,
      storeMode: lane.storeMode,
      command,
      exitCode: result.status ?? 1,
      signal: result.signal ?? null,
      spawnError: result.error ? { name: result.error.name, message: result.error.message, code: result.error.code ?? null, errno: result.error.errno ?? null, syscall: result.error.syscall ?? null } : null,
      raw: { stdout: { path: stdoutPath, sha256: sha256(stdoutBytes) }, stderr: { path: stderrPath, sha256: sha256(stderrBytes) } },
      junit: junitSummary(TEST_REPORT_DIRS[lane.id]),
    });
  }
  const sourceFingerprintAfter = currentSourceFingerprint();
  const artifact = {
    schemaVersion: SCHEMA_VERSION,
    authority: 'LOCAL_ENGINEERING_ONLY',
    scopeId: SCOPE_ID,
    createdAt: new Date().toISOString(),
    sourceFingerprint: sourceFingerprintBefore,
    sourceFingerprintAfter,
    plan: { requiredLanes: Object.values(LANES).map(({ id }) => id), selectedLanes: laneNames },
    toolchain: toolchain(),
    runs,
    localGate: 'NOT_A_CLOSURE_OR_CONVERGENCE_DECISION',
    productionAdmission: 'NOT_ADMITTED',
  };
  const validation = validateArtifact(artifact, outputDirectory);
  const artifactPath = path.join(outputDirectory, `${stamp}-timeline-local-evidence.json`);
  fs.writeFileSync(artifactPath, `${JSON.stringify({ ...artifact, validation }, null, 2)}\n`, { flag: 'wx' });
  return { artifactPath, validation };
}

function parseArgs(argv) {
  const [action, ...args] = argv;
  if (action === 'collect') {
    const lanes = [];
    let outputDirectory = path.join(ROOT, 'build/project-timeline-local-evidence');
    for (let i = 0; i < args.length; i += 1) {
      if (args[i] === '--lane' && args[i + 1]) lanes.push(args[++i]);
      else if (args[i] === '--output-dir' && args[i + 1]) outputDirectory = path.resolve(ROOT, args[++i]);
      else throw new Error(`Unexpected collect argument: ${args[i]}`);
    }
    if (!lanes.length) throw new Error('Select at least one lane with --lane');
    return collect(lanes, outputDirectory);
  }
  if (action === 'verify' && args.length === 1) {
    const file = path.resolve(args[0]);
    const artifactDirectory = path.dirname(file);
    assertBuildOutputDirectory(artifactDirectory);
    const artifact = JSON.parse(fs.readFileSync(file, 'utf8'));
    const validation = validateArtifact(artifact, artifactDirectory);
    console.log(JSON.stringify(validation, null, 2));
    process.exitCode = validation.valid ? 0 : 1;
    return Promise.resolve();
  }
  throw new Error('Usage: node scripts/project-timeline-local-evidence.mjs collect --lane <timeline-unit|isolated-store|dev-only-http|dev-only-restart> [--output-dir <dir>] | verify <artifact.json>');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const result = await parseArgs(process.argv.slice(2));
    if (result?.artifactPath) console.log(`${result.validation.valid ? 'VALID' : 'INCOMPLETE'} local engineering artifact: ${result.artifactPath}${result.validation.errors.length ? `\n${result.validation.errors.join('\n')}` : ''}`);
    if (result && !result.validation?.valid) process.exitCode = 1;
  } catch (error) {
    console.error(error.message);
    process.exitCode = 2;
  }
}
