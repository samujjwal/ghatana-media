package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.ClaimResult;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalAction;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalOutcome;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.RequestIdentity;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * AT-05 durable backing: real filesystem persistence for the invocation
 * ledger — claim fencing, CAS completion, restart survival, corrupt-record
 * fail-closed behavior and identity-mismatch rejection.
 */
class FileInvocationLedgerTest {

    @TempDir Path dir;

    private static RequestIdentity identity(String toolId, String fingerprint) {
        return new RequestIdentity(toolId, "1.0.0", "caller-agent", "rel-1",
                "tenant-1", ToolActionClass.CALL_EXTERNAL, "1.0", fingerprint, true);
    }

    private static LogicalAction fence(String invocationId, RequestIdentity identity) {
        return new LogicalAction(invocationId, identity, LogicalOutcome.OUTCOME_UNKNOWN, null);
    }

    private static LogicalAction terminal(String invocationId, RequestIdentity identity) {
        ToolExecutionResult result = ToolExecutionResult.succeeded(invocationId,
                Map.of("transcript", "hello"), Map.of("providerCalls", 1),
                "corr-1", Instant.parse("2026-01-01T00:00:00Z"), Duration.ofMillis(5));
        return new LogicalAction(invocationId, identity, LogicalOutcome.SUCCESS, result);
    }

    @Test
    void claimPersistsFenceAndDuplicateClaimIsRejected() {
        FileInvocationLedger ledger = new FileInvocationLedger(dir);
        LogicalAction fence = fence("inv-1", identity("stt", "fp-1"));

        assertThat(ledger.claim(fence)).isEqualTo(ClaimResult.CLAIMED);
        assertThat(ledger.claim(fence)).isEqualTo(ClaimResult.ALREADY_CLAIMED);
        assertThat(ledger.find("inv-1")).hasValueSatisfying(found -> {
            assertThat(found.outcome()).isEqualTo(LogicalOutcome.OUTCOME_UNKNOWN);
            assertThat(found.result()).isNull();
            assertThat(found.requestIdentity()).isEqualTo(fence.requestIdentity());
        });
    }

    @Test
    void independentInvocationsClaimIndependently() {
        FileInvocationLedger ledger = new FileInvocationLedger(dir);
        assertThat(ledger.claim(fence("inv-a", identity("stt", "fp-a")))).isEqualTo(ClaimResult.CLAIMED);
        assertThat(ledger.claim(fence("inv-b", identity("tts", "fp-b")))).isEqualTo(ClaimResult.CLAIMED);
        assertThat(ledger.find("inv-a")).isPresent();
        assertThat(ledger.find("inv-b")).isPresent();
    }

    @Test
    void completeReplacesExactFenceWithTerminalResult() {
        FileInvocationLedger ledger = new FileInvocationLedger(dir);
        RequestIdentity id = identity("stt", "fp-1");
        ledger.claim(fence("inv-1", id));

        assertThat(ledger.complete(terminal("inv-1", id))).isTrue();
        assertThat(ledger.find("inv-1")).hasValueSatisfying(found -> {
            assertThat(found.outcome()).isEqualTo(LogicalOutcome.SUCCESS);
            assertThat(found.result()).isNotNull();
            assertThat(found.result().status().name()).isEqualTo("SUCCESS");
            assertThat(found.result().invocationId()).isEqualTo("inv-1");
        });
        // Terminal record is final: a second completion cannot overwrite it.
        assertThat(ledger.complete(terminal("inv-1", id))).isFalse();
    }

    @Test
    void completeRejectsAbsentMismatchedAndNonFenceRecords() {
        FileInvocationLedger ledger = new FileInvocationLedger(dir);
        RequestIdentity id = identity("stt", "fp-1");

        assertThat(ledger.complete(terminal("missing", id))).isFalse();

        ledger.claim(fence("inv-1", id));
        RequestIdentity other = identity("stt", "fp-DIFFERENT");
        assertThat(ledger.complete(terminal("inv-1", other))).isFalse();
        assertThat(ledger.find("inv-1")).hasValueSatisfying(f ->
                assertThat(f.outcome()).isEqualTo(LogicalOutcome.OUTCOME_UNKNOWN));
    }

