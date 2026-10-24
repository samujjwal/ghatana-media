import {createHash} from 'node:crypto';
import YAML from 'yaml';
import {buildSemanticBatchPostimages} from './media-pdp0-semantic-case-batch-projector.mjs';

export const ROOT_SELECTED_R7_TARGETS = Object.freeze({
  capabilities: '.product-experience/pdp-0-product-truth/capabilities.yaml',
  requirements: '.product-experience/pdp-0-product-truth/requirements.yaml',
  leaf: '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  crosswalk: 'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
});

export const ROOT_SELECTED_R7_ALLOWED_OPERATIONS = Object.freeze([
  'ADD_CAPABILITY_DEFINITION',
  'APPEND_REQUIREMENT_CASE',
  'APPEND_REQUIREMENT_CAPABILITY_BINDING',
  'PATCH_CROSSWALK_TRACE',
]);
export const ROOT_SELECTED_R9_REPAIR_OPERATIONS = Object.freeze([
  'REVISE_CAPABILITY_OWNER_DEFINITION',
  'REVISE_ACCEPTANCE_CASE_TEXT',
]);

export const ROOT_SELECTED_R7_CROSSWALK_PATCH_FIELDS = Object.freeze([
  'pdp0EvidenceRefs', 'rootDirectedSourceCandidate', 'proposedPdp0SourceChange',
]);
export const ROOT_SELECTED_R7_CURRENT7 = Object.freeze([
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
  '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  '.product-experience/pdp-0-product-truth/campaign-extensions.yaml',
  '.product-experience/decision-log.md',
  '.product-experience/pdp-0-product-truth/quality-policy.yaml',
]);

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function stable(value, seen = new WeakMap()) {
  if (!value || typeof value !== 'object') return value;
  if (seen.has(value)) return seen.get(value);
  const result = Array.isArray(value) ? [] : {};
  seen.set(value, result);
  if (Array.isArray(value)) for (const item of value) result.push(stable(item, seen));
  else for (const key of Object.keys(value).sort()) result[key] = stable(value[key], seen);
  return result;
}
const canonical = value => JSON.stringify(stable(value));
const fail = message => { throw new Error(`root-selected R7 source projector rejected candidate: ${message}`); };
const exactJson = value => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);

function parseYaml(bytes, ref) {
  const doc = YAML.parseDocument(bytes.toString('utf8'), {uniqueKeys: true, prettyErrors: true});
  if (doc.errors.length) fail(`${ref} is invalid YAML: ${doc.errors.map(error => error.message).join('; ')}`);
  return doc;
}

function parseSources(sourceBytes) {
  if (!sourceBytes || Object.keys(sourceBytes).sort().join('|') !== Object.values(ROOT_SELECTED_R7_TARGETS).sort().join('|')) fail('exact four source target set required');
  for (const ref of Object.values(ROOT_SELECTED_R7_TARGETS)) if (!Buffer.isBuffer(sourceBytes[ref])) fail(`exact source bytes required for ${ref}`);
  const capabilities = parseYaml(sourceBytes[ROOT_SELECTED_R7_TARGETS.capabilities], ROOT_SELECTED_R7_TARGETS.capabilities);
  const requirements = parseYaml(sourceBytes[ROOT_SELECTED_R7_TARGETS.requirements], ROOT_SELECTED_R7_TARGETS.requirements);
  const leaf = parseYaml(sourceBytes[ROOT_SELECTED_R7_TARGETS.leaf], ROOT_SELECTED_R7_TARGETS.leaf);
  let crosswalk;
  try { crosswalk = JSON.parse(sourceBytes[ROOT_SELECTED_R7_TARGETS.crosswalk].toString('utf8')); }
  catch (error) { fail(`crosswalk JSON invalid: ${error.message}`); }
  if (!Array.isArray(crosswalk.rows)) fail('crosswalk.rows must be an array');
  return {capabilities, requirements, leaf, crosswalk};
}

