package com.ghatana.media.production.delivery;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;

/** Durable idempotency ledger for delivery operations; it never authorizes or dispatches an effect. */
public interface DeliveryOperationStore {
    Duration MAX_DISPATCH_CLAIM_LEASE = Duration.ofMinutes(5);

    record Operation(String tenantId, String principalId, String requestId, String artifactId,
                     String versionRef, String artifactDigest, String destinationRef,
                     String requestFingerprint, MediaDeliveryEngine.Status status,
                     int acknowledgedBytes, String destinationReceiptRef) {
        public Operation {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            requestId = required(requestId, "requestId");
            artifactId = required(artifactId, "artifactId");
            versionRef = required(versionRef, "versionRef");
            artifactDigest = required(artifactDigest, "artifactDigest");
            destinationRef = required(destinationRef, "destinationRef");
            requestFingerprint = required(requestFingerprint, "requestFingerprint");
            java.util.Objects.requireNonNull(status, "status");
            MediaDeliveryEngine.validateProgress(status, acknowledgedBytes);
            if (destinationReceiptRef != null) {
                destinationReceiptRef = MediaDeliveryEngine.requiredExact(destinationReceiptRef, "destinationReceiptRef");
            }
            if ((status == MediaDeliveryEngine.Status.DESTINATION_CONFIRMED) != (destinationReceiptRef != null)) {
                throw new IllegalArgumentException("only confirmed delivery carries a destination receipt");
            }
        }
    }

    /** Exact, monotonically fenced owner of one operation's destination boundary. */
    record DispatchClaim(String tenantId, String principalId, String requestId, String artifactId,
                         String versionRef, String artifactDigest, String destinationRef,
                         String requestFingerprint, String ownerId, long fence, Instant expiresAt) {
        public DispatchClaim {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            requestId = required(requestId, "requestId");
            artifactId = required(artifactId, "artifactId");
            versionRef = required(versionRef, "versionRef");
            artifactDigest = required(artifactDigest, "artifactDigest");
            destinationRef = required(destinationRef, "destinationRef");
            requestFingerprint = required(requestFingerprint, "requestFingerprint");
            ownerId = required(ownerId, "ownerId");
            if (fence < 1) throw new IllegalArgumentException("fence must be positive");
            java.util.Objects.requireNonNull(expiresAt, "expiresAt");
        }

        public boolean matches(Operation operation) {
            return tenantId.equals(operation.tenantId()) && principalId.equals(operation.principalId())
                    && requestId.equals(operation.requestId()) && artifactId.equals(operation.artifactId())
                    && versionRef.equals(operation.versionRef()) && artifactDigest.equals(operation.artifactDigest())
                    && destinationRef.equals(operation.destinationRef())
                    && requestFingerprint.equals(operation.requestFingerprint());
        }
    }

    Optional<Operation> find(String tenantId, String requestId);

    /** Inserts only when absent; false means another writer already owns this key. */
    boolean insertIfAbsent(Operation operation);

    /** Replaces exactly the matching request fingerprint; false means the stored scope changed. */
    boolean update(Operation operation);

    /** True only when claims are atomic across processes and survive store-client recreation. */
    default boolean supportsDurableDispatchClaims() { return false; }

    /** Atomically acquires an unowned or expired dispatch lease for the exact immutable operation scope. */
    default Optional<DispatchClaim> acquireDispatchClaim(Operation operation, String ownerId, Duration lease) {
        checkedLease(lease);
        return Optional.empty();
    }

    /** Extends a still-live claim without changing its fencing token; an expired claim cannot be revived. */
    default Optional<DispatchClaim> renewDispatchClaim(DispatchClaim claim, Duration lease) {
        checkedLease(lease);
        return Optional.empty();
    }

    /** Returns true only for the current owner/fence and exact immutable operation scope. */
    default boolean isDispatchClaimCurrent(DispatchClaim claim) { return false; }

    /** Releases only this exact owner/fence. Fencing counters are retained monotonically. */
    default boolean releaseDispatchClaim(DispatchClaim claim) { return false; }

    /** Updates operation state only while this claim remains the current live owner. */
    default boolean update(Operation operation, DispatchClaim claim) { return false; }

    /** Enforces monotonic offsets and legal operation state transitions for every store implementation. */
    static boolean isAllowedTransition(Operation current, Operation next) {
        if (current == null || next == null
                || !current.tenantId().equals(next.tenantId())
                || !current.principalId().equals(next.principalId())
                || !current.requestId().equals(next.requestId())
                || !current.artifactId().equals(next.artifactId())
                || !current.versionRef().equals(next.versionRef())
                || !current.artifactDigest().equals(next.artifactDigest())
                || !current.destinationRef().equals(next.destinationRef())
                || !current.requestFingerprint().equals(next.requestFingerprint())
                || next.acknowledgedBytes() < current.acknowledgedBytes()) return false;
        return switch (current.status()) {
            case QUEUED -> current.acknowledgedBytes() == 0 && next.acknowledgedBytes() == 0
                    && (next.status() == MediaDeliveryEngine.Status.OUTCOME_UNKNOWN
                    || next.status() == MediaDeliveryEngine.Status.UNAVAILABLE
                    || next.status() == MediaDeliveryEngine.Status.REVOKED);
            case OUTCOME_UNKNOWN -> next.status() == MediaDeliveryEngine.Status.OUTCOME_UNKNOWN
                    || next.status() == MediaDeliveryEngine.Status.SENT
                    || next.status() == MediaDeliveryEngine.Status.DESTINATION_CONFIRMED;
            case SENT -> next.status() == MediaDeliveryEngine.Status.OUTCOME_UNKNOWN
                    || next.status() == MediaDeliveryEngine.Status.SENT
                    || next.status() == MediaDeliveryEngine.Status.DESTINATION_CONFIRMED;
            case DESTINATION_CONFIRMED, REVOKED, UNAVAILABLE -> false;
        };
    }

    private static void validateLease(Duration lease) {
        if (lease == null || lease.isZero() || lease.isNegative() || lease.compareTo(MAX_DISPATCH_CLAIM_LEASE) > 0) {
            throw new IllegalArgumentException("dispatch claim lease must be positive and at most five minutes");
        }
    }

    static Duration checkedLease(Duration lease) {
        validateLease(lease);
        return lease;
    }

    private static String required(String value, String field) {
        if (value == null) throw new IllegalArgumentException(field + " must not be blank");
        String normalized = value.trim();
        if (normalized.isEmpty()) throw new IllegalArgumentException(field + " must not be blank");
        return normalized;
    }
}
