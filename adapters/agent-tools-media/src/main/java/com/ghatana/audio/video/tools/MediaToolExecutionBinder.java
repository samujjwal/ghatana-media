package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.toolruntime.ToolHandler;
import io.activej.promise.Promise;

import java.nio.ByteBuffer;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * AT-05: bind a Tools runtime execution envelope to one Media action using an
 * atomic pre-dispatch claim and durable outcome readback.
 *
 * <p>The ledger must durably claim an invocation before dispatch. A missing,
 * unavailable, or racing claim never dispatches. The claim begins as
 * OUTCOME_UNKNOWN and is replaced only by an acknowledged terminal result;
 * lost completion acknowledgments therefore leave a replay fence in place.
 * Replay identity includes the full immutable envelope request. Envelope
 * identity is a consistency check only and does not authenticate the caller
 * or grant tool permissions.
 */
public final class MediaToolExecutionBinder {

    public enum LogicalOutcome { SUCCESS, FAILED, OUTCOME_UNKNOWN }

    /** Complete immutable request identity bound to the invocation key. */
    public record RequestIdentity(
            String toolId,
            String toolVersion,
            String callerAgentId,
            String callerReleaseId,
            String tenantId,
            ToolActionClass actionClass,
            String requestSchemaVersion,
            String inputFingerprint,
            boolean bound) {
        public RequestIdentity {
            Objects.requireNonNull(toolId, "toolId");
            Objects.requireNonNull(inputFingerprint, "inputFingerprint");
            if (bound) {
                Objects.requireNonNull(toolVersion, "toolVersion");
                Objects.requireNonNull(callerAgentId, "callerAgentId");
                Objects.requireNonNull(tenantId, "tenantId");
                Objects.requireNonNull(actionClass, "actionClass");
            }
        }

        static RequestIdentity from(ToolExecutionEnvelope envelope) {
            return new RequestIdentity(envelope.toolId(), envelope.toolVersion(), envelope.callerAgentId(),
                    envelope.callerReleaseId(), envelope.tenantId(), envelope.actionClass(),
                    envelope.requestSchemaVersion(), fingerprintInput(envelope.input()), true);
        }

        private static RequestIdentity legacy(String toolId, String tenantId, String callerAgentId) {
            return new RequestIdentity(toolId, null, callerAgentId, null, tenantId, null, null, "", false);
        }
    }

    /** One ledger state for an invocation. UNKNOWN may have no result (claim fence). */
    public record LogicalAction(
            String invocationId,
            RequestIdentity requestIdentity,
            LogicalOutcome outcome,
            ToolExecutionResult result) {
        public LogicalAction {
            Objects.requireNonNull(invocationId, "invocationId");
            Objects.requireNonNull(requestIdentity, "requestIdentity");
            Objects.requireNonNull(outcome, "outcome");
            if (invocationId.isBlank()) throw new IllegalArgumentException("invocationId must not be blank");
            switch (outcome) {
                case OUTCOME_UNKNOWN -> {
                    if (result != null) throw new IllegalArgumentException("UNKNOWN action cannot carry a result");
                }
                case SUCCESS -> requireResult(invocationId, result, ToolExecutionStatus.SUCCESS);
                case FAILED -> {
                    Objects.requireNonNull(result, "result");
                    if (!result.invocationId().equals(invocationId) || !result.status().isTerminal()
                            || result.status() == ToolExecutionStatus.SUCCESS
                            || result.status() == ToolExecutionStatus.TIMEOUT) {
                        throw new IllegalArgumentException("FAILED action requires a matching terminal failure result");
                    }
                }
            }
        }

        private static void requireResult(String invocationId, ToolExecutionResult result,
                ToolExecutionStatus expected) {
            Objects.requireNonNull(result, "result");
            if (!result.invocationId().equals(invocationId) || result.status() != expected) {
                throw new IllegalArgumentException("action result does not match its terminal outcome");
            }
        }

        /** Compatibility constructor for older local ledger adapters; unbound actions fail replay closed. */
        @Deprecated
        public LogicalAction(String invocationId, String toolId, String tenantId, String callerAgentId,
                LogicalOutcome outcome, ToolExecutionResult result) {
            this(invocationId, RequestIdentity.legacy(toolId, tenantId, callerAgentId), outcome,
                    outcome == LogicalOutcome.OUTCOME_UNKNOWN ? null : result);
        }

        /** Compatibility constructor for legacy unscoped ledger records; these cannot be replayed. */
        @Deprecated
        public LogicalAction(String invocationId, String toolId, LogicalOutcome outcome, ToolExecutionResult result) {
            this(invocationId, RequestIdentity.legacy(toolId, "", ""), outcome,
                    outcome == LogicalOutcome.OUTCOME_UNKNOWN ? null : result);
        }

        public String toolId() { return requestIdentity.toolId(); }
        public String tenantId() { return requestIdentity.tenantId(); }
        public String callerAgentId() { return requestIdentity.callerAgentId(); }

        /** Avoid rendering request identity, fingerprint, result, or result payloads in diagnostics. */
        @Override public String toString() {
            return "LogicalAction{outcome=" + outcome
                    + ", requestIdentityPresent=" + (requestIdentity != null)
                    + ", resultPresent=" + (result != null) + "}";
        }
    }

