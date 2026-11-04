import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { TARGETS, freshGradleReportCounts, parseGradleXmlCounts, parseTestCounts, reportSnapshot, runSuite, selectTargets } from '../scripts/qualification/run-selected-backend-suite.mjs';

test('plan covers the exact 15-target cohort and preserves the OC retirement guards', () => {
  assert.deepEqual(TARGETS.map(({ id }) => id), ['JC', 'MC', 'TY', 'RS', 'IP', 'CA', 'LD', 'AS', 'VS', 'DC', 'OC', 'AT', 'SK', 'CT', 'IT']);

  const allCommands = TARGETS.flatMap(({ commands }) => commands);
  const gradleCommands = allCommands.filter(({ command }) => command === './gradlew');
  assert.ok(gradleCommands.length > 0);
  for (const command of gradleCommands) {
    assert.deepEqual(command.args.slice(0, 6), ['--offline', '--no-parallel', '--max-workers=2', '--continue', '--rerun-tasks', '--console=plain']);
  }
  assert.deepEqual(TARGETS.find(({ id }) => id === 'JC').commands[0].args.slice(6), [':services:media:libs:common:test']);
  assert.deepEqual(TARGETS.find(({ id }) => id === 'MC').commands[0].args.slice(6), [':services:media:libs:java:common:test']);
  assert.deepEqual(TARGETS.find(({ id }) => id === 'IP').commands[0].args.slice(6), [
    ':services:media:modules:infrastructure:persistence:test', ':services:media:modules:infrastructure:persistence:integrationTest',
  ]);
  assert.deepEqual(TARGETS.find(({ id }) => id === 'CA').commands[0].args.slice(6), [
    ':services:media:modules:infrastructure:cache:test', ':services:media:modules:infrastructure:cache:integrationTest',
  ]);
  assert.deepEqual(TARGETS.find(({ id }) => id === 'RS').commands[0], {
    command: 'cargo', args: ['test', '--package', 'speech-audio-rust', '--locked', '--offline'],
  });
  assert.deepEqual(TARGETS.find(({ id }) => id === 'OC').commands.map(({ args }) => args), [
    ['run', 'test:ocr-single-authority'], ['run', 'check:ocr-consumer-inventory'],
  ]);
  assert.ok(TARGETS.filter(({ id }) => ['TY', 'SK'].includes(id)).every(({ commands }) => commands[0].args[0] === '--filter'));
  assert.ok(!JSON.stringify(TARGETS.find(({ id }) => id === 'OC')).includes('ocr-compat'));
  assert.ok(!JSON.stringify(allCommands).match(/download|install|model|provider/i));
});

test('selection is case-insensitive, de-duplicated, canonical-order, and rejects unknown IDs', () => {
  assert.deepEqual(selectTargets('it,JC,IT').map(({ id }) => id), ['JC', 'IT']);
  assert.equal(selectTargets('all').length, 15);
  assert.throws(() => selectTargets('JC,nope'), /Unknown target\(s\): NOPE/);
});

test('count parsers read Gradle, Cargo, TAP, and Vitest summaries', () => {
  assert.deepEqual(parseTestCounts('3 tests completed, 1 failed, 2 skipped'), {
    tests: 3, passed: 0, failed: 1, skipped: 2,
  });
  assert.deepEqual(parseTestCounts('test result: ok. 4 passed; 0 failed; 1 ignored; 0 measured; 0 filtered out'), {
    tests: 5, passed: 4, failed: 0, skipped: 1,
  });
  assert.deepEqual(parseTestCounts('# tests 4\n# pass 3\n# fail 0\n# skipped 1'), {
    tests: 4, passed: 3, failed: 0, skipped: 1,
  });
  assert.deepEqual(parseTestCounts('ℹ tests 12\nℹ suites 0\nℹ pass 12\nℹ fail 0\nℹ cancelled 0\nℹ skipped 0'), {
    tests: 12, passed: 12, failed: 0, skipped: 0,
  });
  assert.deepEqual(parseTestCounts('Tests  7 passed | 2 skipped (9)'), {
    tests: 9, passed: 7, failed: 0, skipped: 2,
  });
  assert.equal(parseTestCounts('build succeeded'), null);
});

test('Gradle XML reports provide counts for successful and failing task runs', () => {
  assert.deepEqual(parseGradleXmlCounts([
    '<?xml version="1.0"?><testsuite name="PassingTest" tests="4" skipped="1" failures="0" errors="0">',
    '<?xml version="1.0"?><testsuite name="FailingTest" tests="3" skipped="0" failures="1" errors="1">',
  ]), { tests: 7, passed: 4, failed: 2, skipped: 1 });
  assert.equal(parseGradleXmlCounts(['not a test report']), null);
});

