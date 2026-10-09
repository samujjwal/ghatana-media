const REQUEST_KEYS = new Set(['action', 'mediaRequest', 'hostContext']);
const MEDIA_REQUEST_KEYS = new Set(['registeredReturnRouteId', 'correlationId', 'requestedWorkspaceId']);
const HOST_CONTEXT_KEYS = new Set(['interactionNonce', 'identityStatus', 'principalContextRef', 'tenantContextRef', 'adapterVerificationStatus']);
const RESULT_KEYS = new Set([
  'externalOwner', 'externalContractRef', 'externalRevision', 'externalFingerprint', 'interactionNonce', 'outcome',
  'principalContextRef', 'tenantContextRef', 'requestedWorkspaceId', 'membershipDisposition',
  'workspaceSelectionEvidenceRef', 'observedAt', 'validUntil', 'registeredReturnRouteId', 'hostAdapterVerificationStatus',
]);
const plainRecord = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
  && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
const hasOnly = (value, keys) => plainRecord(value) && Object.keys(value).every((key) => keys.has(key));
const nonempty = (value) => typeof value === 'string' && value.trim().length > 0;
const instant = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value))
  && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)
  && new Date(Date.parse(value)).toISOString() === value;
const safeRoutes = (routes) => Array.isArray(routes) && routes.length > 0 && routes.every(nonempty);

/** Validates Media's proposed adapter envelope; this does not verify Shared signatures or live authority. */
export function validateMediaIdentityHandoffRequest(request, registeredReturnRouteIds) {
  if (!safeRoutes(registeredReturnRouteIds) || !hasOnly(request, REQUEST_KEYS)
      || !['INITIATE_IDENTITY_HANDOFF', 'SELECT_CONFIRMED_WORKSPACE'].includes(request.action)) return false;
  const media = request.mediaRequest;
  const host = request.hostContext;
  if (!hasOnly(media, MEDIA_REQUEST_KEYS) || !hasOnly(host, HOST_CONTEXT_KEYS)) return false;
  if (!nonempty(media.registeredReturnRouteId) || !registeredReturnRouteIds.includes(media.registeredReturnRouteId)) return false;
  if (!nonempty(media.correlationId)) return false;
  if (!nonempty(host.interactionNonce) || !['ANONYMOUS', 'AUTHENTICATED', 'UNKNOWN'].includes(host.identityStatus)) return false;
  if (!['HOST_ADAPTER_READY', 'MISSING', 'INVALID'].includes(host.adapterVerificationStatus)) return false;
  if (host.identityStatus === 'ANONYMOUS' && (host.principalContextRef !== null || host.tenantContextRef !== null)) return false;
  if (host.identityStatus === 'AUTHENTICATED' && (!nonempty(host.principalContextRef) || !nonempty(host.tenantContextRef))) return false;
  if (host.identityStatus === 'UNKNOWN') return false;
  if (request.action === 'SELECT_CONFIRMED_WORKSPACE') {
    if (host.identityStatus !== 'AUTHENTICATED' || !nonempty(media.requestedWorkspaceId)) return false;
  }
  if (request.action === 'INITIATE_IDENTITY_HANDOFF' && media.requestedWorkspaceId !== undefined) return false;
  return true;
}

