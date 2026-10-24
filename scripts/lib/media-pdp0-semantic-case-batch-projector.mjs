import {createHash} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import {fingerprintPxdDecisionSection} from './pdp0-phase-scoped-source-fingerprints.mjs';

export const MEDIA_PDP0_BATCH_TARGETS = Object.freeze([
  '.product-experience/pdp-0-product-truth/capabilities.yaml',
  '.product-experience/pdp-0-product-truth/requirements.yaml',
  '.product-experience/pdp-0-product-truth/capability-leaf-review.yaml',
  'docs/implementation/observations/pdp0-semantic-audit-slices/pdp0-501-disposition-crosswalk.json',
]);

const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const stable = (value) => Array.isArray(value) ? value.map(stable)
  : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, stable(value[key])]))
    : value;
const canonical = (value) => JSON.stringify(stable(value));
const exactJson = (value) => Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
const clone = (value) => structuredClone(value);
const fail = (message) => { throw new Error(`PDP-0 semantic batch rejected: ${message}`); };
const PDP0_AUTHORITY_MAP_REF = '.product-experience/authority-map.yaml';
const PDP0_DECISION_LOG_REF = '.product-experience/decision-log.md';
const EXPECTED_ROOT_ROLE = 'media-product';
const PDP0_TECHNICAL_PEER_RECORD_REF = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/cohort-02.r6.independent-peer-2026-10-23.json';
const PDP0_TECHNICAL_PEER_RECORD_SHA256 = '7551b0367917e71ef1874a93bdc9b8b10450c83a97cc4b939a453c7f7234680c';

function requireValue(condition, message) {
  if (!condition) fail(message);
}

function object(value, label) {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), `${label} must be an object`);
}

function sourceMap(sourceBytes) {
  object(sourceBytes, 'sourceBytes');
  const keys = Object.keys(sourceBytes).sort();
  requireValue(canonical(keys) === canonical([...MEDIA_PDP0_BATCH_TARGETS].sort()), 'source byte set must contain exactly the bounded PDP-0 batch targets');
  for (const ref of MEDIA_PDP0_BATCH_TARGETS) requireValue(Buffer.isBuffer(sourceBytes[ref]), `exact bytes required for ${ref}`);
  return Object.fromEntries(MEDIA_PDP0_BATCH_TARGETS.map((ref) => [ref, Buffer.from(sourceBytes[ref])]));
}

function parseYaml(bytes, ref) {
  const doc = YAML.parseDocument(bytes.toString('utf8'), {uniqueKeys: true, prettyErrors: true});
  requireValue(doc.errors.length === 0, `${ref} YAML is invalid: ${doc.errors.map((error) => error.message).join('; ')}`);
  return doc;
}

function getValue(node, key) {
  return node.get(key, true)?.toJSON() ?? null;
}

function sequence(node, key, label) {
  const seq = node.get(key, true);
  requireValue(seq && Array.isArray(seq.items), `${label}.${key} must be a sequence`);
  return seq;
}

function getSingleById(seq, id, label) {
  const matches = seq.items.filter((item) => getValue(item, 'id') === id);
  requireValue(matches.length === 1, `${label} ${id} must resolve exactly once; found ${matches.length}`);
  return matches[0];
}

function identityFor(record, kind) {
  if (kind === 'ADD_CROSSWALK_ROW') return record.auditId ?? record.existingAuditId ?? record.id;
  return record.id;
}

function appendRecord(seq, record, identity, label, doc) {
  object(record, `${label} record`);
  if (identity !== undefined && identity !== null) {
    const matches = seq.items.filter((item) => getValue(item, 'id') === identity || getValue(item, 'auditId') === identity || getValue(item, 'existingAuditId') === identity);
    requireValue(matches.length === 0, `${label} identity ${identity} already exists`);
  }
  seq.add(doc.createNode(record));
}

function ownerIdentitySnapshot(leafDoc) {
  const owner = leafDoc.get('ownerCapabilityLeafAdjudication', true);
  const records = sequence(owner, 'records', 'ownerCapabilityLeafAdjudication').items.map((item) => item.toJSON());
  return records;
}

function comparePreservedLeafRows(beforeRows, afterRows) {
  const afterById = new Map(afterRows.map((row) => [row.id, row]));
  requireValue(beforeRows.every((row) => row?.id && afterById.has(row.id)), 'owner capability adjudication lost one or more base identities');
  for (const row of beforeRows) requireValue(canonical(afterById.get(row.id)) === canonical(row), `owner capability adjudication base row ${row.id} was modified`);
  requireValue(afterById.size === afterRows.length, 'owner capability adjudication contains duplicate identities');
}

function compareAppendOnly(before, after, {label, collectionKey, allowedNestedAppends = []}) {
  requireValue(Array.isArray(before[collectionKey]) && Array.isArray(after[collectionKey]), `${label}.${collectionKey} must remain an array`);
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (key !== collectionKey) requireValue(canonical(before[key]) === canonical(after[key]), `${label}.${key} changed outside the declared append target`);
  }
  const beforeRows = before[collectionKey];
  const afterRows = after[collectionKey];
  requireValue(afterRows.length >= beforeRows.length, `${label}.${collectionKey} lost base rows`);
  const beforeIds = beforeRows.map((row) => row?.id);
  const afterIds = afterRows.slice(0, beforeRows.length).map((row) => row?.id);
  requireValue(canonical(beforeIds) === canonical(afterIds), `${label}.${collectionKey} base identity order changed`);
  for (let index = 0; index < beforeRows.length; index += 1) {
    const original = clone(beforeRows[index]);
    const projected = clone(afterRows[index]);
    for (const nestedKey of allowedNestedAppends) {
      if (!Object.hasOwn(original, nestedKey)) continue;
      requireValue(Array.isArray(original[nestedKey]) && Array.isArray(projected[nestedKey]), `${label}.${beforeIds[index]}.${nestedKey} must remain an array`);
      requireValue(canonical(projected[nestedKey].slice(0, original[nestedKey].length)) === canonical(original[nestedKey]), `${label}.${beforeIds[index]}.${nestedKey} changed existing entries`);
      original[nestedKey] = projected[nestedKey];
    }
    requireValue(canonical(original) === canonical(projected), `${label}.${beforeIds[index]} changed outside declared append fields`);
  }
}

