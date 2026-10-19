import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {createRequire} from 'node:module';

const parseYaml = createRequire(path.resolve(process.cwd(), '../ghatana-tools/package.json'))('yaml').parse;
const requirementsPath = '.product-experience/pdp-0-product-truth/requirements.yaml';
const capabilitiesPath = '.product-experience/pdp-0-product-truth/capabilities.yaml';
const requirements = parseYaml(fs.readFileSync(requirementsPath, 'utf8')).requirements;
const capabilities = parseYaml(fs.readFileSync(capabilitiesPath, 'utf8')).capabilities;

const corrections = [
  {
    requirementId: 'MEDIA-REQ-CAP-ARTIFACT',
    caseId: 'MEDIA-REQ-CAP-ARTIFACT-AC-03',
    capabilityId: 'media.artifact.search',
    required: ['semantic transcript search', 'exact source version', 'transcript time range', 'unavailable', 'denied', 'unknown', 'empty', 'complete', 'rights-and-retention'],
    capabilityRequired: ['semantic transcript search returns candidate matches', 'exact source versions', 'transcript time ranges', 'matching uncertainty', 'completeness are not guaranteed'],
  },
  {
    requirementId: 'MEDIA-REQ-CAP-ARTIFACT',
    caseId: 'MEDIA-REQ-CAP-ARTIFACT-AC-04',
    capabilityId: 'media.artifact.search',
    required: ['duplicate', 'near-duplicate', 'candidate groups', 'source artifact identity', 'uncertainty', 'merging', 'replacing', 'deleting'],
    capabilityRequired: ['duplicate or near-duplicate search', 'candidate groups', 'source identities', 'matching uncertainty', 'merge, replacement, or deletion'],
  },
  {
    requirementId: 'MEDIA-REQ-CAP-STREAM',
    caseId: 'MEDIA-REQ-CAP-STREAM-AC-03',
    capabilityId: 'media.stream.recording.integrate',
    required: ['authorized presenter script', 'explicit scene/narration cue map', 'synchronized', 'provenance', 'inferring', 'absent', 'committed recording', 'project edit'],
    capabilityRequired: ['authorized versioned script', 'versioned scene/narration cue map', 'active cue', 'active-cue provenance', 'missing, mismatched, or unavailable map', 'does not establish cue correctness, commit a recording, or edit a project'],
  },
  {
    requirementId: 'MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION',
    caseId: 'MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION-AC-04',
    capabilityId: 'media.speech.transcription.file',
    required: ['versioned custom glossary', 'unverified', 'source-version/timebase-linked', 'punctuation', 'capitalization', 'ambiguous', 'unsupported', 'unavailable', 'verifies transcript correctness'],
    capabilityRequired: ['versioned custom glossary', 'uncertain source-anchored filler-word or retake candidates', 'glossary guidance is distinct from punctuation/capitalization formatting', 'ambiguous, unsupported, or unavailable glossary entries', 'remains unverified'],
  },
  {
    requirementId: 'MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION',
    caseId: 'MEDIA-REQ-CAP-SPEECH-TRANSCRIPTION-AC-05',
    capabilityId: 'media.speech.transcription.file',
    required: ['uncertain candidate observations', 'exact source version', 'time range', 'silence observations', 'silence alone', 'deleting', 'trimming', 'cutting'],
    capabilityRequired: ['filler-word or retake candidates', 'uncertain source-anchored filler-word or retake candidates', 'filler/retake candidates are distinct from silence observations'],
  },
  {
    requirementId: 'MEDIA-REQ-CAP-COMPOSE',
    caseId: 'MEDIA-REQ-CAP-COMPOSE-AC-03',
    capabilityId: 'media.compose.multitrack-timeline',
    required: ['active-speaker-aware multicamera cut proposal', 'speaker-turn', 'camera-source', 'reviewable local candidate', 'uncertainty', 'inferring', 'committing', 'separate approval'],
    capabilityRequired: ['reviewable active-speaker multicamera cut proposal', 'speaker-turn and camera-source evidence', 'uncertainty', 'does not commit a project edit'],
  },
];

