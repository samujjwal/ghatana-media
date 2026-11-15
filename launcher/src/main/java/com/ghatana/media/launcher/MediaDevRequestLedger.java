package com.ghatana.media.launcher;

import com.ghatana.media.runtime.InMemoryMediaRequestLedger;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Acquired;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Claim;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Erased;
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
import java.time.Instant;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.ServiceLoader;
import java.util.UUID;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
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
 *
 * <p><b>Retention.</b> Terminal rows (COMPLETED, RELEASED) last updated more than
 * {@code MEDIA_DEV_REQUEST_LEDGER_RETENTION_DAYS} days ago (default 30) are pruned by a single daemon thread, at most
 * {@link #MAX_PRUNE_BATCH} rows per pass. IN_PROGRESS rows are never pruned, whatever their age, and an ERASED
 * tombstone is kept forever so an erased output is never produced again. Once its row is pruned, a retry with the
 * same requestId is a NEW request: it claims the key again (attempt and fence restart), the model runs again, and
 * the fingerprint is no longer compared against the old run, so a different request under the same id is accepted
 * instead of answered 409. Artifacts are never deleted by pruning. Registration is still guarded by the upload
 * idempotency key (derived from tenant, principal and requestId, not from the fingerprint), for as long as the upload
 * store still holds that record: a retry that produces byte-identical output replays the existing artifact, while
 * different bytes or different upload metadata are refused by the upload store as an Idempotency-Key conflict and no
 * second artifact is registered. Once the artifact itself has expired or been erased, a retry registers a new one.</p>
 */
final class MediaDevRequestLedger implements AutoCloseable {
    static final String ENV_BACKEND = "MEDIA_DEV_REQUEST_LEDGER";
    static final String ENV_LEASE_SECONDS = "MEDIA_DEV_REQUEST_LEDGER_LEASE_SECONDS";
    static final String ENV_WAIT_SECONDS = "MEDIA_DEV_REQUEST_LEDGER_WAIT_SECONDS";
    static final String POSTGRESQL_FACTORY = "postgresql-dev-request-ledger";
    static final Duration DEFAULT_LEASE = Duration.ofMinutes(15);
    static final Duration DEFAULT_WAIT = Duration.ofSeconds(20);
    /** Retention of terminal rows, in whole days: {@code MEDIA_DEV_REQUEST_LEDGER_RETENTION_DAYS}, 1-3650. */
    static final String ENV_RETENTION_DAYS = "MEDIA_DEV_REQUEST_LEDGER_RETENTION_DAYS";
    static final Duration DEFAULT_RETENTION = Duration.ofDays(30);
    /** Upper bound of rows deleted by one prune pass. */
    static final int MAX_PRUNE_BATCH = 500;
    static final Duration PRUNE_INITIAL_DELAY = Duration.ofMinutes(1);
    static final Duration PRUNE_INTERVAL = Duration.ofHours(1);
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
    private final Duration retention;
    private static final String LOCAL_HOST = localHost();

    private final String owner = localOwner();
    private final boolean durable;
    private volatile ScheduledExecutorService pruner;

    MediaDevRequestLedger(RequestLedger ledger, Duration lease, Duration maxWait, boolean durable) {
        this(ledger, lease, maxWait, durable, DEFAULT_RETENTION);
    }

    MediaDevRequestLedger(RequestLedger ledger, Duration lease, Duration maxWait, boolean durable, Duration retention) {
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.lease = Objects.requireNonNull(lease, "lease");
        this.maxWait = Objects.requireNonNull(maxWait, "maxWait");
        this.retention = Objects.requireNonNull(retention, "retention");
        this.durable = durable;
        if (retention.isZero() || retention.isNegative()) throw new IllegalArgumentException("retention must be positive");
        if (lease.isZero() || lease.isNegative()) throw new IllegalArgumentException("lease must be positive");
        if (maxWait.isNegative()) throw new IllegalArgumentException("maxWait must not be negative");
    }

    /**
     * Owner identity of this launcher process: {@code launcher/<host>/<pid>/<process start millis>/<nonce>}. A later
     * process on the same host can prove the owner is gone (no such pid, or the pid was reused by a process with a
     * different start time) and take its run over immediately instead of waiting for the lease to expire.
     */
    static String localOwner() {
        String start = ProcessHandle.current().info().startInstant().map(i -> Long.toString(i.toEpochMilli())).orElse("0");
        return "launcher/" + LOCAL_HOST + "/" + ProcessHandle.current().pid() + "/" + start + "/"
                + UUID.randomUUID().toString().substring(0, 8);
    }

    private static String localHost() {
        try {
            return java.net.InetAddress.getLocalHost().getHostName().replace('/', '_');
        } catch (java.io.IOException | RuntimeException unknown) {
            return "unknown-host";
        }
    }

    /** True only when {@code owner} names a process on THIS host that provably no longer runs. */
    static boolean ownerProcessIsGone(String owner) {
        String[] parts = owner == null ? new String[0] : owner.split("/");
        if (parts.length != 5 || !"launcher".equals(parts[0]) || !LOCAL_HOST.equals(parts[1])) return false;
        try {
            long pid = Long.parseLong(parts[2]);
            long recordedStart = Long.parseLong(parts[3]);
            if (pid == ProcessHandle.current().pid()) return false;
            var handle = ProcessHandle.of(pid);
            if (handle.isEmpty() || !handle.get().isAlive()) return true;
            var started = handle.get().info().startInstant();
            // A live process whose start time differs by more than a second is a reused pid, not the owner.
            return started.isPresent() && recordedStart != 0
                    && Math.abs(started.get().toEpochMilli() - recordedStart) > 1_000;
        } catch (NumberFormatException malformed) {
            return false;
        }
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
        Duration retention = retention(environment);
        boolean datasourceConfigured = !environment.getOrDefault("MEDIA_POSTGRES_JDBC_URL", "").isBlank();
        RequestLedger store;
        boolean durable;
        switch (mode) {
            case "memory" -> {
                log.warn("DEV request ledger is process-local (non-durable) by explicit configuration");
                store = new InMemoryMediaRequestLedger();
                durable = false;
            }
            case "postgresql" -> {
                store = openPostgresql(environment);
                durable = true;
            }
            case "auto" -> {
                if (datasourceConfigured) {
                    store = openPostgresql(environment);
                    durable = true;
                } else {
                    log.warn("DEV request ledger is process-local (non-durable): no canonical PostgreSQL datasource is configured");
                    store = new InMemoryMediaRequestLedger();
                    durable = false;
                }
            }
            default -> throw new IllegalArgumentException(ENV_BACKEND + " must be postgresql, memory or auto");
        }
        MediaDevRequestLedger ledger = new MediaDevRequestLedger(store, lease, wait, durable, retention);
        ledger.startPruning();
        return ledger;
    }

    /**
     * Starts the single daemon thread that prunes terminal rows past retention, one bounded batch per pass. It is
     * stopped by {@link #close}.
     */
    private void startPruning() {
        ScheduledExecutorService scheduler = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "media-dev-request-ledger-prune");
            thread.setDaemon(true);
            return thread;
        });
        scheduler.scheduleWithFixedDelay(this::pruneQuietly, PRUNE_INITIAL_DELAY.toMillis(),
                PRUNE_INTERVAL.toMillis(), TimeUnit.MILLISECONDS);
        pruner = scheduler;
    }

    private void pruneQuietly() {
        try {
            pruneOnce(Instant.now());
        } catch (RuntimeException failure) {
            // Pruning is best effort: a failed pass leaves rows in place and the next pass retries them.
            log.warn("DEV request ledger prune pass failed reason={}", failure.getClass().getSimpleName());
        }
    }

    /**
     * One prune pass: deletes at most {@link #MAX_PRUNE_BATCH} COMPLETED or RELEASED rows last updated before
     * {@code now - retention}. IN_PROGRESS and ERASED rows are never deleted. Returns the rows deleted.
     */
    int pruneOnce(Instant now) {
        int removed = ledger.pruneTerminal(now.minus(retention), MAX_PRUNE_BATCH);
        if (removed > 0) {
            log.info("DEV request ledger pruned {} terminal row(s) older than {} days", removed, retention.toDays());
        }
        return removed;
    }

    Duration retention() { return retention; }

    /** {@code MEDIA_DEV_REQUEST_LEDGER_RETENTION_DAYS}: an integer from 1 to 3650, default 30; malformed is refused. */
    static Duration retention(Map<String, String> environment) {
        String raw = environment.get(ENV_RETENTION_DAYS);
        if (raw == null || raw.isBlank()) return DEFAULT_RETENTION;
        try {
            long days = Long.parseLong(raw.trim());
            if (days < 1 || days > 3650) throw new NumberFormatException();
            return Duration.ofDays(days);
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException(ENV_RETENTION_DAYS + " must be an integer within [1, 3650]");
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
            if (claim instanceof InProgress stuck && ownerProcessIsGone(stuck.leaseOwner())) {
                // The run was owned by a launcher process on this host that no longer exists (killed or crashed): its
                // outcome is UNKNOWN, so take the run over now under a higher fencing token instead of waiting.
                log.warn("DEV request ledger reclaiming a run owned by a dead local process lane={}", lane);
                try {
                    claim = ledger.reclaim(key, fingerprint, stuck.leaseOwner(), stuck.fence(), owner, lease);
                } catch (RuntimeException failure) {
                    throw unavailable(failure);
                }
            }
            if (claim instanceof Erased) {
                // The registered output of this requestId was erased on request: never a replay, never a re-run.
                throw new LedgerRefusedException(410, "OUTPUT_ERASED",
                        "the output of this requestId was erased; it cannot be replayed or produced again under this requestId",
                        Map.of("lane", lane));
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

    /** The ledger row of a request of this principal, for provenance checks (never an authority for rights). */
    java.util.Optional<com.ghatana.media.runtime.MediaRequestLedgerContracts.Entry> find(String tenantId, String principalId,
                                                                                         String lane, String requestId) {
        try {
            return ledger.find(new Key(tenantId, principalId, lane, requestId));
        } catch (RuntimeException failure) {
            throw unavailable(failure);
        }
    }

    /** Marks the replay rows of erased outputs as erased in a process-local ledger; durable rows are erased in the erasure transaction. */
    int eraseOutputs(String tenantId, java.util.Set<String> artifactIds) {
        return ledger.eraseOutputs(tenantId, artifactIds);
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
        ScheduledExecutorService scheduler = pruner;
        if (scheduler != null) scheduler.shutdownNow();
        ledger.close();
    }
}
