import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { REQUIRED_AUDIENCES, digestDirectory, privacyFindings, validateManifest } from './phr-synthetic-capture-manifest.mjs';

const h = (c) => `sha256:${c.repeat(64)}`;
function manifest() {
  return {
    schemaVersion: 'media.phr-synthetic-capture-manifest.v1', manifestId: 'm1', generatedAt: '2026-11-12T00:00:00Z',
    engine: { package: '@audio-video/client', packageVersion: '0.1.0', recorderOrchestratorRef: h('f'), captureAdapterKinds: ['BROWSER'] },
    origins: REQUIRED_AUDIENCES.map((a, i) => ({
      originId: `phr-${a}`, appAudience: a, baseUrl: `https://${a.replace('.', '-')}.phr.test`, buildDigest: h('abcde'[i]),
      scenarioRef: `scenario-${a}`, fixtureIds: [`synthetic-${a}`],
      captures: [{ sceneId: 'home', adapterKind: 'BROWSER', outcome: 'CAPTURED', sourceDigest: h('1'), redacted: true }],
    })),
    privacy: { dataClass: 'SYNTHETIC', containsRealPersonalData: false, redactionPolicyRef: 'redaction-v1', scanner: 'phr-synthetic-capture-manifest.mjs/privacy-scan.v1', scanResult: 'NO_FINDINGS' },
    classification: { clinicalEvidence: false, sttAdmissionEvidence: false, demoOnly: true, safetyProof: false },
  };
}

test('a complete synthetic five-origin manifest is valid', () => assert.deepEqual(validateManifest(manifest()), []));

test('requires exactly five distinct audiences with independent build digests', () => {
  const m = manifest(); m.origins.pop();
  assert.ok(validateManifest(m).some((p) => /exactly five/.test(p)));
  const dup = manifest(); dup.origins[1].buildDigest = dup.origins[0].buildDigest;
  assert.ok(validateManifest(dup).some((p) => /independent build artifact/.test(p)));
  const sameAud = manifest(); sameAud.origins[1].appAudience = 'doctor';
  assert.ok(validateManifest(sameAud).some((p) => /distinct/.test(p)));
});

test('privacy scan rejects real-looking emails, phones and non-synthetic hosts', () => {
  assert.ok(privacyFindings({ a: 'jane.doe@gmail.com' }).length > 0);
  assert.ok(privacyFindings({ a: 'call +977 9841234567' }).length > 0);
  assert.ok(privacyFindings({ a: 'https://real-hospital.org.np/patient' }).length > 0);
  assert.deepEqual(privacyFindings({ a: 'synthetic@phr.test', b: 'http://127.0.0.1:4173/x', c: h('a') }), []);
  const m = manifest(); m.origins[0].baseUrl = 'https://app.realclinic.com.np';
  assert.ok(validateManifest(m).some((p) => /non-synthetic host/.test(p)));
});

test('cannot be classified as clinical or STT admission evidence, nor claim real data', () => {
  const m = manifest(); m.classification.clinicalEvidence = true; m.privacy.containsRealPersonalData = true;
  const problems = validateManifest(m);
  assert.ok(problems.some((p) => /clinical or STT admission/.test(p)));
  assert.ok(problems.some((p) => /SYNTHETIC data/.test(p)));
});

test('build digest is recomputed from the build directory (tamper detected)', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'phr-build-'));
  try {
    mkdirSync(path.join(root, 'assets'));
    writeFileSync(path.join(root, 'index.html'), '<html>doctor</html>');
    writeFileSync(path.join(root, 'assets/app.js'), 'console.log(1)');
    const d = digestDirectory(root);
    assert.equal(digestDirectory(root), d, 'deterministic');
    const m = manifest(); m.origins[0].buildDigest = d;
    assert.deepEqual(validateManifest(m, { buildDirs: { doctor: root } }), []);
    writeFileSync(path.join(root, 'assets/app.js'), 'console.log(2)');
    assert.ok(validateManifest(m, { buildDirs: { doctor: root } }).some((p) => /does not match recomputed/.test(p)));
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('package must be labelled demo-only (never safety proof) and every capture redacted', () => {
  const a = manifest(); a.classification.demoOnly = false;
  assert.match(validateManifest(a).join('\n'), /demoOnly:true/);
  const b = manifest(); b.classification.safetyProof = true;
  assert.match(validateManifest(b).join('\n'), /safetyProof:false/);
  const c = manifest(); delete c.classification.demoOnly;
  assert.ok(validateManifest(c).length > 0);
  const d = manifest(); d.origins[2].captures[0].redacted = false;
  assert.match(validateManifest(d).join('\n'), /must be redacted/);
});

test('conformance by exact build digest: five real build dirs pass, one changed byte or a swapped build fails', () => {
  const root = mkdtempSync(path.join(tmpdir(), 'cap-conf-'));
  try {
    const dirs = {}; const m = manifest();
    m.origins.forEach((o, i) => {
      const d = path.join(root, o.appAudience); mkdirSync(path.join(d, 'assets'), { recursive: true });
      writeFileSync(path.join(d, 'index.html'), `<html>${o.appAudience}</html>`); writeFileSync(path.join(d, 'assets', 'app.js'), `// ${i}`);
      o.buildDigest = digestDirectory(d); dirs[o.appAudience] = d;
    });
    assert.deepEqual(validateManifest(m, { buildDirs: dirs }), []);
    writeFileSync(path.join(dirs.doctor, 'assets', 'app.js'), '// tampered');
    assert.match(validateManifest(m, { buildDirs: dirs }).join('\n'), /buildDigest does not match/);
    writeFileSync(path.join(dirs.doctor, 'assets', 'app.js'), '// 0');
    assert.deepEqual(validateManifest(m, { buildDirs: dirs }), []);
    assert.match(validateManifest(m, { buildDirs: { ...dirs, doctor: dirs.patient } }).join('\n'), /buildDigest does not match/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
