import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { evaluateMediaIdentityHandoffResult, validateMediaIdentityHandoffRequest } from '../scripts/lib/media-identity-handoff-definition.mjs';

const toolsRequire = createRequire(new URL('../../ghatana-tools/package.json', import.meta.url));
const { parse } = toolsRequire('yaml');
const source = parse(await readFile('.product-experience/pdp-3-product-experience/handoff-bindings.yaml', 'utf8'));
const handoff = source.handoffs.find(({ id }) => id === 'media.handoff.identity').mediaOwnerDefinition;
const now = '2026-10-08T12:00:00.000Z';
const routes = ['media.route.project'];
const pin = { externalOwner: 'ghatana-shared', externalContractRef: 'shared.identity.contract', externalRevision: 'rev-7', externalFingerprint: `sha256:${'a'.repeat(64)}` };
const anonymousInitiation = {
  action: 'INITIATE_IDENTITY_HANDOFF',
  mediaRequest: { registeredReturnRouteId: 'media.route.project', correlationId: 'corr-1' },
  hostContext: { interactionNonce: 'host-nonce-1', identityStatus: 'ANONYMOUS', principalContextRef: null, tenantContextRef: null, adapterVerificationStatus: 'HOST_ADAPTER_READY' },
};
const authenticatedSelection = {
  action: 'SELECT_CONFIRMED_WORKSPACE',
  mediaRequest: { registeredReturnRouteId: 'media.route.project', correlationId: 'corr-2', requestedWorkspaceId: 'workspace-ref-1' },
  hostContext: { interactionNonce: 'host-nonce-2', identityStatus: 'AUTHENTICATED', principalContextRef: 'principal-ref-1', tenantContextRef: 'tenant-ref-1', adapterVerificationStatus: 'HOST_ADAPTER_READY' },
};
const authenticatedResult = {
  ...pin, interactionNonce: 'host-nonce-2', outcome: 'AUTHORIZED', principalContextRef: 'principal-ref-1',
  tenantContextRef: 'tenant-ref-1', requestedWorkspaceId: 'workspace-ref-1', membershipDisposition: 'CURRENT_MEMBER',
  workspaceSelectionEvidenceRef: 'shared-evidence-ref-1',
  observedAt: '2026-10-08T11:59:00.000Z', validUntil: '2026-10-08T12:01:00.000Z', registeredReturnRouteId: 'media.route.project', hostAdapterVerificationStatus: 'HOST_VERIFIED',
};
const anonymousResult = { ...authenticatedResult, interactionNonce: 'host-nonce-1', principalContextRef: 'principal-new', tenantContextRef: 'tenant-new', requestedWorkspaceId: null, membershipDisposition: 'UNKNOWN', workspaceSelectionEvidenceRef: null };
const evaluate = (request, result, expectedOwnerPin = pin, routeIds = routes) => evaluateMediaIdentityHandoffResult(request, result, { now, registeredReturnRouteIds: routeIds, expectedOwnerPin });

test('Media identity adapter envelope stays typed and Shared wire names remain pending', () => {
  assert.equal(handoff.sourceDecisionRef, '.product-experience/decision-log.md#PXD-082');
  assert.equal(handoff.adapterEnvelopeDefinition.sharedWireSchemaStatus, 'PENDING_SHARED_OWNER_EVIDENCE');
  assert.deepEqual(handoff.adapterEnvelopeDefinition.request.requiredFields, ['action', 'mediaRequest', 'hostContext']);
  assert.match(handoff.adapterEnvelopeDefinition.request.hostContext.anonymousContext, /ANONYMOUS/u);
  assert.ok(handoff.adapterEnvelopeDefinition.result.sharedWireMapping.includes('unbound to Shared wire names'));
});

test('anonymous initiation and authenticated workspace selection use distinct trusted host contexts', () => {
  assert.equal(validateMediaIdentityHandoffRequest(anonymousInitiation, routes), true);
  assert.equal(validateMediaIdentityHandoffRequest(authenticatedSelection, routes), true);
  assert.equal(validateMediaIdentityHandoffRequest({ ...authenticatedSelection, hostContext: { ...authenticatedSelection.hostContext, principalContextRef: null } }, routes), false);
  assert.equal(validateMediaIdentityHandoffRequest({ ...anonymousInitiation, action: 'SELECT_CONFIRMED_WORKSPACE' }, routes), false);
  assert.equal(evaluate(anonymousInitiation, anonymousResult), 'HOST_ADAPTER_EVIDENCE_ACCEPTABLE_FOR_CONTEXT');
});

