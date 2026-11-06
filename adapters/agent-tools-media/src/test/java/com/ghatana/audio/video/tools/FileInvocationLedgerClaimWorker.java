package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.ClaimResult;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalAction;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalOutcome;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.RequestIdentity;

import java.nio.file.Path;

/**
 * Test-only child-process entrypoint: a fresh JVM performs exactly one
 * {@link FileInvocationLedger#claim} against the given ledger directory and
 * prints the {@link ClaimResult} name on stdout. Used to prove claim
 * exclusivity across real OS processes — not only threads in one JVM.
 */
public final class FileInvocationLedgerClaimWorker {

    private FileInvocationLedgerClaimWorker() { }

    public static void main(String[] args) {
        Path directory = Path.of(args[0]);
        String invocationId = args[1];
        String fingerprint = args[2];
        FileInvocationLedger ledger = FileInvocationLedgerTest.ledger(directory);
        RequestIdentity identity = new RequestIdentity("stt", "1.0.0", "caller-agent",
                "rel-1", "tenant-1", ToolActionClass.CALL_EXTERNAL, "1.0", fingerprint, true);
        ClaimResult result = ledger.claim(
                new LogicalAction(invocationId, identity, LogicalOutcome.OUTCOME_UNKNOWN, null));
        // The process exits without completing: the durable fence must remain
        // authoritative for any later process (crash-after-claim semantics).
        System.out.println(result.name());
    }
}
