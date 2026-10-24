import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {fingerprintPxdDecisionSection} from '../../scripts/lib/pdp0-phase-scoped-source-fingerprints.mjs';
import {verifyQualityExtensionSourceAdoptionV2} from '../../scripts/lib/media-pdp0-quality-extension-source-adoption-v2.mjs';

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const obs = 'docs/implementation/observations/pdp0-semantic-audit-slices';
const qualityPolicy = '.product-experience/pdp-0-product-truth/quality-policy.yaml';
const decisionLog = '.product-experience/decision-log.md';
const qualityJournalRef = `${obs}/source-amendment-journals/f6feb44574d87a7ee15807b80ac8cf8c95c9ca86ab81ff6c9cddea3ec5799a0a.json`;
const v7ManifestRef = `${obs}/AUD-SPEC-002-source-amendment-v7-freeze-manifest.v1.json`;
const qualityCandidateRef = `${obs}/AUD-SPEC-002-quality-extension-source-candidate.v2.json`;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = ref => fs.readFileSync(path.join(repo, ref));

function copyTree(source, target, predicate = () => true) {
  if (!fs.existsSync(source)) return;
  fs.cpSync(source, target, {recursive:true, filter:from => predicate(path.relative(source, from), from)});
}

function assertAppliedSuccessorBaseline() {
  const qualityJournal = JSON.parse(read(qualityJournalRef));
  const candidate = JSON.parse(read(qualityCandidateRef));
  const v7Manifest = JSON.parse(read(v7ManifestRef));
  assert.equal(qualityJournal.state, 'COMMITTED_EXACT_READBACK');
  assert.equal(qualityJournal.candidateSha256, hash(read(qualityCandidateRef)));
  const qualityRows = new Map(qualityJournal.targets.map(row => [row.targetRef, row]));
  for (const target of candidate.targets) {
    const journalRow = qualityRows.get(target.targetRef);
    assert.ok(journalRow, `quality apply journal covers ${target.targetRef}`);
    assert.equal(journalRow.expectedPreimageSha256, target.preimageSha256);
    assert.equal(journalRow.postimageSha256, target.postimageSha256);
    assert.equal(hash(read(target.targetRef)), target.postimageSha256, `actual successor readback for ${target.targetRef}`);
    assert.equal(hash(read(journalRow.immutablePreimageRef)), target.preimageSha256, `immutable predecessor snapshot for ${target.targetRef}`);
  }

  const v7Targets = new Map(v7Manifest.targetPostimages.map(row => [row.targetRef, row]));
  const qualityLog = candidate.targets.find(row => row.targetRef === decisionLog);
  assert.equal(qualityLog.preimageSha256, v7Targets.get(decisionLog).postimageSha256,
    'the V7 decision-log postimage is the consumed predecessor for the quality successor');
  for (const [targetRef, row] of v7Targets) {
    if (targetRef === decisionLog) continue;
    assert.equal(hash(read(targetRef)), row.postimageSha256, `preserved exact V7 target ${targetRef}`);
  }
  const v7DecisionLog = read(`${obs}/AUD-SPEC-002-decision-log-postimage.v6.md`).toString('utf8');
  const currentDecisionLog = read(decisionLog).toString('utf8');
  assert.equal(fingerprintPxdDecisionSection(currentDecisionLog, 'PXD-226').section.trimEnd(),
    fingerprintPxdDecisionSection(v7DecisionLog, 'PXD-226').section.trimEnd(),
    'PXD-226 content remains byte-equivalent apart from the new separator before PXD-227');
  assert.equal((currentDecisionLog.match(/^### PXD-226\b/gmu) ?? []).length, 1);
  assert.equal((currentDecisionLog.match(/^### PXD-227\b/gmu) ?? []).length, 1);

  const readback = verifyQualityExtensionSourceAdoptionV2();
  assert.equal(readback.state, 'EXACT_TWO_TARGET_POSTIMAGE_READBACK');
  assert.equal(readback.population.currentRowsCount, 463);
  assert.equal(readback.population.historicalRows, 462);
  assert.equal(readback.population.futureRows, 6);
  return {qualityJournal, candidate, v7Manifest};
}

function makePreApplyTestInstall({qualityJournal, candidate, v7Manifest}) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'media-quality-pdp0-focused-'));
  const mediaRoot = path.join(temp, 'ghatana-media');
  const lifecycleRoot = path.join(temp, 'ghatana-lifecycle');
  fs.mkdirSync(mediaRoot, {recursive:true});
  fs.mkdirSync(lifecycleRoot, {recursive:true});

  copyTree(path.join(repo, 'scripts'), path.join(mediaRoot, 'scripts'));
  copyTree(path.join(repo, 'tests'), path.join(mediaRoot, 'tests'));
  copyTree(path.join(repo, obs), path.join(mediaRoot, obs));
  copyTree(path.join(repo, 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates'),
    path.join(mediaRoot, 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates'));
  copyTree(path.join(repo, 'docs/implementation/references'), path.join(mediaRoot, 'docs/implementation/references'));
  copyTree(path.join(repo, 'docs/implementation/verification/pdp-38'), path.join(mediaRoot, 'docs/implementation/verification/pdp-38'));

  const productTruthRefs = [
    'applications-channels.yaml', 'capabilities.yaml', 'requirements.yaml',
    'quality-policy.yaml', 'capability-leaf-review.yaml', 'campaign-extensions.yaml',
  ];
  for (const file of productTruthRefs) {
    const rel = `.product-experience/pdp-0-product-truth/${file}`;
    const to = path.join(mediaRoot, rel);
    fs.mkdirSync(path.dirname(to), {recursive:true});
    fs.copyFileSync(path.join(repo, rel), to);
  }
  const copiedDecisionLog = path.join(mediaRoot, decisionLog);
  fs.mkdirSync(path.dirname(copiedDecisionLog), {recursive:true});
  fs.copyFileSync(path.join(repo, decisionLog), copiedDecisionLog);

  const lifecycleRefs = [
    '../ghatana-lifecycle/docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-quality-applicability-root-choice-r01.json',
    'ghatana-lifecycle:docs/engineering/reviews/gtool-critical-2026-10-23/media-aud-spec-002-version-population-root-decision.json',
  ];
  for (const ref of lifecycleRefs) {
    const suffix = ref.startsWith('ghatana-lifecycle:') ? ref.slice('ghatana-lifecycle:'.length)
      : ref.slice('../ghatana-lifecycle/'.length);
    const to = path.join(lifecycleRoot, suffix);
    fs.mkdirSync(path.dirname(to), {recursive:true});
    fs.copyFileSync(path.resolve(repo, '../ghatana-lifecycle', suffix), to);
  }
  fs.symlinkSync(path.resolve(repo, '../ghatana-tools'), path.join(temp, 'ghatana-tools'), 'dir');

  const v7LogIndex = v7Manifest.targetPostimages.findIndex(row => row.targetRef === decisionLog);
  assert.notEqual(v7LogIndex, -1, 'V7 manifest includes its decision-log predecessor');
  const v7LogRef = v7Manifest.postimageArtifactRefs[v7LogIndex].ref;
  fs.copyFileSync(path.join(repo, v7LogRef), copiedDecisionLog);
  const qualityPolicyRow = qualityJournal.targets.find(row => row.targetRef === qualityPolicy);
  assert.ok(qualityPolicyRow, 'quality apply journal contains its policy preimage');
  const qualityPreimage = read(qualityPolicyRow.immutablePreimageRef);
  assert.equal(hash(qualityPreimage), qualityPolicyRow.expectedPreimageSha256);
  fs.writeFileSync(path.join(mediaRoot, qualityPolicy), qualityPreimage);

  const v7DecisionLogRow = v7Manifest.targetPostimages.find(row => row.targetRef === decisionLog);
  assert.equal(candidate.targets[0].preimageSha256, v7DecisionLogRow.postimageSha256);
  const ownerDecision = path.join(mediaRoot, obs, 'AUD-SPEC-002-quality-extension-source-owner-decision.v2.json');
  const applyAuthorization = path.join(mediaRoot, obs, 'AUD-SPEC-002-quality-extension-apply-authorization.v2.json');
  for (const target of [ownerDecision, applyAuthorization]) {
    if (fs.existsSync(target)) fs.unlinkSync(target);
  }
  return {temp, mediaRoot};
}

const applied = assertAppliedSuccessorBaseline();
const fixture = makePreApplyTestInstall(applied);
try {
  const files = [
    'tests/media-pdp0-quality-extension-source-candidate-v2.test.mjs',
    'tests/media-pdp0-quality-extension-source-adoption-v2.test.mjs',
    'tests/media-pdp0-quality-extension-provenance-plan-v3.test.mjs',
  ];
  const run = spawnSync(process.execPath, ['--test', ...files], {cwd:fixture.mediaRoot, encoding:'utf8', maxBuffer:32 * 1024 * 1024});
  process.stdout.write(run.stdout ?? '');
  process.stderr.write(run.stderr ?? '');
  if (run.status !== 0) process.exitCode = run.status ?? 1;
  else process.stdout.write('\nVerified actual applied quality successor; focused tests ran in an isolated pre-apply fixture derived from its immutable preimages.\n');
} finally {
  fs.rmSync(fixture.temp, {recursive:true, force:true});
}
