package com.ghatana.audiovideo.adapter.ledger;

import com.ghatana.datacloud.delivery.ledger.RunLedger;

import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Latest-truth projection guard for Data Cloud RunLedger delivery.
 *
 * <p>LD-04: replayed, out-of-order and stale ledger updates must never
 * overwrite a newer truth, and a store that is unavailable is reported
 * explicitly — never as a false acknowledgment. A record is only projected
 * when it carries strictly newer truth (a later attempt, a terminal outcome
 * replacing an open one, or a strictly newer timestamp); an ambiguous
 * same-attempt/same-instant conflict is rejected rather than silently
 * resolved. No second ledger writer or database is introduced — the sink is
 * the existing Data Cloud RunLedger API.
 *
 * @doc.type class
 * @doc.purpose Idempotent, order-protected RunLedger projection
 * @doc.layer product
 * @doc.pattern Projection Guard
 */
public final class RunLedgerProjection {

    // A fixed set keeps synchronization memory bounded while ensuring a run's
    // compare/store/update sequence is indivisible within this process.
    private static final int LOCK_STRIPE_COUNT = 64;

    /** What the projection decided about an incoming record. */
    public enum Disposition {
        /** Newer truth — forwarded to the store. */
        PROJECTED,
        /** Byte-identical replay of the last projected record — idempotent skip. */
        REPLAYED,
        /** Older or weaker truth — skipped without touching the store. */
        STALE,
        /** Same attempt at the same logical instant but different truth — rejected. */
        CONFLICT,
        /** A prior store call may have committed and must be reconciled first. */
        PENDING_RECONCILIATION
    }

    /** Whether the store acknowledged the projection. */
    public enum StoreResult {
        ACKNOWLEDGED,
        UNAVAILABLE,
        /** The store may have committed; the acknowledgement is unknown. */
        OUTCOME_UNKNOWN,
        /** Store was not contacted — nothing newer to write. */
        NOT_ATTEMPTED
    }

    public record ProjectionResult(Disposition disposition, StoreResult store) { }

    /** Existing Data Cloud RunLedger delivery surface; failures mean unavailable. */
    @FunctionalInterface
    public interface LedgerStore {
        void store(RunLedger ledger) throws Exception;
    }

    /** The store guarantees this exception is raised before any write attempt. */
    public static final class StoreNotDispatchedException extends Exception {
        public StoreNotDispatchedException(String message) { super(message); }
    }

    /** Host-supplied authoritative readback from the same ledger authority. */
    @FunctionalInterface
    public interface LedgerReadback {
        Optional<RunLedger> read(String runId) throws Exception;
    }

    public enum ReconciliationResult { NO_PENDING, CONFIRMED, UNRESOLVED }

    /**
     * Durable backing for the per-run projection triple (latest truth,
     * pre-dispatch-unavailable floor, uncertain fence). When supplied, state
     * is hydrated once per run and persisted after every transition, so a
     * process restart cannot silently drop a reconciliation fence or replay
     * guard. Implementations must fail loudly on I/O errors — a silently
     * lost fence is worse than a failed projection.
     */
    public interface ProjectionStateBacking {
        /** All three slots may independently be absent (null). */
        record RunProjectionState(RunLedger latest, RunLedger unavailable, RunLedger uncertain) { }

        Optional<RunProjectionState> load(String runId);

        void save(String runId, RunProjectionState state);
    }

    private final LedgerStore store;
    private final ProjectionStateBacking stateBacking;
    private final Map<String, RunLedger> latestByRunId = new ConcurrentHashMap<>();
    // A pre-dispatch refusal proves no effect occurred, but the incoming record
    // is still the newest truth observed by this projection. Keep it as an
    // ordering floor so delayed weaker records cannot pass while the exact
    // record (or a strictly newer one) remains retryable.
    private final Map<String, RunLedger> unavailableByRunId = new ConcurrentHashMap<>();
    private final Map<String, RunLedger> uncertainByRunId = new ConcurrentHashMap<>();
    private final java.util.Set<String> hydratedRunIds =
            java.util.concurrent.ConcurrentHashMap.newKeySet();
    private final Object[] runLocks = new Object[LOCK_STRIPE_COUNT];

    public RunLedgerProjection(LedgerStore store) {
        this(store, null);
    }

    public RunLedgerProjection(LedgerStore store, ProjectionStateBacking stateBacking) {
        this.store = Objects.requireNonNull(store, "store must not be null");
        this.stateBacking = stateBacking;
        for (int i = 0; i < runLocks.length; i++) {
            runLocks[i] = new Object();
        }
    }

