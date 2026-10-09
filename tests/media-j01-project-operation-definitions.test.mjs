import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';

const root = resolve(new URL('..', import.meta.url).pathname);
const { parse } = createRequire(resolve(root, '../ghatana-tools/package.json'))('yaml');
const yaml = (path) => parse(readFileSync(resolve(root, path), 'utf8'));

const j01 = yaml('.product-experience/pdp-0-product-truth/journey-catalog.yaml').journeys.find(({ id }) => id === 'J-01');
const contracts = yaml('.product-experience/pdp-1-domain-data/operations.yaml').individualOperationContracts.records;
const byId = new Map(contracts.map((record) => [record.id, record]));

test('J-01 requires only project create, authorized collection observation, and exact project/head inspection slices', () => {
  assert.equal(j01.scopeStatus, 'TARGET');
  assert.equal(j01.completion, 'A versioned empty project exists and the creator sees a safe next action without selecting a provider/model/engine.');
  assert.deepEqual(j01.proposedChannels, ['media.channel.web']);

  const create = byId.get('media.operation-slice.create-project');
  const list = byId.get('media.operation-slice.list-projects');
  const inspect = byId.get('media.operation-slice.inspect-project');
  assert.ok(create && list && inspect);
  assert.deepEqual(create.affectedObjects.exactRefs, ['media.domain.project', 'media.domain.project-revision']);
  assert.equal(create.operationKind, 'COMMAND');
  assert.equal(list.operationKind, 'QUERY');
  assert.equal(inspect.operationKind, 'QUERY');
  assert.equal(create.executionAdmission, 'NOT_ADMITTED');
  assert.equal(list.executionAdmission, 'NOT_ADMITTED');
  assert.equal(inspect.executionAdmission, 'NOT_ADMITTED');
  assert.equal(create.sourceRef, '.product-experience/pdp-0-product-truth/journey-catalog.yaml#J-01');
  assert.equal(list.sourceRef, create.sourceRef);
  assert.equal(inspect.sourceRef, create.sourceRef);
  assert.equal(contracts.filter(({ id }) => id.startsWith('media.operation-slice.project-')).length, 0,
    'the J-01 project slices do not introduce a second project-family alias');
});

test('project creation establishes an empty immutable initial revision atomically and binds replay to the full request', () => {
  const create = byId.get('media.operation-slice.create-project');
  const domain = yaml('.product-experience/pdp-1-domain-data/domain-objects.yaml');
  const project = domain.objects.find(({ id }) => id === 'media.domain.project');
  const revision = domain.objects.find(({ id }) => id === 'media.domain.project-revision');

  assert.deepEqual(create.requestFields, ['trustedTenantId', 'trustedPrincipalId', 'selectedAuthorizedWorkspaceId', 'title', 'requestId']);
  assert.match(create.requestIdentity, /scoped-by-tenantId-and-principalId-and-bound-to-workspaceId-and-exact-title/u);
  assert.match(create.effect.commitUnit, /atomically/u);
  assert.match(create.effect.initialRevision, /empty-immutable-COMMITTED/u);
  assert.equal(create.effect.projectHead, 'headRevisionId-equals-the-initial-revisionId');
  assert.match(create.idempotency.matchingReplay, /original-projectId-and-initial-revisionId/u);
  assert.equal(create.idempotency.mismatchingReplay, 'IDEMPOTENCY_CONFLICT; never-rebind-the-key');
  assert.match(create.outcomes.unknownOutcome, /inspect-by-the-same-requestId-before-any-resubmission/u);
  assert.match(create.outcomes.noGlobalAbsence, /never-proves-no-project-was-created/u);
  assert.match(create.negativeCases.join(' '), /partial-project-without-initial-revision/u);
  assert.match(project.initialState, /ACTIVE-project-and-its-head-to-an-immutable-empty-COMMITTED-revision-atomically/u);
  assert.match(revision.initialRevision, /COMMITTED; parentRevisionId-null/u);
  assert.match(create.authority.deploymentStatus, /not-established/u);
});

