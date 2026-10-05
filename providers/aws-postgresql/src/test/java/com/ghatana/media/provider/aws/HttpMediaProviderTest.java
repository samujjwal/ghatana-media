package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import org.junit.jupiter.api.Test;

import java.util.HashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** @doc.type class @doc.purpose Verify remote Media provider security, capabilities, and eligibility */
class HttpMediaProviderTest {

    @Test
    void unconfiguredProvidersAreInertAndSafeToDiscover() {
        HttpMediaProcessingProvider processing = new HttpMediaProcessingProvider(Map.of());
        HttpMediaStreamingProvider streaming = new HttpMediaStreamingProvider(Map.of());
        assertThat(processing.ready()).isFalse();
        assertThat(processing.productionEligible()).isFalse();
        assertThat(streaming.ready()).isFalse();
        assertThat(streaming.productionEligible()).isFalse();
    }

    @Test
    void configuredCapabilitiesAreExplicit() {
        Map<String, String> environment = new HashMap<>();
        environment.put("MEDIA_HTTP_PROVIDER_ENDPOINT", "https://media.example.test");
        environment.put("MEDIA_HTTP_PROVIDER_TOKEN_REFERENCE", "secret:env:MEDIA_TOKEN");
        environment.put("MEDIA_TOKEN", "token-value");
        environment.put("MEDIA_HTTP_PROVIDER_JOB_TYPES", "VISION,MULTIMODAL");
        environment.put("MEDIA_HTTP_PROVIDER_STREAM_KINDS", "VIDEO");
        environment.put("MEDIA_HTTP_PROVIDER_REGION", "us-west-2");
        environment.put("MEDIA_HTTP_PROVIDER_DATA_RETENTION", "NONE");
        HttpMediaProcessingProvider processing = new HttpMediaProcessingProvider(environment);
        HttpMediaStreamingProvider streaming = new HttpMediaStreamingProvider(environment);
        assertThat(processing.capabilities()).containsExactlyInAnyOrder(JobType.VISION, JobType.MULTIMODAL);
        assertThat(streaming.capabilities()).containsExactly(StreamKind.VIDEO);
        assertThat(processing.productionEligible()).isTrue();
        assertThat(streaming.productionEligible()).isTrue();
        assertThat(processing.ready()).isFalse();
        assertThat(streaming.ready()).isFalse();
    }

    @Test
    void productionRejectsInsecureEndpointAndMissingSecret() {
        Map<String, String> insecure = new HashMap<>();
        insecure.put("MEDIA_RUNTIME_ENVIRONMENT", "production");
        insecure.put("MEDIA_HTTP_PROVIDER_ENDPOINT", "http://media.example.test");
        insecure.put("MEDIA_HTTP_PROVIDER_TOKEN_REFERENCE", "secret:env:MEDIA_TOKEN");
        insecure.put("MEDIA_TOKEN", "token-value");
        assertThatThrownBy(() -> new HttpMediaProcessingProvider(insecure))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("HTTPS")
                .hasMessageNotContaining("token-value");

        Map<String, String> missing = new HashMap<>(insecure);
        missing.put("MEDIA_HTTP_PROVIDER_ENDPOINT", "https://media.example.test");
        missing.remove("MEDIA_TOKEN");
        assertThatThrownBy(() -> new HttpMediaStreamingProvider(missing))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("could not be resolved");
    }
}
