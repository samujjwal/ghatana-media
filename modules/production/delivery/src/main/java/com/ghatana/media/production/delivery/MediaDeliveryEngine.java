package com.ghatana.media.production.delivery;

import com.ghatana.media.runtime.MediaCreationContracts;

import java.time.Instant;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/** Bounded, destination-acknowledged delivery coordinator. No network destination is supplied here. */
public final class MediaDeliveryEngine {
    public static final int MAX_ARTIFACT_BYTES = 64 * 1024 * 1024;
    public static final int CHUNK_BYTES = 1024 * 1024;

    public enum Status { QUEUED, SENT, DESTINATION_CONFIRMED, OUTCOME_UNKNOWN, REVOKED, UNAVAILABLE }

    public static final class DeliveryException extends RuntimeException {
        public enum Code { INVALID_REQUEST, IDEMPOTENCY_CONFLICT, AUTHORIZATION_DENIED, AUTHORIZATION_UNAVAILABLE, INVALID_DESTINATION_EVIDENCE }
        private final Code code;
        public DeliveryException(Code code, String message) { super(message); this.code = code; }
        public Code code() { return code; }
    }

    /** Immutable byte snapshot. Tenant and exact version are part of the artifact identity. */
    public record Artifact(String tenantId, String artifactId, String versionRef, String digest, byte[] bytes) {
        public Artifact {
            tenantId = required(tenantId, "tenantId");
            artifactId = required(artifactId, "artifactId");
            versionRef = required(versionRef, "versionRef");
            Objects.requireNonNull(bytes, "bytes");
            if (bytes.length == 0 || bytes.length > MAX_ARTIFACT_BYTES) {
                throw new DeliveryException(DeliveryException.Code.INVALID_REQUEST, "artifact size is outside delivery bounds");
            }
            bytes = bytes.clone();
            String computed = MediaCreationContracts.sha256(bytes);
            if (!computed.equals(digest)) throw new DeliveryException(DeliveryException.Code.INVALID_REQUEST, "artifact digest does not match immutable bytes");
        }
        @Override public byte[] bytes() { return bytes.clone(); }
        int size() { return bytes.length; }
        byte[] chunk(int offset, int count) { return Arrays.copyOfRange(bytes, offset, offset + count); }
    }

    public record ExportRequest(String tenantId, String principalId, String requestId, Artifact artifact, String destinationRef) {
        public ExportRequest {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            requestId = required(requestId, "requestId");
            Objects.requireNonNull(artifact, "artifact");
            destinationRef = required(destinationRef, "destinationRef");
            if (!tenantId.equals(artifact.tenantId())) throw new DeliveryException(DeliveryException.Code.INVALID_REQUEST, "artifact tenant differs from export tenant");
        }
    }

    /** Exact scope returned by the host authorization service; this engine never mints authority. */
    public record TransferAuthorization(String tokenId, String tenantId, String principalId, String requestId,
                                        String artifactId, String versionRef, String artifactDigest,
                                        String destinationRef, Instant validUntil) {
        public TransferAuthorization {
            tokenId = required(tokenId, "tokenId");
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            requestId = required(requestId, "requestId");
            artifactId = required(artifactId, "artifactId");
            versionRef = required(versionRef, "versionRef");
            artifactDigest = required(artifactDigest, "artifactDigest");
            destinationRef = required(destinationRef, "destinationRef");
            Objects.requireNonNull(validUntil, "validUntil");
        }
    }

    public interface AuthorizationPort {
        TransferAuthorization authorize(ExportRequest request);
        /** Null means authority currentness could not be determined. */
        Boolean isCurrent(TransferAuthorization authorization, Instant now);
    }

    /** Destination evidence must be generated and returned by the destination authority. */
    public record ChunkReceipt(String receiptRef, String tenantId, String principalId, String requestId,
                               String artifactId, String versionRef, String destinationRef,
                               String artifactDigest, int offset, String chunkDigest, int acceptedBytes, int nextOffset) {
        public ChunkReceipt {
            receiptRef = required(receiptRef, "receiptRef");
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            requestId = required(requestId, "requestId");
            artifactId = required(artifactId, "artifactId");
            versionRef = required(versionRef, "versionRef");
            destinationRef = required(destinationRef, "destinationRef");
            artifactDigest = required(artifactDigest, "artifactDigest");
            chunkDigest = required(chunkDigest, "chunkDigest");
        }
    }