function appendById(sequence, record, label) {
  if (!record || typeof record.id !== 'string' || sequence.items.some(item => item.get('id') === record.id)) fail(`${label} identity must be new and unique: ${record?.id}`);
  sequence.add(YAML.parseDocument('').createNode(record));
}

function capabilityDefinitionIsBounded(record) {
  if (!record || typeof record.id !== 'string' || typeof record.operation !== 'string' || !record.operation.trim()) return false;
  const def = record.ownerDefinition;
  if (!Array.isArray(def?.typedInputSlots) || !def.typedInputSlots.length || !Array.isArray(def?.successOutputs) || !def.successOutputs.length
      || !def.nonSuccessOutputs || def.errors === undefined || !Array.isArray(record.requiredAuthority) || !record.requiredAuthority.length
      || !Array.isArray(record.explicitUnsupportedCases) || !record.explicitUnsupportedCases.length || !Array.isArray(record.acceptanceCases)) return false;
  const positives = record.acceptanceCases.filter(item => item.polarity === 'POSITIVE');
  const negatives = record.acceptanceCases.filter(item => item.polarity === 'NEGATIVE');
  return positives.length > 0 && negatives.length > 0
    && record.acceptanceCases.every(item => typeof item.id === 'string' && ['POSITIVE', 'NEGATIVE'].includes(item.polarity)
      && typeof item.given === 'string' && typeof item.when === 'string' && typeof item.then === 'string'
      && (item.sourceAuditId === undefined || item.sourceAuditId === record.sourceAuditId)
      && (item.sourceCapabilityId === undefined || item.sourceCapabilityId === record.id));
}

function validateOperation(op) {
  if (!op || ![...ROOT_SELECTED_R7_ALLOWED_OPERATIONS, ...ROOT_SELECTED_R9_REPAIR_OPERATIONS].includes(op.kind) || typeof op.operationId !== 'string' || !op.operationId
      || typeof op.auditId !== 'string' || !op.auditId) fail(`unregistered R7 candidate operation kind or identity: ${op?.kind}`);
  if (op.kind === 'ADD_CAPABILITY_DEFINITION' && !capabilityDefinitionIsBounded(op.record)) fail(`invalid capability semantic bundle for ${op.auditId}`);
  if (op.kind === 'APPEND_REQUIREMENT_CASE' && (!op.record?.id || typeof op.record.given !== 'string' || typeof op.record.when !== 'string'
      || typeof op.record.then !== 'string' || !op.record.sourceCapabilityId || !op.record.sourceCapabilityCaseId
      || op.sourceCapabilityId !== op.record.sourceCapabilityId || op.sourceCapabilityCaseId !== op.record.sourceCapabilityCaseId
      || String(op.polarity).toUpperCase() !== String(op.record.polarity).toUpperCase())) fail(`invalid parent requirement relation for ${op.auditId}`);
  if (op.kind === 'APPEND_REQUIREMENT_CAPABILITY_BINDING' && (!op.requirementId || !op.capabilityId)) fail(`invalid requirement binding for ${op.auditId}`);
  if (op.kind === 'PATCH_CROSSWALK_TRACE') {
    if (!op.patch || Object.keys(op.patch).some(key => !ROOT_SELECTED_R7_CROSSWALK_PATCH_FIELDS.includes(key))
        || !op.patch.rootDirectedSourceCandidate || !op.patch.proposedPdp0SourceChange || !Array.isArray(op.patch.pdp0EvidenceRefs)) {
      fail(`crosswalk patch for ${op.auditId} includes an undeclared field or omits required trace fields`);
    }
  }
  if (op.kind === 'REVISE_CAPABILITY_OWNER_DEFINITION') {
    if (Object.keys(op).sort().join('|') !== ['auditId','beforeOwnerDefinitionSha256','capabilityId','kind','operationId','patch'].sort().join('|')
        || !/^[a-f0-9]{64}$/u.test(op.beforeOwnerDefinitionSha256 ?? '')
        || !op.patch || Object.keys(op.patch).sort().join('|') !== 'successOutputs|typedInputSlots'
        || !Array.isArray(op.patch.typedInputSlots) || !Array.isArray(op.patch.successOutputs)) {
      fail(`invalid exact R9 owner-definition repair for ${op.capabilityId}`);
    }
  }
  if (op.kind === 'REVISE_ACCEPTANCE_CASE_TEXT') {
    if (Object.keys(op).sort().join('|') !== ['auditId','beforeCaseSha256','caseId','kind','operationId','polarity','sourceCapabilityCaseId','targetId','targetKind','patch'].sort().join('|')
        || !['CAPABILITY','REQUIREMENT'].includes(op.targetKind) || typeof op.targetId !== 'string' || typeof op.caseId !== 'string'
        || typeof op.sourceCapabilityCaseId !== 'string' || !['POSITIVE','NEGATIVE'].includes(op.polarity)
        || !/^[a-f0-9]{64}$/u.test(op.beforeCaseSha256 ?? '')
        || !op.patch || Object.keys(op.patch).sort().join('|') !== 'given|then|when'
        || !['given','when','then'].every(key => typeof op.patch[key] === 'string' && op.patch[key].trim())) {
      fail(`invalid exact R9 acceptance-case text repair for ${op.caseId}`);
    }
  }
}

