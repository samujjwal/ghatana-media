package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRequestLedgerContracts.Acquired;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Claim;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Erased;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Entry;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.InProgress;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Key;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Mismatch;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Replay;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.RequestLedger;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.State;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Process-local ledger for tests and explicitly non-durable runs. It has the same claim/fence semantics as the
 * PostgreSQL ledger but loses everything on restart, so it must never be presented as durable idempotency.
 */
public final class InMemoryMediaRequestLedger implements RequestLedger {
    private final Clock clock;
    private final Map<Key, Entry> rows = new HashMap<>();
    private boolean closed;

    public InMemoryMediaRequestLedger() { this(Clock.systemUTC()); }

    public InMemoryMediaRequestLedger(Clock clock) { this.clock = Objects.requireNonNull(clock, "clock"); }

    @Override public String ledgerId() { return "in-memory-request-ledger"; }

    @Override public synchronized boolean ready() { return !closed; }

    @Override public synchronized Claim claim(Key key, String fingerprint, String owner, Duration lease) {
        ensureOpen();
        MediaRequestLedgerContracts.requireFingerprint(fingerprint);
        Objects.requireNonNull(owner, "owner");
        if (lease == null || lease.isZero() || lease.isNegative()) throw new IllegalArgumentException("lease must be positive");
        Instant now = clock.instant();
        Entry current = rows.get(key);
        if (current == null) {
            rows.put(key, new Entry(key, fingerprint, State.IN_PROGRESS, owner, 1, now.plus(lease), 1, List.of(), "",
                    now, now, null));
            return new Acquired(1, 1, false);
        }
        if (current.state() == State.ERASED) return new Erased();
        if (current.state() == State.RELEASED) {
            long fence = current.fence() + 1;
            int attempt = current.attempts() + 1;
            rows.put(key, new Entry(key, fingerprint, State.IN_PROGRESS, owner, fence, now.plus(lease), attempt, List.of(),
                    "", current.createdAt(), now, null));
            return new Acquired(fence, attempt, false);
        }
        if (!current.fingerprint().equals(fingerprint)) return new Mismatch();
        if (current.state() == State.COMPLETED) return new Replay(current.outputs());
        if (current.leaseExpiresAt().isAfter(now)) {
            return new InProgress(current.leaseExpiresAt(), current.leaseOwner(), current.fence());
        }
        long fence = current.fence() + 1;
        int attempt = current.attempts() + 1;
        rows.put(key, new Entry(key, fingerprint, State.IN_PROGRESS, owner, fence, now.plus(lease), attempt, List.of(),
                current.lastFailureCode(), current.createdAt(), now, null));
        return new Acquired(fence, attempt, true);
    }

    @Override public synchronized Claim reclaim(Key key, String fingerprint, String expectedOwner, long expectedFence,
                                                String newOwner, Duration lease) {
        ensureOpen();
        MediaRequestLedgerContracts.requireFingerprint(fingerprint);
        if (lease == null || lease.isZero() || lease.isNegative()) throw new IllegalArgumentException("lease must be positive");
        Entry current = rows.get(key);
        if (current != null && current.state() == State.IN_PROGRESS && current.fingerprint().equals(fingerprint)
                && current.leaseOwner().equals(expectedOwner) && current.fence() == expectedFence) {
            Instant now = clock.instant();
            long fence = current.fence() + 1;
            int attempt = current.attempts() + 1;
            rows.put(key, new Entry(key, fingerprint, State.IN_PROGRESS, newOwner, fence, now.plus(lease), attempt,
                    List.of(), current.lastFailureCode(), current.createdAt(), now, null));
            return new Acquired(fence, attempt, true);
        }
        return claim(key, fingerprint, newOwner, lease);
    }

    @Override public synchronized boolean complete(Key key, long fence, List<OutputRef> outputs) {
        ensureOpen();
        if (outputs == null || outputs.isEmpty()) throw new IllegalArgumentException("a completed request needs an output");
        Entry current = rows.get(key);
        if (current == null || current.state() != State.IN_PROGRESS || current.fence() != fence) return false;
        Instant now = clock.instant();
        rows.put(key, new Entry(key, current.fingerprint(), State.COMPLETED, current.leaseOwner(), fence,
                current.leaseExpiresAt(), current.attempts(), outputs, "", current.createdAt(), now, now));
        return true;
    }

    @Override public synchronized boolean release(Key key, long fence, String failureCode) {
        ensureOpen();
        Entry current = rows.get(key);
        if (current == null || current.state() != State.IN_PROGRESS || current.fence() != fence) return false;
        rows.put(key, new Entry(key, current.fingerprint(), State.RELEASED, current.leaseOwner(), fence,
                current.leaseExpiresAt(), current.attempts(), List.of(), failureCode == null ? "" : failureCode,
                current.createdAt(), clock.instant(), null));
        return true;
    }

    @Override public synchronized Optional<Entry> find(Key key) {
        ensureOpen();
        return Optional.ofNullable(rows.get(key));
    }

    @Override public synchronized int eraseOutputs(String tenantId, java.util.Set<String> artifactIds) {
        ensureOpen();
        int changed = 0;
        Instant now = clock.instant();
        for (Map.Entry<Key, Entry> row : new java.util.ArrayList<>(rows.entrySet())) {
            Entry entry = row.getValue();
            if (!entry.key().tenantId().equals(tenantId) || entry.state() != State.COMPLETED) continue;
            if (entry.outputs().stream().noneMatch(output -> artifactIds.contains(output.artifactId()))) continue;
            rows.put(row.getKey(), new Entry(entry.key(), entry.fingerprint(), State.ERASED, entry.leaseOwner(),
                    entry.fence(), entry.leaseExpiresAt(), entry.attempts(), List.of(), "", entry.createdAt(), now, null));
            changed++;
        }
        return changed;
    }

    @Override public synchronized void close() { closed = true; }

    private void ensureOpen() {
        if (closed) throw new IllegalStateException("request ledger is closed");
    }
}