test('six semantic corrections are owned by existing PDP-0 requirement and capability identities', () => {
  assert.equal(capabilities.length, 462, 'the exact existing capability leaf denominator is preserved');
  assert.equal(new Set(capabilities.map(item => item.id)).size, 462, 'capability IDs remain unique');
  const allCaseIds = requirements.flatMap(requirement => (requirement.acceptanceCases ?? []).map(item => item.id));
  assert.equal(new Set(allCaseIds).size, allCaseIds.length, 'acceptance case IDs remain unique');

  for (const correction of corrections) {
    const requirement = requirements.find(item => item.id === correction.requirementId);
    assert.ok(requirement, `existing parent requirement ${correction.requirementId} exists`);
    const acceptanceCase = (requirement.acceptanceCases ?? []).find(item => item.id === correction.caseId);
    assert.ok(acceptanceCase, `${correction.caseId} is nested under ${correction.requirementId}`);
    const capability = capabilities.find(item => item.id === correction.capabilityId);
    assert.ok(capability, `existing capability ${correction.capabilityId} exists`);
    assert.ok(requirement.capabilityIds.includes(correction.capabilityId), `${correction.capabilityId} is owned by ${correction.requirementId}`);
    assert.ok(capability.ownerDefinition, `${correction.capabilityId} has an owner definition`);

    const caseText = ['given', 'when', 'then', 'rejection'].map(key => acceptanceCase[key] ?? '').join(' ').toLowerCase();
    for (const phrase of correction.required) {
      assert.ok(caseText.includes(phrase.toLowerCase()), `${correction.caseId} states “${phrase}”`);
    }
    const capabilityText = [capability.outcome, capability.ownerDefinition.semanticOutcomeContract?.result,
      ...(capability.ownerDefinition.semanticOutcomeContract?.outputDistinctions ?? []),
      capability.ownerDefinition.semanticOutcomeContract?.unknownDisposition,
      capability.ownerDefinition.effect?.semanticOutcome].join(' ').toLowerCase();
    for (const phrase of correction.capabilityRequired) {
      assert.ok(capabilityText.includes(phrase.toLowerCase()), `${correction.capabilityId} outcome preserves “${phrase}”`);
    }
  }
});

test('corrections are explicit P0 candidates and preserve uncertain or unavailable outcomes', () => {
  const findCapability = id => capabilities.find(item => item.id === id);
  const search = findCapability('media.artifact.search').ownerDefinition.semanticOutcomeContract;
  const searchCapability = findCapability('media.artifact.search');
  assert.deepEqual(Object.keys(searchCapability.ownerDefinition.parameterSchema.properties).sort(), ['pageSize', 'pageToken', 'searchIntent', 'transcriptQuery']);
  assert.ok(searchCapability.ownerDefinition.parameterSchema.conditionalSemantics.some(({ when, requires }) => when === 'searchIntent=SEMANTIC_TRANSCRIPT_CANDIDATES' && requires === 'transcriptQuery'));
  assert.deepEqual(searchCapability.ownerDefinition.successOutputs.map(({ artifactType }) => artifactType), ['bounded-governed-artifact-result-page-and-opaque-continuation']);
  assert.deepEqual(searchCapability.ownerDefinition.successOutputs[0].optionalSemanticObservations.map(({ id }) => id), ['transcriptSearchCandidates', 'duplicateCandidateGroups']);
  assert.match(search.unknownDisposition, /do not present uncertainty as an empty or complete result/u);
  assert.match(search.unknownDisposition, /never establishes transcript correctness or authorizes merge, replacement, or deletion/u);

  const transcription = findCapability('media.speech.transcription.file').ownerDefinition.semanticOutcomeContract;
  const transcriptionCapability = findCapability('media.speech.transcription.file');
  assert.ok(Object.hasOwn(transcriptionCapability.ownerDefinition.parameterSchema.properties, 'customGlossaryRef'));
  assert.ok(Object.hasOwn(transcriptionCapability.ownerDefinition.parameterSchema.properties, 'fillerRetakeCandidates'));
  assert.deepEqual(transcriptionCapability.ownerDefinition.successOutputs.map(({ artifactType }) => artifactType), [
    'owner-issued-transcription-job-reference',
    'transcript-draft-with-source-version-and-timebase-if-produced',
    'language-and-recognition-evidence-when-provided',
  ]);
  assert.deepEqual(transcriptionCapability.ownerDefinition.successOutputs[1].optionalSemanticObservations.map(({ id }) => id), [
    'glossaryApplication', 'fillerRetakeCandidateObservations',
  ]);
  assert.match(transcription.unknownDisposition, /ambiguous, unsupported, or unavailable glossary entries are not silently applied/u);
  assert.match(transcription.unknownDisposition, /transcript text remains unverified/u);
  assert.match(transcription.result, /filler\/retake candidates are distinct from silence observations/u);

  const silence = findCapability('media.audio.analysis.detect.silence').ownerDefinition.semanticOutcomeContract;
  assert.match(silence.result, /Silence observations are distinct from speech-based filler-word or retake candidates/u);
  assert.match(silence.unknownDisposition, /cannot be promoted to a filler-word or retake classification/u);

  const recording = findCapability('media.stream.recording.integrate').ownerDefinition.semanticOutcomeContract;
  assert.match(recording.result, /missing, mismatched, or unavailable map remains UNBOUND, UNAVAILABLE, or UNKNOWN/u);
  assert.match(recording.result, /does not establish cue correctness, commit a recording, or edit a project/u);
  assert.match(recording.unknownDisposition, /do not infer cue alignment/u);
  const stream = findCapability('media.stream.recording.integrate');
  const cueBinding = stream.ownerDefinition.typedInputSlots[0].optionalSemanticComponents.find(({ id }) => id === 'presenterCueBinding');
  assert.deepEqual(Object.keys(cueBinding.fields).sort(), ['activeCueId', 'clockDomainRef', 'cueMapRef', 'scriptRef']);
  assert.deepEqual(stream.ownerDefinition.successOutputs.map(({ artifactType }) => artifactType), ['ordered-stream-observation-or-terminal-session-state']);
  assert.equal(stream.ownerDefinition.successOutputs[0].optionalSemanticObservations[0].id, 'presenterPromptObservation');
  assert.deepEqual(stream.inputArtifactTypes, ['stream-session-request', 'consent-and-capability-context']);

  const compose = findCapability('media.compose.multitrack-timeline').ownerDefinition.semanticOutcomeContract;
  assert.match(compose.result, /missing links and uncertainty explicit/u);
  assert.match(compose.result, /does not commit a project edit/u);
  assert.match(compose.unknownDisposition, /cannot be inferred/u);
});