function compareUnrelatedSourceFields(beforeBytes, afterBytes) {
  const before = parseSources(beforeBytes);
  const after = parseSources(afterBytes);
  compareAppendOnly(before.capabilities.toJSON(), after.capabilities.toJSON(), {label: 'capabilities', collectionKey: 'capabilities', allowedNestedAppends: ['acceptanceCases']});
  compareAppendOnly(before.requirements.toJSON(), after.requirements.toJSON(), {label: 'requirements', collectionKey: 'requirements', allowedNestedAppends: ['acceptanceCases', 'capabilityIds']});
  const beforeLeaf = before.leaf.toJSON();
  const afterLeaf = after.leaf.toJSON();
  for (const key of new Set([...Object.keys(beforeLeaf), ...Object.keys(afterLeaf)])) {
    if (key === 'ownerCapabilityLeafAdjudication') {
      const beforeOwner = beforeLeaf[key]; const afterOwner = afterLeaf[key];
      for (const nested of new Set([...Object.keys(beforeOwner), ...Object.keys(afterOwner)])) {
        if (nested !== 'records') requireValue(canonical(beforeOwner[nested]) === canonical(afterOwner[nested]), `ownerCapabilityLeafAdjudication.${nested} changed`);
      }
      continue;
    }
    if (key === 'ownerTrustReconstructionDispositions') {
      const beforeTrust = beforeLeaf[key]; const afterTrust = afterLeaf[key];
      for (const nested of new Set([...Object.keys(beforeTrust), ...Object.keys(afterTrust)])) {
        if (nested !== 'records') requireValue(canonical(beforeTrust[nested]) === canonical(afterTrust[nested]), `ownerTrustReconstructionDispositions.${nested} changed`);
      }
      const baseTrust = beforeTrust.records;
      requireValue(canonical(afterTrust.records.slice(0, baseTrust.length)) === canonical(baseTrust), 'base trust reconstruction records changed');
      continue;
    }
    requireValue(canonical(beforeLeaf[key]) === canonical(afterLeaf[key]), `capability-leaf-review.${key} changed outside append targets`);
  }
  const beforeCrosswalk = before.crosswalk;
  const afterCrosswalk = after.crosswalk;
  for (const key of new Set([...Object.keys(beforeCrosswalk), ...Object.keys(afterCrosswalk)])) {
    if (key !== 'rows') requireValue(canonical(beforeCrosswalk[key]) === canonical(afterCrosswalk[key]), `crosswalk.${key} changed outside rows`);
  }
  requireValue(canonical(afterCrosswalk.rows.slice(0, beforeCrosswalk.rows.length)) === canonical(beforeCrosswalk.rows), 'base crosswalk rows changed');
}

function parseSources(sourceBytes) {
  const capabilities = parseYaml(sourceBytes[MEDIA_PDP0_BATCH_TARGETS[0]], MEDIA_PDP0_BATCH_TARGETS[0]);
  const requirements = parseYaml(sourceBytes[MEDIA_PDP0_BATCH_TARGETS[1]], MEDIA_PDP0_BATCH_TARGETS[1]);
  const leaf = parseYaml(sourceBytes[MEDIA_PDP0_BATCH_TARGETS[2]], MEDIA_PDP0_BATCH_TARGETS[2]);
  let crosswalk;
  try { crosswalk = JSON.parse(sourceBytes[MEDIA_PDP0_BATCH_TARGETS[3]].toString('utf8')); }
  catch (error) { fail(`crosswalk JSON is invalid: ${error.message}`); }
  object(crosswalk, 'crosswalk JSON');
  requireValue(Array.isArray(crosswalk.rows), 'crosswalk.rows must be an array');
  return {capabilities, requirements, leaf, crosswalk};
}

function asSourceBytes(docs) {
  return {
    [MEDIA_PDP0_BATCH_TARGETS[0]]: Buffer.from(docs.capabilities.toString()),
    [MEDIA_PDP0_BATCH_TARGETS[1]]: Buffer.from(docs.requirements.toString()),
    [MEDIA_PDP0_BATCH_TARGETS[2]]: Buffer.from(docs.leaf.toString()),
    [MEDIA_PDP0_BATCH_TARGETS[3]]: exactJson(docs.crosswalk),
  };
}

function validateOperation(operation) {
  object(operation, 'operation');
  requireValue(typeof operation.operationId === 'string' && operation.operationId.length > 0, 'operationId is required');
  requireValue(typeof operation.rowId === 'string' && operation.rowId.length > 0, 'rowId is required');
  requireValue(typeof operation.optionId === 'string' && operation.optionId.length > 0, 'optionId is required');
  const allowed = new Set([
    'APPEND_CAPABILITY_CASE', 'APPEND_REQUIREMENT_CASE', 'ADD_CAPABILITY_DEFINITION',
    'APPEND_REQUIREMENT_CAPABILITY_BINDING', 'ADD_OWNER_ADJUDICATION', 'ADD_TRUST_RECONSTRUCTION', 'ADD_CROSSWALK_ROW',
  ]);
  requireValue(allowed.has(operation.kind), `unsupported typed operation ${operation.kind}`);
  return operation;
}

