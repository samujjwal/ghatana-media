package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaErasureContracts.ErasureAuthority;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureOperation;
import com.ghatana.media.runtime.MediaErasureContracts.ErasurePlan;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureReceipt;
import com.ghatana.media.runtime.MediaErasureContracts.LegalHold;
import com.ghatana.media.runtime.MediaErasureContracts.LocalWork;
import com.ghatana.media.runtime.MediaErasureContracts.Phase;
import com.ghatana.media.runtime.MediaErasureContracts.ReceiptItem;
import com.ghatana.media.runtime.MediaErasureContracts.Tombstone;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The fixed order of an erasure (database, objects, host-local copies, receipt) and its resumption, over a recording
 * authority: a failure of any local copy leaves the operation incomplete (no receipt is finalised) and the next start
 * finishes it; an already-completed operation is never redone.
 */
class MediaDevErasureRuntimeOrderingTest {
    private static final String TENANT = "tenant-a";
    private static final String PRINCIPAL = "test-principal-owner";

    private static final class Recording implements ErasureAuthority {
        final List<String> calls = new ArrayList<>();
        final List<ErasureOperation> open = new ArrayList<>();
        Phase phase = Phase.DB_ERASED;
        List<ReceiptItem> completedWith;

        ErasureOperation operation(Phase at) {
            return new ErasureOperation(TENANT, "e-1", PRINCIPAL, "root", at,
                    new LocalWork(List.of("root", "child"), List.of("d".repeat(64)), List.of()), false);
        }

        @Override public String authorityId() { return "recording"; }
        @Override public boolean ready() { return true; }
        @Override public ErasurePlan plan(String t, String p, String a) { throw new UnsupportedOperationException(); }
        @Override public LegalHold placeHold(String t, String p, String r, String a, String reason, AssuranceSource s) { throw new UnsupportedOperationException(); }
        @Override public LegalHold releaseHold(String t, String p, String h, String r, AssuranceSource s) { throw new UnsupportedOperationException(); }
        @Override public Optional<LegalHold> hold(String t, String p, String h) { return Optional.empty(); }
        @Override public List<LegalHold> holds(String t, String p, String a) { return List.of(); }
        @Override public ErasureOperation begin(String t, String p, String id, String a, AssuranceSource s) {
            calls.add("begin");
            return operation(phase);
        }
        @Override public ErasureOperation eraseObjects(ErasureOperation operation) {
            calls.add("objects");
            phase = Phase.OBJECTS_ERASED;
            return operation(Phase.OBJECTS_ERASED);
        }
        @Override public ErasureReceipt complete(ErasureOperation operation, List<ReceiptItem> localItems) {
            calls.add("complete");
            completedWith = localItems;
            phase = Phase.COMPLETED;
            open.clear();
            return new ErasureReceipt("e-1", "root", Phase.COMPLETED, PRINCIPAL, Instant.EPOCH, Instant.EPOCH, localItems);
        }
        @Override public Optional<ErasureReceipt> receipt(String t, String p, String id) {
            return phase == Phase.COMPLETED ? Optional.of(new ErasureReceipt("e-1", "root", Phase.COMPLETED, PRINCIPAL,
                    Instant.EPOCH, Instant.EPOCH, completedWith == null ? List.of() : completedWith)) : Optional.empty();
        }
        @Override public List<ErasureOperation> incomplete() { return List.copyOf(open); }
        @Override public Optional<Tombstone> tombstone(String t, String a) { return Optional.empty(); }
        @Override public void close() { }
    }

    private static MediaDevErasureRuntime.LocalCopyEraser eraser(String kind, List<String> log, List<String> removed, boolean fail) {
        return new MediaDevErasureRuntime.LocalCopyEraser() {
            @Override public String kind() { return kind; }
            @Override public List<String> erase(String tenantId, LocalWork work) {
                log.add(kind + ":" + tenantId + ":" + work.artifactIds());
                if (fail) throw new IllegalStateException("local copy could not be removed");
                return removed;
            }
        };
    }

