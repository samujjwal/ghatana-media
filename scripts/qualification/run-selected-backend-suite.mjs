#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const GRADLE_FLAGS = ['--offline', '--no-parallel', '--max-workers=2', '--continue', '--rerun-tasks', '--console=plain'];

const gradle = (...tasks) => ({ command: './gradlew', args: [...GRADLE_FLAGS, ...tasks] });
const pnpm = (...args) => ({ command: 'pnpm', args });

export const TARGETS = Object.freeze([
  { id: 'JC', commands: [gradle(':services:media:libs:common:test')] },
  { id: 'MC', commands: [gradle(':services:media:libs:java:common:test')] },
  { id: 'TY', commands: [pnpm('--filter', '@audio-video/types', 'test')] },
  { id: 'RS', commands: [{ command: 'cargo', args: ['test', '--package', 'speech-audio-rust', '--locked', '--offline'] }] },
  { id: 'IP', commands: [gradle(':services:media:modules:infrastructure:persistence:test', ':services:media:modules:infrastructure:persistence:integrationTest')] },
  { id: 'CA', commands: [gradle(':services:media:modules:infrastructure:cache:test', ':services:media:modules:infrastructure:cache:integrationTest')] },
  { id: 'LD', commands: [gradle(':services:media:adapters:ledger:test')] },
  { id: 'AS', commands: [gradle(':services:media:modules:audio-streaming:test')] },
  { id: 'VS', commands: [gradle(':services:media:modules:video-streaming:test')] },
  { id: 'DC', commands: [gradle(':services:media:adapters:data-cloud-media:test')] },
  { id: 'OC', commands: [pnpm('run', 'test:ocr-single-authority'), pnpm('run', 'check:ocr-consumer-inventory')] },
  { id: 'AT', commands: [gradle(':services:media:adapters:agent-tools-media:test')] },
  { id: 'SK', commands: [pnpm('--filter', '@audio-video/client', 'test')] },
  { id: 'CT', commands: [gradle(':services:media:modules:integration-tests:test')] },
  { id: 'IT', commands: [gradle(':services:media:integration-tests:test')] },
]);

const UNAVAILABLE_PATTERNS = [
  /could not resolve .*dependencies|could not resolve all files|no cached version .*available for offline mode/i,
  /offline mode.*(?:not|unable)|dependency resolution.*failed|failed to resolve .*dependency/i,
  /no matching toolchains? found|toolchain .*not found|java home .*does not exist/i,
  /cannot connect to the docker daemon|docker daemon.*(?:not running|unavailable)|could not find a valid docker environment|docker.*socket.*permission denied|permission denied.*docker/i,
  /\.lck.*operation not permitted|operation not permitted.*\.lck/i,
  /command not found|is not recognized as an internal or external command/i,
  /pnpm(?:\s+ERR_PNPM)?[^\n]*(?:missing|not found|install.*required)|(?:cannot find|module not found|cannot find package).*(?:vitest(?:\/config)?|typescript|zod)|(?:tsc|vitest): command not found/i,
];

function countMatches(text, expression, convert) {
  const matches = [...text.matchAll(expression)];
  if (!matches.length) return null;
  return matches.map(convert).reduce((total, count) => ({
    tests: total.tests + count.tests,
    passed: total.passed + count.passed,
    failed: total.failed + count.failed,
    skipped: total.skipped + count.skipped,
  }), { tests: 0, passed: 0, failed: 0, skipped: 0 });
}

