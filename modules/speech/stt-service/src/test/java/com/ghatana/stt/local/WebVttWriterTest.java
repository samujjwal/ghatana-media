package com.ghatana.stt.local;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

class WebVttWriterTest {
    @Test
    void writesOrderedEscapedCuesWithExactMillisecondTimestamps() {
        String vtt = new String(WebVttWriter.write(List.of(
                new WebVttWriter.Cue(0, 1500, "Fish & <chips>"),
                new WebVttWriter.Cue(1400, 3_723_004, "overlapping start is clamped"),
                new WebVttWriter.Cue(4_000_000, 4_000_000, "zero length gets one millisecond"),
                new WebVttWriter.Cue(5_000_000, 5_000_100, "   "))), StandardCharsets.UTF_8);
        assertThat(vtt).isEqualTo("""
                WEBVTT

                1
                00:00:00.000 --> 00:00:01.500
                Fish &amp; &lt;chips&gt;

                2
                00:00:01.500 --> 01:02:03.004
                overlapping start is clamped

                3
                01:06:40.000 --> 01:06:40.001
                zero length gets one millisecond

                """);
    }
}
