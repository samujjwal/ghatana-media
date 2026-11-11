import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const script = resolve(root, 'scripts/media-dev-identity-token.mjs');
const secret = 'test-only-dev-secret-with-at-least-32-bytes';
const requiredArguments = ['--tenant', 'tenant-a', '--subject', 'principal-a', '--permission', 'media:job:read'];

function invoke(args = requiredArguments, overrides = {}) {
  const env = { ...process.env };
  delete env.MEDIA_RUNTIME_ENVIRONMENT;
  delete env.MEDIA_PROFILE;
  delete env.MEDIA_DEV_IDENTITY_ENABLED;
  delete env.MEDIA_DEV_JWT_HMAC_SECRET;
  Object.assign(env, {
    MEDIA_RUNTIME_ENVIRONMENT: 'dev',
    MEDIA_DEV_IDENTITY_ENABLED: 'true',
    MEDIA_DEV_JWT_HMAC_SECRET: secret,
  });
  for (const [key, value] of Object.entries(overrides)) {
    if (value === null) delete env[key];
    else env[key] = value;
  }
  return spawnSync(process.execPath, [script, ...args], { cwd: root, env, encoding: 'utf8' });
}

function decodeToken(result) {
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, '');
  assert.match(result.stdout, /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\n$/u);
  const [encodedHeader, encodedPayload, signature] = result.stdout.trim().split('.');
  const signingInput = `${encodedHeader}.${encodedPayload}`;
  const expectedSignature = createHmac('sha256', secret).update(signingInput, 'ascii').digest('base64url');
  assert.equal(signature, expectedSignature);
  return {
    header: JSON.parse(Buffer.from(encodedHeader, 'base64url').toString('utf8')),
    payload: JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')),
  };
}

function assertRejected(args, overrides, message) {
  const result = invoke(args, overrides);
  assert.equal(result.status, 2, result.stderr);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, message);
}

test('DEV_ONLY issuer refuses disabled, wrong-profile, and weak-secret configurations', () => {
  assertRejected(requiredArguments, { MEDIA_DEV_IDENTITY_ENABLED: 'false' }, /available only/u);
  assertRejected(requiredArguments, { MEDIA_RUNTIME_ENVIRONMENT: 'production' }, /available only/u);
  assertRejected(requiredArguments, { MEDIA_RUNTIME_ENVIRONMENT: 'local' }, /available only/u);
  assertRejected(requiredArguments, { MEDIA_DEV_JWT_HMAC_SECRET: 'short' }, /at least 32 UTF-8 bytes/u);
  assertRejected(requiredArguments, { MEDIA_DEV_JWT_HMAC_SECRET: null }, /at least 32 UTF-8 bytes/u);
});

test('default token has exact DEV_ONLY claims and a valid HMAC signature', () => {
  const { header, payload } = decodeToken(invoke());
  assert.deepEqual(header, { alg: 'HS256', typ: 'JWT' });
  assert.deepEqual(payload, {
    sub: 'principal-a',
    tenant_id: 'tenant-a',
    iss: 'urn:ghatana:media:dev-only',
    aud: 'ghatana-media-dev',
    dev_only: true,
    iat: payload.iat,
    exp: payload.exp,
    permissions: ['media:job:read'],
  });
  assert.ok(Number.isSafeInteger(payload.iat));
  assert.ok(Number.isSafeInteger(payload.exp));
  assert.equal(payload.exp - payload.iat, 120);
});

test('only the explicit 30..300 second integer lifetime is accepted', () => {
  for (const lifetime of [30, 300]) {
    const { payload } = decodeToken(invoke([...requiredArguments, '--expires-in', String(lifetime)]));
    assert.equal(payload.exp - payload.iat, lifetime);
  }
  for (const lifetime of ['29', '301', '30.5', 'NaN', 'Infinity']) {
    assertRejected([...requiredArguments, '--expires-in', lifetime], {}, /between 30 and 300/u);
  }
  assertRejected([...requiredArguments, '--expires-in', '60', '--expires-in', '90'], {}, /Usage:/u);
});

test('identity values, option names, and required permission list fail closed', () => {
  assertRejected(['--tenant', 'tenant a', ...requiredArguments.slice(2)], {}, /visible ASCII/u);
  assertRejected(['--tenant', 'tenant-a', '--subject', '主體', ...requiredArguments.slice(4)], {}, /visible ASCII/u);
  assertRejected(['--subject', 'principal-a', '--permission', 'media:job:read'], {}, /Missing required --tenant/u);
  assertRejected(['--tenant'], {}, /Missing value for --tenant/u);
  assertRejected(['--tenant', 'tenant-a', '--permission', 'media:job:read'], {}, /Missing required --subject/u);
  assertRejected(['--tenant', 'tenant-a', '--subject', 'other', '--subject', 'principal-a', '--permission', 'media:job:read'], {}, /Usage:/u);
  assertRejected([...requiredArguments, '--unexpected', 'value'], {}, /Usage:/u);
  assertRejected(['--tenant', 'tenant-a', '--subject', 'principal-a'], {}, /At least one explicit/u);
  assertRejected([...requiredArguments, '--permission', 'media:job:read'], {}, /unique/u);
  assertRejected(['--tenant', 'tenant-a', '--subject', 'principal-a', '--permission', 'media:job:admin'], {}, /development permission allowlist/u);
});

test('script permission allowlist exactly matches canonical and DEV_ONLY route permissions', () => {
  const scriptText = readFileSync(script, 'utf8');
  const manifestPath = resolve(root, 'launcher/src/main/java/com/ghatana/media/launcher/MediaRouteManifest.java');
  const manifestText = readFileSync(manifestPath, 'utf8');
  const devRoutePath = resolve(root, 'launcher/src/main/java/com/ghatana/media/launcher/MediaDevOnlyRoutePermissions.java');
  const devRouteText = readFileSync(devRoutePath, 'utf8');
  const allowlist = scriptText.match(/const PERMISSION_ALLOWLIST = new Set\(\[([\s\S]*?)\n\]\);/u)?.[1];
  const requiredPermission = manifestText.match(/public static String requiredPermission\([\s\S]*?\n    \}/u)?.[0];
  const devPermission = devRouteText.match(/static final String PROJECT_[A-Z]+ = "media:project:dev:[a-z]+";/gu)?.join('\n');
  assert.ok(allowlist, 'script allowlist should remain statically inspectable');
  assert.ok(requiredPermission, 'manifest permission method should remain statically inspectable');
  assert.ok(devPermission, 'development-only route permissions should remain statically inspectable');
  const scripted = [...allowlist.matchAll(/'((?:media:)[a-z:-]+)'/gu)].map((match) => match[1]).sort();
  const manifested = [...requiredPermission.matchAll(/return "((?:media:)[a-z:-]+)"/gu)].map((match) => match[1]);
  const devPermissions = [...devPermission.matchAll(/"((?:media:)[a-z:-]+)"/gu)].map((match) => match[1]);
  assert.deepEqual(scripted, [...manifested, ...devPermissions].sort());
});
