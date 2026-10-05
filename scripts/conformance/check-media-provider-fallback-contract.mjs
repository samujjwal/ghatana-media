#!/usr/bin/env node

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const read = relative => fs.readFileSync(path.join(root, relative), 'utf8');
const contracts = read('runtime-contracts/src/main/java/com/ghatana/media/runtime/MediaRuntimeContracts.java');
const runtime = read('launcher/src/main/java/com/ghatana/media/launcher/MediaRuntime.java');
const http = read('providers/aws-postgresql/src/main/java/com/ghatana/media/provider/aws/HttpMediaProcessingProvider.java');
const test = read('runtime-contracts/src/test/java/com/ghatana/media/runtime/MediaProcessingProviderFallbackContractTest.java');
const errors = [];

for (const token of [
  'default boolean fallbackEligible(Throwable failure) { return false; }',
  'Timeout and network errors occur after dispatch and are ambiguous by',
]) if (!contracts.includes(token)) errors.push(`MediaProcessingProvider contract missing ${token}`);

for (const forbidden of [
  'return value instanceof java.util.concurrent.TimeoutException',
  '|| value instanceof java.io.IOException',
]) if (contracts.includes(forbidden)) errors.push(`MediaProcessingProvider contract retains unsafe inherited fallback token ${forbidden}`);

for (const token of [
  'failedProvider.fallbackEligible(failure)',
  'index + 1 < providers.size()',
]) if (!runtime.includes(token)) errors.push(`MediaRuntime fallback dispatch is not provider-authority-bound: missing ${token}`);

for (const token of [
  'public boolean fallbackEligible(Throwable failure)',
  'return false;',
]) if (!http.includes(token)) errors.push(`Production HTTP Media provider missing explicit conservative fallback token ${token}`);

for (const token of [
  'externalProviderDoesNotInheritTimeoutOrIoFallbackAuthority',
  'fallbackRequiresExplicitProviderOptIn',
  'assertThat(provider.fallbackEligible(new TimeoutException',
]) if (!test.includes(token)) errors.push(`Media fallback contract test missing ${token}`);

if (errors.length) {
  console.error(`Media provider fallback contract failed with ${errors.length} violation(s):`);
  errors.forEach(error => console.error(`- ${error}`));
  process.exit(1);
}
console.log('Media provider fallback is conservative by contract: ambiguous timeout/network failures do not authorize a second provider unless the failed provider explicitly opts in.');
