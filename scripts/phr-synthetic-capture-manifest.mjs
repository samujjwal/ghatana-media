#!/usr/bin/env node
// MED-08: validation + build-digest tooling for the five-origin synthetic PHR Web capture manifest.
// Capture itself is done by the existing Media engine (@audio-video/client recorder-orchestrator,
// capture-adapters, production-studio/interactive-demo). PHR supplies only scenario scripts and builds;
// this tool neither captures nor duplicates a capture engine. Dependency-free (node:* only).
//
//   node scripts/phr-synthetic-capture-manifest.mjs validate <manifest.json> [--build-dir <audience>=<dir> ...]
//   node scripts/phr-synthetic-capture-manifest.mjs digest <dir>
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const REQUIRED_AUDIENCES = ['doctor', 'patient', 'facility', 'pharmacy', 'phr.coordination'];
const SHA = /^sha256:[a-f0-9]{64}$/u;
const SYNTHETIC_HOST = /(^|\.)(example|invalid|test|localhost)$|^(127\.0\.0\.1|\[::1\])$/u;

/** Deterministic digest of a build directory: sorted relative paths + file bytes. */
export function digestDirectory(dir) {
  const files = [];
  (function walk(current) {
    for (const entry of readdirSync(current).sort()) {
      const full = path.join(current, entry);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  })(dir);
  const hash = createHash('sha256');
  for (const file of files) {
    hash.update(path.relative(dir, file).split(path.sep).join('/')).update('\0');
    hash.update(createHash('sha256').update(readFileSync(file)).digest()).update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

/** Heuristic privacy scan over every string value. Findings mean the manifest must not be published. */
export function privacyFindings(value, pointer = '') {
  const findings = [];
  if (typeof value === 'string') {
    if (/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/iu.test(value)) {
      const domain = value.match(/@([A-Z0-9.-]+\.[A-Z]{2,})/iu)?.[1] ?? '';
      if (!SYNTHETIC_HOST.test(domain.toLowerCase())) findings.push(`${pointer}: non-synthetic email address`);
    }
    if (/(?<![\w.-])\+?\d[\d\s-]{8,}\d(?![\w.-])/u.test(value) && !SHA.test(value) && !/^[a-f0-9]{64}$/u.test(value)) {
      findings.push(`${pointer}: phone-number or identifier-like digit run`);
    }
    for (const url of value.match(/https?:\/\/[^\s"']+/giu) ?? []) {
      let host = '';
      try { host = new URL(url).hostname.toLowerCase(); } catch { findings.push(`${pointer}: malformed URL`); continue; }
      if (!SYNTHETIC_HOST.test(host)) findings.push(`${pointer}: non-synthetic host ${host}`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findings.push(...privacyFindings(v, `${pointer}/${i}`)));
  } else if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) findings.push(...privacyFindings(v, `${pointer}/${k}`));
  }
  return findings;
}

/** @returns {string[]} problems; empty means valid. */
export function validateManifest(manifest, { buildDirs = {} } = {}) {
  const problems = [];
  const need = (cond, msg) => { if (!cond) problems.push(msg); };
  need(manifest?.schemaVersion === 'media.phr-synthetic-capture-manifest.v1', 'schemaVersion must be media.phr-synthetic-capture-manifest.v1');
  need(typeof manifest?.manifestId === 'string' && manifest.manifestId !== '', 'manifestId required');
  need(!Number.isNaN(Date.parse(manifest?.generatedAt)), 'generatedAt must be a date-time');
  need(SHA.test(manifest?.engine?.recorderOrchestratorRef ?? ''), 'engine.recorderOrchestratorRef must be sha256:<hex>');
  need(manifest?.engine?.package === '@audio-video/client', 'engine.package must be @audio-video/client (no duplicate capture engine)');
  const origins = Array.isArray(manifest?.origins) ? manifest.origins : [];
  need(origins.length === 5, 'exactly five origins required');
  const audiences = origins.map((o) => o?.appAudience);
  for (const a of REQUIRED_AUDIENCES) need(audiences.includes(a), `missing origin audience ${a}`);
  need(new Set(audiences).size === audiences.length, 'origin audiences must be distinct');
  need(new Set(origins.map((o) => o?.originId)).size === origins.length, 'originIds must be distinct');
  need(new Set(origins.map((o) => o?.baseUrl)).size === origins.length, 'origin base URLs must be distinct');
  need(new Set(origins.map((o) => o?.buildDigest)).size === origins.length, 'each origin needs its own independent build artifact digest');
  for (const o of origins) {
    const id = o?.originId ?? '?';
    need(SHA.test(o?.buildDigest ?? ''), `${id}: buildDigest must be sha256:<hex>`);
    need(Array.isArray(o?.fixtureIds) && o.fixtureIds.length > 0, `${id}: fixtureIds required`);
    need(Array.isArray(o?.captures) && o.captures.length > 0, `${id}: at least one capture required`);
    for (const c of o?.captures ?? []) {
      need(SHA.test(c?.sourceDigest ?? ''), `${id}/${c?.sceneId}: sourceDigest must be sha256:<hex>`);
      need(['CAPTURED', 'UNAVAILABLE', 'OUTCOME_UNKNOWN', 'DENIED'].includes(c?.outcome), `${id}/${c?.sceneId}: invalid outcome`);
      need(c?.redacted === true, `${id}/${c?.sceneId}: capture must be redacted (redacted:true) before it is part of the package`);
    }
    const dir = buildDirs[o?.appAudience];
    if (dir) need(digestDirectory(dir) === o.buildDigest, `${id}: buildDigest does not match recomputed digest of ${dir}`);
  }
  const p = manifest?.privacy;
  need(p?.dataClass === 'SYNTHETIC' && p?.containsRealPersonalData === false, 'privacy must declare SYNTHETIC data with no real personal data');
  need(p?.scanResult === 'NO_FINDINGS', 'privacy.scanResult must be NO_FINDINGS');
  need(manifest?.classification?.clinicalEvidence === false && manifest?.classification?.sttAdmissionEvidence === false,
    'manifest must not be classified as clinical or STT admission evidence');
  need(manifest?.classification?.demoOnly === true && manifest?.classification?.safetyProof === false,
    'manifest must be labelled demoOnly:true and safetyProof:false (replayable demo by build digest, never safety proof)');
  for (const f of privacyFindings(manifest)) problems.push(`privacy scan: ${f}`);
  return problems;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [cmd, target, ...rest] = process.argv.slice(2);
  if (cmd === 'digest' && target) {
    console.log(digestDirectory(target));
  } else if (cmd === 'validate' && target) {
    const buildDirs = {};
    for (let i = 0; i < rest.length; i += 2) {
      if (rest[i] !== '--build-dir' || !rest[i + 1]?.includes('=')) { console.error('usage: --build-dir <audience>=<dir>'); process.exit(2); }
      const [audience, ...dir] = rest[i + 1].split('=');
      buildDirs[audience] = dir.join('=');
    }
    const problems = validateManifest(JSON.parse(readFileSync(target, 'utf8')), { buildDirs });
    for (const p of problems) console.error(`FAIL ${p}`);
    console.log(problems.length ? `INVALID (${problems.length})` : 'VALID');
    process.exit(problems.length ? 1 : 0);
  } else {
    console.error('usage: validate <manifest.json> [--build-dir audience=dir ...] | digest <dir>');
    process.exit(2);
  }
}