test('Gradle XML freshness detects same-size rewrites with unchanged timestamps', () => {
  const cwd = mkdtempSync(path.join(os.tmpdir(), 'selected-backend-reports-'));
  const reportDir = path.join(cwd, 'libs/common/build/test-results/test');
  mkdirSync(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, 'TEST-Example.xml');
  const command = { command: './gradlew', args: [':services:media:libs:common:test'] };
  const oldXml = '<testsuite tests="1" failures="0" errors="0" skipped="0"/>';
  const newXml = '<testsuite tests="1" failures="1" errors="0" skipped="0"/>';
  const fixedTime = new Date('2026-11-04T00:00:00Z');
  try {
    writeFileSync(reportPath, oldXml);
    utimesSync(reportPath, fixedTime, fixedTime);
    const before = reportSnapshot([reportPath]);
    writeFileSync(reportPath, newXml);
    utimesSync(reportPath, fixedTime, fixedTime);
    assert.equal(readFileSync(reportPath, 'utf8').length, oldXml.length);
    assert.deepEqual(freshGradleReportCounts(command, cwd, before), {
      tests: 1, passed: 0, failed: 1, skipped: 0,
    });
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
});

test('runner is serial, continues across targets and remaining commands, and reports stable statuses', async () => {
  const calls = [];
  const lines = [];
  const targets = [
    { id: 'FIRST', commands: [{ command: 'one', args: [] }, { command: 'two', args: [] }] },
    { id: 'SECOND', commands: [{ command: 'three', args: [] }] },
    { id: 'THIRD', commands: [{ command: 'four', args: [] }] },
  ];
  const results = new Map([
    ['one', { code: 7, stdout: '# tests 3\n# pass 2\n# fail 1\n# skipped 0', stderr: 'PRIVATE assertion output' }],
    ['two', { code: 0, stdout: '# tests 1\n# pass 1\n# fail 0\n# skipped 0' }],
    ['three', { code: 1, stderr: 'No cached version of dependency is available for offline mode' }],
    ['four', { code: 0, stdout: '# tests 2\n# pass 2\n# fail 0\n# skipped 0' }],
  ]);
  let active = 0;
  const result = await runSuite({
    targets,
    cwd: '/fake/workspace',
    write: (line) => lines.push(line),
    commandRunner: async (command, options) => {
      assert.equal(active, 0, 'commands must not overlap');
      active += 1;
      calls.push({ command: command.command, options });
      await Promise.resolve();
      active -= 1;
      return results.get(command.command);
    },
  });
  assert.deepEqual(calls.map(({ command }) => command), ['one', 'two', 'three', 'four']);
  assert.deepEqual(calls.map(({ options }) => options.cwd), Array(4).fill('/fake/workspace'));
  assert.ok(calls.every(({ options }) => options.timeoutMs === 20 * 60 * 1000));
  assert.deepEqual(result.results.map(({ id, status }) => [id, status]), [
    ['FIRST', 'FAIL'], ['SECOND', 'UNAVAILABLE'], ['THIRD', 'PASS'],
  ]);
  assert.deepEqual(result.results[0].counts, { tests: 4, passed: 3, failed: 1, skipped: 0 });
  assert.equal(result.exitCode, 1);
  assert.deepEqual(lines, [
    'FIRST#1\tFAIL\tcmd=one\ttests=3 pass=2 fail=1 skipped=0\tdetail=test failures reported',
    'FIRST#2\tPASS\tcmd=two\ttests=1 pass=1 fail=0 skipped=0',
    'FIRST\tFAIL\ttests=4 pass=3 fail=1 skipped=0',
    'SECOND#1\tUNAVAILABLE\tcmd=three\ttests=N/A\tdetail=tool, dependency, or environment unavailable',
    'SECOND\tUNAVAILABLE\ttests=N/A',
    'THIRD#1\tPASS\tcmd=four\ttests=2 pass=2 fail=0 skipped=0',
    'THIRD\tPASS\ttests=2 pass=2 fail=0 skipped=0',
    'SUMMARY\tPASS=1\tPARTIAL=0\tFAIL=1\tUNAVAILABLE=1\tTOTAL=3',
  ]);
  assert.ok(!lines.join('\n').includes('PRIVATE'));
});

test('missing command is unavailable and never counted as a pass', async () => {
  const lines = [];
  const result = await runSuite({
    targets: [{ id: 'MISS', commands: [{ command: 'missing', args: [] }] }],
    write: (line) => lines.push(line),
    commandRunner: async () => ({ code: null, error: { code: 'ENOENT' } }),
  });
  assert.equal(result.results[0].status, 'UNAVAILABLE');
  assert.equal(result.exitCode, 1);
  assert.match(lines.at(-1), /PASS=0\tPARTIAL=0\tFAIL=0\tUNAVAILABLE=1\tTOTAL=1/);
});

test('permission and output-buffer execution errors are unavailable while timeout stays fail', async () => {
  const fixtures = [
    ['EACCES', { code: null, error: { code: 'EACCES' } }],
    ['EPERM', { code: null, error: { code: 'EPERM' } }],
    ['ENOBUFS', { code: null, error: { code: 'ENOBUFS' } }],
    ['TIMEOUT', { code: null, timedOut: true, error: { code: 'ETIMEDOUT' } }],
  ];
  const resultByCommand = new Map(fixtures);
  const result = await runSuite({
    targets: fixtures.map(([id]) => ({ id, commands: [{ command: id, args: [] }] })),
    commandRunner: async ({ command }) => resultByCommand.get(command),
    write: () => {},
  });
  assert.deepEqual(result.results.map(({ id, status }) => [id, status]), [
    ['EACCES', 'UNAVAILABLE'], ['EPERM', 'UNAVAILABLE'], ['ENOBUFS', 'UNAVAILABLE'], ['TIMEOUT', 'FAIL'],
  ]);
  assert.equal(result.exitCode, 1);
});

test('timeout is FAIL, successful no-summary is UNAVAILABLE, and skipped tests are PARTIAL', async () => {
  const targets = [
    { id: 'TIMEOUT', commands: [{ command: 'slow', args: [] }] },
    { id: 'NO_SUMMARY', commands: [{ command: 'silent', args: [] }] },
    { id: 'SKIPPED', commands: [{ command: 'skip', args: [] }] },
    { id: 'ALL_SKIPPED', commands: [{ command: 'all-skip', args: [] }] },
    { id: 'INVENTORY', commands: [{ command: 'pnpm', args: ['run', 'check:ocr-consumer-inventory'] }] },
  ];
  const resultsByCommand = {
    slow: { code: null, timedOut: true, error: { code: 'ETIMEDOUT' } },
    silent: { code: 0, stdout: 'BUILD SUCCESSFUL' },
    skip: { code: 0, stdout: '# tests 3\n# pass 2\n# fail 0\n# skipped 1' },
    'all-skip': { code: 0, stdout: '# tests 2\n# pass 0\n# fail 0\n# skipped 2' },
    pnpm: { code: 0, stdout: 'inventory valid' },
  };
  const lines = [];
  const result = await runSuite({ targets, commandRunner: async ({ command }) => resultsByCommand[command], write: (line) => lines.push(line) });
  assert.deepEqual(result.results.map(({ id, status }) => [id, status]), [
    ['TIMEOUT', 'FAIL'], ['NO_SUMMARY', 'UNAVAILABLE'], ['SKIPPED', 'PARTIAL'], ['ALL_SKIPPED', 'UNAVAILABLE'], ['INVENTORY', 'PASS'],
  ]);
  assert.deepEqual(result.results[2].counts, { tests: 3, passed: 2, failed: 0, skipped: 1 });
  assert.deepEqual(result.results[3].counts, { tests: 2, passed: 0, failed: 0, skipped: 2 });
  assert.equal(result.results[4].commandResults[0].kind, 'inventory');
  assert.equal(result.exitCode, 1);
  assert.match(lines.find((line) => line.startsWith('TIMEOUT#1')), /FAIL\tcmd=slow/);
  assert.match(lines.find((line) => line.startsWith('SKIPPED\t')), /PARTIAL\ttests=3 pass=2 fail=0 skipped=1/);
  assert.match(lines.find((line) => line.startsWith('INVENTORY#1')), /PASS\tcmd=pnpm run check:ocr-consumer-inventory\ttests=N\/A\tkind=inventory/);
});

test('inconsistent successful test counts are unavailable, not a pass', async () => {
  const lines = [];
  const result = await runSuite({
    targets: [{ id: 'INCONSISTENT', commands: [{ command: 'bad-summary', args: [] }] }],
    commandRunner: async () => ({ code: 0, stdout: '# tests 4\n# pass 3\n# fail 0\n# skipped 0' }),
    write: (line) => lines.push(line),
  });
  assert.equal(result.results[0].status, 'UNAVAILABLE');
  assert.equal(result.results[0].commandResults[0].reason, 'inconsistent test counts');
  assert.equal(result.exitCode, 1);
  assert.match(lines.at(-1), /PASS=0\tPARTIAL=0\tFAIL=0\tUNAVAILABLE=1/);
});

test('known missing dependencies, tools, and Docker environment are unavailable', async () => {
  const cases = [
    ['vite', { code: 1, stderr: "Cannot find package 'vitest/config' imported from config.mjs" }],
    ['tsc', { code: 127, stderr: 'tsc: command not found' }],
    ['docker', { code: 1, stderr: 'permission denied while connecting to Docker socket' }],
    ['gradle-lock', { code: 1, stderr: 'gradle-9.8.2-bin.zip.lck (Operation not permitted)' }],
  ];
  const targets = cases.map(([id]) => ({ id, commands: [{ command: id, args: [] }] }));
  const output = new Map(cases);
  const result = await runSuite({ targets, commandRunner: async ({ command }) => output.get(command), write: () => {} });
  assert.ok(result.results.every(({ status }) => status === 'UNAVAILABLE'));
  assert.equal(result.exitCode, 1);
});
