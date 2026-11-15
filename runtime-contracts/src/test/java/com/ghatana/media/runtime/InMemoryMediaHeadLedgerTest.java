package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaHeadLedgerContracts.Applied;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.HeadMovedException;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.Kind;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.LineageOwnershipException;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.NothingToUndoException;
import com.ghatana.media.runtime.MediaHeadLedgerContracts.RequestReusedException;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class InMemoryMediaHeadLedgerTest {
    private static final String T = "tenant";
    private static final String P = "owner";
    private static final String L = "lineage-1";
    private static final String V0 = "sha256:" + "0".repeat(64);
    private static final String V1 = "sha256:" + "1".repeat(64);
    private static final String V2 = "sha256:" + "2".repeat(64);

    private final InMemoryMediaHeadLedger ledger = new InMemoryMediaHeadLedger();

    @Test
    void applyCreatesBaseThenApplyAndUndoRestoresTheExactPreviousHeadRepeatedly() {
        Applied first = ledger.apply(T, P, L, "req-1", "a0", V0, "a1", V1, "r1");
        assertThat(first.replayed()).isFalse();
        assertThat(ledger.events(T, P, L)).extracting(e -> e.kind()).containsExactly(Kind.BASE, Kind.APPLY);
        assertThat(first.state().head().orElseThrow().artifactVersionId()).isEqualTo(V1);

        Applied second = ledger.apply(T, P, L, "req-2", "a1", V1, "a2", V2, "r2");
        assertThat(second.state().head().orElseThrow().artifactVersionId()).isEqualTo(V2);

        Applied undone = ledger.undo(T, P, L, "undo-1", V2);
        assertThat(undone.state().head().orElseThrow().artifactVersionId()).isEqualTo(V1);
        assertThat(undone.state().head().orElseThrow().artifactId()).isEqualTo("a1");
        Applied undoneAgain = ledger.undo(T, P, L, "undo-2", V1);
        assertThat(undoneAgain.state().head().orElseThrow().artifactVersionId()).isEqualTo(V0);
        assertThat(undoneAgain.state().undoable()).isFalse();
        assertThatThrownBy(() -> ledger.undo(T, P, L, "undo-3", V0)).isInstanceOf(NothingToUndoException.class);
        // The log is append-only: nothing was removed.
        assertThat(ledger.events(T, P, L)).hasSize(5);
    }

    @Test
    void operationsAreIdempotentByRequestIdAndReuseWithADifferentOperationIsRefused() {
        ledger.apply(T, P, L, "req-1", "a0", V0, "a1", V1, "r1");
        Applied replay = ledger.apply(T, P, L, "req-1", "a0", V0, "a1", V1, "r1");
        assertThat(replay.replayed()).isTrue();
        assertThat(ledger.events(T, P, L)).hasSize(2);
        assertThatThrownBy(() -> ledger.apply(T, P, L, "req-1", "a1", V1, "a2", V2, "r2"))
                .isInstanceOf(RequestReusedException.class);
        ledger.undo(T, P, L, "undo-1", V1);
        assertThat(ledger.undo(T, P, L, "undo-1", V1).replayed()).isTrue();
        assertThat(ledger.events(T, P, L)).hasSize(3);
        assertThatThrownBy(() -> ledger.undo(T, P, L, "req-1", V0)).isInstanceOf(RequestReusedException.class);
    }

    @Test
    void staleHeadsAndForeignPrincipalsAreRefused() {
        ledger.apply(T, P, L, "req-1", "a0", V0, "a1", V1, "r1");
        assertThatThrownBy(() -> ledger.apply(T, P, L, "req-2", "a0", V0, "a2", V2, "r2"))
                .isInstanceOf(HeadMovedException.class);
        assertThatThrownBy(() -> ledger.undo(T, P, L, "undo-1", V0)).isInstanceOf(HeadMovedException.class);
        assertThat(ledger.events(T, "someone-else", L)).isEmpty();
        assertThat(ledger.events("other-tenant", P, L)).isEmpty();
        assertThatThrownBy(() -> ledger.apply(T, "someone-else", L, "req-9", "a1", V1, "a2", V2, "r2"))
                .isInstanceOf(LineageOwnershipException.class);
        assertThatThrownBy(() -> ledger.undo(T, "someone-else", L, "undo-9", V1))
                .isInstanceOf(LineageOwnershipException.class);
        assertThat(ledger.events(T, P, L)).hasSize(2);
    }
}
