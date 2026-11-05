package com.ghatana.audiovideo.adapter.ledger;

import java.nio.file.Files;
import java.nio.file.Path;

/**
 * Child-process entry point for the projection single-writer fence:
 * waits for the parent's go-file, attempts to claim the exclusive writer
 * lock, and prints CLAIMED or CONFLICT so the parent can assert exactly
 * one winner across real JVMs.
 */
public final class RunLedgerProjectionWriterClaimWorker {

    private RunLedgerProjectionWriterClaimWorker() { }

    public static void main(String[] args) throws Exception {
        Path dir = Path.of(args[0]);
        Path goFile = Path.of(args[1]);
        long deadline = System.currentTimeMillis() + 30_000;
        while (!Files.exists(goFile)) {
            if (System.currentTimeMillis() > deadline) {
                System.out.println("TIMEOUT");
                System.out.flush();
                System.exit(4);
            }
            Thread.sleep(10);
        }
        try (FileRunLedgerProjectionState ignored = FileRunLedgerProjectionState.forExclusiveWriter(dir)) {
            System.out.println("CLAIMED");
            System.out.flush();
            Thread.sleep(1_000);
        } catch (FileRunLedgerProjectionState.ProjectionWriterConflictException conflict) {
            System.out.println("CONFLICT");
            System.out.flush();
            System.exit(3);
        }
    }
}
