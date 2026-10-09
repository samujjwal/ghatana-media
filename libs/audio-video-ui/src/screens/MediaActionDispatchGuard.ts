import { canonicalMediaActionRequest, type MediaActionPort, type MediaActionDispatchResult, type MediaActionReconciliation } from "../ports";
import { MEDIA_LOCAL_ACTION_IDS } from "./MediaLocalActionContracts";

export interface MediaActionDispatchGuard {
  readonly actionPort: MediaActionPort;
  isInFlight(actionId: string): boolean;
  observeReconciliations(records: readonly MediaActionReconciliation[]): void;
}

interface AwaitingOwnerReconciliation {
  readonly actionId: string;
  readonly requestId: string | null;
  readonly requestCanonical: string;
  readonly subjectRefs: readonly string[];
  readonly baselineRevisions: ReadonlySet<string>;
  readonly seenRevisions: Set<string>;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sameReconciliationIdentity(record: MediaActionReconciliation, expected: Pick<AwaitingOwnerReconciliation, "actionId" | "requestId" | "requestCanonical" | "subjectRefs">): boolean {
  return record.actionId === expected.actionId
    && record.requestId === expected.requestId
    && record.requestCanonical === expected.requestCanonical
    && sameStrings(record.subjectRefs, expected.subjectRefs);
}

/**
 * Serializes the same action synchronously and holds uncertain requests until a
 * trusted owner projection reconciles the exact request, subjects and outcome.
 */
export function createMediaActionDispatchGuard(
  delegate: MediaActionPort,
  onPendingChange: (actionId: string, pending: boolean) => void = () => undefined,
): MediaActionDispatchGuard {
  const inFlight = new Set<string>();
  const awaitingOwner = new Map<string, AwaitingOwnerReconciliation>();
  let latestReconciliations: readonly MediaActionReconciliation[] = [];

  const releaseIfReconciled = (actionId: string): boolean => {
    const expected = awaitingOwner.get(actionId);
    if (!expected) return false;
    if (expected.subjectRefs.length === 0 || expected.subjectRefs.some((ref) => ref.trim().length === 0)) return false;
    const exactRecords = latestReconciliations.filter((record) =>
      sameReconciliationIdentity(record, expected) && record.reconciliationRevision.trim().length > 0,
    );
    const eligibleRevisions = new Map<string, Set<MediaActionReconciliation["disposition"]>>();
    for (const record of exactRecords) {
      const dispositions = eligibleRevisions.get(record.reconciliationRevision) ?? new Set<MediaActionReconciliation["disposition"]>();
      dispositions.add(record.disposition);
      eligibleRevisions.set(record.reconciliationRevision, dispositions);
    }
    // An immutable revision cannot simultaneously mean pending/unknown and
    // effect-resolved/retry-authorized. Conflicting records invalidate that
    // revision instead of allowing a permissive sibling record to unlock it.
    const exactOutcome = exactRecords.some((record) => {
      const dispositions = eligibleRevisions.get(record.reconciliationRevision);
      if (dispositions?.size !== 1) return false;
      return !expected.baselineRevisions.has(record.reconciliationRevision)
        && !expected.seenRevisions.has(record.reconciliationRevision)
        && (record.disposition === "retry-authorized" || (expected.requestId !== null && record.disposition === "effect-resolved"));
    });
    for (const record of exactRecords) expected.seenRevisions.add(record.reconciliationRevision);
    if (!exactOutcome) return false;
    awaitingOwner.delete(actionId);
    inFlight.delete(actionId);
    onPendingChange(actionId, false);
    return true;
  };

  return {
    isInFlight: (actionId) => inFlight.has(actionId),
    observeReconciliations: (records) => {
      latestReconciliations = records;
      for (const actionId of awaitingOwner.keys()) releaseIfReconciled(actionId);
    },
    actionPort: {
      invoke: async (actionId, payload, context): Promise<MediaActionDispatchResult> => {
        if (inFlight.has(actionId)) {
          return { status: "unavailable", reason: "This action is already in flight or awaits exact owner reconciliation; do not retry from a stale projection." };
        }
        const subjectRefs = context?.subjectRefs ?? [];
        let requestCanonical: string;
        try {
          requestCanonical = canonicalMediaActionRequest(actionId, payload, { subjectRefs });
        } catch (error) {
          return { status: "unavailable", reason: error instanceof Error ? error.message : "Action request is malformed." };
        }
        // Capture exact matching owner-record revisions before the request can
        // race a reconciliation update; projection version changes alone never unlock.
        const expectedBase = { actionId, requestId: null, requestCanonical, subjectRefs: [...subjectRefs] };
        const baselineRevisions = new Set(latestReconciliations.filter((record) =>
          record.actionId === actionId
          && record.requestCanonical === requestCanonical
          && sameStrings(record.subjectRefs, subjectRefs)
          && record.reconciliationRevision.trim().length > 0,
        ).map((record) => record.reconciliationRevision));
        inFlight.add(actionId);
        onPendingChange(actionId, true);
        let release = false;
        try {
          const result = await delegate.invoke(actionId, payload, { subjectRefs });
          if (result.status === "denied" || result.status === "unavailable"
            || (result.status === "local-applied" && MEDIA_LOCAL_ACTION_IDS.has(actionId))) {
            release = true;
          } else {
            const requestId = result.status === "request-started" || result.status === "request-acknowledged"
              ? result.requestId.trim().length > 0 ? result.requestId : null
              : null;
            awaitingOwner.set(actionId, { ...expectedBase, requestId, baselineRevisions, seenRevisions: new Set() });
            releaseIfReconciled(actionId);
            release = !inFlight.has(actionId);
          }
          // Uncertain outcomes stay locked until an exact owner record resolves
          // the same request, or explicitly authorizes retry for that request.
          return result;
        } catch (error) {
          awaitingOwner.set(actionId, { ...expectedBase, baselineRevisions, seenRevisions: new Set() });
          releaseIfReconciled(actionId);
          throw error;
        } finally {
          if (release && inFlight.delete(actionId)) {
            awaitingOwner.delete(actionId);
            onPendingChange(actionId, false);
          }
        }
      },
    },
  };
}
