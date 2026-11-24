// Pure helpers for the Media local-file install set (digest-pinned client artifacts).
// Source-free by design: verification reads ONLY the manifest and the files it names.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';

export const MANIFEST_NAME = 'media-install-manifest.json';
export const SCHEMA = 'ghatana.media.install-manifest.v2';
const MAVEN_POM_NAMESPACE = 'http://maven.apache.org/POM/4.0.0';
// Development versions only: the standing rule is never to bump versions during development.
export const ALLOWED_VERSIONS = ['0.1.0-SNAPSHOT', '0.1.0'];
export const REQUIRED_MAVEN = [
  { groupId: 'com.ghatana.media', artifactId: 'runtime-contracts', role: 'media-stt' },
  { groupId: 'dev.ghatana.documentintelligence', artifactId: 'document-intelligence-java-client', role: 'document-intelligence' },
  { groupId: 'com.ghatana.audio-video', artifactId: 'grpc-api', role: 'media-grpc-api' },
];
export const REQUIRED_NPM = [{ name: '@ghatana-media/security-scanner-provider', role: 'security-scanner' }];
export const REQUIRED_PROVIDER_ADMISSIONS = ['security-scanner', 'document-intelligence', 'media-stt'];
export const GRPC_API_RPC_SURFACE_OBSERVATION = Object.freeze({
  sourceApiMethodCount: 45,
  pdp1UnboundRpcs: Object.freeze([
    Object.freeze({
      identity: 'VisionService.RecognizeSceneText',
      pdp1Binding: 'UNBOUND',
      operationAdmission: 'NOT_ADMITTED',
    }),
    Object.freeze({
      identity: 'VisionService.ResolveSourceFrame',
      pdp1Binding: 'UNBOUND',
      operationAdmission: 'NOT_ADMITTED',
    }),
  ]),
});

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

function rootPomCoordinates(xml) {
  const values = { groupId: '', artifactId: '', version: '' };
  let current = null;
  let rootSeen = false;
  let rootEnded = false;
  const stack = [];
  const tokenPattern = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<\?[\s\S]*?\?>|<!DOCTYPE[\s\S]*?>|<[^>]+>|[^<]+/g;
  let tokenOffset = 0;
  for (const match of xml.matchAll(tokenPattern)) {
    if (match.index !== tokenOffset) return null;
    const token = match[0];
    tokenOffset += token.length;
    if (rootEnded) {
      if (token.startsWith('<!--') || (token.startsWith('<?') && !/^<\?xml(?:\s|\?>)/u.test(token))) continue;
      if (!token.startsWith('<') && /^\s*$/u.test(token)) continue;
      return null;
    }
    if (token.startsWith('<!--') || token.startsWith('<?') || token.startsWith('<!DOCTYPE')) continue;
    if (token.startsWith('<![CDATA[')) {
      if (stack.length === 2 && current && Object.hasOwn(values, current)) values[current] += token.slice(9, -3);
      continue;
    }
    if (token.startsWith('</')) {
      const qName = token.match(/^<\/\s*([A-Za-z_][\w:.-]*)/u)?.[1];
      if (!qName || stack.at(-1)?.qName !== qName) return null;
      stack.pop();
      if (stack.length === 1) current = null;
      if (stack.length === 0) {
        rootEnded = true;
        continue;
      }
      continue;
    }
    if (token.startsWith('<')) {
      const nameMatch = token.match(/^<\s*([A-Za-z_][\w:.-]*)/u);
      if (!nameMatch) return null;
      const qName = nameMatch[1];
      const localName = qName.split(':').at(-1);
      const selfClosing = /\/\s*>$/u.test(token);
      const attributes = token.slice(nameMatch[0].length, selfClosing ? -2 : -1);
      const parentNamespaces = stack.at(-1)?.namespaces ?? new Map();
      const namespaces = new Map(parentNamespaces);
      for (const match of attributes.matchAll(/([A-Za-z_][\w:.-]*)\s*=\s*(?:"([^"]*)"|'([^']*)')/gu)) {
        const attribute = match[1];
        if (attribute === 'xmlns') namespaces.set('', match[2] ?? match[3] ?? '');
        else if (attribute.startsWith('xmlns:')) namespaces.set(attribute.slice(6), match[2] ?? match[3] ?? '');
      }
      const prefix = qName.includes(':') ? qName.slice(0, qName.indexOf(':')) : '';
      const namespace = namespaces.get(prefix) ?? '';
      if (!rootSeen) {
        if (localName !== 'project' || namespace !== MAVEN_POM_NAMESPACE) return null;
        rootSeen = true;
      } else if (stack.length === 1 && Object.hasOwn(values, localName) && namespace === MAVEN_POM_NAMESPACE) {
        current = localName;
      } else if (stack.length === 1) {
        current = null;
      }
      if (rootSeen && stack.length === 0) {
        if (selfClosing) rootEnded = true;
        else stack.push({ qName, namespaces });
        continue;
      }
      if (!selfClosing) stack.push({ qName, namespaces });
      else if (stack.length === 1) current = null;
      continue;
    }
    if (stack.length === 2 && current && Object.hasOwn(values, current)) values[current] += token;
  }
  if (tokenOffset !== xml.length || !rootSeen || !rootEnded) return null;
  const decode = (value) => value.trim()
    .replace(/&#x([0-9a-f]+);/giu, (_entity, hex) => decodeCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/gu, (_entity, decimal) => decodeCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&(?:amp|lt|gt|quot|apos);/gu, (entity) => ({
      '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&apos;': "'",
    })[entity]);
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, decode(value)]));
}