    public record DestinationReceipt(String receiptRef, String tenantId, String principalId, String requestId, String artifactId,
                                    String versionRef, String artifactDigest, String destinationRef,
                                    long acceptedBytes, String checksum) {
        public DestinationReceipt {
            receiptRef = required(receiptRef, "receiptRef");
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            requestId = required(requestId, "requestId");
            artifactId = required(artifactId, "artifactId");
            versionRef = required(versionRef, "versionRef");
            artifactDigest = required(artifactDigest, "artifactDigest");
            destinationRef = required(destinationRef, "destinationRef");
            checksum = required(checksum, "checksum");
        }
    }

    public record Reconciliation(int nextOffset, Optional<DestinationReceipt> finalReceipt) {
        public Reconciliation {
            if (nextOffset < 0) throw new IllegalArgumentException("nextOffset must not be negative");
            finalReceipt = finalReceipt == null ? Optional.empty() : finalReceipt;
        }
    }

    public interface DestinationPort {
        ChunkReceipt sendChunk(ExportRequest request, int offset, byte[] chunk, String chunkDigest,
                               TransferAuthorization authorization);
        Reconciliation reconcile(ExportRequest request);
    }

    public record DeliveryResult(String tenantId, String principalId, String requestId, String artifactId,
                                 String versionRef, String artifactDigest, String destinationRef,
                                 Status status, int acknowledgedBytes, Optional<String> destinationReceiptRef) {
        public DeliveryResult {
            destinationReceiptRef = destinationReceiptRef == null ? Optional.empty() : destinationReceiptRef;
            if ((status == Status.DESTINATION_CONFIRMED) != destinationReceiptRef.isPresent()) {
                throw new IllegalArgumentException("only confirmed delivery carries a destination receipt");
            }
            if (acknowledgedBytes < 0) throw new IllegalArgumentException("acknowledgedBytes must not be negative");
        }
    }

    private static final class Entry {
        final ExportRequest request;
        DeliveryResult result;
        Entry(ExportRequest request, DeliveryResult result) { this.request = request; this.result = result; }
    }

    private final AuthorizationPort authorization;
    private final DestinationPort destination;
    private final java.util.function.Supplier<Instant> clock;
    private final Map<String, Entry> entries = new HashMap<>();

    public MediaDeliveryEngine(AuthorizationPort authorization, DestinationPort destination,
                               java.util.function.Supplier<Instant> clock) {
        this.authorization = Objects.requireNonNull(authorization, "authorization");
        this.destination = Objects.requireNonNull(destination, "destination");
        this.clock = Objects.requireNonNull(clock, "clock");
    }

    /** Enqueue and dispatch once. A duplicate exact request reuses its state; a key collision fails. */
    public synchronized DeliveryResult export(ExportRequest request) {
        Objects.requireNonNull(request, "request");
        Entry existing = entries.get(key(request));
        if (existing != null) {
            assertSame(existing.request, request);
            return existing.result;
        }
        Entry entry = new Entry(request, result(request, Status.QUEUED, 0, null));
        entries.put(key(request), entry);
        TransferAuthorization grant;
        try {
            grant = authorization.authorize(request);
        } catch (RuntimeException denied) {
            entry.result = result(request, Status.UNAVAILABLE, 0, null);
            throw new DeliveryException(DeliveryException.Code.AUTHORIZATION_UNAVAILABLE, "transfer authorization is unavailable");
        }
        if (grant == null) {
            entry.result = result(request, Status.UNAVAILABLE, 0, null);
            throw new DeliveryException(DeliveryException.Code.AUTHORIZATION_UNAVAILABLE, "transfer authorization is unavailable");
        }
        try { validateScope(grant, request); }
        catch (DeliveryException denied) {
            entry.result = result(request, Status.REVOKED, 0, null);
            throw denied;
        }
        AuthorizationCurrentness currentness = currentness(grant);
        if (currentness != AuthorizationCurrentness.CURRENT) {
            Status status = currentness == AuthorizationCurrentness.REVOKED ? Status.REVOKED : Status.UNAVAILABLE;
            entry.result = result(request, status, 0, null);
            DeliveryException.Code code = status == Status.REVOKED
                    ? DeliveryException.Code.AUTHORIZATION_DENIED : DeliveryException.Code.AUTHORIZATION_UNAVAILABLE;
            throw new DeliveryException(code, status == Status.REVOKED
                    ? "transfer authorization is revoked or expired" : "transfer authorization currentness is unavailable");
        }
        transfer(entry, grant, 0);
        return entry.result;
    }

