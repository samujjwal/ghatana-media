#!/usr/bin/env node

import { spawnSync } from 'node:child_process';

const gradleTasks = [
  ':services:media:modules:speech:stt-service:test',
  ':services:media:modules:speech:tts-service:test',
  '--no-build-cache',
];
const gradleCommand = process.platform === 'win32' ? 'cmd.exe' : './gradlew';
const gradleArgs = process.platform === 'win32'
  ? ['/d', '/c', 'call', 'gradlew.bat', ...gradleTasks]
  : gradleTasks;

const commands = [
  [process.execPath, ['scripts/conformance/check-media-speech-persistence-privacy.mjs']],
  [gradleCommand, gradleArgs],
];

for (const [command, args] of commands) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (result.stdout) process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log('Media speech persistence privacy source and module verification commands passed.');