function jsonValue(value) { return JSON.stringify(value); }

function decisionSectionBindsChoice(section, rowId, optionId, operationDigest) {
  return section.includes(rowId) && section.includes(optionId) && section.includes(operationDigest);
}

function assertCapabilityCaseSemantics({operation, capability, record}) {
  const definition = getValue(capability, 'ownerDefinition');
  const expected = {
    operation: getValue(capability, 'operation'),
    typedInputSlots: definition?.typedInputSlots,
    successOutputs: definition?.successOutputs,
    nonSuccessOutputs: definition?.nonSuccessOutputs,
    errors: definition?.errors,
    requiredAuthority: getValue(capability, 'requiredAuthority'),
    explicitUnsupportedCases: getValue(capability, 'explicitUnsupportedCases'),
  };
  requireValue(operation.semanticBinding && canonical(operation.semanticBinding) === canonical(expected), `capability case ${operation.operationId} does not bind the exact live operation/input/output/failure contract`);
  const operationSelector = `${operation.targetId}.${expected.operation}`;
  requireValue(typeof expected.operation === 'string' && expected.operation.length > 0 && expected.operation !== 'undefined', `live target ${operation.targetId} has no canonical operation`);
  requireValue(typeof record.given === 'string' && typeof record.when === 'string' && typeof record.then === 'string', `capability case ${operation.operationId} must retain non-empty given/when/then text`);
  const evidence = operation.caseSemanticEvidence;
  const evidenceContract = evidence?.semanticContract;
  const evidenceMatches = evidence && canonical(evidenceContract) === canonical(expected)
    && evidence.reviewDisposition === 'PASS'
    && evidence.reviewedAuditId === operation.rowId
    && typeof evidence.peerReviewRef === 'string'
    && evidence.peerReviewRef.startsWith('docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/')
    && /^[a-f0-9]{64}$/u.test(evidence.peerReviewSha256 ?? '')
    && /^[a-f0-9]{64}$/u.test(evidence.reviewedCaseSha256 ?? '')
    && evidence.reviewedCaseSha256 === sha(Buffer.from(canonical(record)));
  const hasExactInputAndOperationText = record.given.includes(jsonValue(expected.typedInputSlots)) && record.when.includes(operationSelector);
  requireValue(hasExactInputAndOperationText || evidenceMatches, `capability case ${operation.operationId} omits exact current typed inputs or operation and has no matching peer-reviewed source evidence`);
  let exactTextBinding = false;
  if (operation.casePolarity === 'POSITIVE') {
    exactTextBinding = typeof record.then === 'string' && record.then.includes(jsonValue(expected.successOutputs));
    if (hasExactInputAndOperationText && !evidenceMatches) {
      requireValue(exactTextBinding, `positive capability case ${operation.operationId} does not assert exact success outputs`);
    }
  } else if (operation.casePolarity === 'NEGATIVE') {
    exactTextBinding = typeof record.given === 'string' && record.given.includes(jsonValue(expected.explicitUnsupportedCases))
      && typeof record.then === 'string' && record.then.includes(jsonValue(expected.nonSuccessOutputs))
      && record.then.includes(jsonValue(expected.errors)) && record.then.includes(jsonValue(expected.requiredAuthority));
    if (hasExactInputAndOperationText && !evidenceMatches) {
      requireValue(exactTextBinding, `negative capability case ${operation.operationId} does not match exact unsupported and failure/authority boundaries`);
    }
  } else fail(`capability case ${operation.operationId} requires POSITIVE or NEGATIVE casePolarity`);

  requireValue(exactTextBinding || evidenceMatches, `capability case ${operation.operationId} does not bind a peer-approved exact source contract`);
}

function assertNewCapabilitySemantics(record) {
  requireValue(typeof record.operation === 'string' && record.operation.trim().length > 0 && record.operation !== 'undefined', `new capability ${record.id} requires its canonical operation`);
  const definition = record.ownerDefinition;
  requireValue(Array.isArray(definition?.typedInputSlots) && definition.typedInputSlots.length > 0, `new capability ${record.id} requires exact typed input slots`);
  requireValue(Array.isArray(definition?.successOutputs) && definition.successOutputs.length > 0, `new capability ${record.id} requires exact success outputs`);
  requireValue(definition.nonSuccessOutputs && Array.isArray(definition.errors) && definition.errors.length > 0, `new capability ${record.id} requires its failure boundary`);
  requireValue(Array.isArray(record.requiredAuthority) && record.requiredAuthority.length > 0 && Array.isArray(record.explicitUnsupportedCases) && record.explicitUnsupportedCases.length > 0, `new capability ${record.id} requires authority and unsupported-condition definitions`);
  requireValue(Array.isArray(record.acceptanceCases) && record.acceptanceCases.length === 2, `new capability ${record.id} requires one positive and one negative operation case`);
  const operationSelector = `${record.id}.${record.operation}`;
  const inputsText = jsonValue(definition.typedInputSlots);
  const outputsText = jsonValue(definition.successOutputs);
  const positive = record.acceptanceCases.find((item) => item.polarity === 'POSITIVE');
  const negative = record.acceptanceCases.find((item) => item.polarity === 'NEGATIVE');
  requireValue(positive && negative, `new capability ${record.id} must identify one positive and one negative case`);
  requireValue(positive.given?.includes(inputsText) && positive.when?.includes(operationSelector) && positive.then?.includes(outputsText), `new capability ${record.id} positive case does not match its canonical operation/input/output contract`);
  requireValue(negative.given?.includes(inputsText) && negative.given?.includes(jsonValue(record.explicitUnsupportedCases)) && negative.when?.includes(operationSelector), `new capability ${record.id} negative case does not match its canonical operation/input/unsupported contract`);
  requireValue(negative.then?.includes(jsonValue(definition.nonSuccessOutputs)) && negative.then?.includes(jsonValue(definition.errors)) && negative.then?.includes(jsonValue(record.requiredAuthority)), `new capability ${record.id} negative case does not match its canonical failure/authority contract`);
}

