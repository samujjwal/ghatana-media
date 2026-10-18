import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {inputs, verifyUnifiedProductionInventory} from '../scripts/check-media-unified-production-inventory.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = key => fs.readFileSync(path.join(root, inputs[key]), 'utf8');
const mutate = (key, fn) => {
  const content = key === 'audit' ? JSON.stringify(fn(JSON.parse(read('audit')))) : fn(read(key));
  return verifyUnifiedProductionInventory({overrides:{[key]:content}});
};
test('unified audit preserves exact 428+73=501, 38/462 P0 leaves, 84+61 cases and 28+18 test candidates', () => {
  const result = verifyUnifiedProductionInventory();
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
  assert.deepEqual(result.stats, {
    original:428, focused:73, total:501,
    canonFamilyCount:38,canonLeafCount:462,recorderCases:84,declarativeCases:61,
    competitiveTests:28,scientificTests:18
  });
});
test('reject lost original audit target without introducing a second requirement authority', () => {
  const result = mutate('audit', doc => {doc.originalAudit.pop();return doc;});
  assert.match(result.errors.join('\n'), /lost, added, or duplicate/);
});
test('reject an original audit entry whose accepted source feature text changes', () => {
  const result = mutate('audit', doc => {doc.originalAudit[0].sourceFeature='fabricated screen';return doc;});
  assert.match(result.errors.join('\n'), /source audit text\/status mismatch/);
});
test('reject unknown/wrong-family proposed capability mapping', () => {
  const result = mutate('audit', doc => {
    doc.originalAudit[0].existingCapabilityLeafCandidate='media.simulation.nonexistent-physics';
    return doc;
  });
  assert.match(result.errors.join('\n'), /nonexistent\/wrong-family/);
});
test('reject silent promotion of lexical proposals into normative acceptance', () => {
  const result = mutate('audit', doc => {
    doc.originalAuditDefaults.semanticMappingDisposition='ACCEPTED_DEV_COMPLETE';
    return doc;
  });
  assert.match(result.errors.join('\n'), /do not promote heuristic matches/);
});
test('reject changed domain prior-review population and missing source ID', () => {
  const result = mutate('blueprint', txt => txt.replace(
    /(\|\s*\x60AUD-SPEC-001\x60\s*\|[^|]+\|\s*\x60B\x60\s*\|)/,
    '| AUD-SPEC-999 | unsupported fabricated item | B |'
  ));
  assert.match(result.errors.join('\n'), /source domain denominator drift|lost, added, or duplicate|source audit text\/status mismatch/);
});
test('reject a Recorder focused audit entry pointing to a nonexistent canonical acceptance case', () => {
  const result = mutate('audit', doc => {
    const r = doc.focusedAudit.find(r => r.group === 'RECORDER');
    r.canonicalAcceptanceCaseRef = 'MEDIA-REC-P0-AC-999';
    return doc;
  });
  assert.match(result.errors.join('\n'), /missing Recorder case/);
});
test('reject a declarative audit entry missing its P1 canonical operation exact link', () => {
  const result = mutate('audit', doc => {
    const r = doc.focusedAudit.find(r => r.group === 'SIMULATION');
    r.canonicalP1OperationRef = 'media.operation.nonexistent-physics';
    return doc;
  });
  assert.match(result.errors.join('\n'), /drift in exact P0\/P1 case/);
});
test('reject a missing scientific reference experiment identifier from the blueprint', () => {
  const result = mutate('blueprint', txt => txt.replace(/\bDAS-A05\b/g,'DAS-A99'));
  assert.match(result.errors.join('\n'), /DAS-A01\.\.18 acceptance experiment/);
});
