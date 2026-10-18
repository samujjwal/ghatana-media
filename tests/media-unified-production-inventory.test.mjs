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

test('all 428 original features carry explicitly unaccepted, source-owned catalog candidates', () => {
  const result = verifyUnifiedProductionInventory();
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
  const ledger = JSON.parse(read('audit'));
  assert.equal(ledger.originalAudit.filter(r => r.curatedCandidate?.status ===
    'PDP0_OWNER_AND_NATIVE_CURRENTNESS_REVIEW_REQUIRED').length, 428);
  assert.equal(ledger.curatedCrosswalkReview.stillAwaitingSemanticAcceptance, 428);
});
test('reject a source-reviewed audit leaf whose owner disappears without altering the source feature', () => {
  const result = mutate('audit', doc => {
    delete doc.originalAudit[0].curatedCandidate;
    return doc;
  });
  assert.match(result.errors.join('\n'), /unreviewed or falsely promoted curated source leaf/);
});
test('reject a curated source candidate promoted to exact semantic acceptance without owner evidence', () => {
  const result = mutate('audit', doc => {
    doc.originalAudit[1].curatedCandidate.status='ACCEPTED_DEV_COMPLETE';
    return doc;
  });
  assert.match(result.errors.join('\n'), /unreviewed or falsely promoted curated source leaf/);
});
test('reject cross-modal ASR source candidate silently replaced by TTS streaming', () => {
  const result = mutate('audit', doc => {
    const row = doc.originalAudit.find(r => r.auditId === 'AUD-ASR-002');
    row.existingCapabilityLeafCandidate='media.speech.synthesis.streaming';
    row.existingParentRequirementCandidate='MEDIA-REQ-CAP-SPEECH-SYNTHESIS';
    row.curatedCandidate.sourceCapabilityRef='.product-experience/pdp-0-product-truth/capabilities.yaml#media.speech.synthesis.streaming';
    return doc;
  });
  assert.match(result.errors.join('\n'), /cross-modal source-leaf mismatch at AUD-ASR-002/);
});
test('reject substituting generic image inpainting for all 52 timeline editing kinds', () => {
  const result = mutate('audit', doc => {
    const row = doc.originalAudit.find(r => r.auditId === 'AUD-EDIT-001');
    row.existingCapabilityLeafCandidate='media.edit.inpaint';
    row.existingParentRequirementCandidate='MEDIA-REQ-CAP-EDIT';
    row.curatedCandidate.sourceCapabilityRef='.product-experience/pdp-0-product-truth/capabilities.yaml#media.edit.inpaint';
    return doc;
  });
  assert.match(result.errors.join('\n'), /cross-modal source-leaf mismatch at AUD-EDIT-001/);
});

test('preserve the exact uploaded original 428 feature texts and 73 third-pass source IDs', () => {
  const result = verifyUnifiedProductionInventory();
  assert.deepEqual(result.errors, [], result.errors.join('\n'));
  const original = JSON.parse(read('attachedAudit'));
  const crosswalk = JSON.parse(read('uploadedIdCrosswalk'));
  assert.equal(original.originalAudit.inventory.length, 428);
  assert.equal(original.thirdPassAdditions.length, 73);
  assert.deepEqual(
    crosswalk.thirdPassTraceability.map(r => r.sourceAuditId),
    original.thirdPassAdditions.map(r => r.audit_id)
  );
});
test('reject loss of an original stable AUD-REC3 source identity', () => {
  const r = mutate('attachedAudit', doc => { doc.thirdPassAdditions.shift(); return doc; });
  assert.match(r.errors.join('\n'), /attached source: 428\+73=501|attached stable ID/);
});
test('reject mismatch between uploaded 73 feature intent and normalized PDP candidate', () => {
  const r = mutate('uploadedIdCrosswalk', doc => {
    doc.thirdPassTraceability[0].sourceFeature = 'invented capability';
    return doc;
  });
  assert.match(r.errors.join('\n'), /attached stable ID not preserved/);
});
test('reject laundering a third-pass alias into accepted canonical semantics', () => {
  const r = mutate('uploadedIdCrosswalk', doc => {
    doc.thirdPassTraceability[0].p0Disposition = 'BOUND_EXISTING';
    return doc;
  });
  assert.match(r.errors.join('\n'), /attached stable ID not preserved/);
});
test('reject an unsupported canonical PDP-0 alias for original third-pass requirement', () => {
  const r = mutate('uploadedIdCrosswalk', doc => {
    doc.thirdPassTraceability[0].candidateP0AcceptanceCases = ['MEDIA-DECL-P0-AC-999'];
    return doc;
  });
  assert.match(r.errors.join('\n'), /missing canonical case|normalized alias drift/);
});
test('reject deleting the two explicitly unbound specialist solver families', () => {
  const r = mutate('uploadedIdCrosswalk', doc => {
    doc.thirdPassTraceability.find(x=>x.sourceAuditId==='AUD-SIM3-009').additionalSemanticRisk='';
    return doc;
  });
  assert.match(r.errors.join('\n'), /missing case and explicit semantic gap/);
});
