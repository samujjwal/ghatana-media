package com.ghatana.media.launcher;

import com.ghatana.media.runtime.InMemoryMediaRequestLedger;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Acquired;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Claim;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.InProgress;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Key;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Mismatch;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Replay;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.RequestLedger;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.RequestLedgerFactory;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.ServiceLoader;
import java.util.UUID;
import java.util.function.Function;
import java.util.function.Supplier;

/**
 * Shared adoption point of the durable request ledger for the DEV_ONLY model lanes. A lane calls
 * {@link #run} AFTER its own validation and its own rights check, so rights are re-evaluated on every call,
 * a replay included (a revoked source refuses even a replay). Only then is the ledger consulted, before any model
 * runs:
 *
 * <ul>
 *   <li>COMPLETED with the same fingerprint: {@code replay} re-reads the registered output artifacts; the model is
 *       not run again;</li>
 *   <li>a different fingerprint: the lane's own "request id reused" exception (HTTP 409);</li>
 *   <li>IN_PROGRESS under a live lease: bounded wait for the owner, then {@code REQUEST_IN_PROGRESS} (409);</li>
 *   <li>a stale lease (crashed owner, outcome UNKNOWN): taken over under a higher fencing token;</li>
 *   <li>a failure of {@code produce} releases the claim so a retry runs again; a crash leaves the row IN_PROGRESS
 *       until its lease expires.</li>
 * </ul>
 *
 * <p>The ledger maps the request to its registered output; it does not make registration exactly-once on its own.
 * Registration stays idempotent through the canonical upload idempotency key, so a superseded run that registers late
 * can never create a second artifact.</p>
 */
final class MediaDevRequestLedger implements AutoCloseable {
    static final String ENV_BACKEND = "MEDIA_DEV_REQUEST_LEDGER";
    static final String ENV_LEASE_SECONDS = "MEDIA_DEV_REQUEST_LEDGER_LEASE_SECONDS";
    static final String ENV_WAIT_SECONDS = "MEDIA_DEV_REQUEST_LEDGER_WAIT_SECONDS";
    static final String POSTGRESQL_FACTORY = "postgresql-dev-request-ledger";
    static final Duration DEFAULT_LEASE = Duration.ofMinutes(15);
    static final Duration DEFAULT_WAIT = Duration.ofSeconds(20);
    private static final long POLL_MILLIS = 200;
    private static final Logger log = LoggerFactory.getLogger(MediaDevRequestLedger.class);

    /** Typed refusal raised by the ledger itself; carries no request content. */
    static final class LedgerRefusedException extends RuntimeException {
        private final int status;
        private final String code;
        private final Map<String, Object> details;

        LedgerRefusedException(int status, String code, String message, Map<String, Object> details) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
            this.details = details;
        }