    public enum ClaimResult { CLAIMED, ALREADY_CLAIMED, UNAVAILABLE }

    /**
     * Durable invocation ledger owned by the Shared run ledger integration.
     * No production implementation is provided here; default claim/completion
     * behavior fails closed. The filesystem development implementation encrypts
     * terminal results and applies a host-provided retention lifetime. Replays
     * require a fresh host-authenticated principal and a host authorizer. The
     * deprecated Java constructors only preserve local source/binary call
     * shapes; they do not migrate or prove compatibility of serialized records.
     */
    public interface InvocationLedger {
        Optional<LogicalAction> find(String invocationId);

        /** Legacy write API; the binder does not use it to authorize dispatch. */
        void record(LogicalAction action);

        /**
         * Atomically and durably inserts the UNKNOWN fence only when absent.
         * Return CLAIMED only after durable acknowledgment. On a lost/ambiguous
         * acknowledgment return UNAVAILABLE or ALREADY_CLAIMED, never CLAIMED.
         * Existing implementations fail closed until they implement this.
         */
        default ClaimResult claim(LogicalAction unknownFence) {
            return ClaimResult.UNAVAILABLE;
        }

        /** Atomically replaces the exact UNKNOWN fence only if full request identity still matches. */
        default boolean complete(LogicalAction terminalAction) {
            return false;
        }
    }

    @FunctionalInterface
    public interface MediaJobReadback {
        Optional<String> durableJobState(String tenantId, String invocationId);
    }

    /** Host-owned decision that maps a freshly authenticated principal to the envelope actor. */
    @FunctionalInterface
    public interface InvocationReplayAuthorizer {
        boolean mayReplay(AuthenticatedPrincipal authenticated, RequestIdentity recordedIdentity);
    }

    public static final class OutcomeUnknownException extends RuntimeException {
        private final String invocationId;
        private final String durableJobState;

        OutcomeUnknownException(String invocationId, String durableJobState) {
            super("tool invocation outcome is unknown");
            this.invocationId = invocationId;
            this.durableJobState = durableJobState;
        }

        public String invocationId() { return invocationId; }
        public String durableJobState() { return durableJobState; }
    }

    public static final class InvocationIdentityConflictException extends RuntimeException {
        InvocationIdentityConflictException() {
            super("tool invocation identity conflicts with its recorded action");
        }
    }

    public static final class InvocationClaimUnavailableException extends RuntimeException {
        InvocationClaimUnavailableException() {
            super("durable invocation claim is unavailable");
        }
    }

    public static final class InvocationReplayDeniedException extends SecurityException {
        InvocationReplayDeniedException() {
            super("authenticated principal is not authorized to replay this invocation");
        }
    }

    private final InvocationLedger ledger;
    private final MediaJobReadback jobReadback;
    private final InvocationReplayAuthorizer replayAuthorizer;

    public MediaToolExecutionBinder(InvocationLedger ledger, MediaJobReadback jobReadback) {
        this(ledger, jobReadback, (authenticated, identity) -> false);
    }

    public MediaToolExecutionBinder(InvocationLedger ledger, MediaJobReadback jobReadback,
            InvocationReplayAuthorizer replayAuthorizer) {
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.jobReadback = Objects.requireNonNull(jobReadback, "jobReadback");
        this.replayAuthorizer = Objects.requireNonNull(replayAuthorizer, "replayAuthorizer");
    }

    public Promise<ToolExecutionResult> execute(
            ToolHandler delegate, ToolExecutionEnvelope envelope, ToolContract contract) {
        return execute(delegate, envelope, contract, null);
    }

