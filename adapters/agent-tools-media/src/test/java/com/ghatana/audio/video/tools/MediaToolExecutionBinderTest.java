package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalAction;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalOutcome;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.InvocationIdentityConflictException;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.InvocationClaimUnavailableException;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.InvocationReplayDeniedException;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.OutcomeUnknownException;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.tools.testing.EventloopTestBase;
import io.activej.promise.Promise;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * AT-05/06: one logical action per invocation — same-key replay preserves the
 * recorded outcome, ambiguous dispatch stays OUTCOME_UNKNOWN and is never
 * blindly retried, and every registered tool id resolves a real handler.
 */
class MediaToolExecutionBinderTest extends EventloopTestBase {

    private static final class InMemoryLedger implements MediaToolExecutionBinder.InvocationLedger {
        private final Map<String, LogicalAction> records = new HashMap<>();
        private final boolean loseCompletionAcknowledgment;
        private final boolean loseClaimAcknowledgment;
        private final CountDownLatch alreadyClaimed;
        private final AtomicInteger claimAttempts = new AtomicInteger();

        private InMemoryLedger() { this(false, null, false); }
        private InMemoryLedger(boolean loseCompletionAcknowledgment) {
            this(loseCompletionAcknowledgment, null, false);
        }
        private InMemoryLedger(boolean loseCompletionAcknowledgment, CountDownLatch alreadyClaimed) {
            this(loseCompletionAcknowledgment, alreadyClaimed, false);
        }
        private InMemoryLedger(boolean loseCompletionAcknowledgment, CountDownLatch alreadyClaimed,
                boolean loseClaimAcknowledgment) {
            this.loseCompletionAcknowledgment = loseCompletionAcknowledgment;
            this.alreadyClaimed = alreadyClaimed;
            this.loseClaimAcknowledgment = loseClaimAcknowledgment;
        }

        @Override public synchronized Optional<LogicalAction> find(String invocationId) {
            return Optional.ofNullable(records.get(invocationId));
        }
        @Override public synchronized void record(LogicalAction action) {
            records.put(action.invocationId(), action);
        }
        @Override public synchronized MediaToolExecutionBinder.ClaimResult claim(LogicalAction fence) {
            claimAttempts.incrementAndGet();
            if (records.putIfAbsent(fence.invocationId(), fence) != null) {
                if (alreadyClaimed != null) alreadyClaimed.countDown();
                return MediaToolExecutionBinder.ClaimResult.ALREADY_CLAIMED;
            }
            return loseClaimAcknowledgment
                    ? MediaToolExecutionBinder.ClaimResult.UNAVAILABLE
                    : MediaToolExecutionBinder.ClaimResult.CLAIMED;
        }
        private int claimAttempts() { return claimAttempts.get(); }
        @Override public synchronized boolean complete(LogicalAction terminal) {
            LogicalAction current = records.get(terminal.invocationId());
            if (current == null || current.outcome() != LogicalOutcome.OUTCOME_UNKNOWN
                    || !current.requestIdentity().equals(terminal.requestIdentity())) return false;
            records.put(terminal.invocationId(), terminal);
            return !loseCompletionAcknowledgment;
        }
    }

    private static ToolExecutionEnvelope envelope(String toolId) {
        return ToolExecutionEnvelope.of(
                toolId, "1.0.0", "caller-agent", null,
                "tenant-1", ToolActionClass.CALL_EXTERNAL, "1.0", Map.of());
    }

    private static ToolContract contractFor(ToolExecutionEnvelope envelope) {
        return new ToolContract(envelope.toolId(), envelope.toolVersion(), "Test", "d",
                envelope.actionClass(), false, true, Map.of(), Map.of(), java.util.Set.of(),
                ToolTransport.IN_PROCESS, null, Map.of());
    }

    private static ToolExecutionEnvelope sameInvocationAs(
            ToolExecutionEnvelope source, String tenantId, String callerAgentId) {
        return new ToolExecutionEnvelope(source.invocationId(), source.toolId(), source.toolVersion(),
                callerAgentId, source.callerReleaseId(), tenantId, source.actionClass(),
                source.requestSchemaVersion(), source.input(), source.requestedAt());
    }

    private static ToolExecutionEnvelope withInput(ToolExecutionEnvelope source, Map<String, Object> input) {
        return new ToolExecutionEnvelope(source.invocationId(), source.toolId(), source.toolVersion(),
                source.callerAgentId(), source.callerReleaseId(), source.tenantId(), source.actionClass(),
                source.requestSchemaVersion(), input, source.requestedAt());
    }

