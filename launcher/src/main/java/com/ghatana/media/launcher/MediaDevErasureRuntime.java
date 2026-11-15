package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaErasureContracts.DeliveryRef;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureAuthority;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureAuthorityFactory;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureOperation;
import com.ghatana.media.runtime.MediaErasureContracts.ErasurePlan;
import com.ghatana.media.runtime.MediaErasureContracts.ErasureReceipt;
import com.ghatana.media.runtime.MediaErasureContracts.LegalHold;
import com.ghatana.media.runtime.MediaErasureContracts.LocalWork;
import com.ghatana.media.runtime.MediaErasureContracts.Phase;
import com.ghatana.media.runtime.MediaErasureContracts.ReceiptItem;
import com.ghatana.media.runtime.MediaErasureContracts.Tombstone;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.nio.file.Path;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.function.Consumer;

/**
 * DEV_ONLY request-driven erasure and legal hold (J-26): composes the durable {@link ErasureAuthority} (PostgreSQL rows
 * and S3 objects) with the host-local copies the authority cannot reach: the speech spool, delivered files, the
 * process-local request ledger and any derived cache.
 *
 * <p>The order is fixed: the authority removes every metadata row of the tree in one transaction, then its stored
 * objects, then this host removes its local copies, then the receipt is finalised. A crash between steps leaves a
 * durable operation; {@link #resumeIncomplete} (run at start-up) and the same erasure id finish it. Revoking a rights
 * statement is a different act and never reaches this class.</p>
 */
final class MediaDevErasureRuntime implements AutoCloseable {
    static final String ENV_ENABLED = "MEDIA_DEV_ERASURE_ENABLED";
    /**
     * DEV_ONLY fault injection used by the real-process tests: {@code AFTER_DB_ERASED} or {@code AFTER_OBJECTS_ERASED}
     * halts the JVM at that point of an erasure. Honored only in the dev profile.
     */
    static final String ENV_CRASH_AT = "MEDIA_DEV_ERASURE_CRASH_AT";
    private static final Logger log = LoggerFactory.getLogger(MediaDevErasureRuntime.class);

    /** A host-local copy of erased content. Receives names and digests only. */
    interface LocalCopyEraser {
        String kind();

        /** Removes the copies named by {@code work}; returns the digests removed (empty for non-object copies). */
        List<String> erase(String tenantId, LocalWork work);
    }

    private final ErasureAuthority authority;
    private final List<LocalCopyEraser> erasers;
    private final String crashAt;

    MediaDevErasureRuntime(ErasureAuthority authority, List<LocalCopyEraser> erasers, String crashAt) {
        this.authority = Objects.requireNonNull(authority, "authority");
        this.erasers = List.copyOf(erasers);
        this.crashAt = crashAt == null ? "" : crashAt.trim();
    }

