package com.ghatana.media.config;

import java.time.Duration;
import java.util.List;

/**
 * Cloud fallback configuration used when local inference fails.
 *
 * @doc.type record
 * @doc.purpose Cloud fallback settings for audio-video engines
 * @doc.layer platform
 * @doc.pattern Configuration
 */
public record CloudFallbackConfig(
    String endpoint,
    String apiKey,
    Duration timeout,
    int maxRetries,
    List<String> fallbackModels
) {
    public static Builder builder() {
        return new Builder();
    }

    public static final class Builder {
        private String endpoint;
        private String apiKey;
        private Duration timeout = Duration.ofSeconds(30);
        private int maxRetries = 3;
        private List<String> fallbackModels = List.of();

        public Builder endpoint(String value) { this.endpoint = value; return this; }
        public Builder apiKey(String value) { this.apiKey = value; return this; }
        public Builder timeout(Duration value) { this.timeout = value; return this; }
        public Builder maxRetries(int value) { this.maxRetries = value; return this; }
        public Builder fallbackModels(List<String> value) { this.fallbackModels = value; return this; }

        public CloudFallbackConfig build() {
            return new CloudFallbackConfig(endpoint, apiKey, timeout, maxRetries, fallbackModels);
        }
    }
}
