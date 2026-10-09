import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { inspectDescriptorCompleteness, inspectSourceFrameTime, inspectResolvedDisplayAspect } from '../scripts/lib/media-descriptor-definition-oracles.mjs';
const require = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = require('yaml');
const Ajv = require('ajv');
const definitions = parse(fs.readFileSync('.product-experience/pdp-1-domain-data/value-objects.yaml', 'utf8')).ownerDescriptorDefinitions;
const byId = new Map(definitions.records.map((r) => [r.id, r]));
const unknown = () => ({ status: 'UNKNOWN', reason: 'source supplied no metadata' });
const known = (value) => ({ status: 'KNOWN', value });
function sample(schema) {
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  if (schema.oneOf) return sample(schema.oneOf[0]);
  if (schema.type === 'object') return Object.fromEntries((schema.required ?? []).map(key => [key, sample(schema.properties[key])]));
  if (schema.type === 'array') return Array.from({ length: schema.minItems ?? 0 }, () => sample(schema.items));
  if (schema.type === 'integer') return schema.minimum ?? 0;
  if (schema.type === 'boolean') return true;
  if (schema.type === 'string') return schema.pattern?.includes('sha256:') ? `sha256:${'a'.repeat(64)}` : 'version-fixture-v1';
  throw new Error('Example requires an exact supported schema type');
}

test('technical descriptors require all slots while unknown metadata cannot satisfy a profile', () => {
  const schema = byId.get('media.value.image-video-technical-descriptor').schema;
  const validate = new Ajv({ strict: true, allErrors: true }).compile(schema);
  const metadata = Object.fromEntries(schema.properties.metadata.required.map((key) => [key, unknown()]));
  const descriptor = { artifactVersionId: 'image-v1', metadata, colorConfigurationFingerprint: unknown(), colorProcessingDomain: unknown(), alphaConversion: unknown(), preserveAlphaRequired: true };
  assert.equal(validate(descriptor), true);
  assert.deepEqual(inspectDescriptorCompleteness(metadata, ['width', 'height']).gaps, ['width', 'height']);
  const ready = { ...metadata, width: known(1920), height: known(1080), alphaMode: known('STRAIGHT') };
  assert.equal(inspectDescriptorCompleteness(ready, ['width', 'height', 'alphaMode']).complete, true);
  assert.equal(inspectDescriptorCompleteness(ready, ['width']).runtimeAdmission, 'NOT_ADMITTED');
  for (const key of schema.properties.metadata.required) {
    const missing = { ...metadata }; delete missing[key];
    assert.equal(validate({ ...descriptor, metadata: missing }), false, `${key} cannot silently disappear`);
  }
  for (const width of [known(0), known(-1), known(1920.5), known(Infinity), { status: 'UNKNOWN', reason: 'absent', value: 1920 }]) {
    assert.equal(validate({ ...descriptor, metadata: { ...metadata, width } }), false);
  }
  assert.equal(validate({ ...descriptor, metadata: { ...metadata, alphaMode: known('FLATTENED_BUT_PRESERVED') } }), false);
  assert.equal(validate({ ...descriptor, colorConfigurationFingerprint: known('a mutable LUT name') }), false);
  assert.equal(inspectDescriptorCompleteness(metadata, ['toString']).complete, false);
  assert.equal(inspectDescriptorCompleteness(metadata, ['width', 'width']).complete, false);
  for (const value of [null, undefined]) assert.equal(inspectDescriptorCompleteness({ width: known(value) }, ['width']).complete, false);
});

test('audio metadata separates sample truth, encoder delay and output-specific profiles', () => {
  const record = byId.get('media.value.audio-technical-descriptor');
  const validate = new Ajv({ strict: true }).compile(record.schema);
  const metadata = Object.fromEntries(record.schema.properties.metadata.required.map((key) => [key, unknown()]));
  const descriptor = { artifactVersionId: 'audio-v1', metadata, masteringDeliveryProfileVersionRef: unknown() };
  assert.equal(validate(descriptor), true);
  assert.equal(inspectDescriptorCompleteness(metadata, ['sampleCount', 'sampleRate', 'encoderDelaySamples']).complete, false);
  assert.equal(validate({ ...descriptor, metadata: { ...metadata, sampleRate: known(16000), channelCount: known(1), sampleCount: known(32000), encoderDelaySamples: known(0), encoderPaddingSamples: known(0) } }), true);
  assert.equal(descriptor.masteringDeliveryProfileVersionRef.status, 'UNKNOWN');
  for (const value of [known(-1), known(1.5), known(9007199254740992)]) assert.equal(validate({ ...descriptor, metadata: { ...metadata, sampleCount: value } }), false);
  assert.match(record.rules.join(' '), /does not define universal output mastering/);
});