    /** Resolve uncertainty first; any resumed send uses the same idempotency identity and verified offset. */
    public synchronized DeliveryResult reconcileAndResume(String tenantId, String requestId) {
        Entry entry = entries.get(required(tenantId, "tenantId") + "\u0000" + required(requestId, "requestId"));
        if (entry == null) throw new DeliveryException(DeliveryException.Code.INVALID_REQUEST, "unknown export request");
        if (entry.result.status() != Status.OUTCOME_UNKNOWN && entry.result.status() != Status.SENT) return entry.result;
        Reconciliation reconciliation;
        try { reconciliation = destination.reconcile(entry.request); }
        catch (RuntimeException unavailable) { entry.result = result(entry.request, Status.OUTCOME_UNKNOWN, entry.result.acknowledgedBytes(), null); return entry.result; }
        if (reconciliation == null) {
            entry.result = result(entry.request, Status.OUTCOME_UNKNOWN, entry.result.acknowledgedBytes(), null);
            return entry.result;
        }
        int artifactSize = entry.request.artifact().size();
        int reconciledOffset = reconciliation.nextOffset();
        boolean invalidOffset = reconciledOffset > artifactSize
                || reconciledOffset < entry.result.acknowledgedBytes()
                || (reconciledOffset != artifactSize && reconciledOffset % CHUNK_BYTES != 0)
                || (entry.result.status() == Status.SENT && reconciledOffset != entry.result.acknowledgedBytes());
        if (invalidOffset) {
            entry.result = result(entry.request, Status.OUTCOME_UNKNOWN, entry.result.acknowledgedBytes(), null);
            return entry.result;
        }
        if (reconciliation.finalReceipt().isPresent()) {
            entry.result = confirmOrUnknown(entry.request, reconciliation.finalReceipt().get(), reconciliation.nextOffset());
            return entry.result;
        }
        TransferAuthorization grant;
        try { grant = authorization.authorize(entry.request); validateScope(grant, entry.request); }
        catch (RuntimeException denied) { entry.result = result(entry.request, Status.OUTCOME_UNKNOWN, reconciliation.nextOffset(), null); return entry.result; }
        if (currentness(grant) != AuthorizationCurrentness.CURRENT) {
            entry.result = result(entry.request, Status.OUTCOME_UNKNOWN, reconciliation.nextOffset(), null);
            return entry.result;
        }
        transfer(entry, grant, reconciliation.nextOffset());
        return entry.result;
    }

    public synchronized Optional<DeliveryResult> find(String tenantId, String requestId) {
        Entry entry = entries.get(required(tenantId, "tenantId") + "\u0000" + required(requestId, "requestId"));
        return Optional.ofNullable(entry).map(e -> e.result);
    }

    private void transfer(Entry entry, TransferAuthorization grant, int start) {
        ExportRequest request = entry.request;
        int offset = start;
        byte[] bytes = request.artifact().bytes();
        while (offset < bytes.length) {
            AuthorizationCurrentness currentness = currentness(grant);
            if (currentness != AuthorizationCurrentness.CURRENT) {
                Status status = offset > 0 ? Status.OUTCOME_UNKNOWN
                        : currentness == AuthorizationCurrentness.REVOKED ? Status.REVOKED : Status.UNAVAILABLE;
                entry.result = result(request, status, offset, null);
                return;
            }
            int count = Math.min(CHUNK_BYTES, bytes.length - offset);
            byte[] chunk = request.artifact().chunk(offset, count);
            String chunkDigest = MediaCreationContracts.sha256(chunk);
            ChunkReceipt receipt;
            try { receipt = destination.sendChunk(request, offset, chunk, chunkDigest, grant); }
            catch (RuntimeException lostAck) { entry.result = result(request, Status.OUTCOME_UNKNOWN, offset, null); return; }
            if (!validChunkReceipt(receipt, request, offset, count, chunkDigest)) {
                entry.result = result(request, Status.OUTCOME_UNKNOWN, offset, null);
                return;
            }
            offset = receipt.nextOffset();
            entry.result = result(request, Status.SENT, offset, null);
        }
        // Requiring destination reconciliation prevents transport completion from becoming confirmation.
        Reconciliation finalState;
        try { finalState = destination.reconcile(request); }
        catch (RuntimeException unavailable) { entry.result = result(request, Status.OUTCOME_UNKNOWN, offset, null); return; }
        if (finalState == null) { entry.result = result(request, Status.OUTCOME_UNKNOWN, offset, null); return; }
        if (finalState.finalReceipt().isEmpty()) {
            entry.result = result(request, Status.OUTCOME_UNKNOWN, offset, null);
            return;
        }
        entry.result = confirmOrUnknown(request, finalState.finalReceipt().get(), finalState.nextOffset());
    }

