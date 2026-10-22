import test from 'node:test';
import assert from 'node:assert/strict';
import { buildMediaBuildContractBridge, validateMediaBuildContractBridge } from '../scripts/lib/media-build-contract-bridge.mjs';

const expected = buildMediaBuildContractBridge();
const clone = () => structuredClone(expected);
const rejects = candidate => assert.notDeepEqual(validateMediaBuildContractBridge(candidate, expected), []);

test('contract bridge preserves source identity and edge joins with explicit unresolved slots', () => {
  assert.equal(expected.census.identityCount, 3186);
  assert.equal(expected.identities.length, expected.census.identityCount);
  assert.equal(expected.edges.length, expected.census.edgeCount);
  assert(expected.identities.some(row => row.kind === 'definitionExtensionOperationMappings'));
  assert(expected.identities.every(row => row.ownerAssignments.length === 1));
  assert(expected.identities.every(row => row.ownerAssignments.every(owner => owner.packageId === 'N/A' || owner.ownerRoleStatus === (owner.ownerRole ? 'SOURCE_DECLARED' : 'UNRESOLVED_IN_SOURCE_PLAN'))));
  assert(expected.identities.every(row => row.codeSymbol.status === 'UNBOUND' && row.evidence.status === 'PLANNING_RECEIPT_ONLY'));
  assert(expected.identities.some(row => row.unresolvedSourceBlockers.length > 0));
  assert(expected.identities.some(row => row.ownerAssignments.some(owner => owner.packageId === 'N/A' && owner.disposition === 'ARCHIVED')));
  assert.deepEqual(validateMediaBuildContractBridge(expected, expected), []);
});

test('contract bridge rejects missing edges, duplicate owners, mismatched operations, missing archived N/A, and cycles', () => {
  const removedEdge = clone();
  removedEdge.edges.pop();
  rejects(removedEdge);

  const duplicateOwner = clone();
  duplicateOwner.identities[0].ownerAssignments.push(structuredClone(duplicateOwner.identities[0].ownerAssignments[0]));
  rejects(duplicateOwner);

  const mismatchedOperation = clone();
  const operationEdge = mismatchedOperation.edges.find(edge => edge.relation === 'p1Operation');
  assert(operationEdge, 'fixture requires at least one source-declared operation edge');
  operationEdge.toId = 'media.operation.not-in-source';
  rejects(mismatchedOperation);

  const missingArchivedNA = clone();
  missingArchivedNA.identities = missingArchivedNA.identities.filter(row => !row.ownerAssignments.some(owner => owner.packageId === 'N/A' && owner.disposition === 'ARCHIVED'));
  rejects(missingArchivedNA);

  const illegalCycle = clone();
  assert(illegalCycle.packages.length >= 2);
  illegalCycle.packages[0].dependencies = [illegalCycle.packages[1].id];
  illegalCycle.packages[1].dependencies = [illegalCycle.packages[0].id];
  rejects(illegalCycle);
});
