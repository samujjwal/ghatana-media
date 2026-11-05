package com.ghatana.audio.video.common.observability;

/** Supplies the service-local Micrometer registry exposition to that service's health sidecar. */
public interface MetricsScrapeSource {
    /** Returns Prometheus text exposition; an empty string means this service has no scrape registry. */
    String scrapeMetrics();
}
