#!/usr/bin/env node
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const mediaRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const lifecycleRoot = path.resolve(mediaRoot, '../ghatana-lifecycle');
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'media-lifecycle-consumer-'));
const deployRoot = path.join(tempRoot, 'installed');
const consumerRoot = path.join(tempRoot, 'consumer');

function run(command, args, cwd, options = {}) {
  execFileSync(command, args, { cwd, stdio: 'inherit', ...options });
}

try {
  // pnpm deploy assembles a relocatable production dependency tree from the
  // workspace package artifact; the consumer below resolves only that tree.
  run('pnpm', ['--filter', '@ghatana/evidence-contracts', 'deploy', '--legacy', deployRoot], lifecycleRoot);
  fs.mkdirSync(path.join(consumerRoot, 'scripts'), { recursive: true });
  fs.cpSync(path.join(mediaRoot, 'config/closure'), path.join(consumerRoot, 'config/closure'), { recursive: true });
  fs.copyFileSync(path.join(mediaRoot, 'scripts/check-media-lifecycle-closure-inputs.mjs'), path.join(consumerRoot, 'scripts/check-media-lifecycle-closure-inputs.mjs'));
  fs.mkdirSync(path.join(consumerRoot, 'scripts/lib'), { recursive: true });
  fs.copyFileSync(path.join(mediaRoot, 'scripts/lib/media-closure-preflight.mjs'), path.join(consumerRoot, 'scripts/lib/media-closure-preflight.mjs'));
  fs.symlinkSync(path.join(deployRoot, 'node_modules'), path.join(consumerRoot, 'node_modules'), 'dir');

  run('git', ['init', '-q'], consumerRoot);
  run('git', ['config', 'user.email', 'media-consumer-test@example.invalid'], consumerRoot);
  run('git', ['config', 'user.name', 'Media isolated consumer test'], consumerRoot);
  run('git', ['add', 'config/closure', 'scripts/check-media-lifecycle-closure-inputs.mjs', 'scripts/lib/media-closure-preflight.mjs'], consumerRoot);
  run('git', ['commit', '-qm', 'isolated consumer fixture'], consumerRoot);

  run(process.execPath, ['scripts/check-media-lifecycle-closure-inputs.mjs'], consumerRoot, {
    env: {
      ...process.env,
      MEDIA_LIFECYCLE_CONTRACT_ROOT: lifecycleRoot,
      MEDIA_EXPECTED_EVIDENCE_CONTRACTS_ROOT: path.join(deployRoot, 'node_modules/@ghatana/evidence-contracts'),
    },
  });
  console.log('Lifecycle consumer admission passed from an isolated installed Evidence Contracts artifact.');
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
