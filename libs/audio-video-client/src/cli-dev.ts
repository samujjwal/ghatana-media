#!/usr/bin/env node
import { realpathSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { runLocalDevelopmentCli } from './cli.js';

function isMainEntrypoint(): boolean {
  const argvPath = process.argv[1];
  if (!argvPath) return false;
  try {
    return basename(realpathSync(argvPath)) === 'cli-dev.js';
  } catch {
    return basename(resolve(argvPath)) === 'cli-dev.js';
  }
}

if (isMainEntrypoint()) void runLocalDevelopmentCli(process.argv.slice(2), process.env.GHATANA_MEDIA_BEARER_TOKEN);
