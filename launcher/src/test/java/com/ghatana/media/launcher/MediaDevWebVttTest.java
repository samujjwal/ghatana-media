package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaDevWebVttTest {
    private static List<MediaDevWebVtt.Cue> parse(String text) {
        return MediaDevWebVtt.parse(text.getBytes(StandardCharsets.UTF_8));
    }

    private static void refused(String text, String code) {
        assertThatThrownBy(() -> parse(text)).isInstanceOfSatisfying(MediaDevWebVtt.WebVttException.class,
                failure -> assertThat(failure.code()).as(failure.getMessage()).isEqualTo(code));
    }

    @Test
    void parsesCuesIgnoringNoteStyleRegionAndIdentifiers() {
        var cues = parse("﻿WEBVTT header text\nX-Header: y\n\nNOTE a\nb\n\nSTYLE\n::cue{}\n\nREGION\nid:r\n\n"
                + "00:05.250 --> 00:06.000\r\nmm:ss form\r\n\r\nid-1\n01:02:03.004 --> 01:02:04.000\nline one\nline two\n");
        assertThat(cues).hasSize(2);
        assertThat(cues.get(1).startMillis()).isEqualTo(((60L + 2) * 60 + 3) * 1000 + 4);
        assertThat(cues.get(1).text()).isEqualTo("line one\nline two");
        assertThat(cues.get(0)).isEqualTo(new MediaDevWebVtt.Cue(5_250, 6_000, "mm:ss form"));
        assertThat(parse("WEBVTT\n")).isEmpty();
    }

    @Test
    void refusesMalformedStructureAndTimings() {
        refused("hello\n", "CAPTION_WEBVTT_MALFORMED");
        refused("WEBVTTX\n", "CAPTION_WEBVTT_MALFORMED");
        refused("WEBVTT\n\n00:00.000 --> 00:00.000\nx\n", "CAPTION_WEBVTT_MALFORMED");
        refused("WEBVTT\n\n00:02.000 --> 00:01.000\nx\n", "CAPTION_WEBVTT_MALFORMED");
        refused("WEBVTT\n\n00:0.000 --> 00:01.000\nx\n", "CAPTION_WEBVTT_MALFORMED");
        refused("WEBVTT\n\n00:00.00 --> 00:01.000\nx\n", "CAPTION_WEBVTT_MALFORMED");
        refused("WEBVTT\n\n00:60.000 --> 01:01.000\nx\n", "CAPTION_WEBVTT_MALFORMED");
        refused("WEBVTT\n\nid\n", "CAPTION_WEBVTT_MALFORMED");
        refused("WEBVTT\n\n00:00.000 --> 00:01.000\n", "CAPTION_WEBVTT_MALFORMED");
        refused("WEBVTT\n\n00:00.000 --> 00:01.000\na --> b\n", "CAPTION_WEBVTT_MALFORMED");
        refused("WEBVTT\n\n00:01.000 --> 00:02.000\na\n\n00:00.000 --> 00:00.500\nb\n", "CAPTION_WEBVTT_MALFORMED");
        refused("WEBVTT\n\n00:00.000 --> 00:01.000\na\u0001b\n", "CAPTION_WEBVTT_MALFORMED");
        assertThatThrownBy(() -> MediaDevWebVtt.parse(new byte[] {'W', 'E', 'B', 'V', 'T', 'T', '\n', (byte) 0xff}))
                .isInstanceOf(MediaDevWebVtt.WebVttException.class);
    }

    @Test
    void refusesOverlapMarkupAndCueSettingsInsteadOfApproximating() {
        refused("WEBVTT\n\n00:00.000 --> 00:01.000\na\n\n00:00.500 --> 00:02.000\nb\n", "CAPTION_CUES_OVERLAP");
        refused("WEBVTT\n\n00:00.000 --> 00:01.000\n<b>a</b>\n", "CAPTION_MARKUP_NOT_SUPPORTED");
        refused("WEBVTT\n\n00:00.000 --> 00:01.000\n<v Bob>a\n", "CAPTION_MARKUP_NOT_SUPPORTED");
        refused("WEBVTT\n\n00:00.000 --> 00:01.000 align:start\na\n", "CAPTION_CUE_SETTINGS_NOT_SUPPORTED");
        assertThat(parse("WEBVTT\n\n00:00.000 --> 00:01.000\nTom & Jerry &amp; co\n").get(0).text())
                .isEqualTo("Tom & Jerry &amp; co");
    }

    @Test
    void enforcesExplicitCaps() {
        StringBuilder monotonic = new StringBuilder("WEBVTT\n\n");
        for (int i = 0; i <= MediaDevWebVtt.MAX_CUES; i++) {
            long start = i * 10L;
            monotonic.append(String.format("%02d:%02d:%02d.%03d --> %02d:%02d:%02d.%03d\nx\n\n",
                    start / 3_600_000, start / 60_000 % 60, start / 1000 % 60, start % 1000,
                    (start + 5) / 3_600_000, (start + 5) / 60_000 % 60, (start + 5) / 1000 % 60, (start + 5) % 1000));
        }
        refused(monotonic.toString(), "RENDER_LIMIT_EXCEEDED");
        refused("WEBVTT\n\n00:00.000 --> 00:01.000\n" + "x".repeat(MediaDevWebVtt.MAX_LINE_CHARS + 1) + "\n",
                "RENDER_LIMIT_EXCEEDED");
        String longText = ("x".repeat(2_000) + "\n").repeat(3);
        refused("WEBVTT\n\n00:00.000 --> 00:01.000\n" + longText, "RENDER_LIMIT_EXCEEDED");
        assertThatThrownBy(() -> MediaDevWebVtt.parse(new byte[MediaDevWebVtt.MAX_BYTES + 1]))
                .isInstanceOfSatisfying(MediaDevWebVtt.WebVttException.class,
                        failure -> assertThat(failure.code()).isEqualTo("RENDER_LIMIT_EXCEEDED"));
    }
}
