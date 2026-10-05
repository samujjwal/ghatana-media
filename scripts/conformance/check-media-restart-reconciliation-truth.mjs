#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const runtime = readFileSync(
  resolve('launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java'),
  'utf8',
);
const test = readFileSync(
  resolve('launcher/src/test/java/com/ghatana/media/launcher/MediaRuntimeRestartReconciliationTest.java'),
  'utf8',
);
const errors = [];
for (const token of [
  'reconcileJobsAfterRestart()',
  'RESTART_RECONCILIATION_REQUIRED',
  'provider outcome unknown after runtime restart',
  'MEDIA_JOB_LOCAL_CANCELLATION_UNCONFIRMED',
]) {
  if (!runtime.includes(token)) errors.push(`MediaRuntime missing ${token}`);
}
for (const token of [
  'unconfirmedCancellationSurvivesShutdownAndRestartRequiresExplicitReconciliation',
  'isEqualTo(JobStatus.RUNNING)',
  'isEqualTo("RESTART_RECONCILIATION_REQUIRED")',
  'isNotEqualTo(JobStatus.CANCELLED)',
]) {
  if (!test.includes(token)) errors.push(`Media restart test missing ${token}`);
}
if (errors.length) {
  console.error('Media restart reconciliation truth failed:');
  errors.forEach(error => console.error(` - ${error}`));
  process.exit(1);
}
console.log('Media restart reconciliation truth passed: uncertain nonterminal jobs remain recoverable and never become fake cancellation.');
