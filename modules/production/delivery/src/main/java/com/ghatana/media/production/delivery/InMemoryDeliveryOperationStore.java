package com.ghatana.media.production.delivery;

import java.util.HashMap;
import java.util.Map;
import java.util.Optional;

/** Process-local development implementation. Runtime durability requires a persistent store. */
public final class InMemoryDeliveryOperationStore implements DeliveryOperationStore {
    private final Map<String, Operation> operations = new HashMap<>();

    @Override public synchronized Optional<Operation> find(String tenantId, String requestId) {
        return Optional.ofNullable(operations.get(key(tenantId, requestId)));
    }

    @Override public synchronized boolean insertIfAbsent(Operation operation) {
        return operations.putIfAbsent(key(operation.tenantId(), operation.requestId()), operation) == null;
    }

    @Override public synchronized boolean update(Operation operation) {
        String key = key(operation.tenantId(), operation.requestId());
        Operation prior = operations.get(key);
        if (prior == null || !prior.requestFingerprint().equals(operation.requestFingerprint())) return false;
        operations.put(key, operation);
        return true;
    }

    private static String key(String tenantId, String requestId) { return tenantId + "\u0000" + requestId; }
}
