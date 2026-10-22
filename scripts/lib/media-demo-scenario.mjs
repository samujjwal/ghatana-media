import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import YAML from 'yaml';

const ROOT = path.resolve(import.meta.dirname, '../..');
const PHASE_STATUS_FILES = [0, 1, 2, 3].map((phase) => `docs/implementation/pdp-${phase}-phase-dev-status.json`);
export const SOURCE_FILES = [
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  '.product-experience/pdp-1-domain-data/operations.yaml',
  '.product-experience/pdp-1-domain-data/states.yaml',
  '.product-experience/pdp-2-design-interface-system/component-contracts.yaml',
  '.product-experience/pdp-2-design-interface-system/interface-grammar.yaml',
  '.product-experience/pdp-3-product-experience/demo-recording-standard.yaml',
  '.product-experience/pdp-3-product-experience/journey-registry.yaml',
  '.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml',
  '.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml',
  '.product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml',
];

const digest = (value) => `sha256:${createHash('sha256').update(value).digest('hex')}`;
const exact = (items, id) => items.find((item) => item?.id === id);

export async function readSources(root = ROOT) {
  const parsed = {};
  const fingerprints = {};
  for (const sourcePath of SOURCE_FILES) {
    const bytes = await readFile(path.join(root, sourcePath));
    fingerprints[sourcePath] = digest(bytes);
    parsed[sourcePath] = sourcePath.endsWith('.yaml') ? YAML.parse(bytes.toString('utf8')) : JSON.parse(bytes.toString('utf8'));
  }
  const phaseStatuses = {};
  for (const statusPath of PHASE_STATUS_FILES) {
    phaseStatuses[statusPath] = JSON.parse(await readFile(path.join(root, statusPath), 'utf8'));
  }
  return { parsed, fingerprints, phaseStatuses };
}

function pushIssue(issues, code, sourceRef, detail) {
  issues.push({ code, sourceRef, detail });
}

function resolveP1Operation(operations, operationRef) {
  const direct = (operations.operations ?? []).find((item) => item.id === operationRef);
  const contracts = operations.individualOperationContracts?.records ?? [];
  const contract = contracts.find((item) => item.id === operationRef);
  const slice = (operations.ownerDefinedOperationContracts?.records ?? []).find((item) => item.id === operationRef);
  return direct ?? contract ?? slice ?? null;
}

