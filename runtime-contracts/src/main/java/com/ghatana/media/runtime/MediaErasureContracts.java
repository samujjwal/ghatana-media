package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * Request-driven erasure of an artifact lineage tree and the owner-authorised legal hold that blocks it (J-26).
 *
 * <p>Erasure is an explicit act on an exact artifact: it removes that artifact and every artifact derived from it
 * (transcripts, WebVTT, corrected caption versions, synthesized audio, vision outputs, grounded answers, renders,
 * creative outputs), the metadata rows that point at them (lineage, transcripts, caption registrations, delivery
 * operations, review records, upload sessions, request-ledger replay rows) and then every stored object and local
 * copy. It is deliberately separate from rights revocation, which only stops new processing and replays and deletes
 * nothing. Nothing in this contract carries content: plans, holds and receipts name identifiers, kinds, counts and
 * SHA-256 digests only.</p>
 *
 * <p>The durable order is fixed so a crash can never leave bytes reachable: one database transaction first removes
 * every metadata row of the tree and records a manifest ({@link Phase#DB_ERASED}); the objects and local copies named
 * by that manifest are then removed idempotently and resumably ({@link Phase#OBJECTS_ERASED},
 * {@link Phase#COMPLETED}).</p>
 */
public final class MediaErasureContracts {
    private MediaErasureContracts() { }

    /** Typed refusal; carries no content. */
    public static final class ErasureRefusedException extends RuntimeException {
        private final int status;
        private final String code;
        private final transient Map<String, Object> details;

        public ErasureRefusedException(int status, String code, String message, Map<String, Object> details) {
            super(message, null, false, false);
            this.status = status;
            this.code = Objects.requireNonNull(code, "code");
            this.details = Map.copyOf(details == null ? Map.of() : details);
        }

        public int status() { return status; }
        public String code() { return code; }
        public Map<String, Object> details() { return details; }
    }

    /** One artifact of the tree: identifiers, kind and content digest only. */
    public record TreeNode(String artifactId, String kind, String contentType, String sha256, long sizeBytes,
                           List<String> derivedFrom) {
        public TreeNode { derivedFrom = List.copyOf(derivedFrom); }
    }

    /** What an erasure of one root would remove, without removing anything. */
    public record ErasurePlan(String rootArtifactId, List<TreeNode> artifacts, Map<String, Integer> dependentRecords,
                              List<LegalHold> blockingHolds, boolean erasable) {
        public ErasurePlan {
            artifacts = List.copyOf(artifacts);
            dependentRecords = Map.copyOf(dependentRecords);
            blockingHolds = List.copyOf(blockingHolds);
        }
    }

    public enum HoldState { ACTIVE, RELEASED }

    /** An owner-authorised legal hold on the tree rooted at one artifact. */
    public record LegalHold(String holdId, String rootArtifactId, String reason, String placedBy,
                            AssuranceSource placedAssurance, Instant placedAt, HoldState state, String releasedBy,
                            AssuranceSource releasedAssurance, String releaseReason, Instant releasedAt,
                            boolean replayed) { }

    public enum Phase { DB_ERASED, OBJECTS_ERASED, COMPLETED }

    /** One removed kind in a receipt: how many, and the digests of the removed objects (never content). */
    public record ReceiptItem(String kind, int count, List<String> digests) {
        public ReceiptItem { digests = List.copyOf(digests); }
    }

    /** Local copies the host must remove after the database transaction (names only; no content). */
    public record LocalWork(List<String> artifactIds, List<String> digests, List<DeliveryRef> deliveries) {
        public LocalWork {
            artifactIds = List.copyOf(artifactIds);
            digests = List.copyOf(digests);
            deliveries = List.copyOf(deliveries);
        }
    }

    public record DeliveryRef(String principalId, String requestId) { }

    /** A durable erasure operation as recorded by the transaction that removed the metadata. */
    public record ErasureOperation(String tenantId, String erasureId, String principalId, String rootArtifactId,
                                   Phase phase, LocalWork localWork, boolean resumed) { }

    /** Final, content-free proof of what was erased. */
    public record ErasureReceipt(String erasureId, String rootArtifactId, Phase phase, String requestedBy,
                                 Instant requestedAt, Instant completedAt, List<ReceiptItem> items) {
        public ErasureReceipt { items = List.copyOf(items); }

        public int totalRemoved() { return items.stream().mapToInt(ReceiptItem::count).sum(); }
    }

    /** Proof that an artifact id was erased: the id, the erasure and the digest it had. */
    public record Tombstone(String artifactId, String erasureId, String kind, String sha256, Instant erasedAt) { }

    /** Provider of tree erasure and legal holds. */
    public interface ErasureAuthority extends AutoCloseable {
        String authorityId();

        boolean ready();

        /** Read-only preview of the exact tree an erasure would remove, and whether a legal hold blocks it. */
        ErasurePlan plan(String tenantId, String principalId, String artifactId);

        /**
         * Places an owner-authorised hold on the tree rooted at {@code artifactId}. Idempotent by
         * {@code (principal, requestId)}; the same request with different content is refused.
         */
        LegalHold placeHold(String tenantId, String principalId, String requestId, String artifactId, String reason,
                            AssuranceSource assurance);

        /** Releases an active hold; the releasing principal and assurance are recorded. */
        LegalHold releaseHold(String tenantId, String principalId, String holdId, String releaseReason,
                              AssuranceSource assurance);

        Optional<LegalHold> hold(String tenantId, String principalId, String holdId);

        /** Holds (any state) whose root is this artifact. */
        List<LegalHold> holds(String tenantId, String principalId, String artifactId);

        /**
         * Phase one: refuses with {@code LEGAL_HOLD_ACTIVE} when any hold covers the tree, otherwise removes every
         * metadata row of the tree in one transaction and records the manifest. Idempotent by {@code erasureId}: the
         * same id and root resumes the existing operation.
         */
        ErasureOperation begin(String tenantId, String principalId, String erasureId, String artifactId,
                               AssuranceSource assurance);

        /** Phase two: deletes every stored object named by the manifest (idempotent). */
        ErasureOperation eraseObjects(ErasureOperation operation);

        /**
         * Phase three: records the local copies removed by the host ({@code kind -> count}, with digests for
         * objects) and finalises the receipt.
         */
        ErasureReceipt complete(ErasureOperation operation, List<ReceiptItem> localItems);

        Optional<ErasureReceipt> receipt(String tenantId, String principalId, String erasureId);

        /** Operations whose phase is not {@link Phase#COMPLETED}, across tenants, for crash recovery. */
        List<ErasureOperation> incomplete();

        Optional<Tombstone> tombstone(String tenantId, String artifactId);

        @Override void close();
    }

    /** ServiceLoader SPI for the durable DEV_ONLY erasure authority over the canonical runtime persistence. */
    public interface ErasureAuthorityFactory {
        String factoryId();

        ErasureAuthority createDevOnly(Map<String, String> environment);
    }
}
