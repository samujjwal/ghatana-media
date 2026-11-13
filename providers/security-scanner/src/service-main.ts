#!/usr/bin/env node
// Deployable entrypoint: `node dist/service-main.js`. All configuration is environment-supplied; nothing
// is defaulted for credentials. Fails closed (exit 2) on any missing/invalid setting.
import { createPrivateKey } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { ed25519Signer, hmacSha256Signer } from './attestation.ts';
import type { AttestationSigner } from './attestation.ts';
import { ClamdEngine } from './clamd-engine.ts';
import { FilesystemQuarantineSource } from './quarantine-fs.ts';
import { SecurityScannerProvider } from './provider.ts';
import { ScannerHttpService, bearerTokenAuthenticator } from './service.ts';

function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing required environment variable ${name}`);
  return v;
}
const int = (name: string, dflt: number) => (process.env[name] ? Number(process.env[name]) : dflt);

function signerFromEnv(): AttestationSigner {
  const keyId = need('SCANNER_SIGNING_KEY_ID');
  const file = need('SCANNER_SIGNING_KEY_FILE');
  const raw = readFileSync(file);
  return process.env.SCANNER_SIGNING_ALGORITHM === 'Ed25519'
    ? ed25519Signer(keyId, createPrivateKey(raw))
    : hmacSha256Signer(keyId, Buffer.from(raw.toString('utf8').trim(), 'base64'));
}

async function main(): Promise<void> {
  const maxBytes = int('SCANNER_MAX_BYTES', 25 * 1024 * 1024);
  const engine = new ClamdEngine({
    endpoint: process.env.SCANNER_CLAMD_SOCKET
      ? { kind: 'unix', path: process.env.SCANNER_CLAMD_SOCKET }
      : { kind: 'tcp', host: need('SCANNER_CLAMD_HOST'), port: int('SCANNER_CLAMD_PORT', 3310) },
    maxBytes,
  });
  const pinned = need('SCANNER_PINNED_ENGINE_VERSIONS').split(',').map((s) => s.trim()).filter(Boolean);
  const maxDefinitionsAgeMs = int('SCANNER_MAX_DEFINITIONS_AGE_MS', 3 * 24 * 3600_000);
  const provider = new SecurityScannerProvider({
    engine,
    source: new FilesystemQuarantineSource(need('SCANNER_QUARANTINE_ROOT')),
    signer: signerFromEnv(),
    scannerRef: need('SCANNER_REF'),
    pinnedEngineVersions: pinned,
    maxBytes,
    maxDefinitionsAgeMs,
    attestationTtlMs: int('SCANNER_ATTESTATION_TTL_MS', 5 * 60_000),
  });
  // JSON file: [{ "token": "<>=32 chars>", "principalId": "...", "tenantIds": ["..."] }]
  const tokens = JSON.parse(readFileSync(need('SCANNER_BEARER_TOKENS_FILE'), 'utf8'));
  const service = new ScannerHttpService({
    provider, engine, pinnedEngineVersions: pinned, maxDefinitionsAgeMs,
    authenticate: bearerTokenAuthenticator(tokens),
  });
  const bound = await service.listen(int('SCANNER_LISTEN_PORT', 8787), process.env.SCANNER_LISTEN_HOST ?? '127.0.0.1');
  console.log(JSON.stringify({ event: 'scanner-service-listening', ...bound, admissionState: 'NOT_ADMITTED' }));
  for (const sig of ['SIGINT', 'SIGTERM'] as const) process.once(sig, () => void service.close().then(() => process.exit(0)));
}

main().catch((e) => {
  console.error(`scanner service failed to start: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(2);
});