export function buildDemoScenario({ parsed, fingerprints, phaseStatuses = {} }) {
  const issues = [];
  const standard = parsed['.product-experience/pdp-3-product-experience/demo-recording-standard.yaml'];
  const registry = parsed['.product-experience/pdp-3-product-experience/journey-registry.yaml'];
  const purpose = parsed['.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml'];
  const channels = parsed['.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml'];
  const fixtures = parsed['.product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml'];
  const operations = parsed['.product-experience/pdp-1-domain-data/operations.yaml'];
  const sourcePhaseByPath = new Map([
    [SOURCE_FILES[0], 0], [SOURCE_FILES[1], 0], [SOURCE_FILES[2], 1], [SOURCE_FILES[3], 1],
    [SOURCE_FILES[4], 2], [SOURCE_FILES[5], 2], ...SOURCE_FILES.slice(6).map((sourcePath) => [sourcePath, 3]),
  ]);
  for (const [sourcePath, phase] of sourcePhaseByPath) {
    const statusPath = `docs/implementation/pdp-${phase}-phase-dev-status.json`;
    const recorded = phaseStatuses[statusPath]?.sourceShaSet?.[sourcePath];
    const actual = fingerprints[sourcePath]?.replace(/^sha256:/, '');
    if (!recorded || recorded !== actual) {
      pushIssue(issues, 'STALE_MATERIAL_HASH', `${statusPath}#sourceShaSet/${sourcePath}`, `Expected ${recorded ?? 'no recorded fingerprint'}, observed ${actual ?? 'no source fingerprint'}.`);
    }
  }
  for (const [statusPath, status] of Object.entries(phaseStatuses)) {
    if (status.status !== 'DEV_COMPLETE' || (status.outstandingMeaningIds?.length ?? 0) > 0) {
      pushIssue(issues, 'PDP_PHASE_NOT_SOURCE_COMPLETE', `${statusPath}#status`, `status=${status.status ?? 'UNKNOWN'}; outstandingMeaningIds=${status.outstandingMeaningIds?.length ?? 'UNKNOWN'}`);
    }
  }
  for (const phase of ['PDP-0', 'PDP-1', 'PDP-2', 'PDP-3']) {
    if (!phaseStatuses[`docs/implementation/${phase.toLowerCase()}-phase-dev-status.json`]) {
      pushIssue(issues, 'PDP_PHASE_STATUS_MISSING', `docs/implementation/${phase.toLowerCase()}-phase-dev-status.json`, 'A source-current phase status record is required.');
    }
  }
  const scenarioId = standard.scope?.scenarioId;
  const journeyIds = standard.scope?.journeyIds ?? [];
  if (!scenarioId || journeyIds.length === 0) pushIssue(issues, 'SOURCE_SCENARIO_IDENTITY_MISSING', '.product-experience/pdp-3-product-experience/demo-recording-standard.yaml#scope', 'Adopted scenario id and supporting journey ids are required.');

  const journeys = journeyIds.map((journeyId) => exact(registry.journeys ?? [], journeyId));
  for (const [index, journeyId] of journeyIds.entries()) {
    if (!journeys[index]) pushIssue(issues, 'JOURNEY_NOT_FOUND', '.product-experience/pdp-3-product-experience/journey-registry.yaml#journeys', journeyId);
  }

  const purposeRecords = (purpose.records ?? []).filter((record) => journeyIds.includes(record.journeyRef));
  const channelEdges = (channels.edges ?? []).filter((edge) => journeyIds.includes(edge.journeyId) || journeyIds.includes(edge.journeyRef));
  const journeyChannels = Object.fromEntries(journeyIds.map((journeyId) => {
    const edges = channelEdges.filter((edge) => edge.journeyId === journeyId || edge.journeyRef === journeyId);
    const selected = edges.find((edge) => /\.web\.v1$/u.test(edge.id ?? '') || /web/iu.test(edge.channelRef ?? ''));
    if (!selected) pushIssue(issues, 'PDP3_CHANNEL_EDGE_MISSING', '.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml#edges', `No source-defined web edge for ${journeyId}.`);
    else if (!['ADMITTED', 'CURRENT', 'OWNER_ADMITTED'].includes(selected.runtimeAdmission)) {
      pushIssue(issues, 'UNADMITTED_CHANNEL', `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml#edges/@id=${selected.id}`, `runtimeAdmission=${selected.runtimeAdmission ?? 'UNKNOWN'}`);
    }
    return [journeyId, selected ?? null];
  }));
  const selectedChannel = journeyChannels['J-03'];

  const beats = purposeRecords.map((record) => {
    const sourceRef = `.product-experience/pdp-3-product-experience/journey-purpose-bindings.yaml#records/@id=${record.id}`;
    const operationRefs = [...new Set([...(record.operationRefs ?? []), ...(record.supportingOperationRefs ?? [])])];
    const resolvedOperations = operationRefs.map((operationRef) => {
      const found = resolveP1Operation(operations, operationRef);
      if (!found) pushIssue(issues, 'P1_RESULT_BINDING_MISSING', sourceRef, `Unresolved operation ${operationRef}`);
      return { operationRef, sourceRef: found ? `.product-experience/pdp-1-domain-data/operations.yaml#${found.id}` : null };
    });
    if (!(record.stepRef && record.actionRef) && record.actionRef !== null) pushIssue(issues, 'PDP3_STEP_ANCHOR_MISSING', sourceRef, 'A source step reference and action identity are required (action may be explicitly null).');
    return {
      beatId: `${record.journeyRef}:${record.id}`,
      journeyId: record.journeyRef,
      stepRef: record.stepRef,
      purposeBindingRef: sourceRef,
      actionIntentRef: record.actionRef ?? null,
      expectedObservationRefs: [...new Set([...(record.outcomeRefs ?? []), ...(record.stateRefs ?? [])])],
      operationBindings: resolvedOperations,
      capabilityRefs: record.capabilityRefs ?? [],
      requirementRefs: record.requirementRefs ?? [],
      domainObjectRefs: record.domainObjectRefs ?? [],
      authorityRefs: record.authorityRefs ?? [],
      sourceRefs: record.sourceRefs ?? [],
      recovery: record.recovery ?? null,
      finality: record.finality ?? null,
    };
  });

  const fixtureIds = standard.scope?.fixtureIds ?? [];
  for (const fixtureId of fixtureIds) {
    if (!exact(fixtures.fixtures ?? [], fixtureId)) pushIssue(issues, 'FIXTURE_NOT_FOUND', '.product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml#fixtures', fixtureId);
  }

  const requiredP1OpsByJourney = new Map();
  for (const beat of beats) {
    const existing = requiredP1OpsByJourney.get(beat.journeyId) ?? new Set();
    for (const binding of beat.operationBindings) existing.add(binding.operationRef);
    requiredP1OpsByJourney.set(beat.journeyId, existing);
  }
  const requiredP1Ops = new Set([...requiredP1OpsByJourney.values()].flatMap((set) => [...set]));
  for (const [journeyId, operationRefs] of requiredP1OpsByJourney) {
    const edge = journeyChannels[journeyId];
    const edgeOps = new Set(edge?.pdp1OperationRefs ?? []);
    for (const operationRef of operationRefs) {
      if (!edgeOps.has(operationRef)) pushIssue(issues, 'P1_OPERATION_NOT_JOINED_TO_SELECTED_EDGE', `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml#edges/@id=${edge?.id ?? `${journeyId}-web-missing`}`, operationRef);
    }
  }

  const scenario = {
    schemaVersion: 'media.demo-scenario-spec.v1',
    productId: standard.productId,
    demoScenarioId: scenarioId,
    scenarioRevision: '1',
    journeyId: 'J-03',
    variantId: scenarioId,
    surfaceId: selectedChannel?.consumerSurfaceId ?? 'UNBOUND',
    sourcePhaseMaterialFingerprints: fingerprints,
    sourcePhaseStatuses: Object.fromEntries(Object.entries(phaseStatuses).map(([statusPath, status]) => [status.phase, {
      status: status.status,
      mainSha: status.mainSha,
      outstandingMeaningCount: status.outstandingMeaningIds?.length ?? null,
    }])),
    sourceCoverage: {
      pdp0: [
        ...journeys.map((journey) => ({ journeyId: journey?.id, sourceRef: journey?.pdp0JourneyRef ?? null })),
        ...[...new Set(beats.flatMap((beat) => beat.capabilityRefs))].sort().map((capabilityId) => ({ sourceRef: `.product-experience/pdp-0-product-truth/capabilities.yaml#capabilities/@id=${capabilityId}` })),
        ...[...new Set(beats.flatMap((beat) => beat.requirementRefs))].sort().map((requirementId) => ({ sourceRef: `.product-experience/pdp-0-product-truth/requirements.yaml#requirements/@id=${requirementId}` })),
      ],
      pdp1: [...requiredP1Ops].sort().map((operationRef) => ({ operationRef, sourceRef: resolveP1Operation(operations, operationRef) ? `.product-experience/pdp-1-domain-data/operations.yaml#${operationRef}` : null })),
      pdp2: [
        ...new Set([
          ...Object.values(journeyChannels).filter(Boolean).flatMap((edge) => [edge.p2GrammarRef, ...(edge.p2SupportingGrammarRefs ?? [])]),
          ...beats.flatMap((beat) => beat.sourceRefs.filter((ref) => ref.includes('pdp-2-design-interface-system'))),
        ].filter(Boolean)),
      ],
      pdp3: [
        ...journeys.map((journey) => ({ journeyId: journey?.id, sourceRef: journey?.contract ?? null })),
        ...Object.values(journeyChannels).filter(Boolean).map((edge) => ({ journeyId: edge.journeyId, sourceRef: `.product-experience/pdp-3-product-experience/journey-channel-contract-bindings.yaml#edges/@id=${edge.id}` })),
      ],
    },
    fixture: {
      fixtureIds,
      fixtureRegistryRef: '.product-experience/pdp-3-product-experience/scenario-fixture-registry.yaml',
      sourceDataClass: 'CENTRALLY_MOCKED_STATIC_FIXTURE',
      rightsConsentRef: '.product-experience/pdp-3-product-experience/demo-recording-standard.yaml#scope',
    },
    storyboard: { orderedSceneIds: standard.scope?.orderedSceneIds ?? [], beats },
    targets: {
      captureTargets: ['EXPLORER_SIMULATED', 'PRODUCT_EXECUTED'],
      explorerRecordingRef: standard.captures?.explorer?.manifestRef ?? null,
      productRecordingRef: null,
      productChannelAdmission: selectedChannel?.runtimeAdmission ?? 'UNKNOWN',
    },
    status: issues.length === 0 ? 'SOURCE_RECIPE_CANDIDATE' : 'BLOCKED_SOURCE_TRACE',
    validationIssues: issues,
    effectsExecuted: false,
    canonicalAdmission: 'NOT_ASSERTED',
  };
  return scenario;
}