function validateNewMeaningBundles(operations) {
  const byRow = new Map();
  for (const op of operations) {
    const rows = byRow.get(op.rowId) ?? [];
    rows.push(op);
    byRow.set(op.rowId, rows);
  }
  for (const [rowId, rows] of byRow) {
    const newMeanings = rows.filter((op) => op.kind === 'ADD_CAPABILITY_DEFINITION');
    requireValue(newMeanings.length <= 1, `row ${rowId} cannot add multiple capability definitions in one semantic meaning bundle`);
    if (newMeanings.length === 1) {
      const requiredKinds = ['APPEND_REQUIREMENT_CASE', 'APPEND_REQUIREMENT_CAPABILITY_BINDING', 'ADD_OWNER_ADJUDICATION', 'ADD_TRUST_RECONSTRUCTION', 'ADD_CROSSWALK_ROW'];
      for (const kind of requiredKinds) requireValue(rows.some((op) => op.kind === kind), `new meaning row ${rowId} is missing typed companion operation ${kind}`);
      const record = newMeanings[0].record;
      requireValue(record?.ownerDefinition?.typedInputSlots?.length > 0, `new capability ${record?.id} requires exact typed input slots`);
      requireValue(record?.ownerDefinition?.successOutputs?.length > 0, `new capability ${record?.id} requires exact success outputs`);
      requireValue(Array.isArray(record.acceptanceCases) && record.acceptanceCases.length >= 2, `new capability ${record?.id} requires positive and negative feature cases`);
    } else {
      requireValue(!rows.some((op) => ['ADD_OWNER_ADJUDICATION', 'ADD_TRUST_RECONSTRUCTION', 'ADD_CROSSWALK_ROW'].includes(op.kind)), `row ${rowId} uses new-meaning companion operations without ADD_CAPABILITY_DEFINITION`);
    }
  }
}