        int status() { return status; }
        String code() { return code; }
        Map<String, Object> details() { return details; }
    }

    private final RequestLedger ledger;
    private final Duration lease;
    private final Duration maxWait;
    private final String owner = "launcher-" + UUID.randomUUID();
    private final boolean durable;

    MediaDevRequestLedger(RequestLedger ledger, Duration lease, Duration maxWait, boolean durable) {
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.lease = Objects.requireNonNull(lease, "lease");
        this.maxWait = Objects.requireNonNull(maxWait, "maxWait");
        this.durable = durable;
        if (lease.isZero() || lease.isNegative()) throw new IllegalArgumentException("lease must be positive");
        if (maxWait.isNegative()) throw new IllegalArgumentException("maxWait must not be negative");
    }

    /** Process-local ledger for tests; never durable. */
    static MediaDevRequestLedger inMemory() {
        return new MediaDevRequestLedger(new InMemoryMediaRequestLedger(), DEFAULT_LEASE, DEFAULT_WAIT, false);
    }

    boolean durable() { return durable; }

    /**
     * {@code MEDIA_DEV_REQUEST_LEDGER}: {@code postgresql} (durable, startup fails when unavailable), {@code memory}
     * (explicitly non-durable) or unset/{@code auto} (PostgreSQL when the canonical runtime datasource is configured,
     * otherwise a process-local ledger that is logged as non-durable).
     */
    static MediaDevRequestLedger compose(Map<String, String> environment) {
        String mode = environment.getOrDefault(ENV_BACKEND, "auto").trim().toLowerCase(Locale.ROOT);
        Duration lease = seconds(environment, ENV_LEASE_SECONDS, DEFAULT_LEASE, 30, 86_400);
        Duration wait = seconds(environment, ENV_WAIT_SECONDS, DEFAULT_WAIT, 0, 300);
        boolean datasourceConfigured = !environment.getOrDefault("MEDIA_POSTGRES_JDBC_URL", "").isBlank();
        switch (mode) {
            case "memory" -> {
                log.warn("DEV request ledger is process-local (non-durable) by explicit configuration");
                return new MediaDevRequestLedger(new InMemoryMediaRequestLedger(), lease, wait, false);
            }
            case "postgresql" -> { return new MediaDevRequestLedger(openPostgresql(environment), lease, wait, true); }
            case "auto" -> {
                if (datasourceConfigured) {
                    return new MediaDevRequestLedger(openPostgresql(environment), lease, wait, true);
                }
                log.warn("DEV request ledger is process-local (non-durable): no canonical PostgreSQL datasource is configured");
                return new MediaDevRequestLedger(new InMemoryMediaRequestLedger(), lease, wait, false);
            }
            default -> throw new IllegalArgumentException(ENV_BACKEND + " must be postgresql, memory or auto");
        }
    }

    private static RequestLedger openPostgresql(Map<String, String> environment) {
        List<RequestLedgerFactory> factories = ServiceLoader.load(RequestLedgerFactory.class).stream()
                .map(ServiceLoader.Provider::get)
                .filter(factory -> POSTGRESQL_FACTORY.equals(factory.factoryId()))
                .toList();
        if (factories.size() != 1) {
            throw new IllegalStateException("exactly one PostgreSQL DEV_ONLY request ledger factory is required");
        }
        return factories.getFirst().createDevOnly(Map.copyOf(environment));
    }

    private static Duration seconds(Map<String, String> environment, String name, Duration fallback, long min, long max) {
        String raw = environment.get(name);
        if (raw == null || raw.isBlank()) return fallback;
        try {
            long value = Long.parseLong(raw.trim());
            if (value < min || value > max) throw new NumberFormatException();
            return Duration.ofSeconds(value);
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException(name + " must be an integer within [" + min + ", " + max + "]");
        }
    }

    /** SHA-256 over length-prefixed parts, so no two different part lists can share a canonical form. */
    static String fingerprint(String schema, Object... parts) {
        StringBuilder canonical = new StringBuilder();
        append(canonical, schema);
        for (Object part : parts) append(canonical, part == null ? "\u0000null" : String.valueOf(part));
        return MediaDevProjectRenderRuntime.sha256Hex(canonical.toString().getBytes(StandardCharsets.UTF_8));
    }

    private static void append(StringBuilder out, String part) {
        out.append(part.length()).append(':').append(part).append(';');
    }

    /**
     * Runs one request through the ledger. {@code outputs} must name every registered artifact of a produced
     * result; {@code replay} rebuilds the result from those registered artifacts.
     */
    <T> T run(String tenantId, String principalId, String lane, String requestId, String fingerprint,
              Function<List<OutputRef>, T> replay, Supplier<T> produce, Function<T, List<OutputRef>> outputs,
              Supplier<? extends RuntimeException> mismatch) {
        Key key = new Key(tenantId, principalId, lane, requestId);
        long deadline = System.nanoTime() + maxWait.toNanos();
        while (true) {
            Claim claim;
            try {
                claim = ledger.claim(key, fingerprint, owner, lease);
            } catch (RuntimeException failure) {
                throw unavailable(failure);
            }
            if (claim instanceof Replay replayed) return replay.apply(replayed.outputs());
            if (claim instanceof Mismatch) throw mismatch.get();
            if (claim instanceof InProgress busy) {
                if (System.nanoTime() >= deadline) {
                    throw new LedgerRefusedException(409, "REQUEST_IN_PROGRESS",
                            "the same requestId is still being processed by another call; retry the same requestId",
                            Map.of("lane", lane, "retryAfterSeconds",
                                    Math.max(1, Duration.between(java.time.Instant.now(), busy.leaseExpiresAt()).toSeconds())));
                }
                try {
                    Thread.sleep(POLL_MILLIS);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    throw new LedgerRefusedException(503, "REQUEST_INTERRUPTED",
                            "the call was interrupted while waiting for the same requestId", Map.of("lane", lane));
                }
                continue;
            }
            Acquired acquired = (Acquired) claim;
            if (acquired.takeover()) {
                log.warn("DEV request ledger took over a stale lease lane={} attempt={}", lane, acquired.attempt());
            }
            final T result;
            try {
                result = produce.get();
            } catch (RuntimeException | Error failure) {
                try {
                    ledger.release(key, acquired.fence(), failure.getClass().getSimpleName());
                } catch (RuntimeException releaseFailure) {
                    log.warn("DEV request ledger release failed lane={} reason={}", lane,
                            releaseFailure.getClass().getSimpleName());
                }
                throw failure;
            }
            try {
                if (!ledger.complete(key, acquired.fence(), outputs.apply(result))) {
                    log.warn("DEV request ledger lease was superseded before completion lane={}", lane);
                }
            } catch (RuntimeException failure) {
                // The output is registered (idempotently by its upload key); only the mapping is missing. The row
                // stays IN_PROGRESS (outcome UNKNOWN) until its lease expires and a retry completes it.
                throw unavailable(failure);
            }
            return result;
        }
    }

    static LedgerRefusedException outputUnavailable(String lane) {
        return new LedgerRefusedException(409, "REQUEST_OUTPUT_UNAVAILABLE",
                "the registered output of this completed requestId is no longer readable by this principal",
                Map.of("lane", lane));
    }

    private static LedgerRefusedException unavailable(RuntimeException cause) {
        log.warn("DEV request ledger unavailable reason={}", cause.getClass().getSimpleName());
        return new LedgerRefusedException(503, "REQUEST_LEDGER_UNAVAILABLE",
                "the durable request ledger is unavailable; nothing was run or recorded, retry the same requestId",
                Map.of());
    }

    @Override public void close() {
        ledger.close();
    }
}