export function validateRootSelectedSourceIntegrationR7Operations(operations, retainedOperationIds = []) {
  if (!Array.isArray(operations) || !operations.length) fail('R7 source operations are required');
  const ids = new Set();
  for (const op of operations) {
    validateOperation(op);
    if (ids.has(op.operationId)) fail(`duplicate operationId ${op.operationId}`);
    if (retainedOperationIds.includes(op.operationId)) fail(`operationId collides with retained projection history: ${op.operationId}`);
    ids.add(op.operationId);
  }
  return true;
}

export function assertRootSelectedCurrent7Preimages(currentTargets, currentBytesByRef) {
  if (!Array.isArray(currentTargets) || currentTargets.length !== 7
      || currentTargets.map(row=>row.targetRef).sort().join('|') !== [...ROOT_SELECTED_R7_CURRENT7].sort().join('|')) {
    fail('the exact current7 source baseline is required');
  }
  for (const row of currentTargets) {
    if (!Buffer.isBuffer(currentBytesByRef?.[row.targetRef]) || sha(currentBytesByRef[row.targetRef]) !== row.sha256) {
      fail(`stale or missing current7 preimage: ${row.targetRef}`);
    }
  }
  return true;
}

function assertLineage(capsDoc, reqDoc, operations) {
  const capById = new Map(capsDoc.get('capabilities', true).items.map(item => [item.get('id'), item.toJS(capsDoc)]));
  const reqById = new Map(reqDoc.get('requirements', true).items.map(item => [item.get('id'), item.toJS(reqDoc)]));
  const definitions = operations.filter(op => op.kind === 'ADD_CAPABILITY_DEFINITION');
  const cases = operations.filter(op => op.kind === 'APPEND_REQUIREMENT_CASE');
  const bindings = operations.filter(op => op.kind === 'APPEND_REQUIREMENT_CAPABILITY_BINDING');
  for (const op of definitions) {
    const capability = capById.get(op.capabilityId);
    if (!capability || !capability.acceptanceCases?.length) fail(`definition ${op.capabilityId} not present after projection`);
    for (const requirementId of capability.requirementIds ?? []) {
      const requirement = reqById.get(requirementId);
      if (!requirement?.capabilityIds?.includes(capability.id) || !bindings.some(x => x.capabilityId === capability.id && x.requirementId === requirementId)) fail(`missing exact binding ${capability.id} -> ${requirementId}`);
    }
  }
  for (const op of cases) {
    const parent = reqById.get(op.requirementId)?.acceptanceCases?.find(item => item.id === op.record.id);
    const source = capById.get(op.record.sourceCapabilityId)?.acceptanceCases?.find(item => item.id === op.record.sourceCapabilityCaseId);
    if (!parent || !source || parent.sourceCapabilityCaseId !== source.id || parent.sourceCapabilityId !== op.sourceCapabilityId
        || op.sourceCapabilityCaseId !== source.id || parent.sourceAuditId !== op.auditId
        || String(parent.polarity).toUpperCase() !== String(source.polarity).toUpperCase()
        || String(op.polarity).toUpperCase() !== String(source.polarity).toUpperCase()) {
      fail(`parent source case and polarity do not resolve for ${op.record.id}`);
    }
  }
}

