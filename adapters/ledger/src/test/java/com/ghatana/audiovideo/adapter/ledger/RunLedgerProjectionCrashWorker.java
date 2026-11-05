package com.ghatana.audiovideo.adapter.ledger;

import com.ghatana.datacloud.delivery.ledger.RunLedger;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Test-only child-process entrypoint: loads a durable
 * {@link FileRunLedgerProjectionState} and calls
 * {@link RunLedgerProjection#project} on the candidate record supplied as a
 * JSON file. The JVM halts inside the store callback — the ambiguous point
 * where the external effect may or may not have committed — so the parent
 * test can prove the pre-dispatch uncertainty fence survived the crash and
 * blocks any redispatch until authoritative readback reconciliation.
 */
public final class RunLedgerProjectionCrashWorker {

    private RunLedgerProjectionCrashWorker() { }

    public static void main(String[] args) throws Exception {
        Path stateDir = Path.of(args[0]);
        Path candidateFile = Path.of(args[1]);
        int haltCode = Integer.parseInt(args[2]);
        RunLedger candidate = RunLedgerJson.decode(
                Files.readString(candidateFile, StandardCharsets.UTF_8));
        FileRunLedgerProjectionState backing = new FileRunLedgerProjectionState(stateDir);
        RunLedgerProjection projection = new RunLedgerProjection(record -> {
            // Effect boundary: the durable fence is already persisted before
            // this point. Halting here simulates a crash with unknown store
            // outcome — no acknowledgement reaches the caller.
            Runtime.getRuntime().halt(haltCode);
        }, backing);
        projection.project(candidate);
    }
}
