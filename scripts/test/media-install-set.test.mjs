// Source-free consumer test: the verifier must accept a well-formed set and refuse missing, wrong-version
// and tampered artifacts. Uses a synthetic set (tiny fake jars); a real set is checked when MEDIA_INSTALL_SET is set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, cpSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  GRPC_API_RPC_SURFACE_OBSERVATION,
  MANIFEST_NAME,
  SCHEMA,
  REQUIRED_MAVEN,
  REQUIRED_PROVIDER_ADMISSIONS,
  fileEntry,
  fingerprintOf,
  verifyInstallSet,
} from '../lib/media-install-set.mjs';

const V = '0.1.0-SNAPSHOT';
const POM_NS = 'http://maven.apache.org/POM/4.0.0';
function build(version = V) {
  const root = mkdtempSync(path.join(tmpdir(), 'media-set-'));
  const w = (rel, data) => { const a = path.join(root, rel); mkdirSync(path.dirname(a), { recursive: true }); writeFileSync(a, data); };
  const mavenArtifacts = REQUIRED_MAVEN.map(({ groupId, artifactId }) => {
    const dir = `${groupId.split('.').join('/')}/${artifactId}/${version}`;
    const b = `${artifactId}-${version}`;
    w(`${dir}/${b}.jar`, Buffer.concat([Buffer.from('PK'), Buffer.from(artifactId)]));
    w(`${dir}/${b}.pom`, `<project xmlns="${POM_NS}"><groupId>${groupId}</groupId><artifactId>${artifactId}</artifactId><version>${version}</version></project>`);
    w(`${dir}/${b}.module`, JSON.stringify({ component: { group: groupId, module: artifactId, version } }));
    return {
      groupId,
      artifactId,
      version,
      files: ['jar', 'pom', 'module'].map((e) => fileEntry(root, `${dir}/${b}.${e}`)),
      ...(artifactId === 'grpc-api' ? { rpcSurfaceObservation: GRPC_API_RPC_SURFACE_OBSERVATION } : {}),
    };
  });
  const pj = path.join(root, 'pkgsrc/package');
  mkdirSync(pj, { recursive: true });
  writeFileSync(path.join(pj, 'package.json'), JSON.stringify({ name: '@ghatana-media/security-scanner-provider', version }));
  mkdirSync(path.join(root, 'npm'), { recursive: true });
  execFileSync('tar', ['-czf', path.join(root, 'npm/scanner.tgz'), '-C', path.join(root, 'pkgsrc'), 'package']);
  rmSync(path.join(root, 'pkgsrc'), { recursive: true });
  const t = fileEntry(root, 'npm/scanner.tgz');
  const manifest = {
    schemaVersion: SCHEMA,
    mediaVersion: version,
    mavenArtifacts,
    npmPackages: [{ name: '@ghatana-media/security-scanner-provider', version, file: t.path, size: t.size, sha256: t.sha256 }],
    providerAdmission: {
      'security-scanner': 'NOT_ADMITTED: test fixture only',
      'document-intelligence': 'NOT_ADMITTED: test fixture only',
      'media-stt': 'NOT_ADMITTED: test fixture only',
    },
  };
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
const grpcApiArtifact = (root) => JSON.parse(readFileSync(path.join(root, MANIFEST_NAME), 'utf8'))
  .mavenArtifacts.find((artifact) => artifact.artifactId === 'grpc-api');

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
test('POM coordinates must be root project coordinates, not only dependency coordinates', () => {
  const r = build();
  const artifact = REQUIRED_MAVEN[0];
  const rel = `${artifact.groupId.split('.').join('/')}/${artifact.artifactId}/${V}/${artifact.artifactId}-${V}.pom`;
  writeFileSync(path.join(r, rel), `<!-- <project xmlns="${POM_NS}"><groupId>${artifact.groupId}</groupId><artifactId>${artifact.artifactId}</artifactId><version>${V}</version></project> -->\n<project xmlns="${POM_NS}"><dependencies><dependency><groupId>${artifact.groupId}</groupId><artifactId>${artifact.artifactId}</artifactId><version>${V}</version></dependency></dependencies></project>`);
  rewrite(r, (m) => {
    const file = m.mavenArtifacts.find((entry) => entry.artifactId === artifact.artifactId).files.find((entry) => entry.path === rel);
    Object.assign(file, fileEntry(r, rel));
  });
  assert.match(verifyInstallSet(r).errors.join('\n'), /\.pom root coordinates disagree/);
});
test('malformed POM tag nesting and non-Maven root namespaces are refused', () => {
  const r = build();
  const artifact = REQUIRED_MAVEN[0];
  const rel = `${artifact.groupId.split('.').join('/')}/${artifact.artifactId}/${V}/${artifact.artifactId}-${V}.pom`;
  writeFileSync(path.join(r, rel), `<project xmlns="${POM_NS}"><groupId>${artifact.groupId}</wrongClose><artifactId>${artifact.artifactId}</artifactId><version>${V}</version></project>`);
  rewrite(r, (m) => {
    const file = m.mavenArtifacts.find((entry) => entry.artifactId === artifact.artifactId).files.find((entry) => entry.path === rel);
    Object.assign(file, fileEntry(r, rel));
  });
  assert.match(verifyInstallSet(r).errors.join('\n'), /\.pom root coordinates disagree/);

  writeFileSync(path.join(r, rel), `<bad:project xmlns:bad="urn:not-maven"><bad:groupId>${artifact.groupId}</bad:groupId><bad:artifactId>${artifact.artifactId}</bad:artifactId><bad:version>${V}</bad:version></bad:project>`);
  rewrite(r, (m) => {
    const file = m.mavenArtifacts.find((entry) => entry.artifactId === artifact.artifactId).files.find((entry) => entry.path === rel);
    Object.assign(file, fileEntry(r, rel));
  });
  assert.match(verifyInstallSet(r).errors.join('\n'), /\.pom root coordinates disagree/);
});
test('POM content after the root element is refused', () => {
  const r = build();
  const artifact = REQUIRED_MAVEN[0];
  const rel = `${artifact.groupId.split('.').join('/')}/${artifact.artifactId}/${V}/${artifact.artifactId}-${V}.pom`;
  writeFileSync(path.join(r, rel), `<project xmlns="${POM_NS}"><groupId>${artifact.groupId}</groupId><artifactId>${artifact.artifactId}</artifactId><version>${V}</version></project>junk`);
  rewrite(r, (m) => {
    const file = m.mavenArtifacts.find((entry) => entry.artifactId === artifact.artifactId).files.find((entry) => entry.path === rel);
    Object.assign(file, fileEntry(r, rel));
  });
  assert.match(verifyInstallSet(r).errors.join('\n'), /\.pom root coordinates disagree/);
});
test('artifact file labels must agree with paths so content checks cannot be bypassed', () => {
  const r = build();
  rewrite(r, (m) => {
    const jar = m.mavenArtifacts[0].files.find((file) => file.path.endsWith('.jar'));
    jar.name = 'renamed.txt';
  });
  assert.match(verifyInstallSet(r).errors.join('\n'), /manifest file name disagrees with path/);
});
test('gRPC API observation preserves the 45-RPC denominator and two unbound Vision RPCs', () => {
  const r = build();
  assert.deepEqual(grpcApiArtifact(r).rpcSurfaceObservation, GRPC_API_RPC_SURFACE_OBSERVATION);
  assert.equal(verifyInstallSet(r).ok, true);
});
test('missing or promoted unbound Vision RPC observations are refused', () => {
  const r = build();
  rewrite(r, (m) => {
    const grpcApi = m.mavenArtifacts.find((artifact) => artifact.artifactId === 'grpc-api');
    grpcApi.rpcSurfaceObservation.pdp1UnboundRpcs[0].operationAdmission = 'ADMITTED';
  });
  assert.match(verifyInstallSet(r).errors.join('\n'), /RPC surface observation is missing or disagrees/);
});
test('provider admission cannot be promoted by artifact packaging', () => {
  const r = build(); rewrite(r, (m) => { m.providerAdmission['media-stt'] = 'ADMITTED'; });
  assert.match(verifyInstallSet(r).errors.join('\n'), /providerAdmission must remain NOT_ADMITTED/);
});
test('provider admission cannot be omitted', () => {
  const r = build();
  rewrite(r, (m) => {
    m.providerAdmission = Object.fromEntries(
      REQUIRED_PROVIDER_ADMISSIONS.slice(0, 2).map((key) => [key, 'NOT_ADMITTED: fixture']),
    );
  });
  assert.match(verifyInstallSet(r).errors.join('\n'), /providerAdmission must remain NOT_ADMITTED/);
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