    private static ToolExecutionEnvelope variant(ToolExecutionEnvelope source, String toolId, String toolVersion,
            String callerAgentId, String callerReleaseId, ToolActionClass actionClass,
            String schemaVersion, Map<String, Object> input) {
        return new ToolExecutionEnvelope(source.invocationId(), toolId, toolVersion, callerAgentId,
                callerReleaseId, source.tenantId(), actionClass, schemaVersion, input, source.requestedAt());
    }

    private static MediaToolExecutionBinder binder(
            InMemoryLedger ledger, Map<String, String> durableJobs) {
        return new MediaToolExecutionBinder(ledger,
                (tenant, invocation) -> Optional.ofNullable(durableJobs.get(invocation)),
                (authenticated, identity) -> authenticated.tenantId().equals(identity.tenantId())
                        && authenticated.principalId().equals(identity.callerAgentId()));
    }

    private static Promise<ToolExecutionResult> authenticatedReplay(MediaToolExecutionBinder binder,
            com.ghatana.toolruntime.ToolHandler delegate, ToolExecutionEnvelope envelope) {
        AuthenticatedPrincipal principal = new AuthenticatedPrincipal(
                envelope.tenantId(), envelope.callerAgentId(), Instant.now());
        return binder.execute(delegate, envelope, contractFor(envelope), principal);
    }