export function parseTestCounts(output = '') {
  const text = String(output);
  const gradleCounts = countMatches(text, /(\d+)\s+tests?\s+completed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+skipped)?/gi, (match) => {
    const completed = Number(match[1]);
    const failed = Number(match[2] ?? 0);
    const skipped = Number(match[3] ?? 0);
    return { tests: completed, passed: Math.max(0, completed - failed - skipped), failed, skipped };
  });
  if (gradleCounts) return gradleCounts;

  const cargoCounts = countMatches(text, /test result:\s*\w+\.\s*(\d+)\s+passed;\s*(\d+)\s+failed;\s*(\d+)\s+ignored/gi, (match) => {
    const passed = Number(match[1]);
    const failed = Number(match[2]);
    const skipped = Number(match[3]);
    return { tests: passed + failed + skipped, passed, failed, skipped };
  });
  if (cargoCounts) return cargoCounts;

  const tapTests = text.match(/^# tests\s+(\d+)\s*$/m);
  const tapPassed = text.match(/^# pass\s+(\d+)\s*$/m);
  const tapFailed = text.match(/^# fail\s+(\d+)\s*$/m);
  const tapSkipped = text.match(/^# skipped\s+(\d+)\s*$/m);
  if (tapTests && tapPassed && tapFailed) {
    return {
      tests: Number(tapTests[1]),
      passed: Number(tapPassed[1]),
      failed: Number(tapFailed[1]),
      skipped: Number(tapSkipped?.[1] ?? 0),
    };
  }

  // Node's current --test reporter prefixes TAP summary records with ℹ.
  const nodeSummary = new Map([...text.matchAll(/^\s*ℹ\s+(tests|pass|fail|skipped)\s+(\d+)\s*$/gm)]
    .map(([, field, value]) => [field, Number(value)]));
  if (['tests', 'pass', 'fail'].every((field) => nodeSummary.has(field))) {
    return {
      tests: nodeSummary.get('tests'),
      passed: nodeSummary.get('pass'),
      failed: nodeSummary.get('fail'),
      skipped: nodeSummary.get('skipped') ?? 0,
    };
  }

  const vitestLines = [...text.matchAll(/^\s*Tests\s+(.+)$/gim)];
  if (vitestLines.length) {
    return vitestLines.map(([, summary]) => {
      const passed = Number(summary.match(/(\d+)\s+passed/i)?.[1] ?? 0);
      const failed = Number(summary.match(/(\d+)\s+failed/i)?.[1] ?? 0);
      const skipped = Number(summary.match(/(\d+)\s+skipped/i)?.[1] ?? 0);
      const total = Number(summary.match(/\((\d+)\)/)?.[1] ?? passed + failed + skipped);
      return { tests: total, passed, failed, skipped };
    }).reduce((total, count) => ({
      tests: total.tests + count.tests,
      passed: total.passed + count.passed,
      failed: total.failed + count.failed,
      skipped: total.skipped + count.skipped,
    }), { tests: 0, passed: 0, failed: 0, skipped: 0 });
  }
  return null;
}

export function parseGradleXmlCounts(xmlFiles) {
  const totals = { tests: 0, passed: 0, failed: 0, skipped: 0 };
  let found = false;
  for (const xml of xmlFiles) {
    const suite = xml.match(/<testsuite\b([^>]*)>/i);
    if (!suite) continue;
    const attrs = Object.fromEntries([...suite[1].matchAll(/([\w-]+)="([^"]*)"/g)].map(([, key, value]) => [key, Number(value)]));
    if (!Number.isFinite(attrs.tests)) continue;
    found = true;
    const skipped = attrs.skipped ?? 0;
    const failed = (attrs.failures ?? 0) + (attrs.errors ?? 0);
    totals.tests += attrs.tests;
    totals.failed += failed;
    totals.skipped += skipped;
    totals.passed += Math.max(0, attrs.tests - failed - skipped);
  }
  return found ? totals : null;
}

function gradleReportFiles(command, cwd) {
  const taskPaths = command.args.filter((arg) => /^:services:media:.+:(?:test|integrationTest)$/.test(arg));
  return taskPaths.flatMap((taskPath) => {
    const parts = taskPath.slice(':services:media:'.length).split(':');
    const task = parts.pop();
    const reportDir = path.join(cwd, ...parts, 'build', 'test-results', task);
    try {
      return readdirSync(reportDir).filter((name) => name.endsWith('.xml')).map((name) => path.join(reportDir, name));
    } catch {
      return [];
    }
  });
}

export function reportSnapshot(files) {
  return new Map(files.map((file) => {
    try {
      const contents = readFileSync(file);
      return [file, createHash('sha256').update(contents).digest('hex')];
    } catch {
      return [file, 'missing'];
    }
  }));
}

export function freshGradleReportCounts(command, cwd, before) {
  const files = gradleReportFiles(command, cwd);
  const fresh = files.filter((file) => {
    try {
      const contents = readFileSync(file);
      return before.get(file) !== createHash('sha256').update(contents).digest('hex');
    } catch {
      return false;
    }
  });
  return parseGradleXmlCounts(fresh.map((file) => readFileSync(file, 'utf8')));
}

export function selectTargets(selection, targets = TARGETS) {
  if (selection === undefined || selection === null || selection === '' || selection === 'all') return [...targets];
  const requested = String(selection).split(',').map((item) => item.trim().toUpperCase()).filter(Boolean);
  const known = new Map(targets.map((target) => [target.id, target]));
  const unknown = requested.filter((id) => !known.has(id));
  if (unknown.length) throw new Error(`Unknown target(s): ${[...new Set(unknown)].join(', ')}`);
  const unique = new Set(requested);
  return targets.filter((target) => unique.has(target.id));
}

function unavailableReason(result) {
  if (result?.error?.code === 'ENOENT') return 'required tool is missing';
  if (['EACCES', 'EPERM'].includes(result?.error?.code)) return 'tool execution is not permitted';
  if (result?.error?.code === 'ENOBUFS') return 'command output exceeded the capture buffer';
  const output = `${result?.stdout ?? ''}\n${result?.stderr ?? ''}`;
  return UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(output)) ? 'tool, dependency, or environment unavailable' : null;
}

function commandStatus(command, result) {
  const args = command.args;
  const isInventoryGuard = args.slice(-2).join(' ') === 'run check:ocr-consumer-inventory';
  if (result?.code !== 0) {
    const counts = result?.counts ?? parseTestCounts(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`);
    if (result?.timedOut || result?.error?.code === 'ETIMEDOUT') {
      return { status: 'FAIL', reason: 'command timed out', counts };
    }
    const unavailable = unavailableReason(result);
    return {
      status: unavailable ? 'UNAVAILABLE' : 'FAIL',
      reason: unavailable ?? (counts?.failed > 0 ? 'test failures reported' : `exit ${result?.code ?? 'unknown'}`),
      counts,
    };
  }
  if (isInventoryGuard) return { status: 'PASS', reason: '', counts: null, kind: 'inventory' };
  const counts = result?.counts ?? parseTestCounts(`${result?.stdout ?? ''}\n${result?.stderr ?? ''}`);
  if (!counts) return { status: 'UNAVAILABLE', reason: 'test summary missing', counts: null };
  if (!countsAreConsistent(counts)) return { status: 'UNAVAILABLE', reason: 'inconsistent test counts', counts };
  if (counts.tests <= counts.skipped || counts.tests === 0) return { status: 'UNAVAILABLE', reason: 'no tests executed', counts };
  if (counts.failed > 0) return { status: 'FAIL', reason: 'test failures reported', counts };
  if (counts.skipped > 0) return { status: 'PARTIAL', reason: 'tests skipped', counts };
  return { status: 'PASS', reason: '', counts };
}

function formatCounts(counts) {
  return counts ? `tests=${counts.tests} pass=${counts.passed} fail=${counts.failed} skipped=${counts.skipped}` : 'tests=N/A';
}

function countsAreConsistent(counts) {
  return ['tests', 'passed', 'failed', 'skipped'].every((field) =>
    Number.isInteger(counts[field]) && counts[field] >= 0
  ) && counts.passed + counts.failed + counts.skipped === counts.tests;
}

export async function runSuite({ targets = TARGETS, commandRunner = defaultCommandRunner, cwd = ROOT, write = console.log } = {}) {
  const results = [];
  for (const target of targets) {
    const commandResults = [];
    for (const command of target.commands) {
      let result;
      try {
        result = await commandRunner(command, { cwd, timeoutMs: 20 * 60 * 1000 });
      } catch (error) {
        result = { code: null, error };
      }
      commandResults.push({ ...commandStatus(command, result), command });
      // Continue remaining commands in a target (notably both OC ownership guards).
    }
    const statuses = commandResults.map(({ status }) => status);
    const status = statuses.includes('FAIL') ? 'FAIL'
      : statuses.includes('UNAVAILABLE') ? 'UNAVAILABLE'
        : statuses.includes('PARTIAL') ? 'PARTIAL' : 'PASS';
    const counts = commandResults.reduce((total, result) => {
      if (!result.counts) return total;
      for (const field of ['tests', 'passed', 'failed', 'skipped']) total[field] += result.counts[field];
      return total;
    }, { tests: 0, passed: 0, failed: 0, skipped: 0 });
    results.push({ id: target.id, status, counts, commandResults });
  }

  for (const result of results) {
    result.commandResults.forEach((commandResult, index) => {
      const detail = commandResult.reason ? `\tdetail=${commandResult.reason}` : '';
      const kind = commandResult.kind ? `\tkind=${commandResult.kind}` : '';
      const commandLine = [commandResult.command.command, ...commandResult.command.args].join(' ');
      write(`${result.id}#${index + 1}\t${commandResult.status}\tcmd=${commandLine}\t${formatCounts(commandResult.counts)}${kind}${detail}`);
    });
    const groupCounts = result.counts.tests > 0 ? formatCounts(result.counts) : 'tests=N/A';
    write(`${result.id}\t${result.status}\t${groupCounts}`);
  }
  const passed = results.filter(({ status }) => status === 'PASS').length;
  const failed = results.filter(({ status }) => status === 'FAIL').length;
  const unavailable = results.filter(({ status }) => status === 'UNAVAILABLE').length;
  const partial = results.filter(({ status }) => status === 'PARTIAL').length;
  write(`SUMMARY\tPASS=${passed}\tPARTIAL=${partial}\tFAIL=${failed}\tUNAVAILABLE=${unavailable}\tTOTAL=${results.length}`);
  return { results, exitCode: results.every(({ status }) => status === 'PASS') ? 0 : 1 };
}

function defaultCommandRunner({ command, args }, { cwd, timeoutMs }) {
  const spec = { command, args };
  const before = command === './gradlew' ? reportSnapshot(gradleReportFiles(spec, cwd)) : null;
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
    env: process.env,
  });
  return {
    code: result.status,
    signal: result.signal,
    error: result.error,
    stdout: result.stdout,
    stderr: result.stderr,
    timedOut: result.error?.code === 'ETIMEDOUT',
    ...(before ? { counts: freshGradleReportCounts(spec, cwd, before) } : {}),
  };
}

function parseArgs(args) {
  const targetArg = args.find((arg) => arg.startsWith('--targets='));
  const singleTarget = args.find((arg) => arg.startsWith('--target='));
  if (targetArg && singleTarget) throw new Error('Use either --target or --targets, not both');
  return targetArg?.slice('--targets='.length) ?? singleTarget?.slice('--target='.length) ?? 'all';
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const targets = selectTargets(parseArgs(process.argv.slice(2)));
    const result = await runSuite({ targets });
    process.exitCode = result.exitCode;
  } catch (error) {
    console.error(`ERROR\t${error.message}`);
    process.exitCode = 2;
  }
}
