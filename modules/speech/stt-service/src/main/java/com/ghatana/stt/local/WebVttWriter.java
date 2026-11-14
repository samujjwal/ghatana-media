package com.ghatana.stt.local;

import java.nio.charset.StandardCharsets;
import java.util.List;

/**
 * Deterministic WebVTT serializer for recognizer segments. Cue text is escaped per the WebVTT text rules
 * ({@code &}, {@code <}, {@code >}); timings are exact whole milliseconds taken from the recognizer. The output
 * is a derived rendering of the transcript, not an independent caption authority or reviewed caption.
 */
public final class WebVttWriter {
    private WebVttWriter() { }

    public record Cue(long startMillis, long endMillis, String text) { }

    public static byte[] write(List<Cue> cues) {
        StringBuilder out = new StringBuilder("WEBVTT\n\n");
        long previousEnd = 0;
        int index = 1;
        for (Cue cue : cues) {
            String text = escape(cue.text().strip());
            if (text.isEmpty()) continue;
            // Recognizer segments can touch or marginally overlap; keep cues ordered and strictly positive.
            long start = Math.max(cue.startMillis(), previousEnd);
            long end = Math.max(cue.endMillis(), start + 1);
            out.append(index++).append('\n').append(timestamp(start)).append(" --> ").append(timestamp(end))
                    .append('\n').append(text).append("\n\n");
            previousEnd = end;
        }
        return out.toString().getBytes(StandardCharsets.UTF_8);
    }

    static String timestamp(long millis) {
        long hours = millis / 3_600_000;
        long minutes = millis / 60_000 % 60;
        long seconds = millis / 1_000 % 60;
        return "%02d:%02d:%02d.%03d".formatted(hours, minutes, seconds, millis % 1_000);
    }

    private static String escape(String text) {
        return text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
                .replace("\r\n", "\n").replace('\r', '\n').replaceAll("\n{2,}", "\n");
    }
}