/** Evaluates host-normalized definition facts only; acceptable disposition is not authentication or authorization. */
export function evaluateMediaIdentityHandoffResult(request, result, options = {}) {
  if (!plainRecord(options) || Object.keys(options).some((key) => !['now', 'registeredReturnRouteIds', 'expectedOwnerPin'].includes(key))) return 'HOLD_UNKNOWN';
  const { now, registeredReturnRouteIds, expectedOwnerPin } = options;
  if (!safeRoutes(registeredReturnRouteIds) || !validateMediaIdentityHandoffRequest(request, registeredReturnRouteIds)) return 'REQUEST_REJECTED';
  if (!hasOnly(result, RESULT_KEYS)) return 'HOLD_UNKNOWN';
  const host = request.hostContext;
  const media = request.mediaRequest;
  // Bind any outcome to this exact interaction and registered continuation before honoring DENIED/UNAVAILABLE/etc.
  if (result.interactionNonce !== host.interactionNonce || result.registeredReturnRouteId !== media.registeredReturnRouteId) return 'HOLD_UNKNOWN';
  if (host.identityStatus === 'AUTHENTICATED'
      && (result.principalContextRef !== host.principalContextRef || result.tenantContextRef !== host.tenantContextRef)) return 'HOLD_UNKNOWN';
  if (host.identityStatus === 'ANONYMOUS' && result.outcome !== 'AUTHORIZED'
      && (result.principalContextRef !== null || result.tenantContextRef !== null)) return 'HOLD_UNKNOWN';
  if (request.action === 'SELECT_CONFIRMED_WORKSPACE' && result.requestedWorkspaceId !== media.requestedWorkspaceId) return 'HOLD_UNKNOWN';
  if (request.action === 'INITIATE_IDENTITY_HANDOFF' && result.outcome !== 'AUTHORIZED'
      && (result.requestedWorkspaceId !== null || result.workspaceSelectionEvidenceRef !== null)) return 'HOLD_UNKNOWN';
  if (!['AUTHORIZED', 'DENIED', 'UNAVAILABLE', 'UNKNOWN', 'EXPIRED_OR_REVOKED'].includes(result.outcome)) return 'HOLD_UNKNOWN';
  if (host.adapterVerificationStatus !== 'HOST_ADAPTER_READY' || result.hostAdapterVerificationStatus !== 'HOST_VERIFIED') return 'HOLD_UNKNOWN';
  if (!expectedOwnerPin || !plainRecord(expectedOwnerPin)
      || !nonempty(expectedOwnerPin.externalOwner) || !nonempty(expectedOwnerPin.externalContractRef)
      || !nonempty(expectedOwnerPin.externalRevision)
      || !/^sha256:[a-f0-9]{64}$/u.test(expectedOwnerPin.externalFingerprint)) return 'HOLD_UNKNOWN';
  if (result.externalOwner !== expectedOwnerPin.externalOwner
      || result.externalContractRef !== expectedOwnerPin.externalContractRef
      || result.externalRevision !== expectedOwnerPin.externalRevision
      || result.externalFingerprint !== expectedOwnerPin.externalFingerprint) return 'HOLD_UNKNOWN';
  if (!instant(result.observedAt) || !instant(result.validUntil) || !instant(now)) return 'HOLD_UNKNOWN';
  const observedAt = Date.parse(result.observedAt);
  const validUntil = Date.parse(result.validUntil);
  const currentTime = Date.parse(now);
  if (observedAt > currentTime || currentTime >= validUntil) return 'HOLD_UNKNOWN';
  if (result.outcome === 'DENIED') return 'DENIED';
  if (result.outcome === 'UNAVAILABLE') return 'UNAVAILABLE';
  if (result.outcome === 'EXPIRED_OR_REVOKED') return 'REAUTHENTICATION_REQUIRED';
  if (result.outcome === 'UNKNOWN') return 'HOLD_UNKNOWN';
  if (request.action === 'SELECT_CONFIRMED_WORKSPACE') {
    if (result.principalContextRef !== host.principalContextRef || result.tenantContextRef !== host.tenantContextRef
        || result.requestedWorkspaceId !== media.requestedWorkspaceId || result.membershipDisposition !== 'CURRENT_MEMBER'
        || !nonempty(result.workspaceSelectionEvidenceRef)) return 'HOLD_UNKNOWN';
  } else if (result.requestedWorkspaceId !== null) {
    if (!nonempty(result.requestedWorkspaceId) || result.membershipDisposition !== 'CURRENT_MEMBER'
        || !nonempty(result.workspaceSelectionEvidenceRef)) return 'HOLD_UNKNOWN';
  } else if (result.membershipDisposition !== 'UNKNOWN' || result.workspaceSelectionEvidenceRef !== null) return 'HOLD_UNKNOWN';
  if (request.action === 'INITIATE_IDENTITY_HANDOFF'
      && (!nonempty(result.principalContextRef) || !nonempty(result.tenantContextRef))) return 'HOLD_UNKNOWN';
  return 'HOST_ADAPTER_EVIDENCE_ACCEPTABLE_FOR_CONTEXT';
}
