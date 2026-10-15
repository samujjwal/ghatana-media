import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { validatePdp1C22SemanticRepairImpact } from '../scripts/record-media-discovery-pdp1-phase-exit.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const impactPath = 'docs/implementation/observations/media-discovery-pdp1-c22-semantic-repair-impact-2026-10-14.json';
const operationsPath = '.product-experience/pdp-1-domain-data/operations.yaml';
const wirePath = '.product-experience/pdp-1-domain-data/owner-action-wire-contracts.yaml';
const readJson = (relativePath) => JSON.parse(fs.readFileSync(path.join(root, relativePath), 'utf8'));
const digest = (relativePath) => `sha256:${crypto.createHash('sha256').update(fs.readFileSync(path.join(root, relativePath))).digest('hex')}`;

function inputs() {
  const record = readJson(impactPath);
  const pxd164 = readJson('docs/implementation/observations/media-discovery-pdp1-pxd164-semantic-repair-impact-2026-10-14-r1.json');
  const operationCurrent = digest(operationsPath);
  const wireCurrent = digest(wirePath);
  const operationPredecessor = record.sourcePredecessor.sourceDigests[operationsPath];
  const wirePredecessor = record.sourcePredecessor.sourceDigests[wirePath];
  const observedDigests = Object.fromEntries([...new Set([
    operationsPath, wirePath,
    ...pxd164.sourceDeltas.map(({ path: sourcePath }) => sourcePath),
    ...Object.keys(pxd164.verificationInputs),
  ])].map((sourcePath) => [sourcePath, digest(sourcePath)]));
  return {
    record,
    observedDigests: { ...observedDigests, [operationsPath]: operationCurrent, [wirePath]: wireCurrent },
    historicalDigests: { [operationsPath]: operationPredecessor, [wirePath]: wirePredecessor },
    statusPins: { [operationsPath]: operationCurrent, [wirePath]: wireCurrent },
    semanticPins: { [operationsPath]: operationCurrent, [wirePath]: wireCurrent },
  };
}

test('PDP-1 C22 impact binds exact R16 source hashes, selectors, result tuple, and boundaries', () => {
  const input = inputs();
  const result = validatePdp1C22SemanticRepairImpact(input.record, input);
  assert.equal(result.valid, true, JSON.stringify(result));
  assert.equal(result.operationSemanticsValid, true);
  assert.equal(result.wireSemanticsValid, true);
  assert.equal(result.exactDeltas, true);
});

test('PDP-1 C22 impact rejects wrong predecessor and current source hashes', () => {
  const predecessor = inputs();
  predecessor.record.sourceDeltas[0].predecessorSha256 = `sha256:${'0'.repeat(64)}`;
  assert.equal(validatePdp1C22SemanticRepairImpact(predecessor.record, predecessor).valid, false);

  const current = inputs();
  current.observedDigests[wirePath] = `sha256:${'f'.repeat(64)}`;
  assert.equal(validatePdp1C22SemanticRepairImpact(current.record, current).valid, false);

  const declaredCurrent = inputs();
  declaredCurrent.record.sourceDeltas[1].observedSha256 = `sha256:${'a'.repeat(64)}`;
  assert.equal(validatePdp1C22SemanticRepairImpact(declaredCurrent.record, declaredCurrent).valid, false);

  const predecessorCut = inputs();
  predecessorCut.record.sourcePredecessor.sourceDigests[operationsPath] = `sha256:${'b'.repeat(64)}`;
  assert.equal(validatePdp1C22SemanticRepairImpact(predecessorCut.record, predecessorCut).valid, false);
});

test('PDP-1 C22 impact rejects wrong selectors, result tuples, and PXD-163 boundaries', () => {
  const selector = inputs();
  selector.record.sourceDeltas[1].selector = `${selector.record.sourceDeltas[1].selector}/wrong`;
  assert.equal(validatePdp1C22SemanticRepairImpact(selector.record, selector).valid, false);

  const tuple = inputs();
  tuple.record.resultTuple.operationResultFields.pop();
  assert.equal(validatePdp1C22SemanticRepairImpact(tuple.record, tuple).valid, false);

  const boundary = inputs();
  boundary.record.boundaries.externalOwnerAcceptance = 'ACCEPTED';
  assert.equal(validatePdp1C22SemanticRepairImpact(boundary.record, boundary).valid, false);
});

test('PDP-1 C22 impact rejects supplied-record substitutions and altered disposition boundaries', () => {
  const substituted = inputs();
  substituted.record.observedAt = '2030-01-01T00:00:00Z';
  assert.equal(validatePdp1C22SemanticRepairImpact(substituted.record, substituted).valid, false);

  const disposition = inputs();
  disposition.record.reviewDisposition = 'CLAIMED_ACCEPTED';
  assert.equal(validatePdp1C22SemanticRepairImpact(disposition.record, disposition).valid, false);

  const limitation = inputs();
  limitation.record.limitation = '';
  assert.equal(validatePdp1C22SemanticRepairImpact(limitation.record, limitation).valid, false);
});