    @Test
    void theOrderIsDatabaseThenObjectsThenLocalCopiesThenTheReceiptWithOnlyNonEmptyLocalKinds() {
        Recording authority = new Recording();
        List<String> log = new ArrayList<>();
        MediaDevErasureRuntime runtime = new MediaDevErasureRuntime(authority, List.of(
                eraser("LOCAL_SPOOL_ENTRY", log, List.of("a".repeat(64)), false),
                eraser("DELIVERED_OBJECT", log, List.of(), false),
                MediaDevErasureRuntime.tenantCacheEraser(tenant -> log.add("cache:" + tenant))), "");

        ErasureReceipt receipt = runtime.erase(TENANT, PRINCIPAL, "e-1", "root", AssuranceSource.DEV_ISSUED);

        assertThat(authority.calls).containsExactly("begin", "objects", "complete");
        assertThat(log).containsExactly("LOCAL_SPOOL_ENTRY:tenant-a:[root, child]", "DELIVERED_OBJECT:tenant-a:[root, child]",
                "cache:tenant-a");
        assertThat(receipt.items()).extracting(ReceiptItem::kind).containsExactly("LOCAL_SPOOL_ENTRY", "CACHE_TENANT_INVALIDATION");
        assertThat(receipt.items().getFirst().digests()).containsExactly("a".repeat(64));
        assertThat(receipt.items().get(1).digests()).as("a non-digest marker is never reported as a digest").isEmpty();
    }

    @Test
    void aFailingLocalCopyLeavesTheOperationIncompleteAndAStartupResumeFinishesItWithoutRedoingTheDatabaseStep() {
        Recording authority = new Recording();
        List<String> log = new ArrayList<>();
        boolean[] fail = {true};
        MediaDevErasureRuntime.LocalCopyEraser flaky = new MediaDevErasureRuntime.LocalCopyEraser() {
            @Override public String kind() { return "LOCAL_SPOOL_ENTRY"; }
            @Override public List<String> erase(String tenantId, LocalWork work) {
                log.add("spool");
                if (fail[0]) throw new IllegalStateException("disk error");
                return List.of("b".repeat(64));
            }
        };
        MediaDevErasureRuntime runtime = new MediaDevErasureRuntime(authority, List.of(flaky), "");

        assertThatThrownBy(() -> runtime.erase(TENANT, PRINCIPAL, "e-1", "root", AssuranceSource.DEV_ISSUED))
                .isInstanceOf(IllegalStateException.class);
        assertThat(authority.calls).as("the receipt was not finalised").containsExactly("begin", "objects");
        assertThat(authority.phase).isEqualTo(Phase.OBJECTS_ERASED);

        // The next start finds the operation incomplete and finishes it: only the local copies and the receipt remain.
        fail[0] = false;
        authority.open.add(authority.operation(Phase.OBJECTS_ERASED));
        assertThat(runtime.resumeIncomplete()).isEqualTo(1);
        assertThat(authority.calls).containsExactly("begin", "objects", "complete");
        assertThat(authority.completedWith).extracting(ReceiptItem::kind).containsExactly("LOCAL_SPOOL_ENTRY");
        assertThat(runtime.resumeIncomplete()).as("nothing left to resume").isZero();
    }

    @Test
    void aResumeThatFailsIsReportedNotThrownAndTheOperationStaysIncomplete() {
        Recording authority = new Recording();
        authority.open.add(authority.operation(Phase.DB_ERASED));
        MediaDevErasureRuntime runtime = new MediaDevErasureRuntime(authority, List.of(
                eraser("LOCAL_SPOOL_ENTRY", new ArrayList<>(), List.of(), true)), "");
        assertThat(runtime.resumeIncomplete()).isZero();
        assertThat(authority.open).hasSize(1);
        assertThat(authority.calls).containsExactly("objects");
    }

    @Test
    void aCompletedOperationReturnsItsReceiptAndRunsNothingAgain() {
        Recording authority = new Recording();
        authority.phase = Phase.COMPLETED;
        authority.completedWith = List.of(new ReceiptItem("RENDER", 1, List.of("c".repeat(64))));
        List<String> log = new ArrayList<>();
        MediaDevErasureRuntime runtime = new MediaDevErasureRuntime(authority, List.of(eraser("LOCAL_SPOOL_ENTRY", log, List.of("x"), false)), "");

        ErasureReceipt receipt = runtime.erase(TENANT, PRINCIPAL, "e-1", "root", AssuranceSource.DEV_ISSUED);

        assertThat(receipt.items()).extracting(ReceiptItem::kind).containsExactly("RENDER");
        assertThat(authority.calls).containsExactly("begin");
        assertThat(log).isEmpty();
        assertThat(Map.of("k", 1)).isNotEmpty();
    }
}
