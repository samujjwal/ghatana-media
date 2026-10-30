package com.ghatana.audiovideo.adapter.ledger;

import com.ghatana.datacloud.delivery.ledger.RunLedger;

import java.util.Map;
import java.util.Objects;
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

    /** What the projection decided about an incoming record. */
    public enum Disposition {
        /** Newer truth — forwarded to the store. */
        PROJECTED,
        /** Byte-identical replay of the last projected record — idempotent skip. */
        REPLAYED,
        /** Older or weaker truth — skipped without touching the store. */
        STALE,
        /** Same attempt at the same logical instant but different truth — rejected. */
        CONFLICT
    }

    /** Whether the store acknowledged the projection. */
    public enum StoreResult {
        ACKNOWLEDGED,
        UNAVAILABLE,
        /** Store was not contacted — nothing newer to write. */
        NOT_ATTEMPTED
    }

    public record ProjectionResult(Disposition disposition, StoreResult store) { }

    /** Existing Data Cloud RunLedger delivery surface; failures mean unavailable. */
    @FunctionalInterface
    public interface LedgerStore {
        void store(RunLedger ledger) throws Exception;
    }

    private final LedgerStore store;
    private final Map<String, RunLedger> latestByRunId = new ConcurrentHashMap<>();

    public RunLedgerProjection(LedgerStore store) {
        this.store = Objects.requireNonNull(store, "store must not be null");
    }

    /**
     * Projects one ledger record. A {@code STALE}, {@code REPLAYED} or
     * {@code CONFLICT} decision never reaches the store; a store failure is
     * reported as {@link StoreResult#UNAVAILABLE} and the record is not marked
     * as projected, so a later retry can still deliver it.
     */
    public ProjectionResult project(RunLedger incoming) {
        Objects.requireNonNull(incoming, "incoming must not be null");
        Disposition disposition = disposition(latestByRunId.get(incoming.runId()), incoming);
        if (disposition != Disposition.PROJECTED) {
            return new ProjectionResult(disposition, StoreResult.NOT_ATTEMPTED);
        }
        try {
            store.store(incoming);
        } catch (Exception unavailable) {
            return new ProjectionResult(disposition, StoreResult.UNAVAILABLE);
        }
        latestByRunId.put(incoming.runId(), incoming);
        return new ProjectionResult(disposition, StoreResult.ACKNOWLEDGED);
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
