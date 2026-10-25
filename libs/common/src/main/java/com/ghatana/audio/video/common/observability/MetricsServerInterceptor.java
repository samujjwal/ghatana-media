package com.ghatana.audio.video.common.observability;

import io.grpc.ForwardingServerCall;
import io.grpc.ForwardingServerCallListener;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicLong;
import java.util.concurrent.atomic.LongAdder;

/**
 * gRPC server interceptor that collects Prometheus-compatible metrics for every call.
 *
 * <p>Metrics collected (all labelled by {@code grpc_method}):
 * <ul>
 *   <li>{@code grpc_server_started_total} — counter, incremented on call start</li>
 *   <li>{@code grpc_server_handled_total} — counter per gRPC status code</li>
 *   <li>{@code grpc_server_handling_seconds_sum} — sum of call durations</li>
 *   <li>{@code grpc_server_handling_seconds_count} — number of completed calls</li>
 * </ul>
 *
 * <p>Metrics are exposed via {@link #scrape()} which returns a Prometheus text-format
 * string. Mount this on an HTTP /metrics endpoint in each service's health server.
 *
 * <p>This implementation has no dependency on a Prometheus client library. It records fixed
 * protobuf method names, gRPC status codes, and durations only. Cancellation and handler-start
 * failures receive terminal metric outcomes even when the call does not reach {@code close()}.
  * @doc.type class
 * @doc.purpose Provides metrics server interceptor functionality.
 * @doc.layer product
 * @doc.pattern Filter
*/
public class MetricsServerInterceptor implements ServerInterceptor {

    private static final MetricsServerInterceptor INSTANCE = new MetricsServerInterceptor();

    public static MetricsServerInterceptor getInstance() { return INSTANCE; }

    // started[method]
    private final ConcurrentHashMap<String, LongAdder> started = new ConcurrentHashMap<>();
    // handled[method][status_code]
    private final ConcurrentHashMap<String, ConcurrentHashMap<String, LongAdder>> handled =
            new ConcurrentHashMap<>();
    // duration sums and counts [method]
    private final ConcurrentHashMap<String, AtomicLong> durationSumNs = new ConcurrentHashMap<>();
    private final ConcurrentHashMap<String, LongAdder> durationCount = new ConcurrentHashMap<>();

    @Override
    public <ReqT, RespT> ServerCall.Listener<ReqT> interceptCall(
            ServerCall<ReqT, RespT> call,
            Metadata headers,
            ServerCallHandler<ReqT, RespT> next) {

        String method = call.getMethodDescriptor().getFullMethodName();
        started.computeIfAbsent(method, k -> new LongAdder()).increment();
        long startNs = System.nanoTime();
        AtomicBoolean completed = new AtomicBoolean();
        java.util.function.Consumer<Status> recordCompletion = status -> {
            if (!completed.compareAndSet(false, true)) {
                return;
            }
            long elapsedNs = System.nanoTime() - startNs;
            String code = status.getCode().name();

            handled.computeIfAbsent(method, k -> new ConcurrentHashMap<>())
                    .computeIfAbsent(code, k -> new LongAdder())
                    .increment();

            durationSumNs.computeIfAbsent(method, k -> new AtomicLong(0))
                    .addAndGet(elapsedNs);
            durationCount.computeIfAbsent(method, k -> new LongAdder()).increment();
        };

        try {
            ServerCall.Listener<ReqT> delegate = next.startCall(
                    new ForwardingServerCall.SimpleForwardingServerCall<>(call) {
                        @Override
                        public void close(Status status, Metadata trailers) {
                            recordCompletion.accept(status);
                            super.close(status, trailers);
                        }
                    }, headers);
            return new ForwardingServerCallListener.SimpleForwardingServerCallListener<>(delegate) {
                @Override
                public void onCancel() {
                    try {
                        super.onCancel();
                    } finally {
                        recordCompletion.accept(Status.CANCELLED);
                    }
                }
            };
        } catch (RuntimeException startupFailure) {
            recordCompletion.accept(Status.UNKNOWN);
            throw startupFailure;
        }
    }

    // -------------------------------------------------------------------------
    // Prometheus text-format scrape endpoint
    // -------------------------------------------------------------------------

    /**
     * Returns all collected metrics in Prometheus text exposition format.
     * Intended to be served at {@code GET /metrics}.
     */
    public String scrape() {
        StringBuilder sb = new StringBuilder(2048);

        sb.append("# HELP grpc_server_started_total Total number of RPCs started on the server.\n");
        sb.append("# TYPE grpc_server_started_total counter\n");
        started.forEach((method, adder) -> sb
                .append("grpc_server_started_total{grpc_method=\"")
                .append(escape(method)).append("\"} ")
                .append(adder.sum()).append('\n'));

        sb.append("# HELP grpc_server_handled_total Total number of RPCs completed on the server.\n");
        sb.append("# TYPE grpc_server_handled_total counter\n");
        handled.forEach((method, codes) ->
                codes.forEach((code, adder) -> sb
                        .append("grpc_server_handled_total{grpc_method=\"")
                        .append(escape(method)).append("\",grpc_code=\"")
                        .append(code).append("\"} ")
                        .append(adder.sum()).append('\n')));

        sb.append("# HELP grpc_server_handling_seconds Duration of RPC calls in seconds.\n");
        sb.append("# TYPE grpc_server_handling_seconds summary\n");
        durationCount.forEach((method, count) -> {
            long sumNs = durationSumNs.getOrDefault(method, new AtomicLong(0)).get();
            double sumSec = sumNs / 1_000_000_000.0;
            sb.append("grpc_server_handling_seconds_sum{grpc_method=\"")
              .append(escape(method)).append("\"} ").append(sumSec).append('\n');
            sb.append("grpc_server_handling_seconds_count{grpc_method=\"")
              .append(escape(method)).append("\"} ").append(count.sum()).append('\n');
        });

        return sb.toString();
    }

    /** Reset all counters (useful for tests). */
    public void reset() {
        started.clear();
        handled.clear();
        durationSumNs.clear();
        durationCount.clear();
    }

    private static String escape(String s) {
        return s.replace("\\", "\\\\").replace("\"", "\\\"");
    }
}