function applyOperations(sourceBytes, operations) {
  const docs = parseSources(sourceBytes);
  const originalOwnerRows = ownerIdentitySnapshot(docs.leaf);
  const caps = sequence(docs.capabilities, 'capabilities', 'capabilities root');
  const reqs = sequence(docs.requirements, 'requirements', 'requirements root');
  const capById = () => new Map(caps.items.map((item) => [getValue(item, 'id'), item]));
  const reqById = () => new Map(reqs.items.map((item) => [getValue(item, 'id'), item]));
  const leafOwner = docs.leaf.get('ownerCapabilityLeafAdjudication', true);
  const leafTrust = docs.leaf.get('ownerTrustReconstructionDispositions', true);
  const adjudications = sequence(leafOwner, 'records', 'ownerCapabilityLeafAdjudication');
  const trustRecords = sequence(leafTrust, 'records', 'ownerTrustReconstructionDispositions');
  const ownerRowsBefore = originalOwnerRows;
  const crosswalkIds = new Set(docs.crosswalk.rows.map((row) => identityFor(row, 'ADD_CROSSWALK_ROW')));
  const opIds = new Set();
  const naturalKeys = new Set();

  const ordered = operations.slice().sort((a, b) => {
    const rank = (kind) => ({ADD_CAPABILITY_DEFINITION: 0, APPEND_REQUIREMENT_CAPABILITY_BINDING: 1, APPEND_CAPABILITY_CASE: 2, APPEND_REQUIREMENT_CASE: 3, ADD_OWNER_ADJUDICATION: 4, ADD_TRUST_RECONSTRUCTION: 5, ADD_CROSSWALK_ROW: 6}[kind]);
    return rank(a.kind) - rank(b.kind) || a.operationId.localeCompare(b.operationId);
  });

  for (const operation of ordered) {
    if (opIds.has(operation.operationId)) fail(`duplicate operationId ${operation.operationId}`);
    opIds.add(operation.operationId);
    const record = operation.record;
    const capMap = capById();
    const reqMap = reqById();
    switch (operation.kind) {
      case 'APPEND_CAPABILITY_CASE': {
        const capability = capMap.get(operation.targetId);
        requireValue(capability, `capability case target ${operation.targetId} does not exist`);
        const cases = sequence(capability, 'acceptanceCases', `capability ${operation.targetId}`);
        requireValue(typeof record?.given === 'string' && typeof record?.when === 'string' && typeof record?.then === 'string', 'capability cases must contain given/when/then only');
        assertCapabilityCaseSemantics({operation, capability, record});
        const key = `cap-case:${operation.targetId}:${sha(Buffer.from(canonical(record)))}`;
        requireValue(!naturalKeys.has(key) && !cases.items.some((item) => canonical(item.toJSON()) === canonical(record)), `duplicate/conflicting capability case on ${operation.targetId}`);
        naturalKeys.add(key); cases.add(docs.capabilities.createNode(record));
        break;
      }
      case 'APPEND_REQUIREMENT_CASE': {
        const requirement = reqMap.get(operation.targetId);
        requireValue(requirement, `requirement case target ${operation.targetId} does not exist`);
        const cases = sequence(requirement, 'acceptanceCases', `requirement ${operation.targetId}`);
        requireValue(typeof record?.id === 'string' && typeof record?.given === 'string' && typeof record?.when === 'string' && typeof record?.then === 'string', 'requirement case must contain id/given/when/then');
        const key = `req-case:${operation.targetId}:${record.id}`;
        requireValue(!naturalKeys.has(key) && !cases.items.some((item) => getValue(item, 'id') === record.id), `duplicate/conflicting requirement case ${record.id}`);
        naturalKeys.add(key); appendRecord(cases, record, record.id, 'requirement case', docs.requirements);
        break;
      }
      case 'ADD_CAPABILITY_DEFINITION': {
        requireValue(typeof operation.targetId === 'string' && record?.id === operation.targetId, 'capability definition target must equal record.id');
        assertNewCapabilitySemantics(record);
        const key = `capability:${operation.targetId}`;
        requireValue(!naturalKeys.has(key) && !capMap.has(operation.targetId), `duplicate/conflicting capability definition ${operation.targetId}`);
        naturalKeys.add(key); appendRecord(caps, record, operation.targetId, 'capability definition', docs.capabilities);
        break;
      }
      case 'APPEND_REQUIREMENT_CAPABILITY_BINDING': {
        const requirement = reqMap.get(operation.targetId);
        requireValue(requirement, `requirement capability binding target ${operation.targetId} does not exist`);
        requireValue(typeof operation.capabilityId === 'string' && capMap.has(operation.capabilityId), `capability binding references missing capability ${operation.capabilityId}`);
        const capability = capMap.get(operation.capabilityId);
        const declaredRequirementIds = getValue(capability, 'requirementIds') ?? [];
        requireValue(Array.isArray(declaredRequirementIds) && declaredRequirementIds.includes(operation.targetId), `capability ${operation.capabilityId} does not directly declare requirement ${operation.targetId}`);
        const bindings = sequence(requirement, 'capabilityIds', `requirement ${operation.targetId}`);
        requireValue(!bindings.items.some((item) => item.toJSON() === operation.capabilityId), `requirement ${operation.targetId} already binds ${operation.capabilityId}`);
        bindings.add(docs.requirements.createNode(operation.capabilityId));
        break;
      }
      case 'ADD_OWNER_ADJUDICATION': {
        const id = record?.id;
        const key = `owner-adjudication:${id}`;
        requireValue(typeof id === 'string' && !naturalKeys.has(key), `duplicate/conflicting owner adjudication ${id}`);
        naturalKeys.add(key); appendRecord(adjudications, record, id, 'owner adjudication', docs.leaf);
        break;
      }
      case 'ADD_TRUST_RECONSTRUCTION': {
        const id = record?.id;
        const key = `trust-reconstruction:${id}`;
        requireValue(typeof id === 'string' && !naturalKeys.has(key), `duplicate/conflicting trust reconstruction ${id}`);
        naturalKeys.add(key); appendRecord(trustRecords, record, id, 'trust reconstruction', docs.leaf);
        break;
      }
      case 'ADD_CROSSWALK_ROW': {
        const identity = identityFor(record, operation.kind);
        requireValue(typeof identity === 'string' && !crosswalkIds.has(identity), `duplicate/conflicting crosswalk identity ${identity}`);
        crosswalkIds.add(identity); docs.crosswalk.rows.push(clone(record));
        break;
      }
      default: fail(`unhandled typed operation ${operation.kind}`);
    }
  }
  const finalOwnerRows = ownerIdentitySnapshot(docs.leaf);
  comparePreservedLeafRows(ownerRowsBefore, finalOwnerRows);
  const baseIdCount = new Set(ownerRowsBefore.map((row) => row.id)).size;
  requireValue(baseIdCount === 462 && ownerRowsBefore.length === 462, `expected exactly 462 unique base owner adjudication identities, found ${baseIdCount}`);
  const postimages = asSourceBytes(docs);
  compareUnrelatedSourceFields(sourceBytes, postimages);
  return postimages;
}

function expectedCandidateDigest(manifest) {
  const {candidateSha256: _candidateSha256, ...body} = manifest;
  return sha(Buffer.from(canonical(body)));
}

function rowOperationDigests(operations) {
  const grouped = new Map();
  for (const operation of operations) {
    const list = grouped.get(operation.rowId) ?? [];
    list.push(operation);
    grouped.set(operation.rowId, list);
  }
  return new Map([...grouped].map(([rowId, rows]) => [rowId, {
    operationIds: rows.map((row) => row.operationId).sort(),
    sha256: sha(Buffer.from(canonical(rows.slice().sort((a, b) => a.operationId.localeCompare(b.operationId))))),
    optionId: rows[0].optionId,
    allSameOption: rows.every((row) => row.optionId === rows[0].optionId),
  }]));
}

function readWorkflowFile(repositoryRoot, ref, label) {
  requireValue(typeof repositoryRoot === 'string' && repositoryRoot.length > 0, 'repositoryRoot is required for workflow-bound approval resolution');
  requireValue(typeof ref === 'string' && ref.length > 0 && !path.isAbsolute(ref), `${label} must be a repository-relative file ref`);
  const root = fs.realpathSync(repositoryRoot);
  const resolved = path.resolve(root, ref);
  requireValue(resolved.startsWith(`${root}${path.sep}`), `${label} escapes the repository root`);
  let realPath;
  try { realPath = fs.realpathSync(resolved); } catch (error) { fail(`${label} actual workflow file is unavailable: ${error.message}`); }
  requireValue(realPath.startsWith(`${root}${path.sep}`), `${label} resolves outside the repository root`);
  return fs.readFileSync(realPath);
}

function parseWorkflowJson(bytes, label) {
  try { return JSON.parse(bytes.toString('utf8')); }
  catch (error) { fail(`${label} actual workflow file is invalid JSON: ${error.message}`); }
}

