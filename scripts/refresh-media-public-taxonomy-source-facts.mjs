import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse, stringify } = toolsRequire('yaml');
const taxonomyPath = '.product-experience/pdp-3-product-experience/public-effect-finality-taxonomy.yaml';
const actionPath = '.product-experience/pdp-3-product-experience/action-registry.yaml';
const operationPath = '.product-experience/pdp-1-domain-data/operations.yaml';
const [taxonomyText, actionText, operationText] = await Promise.all([
  readFile(taxonomyPath, 'utf8'), readFile(actionPath, 'utf8'), readFile(operationPath, 'utf8'),
]);
const taxonomy = parse(taxonomyText);
const actions = parse(actionText);
const operations = parse(operationText);
const original = new Set(actions.actions.map(({ id }) => id));
const actionById = new Map([...actions.actions, ...(actions.ownerDefinedActions ?? [])].map((action) => [action.id, action]));
const operationById = new Map();
for (const operation of operations.operations ?? []) operationById.set(operation.id, operation);
for (const group of ['capabilityOperationContracts', 'individualOperationContracts', 'ownerDefinedOperationContracts']) {
  for (const operation of operations[group]?.records ?? []) {
    for (const ref of operation.operationRefs ?? [operation.id]) operationById.set(ref, operation);
  }
}
const unionRefs = (bindingOperations, key, envelope) => {
  const values = bindingOperations.flatMap((operation) => operation[key] ?? []);
  return [...new Set(values.length ? values : (envelope[key] ?? []))];
};
const indentField = (key, value) => stringify({ [key]: value }).trimEnd().split('\n').map((line) => `    ${line}`).join('\n');
const replaceField = (block, key, value) => {
  const lines = block.split(/(?<=\n)/u);
  const start = lines.findIndex((line) => line.startsWith(`    ${key}:`));
  if (start < 0) return `${block.trimEnd()}\n${indentField(key, value)}\n`;
  let end = start + 1;
  while (end < lines.length && !/^    [A-Za-z][A-Za-z0-9_-]*:/u.test(lines[end])) end += 1;
  lines.splice(start, end - start, `${indentField(key, value)}\n`);
  return lines.join('');
};
const recordsIndex = taxonomyText.indexOf('\nrecords:\n');
if (recordsIndex < 0) throw new Error('taxonomy records section was not found');
const prefix = taxonomyText.slice(0, recordsIndex + '\nrecords:\n'.length);
const body = taxonomyText.slice(prefix.length);
const recordBlocks = body.split(/(?=^  - (?:id|actionRef):)/mu);
let updated = 0;
for (let i = 0; i < recordBlocks.length; i += 1) {
  let block = recordBlocks[i];
  if (!block.trim()) continue;
  const record = taxonomy.records[updated];
  if (!record) throw new Error('taxonomy text has more rows than parsed records');
  const action = actionById.get(record.actionRef);
  if (!action) throw new Error(`missing action source ${record.actionRef}`);
  const semantics = action.actionDefinitionSemantics ?? {};
  const typed = semantics.typedDefinition ?? {};
  const envelope = semantics.sourceEnvelope;
  if (!envelope) throw new Error(`${record.actionRef} has no source envelope`);
  const exactRefs = typed.exactOperationRefs ?? envelope.exactOperationRefs ?? (envelope.operationRef ? [envelope.operationRef] : []);
  const canonicalBindings = envelope.canonicalBindings ?? typed.canonicalOperationBindings ?? null;
  const bindingOperations = canonicalBindings?.operations ?? (canonicalBindings?.operationRef ? [canonicalBindings] : []);
  const operationKindFacts = exactRefs.map((operationRef) => {
    const bound = bindingOperations.find((entry) => entry.operationRef === operationRef);
    const source = operationById.get(operationRef);
    const operationKind = bound?.operationKind ?? source?.operationKind;
    if (!operationKind) throw new Error(`${record.actionRef} has no exact operation kind source for ${operationRef}`);
    return { operationRef, operationKind };
  });
  const facts = {
    domainOperationDisposition: envelope.domainOperationDisposition ?? typed.domainOperationDisposition ?? null,
    operationRefs: exactRefs,
    operationKindFacts,
    domainObjectRefs: unionRefs(bindingOperations, 'domainObjectRefs', envelope),
    stateRefs: unionRefs(bindingOperations, 'stateRefs', envelope),
    authorityRefs: unionRefs(bindingOperations, 'authorityRefs', envelope),
    requirementRefs: envelope.requirementRefs ?? [],
    profileRef: envelope.profileRef ?? (bindingOperations.length === 1 ? bindingOperations[0].profileRef ?? null : null),
    scopeStatus: envelope.scopeStatus ?? envelope.ownerDefinitionStatus ?? null,
    runtimeAdmission: envelope.runtimeAdmission ?? typed.runtimeAdmission ?? null,
  };
  const ref = `.product-experience/pdp-3-product-experience/action-registry.yaml#${original.has(record.actionRef) ? 'actions' : 'ownerDefinedActions'}/@id=${record.actionRef}/actionDefinitionSemantics/sourceEnvelope`;
  block = replaceField(block, 'sourceEnvelopeRef', ref);
  block = replaceField(block, 'sourceEnvelopeSha256', createHash('sha256').update(JSON.stringify(envelope)).digest('hex'));
  block = replaceField(block, 'sourceEnvelopeOperationRefs', exactRefs);
  block = replaceField(block, 'sourceEnvelopeCanonicalBindings', canonicalBindings);
  block = replaceField(block, 'sourceEnvelopeFacts', facts);
  block = replaceField(block, 'sourceHistoricalPublicBinding', {
    sourceDecisionRef: semantics.sourceDecisionRef ?? null,
    grammarDecisionRef: semantics.grammarDecisionRef ?? null,
    reviewDecisionRef: semantics.reviewDecisionRef ?? null,
    operationRef: semantics.operationRef ?? null,
    publicEffectId: semantics.publicEffect?.id ?? null,
    publicFinalityId: semantics.publicFinality?.id ?? null,
  });
  recordBlocks[i] = block;
  updated += 1;
}
if (updated !== taxonomy.records.length) throw new Error(`updated ${updated} of ${taxonomy.records.length} taxonomy records`);
await writeFile(taxonomyPath, `${prefix}${recordBlocks.join('')}`);
console.log(`Refreshed exact source envelope refs, digests, operation bindings, and facts for ${updated} actions.`);
