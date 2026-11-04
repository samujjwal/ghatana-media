package com.ghatana.audio.streaming;

import com.ghatana.audio.streaming.StreamIntentSupport.IntentDisposition;
import com.ghatana.audio.streaming.StreamIntentSupport.Support;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * AS-06: each of the 17 PDP media.stream intents is either implemented with a
 * real test, delegated to its owning surface, or NOT_ADMITTED with the gap —
 * no transport is fabricated.
 */
@DisplayName("StreamIntentSupport")
class StreamIntentSupportTest {

    /** Exact PDP-0 media.stream family leaf intent IDs. */
    private static final Set<String> PDP_STREAM_LEAVES = Set.of(
            "media.stream.session.open",
            "media.stream.session.connect",
            "media.stream.frame.submit",
            "media.stream.frame.acknowledge",
            "media.stream.session.close",
            "media.stream.session.reconnect",
            "media.stream.ordering.enforce",
            "media.stream.lease.renew",
            "media.stream.buffer.bound",
            "media.stream.backpressure.apply",
            "media.stream.recording.integrate",
            "media.stream.live-processing.integrate",
            "media.stream.transport.webrtc",
            "media.stream.transport.adaptive-http",
            "media.stream.transport.hls",
            "media.stream.transport.dash",
            "media.stream.caption.live");

    @Test
    @DisplayName("the matrix covers exactly the 17 PDP stream leaf intents")
    void coversAllSeventeenLeaves() {
        Set<String> covered = StreamIntentSupport.coveredIntents();
        assertThat(covered)
                .containsExactlyInAnyOrderElementsOf(PDP_STREAM_LEAVES);
        assertThat(covered).hasSize(17);
        for (String intentId : PDP_STREAM_LEAVES) {
            IntentDisposition disposition = StreamIntentSupport.dispositionOf(intentId);
            assertThat(disposition).as(intentId).isNotNull();
            assertThat(disposition.intentId()).isEqualTo(intentId);
            assertThat(disposition.basis()).isNotBlank();
            // This matrix is the module's local code disposition only. It
            // does not make PDP draft leaves or API-parity entries admitted.
            assertThat(StreamIntentSupport.admittedHere(intentId))
                    .as("local admission must agree with the one explicit owner disposition for %s", intentId)
                    .isEqualTo(disposition.support() == Support.IMPLEMENTED);
        }
    }

    @Test
    @DisplayName("every leaf has one explicit local owner disposition")
    void dispositionsMatchTheCurrentOwnerMatrix() {
        Map<Support, Set<String>> expected = Map.of(
                Support.IMPLEMENTED, Set.of(
                        "media.stream.session.open",
                        "media.stream.session.connect",
                        "media.stream.frame.submit",
                        "media.stream.frame.acknowledge",
                        "media.stream.session.close",
                        "media.stream.session.reconnect",
                        "media.stream.ordering.enforce",
                        "media.stream.buffer.bound",
                        "media.stream.backpressure.apply"),
                Support.DELEGATED, Set.of(
                        "media.stream.recording.integrate",
                        "media.stream.live-processing.integrate",
                        "media.stream.caption.live"),
                Support.NOT_ADMITTED, Set.of(
                        "media.stream.lease.renew",
                        "media.stream.transport.webrtc",
                        "media.stream.transport.adaptive-http",
                        "media.stream.transport.hls",
                        "media.stream.transport.dash"));

        for (Map.Entry<Support, Set<String>> disposition : expected.entrySet()) {
            Set<String> actual = PDP_STREAM_LEAVES.stream()
                    .filter(intentId -> StreamIntentSupport.dispositionOf(intentId).support()
                            == disposition.getKey())
                    .collect(java.util.stream.Collectors.toSet());
            assertThat(actual).as("owner disposition %s", disposition.getKey())
                    .containsExactlyInAnyOrderElementsOf(disposition.getValue());
        }
        // A map keyed by intent ID plus exact partition equality proves each
        // existing leaf is classified once; it does not assert source-owner
        // acceptance, transport qualification, or route-semantic resolution.
        assertThat(expected.values().stream().mapToInt(Set::size).sum()).isEqualTo(17);
    }

    @Test
    @DisplayName("ordered-session intents implemented in this module are admitted")
    void implementedIntentsAdmitted() {
        Set<String> implemented = Set.of(
                "media.stream.session.open",
                "media.stream.session.connect",
                "media.stream.frame.submit",
                "media.stream.frame.acknowledge",
                "media.stream.session.close",
                "media.stream.session.reconnect",
                "media.stream.ordering.enforce",
                "media.stream.buffer.bound",
                "media.stream.backpressure.apply");
        for (String intentId : implemented) {
            assertThat(StreamIntentSupport.dispositionOf(intentId).support())
                    .as(intentId).isEqualTo(Support.IMPLEMENTED);
            assertThat(StreamIntentSupport.admittedHere(intentId)).as(intentId).isTrue();
        }
    }

    @Test
    @DisplayName("no WebRTC/adaptive-HTTP/HLS/DASH transport is claimed or fabricated")
    void transportsNotAdmitted() {
        for (String intentId : Set.of(
                "media.stream.transport.webrtc",
                "media.stream.transport.adaptive-http",
                "media.stream.transport.hls",
                "media.stream.transport.dash",
                "media.stream.lease.renew")) {
            assertThat(StreamIntentSupport.dispositionOf(intentId).support())
                    .as(intentId).isEqualTo(Support.NOT_ADMITTED);
            assertThat(StreamIntentSupport.admittedHere(intentId)).as(intentId).isFalse();
        }
    }

    @Test
    @DisplayName("lease renewal stays unadmitted until its owner contract binds authority and replay")
    void leaseRenewalNamesMissingOwnerEvidence() {
        IntentDisposition renewal = StreamIntentSupport.dispositionOf("media.stream.lease.renew");

        assertThat(renewal.support()).isEqualTo(Support.NOT_ADMITTED);
        assertThat(renewal.basis())
                .contains("canonical route is absent")
                .contains("session generation")
                .contains("current consent/rights refs")
                .contains("replay receipt")
                .contains("authoritative renewed-expiry result");
        assertThat(StreamIntentSupport.admittedHere("media.stream.lease.renew")).isFalse();
    }

    @Test
    @DisplayName("recording, live-processing and caption intents are delegated to owners")
    void delegatedIntentsNamed() {
        for (String intentId : Set.of(
                "media.stream.recording.integrate",
                "media.stream.live-processing.integrate",
                "media.stream.caption.live")) {
            IntentDisposition disposition = StreamIntentSupport.dispositionOf(intentId);
            assertThat(disposition.support()).as(intentId).isEqualTo(Support.DELEGATED);
            assertThat(disposition.basis()).as(intentId).contains("owner");
            assertThat(StreamIntentSupport.admittedHere(intentId)).as(intentId).isFalse();
        }
    }

    @Test
    @DisplayName("an unknown or non-stream intent is never reported as supported")
    void unknownIntentNotSupported() {
        assertThat(StreamIntentSupport.dispositionOf("media.stream.transport.srt")).isNull();
        assertThat(StreamIntentSupport.dispositionOf("media.job.submit")).isNull();
        assertThat(StreamIntentSupport.admittedHere("media.stream.transport.srt")).isFalse();
    }
}
