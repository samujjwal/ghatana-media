#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { validateMediaCancellationTruth } from './lib/media-cancellation-truth.mjs';

const read = path => readFileSync(resolve(process.cwd(), path), 'utf8');
const errors = validateMediaCancellationTruth({
  runtimeSource: read('launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java'),
  testSource: read('launcher/src/test/java/com/ghatana/media/launcher/MediaRuntimeJobGovernanceTest.java'),
  migrationSource: read('providers/aws-postgresql/src/main/resources/db/media-runtime/V006__media_job_cancellation_truth.sql'),
});

if (errors.length > 0) {
  console.error('Media cancellation truth check failed:');
  errors.forEach(error => console.error(` - ${error}`));
  process.exit(1);
}
console.log('Media cancellation truth passed: only provider-confirmed cancellation is terminal; uncertain cancellation remains monitored.');
