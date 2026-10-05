package com.ghatana.audio.video.common.observability;

import io.grpc.ForwardingServerCall;
import io.grpc.Metadata;
import io.grpc.ServerCall;
import io.grpc.ServerCallHandler;
import io.grpc.ServerInterceptor;
import io.grpc.Status;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.concurrent.ConcurrentHashMap;
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
 * <p>This implementation is intentionally zero-dependency on a Prometheus client library
 * to keep the common module lightweight. When a Micrometer/OpenTelemetry SDK is present
 * in the consuming service, the service can bridge these counters or simply use its own
 * instrumentation on top of this interceptor.
  * @doc.type class
 * @doc.purpose Provides metrics server interceptor functionality.
 * @doc.layer product
 * @doc.pattern Filter
*/
public class MetricsServerInterceptor implements ServerInterceptor {

    private static final Logger LOG = LoggerFactory.getLogger(MetricsServerInterceptor.class);

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

        return next.startCall(
                new ForwardingServerCall.SimpleForwardingServerCall<>(call) {
                    @Override
                    public void close(Status status, Metadata trailers) {
                        long elapsedNs = System.nanoTime() - startNs;
                        String code = status.getCode().name();

                        handled.computeIfAbsent(method, k -> new ConcurrentHashMap<>())
                               .computeIfAbsent(code, k -> new LongAdder())
                               .increment();

                        durationSumNs.computeIfAbsent(method, k -> new AtomicLong(0))
                                     .addAndGet(elapsedNs);
                        durationCount.computeIfAbsent(method, k -> new LongAdder()).increment();

                        super.close(status, trailers);
                    }
                }, headers);
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