export function buildRootSelectedSourceIntegrationR7Postimages({baseSources, retainedProjectionOperations, retainedProjectionPostimages = null, operations, frozenPostimages = null}) {
  const base = parseSources(baseSources);
  if (!Array.isArray(retainedProjectionOperations) || retainedProjectionOperations.length !== 248) fail('the exact 248 retained projection operations are required');
  if (!Array.isArray(operations) || !operations.length) fail('R7 source operations are required');
  validateRootSelectedSourceIntegrationR7Operations(operations);

  const retained = retainedProjectionPostimages ?? buildSemanticBatchPostimages(baseSources, retainedProjectionOperations);
  if (Object.keys(retained).sort().join('|') !== Object.values(ROOT_SELECTED_R7_TARGETS).sort().join('|')
      || Object.values(ROOT_SELECTED_R7_TARGETS).some(ref => !Buffer.isBuffer(retained[ref]))) fail('exact four retained projection postimages required');
  const staged = parseSources(retained);
  const caps = staged.capabilities.get('capabilities', true);
  const reqs = staged.requirements.get('requirements', true);
  const capById = new Map(caps.items.map(item => [item.get('id'), item]));
  const reqById = new Map(reqs.items.map(item => [item.get('id'), item]));
  const crossRows = new Map(staged.crosswalk.rows.map(row => [row.auditId, row]));
  for (const op of operations) {
    switch (op.kind) {
      case 'ADD_CAPABILITY_DEFINITION': {
        if (capById.has(op.capabilityId) || op.record.id !== op.capabilityId) fail(`capability id is not new and exact: ${op.capabilityId}`);
        appendById(caps, op.record, 'capability'); capById.set(op.capabilityId, caps.items.at(-1));
        break;
      }
      case 'APPEND_REQUIREMENT_CASE': {
        const req = reqById.get(op.requirementId); if (!req) fail(`unknown requirement ${op.requirementId}`);
        const cases = req.get('acceptanceCases', true); if (!cases || !Array.isArray(cases.items)) fail(`requirement ${op.requirementId} acceptanceCases missing`);
        appendById(cases, op.record, 'requirement case');
        break;
      }
      case 'APPEND_REQUIREMENT_CAPABILITY_BINDING': {
        const req = reqById.get(op.requirementId); const cap = capById.get(op.capabilityId);
        if (!req || !cap) fail(`binding target missing ${op.capabilityId} -> ${op.requirementId}`);
        const declared = cap.get('requirementIds', true)?.toJSON() ?? [];
        if (!declared.includes(op.requirementId)) fail(`capability does not declare requirement ${op.requirementId}`);
        const bindings = req.get('capabilityIds', true);
        if (!bindings || !Array.isArray(bindings.items) || bindings.items.some(item => (item?.toJSON?.() ?? item) === op.capabilityId)) fail(`binding already exists or array missing ${op.requirementId} -> ${op.capabilityId}`);
        bindings.add(staged.requirements.createNode(op.capabilityId));
        break;
      }
      case 'PATCH_CROSSWALK_TRACE': {
        const row = crossRows.get(op.auditId); if (!row) fail(`crosswalk audit row does not exist: ${op.auditId}`);
        const oldRefs = row.pdp0EvidenceRefs ?? [];
        const newRefs = op.patch.pdp0EvidenceRefs;
        if (!Array.isArray(oldRefs) || oldRefs.some(ref => !newRefs.includes(ref))) fail(`crosswalk evidence refs are not append-only for ${op.auditId}`);
        for (const key of ROOT_SELECTED_R7_CROSSWALK_PATCH_FIELDS) row[key] = structuredClone(op.patch[key]);
        break;
      }
      case 'REVISE_CAPABILITY_OWNER_DEFINITION': {
        const node = capById.get(op.capabilityId);
        if (!node) fail(`R9 owner-definition target is not a staged capability: ${op.capabilityId}`);
        const record = node.toJS(staged.capabilities);
        if (sha(Buffer.from(canonical(record.ownerDefinition))) !== op.beforeOwnerDefinitionSha256) fail(`R9 owner-definition preimage differs for ${op.capabilityId}`);
        const ownerDefinition = node.get('ownerDefinition', true);
        if (!ownerDefinition) fail(`ownerDefinition missing on ${op.capabilityId}`);
        ownerDefinition.set('typedInputSlots', staged.capabilities.createNode(op.patch.typedInputSlots));
        ownerDefinition.set('successOutputs', staged.capabilities.createNode(op.patch.successOutputs));
        break;
      }
      case 'REVISE_ACCEPTANCE_CASE_TEXT': {
        const target = op.targetKind === 'CAPABILITY' ? capById.get(op.targetId) : reqById.get(op.targetId);
        if (!target) fail(`R9 case target is missing: ${op.targetKind}:${op.targetId}`);
        const caseNode = target.get('acceptanceCases', true)?.items?.find(item => item.get('id') === op.caseId);
        if (!caseNode) fail(`R9 acceptance case is missing: ${op.caseId}`);
        const record = caseNode.toJS(op.targetKind === 'CAPABILITY' ? staged.capabilities : staged.requirements);
        if (sha(Buffer.from(canonical(record))) !== op.beforeCaseSha256
            || String(record.polarity).toUpperCase() !== op.polarity
            || (op.targetKind === 'CAPABILITY' && (record.id !== op.sourceCapabilityCaseId || record.sourceCapabilityId !== op.targetId))
            || (op.targetKind === 'REQUIREMENT' && (record.sourceCapabilityCaseId !== op.sourceCapabilityCaseId
              || record.sourceCapabilityId !== operations.find(row => row.kind === 'REVISE_ACCEPTANCE_CASE_TEXT' && row.targetKind === 'CAPABILITY'
                && row.caseId === op.sourceCapabilityCaseId)?.targetId))) {
          fail(`R9 acceptance case lineage or preimage differs for ${op.caseId}`);
        }
        for (const key of ['given','when','then']) caseNode.set(key, op.patch[key]);
        break;
      }
      default: fail(`unhandled operation ${op.kind}`);
    }
  }
  assertLineage(staged.capabilities, staged.requirements, operations);
  const leafRowsBefore = base.leaf.get('ownerCapabilityLeafAdjudication', true).get('records', true).toJS(base.leaf);
  const leafRowsAfter = staged.leaf.get('ownerCapabilityLeafAdjudication', true).get('records', true).toJS(staged.leaf);
  if (leafRowsBefore.length !== 462 || canonical(leafRowsBefore) !== canonical(leafRowsAfter)) fail('historical owner adjudication rows must remain exactly byte-semantic identical');
  const projected = {
    [ROOT_SELECTED_R7_TARGETS.capabilities]: Buffer.from(staged.capabilities.toString({lineWidth:0})),
    [ROOT_SELECTED_R7_TARGETS.requirements]: Buffer.from(staged.requirements.toString({lineWidth:0})),
    [ROOT_SELECTED_R7_TARGETS.leaf]: Buffer.from(baseSources[ROOT_SELECTED_R7_TARGETS.leaf]),
    [ROOT_SELECTED_R7_TARGETS.crosswalk]: exactJson(staged.crosswalk),
  };
  let result = projected;
  if (frozenPostimages) {
    if (Object.keys(frozenPostimages).sort().join('|') !== Object.values(ROOT_SELECTED_R7_TARGETS).sort().join('|')
        || Object.values(ROOT_SELECTED_R7_TARGETS).some(ref => !Buffer.isBuffer(frozenPostimages[ref]))) fail('exact frozen four-target postimages required');
    const expected = parseSources(frozenPostimages), actual = parseSources(projected);
    for (const key of ['capabilities','requirements','leaf']) {
      if (canonical(expected[key].toJS()) !== canonical(actual[key].toJS())) fail(`projected ${key} semantics differ from frozen postimage`);
    }
    if (canonical(expected.crosswalk) !== canonical(actual.crosswalk)) fail('projected crosswalk semantics differ from frozen postimage');
    if (frozenPostimages[ROOT_SELECTED_R7_TARGETS.leaf].compare(baseSources[ROOT_SELECTED_R7_TARGETS.leaf]) !== 0) fail('frozen leaf review target must remain byte-identical');
    result = Object.fromEntries(Object.values(ROOT_SELECTED_R7_TARGETS).map(ref=>[ref,Buffer.from(frozenPostimages[ref])]));
  }
  return {postimages: result, projectedSerializationHashes:Object.fromEntries(Object.entries(projected).map(([ref,bytes])=>[ref,sha(bytes)])), postimageHashes: Object.fromEntries(Object.entries(result).map(([ref, bytes]) => [ref, sha(bytes)])), retainedProjectionHashes: Object.fromEntries(Object.entries(retained).map(([ref, bytes]) => [ref, sha(bytes)])), rebuildSemanticallyMatchesFrozenPostimages:!!frozenPostimages};
}

