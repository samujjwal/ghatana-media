package com.ghatana.audio.video.vision.video;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

class SourceMediaTimestampTest {
    @Test
    void acceptsExactAndRoundedPositivePtsConversions() {
        assertThat(SourceMediaTimestamp.fromPts("90000", "1/90000").timestampMs()).isEqualTo(1000L);
        assertThat(SourceMediaTimestamp.fromPts("1", "1/3").timestampMs()).isEqualTo(333L);
        assertThat(SourceMediaTimestamp.fromPts("1", "1/8").timestampMs()).isEqualTo(125L);
    }

    @Test
    void preservesNegativePtsAndRoundsAwayFromZeroAtHalfMillis() {
        var timestamp = SourceMediaTimestamp.fromPts("-1", "1/2000");

        assertThat(timestamp.isKnown()).isTrue();
        assertThat(timestamp.pts()).isEqualTo(-1L);
        assertThat(timestamp.timestampMs()).isEqualTo(-1L);
    }

    @Test
    void rejectsForgedMillisAndReasonOnKnownTimestamps() {
        assertThatThrownBy(() -> new SourceMediaTimestamp(
                SourceMediaTimestamp.Status.KNOWN, 90_000L, 1L, 90_000L, 999L, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("match PTS and timebase");
        assertThatThrownBy(() -> new SourceMediaTimestamp(
                SourceMediaTimestamp.Status.KNOWN, 90_000L, 1L, 90_000L, 1_000L, "UNEXPECTED"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("must not have an unknown reason");
    }

    @Test
    void rejectsKnownTimestampConversionOutsideLongRange() {
        assertThatThrownBy(() -> new SourceMediaTimestamp(
                SourceMediaTimestamp.Status.KNOWN, Long.MAX_VALUE, 1_000_000_000L, 1L, 0L, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("outside the supported range");
    }

    @Test
    void rejectsUnboundedTimebaseThroughCanonicalConstructor() {
        assertThatThrownBy(() -> new SourceMediaTimestamp(
                SourceMediaTimestamp.Status.KNOWN, 1L, 1_000_000_001L, 1L, 1_000_000_001_000L, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("positive bounded rational");
    }

    @Test
    void preservesUnknownTimestampRules() {
        assertThat(SourceMediaTimestamp.unknown("SOURCE_PTS_MISSING"))
                .satisfies(timestamp -> {
                    assertThat(timestamp.isKnown()).isFalse();
                    assertThat(timestamp.pts()).isNull();
                    assertThat(timestamp.timestampMs()).isNull();
                    assertThat(timestamp.reason()).isEqualTo("SOURCE_PTS_MISSING");
                });
        assertThatThrownBy(() -> new SourceMediaTimestamp(
                SourceMediaTimestamp.Status.UNKNOWN, null, null, null, null, " "))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("require a reason");
        assertThatThrownBy(() -> new SourceMediaTimestamp(
                SourceMediaTimestamp.Status.UNKNOWN, 1L, 1L, 1000L, 1L, "UNKNOWN"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("no fabricated values");
    }
}
