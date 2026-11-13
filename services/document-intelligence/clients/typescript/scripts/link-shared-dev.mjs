#!/usr/bin/env node
import { access, mkdir, rm, symlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const sharedRoot = process.env.GHATANA_SHARED_ROOT;
if (!sharedRoot) throw new Error('GHATANA_SHARED_ROOT is required');
const packageRoot = resolve(sharedRoot, 'platform/typescript/document-extraction');
await access(resolve(packageRoot, 'package.json'));
await exec('pnpm', ['--dir', packageRoot, 'build'], { stdio: 'inherit' });
const localNodeModules = resolve(dirname(new URL(import.meta.url).pathname), '..', 'node_modules');
await mkdir(localNodeModules, { recursive: true });
const target = resolve(localNodeModules, '@ghatana/document-extraction');
await mkdir(dirname(target), { recursive: true });
await rm(target, { recursive: true, force: true });
await symlink(packageRoot, target, 'junction');
console.log(`linked frozen Shared package at ${target}`);
