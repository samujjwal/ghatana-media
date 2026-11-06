package com.ghatana.media.production.delivery;

import java.util.HashMap;
import java.util.Map;
import java.time.Duration;
import java.time.Instant;
import java.util.Optional;
import java.util.function.Supplier;

/** Process-local development implementation. Runtime durability requires a persistent store. */
public final class InMemoryDeliveryOperationStore implements DeliveryOperationStore {
    private record OperationKey(String tenantId, String requestId) {}
    private final Map<OperationKey, Operation> operations = new HashMap<>();
    private final Map<OperationKey, DispatchClaim> claims = new HashMap<>();
    private final Map<OperationKey, Long> fences = new HashMap<>();
    private final Supplier<Instant> clock;

    public InMemoryDeliveryOperationStore() { this(Instant::now); }

    public InMemoryDeliveryOperationStore(Supplier<Instant> clock) {
        this.clock = java.util.Objects.requireNonNull(clock, "clock");
    }

    @Override public synchronized Optional<Operation> find(String tenantId, String requestId) {
        return Optional.ofNullable(operations.get(key(tenantId, requestId)));
    }

    @Override public synchronized boolean insertIfAbsent(Operation operation) {
        return operations.putIfAbsent(key(operation.tenantId(), operation.requestId()), operation) == null;
    }

    @Override public synchronized boolean update(Operation operation) {
        OperationKey key = key(operation.tenantId(), operation.requestId());
        Operation prior = operations.get(key);
        if (!DeliveryOperationStore.isAllowedTransition(prior, operation)) return false;
        DispatchClaim active = claims.get(key);
        if (active != null && active.expiresAt().isAfter(now())) return false;
        operations.put(key, operation);
        return true;
    }

    @Override public synchronized Optional<DispatchClaim> acquireDispatchClaim(
            Operation operation, String ownerId, Duration lease) {
        Duration checked = DeliveryOperationStore.checkedLease(lease);
        ownerId = ownerId == null ? "" : ownerId.trim();
        if (ownerId.isEmpty() || ownerId.length() > 255) throw new IllegalArgumentException("ownerId is invalid");
        OperationKey key = key(operation.tenantId(), operation.requestId());
        Operation stored = operations.get(key);
        if (!operation.equals(stored)) return Optional.empty();
        Instant now = now();
        DispatchClaim prior = claims.get(key);
        if (prior != null && prior.expiresAt().isAfter(now)) return Optional.empty();
        long fence = Math.addExact(fences.getOrDefault(key, 0L), 1L);
        fences.put(key, fence);
        DispatchClaim acquired = claim(operation, ownerId, fence, now.plus(checked));
        claims.put(key, acquired);
        return Optional.of(acquired);
    }

    @Override public synchronized Optional<DispatchClaim> renewDispatchClaim(DispatchClaim claim, Duration lease) {
        Duration checked = DeliveryOperationStore.checkedLease(lease);
        OperationKey key = key(claim.tenantId(), claim.requestId());
        Instant now = now();
        if (!isCurrent(key, claim, now)) return Optional.empty();
        DispatchClaim renewed = claim(operationFor(claim), claim.ownerId(), claim.fence(), now.plus(checked));
        claims.put(key, renewed);
        return Optional.of(renewed);
    }

    @Override public synchronized boolean isDispatchClaimCurrent(DispatchClaim claim) {
        return isCurrent(key(claim.tenantId(), claim.requestId()), claim, now());
    }

    @Override public synchronized boolean releaseDispatchClaim(DispatchClaim claim) {
        OperationKey key = key(claim.tenantId(), claim.requestId());
        if (!isCurrent(key, claim, now())) return false;
        claims.remove(key);
        return true;
    }

    @Override public synchronized boolean update(Operation operation, DispatchClaim claim) {
        OperationKey key = key(operation.tenantId(), operation.requestId());
        if (!claim.matches(operation) || !isCurrent(key, claim, now())) return false;
        Operation prior = operations.get(key);
        if (!DeliveryOperationStore.isAllowedTransition(prior, operation)) return false;
        operations.put(key, operation);
        return true;
    }

    private boolean isCurrent(OperationKey key, DispatchClaim claim, Instant now) {
        DispatchClaim stored = claims.get(key);
        Operation operation = operations.get(key);
        return stored != null && operation != null && stored.ownerId().equals(claim.ownerId())
                && stored.fence() == claim.fence() && stored.expiresAt().isAfter(now)
                && claim.matches(operation) && stored.matches(operation);
    }

    private Operation operationFor(DispatchClaim claim) {
        Operation operation = operations.get(key(claim.tenantId(), claim.requestId()));
        if (operation == null || !claim.matches(operation)) throw new IllegalStateException("claim scope no longer exists");
        return operation;
    }

    private Instant now() { return java.util.Objects.requireNonNull(clock.get(), "clock result"); }

    private static DispatchClaim claim(Operation operation, String ownerId, long fence, Instant expiry) {
        return new DispatchClaim(operation.tenantId(), operation.principalId(), operation.requestId(),
                operation.artifactId(), operation.versionRef(), operation.artifactDigest(), operation.destinationRef(),
                operation.requestFingerprint(), ownerId, fence, expiry);
    }

    private static OperationKey key(String tenantId, String requestId) { return new OperationKey(tenantId, requestId); }
}
