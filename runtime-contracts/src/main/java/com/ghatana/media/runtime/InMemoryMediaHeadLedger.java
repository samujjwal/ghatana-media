package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaHeadLedgerContracts.Applied;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.Event;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.HeadLedger;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.HeadState;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.Planner;

import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Process-local head ledger for tests and explicitly non-durable runs; it loses everything on restart. */
public final class InMemoryMediaHeadLedger implements HeadLedger {
    private final Clock clock;
    private final Map<String, List<Event>> logs = new HashMap<>();

    public InMemoryMediaHeadLedger() { this(Clock.systemUTC()); }

    public InMemoryMediaHeadLedger(Clock clock) { this.clock = Objects.requireNonNull(clock, "clock"); }

    @Override public String ledgerId() { return "in-memory-media-head-ledger"; }

    @Override public boolean ready() { return true; }

    private static String key(String tenantId, String lineageId) { return tenantId + "\u0000" + lineageId; }

    @Override
    public synchronized Applied apply(String tenantId, String principalId, String lineageId, String requestId,
                                      String baseArtifactId, String baseVersion, String artifactId, String version,
                                      String reportArtifactId) {
        List<Event> log = logs.computeIfAbsent(key(tenantId, lineageId), k -> new ArrayList<>());
        Planner.Plan plan = Planner.apply(log, tenantId, principalId, lineageId, requestId, baseArtifactId, baseVersion,
                artifactId, version, reportArtifactId, clock.instant());
        if (plan.replayed()) return new Applied(plan.recorded(), HeadState.of(log), true);
        log.addAll(plan.toAppend());
        return new Applied(log.getLast(), HeadState.of(log), false);
    }

    @Override
    public synchronized Applied undo(String tenantId, String principalId, String lineageId, String requestId,
                                     String expectedHeadVersionId) {
        List<Event> log = logs.getOrDefault(key(tenantId, lineageId), new ArrayList<>());
        Planner.Plan plan = Planner.undo(log, tenantId, principalId, lineageId, requestId, expectedHeadVersionId,
                clock.instant());
        if (plan.replayed()) return new Applied(plan.recorded(), HeadState.of(log), true);
        log.addAll(plan.toAppend());
        return new Applied(log.getLast(), HeadState.of(log), false);
    }

    @Override
    public synchronized List<Event> events(String tenantId, String principalId, String lineageId) {
        List<Event> log = logs.getOrDefault(key(tenantId, lineageId), List.of());
        return log.isEmpty() || !log.getFirst().principalId().equals(principalId) ? List.of() : List.copyOf(log);
    }

    @Override public void close() { }
}