    @Test
    void recordsSurviveRestart() {
        FileInvocationLedger first = new FileInvocationLedger(dir);
        RequestIdentity id = identity("stt", "fp-1");
        first.claim(fence("inv-1", id));
        first.complete(terminal("inv-1", id));
        first.claim(fence("inv-2", identity("vision", "fp-2")));

        // A fresh instance over the same directory simulates process restart.
        FileInvocationLedger restarted = new FileInvocationLedger(dir);
        assertThat(restarted.find("inv-1")).hasValueSatisfying(f ->
                assertThat(f.outcome()).isEqualTo(LogicalOutcome.SUCCESS));
        assertThat(restarted.find("inv-2")).hasValueSatisfying(f ->
                assertThat(f.outcome()).isEqualTo(LogicalOutcome.OUTCOME_UNKNOWN));
        // The fence still blocks redispatch after restart.
        assertThat(restarted.claim(fence("inv-2", identity("vision", "fp-2"))))
                .isEqualTo(ClaimResult.ALREADY_CLAIMED);
    }

    @Test
    void recordUpsertsAndFindRoundTrips() {
        FileInvocationLedger ledger = new FileInvocationLedger(dir);
        RequestIdentity id = identity("mm", "fp-mm");
        ledger.record(terminal("inv-r", id));
        ledger.record(fence("inv-r", id));
        assertThat(ledger.find("inv-r")).hasValueSatisfying(f ->
                assertThat(f.outcome()).isEqualTo(LogicalOutcome.OUTCOME_UNKNOWN));
    }

    @Test
    void corruptRecordFailsClosed() {
        FileInvocationLedger ledger = new FileInvocationLedger(dir);
        ledger.claim(fence("inv-1", identity("stt", "fp-1")));

        // Corrupt every record file in the directory.
        try (Stream<Path> files = Files.list(dir)) {
            for (Path file : files.filter(p -> p.toString().endsWith(".json")).toList()) {
                Files.writeString(file, "{not-json");
            }
        } catch (java.io.IOException e) {
            throw new AssertionError(e);
        }
        assertThatThrownBy(() -> ledger.find("inv-1"))
                .isInstanceOf(RuntimeException.class);
    }

    @Test
    void claimRejectsNonFenceAndCompleteRejectsUnknown() {
        FileInvocationLedger ledger = new FileInvocationLedger(dir);
        RequestIdentity id = identity("stt", "fp-1");
        assertThatThrownBy(() -> ledger.claim(terminal("inv-x", id)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> ledger.complete(fence("inv-y", id)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void filenamesAreDigestsNotCallerIdentity() throws Exception {
        FileInvocationLedger ledger = new FileInvocationLedger(dir);
        ledger.claim(fence("inv-sensitive-tenant-1", identity("stt", "fp")));
        try (Stream<Path> files = Files.list(dir)) {
            List<String> names = files.map(p -> p.getFileName().toString()).toList();
            assertThat(names).isNotEmpty();
            assertThat(names).noneMatch(n -> n.contains("inv-sensitive") || n.contains("tenant"));
            assertThat(names).allMatch(n -> n.endsWith(".json") || n.endsWith(".lock") || n.contains(".tmp"));
        }
    }

    @Test
    void resultRoundTripsThroughRestart() {
        FileInvocationLedger ledger = new FileInvocationLedger(dir);
        RequestIdentity id = identity("stt", "fp-1");
        ledger.claim(fence("inv-1", id));
        ToolExecutionResult rich = ToolExecutionResult.succeeded("inv-1",
                Map.of("segments", List.of(Map.of("text", "hi", "startMs", 0))),
                Map.of("providerCalls", 1, "bytes", 42),
                "corr-9", Instant.parse("2026-02-02T10:00:00Z"), Duration.ofSeconds(2));
        ledger.complete(new LogicalAction("inv-1", id, LogicalOutcome.SUCCESS, rich));

        FileInvocationLedger restarted = new FileInvocationLedger(dir);
        assertThat(restarted.find("inv-1")).hasValueSatisfying(f -> {
            ToolExecutionResult r = f.result();
            assertThat(r.status().name()).isEqualTo("SUCCESS");
            assertThat(r.policyDecision()).isEqualTo("ALLOW");
            assertThat(r.sideEffectSummary()).containsEntry("providerCalls", 1);
            assertThat(r.completedAt()).isEqualTo(Instant.parse("2026-02-02T10:00:00Z"));
            assertThat(r.executionDuration()).isEqualTo(Duration.ofSeconds(2));
            assertThat(r.correlationId()).isEqualTo("corr-9");
        });
    }
}
