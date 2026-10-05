package com.ghatana.media.common;

/**
 * Common metrics for all engines.
 *
 * @doc.type record
 * @doc.purpose Engine performance and error metrics snapshot
 * @doc.layer platform
 * @doc.pattern ValueObject
 */
public record EngineMetrics(
    long requestCount,
    long errorCount,
    double avgLatencyMs,
    long activeRequests,
    long memoryUsageBytes
) {
    public double errorRate() {
        return requestCount > 0 ? (double) errorCount / requestCount : 0.0;
    }
}