    private DeliveryResult confirmOrUnknown(ExportRequest request, DestinationReceipt receipt, int offset) {
        if (!validFinalReceipt(receipt, request) || offset != request.artifact().size()) {
            return result(request, Status.OUTCOME_UNKNOWN, Math.min(offset, request.artifact().size()), null);
        }
        return result(request, Status.DESTINATION_CONFIRMED, offset, receipt.receiptRef());
    }

    private boolean validChunkReceipt(ChunkReceipt receipt, ExportRequest request, int offset, int count, String digest) {
        return receipt != null && receipt.tenantId().equals(request.tenantId())
                && receipt.principalId().equals(request.principalId())
                && receipt.requestId().equals(request.requestId())
                && receipt.artifactId().equals(request.artifact().artifactId())
                && receipt.versionRef().equals(request.artifact().versionRef())
                && receipt.destinationRef().equals(request.destinationRef())
                && receipt.artifactDigest().equals(request.artifact().digest())
                && receipt.offset() == offset && receipt.chunkDigest().equals(digest)
                && receipt.acceptedBytes() == count && receipt.nextOffset() == offset + count;
    }

    private boolean validFinalReceipt(DestinationReceipt r, ExportRequest request) {
        return r.tenantId().equals(request.tenantId()) && r.requestId().equals(request.requestId())
                && r.principalId().equals(request.principalId())
                && r.artifactId().equals(request.artifact().artifactId())
                && r.versionRef().equals(request.artifact().versionRef())
                && r.artifactDigest().equals(request.artifact().digest())
                && r.destinationRef().equals(request.destinationRef())
                && r.acceptedBytes() == request.artifact().size() && r.checksum().equals(request.artifact().digest());
    }

    private enum AuthorizationCurrentness { CURRENT, REVOKED, UNAVAILABLE }

    private AuthorizationCurrentness currentness(TransferAuthorization grant) {
        if (grant == null) return AuthorizationCurrentness.UNAVAILABLE;
        final Instant now;
        try { now = Objects.requireNonNull(clock.get(), "clock result"); }
        catch (RuntimeException unavailable) { return AuthorizationCurrentness.UNAVAILABLE; }
        if (!now.isBefore(grant.validUntil())) return AuthorizationCurrentness.REVOKED;
        try {
            Boolean current = authorization.isCurrent(grant, now);
            return current == null ? AuthorizationCurrentness.UNAVAILABLE
                    : current ? AuthorizationCurrentness.CURRENT : AuthorizationCurrentness.REVOKED;
        }
        catch (RuntimeException unavailable) { return AuthorizationCurrentness.UNAVAILABLE; }
    }

    private void validateScope(TransferAuthorization grant, ExportRequest request) {
        if (grant == null || !grant.tenantId().equals(request.tenantId()) || !grant.principalId().equals(request.principalId())
                || !grant.requestId().equals(request.requestId())
                || !grant.artifactId().equals(request.artifact().artifactId())
                || !grant.versionRef().equals(request.artifact().versionRef())
                || !grant.artifactDigest().equals(request.artifact().digest())
                || !grant.destinationRef().equals(request.destinationRef())) {
            throw new DeliveryException(DeliveryException.Code.AUTHORIZATION_DENIED, "transfer authorization scope does not match export");
        }
    }

    private static void assertSame(ExportRequest a, ExportRequest b) {
        if (!a.tenantId().equals(b.tenantId()) || !a.principalId().equals(b.principalId()) || !a.requestId().equals(b.requestId())
                || !a.destinationRef().equals(b.destinationRef()) || !a.artifact().artifactId().equals(b.artifact().artifactId())
                || !a.artifact().versionRef().equals(b.artifact().versionRef()) || !a.artifact().digest().equals(b.artifact().digest())) {
            throw new DeliveryException(DeliveryException.Code.IDEMPOTENCY_CONFLICT, "request id is already bound to different export content or destination");
        }
    }

    private static String key(ExportRequest r) { return r.tenantId() + "\u0000" + r.requestId(); }
    private static DeliveryResult result(ExportRequest r, Status status, int acknowledged, String receipt) {
        return new DeliveryResult(r.tenantId(), r.principalId(), r.requestId(), r.artifact().artifactId(),
                r.artifact().versionRef(), r.artifact().digest(), r.destinationRef(), status,
                acknowledged, Optional.ofNullable(receipt));
    }
    private static String required(String value, String field) {
        Objects.requireNonNull(value, field);
        if (value.isBlank()) throw new IllegalArgumentException(field + " must not be blank");
        return value.trim();
    }
}