test('project collection and inspection are scoped observations, not global existence, rights, or byte-access claims', () => {
  const list = byId.get('media.operation-slice.list-projects');
  const inspect = byId.get('media.operation-slice.inspect-project');

  assert.deepEqual(list.requestFields, ['trustedTenantId', 'trustedPrincipalId', 'selectedAuthorizedWorkspaceId']);
  assert.deepEqual(list.optionalRequestFields, ['pageToken']);
  assert.deepEqual(list.resultFields, ['projectId', 'workspaceId', 'title', 'headRevisionId', 'projectState', 'observedAt', 'nextPageToken']);
  assert.match(list.authority.visibility, /only-projects-that-current-project-policy-authorizes/u);
  assert.match(list.resultSemantics.freshness, /not-a-live-currentness-guarantee/u);
  assert.match(list.outcomes.noGlobalAbsence, /observedAt-only/u);

  assert.deepEqual(inspect.requestFields, ['trustedTenantId', 'trustedPrincipalId', 'selectedAuthorizedWorkspaceId', 'projectId-or-creationRequestId']);
  assert.equal(inspect.selectorSemantics.exclusive, 'exactly-one-selector-is-required; conflicting-or-absent-selectors-are-invalid');
  assert.match(inspect.selectorSemantics.creationRequestId, /never-creates-or-replays/u);
  assert.deepEqual(inspect.resultFields, ['selectorKind', 'projectId', 'workspaceId', 'title', 'projectState', 'headRevisionId', 'headRevisionState', 'headRevisionSnapshot', 'creationRequestId', 'requestFingerprint', 'initialRevisionId', 'creationOutcome', 'observedAt']);
  assert.match(inspect.resultSemantics.creationRequestIdSelector, /original-immutable-create-receipt-and-initialRevisionId/u);
  assert.match(inspect.resultSemantics.creationRequestIdSelector, /must-not-substitute-the-current-head/u);
  assert.match(inspect.resultSemantics.requestBinding, /trusted-tenantId-principalId-workspaceId-and-exact-title-fingerprint/u);
  assert.match(inspect.resultSemantics.absentOrExpired, /cannot-authorize-resubmission-under-a-new-requestId/u);
  assert.match(inspect.revisionSemantics, /exact-opaque-revision-identities-and-immutable-snapshot-identity/u);
  assert.match(inspect.contentBoundary, /no-artifact-bytes-current-rights-content-availability/u);
  assert.match(inspect.outcomes.notFound, /never-global-nonexistence-or-proof-of-no-prior-create-effect/u);
  assert.match(inspect.outcomes.unknownCreate, /never-convert-scoped-absence-to-not-found-or-failed/u);
  assert.match(inspect.negativeCases.join(' '), /replace-initialRevisionId-with-new-current-head/u);
  assert.match(inspect.negativeCases.join(' '), /mismatched-original-requestFingerprint/u);
});

test('J-01 initial state definition does not invent transitions or close broader project lifecycle semantics', () => {
  const states = yaml('.product-experience/pdp-1-domain-data/states.yaml');
  const transitions = yaml('.product-experience/pdp-1-domain-data/transitions.yaml');
  const actionContracts = yaml('.product-experience/pdp-1-domain-data/action-contracts.yaml');
  const project = states.stateMachines.find(({ machineId }) => machineId === 'media-project');
  const revision = states.stateMachines.find(({ machineId }) => machineId === 'media-project-version');
  const projectTransitions = transitions.transitionRecords.filter(({ sourceMachineId }) => sourceMachineId.startsWith('media-project'));
  const bindings = actionContracts.operationSliceBindings;

  assert.match(project.meaningDisposition, /bounded-J01-ACTIVE-initial-create/u);
  assert.match(project.meaningDisposition, /archive-and-restore-guards-remain-pending/u);
  assert.match(revision.meaningDisposition, /bounded-J01-COMMITTED-empty-initial-revision/u);
  assert.match(revision.meaningDisposition, /draft-commit-branch-restore-and-conflict-guards-remain-pending/u);
  assert.ok(projectTransitions.every(({ guardDisposition }) => guardDisposition.includes('pending-owner-review')),
    'unrelated archive/restore/commit transitions remain unreviewed');
  assert.deepEqual(bindings['media.operation-slice.create-project'].actionIntentRefs, ['media.action.create-project']);
  assert.deepEqual(bindings['media.operation-slice.list-projects'].actionIntentRefs, []);
  assert.equal(bindings['media.operation-slice.create-project'].disposition.endsWith('runtime-NOT_ADMITTED'), true);
});

test('project action contracts distinguish collection reads from selected-project and creation-receipt inspection', () => {
  const bindings = yaml('.product-experience/pdp-1-domain-data/action-contracts.yaml').operationSliceBindings;
  const expected = {
    'media.operation-slice.create-project': ['media.action.create-project'],
    'media.operation-slice.list-projects': [],
    'media.operation-slice.inspect-project': ['media.action.open-project', 'media.action.inspect-project-creation'],
  };
  for (const [id, actionIntentRefs] of Object.entries(expected)) {
    assert.deepEqual(yaml('.product-experience/pdp-1-domain-data/operations.yaml').individualOperationContracts.records.find((record) => record.id === id).actionIntentRefs, actionIntentRefs);
    assert.deepEqual(bindings[id].actionIntentRefs, actionIntentRefs);
  }
});
