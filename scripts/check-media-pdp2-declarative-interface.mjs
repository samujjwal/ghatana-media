// PDP-2-local validation for declarative-production presentation bindings.
// Reads only PDP-0/PDP-1 predecessors and PDP-2 source; it does not imply PDP-3,
// runtime, Explorer, owner acceptance, phase exit, or release admission.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseDocument } from 'yaml';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const declarativePdp2Paths = {
  p0: '.product-experience/pdp-0-product-truth/requirements.yaml',
  p1: '.product-experience/pdp-1-domain-data/declarative-production-contracts.yaml',
  p2: '.product-experience/pdp-2-design-interface-system/animation-simulation-grammar.yaml',
  recorderP2: '.product-experience/pdp-2-design-interface-system/recorder-studio-interface.yaml',
};
const ids = Array.from({ length: 61 }, (_, i) => `MEDIA-DECL-P0-AC-${String(i + 1).padStart(3, '0')}`);
const groups = { ANIMATION: 17, SIMULATION: 22, TUTORPUTOR: 12, UNIFIED: 10 };
const surfaces = [
  'media.surface.recorder-orchestrator',
  'media.surface.capture-adapters',
  'media.surface.production-studio',
  'media.surface.interactive-demo-player',
];
const sameSet = (left, right) => Array.isArray(left) && new Set(left).size === left.length &&
  new Set(right).size === right.length && left.length === right.length && left.every(value => right.includes(value));

export function verifyPdp2DeclarativeInterface({ repoRoot = root, overrides = {} } = {}) {
  const errors = [];
  const fail = message => errors.push(message);
  const docs = {};
  for (const [key, relative] of Object.entries(declarativePdp2Paths)) {
    const raw = Object.hasOwn(overrides, key) ? overrides[key] : fs.readFileSync(path.join(repoRoot, relative), 'utf8');
    const parsed = parseDocument(raw, { strict: true, uniqueKeys: true });
    if (parsed.errors.length) {
      for (const issue of parsed.errors) fail(`${key}: invalid or duplicate YAML: ${issue.message}`);
      continue;
    }
    try { docs[key] = parsed.toJS(); } catch (error) { fail(`${key}: invalid document shape: ${error.message}`); }
  }
  const p0 = docs.p0?.declarativeProductionProfile ?? {};
  const p1 = docs.p1 ?? {};
  const p2 = docs.p2?.declarativeProductionInterface ?? {};
  const recorder = docs.recorderP2 ?? {};
  const p0Rows = p0.acceptanceClauses ?? [];
  const p1Rows = p1.caseOperationBindings ?? [];
  const p2Rows = p2.caseInterfaceBindings ?? [];
  const p0ById = new Map(p0Rows.map(row => [row.id, row]));
  const p1ById = new Map(p1Rows.map(row => [row.caseId, row]));
  const p2ById = new Map(p2Rows.map(row => [row.caseId, row]));

  if (!sameSet(p0Rows.map(row => row.id), ids) || p0.additionalAcceptanceCaseCount !== 61)
    fail('PDP-0 predecessor must contain the exact 61 canonical declarative case identities');
  if (p1.denominator?.operationBindings !== 61 || !sameSet(p1Rows.map(row => row.caseId), ids))
    fail('PDP-1 predecessor must bind the exact 61 declarative cases');
  if (p2.caseCount !== 61 || !sameSet(p2Rows.map(row => row.caseId), ids))
    fail('PDP-2 must bind the exact 61 canonical declarative cases');
  if (!sameSet(p2.surfaces, surfaces)) fail('PDP-2 must preserve the exact four declarative surface identities');
  if (p2.existingManualStudioOperationKinds !== 52 ||
      recorder.manualOperationParity?.canonicalOperationCount !== 52 ||
      recorder.manualOperationParity?.operations?.length !== 52 ||
      p2.manualParitySource !== `${declarativePdp2Paths.recorderP2}#manualOperationParity`)
    fail('PDP-2 must bind exact existing 52-kind Studio manual-operation parity');

  for (const [group, count] of Object.entries(groups)) {
    if (p0Rows.filter(row => row.group === group).length !== count ||
        p1Rows.filter(row => row.group === group).length !== count ||
        p2Rows.filter(row => row.group === group).length !== count)
      fail(`${group}: PDP-0/PDP-1/PDP-2 group denominator must remain ${count}`);
  }

  for (const id of ids) {
    const r0 = p0ById.get(id), r1 = p1ById.get(id), r2 = p2ById.get(id);
    if (!r0 || !r1 || !r2) continue;
    if (r1.capabilityRef !== r0.capabilityLeafId || r2.capabilityRef !== r0.capabilityLeafId ||
        r1.surfaceId !== r0.surfaceId || r2.surfaceId !== r0.surfaceId ||
        r1.parentRequirementId !== r0.parentRequirementId)
      fail(`${id}: PDP-2 capability, requirement, or surface differs from exact P0/P1 predecessor`);
    if (!r1.canonicalOperationRef || r2.operationRef !== r1.canonicalOperationRef ||
        r2.sourceP1Binding !== `${declarativePdp2Paths.p1}#caseOperationBindings/@caseId=${id}`)
      fail(`${id}: PDP-2 operation/source binding must resolve to the exact P1 case row`);
    if (!r0.given || !r0.when || !r0.then || !r0.rejection ||
        !r2.statesRequired?.includes('OUTCOME_UNKNOWN') ||
        !r2.negative?.includes('no-fake-execution'))
      fail(`${id}: explicit positive, negative, unknown-finality, and no-fake-execution semantics are required`);
    if (r2.admission !== 'SCREEN_REUSE_PROPOSAL_NOT_RUNTIME_OR_EXPLORER_EVIDENCE')
      fail(`${id}: admission must remain a screen-reuse proposal without runtime or Explorer evidence`);
  }
  if (p2.status !== 'SOURCE_AUTHORED_PDP2_DEFINITION')
    fail('PDP-2 successor status must be source-current and distinct from phase DEV_COMPLETE');
  if (!p2.simulationGrammar?.stateRule?.includes('tStory') || !p2.simulationGrammar?.stateRule?.includes('tSim') ||
      !p2.simulationGrammar?.visualOutputs?.includes('never the reverse'))
    fail('PDP-2 must keep model state and presentation output authority distinct');
  if (!p2.tutorPutorIntegration?.evidenceOwner?.startsWith('TutorPutor only') ||
      !p2.headlessAndEmbeddedParity?.apiOnly?.includes('do not invent a real browser screen'))
    fail('PDP-2 must preserve TutorPutor evidence ownership and headless no-fake-screen boundary');

  return { errors, stats: { p0Cases: p0Rows.length, p1Bindings: p1Rows.length, p2Bindings: p2Rows.length,
    surfaceCount: surfaces.length, manualEditKinds: recorder.manualOperationParity?.operations?.length ?? 0 } };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const result = verifyPdp2DeclarativeInterface();
  process.stdout.write(JSON.stringify({ status: result.errors.length ? 'FAIL' : 'PASS', ...result }, null, 2) + '\n');
  if (result.errors.length) process.exitCode = 1;
}
