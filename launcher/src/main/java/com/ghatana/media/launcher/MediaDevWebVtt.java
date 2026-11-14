package com.ghatana.media.launcher;

import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Strict, bounded WebVTT reader for DEV_ONLY caption rendering.
 *
 * <p>Accepted: an optional UTF-8 BOM, the {@code WEBVTT} signature line (optionally followed by a space/tab and a
 * header text), header lines, then blank-line separated blocks. {@code NOTE}, {@code STYLE} and {@code REGION}
 * blocks are ignored. A cue block is an optional identifier line, a timing line
 * {@code [hh:]mm:ss.ttt --> [hh:]mm:ss.ttt}, and one or more text lines. Times are exact whole milliseconds by
 * syntax.
 *
 * <p>Typed refusals (never approximated): invalid UTF-8, NUL or other control characters, a missing signature, a
 * malformed timing, end not after start, start times that go backwards, overlapping cues, cue settings after the
 * timing (position/align/etc. are layout this renderer does not honour), and markup. Markup policy: cue text is
 * plain text; any {@code <} (WebVTT tags, voice spans, timestamps, HTML) is rejected with
 * {@code CAPTION_MARKUP_NOT_SUPPORTED} rather than stripped or interpreted. {@code &} is kept literally.
 */
final class MediaDevWebVtt {
    static final int MAX_BYTES = 1024 * 1024;
    static final int MAX_CUES = 5_000;
    static final int MAX_CUE_TEXT_CHARS = 4_096;
    static final int MAX_LINE_CHARS = 4_096;

    private static final String TS = "(?:(\\d{2,}):)?([0-5]\\d):([0-5]\\d)\\.(\\d{3})";
    private static final Pattern TIMING = Pattern.compile("^" + TS + "[ \\t]+-->[ \\t]+" + TS + "([ \\t].*)?$");

    record Cue(long startMillis, long endMillis, String text) { }

    /** Typed parse refusal; {@link #code()} is surfaced as the 422 code. */
    static final class WebVttException extends IllegalArgumentException {
        private final String code;
        WebVttException(String code, String message) { super(message); this.code = code; }
        String code() { return code; }
    }

    private MediaDevWebVtt() { }

    static List<Cue> parse(byte[] bytes) {
        if (bytes.length > MAX_BYTES) throw new WebVttException("RENDER_LIMIT_EXCEEDED", "WebVTT file exceeds the byte ceiling");
        String text;
        try {
            text = StandardCharsets.UTF_8.newDecoder().onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT).decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException invalid) {
            throw malformed("WebVTT file is not valid UTF-8");
        }
        if (text.startsWith("﻿")) text = text.substring(1);
        for (int i = 0; i < text.length(); i++) {
            char c = text.charAt(i);
            if (c == '\0' || (c < 0x20 && c != '\n' && c != '\r' && c != '\t') || c == 0x7f) {
                throw malformed("WebVTT file contains a control character");
            }
        }
        String[] lines = text.replace("\r\n", "\n").replace('\r', '\n').split("\n", -1);
        for (String line : lines) {
            if (line.length() > MAX_LINE_CHARS) {
                throw new WebVttException("RENDER_LIMIT_EXCEEDED", "WebVTT line exceeds the length ceiling");
            }
        }
        String first = lines[0];
        if (!first.startsWith("WEBVTT") || (first.length() > 6 && first.charAt(6) != ' ' && first.charAt(6) != '\t')) {
            throw malformed("WebVTT signature is missing");
        }
        int index = 1;
        while (index < lines.length && !lines[index].isEmpty()) index++; // header block

        List<Cue> cues = new ArrayList<>();
        long previousStart = -1;
        long previousEnd = -1;
        while (index < lines.length) {
            if (lines[index].isEmpty()) { index++; continue; }
            int blockStart = index;
            while (index < lines.length && !lines[index].isEmpty()) index++;
            List<String> block = List.of(lines).subList(blockStart, index);
            String head = block.get(0);
            if (head.equals("NOTE") || head.startsWith("NOTE ") || head.startsWith("NOTE\t")
                    || head.trim().equals("STYLE") || head.trim().equals("REGION")) {
                continue;
            }
            int timingLine = head.contains("-->") ? 0 : 1;
            if (timingLine == 1 && block.size() < 2) throw malformed("cue identifier has no timing line");
            String timing = block.get(timingLine);
            Matcher match = TIMING.matcher(timing);
            if (!match.matches()) throw malformed("cue timing is malformed");
            if (match.group(9) != null && !match.group(9).isBlank()) {
                throw new WebVttException("CAPTION_CUE_SETTINGS_NOT_SUPPORTED",
                        "cue settings are layout and are not supported");
            }
            long start = millis(match, 1);
            long end = millis(match, 5);
            if (end <= start) throw malformed("cue end must be after its start");
            if (start < previousStart) throw malformed("cue start times must not decrease");
            if (start < previousEnd) {
                throw new WebVttException("CAPTION_CUES_OVERLAP", "overlapping cues are not supported");
            }
            if (block.size() <= timingLine + 1) throw malformed("cue has no text");
            StringBuilder cueText = new StringBuilder();
            for (String line : block.subList(timingLine + 1, block.size())) {
                if (line.contains("-->")) throw malformed("cue text must not contain a timing arrow");
                if (line.indexOf('<') >= 0) {
                    throw new WebVttException("CAPTION_MARKUP_NOT_SUPPORTED",
                            "cue text markup is not supported; captions are rendered as plain text");
                }
                if (cueText.length() > 0) cueText.append('\n');
                cueText.append(line);
            }
            if (cueText.length() > MAX_CUE_TEXT_CHARS) {
                throw new WebVttException("RENDER_LIMIT_EXCEEDED", "cue text exceeds the length ceiling");
            }
            if (cueText.toString().isBlank()) throw malformed("cue text is blank");
            if (cues.size() >= MAX_CUES) {
                throw new WebVttException("RENDER_LIMIT_EXCEEDED", "WebVTT file exceeds the cue count ceiling");
            }
            cues.add(new Cue(start, end, cueText.toString()));
            previousStart = start;
            previousEnd = end;
        }
        return List.copyOf(cues);
    }

    private static long millis(Matcher match, int group) {
        long hours = match.group(group) == null ? 0 : Long.parseLong(match.group(group));
        if (hours > 10_000) throw new WebVttException("RENDER_LIMIT_EXCEEDED", "cue time exceeds the ceiling");
        return ((hours * 60 + Long.parseLong(match.group(group + 1))) * 60 + Long.parseLong(match.group(group + 2)))
                * 1000 + Long.parseLong(match.group(group + 3));
    }

    private static WebVttException malformed(String message) {
        return new WebVttException("CAPTION_WEBVTT_MALFORMED", message);
    }
}
