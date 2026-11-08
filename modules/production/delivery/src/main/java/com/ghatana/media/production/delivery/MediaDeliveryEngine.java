package com.ghatana.media.production.delivery;

import com.ghatana.media.runtime.MediaCreationContracts;

import java.time.Instant;
import java.util.Arrays;
import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.time.Duration;
import java.util.UUID;

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
            receiptRef = requiredExact(receiptRef, "receiptRef");
            tenantId = requiredExact(tenantId, "tenantId");
            principalId = requiredExact(principalId, "principalId");
            requestId = requiredExact(requestId, "requestId");
            artifactId = requiredExact(artifactId, "artifactId");
            versionRef = requiredExact(versionRef, "versionRef");
            destinationRef = requiredExact(destinationRef, "destinationRef");
            artifactDigest = requiredExact(artifactDigest, "artifactDigest");
            chunkDigest = requiredExact(chunkDigest, "chunkDigest");
        }
    }

    public record DestinationReceipt(String receiptRef, String tenantId, String principalId, String requestId, String artifactId,
                                    String versionRef, String artifactDigest, String destinationRef,
                                    long acceptedBytes, String checksum) {
        public DestinationReceipt {
            receiptRef = requiredExact(receiptRef, "receiptRef");
            tenantId = requiredExact(tenantId, "tenantId");
            principalId = requiredExact(principalId, "principalId");
            requestId = requiredExact(requestId, "requestId");
            artifactId = requiredExact(artifactId, "artifactId");
            versionRef = requiredExact(versionRef, "versionRef");
            artifactDigest = requiredExact(artifactDigest, "artifactDigest");
            destinationRef = requiredExact(destinationRef, "destinationRef");
            checksum = requiredExact(checksum, "checksum");
        }
    }

    public record Reconciliation(int nextOffset, Optional<DestinationReceipt> finalReceipt) {
        public Reconciliation {
            if (nextOffset < 0) throw new IllegalArgumentException("nextOffset must not be negative");
            finalReceipt = finalReceipt == null ? Optional.empty() : finalReceipt;
        }
    }

    /** Fenced response envelopes preserve the existing receipt DTOs and add the active dispatch token. */
    public record FencedChunkReceipt(ChunkReceipt receipt, long dispatchFence) {
        public FencedChunkReceipt {
            Objects.requireNonNull(receipt, "receipt");
            if (dispatchFence < 1) throw new IllegalArgumentException("dispatchFence must be positive");
        }
    }

    public record FencedDestinationReceipt(DestinationReceipt receipt, long dispatchFence) {
        public FencedDestinationReceipt {
            Objects.requireNonNull(receipt, "receipt");
            if (dispatchFence < 1) throw new IllegalArgumentException("dispatchFence must be positive");
        }
    }

    public record FencedReconciliation(int nextOffset, Optional<FencedDestinationReceipt> finalReceipt,
                                       long dispatchFence) {
        public FencedReconciliation {
            if (nextOffset < 0) throw new IllegalArgumentException("nextOffset must not be negative");
            if (dispatchFence < 1) throw new IllegalArgumentException("dispatchFence must be positive");
            finalReceipt = finalReceipt == null ? Optional.empty() : finalReceipt;
        }
    }

    public interface DestinationPort {
        ChunkReceipt sendChunk(ExportRequest request, int offset, byte[] chunk, String chunkDigest,
                               TransferAuthorization authorization);
        Reconciliation reconcile(ExportRequest request);
    }

    /**
     * Destination boundary that receives the durable operation fence on every read or write.
     * Implementations must reject stale fencing tokens and deduplicate by exact request/chunk identity.
     * A legacy DestinationPort remains source compatible, but is never called by this engine.
     */
    public interface FencedDestinationPort extends DestinationPort {
        FencedChunkReceipt sendChunk(ExportRequest request, int offset, byte[] chunk, String chunkDigest,
                                     TransferAuthorization authorization, DeliveryOperationStore.DispatchClaim claim);
        FencedReconciliation reconcile(ExportRequest request, DeliveryOperationStore.DispatchClaim claim);

        @Override default ChunkReceipt sendChunk(ExportRequest request, int offset, byte[] chunk, String chunkDigest,
                                                 TransferAuthorization authorization) {
            throw new UnsupportedOperationException("fenced dispatch claim is required");
        }

        @Override default Reconciliation reconcile(ExportRequest request) {
            throw new UnsupportedOperationException("fenced dispatch claim is required");
        }
    }

    public record DeliveryResult(String tenantId, String principalId, String requestId, String artifactId,
                                 String versionRef, String artifactDigest, String destinationRef,
                                 Status status, int acknowledgedBytes, Optional<String> destinationReceiptRef) {
        public DeliveryResult {
            tenantId = requiredExact(tenantId, "tenantId");
            principalId = requiredExact(principalId, "principalId");
            requestId = requiredExact(requestId, "requestId");
            artifactId = requiredExact(artifactId, "artifactId");
            versionRef = requiredExact(versionRef, "versionRef");
            artifactDigest = requiredExact(artifactDigest, "artifactDigest");
            destinationRef = requiredExact(destinationRef, "destinationRef");
            Objects.requireNonNull(status, "status");
            destinationReceiptRef = destinationReceiptRef == null ? Optional.empty() : destinationReceiptRef;
            destinationReceiptRef = destinationReceiptRef.map(receipt -> requiredExact(receipt, "destinationReceiptRef"));
            if ((status == Status.DESTINATION_CONFIRMED) != destinationReceiptRef.isPresent()) {
                throw new IllegalArgumentException("only confirmed delivery carries a destination receipt");
            }
            validateProgress(status, acknowledgedBytes);
        }
    }

    private static final class Entry {
        final ExportRequest request;
        final String fingerprint;
        DeliveryResult result;
        Entry(ExportRequest request, String fingerprint, DeliveryResult result) {
            this.request = request; this.fingerprint = fingerprint; this.result = result;
        }
    }

    private final AuthorizationPort authorization;
    private final DestinationPort destination;
    private final java.util.function.Supplier<Instant> clock;
    private final DeliveryOperationStore operations;
    private record OperationKey(String tenantId, String requestId) {}
    private final Map<OperationKey, Entry> entries = new HashMap<>();
    private final String dispatcherId = UUID.randomUUID().toString();
    private static final Duration DISPATCH_CLAIM_LEASE = Duration.ofMinutes(5);

    public MediaDeliveryEngine(AuthorizationPort authorization, DestinationPort destination,
                               java.util.function.Supplier<Instant> clock) {
        this(authorization, destination, clock, new InMemoryDeliveryOperationStore());
    }

    public MediaDeliveryEngine(AuthorizationPort authorization, DestinationPort destination,
                               java.util.function.Supplier<Instant> clock, DeliveryOperationStore operations) {
        this.authorization = Objects.requireNonNull(authorization, "authorization");
        this.destination = Objects.requireNonNull(destination, "destination");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.operations = Objects.requireNonNull(operations, "operations");
    }

    /** Enqueue and dispatch once. A duplicate exact request reuses its state; a key collision fails. */
    public synchronized DeliveryResult export(ExportRequest request) {
        Objects.requireNonNull(request, "request");
        Entry existing = loadEntry(request);
        if (existing != null) {
            assertSame(existing.request, request);
            refreshEntry(existing);
            return existing.result.status() == Status.QUEUED ? dispatchQueued(existing) : existing.result;
        }
        Entry entry = new Entry(request, fingerprint(request), result(request, Status.QUEUED, 0, null));
        if (!operations.insertIfAbsent(operation(entry))) {
            Entry raced = loadEntry(request);
            if (raced == null) throw new IllegalStateException("delivery operation could not be read after idempotency race");
            assertSame(raced.request, request);
            refreshEntry(raced);
            return raced.result.status() == Status.QUEUED ? dispatchQueued(raced) : raced.result;
        }
        entries.put(key(request), entry);
        return dispatchQueued(entry);
    }

    /** Resolve uncertainty first; any resumed send uses the same idempotency identity and verified offset. */
    public synchronized DeliveryResult reconcileAndResume(String tenantId, String requestId) {
        Entry entry = entries.get(new OperationKey(required(tenantId, "tenantId"), required(requestId, "requestId")));
        if (entry == null) throw new DeliveryException(DeliveryException.Code.INVALID_REQUEST, "unknown export request");
        return reconcileAndResume(entry);
    }

    /** Restart-safe reconciliation when the caller supplies the same immutable artifact snapshot. */
    public synchronized DeliveryResult reconcileAndResume(ExportRequest request) {
        Objects.requireNonNull(request, "request");
        Entry entry = loadEntry(request);
        if (entry == null) throw new DeliveryException(DeliveryException.Code.INVALID_REQUEST, "unknown export request");
        assertSame(entry.request, request);
        return reconcileAndResume(entry);
    }

    private DeliveryResult reconcileAndResume(Entry entry) {
        refreshEntry(entry);
        if (entry.result.status() == Status.QUEUED) return dispatchQueued(entry);
        if (entry.result.status() != Status.OUTCOME_UNKNOWN && entry.result.status() != Status.SENT) return entry.result;
        if (!(destination instanceof FencedDestinationPort fencedDestination)
                || !operations.supportsDurableDispatchClaims()) return entry.result;
        DeliveryOperationStore.DispatchClaim claim = operations.acquireDispatchClaim(
                operation(entry), dispatcherId, DISPATCH_CLAIM_LEASE).orElse(null);
        if (claim == null) return refreshEntry(entry);
        try {
            refreshEntry(entry);
            if (entry.result.status() != Status.OUTCOME_UNKNOWN && entry.result.status() != Status.SENT) {
                return entry.result;
            }
            return reconcileAndResume(entry, fencedDestination, claim);
        } finally {
            operations.releaseDispatchClaim(claim);
        }
    }

    private DeliveryResult reconcileAndResume(Entry entry, FencedDestinationPort fencedDestination,
                                               DeliveryOperationStore.DispatchClaim initialClaim) {
        DeliveryOperationStore.DispatchClaim claim = renew(initialClaim);
        if (claim == null) return refreshEntry(entry);
        FencedReconciliation reconciliation;
        try { reconciliation = fencedDestination.reconcile(entry.request, claim); }
        catch (RuntimeException unavailable) {
            return setResultOrReadback(entry,
                    result(entry.request, Status.OUTCOME_UNKNOWN, entry.result.acknowledgedBytes(), null), claim);
        }
        if (reconciliation == null) {
            return setResultOrReadback(entry,
                    result(entry.request, Status.OUTCOME_UNKNOWN, entry.result.acknowledgedBytes(), null), claim);
        }
        if (reconciliation.dispatchFence() != claim.fence()) {
            return setResultOrReadback(entry,
                    result(entry.request, Status.OUTCOME_UNKNOWN, entry.result.acknowledgedBytes(), null), claim);
        }
        int artifactSize = entry.request.artifact().size();
        int reconciledOffset = reconciliation.nextOffset();
        boolean invalidOffset = reconciledOffset > artifactSize
                || reconciledOffset < entry.result.acknowledgedBytes()
                || (reconciledOffset != artifactSize && reconciledOffset % CHUNK_BYTES != 0)
                || (entry.result.status() == Status.SENT && reconciledOffset != entry.result.acknowledgedBytes());
        if (invalidOffset) {
            return setResultOrReadback(entry,
                    result(entry.request, Status.OUTCOME_UNKNOWN, entry.result.acknowledgedBytes(), null), claim);
        }
        if (reconciliation.finalReceipt().isPresent()) {
            FencedDestinationReceipt finalReceipt = reconciliation.finalReceipt().get();
            if (finalReceipt.dispatchFence() != claim.fence()) {
                return setResultOrReadback(entry,
                        result(entry.request, Status.OUTCOME_UNKNOWN, reconciliation.nextOffset(), null), claim);
            }
            return setResultOrReadback(entry,
                    confirmOrUnknown(entry.request, finalReceipt.receipt(), reconciliation.nextOffset()), claim);
        }
        TransferAuthorization grant;
        try { grant = authorization.authorize(entry.request); validateScope(grant, entry.request); }
        catch (RuntimeException denied) {
            return setResultOrReadback(entry,
                    result(entry.request, Status.OUTCOME_UNKNOWN, reconciliation.nextOffset(), null), claim);
        }
        if (currentness(grant) != AuthorizationCurrentness.CURRENT) {
            return setResultOrReadback(entry,
                    result(entry.request, Status.OUTCOME_UNKNOWN, reconciliation.nextOffset(), null), claim);
        }
        transfer(entry, grant, reconciliation.nextOffset(), fencedDestination, claim);
        return entry.result;
    }

    /** Reauthorizes and resumes a pre-effect operation whose process may have stopped while queued. */
    private DeliveryResult dispatchQueued(Entry entry) {
        ExportRequest request = entry.request;
        if (entry.result.status() != Status.QUEUED) return entry.result;
        if (!(destination instanceof FencedDestinationPort fencedDestination)
                || !operations.supportsDurableDispatchClaims()) {
            if (!persistResult(entry, result(request, Status.UNAVAILABLE, 0, null))) return refreshEntry(entry);
            return entry.result;
        }
        DeliveryOperationStore.DispatchClaim claim = operations.acquireDispatchClaim(
                operation(entry), dispatcherId, DISPATCH_CLAIM_LEASE).orElse(null);
        if (claim == null) return refreshEntry(entry);
        try {
            refreshEntry(entry);
            if (entry.result.status() != Status.QUEUED) return entry.result;
            TransferAuthorization grant;
            try {
                grant = authorization.authorize(request);
            } catch (RuntimeException unavailable) {
                if (!setResult(entry, result(request, Status.UNAVAILABLE, 0, null), claim)) return refreshEntry(entry);
                throw authorizationUnavailable();
            }
            if (grant == null) {
                if (!setResult(entry, result(request, Status.UNAVAILABLE, 0, null), claim)) return refreshEntry(entry);
                throw authorizationUnavailable();
            }
            try {
                validateScope(grant, request);
            } catch (DeliveryException denied) {
                if (!setResult(entry, result(request, Status.REVOKED, 0, null), claim)) return refreshEntry(entry);
                throw denied;
            }
            AuthorizationCurrentness currentness = currentness(grant);
            if (currentness != AuthorizationCurrentness.CURRENT) {
                Status status = currentness == AuthorizationCurrentness.REVOKED ? Status.REVOKED : Status.UNAVAILABLE;
                if (!setResult(entry, result(request, status, 0, null), claim)) return refreshEntry(entry);
                DeliveryException.Code code = status == Status.REVOKED
                        ? DeliveryException.Code.AUTHORIZATION_DENIED : DeliveryException.Code.AUTHORIZATION_UNAVAILABLE;
                throw new DeliveryException(code, status == Status.REVOKED
                        ? "transfer authorization is revoked or expired" : "transfer authorization currentness is unavailable");
            }
            transfer(entry, grant, 0, fencedDestination, claim);
            return entry.result;
        } finally {
            operations.releaseDispatchClaim(claim);
        }
    }

    private static DeliveryException authorizationUnavailable() {
        return new DeliveryException(DeliveryException.Code.AUTHORIZATION_UNAVAILABLE,
                "transfer authorization is unavailable");
    }

    public synchronized Optional<DeliveryResult> find(String tenantId, String requestId) {
        String exactTenantId = required(tenantId, "tenantId");
        String exactRequestId = required(requestId, "requestId");
        Entry entry = entries.get(new OperationKey(exactTenantId, exactRequestId));
        if (entry == null) {
            Optional<DeliveryOperationStore.Operation> stored = operations.find(exactTenantId, exactRequestId);
            if (stored.isEmpty()) return Optional.empty();
            DeliveryOperationStore.Operation operation = stored.get();
            if (!operation.tenantId().equals(exactTenantId) || !operation.requestId().equals(exactRequestId)) {
                throw new DeliveryException(DeliveryException.Code.IDEMPOTENCY_CONFLICT,
                        "delivery operation readback differs from requested tenant and request scope");
            }
            return Optional.of(result(operation));
        }
        return Optional.of(refreshEntry(entry));
    }

    private void transfer(Entry entry, TransferAuthorization grant, int start,
                          FencedDestinationPort fencedDestination,
                          DeliveryOperationStore.DispatchClaim initialClaim) {
        ExportRequest request = entry.request;
        int offset = start;
        int artifactSize = request.artifact().size();
        DeliveryOperationStore.DispatchClaim claim = initialClaim;
        while (offset < artifactSize) {
            claim = renew(claim);
            if (claim == null) { refreshEntry(entry); return; }
            AuthorizationCurrentness currentness = currentness(grant);
            if (currentness != AuthorizationCurrentness.CURRENT) {
                Status status = offset > 0 ? Status.OUTCOME_UNKNOWN
                        : currentness == AuthorizationCurrentness.REVOKED ? Status.REVOKED : Status.UNAVAILABLE;
                if (!setResult(entry, result(request, status, offset, null), claim)) refreshEntry(entry);
                return;
            }
            int count = Math.min(CHUNK_BYTES, artifactSize - offset);
            byte[] chunk = request.artifact().chunk(offset, count);
            String chunkDigest = MediaCreationContracts.sha256(chunk);
            // Persist ambiguity before crossing the destination boundary. A process death
            // after acceptance but before ACK/readback must never leave a replayable QUEUED row.
            if (!setResult(entry, result(request, Status.OUTCOME_UNKNOWN, offset, null), claim)) {
                refreshEntry(entry);
                return;
            }
            if (!operations.isDispatchClaimCurrent(claim)) { refreshEntry(entry); return; }
            FencedChunkReceipt fencedReceipt;
            try { fencedReceipt = fencedDestination.sendChunk(request, offset, chunk, chunkDigest, grant, claim); }
            catch (RuntimeException lostAck) { refreshEntry(entry); return; }
            if (fencedReceipt == null || fencedReceipt.dispatchFence() != claim.fence()
                    || !validChunkReceipt(fencedReceipt.receipt(), request, offset, count, chunkDigest)) {
                refreshEntry(entry);
                return;
            }
            offset = fencedReceipt.receipt().nextOffset();
            if (!setResult(entry, result(request, Status.SENT, offset, null), claim)) {
                refreshEntry(entry);
                return;
            }
        }
        // Requiring destination reconciliation prevents transport completion from becoming confirmation.
        claim = renew(claim);
        if (claim == null) { refreshEntry(entry); return; }
        FencedReconciliation finalState;
        try { finalState = fencedDestination.reconcile(request, claim); }
        catch (RuntimeException unavailable) {
            if (!setResult(entry, result(request, Status.OUTCOME_UNKNOWN, offset, null), claim)) refreshEntry(entry);
            return;
        }
        if (finalState == null) {
            if (!setResult(entry, result(request, Status.OUTCOME_UNKNOWN, offset, null), claim)) refreshEntry(entry);
            return;
        }
        if (finalState.dispatchFence() != claim.fence()) {
            if (!setResult(entry, result(request, Status.OUTCOME_UNKNOWN, offset, null), claim)) refreshEntry(entry);
            return;
        }
        if (finalState.finalReceipt().isEmpty()) {
            if (!setResult(entry, result(request, Status.OUTCOME_UNKNOWN, offset, null), claim)) refreshEntry(entry);
            return;
        }
        FencedDestinationReceipt finalReceipt = finalState.finalReceipt().get();
        if (finalReceipt.dispatchFence() != claim.fence()) {
            if (!setResult(entry, result(request, Status.OUTCOME_UNKNOWN, offset, null), claim)) refreshEntry(entry);
            return;
        }
        if (!setResult(entry, confirmOrUnknown(request, finalReceipt.receipt(), finalState.nextOffset()), claim)) {
            refreshEntry(entry);
        }
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

    private Entry loadEntry(ExportRequest request) {
        Entry cached = entries.get(key(request));
        if (cached != null) return cached;
        Optional<DeliveryOperationStore.Operation> stored = operations.find(request.tenantId(), request.requestId());
        if (stored.isEmpty()) return null;
        DeliveryOperationStore.Operation operation = stored.get();
        if (!matchesScope(operation, request) || !matchesArtifactProgress(operation, request)) {
            throw new DeliveryException(DeliveryException.Code.IDEMPOTENCY_CONFLICT,
                    "request id is already bound to different export content or impossible delivery progress");
        }
        // Preserve the persisted fingerprint so older rows remain resumable. Exact stored
        // fields are checked independently because delimiter-joined fingerprints can collide.
        Entry loaded = new Entry(request, operation.requestFingerprint(), result(operation));
        entries.put(key(request), loaded);
        return loaded;
    }

    private static boolean matchesScope(DeliveryOperationStore.Operation operation, ExportRequest request) {
        return operation.tenantId().equals(request.tenantId())
                && operation.principalId().equals(request.principalId())
                && operation.requestId().equals(request.requestId())
                && operation.artifactId().equals(request.artifact().artifactId())
                && operation.versionRef().equals(request.artifact().versionRef())
                && operation.artifactDigest().equals(request.artifact().digest())
                && operation.destinationRef().equals(request.destinationRef());
    }

    private static boolean matchesArtifactProgress(DeliveryOperationStore.Operation operation, ExportRequest request) {
        int artifactSize = request.artifact().size();
        return operation.acknowledgedBytes() <= artifactSize
                && (operation.acknowledgedBytes() == artifactSize
                || operation.acknowledgedBytes() % CHUNK_BYTES == 0)
                && (operation.status() != Status.DESTINATION_CONFIRMED
                || operation.acknowledgedBytes() == artifactSize);
    }

    private DeliveryResult refreshEntry(Entry entry) {
        DeliveryOperationStore.Operation stored = operations.find(
                entry.request.tenantId(), entry.request.requestId()).orElseThrow(
                () -> new IllegalStateException("delivery operation disappeared from durable readback"));
        if (!stored.requestFingerprint().equals(entry.fingerprint)
                || !stored.tenantId().equals(entry.request.tenantId())
                || !stored.principalId().equals(entry.request.principalId())
                || !stored.requestId().equals(entry.request.requestId())
                || !stored.artifactId().equals(entry.request.artifact().artifactId())
                || !stored.versionRef().equals(entry.request.artifact().versionRef())
                || !stored.artifactDigest().equals(entry.request.artifact().digest())
                || !stored.destinationRef().equals(entry.request.destinationRef())
                || !matchesArtifactProgress(stored, entry.request)) {
            throw new DeliveryException(DeliveryException.Code.IDEMPOTENCY_CONFLICT,
                    "delivery operation readback differs from exact immutable request scope or artifact progress bounds");
        }
        entry.result = result(stored);
        return entry.result;
    }

    private void setResult(Entry entry, DeliveryResult result) {
        if (!persistResult(entry, result)) {
            throw new IllegalStateException("delivery operation state changed during update");
        }
    }

    private boolean persistResult(Entry entry, DeliveryResult result) {
        if (!operations.update(operation(entry, result))) return false;
        // Publish in-memory state only after the durable store confirms the update.
        entry.result = result;
        return true;
    }

    private boolean setResult(Entry entry, DeliveryResult result, DeliveryOperationStore.DispatchClaim claim) {
        if (!operations.update(operation(entry, result), claim)) return false;
        entry.result = result;
        return true;
    }

    private DeliveryResult setResultOrReadback(Entry entry, DeliveryResult result,
                                                DeliveryOperationStore.DispatchClaim claim) {
        return setResult(entry, result, claim) ? entry.result : refreshEntry(entry);
    }

    private DeliveryOperationStore.DispatchClaim renew(DeliveryOperationStore.DispatchClaim claim) {
        return operations.renewDispatchClaim(claim, DISPATCH_CLAIM_LEASE).orElse(null);
    }

    private static DeliveryOperationStore.Operation operation(Entry entry) {
        return operation(entry, entry.result);
    }

    private static DeliveryOperationStore.Operation operation(Entry entry, DeliveryResult value) {
        return new DeliveryOperationStore.Operation(value.tenantId(), value.principalId(), value.requestId(),
                value.artifactId(), value.versionRef(), value.artifactDigest(), value.destinationRef(),
                entry.fingerprint, value.status(), value.acknowledgedBytes(), value.destinationReceiptRef().orElse(null));
    }

    private static DeliveryResult result(DeliveryOperationStore.Operation operation) {
        return new DeliveryResult(operation.tenantId(), operation.principalId(), operation.requestId(),
                operation.artifactId(), operation.versionRef(), operation.artifactDigest(), operation.destinationRef(),
                operation.status(), operation.acknowledgedBytes(), Optional.ofNullable(operation.destinationReceiptRef()));
    }

    private static String fingerprint(ExportRequest request) {
        String material = String.join("\n", request.tenantId(), request.principalId(), request.requestId(),
                request.artifact().artifactId(), request.artifact().versionRef(), request.artifact().digest(),
                request.destinationRef());
        return MediaCreationContracts.sha256(material.getBytes(java.nio.charset.StandardCharsets.UTF_8));
    }

    private static OperationKey key(ExportRequest r) { return new OperationKey(r.tenantId(), r.requestId()); }
    static void validateProgress(Status status, int acknowledgedBytes) {
        if (acknowledgedBytes < 0) throw new IllegalArgumentException("acknowledgedBytes must not be negative");
        if (acknowledgedBytes > MAX_ARTIFACT_BYTES) {
            throw new IllegalArgumentException("acknowledgedBytes exceeds the maximum artifact size");
        }
        boolean requiresZero = status == Status.QUEUED || status == Status.REVOKED || status == Status.UNAVAILABLE;
        boolean requiresPositive = status == Status.SENT || status == Status.DESTINATION_CONFIRMED;
        if ((requiresZero && acknowledgedBytes != 0) || (requiresPositive && acknowledgedBytes == 0)) {
            throw new IllegalArgumentException("acknowledgedBytes is inconsistent with delivery status");
        }
    }
    private static DeliveryResult result(ExportRequest r, Status status, int acknowledged, String receipt) {
        return new DeliveryResult(r.tenantId(), r.principalId(), r.requestId(), r.artifact().artifactId(),
                r.artifact().versionRef(), r.artifact().digest(), r.destinationRef(), status,
                acknowledged, Optional.ofNullable(receipt));
    }
    private static String required(String value, String field) {
        return requiredExact(value, field);
    }

    /** External acknowledgment identities and receipts are compared exactly, never normalized into a match. */
    static String requiredExact(String value, String field) {
        Objects.requireNonNull(value, field);
        String trimmed = value.trim();
        if (value.isBlank() || trimmed.isEmpty()) {
            throw new IllegalArgumentException(field + " must not be blank");
        }
        if (hasBoundaryWhitespace(value) || !value.equals(trimmed)) {
            throw new IllegalArgumentException(field + " must not contain surrounding whitespace");
        }
        int maxLength = switch (field) {
            case "tenantId", "principalId", "requestId", "artifactId", "tokenId" -> 128;
            case "ownerId" -> 255;
            case "versionRef", "destinationRef" -> 384;
            default -> 512;
        };
        if (value.length() > maxLength) {
            throw new IllegalArgumentException(field + " exceeds the maximum length of " + maxLength);
        }
        return value;
    }

    private static boolean hasBoundaryWhitespace(String value) {
        if (value.isEmpty()) return true;
        int first = value.codePointAt(0);
        int last = value.codePointBefore(value.length());
        return Character.isWhitespace(first) || Character.isSpaceChar(first)
                || Character.isWhitespace(last) || Character.isSpaceChar(last);
    }
}