test('identity requests reject injected credentials, caller claims, unsafe routes, and malformed host options', () => {
  assert.equal(validateMediaIdentityHandoffRequest(authenticatedSelection, routes), true);
  assert.equal(validateMediaIdentityHandoffRequest({ ...authenticatedSelection, mediaRequest: { ...authenticatedSelection.mediaRequest, accessToken: 'secret' } }, routes), false);
  assert.equal(validateMediaIdentityHandoffRequest({ ...authenticatedSelection, mediaRequest: { ...authenticatedSelection.mediaRequest, tenantId: 'tenant-forgery' } }, routes), false);
  assert.equal(validateMediaIdentityHandoffRequest({ ...authenticatedSelection, mediaRequest: { ...authenticatedSelection.mediaRequest, registeredReturnRouteId: 'https://attacker.invalid' } }, routes), false);
  assert.equal(validateMediaIdentityHandoffRequest(authenticatedSelection, undefined), false);
  const inherited = Object.create({ forged: true });
  Object.assign(inherited, authenticatedSelection);
  assert.equal(validateMediaIdentityHandoffRequest(inherited, routes), false);
});

test('all result outcomes stay bound to nonce and return route before affecting the view', () => {
  assert.equal(evaluate(authenticatedSelection, authenticatedResult), 'HOST_ADAPTER_EVIDENCE_ACCEPTABLE_FOR_CONTEXT');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, outcome: 'DENIED' }), 'DENIED');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, outcome: 'DENIED', interactionNonce: 'other' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, outcome: 'UNAVAILABLE', registeredReturnRouteId: 'other' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, outcome: 'UNKNOWN' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, outcome: 'DENIED', externalOwner: 'forged-owner' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, outcome: 'EXPIRED_OR_REVOKED', validUntil: '2026-10-08T11:59:00.000Z' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, outcome: 'DENIED', requestedWorkspaceId: 'other-workspace' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, outcome: 'EXPIRED_OR_REVOKED', requestedWorkspaceId: 'other-workspace' }), 'HOLD_UNKNOWN');
});

test('exact owner pin, identity, membership, clock and expiry are required for an acceptable fixture', () => {
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, membershipDisposition: 'UNKNOWN' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, requestedWorkspaceId: 'other-workspace' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, tenantContextRef: 'other-tenant' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, externalOwner: 'other-owner' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, externalFingerprint: 'sha256:abc' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, validUntil: 'not-a-date' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, validUntil: '0' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, validUntil: '2026-02-31T12:00:00.000Z' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, validUntil: '2026-10-08' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, validUntil: '2026-10-08T11:59:59.000Z' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, hostAdapterVerificationStatus: 'INVALID' }), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, authenticatedResult, null), 'HOLD_UNKNOWN');
  assert.equal(evaluate(authenticatedSelection, { ...authenticatedResult, workspaceSelectionEvidenceRef: null }), 'HOLD_UNKNOWN');
  assert.equal(evaluateMediaIdentityHandoffResult(authenticatedSelection, authenticatedResult, { registeredReturnRouteIds: routes, expectedOwnerPin: pin }), 'HOLD_UNKNOWN');
  assert.equal(evaluateMediaIdentityHandoffResult(authenticatedSelection, authenticatedResult, null), 'HOLD_UNKNOWN');
  assert.equal(evaluateMediaIdentityHandoffResult(authenticatedSelection, authenticatedResult, []), 'HOLD_UNKNOWN');
  assert.equal(evaluateMediaIdentityHandoffResult(authenticatedSelection, authenticatedResult, { now, registeredReturnRouteIds: routes, expectedOwnerPin: pin, forgedOwner: 'attacker' }), 'HOLD_UNKNOWN');
  const inheritedOptions = Object.assign(Object.create({ expectedOwnerPin: pin }), { now, registeredReturnRouteIds: routes });
  assert.equal(evaluateMediaIdentityHandoffResult(authenticatedSelection, authenticatedResult, inheritedOptions), 'HOLD_UNKNOWN');
});
