import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('semantic Shared lock', () => { it('pins the package and semantic fingerprints', () => { const lock = JSON.parse(readFileSync(resolve(process.cwd(), '../../contracts/shared-contract.lock.json'), 'utf8')); expect(lock.package).toEqual({ name: '@ghatana/document-extraction', version: '0.1.0-SNAPSHOT' }); expect(lock.runtimeRootExportsSha256).toMatch(/^[a-f0-9]{64}$/u); }); });
