package com.ghatana.media.launcher;

import com.ghatana.media.production.delivery.MediaDeliveryEngine;
import com.ghatana.media.production.delivery.InMemoryDeliveryOperationStore;
import org.junit.jupiter.api.Test;

import java.net.URI;
import java.time.Duration;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaDevHttpReceiverDestinationTest {
    private static MediaDevHttpReceiverDestination destination(String url) {
        return new MediaDevHttpReceiverDestination(URI.create(url), "receiver-1", "credential", "0123456789abcdef-key".getBytes(),
                Set.of("tenant-a"), Duration.ofSeconds(1), new InMemoryDeliveryOperationStore());
    }

    @Test
    void onlyABareLoopbackHttpOriginIsAccepted() {
        assertThat(destination("http://127.0.0.1:9").permits("tenant-a")).isTrue();
        assertThat(destination("http://127.0.0.1:9").permits("tenant-b")).isFalse();
        for (String refused : new String[] {"http://10.1.2.3:9", "https://127.0.0.1:9", "http://user@127.0.0.1:9",
                "http://127.0.0.1:9/path", "http://127.0.0.1:9?x=1", "http://example.invalid:9"}) {
            assertThatThrownBy(() -> destination(refused)).as(refused).isInstanceOf(IllegalArgumentException.class);
        }
    }

    @Test
    void composeIsAbsentWithoutAUrlAndFailsClosedWhenMisconfigured() {
        var store = new InMemoryDeliveryOperationStore();
        assertThat(MediaDevHttpReceiverDestination.compose(Map.of(), store)).isNull();
        assertThatThrownBy(() -> MediaDevHttpReceiverDestination.compose(
                Map.of(MediaDevHttpReceiverDestination.URL_ENV, "http://127.0.0.1:9"), store))
                .as("credential reference is mandatory").isInstanceOf(RuntimeException.class);
        assertThatThrownBy(() -> MediaDevHttpReceiverDestination.compose(Map.of(
                MediaDevHttpReceiverDestination.URL_ENV, "http://127.0.0.1:9",
                MediaDevHttpReceiverDestination.CREDENTIAL_REFERENCE_ENV, "secret:env:C",
                MediaDevHttpReceiverDestination.ACK_KEY_REFERENCE_ENV, "secret:env:K",
                MediaDevHttpReceiverDestination.IDENTITY_ENV, "receiver-1", "C", "credential", "K", "0123456789abcdef-key"), store))
                .as("the permitted tenants must be listed").hasMessageContaining("TENANTS");
    }

    @Test
    void ackStateIsDeliveredOnlyForADestinationConfirmedReceipt() {
        var absent = new MediaDevHttpReceiverDestination.Observation(MediaDevHttpReceiverDestination.Finding.OBJECT_ABSENT, 0, java.time.Instant.now());
        var mismatch = new MediaDevHttpReceiverDestination.Observation(MediaDevHttpReceiverDestination.Finding.CHECKSUM_MISMATCH, 0, java.time.Instant.now());
        var verified = new MediaDevHttpReceiverDestination.Observation(MediaDevHttpReceiverDestination.Finding.ACK_VERIFIED, 0, java.time.Instant.now());
        for (MediaDeliveryEngine.Status status : MediaDeliveryEngine.Status.values()) {
            for (var observed : new MediaDevHttpReceiverDestination.Observation[] {null, absent, mismatch, verified}) {
                String state = MediaDevDeliveryRoutes.ackState(status, observed);
                assertThat(state.equals("DELIVERED")).as(status + " " + observed)
                        .isEqualTo(status == MediaDeliveryEngine.Status.DESTINATION_CONFIRMED);
            }
        }
        assertThat(MediaDevDeliveryRoutes.ackState(MediaDeliveryEngine.Status.OUTCOME_UNKNOWN, absent)).isEqualTo("NOT_DELIVERED");
        assertThat(MediaDevDeliveryRoutes.ackState(MediaDeliveryEngine.Status.OUTCOME_UNKNOWN, mismatch)).isEqualTo("UNKNOWN");
        assertThat(MediaDevDeliveryRoutes.ackState(MediaDeliveryEngine.Status.OUTCOME_UNKNOWN, verified)).isEqualTo("UNKNOWN");
        assertThat(MediaDevDeliveryRoutes.ackState(MediaDeliveryEngine.Status.UNAVAILABLE, null)).isEqualTo("NOT_DELIVERED");
    }
}