    /**
     * Executes with a host-authenticated principal. The principal is an authority input, not
     * reconstructed from the envelope; the host authorizer decides whether it maps to the actor.
     */
    public Promise<ToolExecutionResult> execute(
            ToolHandler delegate, ToolExecutionEnvelope envelope, ToolContract contract,
            AuthenticatedPrincipal authenticated) {
        Objects.requireNonNull(delegate, "delegate");
        Objects.requireNonNull(envelope, "envelope");
        Objects.requireNonNull(contract, "contract");
        if (!envelope.toolId().equals(contract.toolId())
                || !envelope.toolVersion().equals(contract.toolVersion())
                || envelope.actionClass() != contract.actionClass()) {
            return Promise.ofException(new IllegalArgumentException("TOOL_CONTRACT_ENVELOPE_MISMATCH"));
        }
        if (authenticated != null && !authenticated.tenantId().equals(envelope.tenantId())) {
            return Promise.ofException(new InvocationReplayDeniedException());
        }
        // Envelope actor/tenant fields are caller-controlled consistency data.
        // Require the host-authenticated identity before even creating a claim:
        // otherwise a first invocation could cross the delegate effect boundary
        // without the authority that is already required for replay.
        if (authenticated == null) {
            return Promise.ofException(new InvocationReplayDeniedException());
        }

        // Bind the request fingerprint and dispatch to the same immutable input
        // tree. ToolExecutionEnvelope does not make nested maps/lists immutable,
        // so retaining the caller-owned input would leave a TOCTOU gap between
        // identity calculation and the delegate's read of the request.
        final ToolExecutionEnvelope boundEnvelope;
        final RequestIdentity identity;
        try {
            boundEnvelope = snapshotEnvelope(envelope);
            identity = RequestIdentity.from(boundEnvelope);
        } catch (RuntimeException invalidInput) {
            return Promise.ofException(invalidInput);
        }
        final boolean authorized;
        try {
            authorized = replayAuthorizer.mayReplay(authenticated, identity);
        } catch (RuntimeException unavailable) {
            return Promise.ofException(new InvocationReplayDeniedException());
        }
        if (!authorized) return Promise.ofException(new InvocationReplayDeniedException());

        LogicalAction fence = new LogicalAction(boundEnvelope.invocationId(), identity,
                LogicalOutcome.OUTCOME_UNKNOWN, null);
        final ClaimResult claim;
        try {
            claim = ledger.claim(fence);
        } catch (RuntimeException ambiguousClaim) {
            return Promise.ofException(new InvocationClaimUnavailableException());
        }

        if (claim == ClaimResult.ALREADY_CLAIMED) {
            final Optional<LogicalAction> prior;
            try {
                prior = ledger.find(boundEnvelope.invocationId());
            } catch (RuntimeException unavailableReadback) {
                return Promise.ofException(new InvocationClaimUnavailableException());
            }
            if (prior == null || prior.isEmpty()) {
                return Promise.ofException(new InvocationClaimUnavailableException());
            }
            return replay(prior.get(), identity, boundEnvelope, authenticated);
        }
        if (claim != ClaimResult.CLAIMED) {
            return Promise.ofException(new InvocationClaimUnavailableException());
        }

        // The durable UNKNOWN fence exists before this effect boundary. Any
        // dispatch/completion ambiguity retains that fence, preventing replay.
        return AgentToolInput.dispatch(delegate, boundEnvelope, contract)
                .map(result -> finishIfTerminal(result, identity, boundEnvelope))
                .mapException(failure -> failure instanceof OutcomeUnknownException
                        ? failure : unknown(boundEnvelope));
    }

    private static ToolExecutionEnvelope snapshotEnvelope(ToolExecutionEnvelope envelope) {
        var nodeCount = new int[1];
        @SuppressWarnings("unchecked")
        Map<String, Object> input = (Map<String, Object>) snapshotValue(envelope.input(), 0, nodeCount);
        return new ToolExecutionEnvelope(envelope.invocationId(), envelope.toolId(), envelope.toolVersion(),
                envelope.callerAgentId(), envelope.callerReleaseId(), envelope.tenantId(), envelope.actionClass(),
                envelope.requestSchemaVersion(), input, envelope.requestedAt());
    }

