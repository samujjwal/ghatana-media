package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeoutException;

import static org.assertj.core.api.Assertions.assertThat;

/** Contract proof that ambiguous post-dispatch failures never imply fallback authority. */
class MediaProcessingProviderFallbackContractTest {

    @Test
    void externalProviderDoesNotInheritTimeoutOrIoFallbackAuthority() {
        MediaProcessingProvider provider = provider(false);

        assertThat(provider.processingBoundary()).isEqualTo(ProcessingBoundary.EXTERNAL);
        assertThat(provider.fallbackEligible(new TimeoutException("timed out"))).isFalse();
        assertThat(provider.fallbackEligible(new IOException("connection reset"))).isFalse();
        assertThat(provider.fallbackEligible(new java.util.concurrent.CompletionException(
                new TimeoutException("timed out")))).isFalse();
    }

    @Test
    void fallbackRequiresExplicitProviderOptIn() {
        MediaProcessingProvider provider = provider(true);

        assertThat(provider.fallbackEligible(new TimeoutException("provider-certified"))).isTrue();
        assertThat(provider.fallbackEligible(new IOException("not certified"))).isFalse();
    }

    private static MediaProcessingProvider provider(boolean explicitlySafe) {
        return new MediaProcessingProvider() {
            @Override public String providerId() { return "contract-provider"; }
            @Override public String providerVersion() { return "contract-v1"; }
            @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public int priority() { return 1; }
            @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
                return CompletableFuture.completedFuture(Map.of());
            }
            @Override public boolean fallbackEligible(Throwable failure) {
                if (!explicitlySafe) return MediaProcessingProvider.super.fallbackEligible(failure);
                return failure instanceof TimeoutException;
            }
        };
    }
}
