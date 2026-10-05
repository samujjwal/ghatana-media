package com.ghatana.audio.video.common.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.BlockingQueue;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.function.Consumer;

/**
 * Asynchronous sink for audit events emitted by gRPC interceptors.
 *
 * <p>Provides a non-blocking {@link #emit} surface so that the gRPC interceptor thread is
 * never delayed by audit persistence I/O. Events are queued and drained by a single
 * background thread. If the internal queue overflows (capacity {@code 4096}) the event
 * is dropped and an error is logged — correct for best-effort audit in the interceptor layer.
 *
 * <p>Use {@link #loggingOnly()} for environments without a persistent audit store.
 * Production deployments wire a real persistence-backed consumer via
 * {@link #withConsumer(Consumer)}.
 *
 * @doc.type class
 * @doc.purpose Non-blocking audit event sink for gRPC interceptor chains
 * @doc.layer product
 * @doc.pattern Service
 */
public final class AuditEventSink implements AutoCloseable {

    private static final Logger LOG = LoggerFactory.getLogger(AuditEventSink.class);
    private static final int QUEUE_CAPACITY = 4096;

    private final BlockingQueue<AuditRecord> queue;
    private final ExecutorService drainer;
    private volatile boolean closed = false;

    private AuditEventSink(Consumer<AuditRecord> consumer) {
        this.queue = new LinkedBlockingQueue<>(QUEUE_CAPACITY);
        this.drainer = Executors.newSingleThreadExecutor(r -> {
            Thread t = new Thread(r, "av-audit-sink");
            t.setDaemon(true);
            return t;
        });
        this.drainer.submit(() -> drain(consumer));
    }

    /**
     * Creates a sink that logs every audit event at INFO level via SLF4J.
     * Suitable for testing and environments without a persistent audit store.
     *
     * @return logging-only sink
     */
    public static AuditEventSink loggingOnly() {
        return new AuditEventSink(record ->
            LOG.info("[AUDIT] tenant={} principal={} method={} roles={} outcome={} reason={}",
                record.tenantId(), record.principal(), record.grpcMethod(),
                record.roles(), record.outcome(), record.reason()));
    }

    /**
     * Creates a sink that invokes the supplied consumer for each drained record.
     *
     * @param consumer persistent or observable audit consumer (must be thread-safe)
     * @return configured sink
     */
    public static AuditEventSink withConsumer(Consumer<AuditRecord> consumer) {
        return new AuditEventSink(consumer);
    }

    /**
     * Enqueues an audit record. Never blocks the caller. Drops the event (with an error log)
     * if the internal queue is full.
     *
     * @param record audit record to enqueue
     */
    public void emit(AuditRecord record) {
        if (closed) {
            return;
        }
        boolean offered = queue.offer(record);
        if (!offered) {
            LOG.error("[AUDIT-DROP] Queue full — dropped audit event for tenant={} method={}",
                record.tenantId(), record.grpcMethod());
        }
    }

    @Override
    public void close() {
        closed = true;
        drainer.shutdownNow();
    }

    private void drain(Consumer<AuditRecord> consumer) {
        while (!Thread.currentThread().isInterrupted()) {
            try {
                AuditRecord record = queue.take();
                try {
                    consumer.accept(record);
                } catch (Exception e) {
                    LOG.error("[AUDIT] Consumer threw for tenant={} method={}: {}",
                        record.tenantId(), record.grpcMethod(), e.getMessage(), e);
                }
            } catch (InterruptedException ie) {
                Thread.currentThread().interrupt();
                break;
            }
        }
        // Flush remaining records before exiting
        AuditRecord remaining;
        while ((remaining = queue.poll()) != null) {
            try {
                consumer.accept(remaining);
            } catch (Exception e) {
                LOG.error("[AUDIT] Flush consumer threw: {}", e.getMessage(), e);
            }
        }
    }

    /**
     * Immutable audit record emitted by {@link AudioVideoRequestContextInterceptor}.
     *
     * @param tenantId    extracted tenant identifier
     * @param principal   authenticated subject / user identifier
     * @param roles       comma-separated roles from JWT or metadata
     * @param grpcMethod  full gRPC method name (e.g. {@code stt.v1.STTService/Transcribe})
     * @param outcome     result of the RBAC/auth check
     * @param reason      human-readable reason string (empty string on success)
     */
    public record AuditRecord(
        String tenantId,
        String principal,
        String roles,
        String grpcMethod,
        Outcome outcome,
        String reason
    ) {
        /** Outcome of the security/RBAC check for an inbound gRPC call. */
        public enum Outcome {
            ALLOWED,
            DENIED_MISSING_TENANT,
            DENIED_UNAUTHENTICATED,
            DENIED_CROSS_TENANT,
            DENIED_INSUFFICIENT_ROLE
        }
    }
}