    /** Composes the runtime, or returns null when erasure is not enabled for this launcher. */
    static MediaDevErasureRuntime compose(Map<String, String> environment, MediaDevRequestLedger ledger,
                                          MediaDevDeliveryRuntime delivery, Consumer<String> tenantCacheInvalidator) {
        if (!"true".equalsIgnoreCase(environment.getOrDefault(ENV_ENABLED, "false"))) return null;
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "")).trim().toLowerCase(Locale.ROOT);
        if (!"dev".equals(profile)
                || !"true".equalsIgnoreCase(environment.getOrDefault("MEDIA_DEV_IDENTITY_ENABLED", "false"))) {
            throw new IllegalArgumentException(ENV_ENABLED + " requires profile=dev and MEDIA_DEV_IDENTITY_ENABLED=true");
        }
        List<ErasureAuthorityFactory> factories = ServiceLoader.load(ErasureAuthorityFactory.class).stream()
                .map(ServiceLoader.Provider::get)
                .filter(factory -> "postgresql-dev-erasure".equals(factory.factoryId()))
                .toList();
        if (factories.size() != 1) {
            throw new IllegalStateException("exactly one PostgreSQL DEV_ONLY erasure authority factory is required");
        }
        ErasureAuthority authority = factories.getFirst().createDevOnly(Map.copyOf(environment));
        List<LocalCopyEraser> erasers = new ArrayList<>();
        MediaDevSpeechSpool spool = MediaDevSpeechSpool.fromEnvironment(environment);
        erasers.add(new LocalCopyEraser() {
            @Override public String kind() { return "LOCAL_SPOOL_ENTRY"; }
            @Override public List<String> erase(String tenantId, LocalWork work) {
                return spool.eraseByDigests(new HashSet<>(work.digests()));
            }
        });
        String destination = environment.get(MediaDevDeliveryRuntime.DESTINATION_DIR);
        Path destinationRoot = destination != null && !destination.isEmpty()
                ? MediaDevLocalDirectoryDestination.confineRoot(destination) : null;
        if (destinationRoot != null || delivery != null) {
            erasers.add(new LocalCopyEraser() {
                @Override public String kind() { return "DELIVERED_OBJECT"; }
                @Override public List<String> erase(String tenantId, LocalWork work) {
                    List<String> removed = new ArrayList<>();
                    for (DeliveryRef ref : work.deliveries()) {
                        // The engine keeps the exported artifact bytes in memory for resumption: drop them too.
                        if (delivery != null) delivery.evict(tenantId, ref.requestId());
                        if (destinationRoot == null) continue;
                        int files = MediaDevLocalDirectoryDestination.eraseDelivered(
                                destinationRoot, tenantId, ref.principalId(), ref.requestId());
                        for (int i = 0; i < files; i++) removed.add(ref.requestId());
                    }
                    return removed;
                }
            });
        }
        if (ledger != null) {
            erasers.add(new LocalCopyEraser() {
                @Override public String kind() { return "PROCESS_LEDGER_ROW"; }
                @Override public List<String> erase(String tenantId, LocalWork work) {
                    int changed = ledger.eraseOutputs(tenantId, new HashSet<>(work.artifactIds()));
                    return java.util.Collections.nCopies(changed, "");
                }
            });
        }
        if (tenantCacheInvalidator != null) {
            erasers.add(new LocalCopyEraser() {
                @Override public String kind() { return "CACHE_TENANT_INVALIDATION"; }
                @Override public List<String> erase(String tenantId, LocalWork work) {
                    tenantCacheInvalidator.accept(tenantId);
                    return List.of("");
                }
            });
        }
        MediaDevErasureRuntime runtime = new MediaDevErasureRuntime(authority, erasers,
                environment.get(ENV_CRASH_AT));
        runtime.resumeIncomplete();
        return runtime;
    }

    boolean ready() { return authority.ready(); }

    ErasurePlan plan(String tenantId, String principalId, String artifactId) {
        return authority.plan(tenantId, principalId, artifactId);
    }

    LegalHold placeHold(String tenantId, String principalId, String requestId, String artifactId, String reason,
                        AssuranceSource assurance) {
        return authority.placeHold(tenantId, principalId, requestId, artifactId, reason, assurance);
    }

    LegalHold releaseHold(String tenantId, String principalId, String holdId, String reason, AssuranceSource assurance) {
        return authority.releaseHold(tenantId, principalId, holdId, reason, assurance);
    }

    Optional<LegalHold> hold(String tenantId, String principalId, String holdId) {
        return authority.hold(tenantId, principalId, holdId);
    }

    List<LegalHold> holds(String tenantId, String principalId, String artifactId) {
        return authority.holds(tenantId, principalId, artifactId);
    }

    Optional<ErasureReceipt> receipt(String tenantId, String principalId, String erasureId) {
        return authority.receipt(tenantId, principalId, erasureId);
    }

    Optional<Tombstone> tombstone(String tenantId, String artifactId) {
        return authority.tombstone(tenantId, artifactId);
    }

    /**
     * Erases the tree rooted at {@code artifactId}. Refuses with {@code LEGAL_HOLD_ACTIVE} while an owner hold covers
     * it. Idempotent by {@code erasureId}: the same id resumes an interrupted erasure and returns its receipt.
     */
    ErasureReceipt erase(String tenantId, String principalId, String erasureId, String artifactId,
                         AssuranceSource assurance) {
        ErasureOperation operation = authority.begin(tenantId, principalId, erasureId, artifactId, assurance);
        crash("AFTER_DB_ERASED");
        return finish(operation);
    }

    /** Finishes every erasure a crash left incomplete. Returns how many were completed. */
    int resumeIncomplete() {
        int finished = 0;
        for (ErasureOperation operation : authority.incomplete()) {
            try {
                finish(operation);
                finished++;
                log.warn("DEV erasure resumed to completion erasureId={}", operation.erasureId());
            } catch (RuntimeException failure) {
                log.error("DEV erasure could not be resumed erasureId={} reason={}", operation.erasureId(),
                        failure.getClass().getSimpleName());
            }
        }
        return finished;
    }

    private ErasureReceipt finish(ErasureOperation operation) {
        ErasureOperation current = operation;
        if (current.phase() == Phase.DB_ERASED) {
            current = authority.eraseObjects(current);
            crash("AFTER_OBJECTS_ERASED");
        }
        if (current.phase() == Phase.COMPLETED) {
            return authority.receipt(current.tenantId(), current.principalId(), current.erasureId()).orElseThrow();
        }
        List<ReceiptItem> local = new ArrayList<>();
        for (LocalCopyEraser eraser : erasers) {
            List<String> removed = eraser.erase(current.tenantId(), current.localWork());
            if (!removed.isEmpty()) {
                List<String> digests = removed.stream().filter(value -> value.matches("[0-9a-f]{64}")).toList();
                local.add(new ReceiptItem(eraser.kind(), removed.size(), digests));
            }
        }
        return authority.complete(current, local);
    }

    private void crash(String point) {
        if (!crashAt.isEmpty() && crashAt.equals(point)) {
            log.error("DEV_ONLY erasure fault injection: halting at {}", point);
            Runtime.getRuntime().halt(137);
        }
    }

    @Override public void close() {
        authority.close();
    }
}
