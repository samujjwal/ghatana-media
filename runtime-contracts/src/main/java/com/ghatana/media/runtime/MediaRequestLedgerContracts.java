package com.ghatana.media.runtime;

import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Durable request ledger for DEV_ONLY model lanes whose output is not byte-reproducible.
 *
 * <p>A lane that runs a local model cannot make a retry idempotent by re-running the model and comparing bytes:
 * the output is nondeterministic under GPU contention. The ledger instead records, per
 * {@code (tenant, principal, lane, requestId)}, the SHA-256 fingerprint of the canonical request (the exact input
 * versions and parameters) and, once the lane completes, the registered output artifact id and version. A retry
 * looks the key up <em>before</em> running a model:</p>
 * <ul>
 *   <li>COMPLETED with the same fingerprint: the caller replays the registered output (re-reading the artifact)
 *       and never runs the model again;</li>
 *   <li>any state with a different fingerprint: the requestId is reused for a different request;</li>
 *   <li>IN_PROGRESS under a live lease: another worker owns the run; the caller waits or is refused;</li>
 *   <li>IN_PROGRESS under an expired lease (the owner crashed or stalled): the outcome is UNKNOWN; a new claim takes
 *       the run over under a higher fencing token, and a completion from the superseded owner is rejected;</li>
 *   <li>RELEASED (the owner reported a failure that registered nothing): the next claim runs again.</li>
 * </ul>
 * The ledger is not an authority for rights: callers re-check rights on every call, including a replay.
 */
public final class MediaRequestLedgerContracts {
    private static final Pattern SHA256 = Pattern.compile("[0-9a-f]{64}");

    private MediaRequestLedgerContracts() { }

    /** The ledger key. Tenant and principal are part of the key, so no cache or replay crosses an owner. */
    public record Key(String tenantId, String principalId, String lane, String requestId) {
        public Key {
            tenantId = bounded(tenantId, "tenantId", 255);
            principalId = bounded(principalId, "principalId", 255);
            lane = bounded(lane, "lane", 64);
            requestId = bounded(requestId, "requestId", 128);
        }
    }

    /** One registered output of a completed request: an exact artifact id and version. */
    public record OutputRef(String role, String artifactId, String versionId) {
        public OutputRef {
            role = bounded(role, "role", 64);
            artifactId = bounded(artifactId, "artifactId", 255);
            versionId = bounded(versionId, "versionId", 255);
        }
    }

    public enum State { IN_PROGRESS, COMPLETED, RELEASED, ERASED }

    /** Read-only view of one ledger row. */
    public record Entry(Key key, String fingerprint, State state, String leaseOwner, long fence,
                        Instant leaseExpiresAt, int attempts, List<OutputRef> outputs, String lastFailureCode,
                        Instant createdAt, Instant updatedAt, Instant completedAt) {
        public Entry {
            outputs = List.copyOf(outputs);
        }
    }

    /** Result of {@link RequestLedger#claim}. */
    public sealed interface Claim permits Acquired, Replay, Mismatch, InProgress, Erased { }

    /** The caller owns the run. {@code fence} must be presented to complete or release; {@code takeover} marks a stale lease. */
    public record Acquired(long fence, int attempt, boolean takeover) implements Claim { }

    /** The request already completed with the same fingerprint; replay these registered outputs. */
    public record Replay(List<OutputRef> outputs) implements Claim {
        public Replay {
            outputs = List.copyOf(outputs);
        }
    }

    /**
     * The registered output of this requestId was erased on request (J-26). The key is permanently answered as
     * erased: it neither replays nor runs a model again, whatever fingerprint the caller presents.
     */
    public record Erased() implements Claim { }

    /** The requestId was already used with a different canonical request. */
    public record Mismatch() implements Claim { }

    /**
     * Another worker holds a live lease for the same request; its outcome is not known yet. {@code leaseOwner} and
     * {@code fence} identify the holder so a caller that can prove the holder is gone may {@link RequestLedger#reclaim}.
     */
    public record InProgress(Instant leaseExpiresAt, String leaseOwner, long fence) implements Claim { }

    public interface RequestLedger extends AutoCloseable {
        String ledgerId();

        boolean ready();

        /**
         * Atomically claims or classifies the key. At most one concurrent claimant of a key receives
         * {@link Acquired} for a given lease; the lease is bounded by {@code lease}.
         */
        Claim claim(Key key, String fingerprint, String owner, Duration lease);

        /**
         * Takes over an IN_PROGRESS run before its lease expires, only when it is still held by exactly
         * {@code expectedOwner} at {@code expectedFence} with the same fingerprint (a compare-and-set). The caller must
         * have independent proof that the owner is gone (for example a dead local process); the previous run's outcome
         * stays UNKNOWN and its late completion is refused by the higher fence. When the row no longer matches, this
         * behaves as {@link #claim}.
         */
        Claim reclaim(Key key, String fingerprint, String expectedOwner, long expectedFence, String newOwner,
                      Duration lease);

        /**
         * Records the registered outputs and marks the request COMPLETED. Returns false, changing nothing, when the
         * caller's lease was superseded (the fence no longer matches) or the request is not IN_PROGRESS.
         */
        boolean complete(Key key, long fence, List<OutputRef> outputs);

        /** Gives up a run that registered nothing so a retry may run again. False when the fence no longer matches. */
        boolean release(Key key, long fence, String failureCode);

        Optional<Entry> find(Key key);

        /**
         * Marks every COMPLETED row of {@code tenantId} whose registered output names one of {@code artifactIds} as
         * {@link State#ERASED} and drops its output references, so the key can never replay an erased output. Returns
         * the number of rows changed. Providers whose rows are erased inside an erasure transaction may keep the
         * default.
         */
        default int eraseOutputs(String tenantId, java.util.Set<String> artifactIds) { return 0; }

        @Override void close();
    }

    /** ServiceLoader SPI for the durable DEV_ONLY ledger over the canonical runtime persistence. */
    public interface RequestLedgerFactory {
        String factoryId();

        /** Creates a ledger only for a verified local development configuration. */
        RequestLedger createDevOnly(Map<String, String> environment);
    }

    public static boolean validFingerprint(String fingerprint) {
        return fingerprint != null && SHA256.matcher(fingerprint).matches();
    }

    public static String requireFingerprint(String fingerprint) {
        if (!validFingerprint(fingerprint)) throw new IllegalArgumentException("fingerprint must be 64 lower-case hex characters");
        return fingerprint;
    }

    private static String bounded(String value, String name, int max) {
        Objects.requireNonNull(value, name);
        if (value.isBlank() || value.length() > max) {
            throw new IllegalArgumentException(name + " must be 1-" + max + " characters");
        }
        return value;
    }
}
