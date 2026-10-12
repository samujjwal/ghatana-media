#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { validatePdp3ImplementationHandoff } from './lib/pdp3-implementation-handoff-validation.mjs';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outputRef = '.product-experience/pdp-3-product-experience/generated/implementation-handoff.v1.json';
const sha = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const inputRefs = [
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/handoff-contracts.yaml',
  '.product-experience/pdp-1-domain-data/operations.yaml',
  '.product-experience/pdp-1-domain-data/handoff-contracts.yaml',
  '.product-experience/pdp-2-design-interface-system/handoff-contracts.yaml',
  '.product-experience/pdp-3-product-experience/screen-registry.yaml',
  '.product-experience/pdp-3-product-experience/journey-registry.yaml',
  '.product-experience/pdp-3-product-experience/action-registry.yaml',
  '.product-experience/pdp-3-product-experience/api-experience-mapping.yaml',
  '.product-experience/pdp-3-product-experience/handoff-bindings.yaml',
  'config/development-subject-authorities.v1.json'
];
function read(ref) { return fs.readFileSync(path.join(root, ref), 'utf8'); }
function refsByPattern(pattern) {
  const hits = new Map();
  for (const sourceRef of inputRefs) {
    const text = read(sourceRef);
    for (const match of text.matchAll(pattern)) {
      const id = match[1];
      if (!hits.has(id)) hits.set(id, new Set());
      hits.get(id).add(sourceRef);
    }
  }
  return [...hits].sort(([a],[b]) => a.localeCompare(b)).map(([id, sources]) => ({ id, sourceRefs: [...sources].sort() }));
}
const screens = refsByPattern(/^\s*- id:\s*(media\.view\.[A-Za-z0-9._-]+)/gm);
const journeys = refsByPattern(/^\s*- id:\s*(J-\d{2})\b/gm).filter(entry => entry.sourceRefs.includes('.product-experience/pdp-3-product-experience/journey-registry.yaml'));
const p3CapabilityReferences = refsByPattern(/\b(media\.[A-Za-z0-9._-]+)/g).filter(entry => entry.sourceRefs.some(s => s.includes('pdp-3-product-experience')));
const capabilityText = read('.product-experience/pdp-0-product-truth/capabilities.yaml');
const declaredCapabilities = new Set([...capabilityText.split(/^capabilities:\s*$/m).at(-1).matchAll(/^\s*- id:\s*(media\.[A-Za-z0-9._-]+)/gm)].map(match => match[1]));
const capabilities = p3CapabilityReferences.filter(entry => declaredCapabilities.has(entry.id)).map(entry => ({ id: entry.id, sourceRefs: entry.sourceRefs.filter(s => s.includes('pdp-3-product-experience')) }));
const operations = refsByPattern(/\b(media\.operation\.[A-Za-z0-9._-]+)/g).filter(entry => entry.sourceRefs.some(s => s.includes('pdp-3-product-experience')));
if (screens.length !== 47 || journeys.length !== 30) throw new Error(`Expected the pinned PDP-3 source populations (47 screens, 30 journeys); found ${screens.length} and ${journeys.length}`);
const pins = Object.fromEntries(inputRefs.map(ref => [ref, sha(ref)]));
const dependencies = [
  { id: 'shared-public-contracts', owner: 'ghatana-shared', status: 'PENDING_EXTERNAL_OWNER_ACCEPTANCE', sourceRef: '.product-experience/pdp-2-design-interface-system/handoff-contracts.yaml' },
  { id: 'identity-and-authorization', owner: 'ghatana-shared', status: 'PENDING_EXTERNAL_OWNER_CONTRACT', sourceRef: '.product-experience/pdp-1-domain-data/handoff-contracts.yaml' },
  { id: 'tools-experience-consumer', owner: 'ghatana-tools', status: 'PENDING_PUBLIC_BINDING_AND_OWNER_ACCEPTANCE', sourceRef: '.product-experience/pdp-3-product-experience/handoff-bindings.yaml' },
  { id: 'lifecycle-evidence-and-receipts', owner: 'ghatana-lifecycle', status: 'UPSTREAM_ADMISSION_NOT_RECORDED', sourceRef: '.product-experience/pdp-3-product-experience/handoff-bindings.yaml' },
  { id: 'runtime-and-provider-admission', owner: 'media-runtime-and-provider-owners', status: 'NOT_ADMITTED', sourceRef: '.product-experience/pdp-1-domain-data/handoff-contracts.yaml' }
];
const handoff = {
  schemaVersion: 'media.pdp3-implementation-handoff.v1',
  contractVersion: '1.0.0',
  productId: 'media',
  handoffId: 'media.pdp3.implementation.v1',
  sourceDefinitionCut: 'adc9aa6adb9c3ee2f79bf9b3975a2f6daa944ae8',
  authority: 'Derived implementation input only. PDP sources remain canonical; this pack does not authorize execution, runtime availability, or acceptance.',
  sourcePins: pins,
  applicability: { status: 'SOURCE_REFERENCED', basis: 'Capabilities and operations are listed only when referenced by PDP-3 handoff/action/API experience sources.', capabilities, operations },
  experiences: { screens, journeys, populations: { screens: screens.length, journeys: journeys.length, orderedSteps: 130, uiActions: 147, scenarioDefinitions: 31, seededJourneys: 4, explicitlyUnseededJourneys: 26, boundedRecoveryOraclesWithoutSameIdentityQuery: 105 } },
  dependencies,
  admission: { implementationStatus: 'NOT_ADMITTED', runtimeAvailability: false, publicContractAcceptance: false, independentAcceptance: false, lifecycleReceiptCurrent: false, productionQualification: false, releaseAuthorized: false, semantics: 'Flags state the current handoff disposition; downstream owners must update evidence through their authorities.' }
};
validatePdp3ImplementationHandoff(handoff, root);
const rendered = `${JSON.stringify(handoff, null, 2)}\n`;
const output = path.join(root, outputRef);
if (process.argv.includes('--check')) {
  if (!fs.existsSync(output) || fs.readFileSync(output, 'utf8') !== rendered) { console.error(`${outputRef} is stale; regenerate it.`); process.exitCode = 1; }
  else console.log(`${outputRef}: deterministic projection current`);
} else { fs.writeFileSync(output, rendered); console.log(`Wrote ${outputRef}`); }
