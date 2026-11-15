package com.ghatana.media.runtime;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * DEV_ONLY reversible head pointer over an owner-scoped lineage of immutable artifact versions (J-19). The ledger is an
 * append-only event log: {@code BASE} names the version the lineage started from, {@code APPLY} makes a new immutable
 * version the head, and {@code UNDO} pops the latest applied version so the previous head is restored exactly (the very
 * same artifact version, never a copy). The head is always derived from the log by {@link HeadState#of}; nothing is ever
 * updated or deleted, and no version content lives here. The ledger is never an authority for rights.
 */
public final class MediaHeadLedgerContracts {
    private static final Pattern ID = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");
    private static final Pattern VERSION = Pattern.compile("sha256:[0-9a-f]{64}");

    private MediaHeadLedgerContracts() { }

    public enum Kind { BASE, APPLY, UNDO }

    /** One immutable log entry. {@code undoesSeq} is set only for UNDO; {@code reportArtifactId} only for APPLY. */
    public record Event(String tenantId, String principalId, String lineageId, int seq, Kind kind, String requestId,
                        String artifactId, String artifactVersionId, String reportArtifactId, Integer undoesSeq,
                        Instant createdAt) {
        public Event {
            Objects.requireNonNull(tenantId, "tenantId");
            Objects.requireNonNull(principalId, "principalId");
            if (lineageId == null || !ID.matcher(lineageId).matches()) {
                throw new IllegalArgumentException("lineageId is not a valid opaque id");
            }
            if (seq < 1) throw new IllegalArgumentException("seq must be positive");
            Objects.requireNonNull(kind, "kind");
            if (requestId == null || !ID.matcher(requestId).matches()) {
                throw new IllegalArgumentException("requestId is not a valid opaque id");
            }
            Objects.requireNonNull(artifactId, "artifactId");
            if (artifactVersionId == null || !VERSION.matcher(artifactVersionId).matches()) {
                throw new IllegalArgumentException("artifactVersionId is invalid");
            }
            if ((kind == Kind.UNDO) != (undoesSeq != null)) {
                throw new IllegalArgumentException("undoesSeq is required for UNDO and forbidden otherwise");
            }
            Objects.requireNonNull(createdAt, "createdAt");
        }
    }

    /** The head and the restorable stack derived from an event log: {@code stack().getLast()} is the head. */
    public record HeadState(List<Event> stack) {
        public HeadState { stack = List.copyOf(stack); }

        public static HeadState of(List<Event> events) {
            List<Event> stack = new ArrayList<>();
            for (Event event : events) {
                if (event.kind() == Kind.UNDO) {
                    if (stack.isEmpty() || stack.getLast().seq() != event.undoesSeq()) {
                        throw new IllegalStateException("head ledger log is inconsistent at seq " + event.seq());
                    }
                    stack.removeLast();
                } else {
                    stack.add(event);
                }
            }
            return new HeadState(stack);
        }

        public Optional<Event> head() { return stack.isEmpty() ? Optional.empty() : Optional.of(stack.getLast()); }

        /** True when an undo is possible: the head was applied (the base is never undone). */
        public boolean undoable() { return stack.size() > 1; }
    }

    /** The latest head moved since the caller looked (callers answer 409 and show the real head). */
    public static final class HeadMovedException extends RuntimeException {
        private final transient Event head;
        public HeadMovedException(Event head) {
            super("the lineage head is not the expected version", null, false, false);
            this.head = head;
        }
        public Event head() { return head; }
    }

    /** There is no applied version to undo. */
    public static final class NothingToUndoException extends RuntimeException {
        public NothingToUndoException() { super("the lineage head is the base version; nothing to undo", null, false, false); }
    }

    /** The requestId already recorded a different operation. */
    public static final class RequestReusedException extends RuntimeException {
        public RequestReusedException() { super("requestId already recorded a different head operation", null, false, false); }
    }

    /** The lineage exists but belongs to another principal (callers conceal this as "not found"). */
    public static final class LineageOwnershipException extends RuntimeException {
        public LineageOwnershipException() { super("lineage is not available to this principal", null, false, false); }
    }

    /** {@code replayed} is true when the requestId had already recorded exactly this operation. */
    public record Applied(Event event, HeadState state, boolean replayed) { }

    public interface HeadLedger extends AutoCloseable {
        String ledgerId();

        boolean ready();

        /**
         * Makes {@code applied} the head. When the lineage is new it is created with a BASE event for {@code base}
         * first; otherwise the current head must equal {@code base} ({@link HeadMovedException}). Idempotent by
         * {@code requestId}: the same operation again returns the recorded event with {@code replayed=true}.
         */
        Applied apply(String tenantId, String principalId, String lineageId, String requestId, String baseArtifactId,
                      String baseArtifactVersionId, String appliedArtifactId, String appliedArtifactVersionId,
                      String reportArtifactId);

        /**
         * Restores the previous head. {@code expectedHeadVersionId} must be the current head
         * ({@link HeadMovedException}); {@link NothingToUndoException} when the head is the base. Idempotent by
         * {@code requestId}.
         */
        Applied undo(String tenantId, String principalId, String lineageId, String requestId,
                     String expectedHeadVersionId);

        /** The full log, ascending; empty when the lineage does not exist or belongs to another principal. */
        List<Event> events(String tenantId, String principalId, String lineageId);

        @Override void close();
    }

    public interface HeadLedgerFactory {
        String factoryId();

        HeadLedger createDevOnly(Map<String, String> environment);
    }

    /**
     * Pure decision procedure shared by every implementation: given the current log, either returns the events to
     * append (with their seq) or the idempotent replay of an event already recorded for the requestId.
     */
    public static final class Planner {
        private Planner() { }

        public record Plan(List<Event> toAppend, Event recorded, boolean replayed) { }

        public static Plan apply(List<Event> log, String tenantId, String principalId, String lineageId, String requestId,
                                 String baseArtifactId, String baseVersion, String artifactId, String version,
                                 String reportArtifactId, Instant now) {
            ownership(log, principalId);
            for (Event event : log) {
                if (event.requestId().equals(requestId)) {
                    if (event.kind() == Kind.APPLY && event.artifactVersionId().equals(version)
                            && event.artifactId().equals(artifactId)) {
                        return new Plan(List.of(), event, true);
                    }
                    throw new RequestReusedException();
                }
            }
            List<Event> add = new ArrayList<>();
            int seq = log.isEmpty() ? 1 : log.getLast().seq() + 1;
            if (log.isEmpty()) {
                add.add(new Event(tenantId, principalId, lineageId, seq++, Kind.BASE, requestId + ".base", baseArtifactId,
                        baseVersion, null, null, now));
            } else {
                Event head = HeadState.of(log).head().orElseThrow();
                if (!head.artifactVersionId().equals(baseVersion)) throw new HeadMovedException(head);
            }
            add.add(new Event(tenantId, principalId, lineageId, seq, Kind.APPLY, requestId, artifactId, version,
                    reportArtifactId, null, now));
            return new Plan(add, null, false);
        }

        public static Plan undo(List<Event> log, String tenantId, String principalId, String lineageId,
                                String requestId, String expectedHeadVersion, Instant now) {
            if (log.isEmpty()) throw new LineageOwnershipException();
            ownership(log, principalId);
            HeadState state = HeadState.of(log);
            for (Event event : log) {
                if (event.requestId().equals(requestId)) {
                    if (event.kind() == Kind.UNDO) {
                        Event undone = log.stream().filter(e -> e.seq() == event.undoesSeq()).findFirst().orElseThrow();
                        if (undone.artifactVersionId().equals(expectedHeadVersion)) return new Plan(List.of(), event, true);
                    }
                    throw new RequestReusedException();
                }
            }
            Event head = state.head().orElseThrow();
            if (!head.artifactVersionId().equals(expectedHeadVersion)) throw new HeadMovedException(head);
            if (!state.undoable()) throw new NothingToUndoException();
            return new Plan(List.of(new Event(tenantId, principalId, lineageId, log.getLast().seq() + 1, Kind.UNDO,
                    requestId, head.artifactId(), head.artifactVersionId(), null, head.seq(), now)), null, false);
        }

        private static void ownership(List<Event> log, String principalId) {
            if (!log.isEmpty() && !log.getFirst().principalId().equals(principalId)) throw new LineageOwnershipException();
        }
    }
}