    @Test
    void sameInvocationIdReturnsOneLogicalAction() {
        InMemoryLedger ledger = new InMemoryLedger();
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope("av.speech-to-text");
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(
                    e.invocationId(), Map.of("transcript", "hello"), Map.of(),
                    e.invocationId(), Instant.now(), Duration.ZERO));
        };

        ToolExecutionResult first = runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope)));
        assertThat(first.status()).isEqualTo(ToolExecutionStatus.SUCCESS);

        // Replay returns the recorded result — no second dispatch.
        ToolExecutionResult replay = runPromise(() -> authenticatedReplay(binder, delegate, envelope));
        assertThat(replay).isSameAs(first);
        assertThat(dispatches.get()).isEqualTo(1);
    }

    @Test
    void resultReplayRequiresFreshAuthenticatedPrincipalAndHostAuthorization() {
        InMemoryLedger ledger = new InMemoryLedger();
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope("av.speech-to-text");
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(e.invocationId(),
                    Map.of("transcript", "actor-private"), Map.of(), e.invocationId(), Instant.now(), Duration.ZERO));
        };

        runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope)));
        assertThatThrownBy(() -> runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope))))
                .isInstanceOf(InvocationReplayDeniedException.class)
                .hasMessageNotContaining("actor-private");
        AuthenticatedPrincipal otherActor = new AuthenticatedPrincipal(
                envelope.tenantId(), "different-principal", Instant.now());
        assertThatThrownBy(() -> runPromise(() -> binder.execute(
                delegate, envelope, contractFor(envelope), otherActor)))
                .isInstanceOf(InvocationReplayDeniedException.class)
                .hasMessageNotContaining("actor-private");
        AuthenticatedPrincipal otherTenant = new AuthenticatedPrincipal(
                "tenant-other", envelope.callerAgentId(), Instant.now());
        assertThatThrownBy(() -> runPromise(() -> binder.execute(
                delegate, envelope, contractFor(envelope), otherTenant)))
                .isInstanceOf(InvocationReplayDeniedException.class)
                .hasMessageNotContaining("actor-private");
        ToolExecutionResult authorized = runPromise(() -> authenticatedReplay(binder, delegate, envelope));
        assertThat(authorized.output().toString()).contains("actor-private");
        assertThat(dispatches.get()).isEqualTo(1);
    }

    @Test
    void sameInvocationIdCannotReplayResultAcrossTenantOrCallerAgent() {
        InMemoryLedger ledger = new InMemoryLedger();
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope original = envelope("av.speech-to-text");
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(
                    e.invocationId(), Map.of("transcript", "tenant-private-result"), Map.of(),
                    e.invocationId(), Instant.now(), Duration.ZERO));
        };

        runPromise(() -> binder.execute(delegate, original, contractFor(original)));

        ToolExecutionEnvelope otherTenant = sameInvocationAs(original, "tenant-other", "caller-agent");
        ToolExecutionEnvelope otherAgent = sameInvocationAs(original, original.tenantId(), "caller-other");
        for (ToolExecutionEnvelope foreign : java.util.List.of(otherTenant, otherAgent)) {
            assertThatThrownBy(() -> runPromise(() ->
                    binder.execute(delegate, foreign, contractFor(foreign))))
                    .isInstanceOf(InvocationIdentityConflictException.class)
                    .hasMessageNotContaining("tenant-private-result");
        }
        assertThat(dispatches.get()).isEqualTo(1);
    }

    @Test
    void foreignTenantCannotProbeUnknownInvocationReadbackOrRedispatch() {
        InMemoryLedger ledger = new InMemoryLedger();
        AtomicInteger readbacks = new AtomicInteger();
        AtomicInteger dispatches = new AtomicInteger();
        var binder = new MediaToolExecutionBinder(ledger, (tenant, invocation) -> {
            readbacks.incrementAndGet();
            return Optional.of("RUNNING");
        });
        ToolExecutionEnvelope original = envelope("av.vision-analysis");
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.ofException(new IllegalStateException("ambiguous provider response"));
        };

        assertThatThrownBy(() -> runPromise(() ->
                binder.execute(delegate, original, contractFor(original))))
                .isInstanceOf(OutcomeUnknownException.class);
        int readbacksForOriginal = readbacks.get();
        ToolExecutionEnvelope foreign = sameInvocationAs(original, "tenant-other", "caller-agent");
        assertThatThrownBy(() -> runPromise(() ->
                binder.execute(delegate, foreign, contractFor(foreign))))
                .isInstanceOf(InvocationIdentityConflictException.class);

        assertThat(dispatches.get()).isEqualTo(1);
        assertThat(readbacks.get()).isEqualTo(readbacksForOriginal);
    }

    @Test
    void ambiguousDispatchStaysUnknownAndReplayNeverRedispatches() {
        InMemoryLedger ledger = new InMemoryLedger();
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope("av.vision-analysis");
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.ofException(new IllegalStateException("transport dropped after dispatch"));
        };

        assertThatThrownBy(() -> runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope))))
                .isInstanceOf(OutcomeUnknownException.class);
        assertThat(ledger.find(envelope.invocationId())).hasValueSatisfying(action ->
                assertThat(action.outcome()).isEqualTo(LogicalOutcome.OUTCOME_UNKNOWN));

        // A replay after the unknown effect must not invoke the delegate again.
        assertThatThrownBy(() -> runPromise(() -> authenticatedReplay(binder, delegate, envelope)))
                .isInstanceOf(OutcomeUnknownException.class)
                .satisfies(thrown -> assertThat(((OutcomeUnknownException) thrown).invocationId())
                        .isEqualTo(envelope.invocationId()));
        assertThat(dispatches.get()).isEqualTo(1);
    }

    @Test
    void changedInputCannotReuseInvocationClaim() {
        InMemoryLedger ledger = new InMemoryLedger();
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope original = envelope("av.speech-to-text");
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(
                    e.invocationId(), Map.of("transcript", "safe"), Map.of(),
                    e.invocationId(), Instant.now(), Duration.ZERO));
        };
        runPromise(() -> binder.execute(delegate, original, contractFor(original)));

        ToolExecutionEnvelope changed = withInput(original, Map.of("different", "request"));
        var changedVariants = java.util.List.of(
                changed,
                variant(original, original.toolId(), "2.0.0", original.callerAgentId(),
                        original.callerReleaseId(), original.actionClass(), original.requestSchemaVersion(), original.input()),
                variant(original, original.toolId(), original.toolVersion(), original.callerAgentId(),
                        "release-other", original.actionClass(), original.requestSchemaVersion(), original.input()),
                variant(original, original.toolId(), original.toolVersion(), original.callerAgentId(),
                        original.callerReleaseId(), ToolActionClass.READ, original.requestSchemaVersion(), original.input()),
                variant(original, original.toolId(), original.toolVersion(), original.callerAgentId(),
                        original.callerReleaseId(), original.actionClass(), "2.0", original.input()),
                variant(original, "av.vision-analysis", original.toolVersion(), original.callerAgentId(),
                        original.callerReleaseId(), original.actionClass(), original.requestSchemaVersion(), original.input()));
        for (ToolExecutionEnvelope variant : changedVariants) {
            assertThatThrownBy(() -> runPromise(() -> binder.execute(delegate, variant, contractFor(variant))))
                    .isInstanceOf(InvocationIdentityConflictException.class);
        }
        assertThat(dispatches.get()).isEqualTo(1);
    }

    @Test
    void inputFingerprintIsMapOrderStableAndDoesNotPersistPlaintext() {
        InMemoryLedger ledger = new InMemoryLedger();
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope empty = envelope("av.speech-to-text");
        Map<String, Object> ordered = new LinkedHashMap<>();
        ordered.put("secret", "sensitive-input-marker");
        ordered.put("count", 1);
        ToolExecutionEnvelope original = withInput(empty, ordered);
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(e.invocationId(), Map.of("ok", true), Map.of(),
                    e.invocationId(), Instant.now(), Duration.ZERO));
        };
        ToolExecutionResult first = runPromise(() -> binder.execute(delegate, original, contractFor(original)));
        assertThat(ledger.find(original.invocationId()).orElseThrow().toString())
                .doesNotContain("sensitive-input-marker");

        Map<String, Object> reordered = new LinkedHashMap<>();
        reordered.put("count", 1);
        reordered.put("secret", "sensitive-input-marker");
        ToolExecutionEnvelope sameRequest = withInput(original, reordered);
        assertThat(runPromise(() -> authenticatedReplay(binder, delegate, sameRequest)))
                .isSameAs(first);

        ToolExecutionEnvelope differentNumberType = withInput(original, Map.of(
                "secret", "sensitive-input-marker", "count", 1L));
        assertThatThrownBy(() -> runPromise(() ->
                binder.execute(delegate, differentNumberType, contractFor(differentNumberType))))
                .isInstanceOf(InvocationIdentityConflictException.class);
        assertThat(dispatches.get()).isEqualTo(1);
    }

    @Test
    void inputFingerprintDistinguishesUnpairedSurrogateFromUtf8ReplacementAndAcceptsSupplementaryText() {
        InMemoryLedger ledger = new InMemoryLedger();
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(e.invocationId(), Map.of("ok", true), Map.of(),
                    e.invocationId(), Instant.now(), Duration.ZERO));
        };

        ToolExecutionEnvelope base = envelope("av.speech-to-text");
        String unpairedSurrogate = String.valueOf((char) 0xD800);
        ToolExecutionEnvelope malformed = withInput(base, Map.of("text", unpairedSurrogate));
        runPromise(() -> binder.execute(delegate, malformed, contractFor(malformed)));

        // UTF-8 String.getBytes replaces an unpaired surrogate with '?'; the
        // canonical fingerprint must keep the two Java strings distinct.
        ToolExecutionEnvelope replacement = withInput(base, Map.of("text", "?"));
        assertThatThrownBy(() -> runPromise(() -> binder.execute(delegate, replacement, contractFor(replacement))))
                .isInstanceOf(InvocationIdentityConflictException.class);

        ToolExecutionEnvelope keyBase = envelope("av.speech-to-text");
        Map<String, Object> malformedKeyInput = new LinkedHashMap<>();
        malformedKeyInput.put(unpairedSurrogate, "value");
        ToolExecutionEnvelope malformedKey = withInput(keyBase, malformedKeyInput);
        runPromise(() -> binder.execute(delegate, malformedKey, contractFor(malformedKey)));
        ToolExecutionEnvelope replacementKey = withInput(keyBase, Map.of("?", "value"));
        assertThatThrownBy(() -> runPromise(() ->
                binder.execute(delegate, replacementKey, contractFor(replacementKey))))
                .isInstanceOf(InvocationIdentityConflictException.class);

        ToolExecutionEnvelope supplementary = withInput(envelope("av.speech-to-text"),
                Map.of("text", new String(Character.toChars(0x1F9EA))));
        assertThat(runPromise(() -> binder.execute(delegate, supplementary, contractFor(supplementary))).status())
                .isEqualTo(ToolExecutionStatus.SUCCESS);
        assertThat(dispatches.get()).isEqualTo(3);
    }

    @Test
    void concurrentReplayDuringDispatchSeesClaimAndNeverDispatchesAgain() {
        InMemoryLedger ledger = new InMemoryLedger();
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope("av.vision-analysis");
        io.activej.promise.SettablePromise<ToolExecutionResult> provider =
                new io.activej.promise.SettablePromise<>();
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            assertThat(ledger.find(e.invocationId())).hasValueSatisfying(claim -> {
                assertThat(claim.outcome()).isEqualTo(LogicalOutcome.OUTCOME_UNKNOWN);
                assertThat(claim.result()).isNull();
            });
            return provider;
        };

        Promise<ToolExecutionResult> first = binder.execute(delegate, envelope, contractFor(envelope));
        assertThatThrownBy(() -> runPromise(() -> authenticatedReplay(binder, delegate, envelope)))
                .isInstanceOf(OutcomeUnknownException.class);
        assertThat(dispatches.get()).isEqualTo(1);

        provider.set(ToolExecutionResult.succeeded(envelope.invocationId(), Map.of(), Map.of(),
                envelope.invocationId(), Instant.now(), Duration.ZERO));
        assertThat(runPromise(() -> first).status()).isEqualTo(ToolExecutionStatus.SUCCESS);
        assertThat(ledger.find(envelope.invocationId())).hasValueSatisfying(action ->
                assertThat(action.outcome()).isEqualTo(LogicalOutcome.SUCCESS));
    }

    @Test
    void simultaneousClaimsDispatchOnlyTheAtomicWinner() throws Exception {
        CountDownLatch alreadyClaimed = new CountDownLatch(1);
        CountDownLatch ready = new CountDownLatch(2);
        CountDownLatch start = new CountDownLatch(1);
        CountDownLatch delegateEntered = new CountDownLatch(1);
        CountDownLatch releaseDelegate = new CountDownLatch(1);
        InMemoryLedger ledger = new InMemoryLedger(false, alreadyClaimed);
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope("av.vision-analysis");
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            delegateEntered.countDown();
            try {
                if (!releaseDelegate.await(2, TimeUnit.SECONDS)) throw new IllegalStateException("test timeout");
            } catch (InterruptedException interrupted) {
                Thread.currentThread().interrupt();
                throw new IllegalStateException(interrupted);
            }
            return Promise.of(ToolExecutionResult.succeeded(e.invocationId(), Map.of(), Map.of(),
                    e.invocationId(), Instant.now(), Duration.ZERO));
        };

        try (var workers = Executors.newFixedThreadPool(2)) {
            var one = workers.submit(() -> {
                ready.countDown();
                start.await();
                return authenticatedReplay(binder, delegate, envelope);
            });
            var two = workers.submit(() -> {
                ready.countDown();
                start.await();
                return authenticatedReplay(binder, delegate, envelope);
            });
            assertThat(ready.await(1, TimeUnit.SECONDS)).isTrue();
            start.countDown();
            assertThat(delegateEntered.await(1, TimeUnit.SECONDS)).isTrue();
            assertThat(alreadyClaimed.await(1, TimeUnit.SECONDS)).isTrue();
            releaseDelegate.countDown();

            Promise<ToolExecutionResult> first = one.get(1, TimeUnit.SECONDS);
            Promise<ToolExecutionResult> second = two.get(1, TimeUnit.SECONDS);
            int successes = 0;
            int unknowns = 0;
            for (Promise<ToolExecutionResult> promise : java.util.List.of(first, second)) {
                try {
                    assertThat(runPromise(() -> promise).status()).isEqualTo(ToolExecutionStatus.SUCCESS);
                    successes++;
                } catch (OutcomeUnknownException unknown) {
                    unknowns++;
                }
            }
            assertThat(successes).isEqualTo(1);
            assertThat(unknowns).isEqualTo(1);
            assertThat(dispatches.get()).isEqualTo(1);
        } finally {
            releaseDelegate.countDown();
        }
    }

    @Test
    void legacyLedgerWithoutAtomicClaimFailsClosedBeforeDispatch() {
        MediaToolExecutionBinder.InvocationLedger legacy = new MediaToolExecutionBinder.InvocationLedger() {
            @Override public Optional<LogicalAction> find(String invocationId) { return Optional.empty(); }
            @Override public void record(LogicalAction action) { }
        };
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope("av.speech-to-text");
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(e.invocationId(), Map.of(), Map.of(),
                    e.invocationId(), Instant.now(), Duration.ZERO));
        };

        assertThatThrownBy(() -> runPromise(() -> new MediaToolExecutionBinder(legacy,
                (tenant, invocation) -> Optional.empty()).execute(delegate, envelope, contractFor(envelope))))
                .isInstanceOf(InvocationClaimUnavailableException.class);
        assertThat(dispatches.get()).isZero();
    }

    @Test
    void envelopeContractMismatchFailsBeforeClaimOrDispatch() {
        InMemoryLedger ledger = new InMemoryLedger();
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope("av.speech-to-text");
        ToolContract wrongContract = contractFor(envelope("av.vision-analysis"));
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(e.invocationId(), Map.of(), Map.of(),
                    e.invocationId(), Instant.now(), Duration.ZERO));
        };

        assertThatThrownBy(() -> runPromise(() -> binder.execute(delegate, envelope, wrongContract)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("TOOL_CONTRACT_ENVELOPE_MISMATCH");
        assertThat(ledger.claimAttempts()).isZero();
        assertThat(dispatches.get()).isZero();
    }

    @Test
    void legacyUnboundActionCannotReplayAsCurrentIdentity() {
        InMemoryLedger ledger = new InMemoryLedger();
        ToolExecutionEnvelope envelope = envelope("av.speech-to-text");
        ToolExecutionResult previous = ToolExecutionResult.succeeded(envelope.invocationId(), Map.of(), Map.of(),
                envelope.invocationId(), Instant.now(), Duration.ZERO);
        ledger.record(new LogicalAction(envelope.invocationId(), envelope.toolId(),
                LogicalOutcome.SUCCESS, previous));
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(previous);
        };

        assertThatThrownBy(() -> runPromise(() -> authenticatedReplay(binder, delegate, envelope)))
                .isInstanceOf(InvocationIdentityConflictException.class);
        assertThat(dispatches.get()).isZero();
    }

    @Test
    void legacyUnknownRecordWithFailedResultLoadsButFailsReplayClosed() {
        InMemoryLedger ledger = new InMemoryLedger();
        ToolExecutionEnvelope envelope = envelope("av.speech-to-text");
        ToolExecutionResult legacyFailure = ToolExecutionResult.failed(envelope.invocationId(),
                "legacy unknown mapping", envelope.invocationId(), Instant.now(), Duration.ZERO);
        ledger.record(new LogicalAction(envelope.invocationId(), envelope.toolId(),
                LogicalOutcome.OUTCOME_UNKNOWN, legacyFailure));
        assertThat(ledger.find(envelope.invocationId()).orElseThrow().result()).isNull();
        AtomicInteger dispatches = new AtomicInteger();
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(legacyFailure);
        };

        assertThatThrownBy(() -> runPromise(() -> binder(ledger, Map.of()).execute(
                delegate, envelope, contractFor(envelope))))
                .isInstanceOf(InvocationIdentityConflictException.class);
        assertThat(dispatches.get()).isZero();
    }

    @Test
    void malformedLedgerActionForDifferentInvocationFailsClosed() {
        ToolExecutionEnvelope requested = envelope("av.speech-to-text");
        String foreignId = "foreign-invocation";
        ToolExecutionResult foreignResult = ToolExecutionResult.succeeded(foreignId, Map.of("private", true),
                Map.of(), foreignId, Instant.now(), Duration.ZERO);
        LogicalAction foreignAction = new LogicalAction(foreignId,
                MediaToolExecutionBinder.RequestIdentity.from(requested), LogicalOutcome.SUCCESS, foreignResult);
        MediaToolExecutionBinder.InvocationLedger malformed = new MediaToolExecutionBinder.InvocationLedger() {
            @Override public Optional<LogicalAction> find(String invocationId) { return Optional.of(foreignAction); }
            @Override public void record(LogicalAction action) { }
            @Override public MediaToolExecutionBinder.ClaimResult claim(LogicalAction fence) {
                return MediaToolExecutionBinder.ClaimResult.ALREADY_CLAIMED;
            }
        };
        AtomicInteger dispatches = new AtomicInteger();
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(foreignResult);
        };

        assertThatThrownBy(() -> runPromise(() -> new MediaToolExecutionBinder(malformed,
                (tenant, invocation) -> Optional.empty()).execute(
                        delegate, requested, contractFor(requested))))
                .isInstanceOf(InvocationClaimUnavailableException.class);
        assertThat(dispatches.get()).isZero();
    }

    @Test
    void logicalActionRejectsMismatchedTerminalResultAndUnknownFenceResult() {
        ToolExecutionEnvelope envelope = envelope("av.speech-to-text");
        ToolExecutionResult foreignResult = ToolExecutionResult.succeeded("another-id", Map.of(), Map.of(),
                "another-id", Instant.now(), Duration.ZERO);
        assertThatThrownBy(() -> new LogicalAction(envelope.invocationId(),
                MediaToolExecutionBinder.RequestIdentity.from(envelope), LogicalOutcome.SUCCESS, foreignResult))
                .isInstanceOf(IllegalArgumentException.class);
        ToolExecutionResult matchingResult = ToolExecutionResult.succeeded(envelope.invocationId(), Map.of(), Map.of(),
                envelope.invocationId(), Instant.now(), Duration.ZERO);
        assertThatThrownBy(() -> new LogicalAction(envelope.invocationId(),
                MediaToolExecutionBinder.RequestIdentity.from(envelope), LogicalOutcome.OUTCOME_UNKNOWN, matchingResult))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void logicalActionDiagnosticDoesNotRenderTranscriptOrRequestIdentity() {
        ToolExecutionEnvelope envelope = envelope("av.speech-to-text");
        String sensitiveTranscript = "PRIVATE_TRANSCRIPT_MARKER";
        ToolExecutionResult result = ToolExecutionResult.succeeded(envelope.invocationId(),
                Map.of("transcript", sensitiveTranscript), Map.of(), envelope.invocationId(),
                Instant.now(), Duration.ZERO);
        LogicalAction action = new LogicalAction(envelope.invocationId(),
                MediaToolExecutionBinder.RequestIdentity.from(envelope), LogicalOutcome.SUCCESS, result);

        assertThat(action.toString())
                .contains("outcome=SUCCESS", "requestIdentityPresent=true", "resultPresent=true")
                .doesNotContain(sensitiveTranscript, envelope.invocationId(), envelope.tenantId(),
                        envelope.callerAgentId());
    }

    @Test
    void unknownExceptionDoesNotEchoCallerIdentityOrUnrecognizedReadbackState() {
        InMemoryLedger ledger = new InMemoryLedger();
        ToolExecutionEnvelope random = envelope("av.vision-analysis");
        ToolExecutionEnvelope envelope = new ToolExecutionEnvelope("private-invocation-marker",
                random.toolId(), random.toolVersion(), random.callerAgentId(), random.callerReleaseId(),
                random.tenantId(), random.actionClass(), random.requestSchemaVersion(), random.input(), random.requestedAt());
        var binder = new MediaToolExecutionBinder(ledger,
                (tenant, invocation) -> Optional.of("private-state-marker"));
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) ->
                Promise.ofException(new IllegalStateException("ambiguous"));

        assertThatThrownBy(() -> runPromise(() -> authenticatedReplay(binder, delegate, envelope)))
                .isInstanceOf(OutcomeUnknownException.class)
                .hasMessage("tool invocation outcome is unknown")
                .satisfies(thrown -> assertThat(((OutcomeUnknownException) thrown).durableJobState()).isNull());
    }

    @Test
    void lostTerminalClaimAcknowledgmentLeavesNoRedispatchPath() {
        InMemoryLedger ledger = new InMemoryLedger(true);
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope("av.speech-to-text");
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(e.invocationId(), Map.of("ok", true), Map.of(),
                    e.invocationId(), Instant.now(), Duration.ZERO));
        };

        assertThatThrownBy(() -> runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope))))
                .isInstanceOf(OutcomeUnknownException.class);
        ToolExecutionResult replay = runPromise(() -> authenticatedReplay(binder, delegate, envelope));
        assertThat(replay.status()).isEqualTo(ToolExecutionStatus.SUCCESS);
        assertThat(dispatches.get()).isEqualTo(1);
    }

    @Test
    void lostPreDispatchClaimAcknowledgmentNeverDispatchesOnRetry() {
        InMemoryLedger ledger = new InMemoryLedger(false, null, true);
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope("av.speech-to-text");
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(ToolExecutionResult.succeeded(e.invocationId(), Map.of(), Map.of(),
                    e.invocationId(), Instant.now(), Duration.ZERO));
        };

        assertThatThrownBy(() -> runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope))))
                .isInstanceOf(InvocationClaimUnavailableException.class);
        assertThatThrownBy(() -> runPromise(() -> authenticatedReplay(binder, delegate, envelope)))
                .isInstanceOf(OutcomeUnknownException.class);
        assertThat(dispatches.get()).isZero();
    }

    @Test
    void unknownAndCancellationRequestedResultsRemainNonfinalFences() {
        for (ToolExecutionStatus status : java.util.List.of(
                ToolExecutionStatus.OUTCOME_UNKNOWN, ToolExecutionStatus.CANCELLATION_REQUESTED,
                ToolExecutionStatus.TIMEOUT)) {
            InMemoryLedger ledger = new InMemoryLedger();
            var binder = binder(ledger, Map.of());
            ToolExecutionEnvelope envelope = envelope("av.vision-analysis");
            var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> Promise.of(switch (status) {
                case OUTCOME_UNKNOWN -> ToolExecutionResult.outcomeUnknown(e.invocationId(), e.invocationId(), null,
                        e.invocationId(), "PENDING", Instant.now(), Duration.ZERO);
                case CANCELLATION_REQUESTED -> ToolExecutionResult.cancellationRequested(
                        e.invocationId(), e.invocationId(), null, e.invocationId(), "CANCEL_REQUESTED",
                        Instant.now(), Duration.ZERO);
                case TIMEOUT -> ToolExecutionResult.timedOut(e.invocationId(),
                        com.ghatana.agent.framework.tools.ToolExecutionFailure.Stage.EXECUTION,
                        e.invocationId(), Instant.now(), Duration.ZERO);
                default -> throw new AssertionError("unexpected status");
            });

            if (status == ToolExecutionStatus.TIMEOUT) {
                assertThatThrownBy(() -> runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope))))
                        .isInstanceOf(OutcomeUnknownException.class);
            } else {
                ToolExecutionResult first = runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope)));
                assertThat(first.status()).isEqualTo(status);
            }
            assertThat(ledger.find(envelope.invocationId())).hasValueSatisfying(action ->
                    assertThat(action.outcome()).isEqualTo(LogicalOutcome.OUTCOME_UNKNOWN));
            assertThatThrownBy(() -> runPromise(() -> authenticatedReplay(binder, delegate, envelope)))
                    .isInstanceOf(OutcomeUnknownException.class);
        }
    }

    @Test
    void unknownReplayAnnotatesTheDurableJobStateWhenReadbackKnowsIt() {
        InMemoryLedger ledger = new InMemoryLedger();
        ToolExecutionEnvelope envelope = envelope("av.multimodal-inference");
        var binder = binder(ledger, Map.of(envelope.invocationId(), "RUNNING"));
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) ->
                Promise.ofException(new IllegalStateException("ambiguous"));

        assertThatThrownBy(() -> runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope))));
        assertThatThrownBy(() -> runPromise(() -> authenticatedReplay(binder, delegate, envelope)))
                .isInstanceOf(OutcomeUnknownException.class)
                .satisfies(thrown -> assertThat(((OutcomeUnknownException) thrown).durableJobState())
                        .isEqualTo("RUNNING"));
    }

    @Test
    void terminalJobStatusWithoutAttemptReceiptDoesNotResolveUnknownToolOutcome() {
        InMemoryLedger ledger = new InMemoryLedger();
        ToolExecutionEnvelope envelope = envelope("av.speech-to-text");
        AtomicInteger dispatches = new AtomicInteger();
        var binder = binder(ledger, Map.of(envelope.invocationId(), "COMPLETED"));
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.ofException(new IllegalStateException("response lost after dispatch"));
        };

        assertThatThrownBy(() -> runPromise(() -> authenticatedReplay(binder, delegate, envelope)))
                .isInstanceOf(OutcomeUnknownException.class)
                .satisfies(thrown -> assertThat(((OutcomeUnknownException) thrown).durableJobState())
                        .isEqualTo("COMPLETED"));
        assertThat(ledger.find(envelope.invocationId())).hasValueSatisfying(action ->
                assertThat(action.outcome()).isEqualTo(LogicalOutcome.OUTCOME_UNKNOWN));

        // A terminal job status alone does not contain the canonical attempt
        // receipt/result needed to reconcile the tool action.
        assertThatThrownBy(() -> runPromise(() -> authenticatedReplay(binder, delegate, envelope)))
                .isInstanceOf(OutcomeUnknownException.class)
                .satisfies(thrown -> assertThat(((OutcomeUnknownException) thrown).durableJobState())
                        .isEqualTo("COMPLETED"));
        assertThat(dispatches.get()).isEqualTo(1);
    }

    @Test
    void recordedFailedOutcomeReplaysAsFailedNotRedispatched() {
        InMemoryLedger ledger = new InMemoryLedger();
        var binder = binder(ledger, Map.of());
        AtomicInteger dispatches = new AtomicInteger();
        ToolExecutionEnvelope envelope = envelope("av.text-to-speech");
        var delegate = (com.ghatana.toolruntime.ToolHandler) (e, c) -> {
            dispatches.incrementAndGet();
            return Promise.of(ToolExecutionResult.failed(
                    e.invocationId(), "provider rejected", e.invocationId(),
                    Instant.now(), Duration.ZERO));
        };

        ToolExecutionResult first = runPromise(() -> binder.execute(delegate, envelope, contractFor(envelope)));
        assertThat(first.status()).isNotEqualTo(ToolExecutionStatus.SUCCESS);
        ToolExecutionResult replay = runPromise(() -> authenticatedReplay(binder, delegate, envelope));
        assertThat(replay).isSameAs(first);
        assertThat(dispatches.get()).isEqualTo(1);
    }

    @Test
    void everyRegisteredToolIdResolvesARealHandler() {
        AudioVideoToolHandlerFactory factory = new AudioVideoToolHandlerFactory();
        // AT-06: no registered-but-missing handler.
        for (String toolId : factory.toolIds()) {
            assertThat(factory.create(toolId)).isNotNull();
        }
        // Unknown ids fail closed — never a fabricated handler.
        assertThatThrownBy(() -> factory.create("av.nonexistent"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> factory.create("datacloud.media.artifacts"))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