function verifyRegisteredPeerIdentity({repositoryRoot, reviewer, builderIdentity, ownerRole}) {
  const bytes = readWorkflowFile(repositoryRoot, PDP0_TECHNICAL_PEER_RECORD_REF, 'fixed technical peer registry record');
  const record = parseWorkflowJson(bytes, 'fixed technical peer registry record');
  requireValue(sha(bytes) === PDP0_TECHNICAL_PEER_RECORD_SHA256, 'fixed technical peer registry record does not match the reviewed source bytes');
  const reviewerIdentity = `codex-thread:${record.reviewer?.fullThreadId ?? ''}`;
  requireValue(record.schemaVersion === 'media.pdp0.parent-case-r6-independent-peer.v1'
    && record.artifactId === 'MEDIA-PDP0-P0-07-COHORT-02-R6-INDEPENDENT-PEER-2026-10-23'
    && record.reviewer?.role === 'DISTINCT_SOURCE_CONTENT_PEER'
    && record.reviewer?.identityKind === 'codex-thread'
    && /^[0-9a-f-]{36}$/u.test(record.reviewer?.fullThreadId ?? '')
    && record.r6ContentReview?.result === 'SOURCE_CONTENT_FINDINGS_ADDRESSED; ROOT_CHOICES_REMAIN_PENDING',
  'fixed technical peer registry record is missing its exact source-content review disposition');
  requireValue(reviewer?.role === record.reviewer.role
    && reviewer?.registryRef === PDP0_TECHNICAL_PEER_RECORD_REF
    && reviewer?.identity === reviewerIdentity,
  'peer reviewer identity does not resolve to the fixed technical review record');
  requireValue(typeof builderIdentity === 'string' && builderIdentity.length > 0
    && reviewerIdentity !== builderIdentity
    && reviewerIdentity !== ownerRole,
  'peer reviewer must be distinct from the declared builder and PDP-0 owner role');
  return {identity: reviewerIdentity, recordSha256: sha(bytes), recordRef: PDP0_TECHNICAL_PEER_RECORD_REF};
}

