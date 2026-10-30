package com.ghatana.audio.streaming;

import com.ghatana.audio.streaming.StreamIntentSupport.IntentDisposition;
import com.ghatana.audio.streaming.StreamIntentSupport.Support;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

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
        assertThat(StreamIntentSupport.coveredIntents())
                .containsExactlyInAnyOrderElementsOf(PDP_STREAM_LEAVES);
        for (String intentId : PDP_STREAM_LEAVES) {
            IntentDisposition disposition = StreamIntentSupport.dispositionOf(intentId);
            assertThat(disposition).as(intentId).isNotNull();
            assertThat(disposition.intentId()).isEqualTo(intentId);
            assertThat(disposition.basis()).isNotBlank();
        }
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