export function validateDemoScenario(scenario) {
  const errors = [];
  if (scenario.schemaVersion !== 'media.demo-scenario-spec.v1') errors.push({ code: 'SCHEMA_VERSION_INVALID' });
  if (!scenario.demoScenarioId || !scenario.journeyId || !scenario.variantId) errors.push({ code: 'IDENTITY_REQUIRED' });
  if (!scenario.sourcePhaseMaterialFingerprints || Object.keys(scenario.sourcePhaseMaterialFingerprints).length !== SOURCE_FILES.length) errors.push({ code: 'SOURCE_FINGERPRINTS_INCOMPLETE' });
  if (!Array.isArray(scenario.storyboard?.beats) || scenario.storyboard.beats.length === 0) errors.push({ code: 'STORYBOARD_BEATS_REQUIRED' });
  if (scenario.storyboard?.beats?.some((beat) => !beat.stepRef || !beat.purposeBindingRef)) errors.push({ code: 'BEAT_SOURCE_BINDING_REQUIRED' });
  if (scenario.targets?.productRecordingRef !== null) errors.push({ code: 'PRODUCT_RECORDING_MUST_START_UNRECORDED' });
  if (scenario.effectsExecuted !== false || scenario.canonicalAdmission !== 'NOT_ASSERTED') errors.push({ code: 'EFFECT_OR_ADMISSION_CLAIM_FORBIDDEN' });
  errors.push(...(scenario.validationIssues ?? []));
  return errors;
}