    private static Object snapshotValue(Object value, int depth, int[] nodeCount) {
        if (++nodeCount[0] > InputFingerprintWriter.MAX_NODES || depth > InputFingerprintWriter.MAX_DEPTH) {
            throw new IllegalArgumentException("TOOL_INPUT_IDENTITY_TOO_LARGE");
        }
        if (value == null || value instanceof String || value instanceof Boolean
                || InputFingerprintWriter.isSupportedNumber(value)) {
            return value;
        }
        if (value instanceof Map<?, ?> map) {
            if (map.size() > InputFingerprintWriter.MAX_NODES - nodeCount[0]) {
                throw new IllegalArgumentException("TOOL_INPUT_IDENTITY_TOO_LARGE");
            }
            var copy = new java.util.LinkedHashMap<String, Object>(map.size());
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                if (!(entry.getKey() instanceof String key)) {
                    throw new IllegalArgumentException("INVALID_TOOL_INPUT_KEY");
                }
                copy.put(key, snapshotValue(entry.getValue(), depth + 1, nodeCount));
            }
            return java.util.Collections.unmodifiableMap(copy);
        }
        if (value instanceof java.util.List<?> list) {
            if (list.size() > InputFingerprintWriter.MAX_NODES - nodeCount[0]) {
                throw new IllegalArgumentException("TOOL_INPUT_IDENTITY_TOO_LARGE");
            }
            var copy = new java.util.ArrayList<Object>(list.size());
            for (Object child : list) copy.add(snapshotValue(child, depth + 1, nodeCount));
            return java.util.Collections.unmodifiableList(copy);
        }
        throw new IllegalArgumentException("INVALID_TOOL_INPUT_VALUE");
    }

    private Promise<ToolExecutionResult> replay(
            LogicalAction prior, RequestIdentity identity, ToolExecutionEnvelope envelope,
            AuthenticatedPrincipal authenticated) {
        if (!prior.invocationId().equals(envelope.invocationId()) || !wellFormed(prior)) {
            return Promise.ofException(new InvocationClaimUnavailableException());
        }
        if (!prior.requestIdentity().bound() || !prior.requestIdentity().equals(identity)) {
            return Promise.ofException(new InvocationIdentityConflictException());
        }
        final boolean authorized;
        try {
            authorized = authenticated != null && authenticated.tenantId().equals(identity.tenantId())
                    && replayAuthorizer.mayReplay(authenticated, identity);
        } catch (RuntimeException unavailable) {
            return Promise.ofException(new InvocationReplayDeniedException());
        }
        if (!authorized) {
            return Promise.ofException(new InvocationReplayDeniedException());
        }
        if (prior.outcome() == LogicalOutcome.OUTCOME_UNKNOWN) {
            return Promise.ofException(unknown(envelope));
        }
        if (prior.result() == null) {
            return Promise.ofException(new InvocationClaimUnavailableException());
        }
        return Promise.of(prior.result());
    }

    private static boolean wellFormed(LogicalAction action) {
        ToolExecutionResult result = action.result();
        if (action.outcome() == LogicalOutcome.OUTCOME_UNKNOWN) return result == null;
        if (result == null || !action.invocationId().equals(result.invocationId())) return false;
        return action.outcome() == LogicalOutcome.SUCCESS
                ? result.status() == ToolExecutionStatus.SUCCESS
                : result.status().isTerminal() && result.status() != ToolExecutionStatus.SUCCESS
                        && result.status() != ToolExecutionStatus.TIMEOUT;
    }

    private ToolExecutionResult finishIfTerminal(
            ToolExecutionResult result, RequestIdentity identity, ToolExecutionEnvelope envelope) {
        ToolExecutionStatus status = result.status();
        if (status == ToolExecutionStatus.TIMEOUT) {
            // Shared labels timeout terminal, but a lost response does not
            // establish that no downstream effect happened.
            throw unknown(envelope);
        }
        if (!status.isTerminal()) {
            // Preserve nonfinal status to the caller while leaving the durable
            // UNKNOWN fence untouched for subsequent reconciliation.
            return result;
        }
        LogicalOutcome outcome = status == ToolExecutionStatus.SUCCESS
                ? LogicalOutcome.SUCCESS : LogicalOutcome.FAILED;
        LogicalAction terminal = new LogicalAction(envelope.invocationId(), identity, outcome, result);
        final boolean acknowledged;
        try {
            acknowledged = ledger.complete(terminal);
        } catch (RuntimeException lostAcknowledgment) {
            throw unknown(envelope);
        }
        if (!acknowledged) throw unknown(envelope);
        return result;
    }

    private OutcomeUnknownException unknown(ToolExecutionEnvelope envelope) {
        String state = null;
        try {
            state = jobReadback.durableJobState(envelope.tenantId(), envelope.invocationId())
                    .flatMap(MediaToolExecutionBinder::canonicalJobStatus).orElse(null);
        } catch (RuntimeException unavailable) {
            // Readback failure cannot make an ambiguous dispatch final.
        }
        return new OutcomeUnknownException(envelope.invocationId(), state);
    }

    private static Optional<String> canonicalJobStatus(String value) {
        try {
            return Optional.of(MediaRuntimeContracts.JobStatus.valueOf(value).name());
        } catch (IllegalArgumentException | NullPointerException invalid) {
            return Optional.empty();
        }
    }

    private static String fingerprintInput(Map<String, Object> input) {
        final MessageDigest digest;
        try {
            digest = MessageDigest.getInstance("SHA-256");
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
        new InputFingerprintWriter(digest).write(input, 0);
        return java.util.HexFormat.of().formatHex(digest.digest());
    }

    /** Deterministic, type-aware, bounded digest writer; raw arguments are not retained in the ledger. */
    private static final class InputFingerprintWriter {
        private static final int MAX_NODES = 20_000;
        private static final int MAX_DEPTH = 64;
        private static final int MAX_BYTES = 1_048_576;
        private final MessageDigest digest;
        private int nodes;
        private int bytes;

        private InputFingerprintWriter(MessageDigest digest) { this.digest = digest; }

        private void write(Object value, int depth) {
            if (++nodes > MAX_NODES || depth > MAX_DEPTH) throw tooLarge();
            if (value == null) {
                tag('N');
            } else if (value instanceof Map<?, ?> map) {
                tag('M');
                writeLength(map.size());
                if (map.size() > MAX_NODES - nodes) throw tooLarge();
                var entries = new ArrayList<Map.Entry<?, ?>>(map.entrySet());
                entries.sort(Comparator.comparing(entry -> {
                    if (!(entry.getKey() instanceof String key)) throw new IllegalArgumentException("INVALID_TOOL_INPUT_KEY");
                    return key;
                }));
                for (Map.Entry<?, ?> entry : entries) {
                    write(entry.getKey(), depth + 1);
                    write(entry.getValue(), depth + 1);
                }
            } else if (value instanceof java.util.List<?> list) {
                tag('L');
                writeLength(list.size());
                if (list.size() > MAX_NODES - nodes) throw tooLarge();
                for (Object child : list) write(child, depth + 1);
            } else if (value instanceof String text) {
                tag('S');
                writeString(text);
            } else if (value instanceof Boolean bool) {
                tag(bool ? 'T' : 'F');
            } else if (isSupportedNumber(value)) {
                tag('D');
                if (value instanceof java.math.BigInteger integer && integer.bitLength() > 8_192) throw tooLarge();
                if (value instanceof java.math.BigDecimal decimal
                        && (decimal.scale() > 4_096 || decimal.scale() < -4_096
                        || decimal.unscaledValue().bitLength() > 8_192)) throw tooLarge();
                writeBytes((value.getClass().getName() + ":" + value).getBytes(StandardCharsets.UTF_8));
            } else {
                throw new IllegalArgumentException("INVALID_TOOL_INPUT_VALUE");
            }
        }

        private static boolean isSupportedNumber(Object value) {
            Class<?> type = value.getClass();
            return type == Byte.class || type == Short.class || type == Integer.class || type == Long.class
                    || type == Float.class || type == Double.class || type == java.math.BigInteger.class
                    || type == java.math.BigDecimal.class;
        }

        private void tag(int tag) {
            reserve(1);
            digest.update((byte) tag);
        }

        private void writeLength(int length) {
            reserve(Integer.BYTES);
            digest.update(ByteBuffer.allocate(Integer.BYTES).putInt(length).array());
        }

        private void writeBytes(byte[] value) {
            writeLength(value.length);
            reserve(value.length);
            digest.update(value);
        }

        private void writeString(String value) {
            if (value.length() > MAX_BYTES / Character.BYTES) throw tooLarge();
            writeLength(value.length());
            reserve(value.length() * Character.BYTES);
            byte[] utf16 = new byte[value.length() * Character.BYTES];
            for (int index = 0; index < value.length(); index++) {
                char character = value.charAt(index);
                utf16[index * 2] = (byte) (character >>> 8);
                utf16[index * 2 + 1] = (byte) character;
            }
            digest.update(utf16);
        }

        private void reserve(int count) {
            if (count < 0 || bytes > MAX_BYTES - count) throw tooLarge();
            bytes += count;
        }

        private static IllegalArgumentException tooLarge() {
            return new IllegalArgumentException("TOOL_INPUT_IDENTITY_TOO_LARGE");
        }
    }
}