test('VFR mapping preserves exact presentation/decode times and never guesses duration from rate', () => {
  const map = { artifactVersionId: 'video-v1', clockId: 'source-pts', streamId: 'video-0', timeBase: { numerator: 1n, denominator: 90000n }, frames: [
    { index: 0, ptsTicks: 0n, dtsTicks: -3003n, durationTicks: 3003n, discontinuityBefore: false },
    { index: 1, ptsTicks: 3003n, dtsTicks: 0n, durationTicks: 6006n, discontinuityBefore: false },
    { index: 2, ptsTicks: 9009n, dtsTicks: 3003n, durationTicks: 3003n, discontinuityBefore: false },
  ] };
  const result = inspectSourceFrameTime(map, 2);
  assert.equal(result.ptsTicks, 9009n); assert.equal(result.durationTicks, 3003n);
  assert.equal(Object.hasOwn(result, 'totalRecordingDuration'), false);
  assert.equal(result.qualification, 'NOT_EVALUATED');
  for (const mutation of [{ ...map, clockId: '' }, { ...map, timeBase: { numerator: 0n, denominator: 1n } }, { ...map, timeBase: { numerator: 1n, denominator: 1n << 63n } }, { ...map, frames: [{ ...map.frames[0], ptsTicks: 0 }] }, { ...map, frames: [{ ...map.frames[0], ptsTicks: 1n << 63n }] }, { ...map, frames: [{ ...map.frames[0], durationTicks: 0n }] }]) assert.throws(() => inspectSourceFrameTime(mutation, 0), /MAP_REQUIRED/);
  const discontinuous = { ...map, frames: [...map.frames.slice(0, 2), { ...map.frames[2], ptsTicks: -1n }] };
  assert.throws(() => inspectSourceFrameTime(discontinuous, 2), /MAP_REQUIRED/);
  assert.equal(inspectSourceFrameTime({ ...discontinuous, frames: [...map.frames.slice(0, 2), { ...discontinuous.frames[2], discontinuityBefore: true }] }, 2).ptsTicks, -1n);
  assert.throws(() => inspectSourceFrameTime(map, 3), /MAP_REQUIRED/);
});

test('display aspect includes pixel aspect and rejects unsupported preservation or unknown permission', () => {
  const plan = { requestedDisplayAspect: { numerator: 16, denominator: 9 }, finalDimensions: { width: 720, height: 405 }, finalPixelAspectRatio: { numerator: 1, denominator: 1 }, aspectPreservationDisposition: 'PRESERVED' };
  assert.equal(inspectResolvedDisplayAspect(plan).allowed, true);
  assert.equal(inspectResolvedDisplayAspect({ ...plan, finalDimensions: { width: 720, height: 400 } }).allowed, false);
  assert.equal(inspectResolvedDisplayAspect({ ...plan, finalDimensions: { width: 1440, height: 1080 }, finalPixelAspectRatio: { numerator: 4, denominator: 3 } }).allowed, true);
  assert.equal(inspectResolvedDisplayAspect({ ...plan, finalPixelAspectRatio: undefined }).allowed, false);
  assert.equal(inspectResolvedDisplayAspect({ ...plan, aspectPreservationDisposition: 'UNKNOWN' }).allowed, false);
  assert.equal(inspectResolvedDisplayAspect({ ...plan, aspectPreservationDisposition: 'EXPLICIT_OWNER_AUTHORIZED_CHANGE', aspectChangeAuthorityRef: unknown() }).allowed, false);
  assert.equal(inspectResolvedDisplayAspect({ ...plan, aspectPreservationDisposition: 'EXPLICIT_OWNER_AUTHORIZED_CHANGE', aspectChangeAuthorityRef: known('authority-decision-v1') }).runtimeAdmission, 'NOT_ADMITTED');
});

test('simulation and replay contracts cannot equate scene appearance with physics or scientific qualification', () => {
  assert.equal(definitions.records.length, 6);
  assert.equal(new Set(definitions.records.map((r) => r.id)).size, 6);
  for (const record of definitions.records) if (record.schema) {
    const validate = new Ajv({ strict: true }).compile(record.schema);
    const valid = sample(record.schema);
    assert.equal(validate(valid), true, `${record.id} declared positive schema example`);
    for (const key of record.schema.required) {
      const missing = structuredClone(valid); delete missing[key];
      assert.equal(validate(missing), false, `${record.id} must reject missing ${key}`);
    }
    assert.equal(validate({ ...valid, runtimeAdmission: 'ADMITTED' }), false, `${record.id} cannot fabricate a runtime admission field`);
  }
  const simulation = byId.get('media.value.simulation-fidelity-definition');
  for (const key of ['modelVersionRef', 'initialConditionsVersionRef', 'boundaryConditionsVersionRef', 'solverVersionRef', 'stepAndToleranceContractRef', 'collisionRepresentationVersionRef', 'massInertiaContractRef', 'materialParametersVersionRef', 'ownerReviewedTierMappingRef']) assert.ok(simulation.schema.required.includes(key));
  assert.match(simulation.rules.join(' '), /Visual LOD changes cannot lower the model fidelity/);
  assert.match(simulation.rules.join(' '), /scene\/render mesh and collision mesh/i);
  const replay = byId.get('media.value.replay-provenance-definition');
  assert.match(replay.rules.join(' '), /metric versions, units, tolerances, scope and measurement methods/);
  assert.match(replay.rules.join(' '), /qualified evidence is missing or unknown/);
  const validateReplay = new Ajv({ strict: true }).compile(replay.schema);
  const replayCandidate = sample(replay.schema);
  for (const replayClass of ['EXACT_ENVIRONMENT', 'TOLERANCE_BOUND', 'STATISTICAL']) assert.equal(validateReplay({ ...replayCandidate, replayClass, qualifiedEvidenceRef: unknown() }), false);
  assert.equal(validateReplay({ ...replayCandidate, replayClass: 'REPLAY_UNAVAILABLE', qualifiedEvidenceRef: unknown() }), true);
  assert.match(definitions.schemaAdmission, /not metadata truth/);
});