test('JOB-AC-03 defines parent cancellation without losing uncertainty or retry identity', () => {
  const job = requirements.find(item => item.id === 'MEDIA-REQ-CAP-JOB');
  const cancelCase = job.acceptanceCases.find(item => item.id === 'MEDIA-REQ-CAP-JOB-AC-03');
  assert.match(cancelCase.then, /parent cancellation, stop admitting or dispatching new child work and request cancellation of active children/u);
  assert.match(cancelCase.then, /keep the parent pending or UNKNOWN until authoritative evidence resolves each child's effect outcome/u);
  assert.match(cancelCase.then, /Any partial result is explicitly labeled and bounded to its evidenced scope/u);
  assert.match(cancelCase.then, /reconcile under the same job identity before any new attempt is allowed/u);
  assert.match(cancelCase.rejection, /continued child admission or dispatch after parent cancellation/u);
  assert.match(cancelCase.rejection, /request or acknowledgement as confirmed terminal cancellation or authoritative child-effect resolution/u);
  assert.match(cancelCase.rejection, /retrying before reconciliation under the same job identity/u);
  assert.match(cancelCase.rejection, /unreconciled outcome as anything other than UNKNOWN/u);
});

test('specialized simulation families stay separate and stochastic replay meaning is explicit', () => {
  const simulation = requirements.find(item => item.id === 'MEDIA-REQ-CAP-SIMULATION');
  const cases = new Map((simulation?.acceptanceCases ?? []).map(item => [item.id, item]));
  const familyCase = cases.get('MEDIA-REQ-CAP-SIMULATION-AC-01');
  const fallbackCase = cases.get('MEDIA-REQ-CAP-SIMULATION-AC-02');
  const stochasticCase = cases.get('MEDIA-REQ-CAP-SIMULATION-AC-03');
  assert.match(familyCase.then, /exact declared model family/u);
  assert.match(fallbackCase.then, /illustrative visual fallback.*non-quantitative/u);
  assert.match(stochasticCase.given, /qualified domain owner.*exact model-family scope/u);
  assert.match(stochasticCase.then, /PRNG algorithm and version/u);
  assert.match(stochasticCase.then, /UNQUALIFIED/u);
  assert.match(stochasticCase.then, /NON_REPLAYABLE/u);
  assert.match(stochasticCase.rejection, /applicability is absent or unknown/u);

  const families = ['cloth', 'soft-body', 'rope', 'particle', 'fluid'];
  for (const family of families) {
    const capability = capabilities.find(item => item.id === `media.simulation.${family}`);
    const outcome = capability.ownerDefinition.semanticOutcomeContract;
    const display = family === 'soft-body' ? 'soft body' : family;
    assert.equal(capability.outcome, outcome.result);
    assert.equal(capability.outcome, capability.ownerDefinition.effect.semanticOutcome);
    assert.match(outcome.result, new RegExp(`this ${display} family is separately qualified`, 'u'));
    assert.match(outcome.result, /visual fallback is explicitly illustrative.*non-quantitative/u);
    assert.ok(outcome.outputDistinctions.some(item => /visual similarity or an illustrative fallback is not a quantitative or scientific validity claim/u.test(item)));
  }

  const agent = capabilities.find(item => item.id === 'media.simulation.agent');
  const stochastic = agent.ownerDefinition.semanticOutcomeContract;
  assert.match(stochastic.result, /PRNG algorithm and implementation\/version/u);
  assert.match(stochastic.result, /NON_REPLAYABLE/u);
  for (const id of ['MEDIA-DECL-P0-AC-023', 'MEDIA-DECL-P0-AC-024', 'MEDIA-DECL-P0-AC-034']) {
    const clause = parseYaml(fs.readFileSync(requirementsPath, 'utf8')).declarativeProductionProfile.acceptanceClauses.find(item => item.id === id);
    assert.match(`${clause.then} ${clause.rejection}`, /PRNG implementation\/version/u);
    assert.match(clause.then, /NON_REPLAYABLE/u);
  }
});

test('PXD-172 defines keyboard privacy, response authorship, and full-duplex voice purpose', () => {
  const source = parseYaml(fs.readFileSync(requirementsPath, 'utf8'));
  const synthesis = source.requirements.find(item => item.id === 'MEDIA-REQ-CAP-SPEECH-SYNTHESIS');
  const speechCases = new Map((synthesis?.acceptanceCases ?? []).map(item => [item.id, item]));
  const response = speechCases.get('MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-03');
  const conversation = speechCases.get('MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-05');
  const overlay = source.recorderStudioProfile.acceptanceClauses.find(item => item.id === 'MEDIA-REC-P0-AC-024');

  assert.ok(synthesis.traceToIntentIds.includes('media.intent.create'));
  assert.ok(synthesis.traceToIntentIds.includes('media.intent.understand'));
  assert.ok(synthesis.relatedOutcomeRefs.includes('media.goal.finished-asset'));
  assert.ok(synthesis.relatedOutcomeRefs.includes('media.goal.understand-media'));
  assert.match(response.given, /response to a user-provided utterance or context.*voice\/personality profile/u);
  assert.match(response.then, /system-authored content.*request\/context provenance/u);
  assert.match(response.then, /factual claims as unverified/u);
  assert.match(response.rejection, /as a user statement, verified fact, or approved communication/u);
  assert.match(conversation.given, /full-duplex voice conversation.*live speech-input session/u);
  assert.match(conversation.when, /concurrently receives live speech input.*spoken response/u);
  assert.match(conversation.then, /observed or transcribed input.*generated response text and synthesized audio/u);
  assert.match(conversation.then, /interruption and cancellation as explicit outcomes/u);
  assert.match(conversation.rejection, /hidden or background microphone capture/u);
  assert.match(conversation.rejection, /complete response when the outcome is unknown or unavailable/u);
  assert.match(overlay.then, /keyboard overlays indicate activity without exposing typed values by default/u);
  assert.match(overlay.then, /sensitive or unclassified values are masked before preview, recording, or export/u);
  assert.match(overlay.rejection, /post-production mask after disclosure/u);

  const crosswalk = JSON.parse(fs.readFileSync('docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json', 'utf8'));
  const row = id => crosswalk.rows.find(item => item.auditId === id);
  assert.ok(row('AUD-CAP-020').pdp0EvidenceRefs.includes('.product-experience/pdp-0-product-truth/requirements.yaml#recorderStudioProfile/acceptanceClauses/@id=MEDIA-REC-P0-AC-024'));
  assert.ok(row('AUD-TTS-017').pdp0EvidenceRefs.includes('.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-SPEECH-SYNTHESIS/acceptanceCases/@id=MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-03'));
  assert.ok(row('AUD-TTS-018').pdp0EvidenceRefs.includes('.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=MEDIA-REQ-CAP-SPEECH-SYNTHESIS/acceptanceCases/@id=MEDIA-REQ-CAP-SPEECH-SYNTHESIS-AC-05'));
  for (const id of ['AUD-CAP-020', 'AUD-TTS-017', 'AUD-TTS-018', 'AUD-SPEC-008', 'AUD-TTS-020']) {
    assert.match(row(id).sourceAcceptanceAlignment, /Preserved verbatim.*provenance.*not PDP-0 acceptance evidence/u);
  }
  assert.equal(row('AUD-CAP-020').independentQcDispositionResolution.currentSourceReviewRef, '.product-experience/decision-log.md#PXD-172');
  assert.equal(row('AUD-TTS-017').independentQcDispositionResolution.currentSourceReviewRef, '.product-experience/decision-log.md#PXD-172');
  assert.equal(row('AUD-TTS-018').independentQcDispositionResolution.currentSourceReviewRef, '.product-experience/decision-log.md#PXD-172');
});
