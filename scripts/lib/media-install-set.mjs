// Pure helpers for the Media local-file install set (digest-pinned client artifacts).
// Source-free by design: verification reads ONLY the manifest and the files it names.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const MANIFEST_NAME = 'media-install-manifest.json';
export const SCHEMA = 'ghatana.media.install-manifest.v1';
// Development versions only: the standing rule is never to bump versions during development.
export const ALLOWED_VERSIONS = ['0.1.0-SNAPSHOT', '0.1.0'];
export const REQUIRED_MAVEN = [
  { groupId: 'com.ghatana.media', artifactId: 'runtime-contracts', role: 'media-stt' },
  { groupId: 'dev.ghatana.documentintelligence', artifactId: 'document-intelligence-java-client', role: 'document-intelligence' },
];
export const REQUIRED_NPM = [{ name: '@ghatana-media/security-scanner-provider', role: 'security-scanner' }];

export const sha256Hex = (buf) => createHash('sha256').update(buf).digest('hex');

/** Deterministic JSON: object keys sorted recursively. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

export function fingerprintOf(manifest) {
  const { manifestFingerprint: _omit, ...rest } = manifest;
  return `sha256:${sha256Hex(Buffer.from(canonicalJson(rest)))}`;
}

export function fileEntry(root, relPath) {
  const abs = path.join(root, relPath);
  const buf = readFileSync(abs);
  return { name: path.basename(relPath), path: relPath.split(path.sep).join('/'), sha256: sha256Hex(buf), size: buf.length };
}

/**
 * Verify an install set directory. Returns { ok, errors[] }; never throws for a bad set.
 * Refuses: missing manifest/artifact/file, wrong (non-development) version, size/digest mismatch,
 * tampered manifest, absent required coordinates, and coordinate disagreement with embedded metadata.
 */
export function verifyInstallSet(root, { requiredMaven = REQUIRED_MAVEN, requiredNpm = REQUIRED_NPM, allowedVersions = ALLOWED_VERSIONS } = {}) {
  const errors = [];
  const manifestPath = path.join(root, MANIFEST_NAME);
  if (!existsSync(manifestPath)) return { ok: false, errors: [`missing ${MANIFEST_NAME}`] };
  let manifest;
  try { manifest = JSON.parse(readFileSync(manifestPath, 'utf8')); } catch (e) { return { ok: false, errors: [`unparseable manifest: ${e.message}`] }; }
  if (manifest.schemaVersion !== SCHEMA) errors.push(`unexpected schemaVersion ${manifest.schemaVersion}`);
  if (manifest.manifestFingerprint !== fingerprintOf(manifest)) errors.push('manifest fingerprint mismatch (manifest modified)');
  if (!allowedVersions.includes(manifest.mediaVersion)) errors.push(`mediaVersion ${manifest.mediaVersion} is not a development version`);

  const checkFile = (f, label) => {
    if (typeof f.path !== 'string' || f.path.includes('..') || path.isAbsolute(f.path)) { errors.push(`${label}: unsafe path ${f.path}`); return null; }
    const abs = path.join(root, f.path);
    if (!existsSync(abs) || !statSync(abs).isFile()) { errors.push(`${label}: missing file ${f.path}`); return null; }
    const buf = readFileSync(abs);
    if (buf.length !== f.size) errors.push(`${label}: size mismatch ${f.path}`);
    if (sha256Hex(buf) !== f.sha256) errors.push(`${label}: sha256 mismatch ${f.path}`);
    const side = `${abs}.sha256`;
    if (existsSync(side) && !readFileSync(side, 'utf8').trim().startsWith(f.sha256)) errors.push(`${label}: sidecar disagrees with manifest ${f.path}`);
    return abs;
  };

  for (const req of requiredMaven) {
    const art = (manifest.mavenArtifacts ?? []).find((a) => a.groupId === req.groupId && a.artifactId === req.artifactId);
    if (!art) { errors.push(`missing required artifact ${req.groupId}:${req.artifactId}`); continue; }
    const label = `${art.groupId}:${art.artifactId}:${art.version}`;
    if (!allowedVersions.includes(art.version)) errors.push(`${label}: wrong version`);
    if (art.version !== manifest.mediaVersion) errors.push(`${label}: version differs from mediaVersion`);
    const base = `${art.artifactId}-${art.version}`;
    const dir = `${art.groupId.split('.').join('/')}/${art.artifactId}/${art.version}/`;
    for (const need of [`${base}.jar`, `${base}.pom`, `${base}.module`]) {
      if (!art.files?.some((f) => f.path === dir + need)) errors.push(`${label}: manifest lacks ${need}`);
    }
    for (const f of art.files ?? []) {
      const abs = checkFile(f, label);
      if (!abs) continue;
      if (f.name.endsWith('.jar') && !readFileSync(abs).subarray(0, 2).equals(Buffer.from('PK'))) errors.push(`${label}: ${f.name} is not a jar`);
      if (f.name.endsWith('.module')) {
        try {
          const c = JSON.parse(readFileSync(abs, 'utf8')).component;
          if (c?.group !== art.groupId || c?.module !== art.artifactId || c?.version !== art.version) errors.push(`${label}: .module coordinates disagree`);
        } catch { errors.push(`${label}: unparseable .module`); }
      }
      if (f.name.endsWith('.pom')) {
        const pom = readFileSync(abs, 'utf8');
        if (!pom.includes(`<groupId>${art.groupId}</groupId>`) || !pom.includes(`<version>${art.version}</version>`)) errors.push(`${label}: .pom coordinates disagree`);
      }
    }
  }
  for (const req of requiredNpm) {
    const pkg = (manifest.npmPackages ?? []).find((p) => p.name === req.name);
    if (!pkg) { errors.push(`missing required npm package ${req.name}`); continue; }
    const label = `${pkg.name}@${pkg.version}`;
    if (!allowedVersions.includes(pkg.version)) errors.push(`${label}: wrong version`);
    if (pkg.version !== manifest.mediaVersion) errors.push(`${label}: version differs from mediaVersion`);
    const abs = checkFile({ path: pkg.file, size: pkg.size, sha256: pkg.sha256 }, label);
    if (abs) {
      const r = spawnSync('tar', ['-xzOf', abs, 'package/package.json'], { encoding: 'utf8' });
      try {
        const j = JSON.parse(r.stdout);
        if (j.name !== pkg.name || j.version !== pkg.version) errors.push(`${label}: tarball package.json disagrees`);
      } catch { errors.push(`${label}: tarball unreadable`); }
    }
  }
  return { ok: errors.length === 0, errors };
}
