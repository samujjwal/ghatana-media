import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const repo = join(dirname(fileURLToPath(import.meta.url)), '..');
const parity = JSON.parse(readFileSync(
  join(repo, 'docs/implementation/media-sdk-route-parity.v1.json'), 'utf8'));
const openapi = readFileSync(join(repo, 'contracts/openapi/media.yaml'), 'utf8');
const sdk = readFileSync(join(repo, 'libs/audio-video-client/src/operations.ts'), 'utf8');

const operationIds = [...openapi.matchAll(/operationId: (\w+)/g)].map((m) => m[1]);
const unique = new Set(operationIds);

test('SK-01: every OpenAPI operationId is classified exactly once', () => {
  const classified = new Set([
    ...Object.keys(parity.boundCanonical),
    ...Object.keys(parity.legacyServed).filter((k) => k !== 'note'),
    ...Object.values(parity.unbound).filter(Array.isArray).flat(),
  ]);
  assert.equal(unique.size, 27);
  for (const id of unique) assert.ok(classified.has(id), `${id} unclassified`);
  assert.equal(classified.size, unique.size, 'no operationId may appear twice');
});

test('SK-01: unbound operation routes are never advertised as live SDK calls', () => {
  const unboundRoutes = {
    getMediaConsent: '/api/v1/consents', grantMediaConsent: 'grant',
    listMediaConsents: 'consents', revokeMediaConsent: 'revoke',
    listMediaJobs: 'GET /api/v1/jobs',
  };
  // The SDK may only carry the canonical job-submit route if it calls POST /api/v1/jobs —
  // it does not: every canonical route the SDK uses must be a bound one.
  for (const m of sdk.matchAll(/"(\/api\/v1[^"]*)"/g)) {
    const lit = m[1];
    const ok = lit.includes('/artifacts/uploads') || lit.includes('/artifacts/')
        || lit.startsWith('/api/v1/media/');
    assert.ok(ok, `unclassified SDK route literal: ${lit}`);
  }
  // Consent and stream routes must not appear at all.
  assert.ok(!sdk.includes('/consents'), 'consent routes must stay unbound');
  assert.ok(!sdk.includes('/streams'), 'stream routes must stay unbound');
  assert.ok(!sdk.includes('POST", "/api/v1/jobs"') && !sdk.includes('POST", `/api/v1/jobs`'),
    'canonical submitMediaJob is not invoked — jobs go through legacy compat routes');
});

test('SK-01: canonical route table stays consistent with the bound map', () => {
  const routes = readFileSync(join(repo, 'libs/audio-video-client/src/canonical-routes.ts'), 'utf8');
  for (const [id, entry] of Object.entries(parity.boundCanonical)) {
    const path = entry.route.split(' ')[1];
    const key = id.replace(/^(\w)Media(\w)/, (a, b, c) => b.toLowerCase() + c);
    assert.ok(routes.includes(path), `canonical-routes.ts missing ${path} for ${id}`);
  }
});
