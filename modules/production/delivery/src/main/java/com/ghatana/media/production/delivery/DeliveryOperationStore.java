package com.ghatana.media.production.delivery;

import java.util.Optional;

/** Durable idempotency ledger for delivery operations; it never authorizes or dispatches an effect. */
public interface DeliveryOperationStore {
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
            if (acknowledgedBytes < 0) throw new IllegalArgumentException("acknowledgedBytes must not be negative");
            if ((status == MediaDeliveryEngine.Status.DESTINATION_CONFIRMED) != (destinationReceiptRef != null)) {
                throw new IllegalArgumentException("only confirmed delivery carries a destination receipt");
            }
        }
    }

    Optional<Operation> find(String tenantId, String requestId);

    /** Inserts only when absent; false means another writer already owns this key. */
    boolean insertIfAbsent(Operation operation);

    /** Replaces exactly the matching request fingerprint; false means the stored scope changed. */
    boolean update(Operation operation);

    private static String required(String value, String field) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(field + " must not be blank");
        return value.trim();
    }
}
