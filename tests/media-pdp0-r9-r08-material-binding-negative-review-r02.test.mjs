import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import YAML from 'yaml';
import { buildR9R08DecisionSectionMaterial } from '../scripts/prepare-media-pdp0-root-selected-source-integration-r9-r08-approval-input.mjs';

const root = path.resolve(import.meta.dirname, '..');
const sha = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const read = (ref) => fs.readFileSync(path.join(root, ref));
const logRef = '.product-experience/decision-log.md';
const authorityRef = '.product-experience/authority-map.yaml';
const statusRef = 'docs/implementation/pdp-0-phase-dev-status.json';

function baseline() {
  const decisionLogText = read(logRef).toString('utf8');
  const authorityMapText = read(authorityRef).toString('utf8');
  const statusBytes = read(statusRef);
  const status = JSON.parse(statusBytes.toString('utf8'));
  const historicalPin = status.sourceShaSet[`${logRef}#PXD-225-section`];
  assert.match(historicalPin, /^[a-f0-9]{64}$/);
  return {
    decisionLogText,
    authorityMapText,
    historicalPdp0StatusSha256: sha(statusBytes),
    historicalPdp0StatusPin: historicalPin,
  };
}

function build(source, decisionLogText = source.decisionLogText, authorityMapText = source.authorityMapText) {
  return buildR9R08DecisionSectionMaterial({
    ...source,
    decisionLogText,
    authorityMapText,
    decisionLogWholeSha256: sha(Buffer.from(decisionLogText)),
    authorityMapWholeSha256: sha(Buffer.from(authorityMapText)),
  });
}

function replacePxd225Authority(text, replacement) {
  const start = text.indexOf('### PXD-225');
  const end = text.indexOf('### PXD-226', start);
  assert.ok(start >= 0 && end > start);
  const section = text.slice(start, end);
  const authorityStart = section.indexOf('**Authority:**');
  const decisionStart = section.indexOf('**Decision:**', authorityStart);
  assert.ok(authorityStart >= 0 && decisionStart > authorityStart);
  return `${text.slice(0, start)}${section.slice(0, authorityStart)}${replacement}\n\n${section.slice(decisionStart)}${text.slice(end)}`;
}

const semanticPins = (material) => material.sections.map(({ sectionId, sha256 }) => [sectionId, sha256]);

test('PXD-225 authority-only tampering changes the authority and whole-section pins, not semantic subsection pins', () => {
  const source = baseline();
  const original = build(source);
  const changedText = replacePxd225Authority(source.decisionLogText,
    '**Authority:** Test-only text mutation; no decision or authority is created.');
  const changed = build(source, changedText);

  assert.deepEqual(semanticPins(changed), semanticPins(original));
  assert.notEqual(changed.decisionSectionRawPin.decisionSectionSha256, original.decisionSectionRawPin.decisionSectionSha256);
  assert.notEqual(changed.pdpAuthoritySectionRefs[0].sectionSha256, original.pdpAuthoritySectionRefs[0].sectionSha256);
  assert.notEqual(changed.decisionLogCaptureProvenance.wholeFileSha256AtMaterialPreparation,
    original.decisionLogCaptureProvenance.wholeFileSha256AtMaterialPreparation);
});

test('new later decision sections do not become authority bindings and final apply CAS remains uncaptured', () => {
  const source = baseline();
  const original = build(source);
  const appended = `${source.decisionLogText}\n### PXD-228 — Test-only section\n\nNo authority is created by this test.\n`;
  const changed = build(source, appended);

  assert.deepEqual(semanticPins(changed), semanticPins(original));
  assert.equal(changed.decisionSectionRawPin.decisionSectionSha256, original.decisionSectionRawPin.decisionSectionSha256);
  assert.equal(changed.pdpAuthoritySectionRefs.some(({ ref }) => ref.includes('PXD-228')), false);
  assert.deepEqual(changed.authoritySectionBindings.map(({ sequence, recordKind }) => [sequence, recordKind]), [
    [1, 'PDP0_SOURCE_OWNER_DECISION'], [2, 'ROOT_ADOPTION_DECISION'],
    [3, 'OPERATION_PROFILE_REGISTRATION'], [4, 'DISTINCT_APPLY_AUTHORIZATION'],
  ]);
  assert.ok(changed.authoritySectionBindings.every(({ decisionSelector }) =>
    decisionSelector.status === 'NOT_ALLOCATED_BY_DECISION_LOG_OWNER' && decisionSelector.ref === null && decisionSelector.sha256 === null));
  assert.equal(changed.applyReadSetV2.wholeDecisionLogSha256, null);
  assert.equal(changed.applyReadSetV2.status, 'NOT_CAPTURED_PENDING_AUTHORITY_SECTION_ALLOCATION_AND_RECORD_CHAIN');
  assert.equal(changed.authorityBoundary.canonicalApply, 'NOT_AUTHORIZED');
});

test('each selected PDP-0 authority-map record has a separate typed section pin and whole-file preimage pin', () => {
  const source = baseline();
  const original = build(source);
  const authorityMap = YAML.parse(source.authorityMapText);
  const row = authorityMap.phaseAuthorities.find(({ phase }) => phase === 'PDP-0');
  assert.ok(row?.owner, 'the PDP-0 phase authority row is present in this source cut');
  row.owner = `${row.owner}-test-tamper`;
  const tamperedMap = YAML.stringify(authorityMap);
  const changed = build(source, source.decisionLogText, tamperedMap);

  assert.deepEqual(semanticPins(changed), semanticPins(original));
  assert.equal(changed.pdpAuthoritySectionRefs[1].sectionSha256, original.pdpAuthoritySectionRefs[1].sectionSha256,
    'the separate canonical phase selector remains unchanged when the phaseAuthorities record is mutated');
  assert.notEqual(changed.pdpAuthoritySectionRefs[2].sectionSha256, original.pdpAuthoritySectionRefs[2].sectionSha256);
  assert.notEqual(changed.authorityMapSourcePin.wholeFileSha256, original.authorityMapSourcePin.wholeFileSha256);
});