function verifyReviewFiles({manifest, manifestBytes, repositoryRoot, postimages}) {
  requireValue(Buffer.isBuffer(manifestBytes), 'exact candidate manifest bytes are required');
  const reviewDirectory = 'docs/implementation/observations/media-pdp0-parent-case-resolution-candidates/';
  requireValue(manifest.rootChoiceRef?.startsWith(reviewDirectory) && manifest.peerReviewRef?.startsWith(reviewDirectory), 'review refs must resolve to the repository PDP-0 review workflow artifacts');
  const rootChoiceBytes = readWorkflowFile(repositoryRoot, manifest.rootChoiceRef, 'root choice');
  const peerReviewBytes = readWorkflowFile(repositoryRoot, manifest.peerReviewRef, 'peer review');
  requireValue(manifestBytes.equals(exactJson(manifest)), 'candidate bytes are not deterministic canonical JSON for the supplied manifest');
  const candidateFileSha256 = sha(manifestBytes);
  requireValue(manifest.candidateSha256 === expectedCandidateDigest(manifest), 'candidate digest does not match the exact operation manifest');
  const rootChoice = parseWorkflowJson(rootChoiceBytes, 'actual root choice');
  const peerReview = parseWorkflowJson(peerReviewBytes, 'actual peer review');
  requireValue(manifest.rootChoiceRef === rootChoice.ref, 'root choice file ref does not match candidate binding');
  requireValue(manifest.peerReviewRef === peerReview.ref, 'peer review file ref does not match candidate binding');
  requireValue(rootChoice.schemaVersion === 'media.pdp0.semantic-case-batch-root-choice.v2', 'unsupported root choice schema; v1 self-authenticated records are rejected');
  requireValue(peerReview.schemaVersion === 'media.pdp0.semantic-case-batch-peer-review.v2', 'unsupported peer review schema; v1 self-authenticated records are rejected');
  requireValue(rootChoice.candidateSha256 === manifest.candidateSha256 && rootChoice.candidateFileSha256 === candidateFileSha256, 'root choice does not bind the exact candidate bytes');
  requireValue(canonical(rootChoice.sourcePins) === canonical(manifest.sourcePins), 'root choice source pins differ from candidate');
  requireValue(canonical(rootChoice.expectedPostimageSha256) === canonical(manifest.expectedPostimageSha256), 'root choice postimage hashes differ from candidate');
  requireValue(rootChoice.sourceOwner?.role === EXPECTED_ROOT_ROLE && rootChoice.sourceOwner?.authorityRef === `${PDP0_AUTHORITY_MAP_REF}#/canonicalPdpPhases/@id=PDP-0/semanticOwner`, 'root choice role does not match the canonical PDP-0 semantic owner registry');
  requireValue(typeof manifest.builderIdentity === 'string' && manifest.builderIdentity.length > 0
    && rootChoice.builderIdentity === manifest.builderIdentity,
  'candidate and owner decision must identify the same builder');
  requireValue(rootChoice.decisionRef && rootChoice.decisionSectionSha256 && /^[a-f0-9]{64}$/u.test(rootChoice.decisionSectionSha256), 'root choice must bind an actual PDP-0 decision-log section');
  const pxdMatch = rootChoice.decisionRef.match(/^\.product-experience\/decision-log\.md#(PXD-\d{3})$/u);
  requireValue(pxdMatch, 'root choice must use an anchored PXD decision-log ref');
  const authorityMapBytes = readWorkflowFile(repositoryRoot, PDP0_AUTHORITY_MAP_REF, 'PDP-0 owner registry');
  requireValue(rootChoice.authorityMapSha256 === sha(authorityMapBytes), 'root choice does not pin the exact owner registry bytes');
  const authorityMap = parseYaml(authorityMapBytes, PDP0_AUTHORITY_MAP_REF).toJSON();
  const semanticOwner = authorityMap.canonicalPdpPhases?.find((phase) => phase.id === 'PDP-0')?.semanticOwner;
  const phaseOwner = authorityMap.phaseAuthorities?.find((phase) => phase.phase === 'PDP-0')?.owner;
  requireValue(semanticOwner === rootChoice.sourceOwner.role && typeof phaseOwner === 'string' && phaseOwner.length > 0, 'root choice source role is not registered for PDP-0');
  const decisionLogBytes = readWorkflowFile(repositoryRoot, PDP0_DECISION_LOG_REF, 'PDP-0 decision log');
  requireValue(rootChoice.decisionLogSha256 === sha(decisionLogBytes), 'root choice does not pin the exact decision-log bytes');
  let decisionFingerprint;
  try { decisionFingerprint = fingerprintPxdDecisionSection(decisionLogBytes.toString('utf8'), pxdMatch[1]); }
  catch (error) { fail(`root choice decision-log workflow record is missing or malformed: ${error.message}`); }
  requireValue(decisionFingerprint.sha256 === rootChoice.decisionSectionSha256, 'root choice decision-log section fingerprint is stale');
  requireValue(decisionFingerprint.section.includes(manifest.candidateSha256), 'PXD decision section does not record the exact candidate digest');
  requireValue(rootChoice.candidateSha256 === manifest.candidateSha256 && rootChoice.ownerAdoption === 'UNKNOWN', 'root choice must record exact candidate selection while keeping broader owner adoption unknown');

  requireValue(peerReview.reviewKind === 'INDEPENDENT_READ_ONLY_SOURCE_CONTENT_PEER' && peerReview.reviewStatus === 'PASS', 'peer review workflow must be an actual independent read-only PASS');
  const registeredPeer = verifyRegisteredPeerIdentity({repositoryRoot, reviewer: peerReview.reviewer, builderIdentity: manifest.builderIdentity, ownerRole: rootChoice.sourceOwner.role});
  requireValue(peerReview.candidateSha256 === manifest.candidateSha256 && peerReview.candidateFileSha256 === candidateFileSha256, 'peer review does not bind exact candidate bytes');
  requireValue(canonical(peerReview.sourcePins) === canonical(manifest.sourcePins), 'peer review source pins differ from candidate');
  requireValue(canonical(peerReview.expectedPostimageSha256) === canonical(manifest.expectedPostimageSha256), 'peer review postimage hashes differ from candidate');
  requireValue(peerReview.findings?.length === 0, 'peer review must have zero findings for PASS');
  const rowOps = rowOperationDigests(manifest.operations);
  requireValue(Array.isArray(rootChoice.decisions) && Array.isArray(peerReview.rows), 'root choices and peer verdicts must be row arrays');
  const decisions = new Map(rootChoice.decisions.map((item) => [item.rowId, item]));
  const reviews = new Map(peerReview.rows.map((item) => [item.rowId, item]));
  requireValue(decisions.size === rowOps.size && reviews.size === rowOps.size && rootChoice.decisions.length === rowOps.size && peerReview.rows.length === rowOps.size, 'root choices and peer verdicts must cover every changed row exactly once');
  for (const [rowId, binding] of rowOps) {
    requireValue(binding.allSameOption, `operations for ${rowId} disagree on the selected root option`);
    const decision = decisions.get(rowId);
    const review = reviews.get(rowId);
    requireValue(decision && decision.operationDigest === binding.sha256 && canonical(decision.operationIds?.slice().sort()) === canonical(binding.operationIds), `root choice for ${rowId} is missing or bound to different operations`);
    requireValue(decision.optionId === binding.optionId && decision.disposition === 'APPROVE_EXACT_PROPOSAL', `root choice for ${rowId} does not approve the selected exact option`);
    requireValue(decisionSectionBindsChoice(decisionFingerprint.section, rowId, decision.optionId, binding.sha256), `PXD section does not bind the exact owner choice for ${rowId}`);
    requireValue(review && review.operationDigest === binding.sha256 && canonical(review.operationIds?.slice().sort()) === canonical(binding.operationIds), `peer PASS for ${rowId} is missing or bound to different operations`);
    requireValue(review.verdict === 'PASS' && Array.isArray(review.findings) && review.findings.length === 0, `peer has not recorded a clean PASS for ${rowId}`);
  }
  return {rootChoice, peerReview, candidateFileSha256, rootChoiceSha256: sha(rootChoiceBytes), peerReviewSha256: sha(peerReviewBytes), registeredPeer};
}

export function buildSemanticBatchPostimages(sourceBytes, operations) {
  const sources = sourceMap(sourceBytes);
  const normalized = operations.map(validateOperation);
  requireValue(normalized.length > 0, 'a batch must contain at least one typed operation');
  validateNewMeaningBundles(normalized);
  return applyOperations(sources, normalized);
}

export function projectMediaPdp0SemanticCaseBatches({baseSources, batches, repositoryRoot}) {
  let projected = sourceMap(baseSources);
  requireValue(Array.isArray(batches) && batches.length > 0, 'at least one source-pinned batch is required');
  requireValue(typeof repositoryRoot === 'string' && repositoryRoot.length > 0, 'repositoryRoot is required to resolve actual registry, decision-log, and review workflow files');
  const baseOwnerRows = ownerIdentitySnapshot(parseSources(projected).leaf);
  const results = [];
  let predecessorCandidateSha256 = null;
  const batchIds = new Set();
  const candidateIds = new Set();
  const operationIds = new Set();

  for (let index = 0; index < batches.length; index += 1) {
    const envelope = batches[index];
    object(envelope, `batch ${index + 1}`);
    requireValue(!Object.hasOwn(envelope, 'rootChoiceBytes') && !Object.hasOwn(envelope, 'peerReviewBytes'), 'caller-supplied root/peer JSON bytes are rejected; use actual repository workflow refs');
    const {manifest, manifestBytes, declaredPostimages} = envelope;
    object(manifest, `batch ${index + 1} manifest`);
    requireValue(manifest.schemaVersion === 'media.pdp0.semantic-case-batch.v1', 'unsupported batch manifest schema');
    requireValue(manifest.sequence === index + 1, 'batches must be supplied in exact sequential order');
    requireValue(typeof manifest.batchId === 'string' && manifest.batchId.length > 0 && !batchIds.has(manifest.batchId), 'batchId must be present and unique across the chain');
    batchIds.add(manifest.batchId);
    requireValue((manifest.predecessorCandidateSha256 ?? null) === predecessorCandidateSha256, 'batch predecessor candidate does not match the exact preceding projected batch');
    const currentPins = Object.fromEntries(MEDIA_PDP0_BATCH_TARGETS.map((ref) => [ref, sha(projected[ref])]));
    requireValue(canonical(manifest.sourcePins) === canonical(currentPins), `batch ${manifest.batchId} source preimages are stale or omit a bounded target`);
    requireValue(manifest.expectedPostimageSha256 && canonical(Object.keys(manifest.expectedPostimageSha256).sort()) === canonical([...MEDIA_PDP0_BATCH_TARGETS].sort()), 'candidate must pin every exact target postimage hash');
    const operations = manifest.operations.map(validateOperation);
    for (const operation of operations) {
      requireValue(!operationIds.has(operation.operationId), `operationId ${operation.operationId} is reused across the batch chain`);
      operationIds.add(operation.operationId);
    }
    validateNewMeaningBundles(operations);
    const postimages = applyOperations(projected, operations);
    const postimageHashes = Object.fromEntries(MEDIA_PDP0_BATCH_TARGETS.map((ref) => [ref, sha(postimages[ref])]));
    requireValue(canonical(postimageHashes) === canonical(manifest.expectedPostimageSha256), `computed postimages differ from candidate ${manifest.batchId}`);
    object(declaredPostimages, `batch ${manifest.batchId} declaredPostimages`);
    for (const ref of MEDIA_PDP0_BATCH_TARGETS) {
      requireValue(Buffer.isBuffer(declaredPostimages[ref]) && declaredPostimages[ref].equals(postimages[ref]), `declared source postimage bytes differ from deterministic projection for ${ref}`);
    }
    const review = verifyReviewFiles({manifest, manifestBytes, repositoryRoot, postimages});
    requireValue(!candidateIds.has(manifest.candidateSha256), `candidate digest ${manifest.candidateSha256} is reused across the batch chain`);
    candidateIds.add(manifest.candidateSha256);
    const targets = MEDIA_PDP0_BATCH_TARGETS.map((ref) => ({targetRef: ref, preimageSha256: currentPins[ref], postimageSha256: postimageHashes[ref]}));
    const plan = {
      batchId: manifest.batchId,
      candidateSha256: manifest.candidateSha256,
      candidateFileSha256: review.candidateFileSha256,
      rootChoiceRef: review.rootChoice.ref,
      rootChoiceSha256: review.rootChoiceSha256,
      peerReviewRef: review.peerReview.ref,
      peerReviewSha256: review.peerReviewSha256,
      targets,
      canonicalApply: 'NOT_PERFORMED',
    };
    results.push({batchId: manifest.batchId, candidateSha256: manifest.candidateSha256, sourcePins: currentPins, postimageHashes, targets, plan});
    projected = postimages;
    predecessorCandidateSha256 = manifest.candidateSha256;
  }

  const finalOwnerRows = ownerIdentitySnapshot(parseSources(projected).leaf);
  comparePreservedLeafRows(baseOwnerRows, finalOwnerRows);
  return {
    schemaVersion: 'media.pdp0.semantic-case-batch-projection.v1',
    status: 'EXACT_SOURCE_POSTIMAGES_PROJECTED; CANONICAL_APPLY_NOT_PERFORMED',
    sourcePreimages: Object.fromEntries(MEDIA_PDP0_BATCH_TARGETS.map((ref) => [ref, {sha256: sha(baseSources[ref]), bytes: Buffer.from(baseSources[ref])}])),
    sourcePostimages: Object.fromEntries(MEDIA_PDP0_BATCH_TARGETS.map((ref) => [ref, {sha256: sha(projected[ref]), bytes: Buffer.from(projected[ref])}])),
    boundedCasPlan: {
      schemaVersion: 'media.pdp0.semantic-case-batch-cas-plan.v1',
      kind: 'NON_MUTATING_EXACT_SOURCE_MULTI_BATCH_CAS_PLAN',
      batchPlans: results.map((item) => item.plan),
      finalTargets: MEDIA_PDP0_BATCH_TARGETS.map((ref) => ({targetRef: ref, preimageSha256: sha(baseSources[ref]), postimageSha256: sha(projected[ref])})),
      baseOwnerAdjudicationIdentityCount: baseOwnerRows.length,
      finalOwnerAdjudicationIdentityCount: finalOwnerRows.length,
      canonicalApply: 'NOT_PERFORMED',
      sourceWrite: 'NOT_PERFORMED',
    },
    batches: results,
  };
}

export function sealSemanticBatchManifest(body) {
  object(body, 'candidate manifest body');
  requireValue(!Object.hasOwn(body, 'candidateSha256'), 'manifest body must not contain candidateSha256 before sealing');
  return {...body, candidateSha256: expectedCandidateDigest(body)};
}

export function candidateManifestBytes(manifest) { return exactJson(manifest); }
export function hashSemanticBatchBytes(bytes) { return sha(bytes); }
