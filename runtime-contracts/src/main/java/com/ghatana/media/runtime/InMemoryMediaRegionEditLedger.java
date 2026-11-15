package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Appended;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Kind;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.LineageExistsException;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Proposal;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.RegionEditLedger;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.StaleHeadException;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Version;

import java.time.Clock;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Process-local region edit ledger for tests and explicitly non-durable runs; it loses everything on restart. */
public final class InMemoryMediaRegionEditLedger implements RegionEditLedger {
    private final Clock clock;
    private final Map<String, List<Version>> lineages = new HashMap<>();
    private boolean closed;

    public InMemoryMediaRegionEditLedger() { this(Clock.systemUTC()); }

    public InMemoryMediaRegionEditLedger(Clock clock) { this.clock = Objects.requireNonNull(clock, "clock"); }

    @Override public String ledgerId() { return "in-memory-region-edit-ledger"; }

    @Override public synchronized boolean ready() { return !closed; }

    private static String key(String tenantId, String lineageId) { return tenantId + '\u0000' + lineageId; }

    @Override
    public synchronized Appended createLineage(String tenantId, String principalId, String lineageId, String requestId,
                                               String artifactId, String artifactVersionId, String contentSha256,
                                               long sizeBytes, String detailJson) {
        ensureOpen();
        List<Version> existing = lineages.get(key(tenantId, lineageId));
        if (existing != null) {
            Version base = existing.get(0);
            if (!base.principalId().equals(principalId) || !base.artifactVersionId().equals(artifactVersionId)
                    || !base.artifactId().equals(artifactId)) {
                throw new LineageExistsException();
            }
            return new Appended(base, true);
        }
        Version base = new Version(tenantId, principalId, lineageId, 1, Kind.BASE, requestId, artifactId,
                artifactVersionId, contentSha256, sizeBytes, null, null, null, null, detailJson, clock.instant());
        lineages.put(key(tenantId, lineageId), new ArrayList<>(List.of(base)));
        return new Appended(base, false);
    }

    @Override
    public synchronized Appended append(String tenantId, String principalId, String lineageId, int expectedHead,
                                        Proposal proposal) {
        ensureOpen();
        List<Version> rows = lineages.get(key(tenantId, lineageId));
        if (rows == null || !rows.get(0).principalId().equals(principalId)) {
            throw new IllegalStateException("lineage does not exist for this principal");
        }
        for (Version version : rows) {
            if (version.requestId().equals(proposal.requestId())) return new Appended(version, true);
        }
        int head = rows.get(rows.size() - 1).versionNumber();
        if (head != expectedHead) throw new StaleHeadException(expectedHead, head);
        Version next = new Version(tenantId, principalId, lineageId, head + 1, proposal.kind(), proposal.requestId(),
                proposal.artifactId(), proposal.artifactVersionId(), proposal.contentSha256(), proposal.sizeBytes(),
                proposal.manifestArtifactId(), proposal.manifestArtifactVersionId(), head,
                proposal.restoresVersionNumber(), proposal.detailJson(), clock.instant());
        rows.add(next);
        return new Appended(next, false);
    }

    @Override
    public synchronized List<Version> versions(String tenantId, String principalId, String lineageId) {
        ensureOpen();
        List<Version> rows = lineages.get(key(tenantId, lineageId));
        return rows == null || !rows.get(0).principalId().equals(principalId) ? List.of() : List.copyOf(rows);
    }

    private void ensureOpen() {
        if (closed) throw new IllegalStateException("region edit ledger is closed");
    }

    @Override public synchronized void close() { closed = true; }
}