function decodeCodePoint(codePoint) {
  if (!Number.isInteger(codePoint) || codePoint < 0 || codePoint > 0x10ffff
    || (codePoint >= 0xd800 && codePoint <= 0xdfff)) return '\ufffd';
  return String.fromCodePoint(codePoint);
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
      if (typeof f.path === 'string' && f.name !== path.basename(f.path)) {
        errors.push(`${label}: manifest file name disagrees with path ${f.path}`);
      }
      const abs = checkFile(f, label);
      if (!abs) continue;
      const extension = path.extname(f.path);
      if (extension === '.jar' && !readFileSync(abs).subarray(0, 2).equals(Buffer.from('PK'))) errors.push(`${label}: ${f.path} is not a jar`);
      if (extension === '.module') {
        try {
          const c = JSON.parse(readFileSync(abs, 'utf8')).component;
          if (c?.group !== art.groupId || c?.module !== art.artifactId || c?.version !== art.version) errors.push(`${label}: .module coordinates disagree`);
        } catch { errors.push(`${label}: unparseable .module`); }
      }
      if (extension === '.pom') {
        const coordinates = rootPomCoordinates(readFileSync(abs, 'utf8'));
        if (coordinates?.groupId !== art.groupId
          || coordinates?.artifactId !== art.artifactId
          || coordinates?.version !== art.version) errors.push(`${label}: .pom root coordinates disagree`);
      }
    }
    if (art.artifactId === 'grpc-api'
      && canonicalJson(art.rpcSurfaceObservation) !== canonicalJson(GRPC_API_RPC_SURFACE_OBSERVATION)) {
      errors.push(`${label}: RPC surface observation is missing or disagrees with the current source/API denominator`);
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
  if (!manifest.providerAdmission
    || REQUIRED_PROVIDER_ADMISSIONS.some((provider) => typeof manifest.providerAdmission[provider] !== 'string')
    || Object.values(manifest.providerAdmission)
    .some((status) => typeof status !== 'string' || !status.startsWith('NOT_ADMITTED:'))) {
    errors.push('providerAdmission must remain NOT_ADMITTED for every packaged provider');
  }
  return { ok: errors.length === 0, errors };
}
