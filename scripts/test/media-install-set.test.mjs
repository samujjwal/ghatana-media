// Source-free consumer test: the verifier must accept a well-formed set and refuse missing, wrong-version
// and tampered artifacts. Uses a synthetic set (tiny fake jars); a real set is checked when MEDIA_INSTALL_SET is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { MANIFEST_NAME, SCHEMA, REQUIRED_MAVEN, fileEntry, fingerprintOf, verifyInstallSet } from '../lib/media-install-set.mjs';

const V = '0.1.0-SNAPSHOT';
function build(version = V) {
  const root = mkdtempSync(path.join(tmpdir(), 'media-set-'));
  const w = (rel, data) => { const a = path.join(root, rel); mkdirSync(path.dirname(a), { recursive: true }); writeFileSync(a, data); };
  const mavenArtifacts = REQUIRED_MAVEN.map(({ groupId, artifactId }) => {
    const dir = `${groupId.split('.').join('/')}/${artifactId}/${version}`;
    const b = `${artifactId}-${version}`;
    w(`${dir}/${b}.jar`, Buffer.concat([Buffer.from('PK'), Buffer.from(artifactId)]));
    w(`${dir}/${b}.pom`, `<project><groupId>${groupId}</groupId><version>${version}</version></project>`);
    w(`${dir}/${b}.module`, JSON.stringify({ component: { group: groupId, module: artifactId, version } }));
    return { groupId, artifactId, version, files: ['jar', 'pom', 'module'].map((e) => fileEntry(root, `${dir}/${b}.${e}`)) };
  });
  const pj = path.join(root, 'pkgsrc/package');
  mkdirSync(pj, { recursive: true });
  writeFileSync(path.join(pj, 'package.json'), JSON.stringify({ name: '@ghatana-media/security-scanner-provider', version }));
  mkdirSync(path.join(root, 'npm'), { recursive: true });
  execFileSync('tar', ['-czf', path.join(root, 'npm/scanner.tgz'), '-C', path.join(root, 'pkgsrc'), 'package']);
  rmSync(path.join(root, 'pkgsrc'), { recursive: true });
  const t = fileEntry(root, 'npm/scanner.tgz');
  const manifest = { schemaVersion: SCHEMA, mediaVersion: version, mavenArtifacts, npmPackages: [{ name: '@ghatana-media/security-scanner-provider', version, file: t.path, size: t.size, sha256: t.sha256 }] };
  manifest.manifestFingerprint = fingerprintOf(manifest);
  writeFileSync(path.join(root, MANIFEST_NAME), JSON.stringify(manifest, null, 2));
  return root;
}
const rewrite = (root, fn) => {
  const p = path.join(root, MANIFEST_NAME);
  const m = JSON.parse(readFileSync(p, 'utf8'));
  fn(m);
  m.manifestFingerprint = fingerprintOf(m); // re-sealed: isolates the specific check under test
  writeFileSync(p, JSON.stringify(m));
};
const jarOf = (root) => path.join(root, 'dev/ghatana/documentintelligence/document-intelligence-java-client', V, `document-intelligence-java-client-${V}.jar`);

test('well-formed set is accepted', () => {
  const r = build(); const v = verifyInstallSet(r); assert.deepEqual(v.errors, []); assert.equal(v.ok, true);
});
test('missing manifest is refused', () => {
  const r = build(); rmSync(path.join(r, MANIFEST_NAME)); assert.equal(verifyInstallSet(r).ok, false);
});
test('missing artifact file is refused', () => {
  const r = build(); rmSync(jarOf(r)); assert.match(verifyInstallSet(r).errors.join('\n'), /missing file/);
});
test('missing required coordinate is refused', () => {
  const r = build(); rewrite(r, (m) => { m.mavenArtifacts.pop(); }); assert.match(verifyInstallSet(r).errors.join('\n'), /missing required artifact/);
});
test('wrong (bumped) version is refused', () => {
  const r = build('0.2.0'); assert.match(verifyInstallSet(r).errors.join('\n'), /not a development version|wrong version/);
});
test('tampered jar is refused', () => {
  const r = build(); writeFileSync(jarOf(r), Buffer.from('PKevil')); assert.match(verifyInstallSet(r).errors.join('\n'), /sha256 mismatch|size mismatch/);
});
test('edited manifest digest without re-seal is refused', () => {
  const r = build(); const p = path.join(r, MANIFEST_NAME); const m = JSON.parse(readFileSync(p, 'utf8'));
  m.mavenArtifacts[0].files[0].sha256 = '0'.repeat(64); writeFileSync(p, JSON.stringify(m));
  assert.match(verifyInstallSet(r).errors.join('\n'), /fingerprint mismatch/);
});
test('re-sealed manifest with wrong digest is still refused by file check', () => {
  const r = build(); rewrite(r, (m) => { m.mavenArtifacts[0].files[0].sha256 = '0'.repeat(64); });
  assert.match(verifyInstallSet(r).errors.join('\n'), /sha256 mismatch/);
});
test('tampered npm tarball is refused', () => {
  const r = build(); writeFileSync(path.join(r, 'npm/scanner.tgz'), 'x'); assert.equal(verifyInstallSet(r).ok, false);
});
test('path traversal in manifest is refused', () => {
  const r = build(); rewrite(r, (m) => { m.mavenArtifacts[0].files[0].path = '../../etc/passwd'; });
  assert.match(verifyInstallSet(r).errors.join('\n'), /unsafe path/);
});
test('real install set (MEDIA_INSTALL_SET) verifies and a copy with one flipped byte is refused', { skip: !process.env.MEDIA_INSTALL_SET }, () => {
  const real = process.env.MEDIA_INSTALL_SET;
  assert.deepEqual(verifyInstallSet(real).errors, []);
  const copy = mkdtempSync(path.join(tmpdir(), 'media-real-copy-'));
  cpSync(real, copy, { recursive: true });
  const m = JSON.parse(readFileSync(path.join(copy, MANIFEST_NAME), 'utf8'));
  const jar = path.join(copy, m.mavenArtifacts[0].files.find((f) => f.name.endsWith('.jar')).path);
  const b = readFileSync(jar); b[b.length - 1] ^= 1; writeFileSync(jar, b);
  assert.equal(verifyInstallSet(copy).ok, false);
});