function resolvePointer(root, reference) {
  if (!reference.startsWith('#/')) throw new Error(`Unsupported schema reference ${reference}`);
  return reference.slice(2).split('/').map((part) => part.replace(/~1/g, '/').replace(/~0/g, '~')).reduce((value, part) => value?.[part], root);
}

export function validateJsonSchema(value, schema, rootSchema = schema, pointer = '$') {
  const errors = [];
  if (schema.$ref) return validateJsonSchema(value, resolvePointer(rootSchema, schema.$ref), rootSchema, pointer);
  if (schema.type) {
    const types = Array.isArray(schema.type) ? schema.type : [schema.type];
    const matches = types.some((type) => type === 'null' ? value === null
      : type === 'array' ? Array.isArray(value)
        : type === 'object' ? value !== null && typeof value === 'object' && !Array.isArray(value)
          : type === 'integer' ? Number.isInteger(value)
            : type === 'number' ? typeof value === 'number'
              : type === 'string' ? typeof value === 'string'
                : type === 'boolean' ? typeof value === 'boolean' : false);
    if (!matches) return [{ pointer, keyword: 'type', expected: types }];
  }
  if (Object.hasOwn(schema, 'const') && JSON.stringify(value) !== JSON.stringify(schema.const)) errors.push({ pointer, keyword: 'const', expected: schema.const });
  if (schema.enum && !schema.enum.includes(value)) errors.push({ pointer, keyword: 'enum' });
  if (typeof value === 'string') {
    if (schema.minLength && value.length < schema.minLength) errors.push({ pointer, keyword: 'minLength' });
    if (schema.pattern && !(new RegExp(schema.pattern, 'u')).test(value)) errors.push({ pointer, keyword: 'pattern' });
  }
  if (Array.isArray(value)) {
    if (schema.minItems && value.length < schema.minItems) errors.push({ pointer, keyword: 'minItems' });
    if (schema.uniqueItems && new Set(value.map((item) => JSON.stringify(item))).size !== value.length) errors.push({ pointer, keyword: 'uniqueItems' });
    if (schema.items) value.forEach((item, index) => errors.push(...validateJsonSchema(item, schema.items, rootSchema, `${pointer}[${index}]`)));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const keys = Object.keys(value);
    for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) errors.push({ pointer, keyword: 'required', missing: key });
    if (schema.minProperties && keys.length < schema.minProperties) errors.push({ pointer, keyword: 'minProperties' });
    for (const [key, propertySchema] of Object.entries(schema.properties ?? {})) {
      if (Object.hasOwn(value, key)) errors.push(...validateJsonSchema(value[key], propertySchema, rootSchema, `${pointer}.${key}`));
    }
    if (schema.additionalProperties === false) {
      for (const key of keys) if (!Object.hasOwn(schema.properties ?? {}, key)) errors.push({ pointer: `${pointer}.${key}`, keyword: 'additionalProperties' });
    } else if (schema.additionalProperties && typeof schema.additionalProperties === 'object') {
      for (const key of keys) if (!Object.hasOwn(schema.properties ?? {}, key)) errors.push(...validateJsonSchema(value[key], schema.additionalProperties, rootSchema, `${pointer}.${key}`));
    }
  }
  return errors;
}

export { ROOT };
