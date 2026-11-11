#!/usr/bin/env node
import { createHmac } from 'node:crypto';

const ISSUER = 'urn:ghatana:media:dev-only';
const AUDIENCE = 'ghatana-media-dev';
const MAX_LIFETIME_SECONDS = 300;
const PERMISSION_ALLOWLIST = new Set([
  'media:consent:create', 'media:consent:read', 'media:consent:revoke',
  'media:artifact:create', 'media:artifact:read', 'media:artifact:write',
  'media:job:create', 'media:job:read', 'media:job:cancel',
  'media:stream:create', 'media:stream:read', 'media:stream:write', 'media:stream:close',
  'media:provider:read', 'media:caption-version:write', 'media:caption-version:read',
  'media:project:dev:create', 'media:project:dev:read', 'media:project:dev:write',
]);

function fail(message) {
  console.error(message);
  process.exit(2);
}

function parseArgs(argv) {
  const result = { lifetime: 120, permissions: [] };
  const seen = new Set();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!['--tenant', '--subject', '--expires-in', '--permission'].includes(key)
        || (key !== '--permission' && seen.has(key))) {
      fail('Usage: node scripts/media-dev-identity-token.mjs --tenant ID --subject ID --permission PERMISSION [--permission PERMISSION ...] [--expires-in 30..300]');
    }
    seen.add(key);
    const value = argv[++index];
    if (!value) fail(`Missing value for ${key}`);
    if (key === '--tenant') result.tenant = value;
    else if (key === '--subject') result.subject = value;
    else if (key === '--permission') result.permissions.push(value);
    else result.lifetime = Number(value);
  }
  return result;
}

function visibleIdentity(name, value) {
  if (typeof value !== 'string' || !/^[\x21-\x7e]{1,255}$/u.test(value)) {
    fail(`${name} must contain 1-255 visible ASCII characters without whitespace`);
  }
  return value;
}

const profile = (process.env.MEDIA_RUNTIME_ENVIRONMENT ?? process.env.MEDIA_PROFILE ?? '').trim().toLowerCase();
if (process.env.MEDIA_DEV_IDENTITY_ENABLED !== 'true' || profile !== 'dev') {
  fail('Token minting is available only when MEDIA_DEV_IDENTITY_ENABLED=true and the Media profile is exactly dev');
}

const secret = process.env.MEDIA_DEV_JWT_HMAC_SECRET;
if (!secret || Buffer.byteLength(secret, 'utf8') < 32) {
  fail('MEDIA_DEV_JWT_HMAC_SECRET must contain at least 32 UTF-8 bytes');
}

const args = parseArgs(process.argv.slice(2));
if (!args.tenant) fail('Missing required --tenant');
if (!args.subject) fail('Missing required --subject');
const tenantId = visibleIdentity('--tenant', args.tenant);
const subject = visibleIdentity('--subject', args.subject);
if (!Number.isInteger(args.lifetime) || args.lifetime < 30 || args.lifetime > MAX_LIFETIME_SECONDS) {
  fail(`--expires-in must be between 30 and ${MAX_LIFETIME_SECONDS} seconds`);
}
if (args.permissions.length === 0) fail('At least one explicit Media development permission is required');
if (new Set(args.permissions).size !== args.permissions.length
    || args.permissions.some((permission) => !PERMISSION_ALLOWLIST.has(permission))) {
  fail('Every --permission must be unique and present in the Media development permission allowlist');
}

const now = Math.floor(Date.now() / 1000);
const header = { alg: 'HS256', typ: 'JWT' };
const payload = {
  sub: subject,
  tenant_id: tenantId,
  iss: ISSUER,
  aud: AUDIENCE,
  dev_only: true,
  iat: now,
  exp: now + args.lifetime,
  permissions: args.permissions,
};
const signingInput = [header, payload]
  .map((part) => Buffer.from(JSON.stringify(part)).toString('base64url'))
  .join('.');
const signature = createHmac('sha256', Buffer.from(secret, 'utf8'))
  .update(signingInput, 'ascii')
  .digest('base64url');
process.stdout.write(`${signingInput}.${signature}\n`);