    /**
     * Projects one ledger record. An exception after dispatch leaves an
     * unknown outcome; later writes for that run are held until exact readback.
     * Only a store-guaranteed pre-dispatch refusal is classified unavailable.
     * The fence is process-local and does not establish restart durability.
     */
    public ProjectionResult project(RunLedger incoming) {
        Objects.requireNonNull(incoming, "incoming must not be null");
        Object runLock = lockFor(incoming.runId());
        synchronized (runLock) {
            hydrate(incoming.runId());
            if (uncertainByRunId.containsKey(incoming.runId())) {
                return new ProjectionResult(Disposition.PENDING_RECONCILIATION, StoreResult.OUTCOME_UNKNOWN);
            }
            RunLedger latest = latestByRunId.get(incoming.runId());
            RunLedger pendingBeforeDispatch = unavailableByRunId.get(incoming.runId());
            RunLedger orderingFloor = pendingBeforeDispatch == null ? latest : pendingBeforeDispatch;
            Disposition disposition = disposition(orderingFloor, incoming);
            // The exact record previously refused before dispatch is a retry,
            // not a duplicate of a confirmed store write.
            if (pendingBeforeDispatch != null && pendingBeforeDispatch.equals(incoming)) {
                disposition = Disposition.PROJECTED;
            }
            if (disposition != Disposition.PROJECTED) {
                return new ProjectionResult(disposition, StoreResult.NOT_ATTEMPTED);
            }
            try {
                store.store(incoming);
            } catch (StoreNotDispatchedException unavailable) {
                unavailableByRunId.put(incoming.runId(), incoming);
                persist(incoming.runId());
                return new ProjectionResult(disposition, StoreResult.UNAVAILABLE);
            } catch (Exception unknown) {
                if (unknown instanceof InterruptedException) Thread.currentThread().interrupt();
                unavailableByRunId.remove(incoming.runId());
                uncertainByRunId.put(incoming.runId(), incoming);
                persist(incoming.runId());
                return new ProjectionResult(disposition, StoreResult.OUTCOME_UNKNOWN);
            } catch (Error fatal) {
                // An effect may have occurred even when the caller must see a
                // fatal failure. Fence any later in-process retry first.
                unavailableByRunId.remove(incoming.runId());
                uncertainByRunId.put(incoming.runId(), incoming);
                persist(incoming.runId());
                throw fatal;
            }
            latestByRunId.put(incoming.runId(), incoming);
            unavailableByRunId.remove(incoming.runId());
            persist(incoming.runId());
            return new ProjectionResult(disposition, StoreResult.ACKNOWLEDGED);
        }
    }

    /**
     * Clears an in-process fence only when the trusted ledger readback returns
     * the exact uncertain record. Missing, different, or failed readback cannot
     * prove whether the prior effect occurred and keeps the fence in place.
     */
    public ReconciliationResult reconcile(String runId, LedgerReadback readback) {
        Objects.requireNonNull(runId, "runId");
        Objects.requireNonNull(readback, "readback");
        synchronized (lockFor(runId)) {
            hydrate(runId);
            RunLedger pending = uncertainByRunId.get(runId);
            if (pending == null) return ReconciliationResult.NO_PENDING;
            final Optional<RunLedger> observed;
            try {
                observed = readback.read(runId);
            } catch (Exception unavailable) {
                if (unavailable instanceof InterruptedException) Thread.currentThread().interrupt();
                return ReconciliationResult.UNRESOLVED;
            }
            if (observed == null || observed.isEmpty() || !pending.equals(observed.get())) {
                return ReconciliationResult.UNRESOLVED;
            }
            latestByRunId.put(runId, pending);
            uncertainByRunId.remove(runId);
            persist(runId);
            return ReconciliationResult.CONFIRMED;
        }
    }

    private void hydrate(String runId) {
        if (stateBacking == null || !hydratedRunIds.add(runId)) return;
        stateBacking.load(runId).ifPresent(state -> {
            if (state.latest() != null) latestByRunId.put(runId, state.latest());
            if (state.unavailable() != null) unavailableByRunId.put(runId, state.unavailable());
            if (state.uncertain() != null) uncertainByRunId.put(runId, state.uncertain());
        });
    }

    private void persist(String runId) {
        if (stateBacking == null) return;
        stateBacking.save(runId, new ProjectionStateBacking.RunProjectionState(
                latestByRunId.get(runId), unavailableByRunId.get(runId), uncertainByRunId.get(runId)));
    }

    private Object lockFor(String runId) {
        return runLocks[Math.floorMod(runId.hashCode(), runLocks.length)];
    }

    private static Disposition disposition(RunLedger previous, RunLedger incoming) {
        if (previous == null) {
            return Disposition.PROJECTED;
        }
        if (previous.equals(incoming)) {
            return Disposition.REPLAYED;
        }
        if (incoming.attemptNumber() != previous.attemptNumber()) {
            return incoming.attemptNumber() > previous.attemptNumber()
                    ? Disposition.PROJECTED : Disposition.STALE;
        }
        boolean incomingTerminal = incoming.outcome() != null;
        boolean previousTerminal = previous.outcome() != null;
        // A recorded terminal truth is never replaced by an open outcome;
        // finality always supersedes an in-flight view.
        if (previousTerminal && !incomingTerminal) {
            return Disposition.STALE;
        }
        // A job attempt has one immutable terminal result. A later timestamp
        // cannot make a contradictory terminal record newer truth: timestamps
        // order observations, but do not authorize rewriting a finalized
        // attempt. Exact repeats were handled above as REPLAYED.
        if (previousTerminal && incomingTerminal) {
            long incomingAt = Math.max(incoming.completedAtMs(), incoming.createdAtMs());
            long previousAt = Math.max(previous.completedAtMs(), previous.createdAtMs());
            return incomingAt < previousAt ? Disposition.STALE : Disposition.CONFLICT;
        }
        if (incomingTerminal && !previousTerminal) {
            return Disposition.PROJECTED;
        }
        long incomingAt = Math.max(incoming.completedAtMs(), incoming.createdAtMs());
        long previousAt = Math.max(previous.completedAtMs(), previous.createdAtMs());
        if (incomingAt > previousAt) {
            return Disposition.PROJECTED;
        }
        if (incomingAt < previousAt) {
            return Disposition.STALE;
        }
        return Disposition.CONFLICT;
    }
}
