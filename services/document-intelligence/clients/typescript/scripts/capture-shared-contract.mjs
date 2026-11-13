#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const exec = promisify(execFile);
const scriptDir = resolve(fileURLToPath(new URL('.', import.meta.url)));
const workerRoot = resolve(scriptDir, '../../..');
const sharedRoot = process.env.GHATANA_SHARED_ROOT;
if (!sharedRoot) throw new Error('GHATANA_SHARED_ROOT is required');
const packageRoot = resolve(sharedRoot, 'platform/typescript/document-extraction');
const packageJson = JSON.parse(await readFile(resolve(packageRoot, 'package.json'), 'utf8'));
if (packageJson.name !== '@ghatana/document-extraction') throw new Error('unexpected Shared package name');
if (!process.argv.includes('--no-build')) await exec('pnpm', ['--dir', packageRoot, 'build'], { stdio: 'inherit' });
const sha = (value) => createHash('sha256').update(value).digest('hex');
const snapshot = await readFile(resolve(packageRoot, 'scripts/public-type-api.snapshot.json'));
const root = await import(resolve(packageRoot, 'dist/index.js'));
const runtimeExports = Object.keys(root).sort();
const signature = async (file, names) => {
  const source = await readFile(resolve(packageRoot, 'src/providers', file), 'utf8');
  const selected = names.map((name) => {
    const index = source.indexOf(`export interface ${name}`);
    if (index < 0) throw new Error(`missing Shared signature ${name}`);
    return source.slice(index, source.indexOf('\n}', index) + 2).replace(/\s+/gu, ' ').trim();
  });
  return sha(selected.join('\n'));
};
const lock = {
  lockVersion: 'document-intelligence.shared-contract.v1',
  package: { name: packageJson.name, version: packageJson.version },
  publicTypeApiSnapshotSha256: sha(snapshot),
  runtimeRootExports: runtimeExports,
  runtimeRootExportsSha256: sha(JSON.stringify(runtimeExports)),
  parserPortSignatureSha256: await signature('parser.ts', ['DocumentParserCapabilities', 'DocumentParseRequest', 'DocumentParserPort']),
  fieldExtractionPortSignatureSha256: await signature('extractor.ts', ['FieldExtractionCapabilities', 'FieldExtractionRequest', 'FieldExtractionProviderResult', 'FieldExtractionProviderPort']),
  embeddingPortSignatureSha256: await signature('embedding.ts', ['EmbeddingCapabilities', 'StructureEmbedding', 'StructureEmbeddingRequest', 'StructureEmbeddingPort']),
  errorCodes: [...root.EXTRACTION_ERROR_CODES].sort(),
  errorCodeSetSha256: sha(JSON.stringify([...root.EXTRACTION_ERROR_CODES].sort())),
  extractionLimits: Object.fromEntries(Object.entries(root.EXTRACTION_LIMITS).sort(([a], [b]) => a.localeCompare(b))),
  extractionLimitSetSha256: sha(JSON.stringify(Object.fromEntries(Object.entries(root.EXTRACTION_LIMITS).sort(([a], [b]) => a.localeCompare(b))))),
};
const output = `${JSON.stringify(lock, null, 2)}\n`;
if (process.argv.includes('--stdout')) process.stdout.write(output);
else await writeFile(resolve(workerRoot, 'contracts/shared-contract.lock.json'), output, 'utf8');