export function deriveRootSelectedSourceIntegrationR7Operations({retainedProjectionSources, candidatePostimages, operationIdentityLedger, packetOperationLedger = []}) {
  const before = parseSources(retainedProjectionSources), after = parseSources(candidatePostimages);
  const identity = operationIdentityLedger?.candidateSourceOperations;
  if (!identity) fail('operation identity ledger is required');
  const packetOps = Array.isArray(packetOperationLedger) ? packetOperationLedger : fail('packet operation ledger must be an array');
  const definitionOp = capabilityId => identity.definitions.find(row => row.capabilityId === capabilityId)
    ?? packetOps.find(row => row.kind === 'CANDIDATE_ADD_CAPABILITY_DEFINITION' && row.capabilityId === capabilityId);
  const caseOp = (requirementId, caseId) => identity.parentRequirementCases.find(row => row.caseId === caseId && row.requirementId === requirementId)
    ?? packetOps.find(row => row.kind === 'CANDIDATE_APPEND_PARENT_CASE' && row.caseId === caseId && row.requirementId === requirementId);
  const bindingOp = (capabilityId, requirementId) => identity.bindings.find(row => row.capabilityId === capabilityId && row.requirementId === requirementId)
    ?? packetOps.find(row => row.kind === 'CANDIDATE_BIND_CAPABILITY_TO_REQUIREMENT' && row.capabilityId === capabilityId && row.requirementId === requirementId);
  const crosswalkOp = auditId => identity.crosswalk.find(row => row.auditId === auditId)
    ?? packetOps.find(row => row.kind === 'CANDIDATE_PATCH_CROSSWALK_TRACE' && row.auditId === auditId);
  const operations = [];
  const beforeCaps = new Set(before.capabilities.get('capabilities', true).items.map(item => item.get('id')));
  const newCaps = after.capabilities.get('capabilities', true).items.map(item => item.toJS(after.capabilities)).filter(item => !beforeCaps.has(item.id));
  const auditByCapability = new Map(newCaps.map(record=>[record.id,record.sourceAuditId]));
  for (const record of newCaps) {
    const auditId = record.sourceAuditId;
    const operationId = definitionOp(record.id)?.operationId;
    if (!operationId || !auditId) fail(`operation identity absent for feature definition ${record.id}`);
    operations.push({operationId, kind: 'ADD_CAPABILITY_DEFINITION', auditId, capabilityId: record.id, record});
  }
  const beforeReq = new Map(before.requirements.get('requirements', true).items.map(item => [item.get('id'), item.toJS(before.requirements)]));
  for (const afterReqNode of after.requirements.get('requirements', true).items) {
    const req = afterReqNode.toJS(after.requirements), base = beforeReq.get(req.id); if (!base) fail(`requirement set changed: ${req.id}`);
    const baseCases = new Set((base.acceptanceCases ?? []).map(item => item.id));
    for (const record of req.acceptanceCases ?? []) if (!baseCases.has(record.id)) {
      const meta = caseOp(req.id, record.id);
      if (!meta) fail(`parent case operation id absent for ${record.id}`);
      const auditId = meta.auditId ?? record.sourceAuditId ?? auditByCapability.get(record.sourceCapabilityId);
      operations.push({operationId: meta.operationId, kind: 'APPEND_REQUIREMENT_CASE', auditId, requirementId: req.id,
        sourceCapabilityId:record.sourceCapabilityId,sourceCapabilityCaseId:record.sourceCapabilityCaseId,polarity:record.polarity,record});
    }
    const baseBindings = new Set(base.capabilityIds ?? []);
    for (const capabilityId of req.capabilityIds ?? []) if (!baseBindings.has(capabilityId)) {
      const meta = bindingOp(capabilityId, req.id);
      if (!meta) fail(`binding operation id absent for ${capabilityId} -> ${req.id}`);
      operations.push({operationId: meta.operationId, kind: 'APPEND_REQUIREMENT_CAPABILITY_BINDING', auditId: auditByCapability.get(capabilityId) ?? definitionOp(capabilityId)?.auditId, capabilityId, requirementId: req.id});
    }
  }
  const afterCross = new Map(after.crosswalk.rows.map(row => [row.auditId, row]));
  for (const baseRow of before.crosswalk.rows) {
    const next = afterCross.get(baseRow.auditId); if (!next) fail(`crosswalk row removed: ${baseRow.auditId}`);
    const changes = ROOT_SELECTED_R7_CROSSWALK_PATCH_FIELDS.filter(key => canonical(baseRow[key] ?? null) !== canonical(next[key] ?? null));
    if (!changes.length) continue;
    const meta = crosswalkOp(baseRow.auditId);
    if (!meta) fail(`crosswalk operation id absent for ${baseRow.auditId}`);
    const outside = Object.keys(next).filter(key => !ROOT_SELECTED_R7_CROSSWALK_PATCH_FIELDS.includes(key) && canonical(next[key]) !== canonical(baseRow[key]));
    if (outside.length) fail(`crosswalk row ${baseRow.auditId} changed outside allowed trace fields: ${outside.join(', ')}`);
    operations.push({operationId: meta.operationId, kind: 'PATCH_CROSSWALK_TRACE', auditId: baseRow.auditId, patch: Object.fromEntries(changes.map(key => [key, next[key]]))});
  }
  const operationGroup = op => {
    const packet = packetOps.some(row => row.operationId === op.operationId);
    const rank = op.kind === 'ADD_CAPABILITY_DEFINITION' ? 0
      : op.kind === 'APPEND_REQUIREMENT_CAPABILITY_BINDING' ? 1
        : op.kind === 'APPEND_REQUIREMENT_CASE' ? 2 : 3;
    return (packet ? 4 : 0) + rank;
  };
  const sourceIndex = op => {
    const packet = packetOps.find(row => row.operationId === op.operationId);
    if (packet) return packetOps.indexOf(packet);
    const list = op.kind === 'ADD_CAPABILITY_DEFINITION' ? identity.definitions
      : op.kind === 'APPEND_REQUIREMENT_CAPABILITY_BINDING' ? identity.bindings
        : op.kind === 'APPEND_REQUIREMENT_CASE' ? identity.parentRequirementCases : identity.crosswalk;
    const item = list.find(row => row.operationId === op.operationId);
    return item ? list.indexOf(item) : Number.MAX_SAFE_INTEGER;
  };
  return operations.sort((a,b)=>operationGroup(a)-operationGroup(b)||sourceIndex(a)-sourceIndex(b));
}

export function sha256R7(bytes) { return sha(bytes); }
