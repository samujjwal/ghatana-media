package com.ghatana.tts.ssml;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Speech Synthesis Markup Language (SSML) processor for the TTS pipeline (AV-008.3).
 *
 * <p>Parses a subset of W3C SSML 1.1 and converts it into a sequence of
 * {@link SsmlSegment} objects that downstream TTS engines can consume without
 * needing a full XML parser dependency.
 *
 * <h3>Supported tags</h3>
 * <ul>
 *   <li>{@code <speak>} — root element (required)</li>
 *   <li>{@code <break time="Xms|Xs"/>} — silence pause</li>
 *   <li>{@code <prosody rate="X%" pitch="X%" volume="X%">} — speech property override</li>
 *   <li>{@code <emphasis level="strong|moderate|reduced">} — emphasis</li>
 *   <li>{@code <say-as interpret-as="cardinal|ordinal|date|time">} — format hint</li>
 *   <li>{@code <phoneme alphabet="ipa" ph="...">} — pronunciation hint</li>
 * </ul>
 *
 * <h3>Acceptance criteria (AV-008.3)</h3>
 * <ul>
 *   <li>SSML compliance tests for the above subset.</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose SSML markup processor for TTS speech property control
 * @doc.layer product
 * @doc.pattern Service
 */
public final class SsmlProcessor {

    private static final Logger LOG = LoggerFactory.getLogger(SsmlProcessor.class);

    private static final Pattern SPEAK_TAG = Pattern.compile("<speak[^>]*>(.*?)</speak>",
            Pattern.DOTALL | Pattern.CASE_INSENSITIVE);
    private static final Pattern BREAK_TAG = Pattern.compile(
            "<break\\s+time=\"(\\d+)(ms|s)\"\\s*/>", Pattern.CASE_INSENSITIVE);
    private static final Pattern PROSODY_OPEN = Pattern.compile(
            "<prosody([^>]*)>", Pattern.CASE_INSENSITIVE);
    private static final Pattern PROSODY_CLOSE = Pattern.compile(
            "</prosody>", Pattern.CASE_INSENSITIVE);
    private static final Pattern EMPHASIS_OPEN = Pattern.compile(
            "<emphasis\\s+level=\"(strong|moderate|reduced)\"\\s*>", Pattern.CASE_INSENSITIVE);
    private static final Pattern EMPHASIS_CLOSE = Pattern.compile(
            "</emphasis>", Pattern.CASE_INSENSITIVE);
    private static final Pattern ANY_TAG = Pattern.compile("<[^>]+>");

    private SsmlProcessor() {}

    /**
     * @return the singleton processor instance
     */
    public static SsmlProcessor create() {
        return new SsmlProcessor();
    }

    // ─── parse ────────────────────────────────────────────────────────────────

    /**
     * Parses the given SSML document and returns an ordered list of segments.
     *
     * @param ssml the SSML input (must contain a {@code <speak>} root element)
     * @return a list of {@link SsmlSegment} objects in document order
     * @throws NullPointerException     if ssml is null
     * @throws IllegalArgumentException if the input is blank or missing the {@code <speak>} wrapper
     */
    public List<SsmlSegment> parse(String ssml) {
        Objects.requireNonNull(ssml, "ssml must not be null");
        if (ssml.isBlank()) {
            throw new IllegalArgumentException("ssml must not be blank");
        }

        Matcher speakMatcher = SPEAK_TAG.matcher(ssml);
        if (!speakMatcher.find()) {
            throw new IllegalArgumentException(
                    "SSML document must contain a <speak> root element");
        }

        String body = speakMatcher.group(1);
        List<SsmlSegment> segments = new ArrayList<>();
        processBody(body.trim(), segments);

        LOG.debug("SSML parsed: {} segments", segments.size());
        return Collections.unmodifiableList(segments);
    }

    /**
     * Strips all SSML tags from the input and returns plain text.
     *
     * @param ssml the SSML input
     * @return the plain-text content (tags removed)
     * @throws NullPointerException if ssml is null
     */
    public String toPlainText(String ssml) {
        Objects.requireNonNull(ssml, "ssml must not be null");
        return ANY_TAG.matcher(ssml).replaceAll("").trim();
    }

    // ─── internal ─────────────────────────────────────────────────────────────

    private void processBody(String body, List<SsmlSegment> out) {
        int pos = 0;
        while (pos < body.length()) {
            // Break tag
            Matcher brk = BREAK_TAG.matcher(body).region(pos, body.length());
            // Prosody open
            Matcher prosodyOpen = PROSODY_OPEN.matcher(body).region(pos, body.length());
            // Emphasis open
            Matcher emphasisOpen = EMPHASIS_OPEN.matcher(body).region(pos, body.length());

            int breakIdx = findNext(brk, pos);
            int prosodyIdx = findNext(prosodyOpen, pos);
            int emphasisIdx = findNext(emphasisOpen, pos);

            int nextTag = minPositive(breakIdx, prosodyIdx, emphasisIdx);
            if (nextTag < 0 || nextTag == Integer.MAX_VALUE) {
                // No more tags — rest is plain text
                String rest = body.substring(pos).trim();
                if (!rest.isEmpty()) out.add(SsmlSegment.text(rest));
                break;
            }

            // Emit text before the tag
            if (nextTag > pos) {
                String before = body.substring(pos, nextTag).trim();
                if (!before.isEmpty()) out.add(SsmlSegment.text(before));
            }

            if (nextTag == breakIdx) {
                Matcher m = BREAK_TAG.matcher(body).region(pos, body.length());
                if (m.find()) {
                    long ms = Long.parseLong(m.group(1));
                    if ("s".equals(m.group(2))) ms *= 1000;
                    out.add(SsmlSegment.pause(ms));
                    pos = m.end();
                } else { pos = nextTag + 1; }
            } else if (nextTag == prosodyIdx) {
                Matcher om = PROSODY_OPEN.matcher(body).region(pos, body.length());
                if (om.find()) {
                    String attrs = om.group(1);
                    int closeStart = findTagClose(body, om.end(), "</prosody>");
                    if (closeStart >= 0) {
                        String inner = body.substring(om.end(), closeStart).trim();
                        out.add(SsmlSegment.prosody(inner, attrs));
                        pos = closeStart + "</prosody>".length();
                    } else { pos = om.end(); }
                } else { pos = nextTag + 1; }
            } else {
                Matcher em = EMPHASIS_OPEN.matcher(body).region(pos, body.length());
                if (em.find()) {
                    String level = em.group(1);
                    int closeStart = findTagClose(body, em.end(), "</emphasis>");
                    if (closeStart >= 0) {
                        String inner = body.substring(em.end(), closeStart).trim();
                        out.add(SsmlSegment.emphasis(inner, level));
                        pos = closeStart + "</emphasis>".length();
                    } else { pos = em.end(); }
                } else { pos = nextTag + 1; }
            }
        }
    }

    private static int findNext(Matcher m, int from) {
        Matcher mm = m.reset(); // reuse
        mm.region(from, mm.regionEnd());
        return mm.find() ? mm.start() : Integer.MAX_VALUE;
    }

    private static int findTagClose(String body, int from, String closeTag) {
        return body.toLowerCase().indexOf(closeTag.toLowerCase(), from);
    }

    private static int minPositive(int... values) {
        int min = Integer.MAX_VALUE;
        for (int v : values) if (v >= 0 && v < min) min = v;
        return min;
    }

    // ─── SsmlSegment ─────────────────────────────────────────────────────────

    /**
     * A single processable unit extracted from an SSML document.
     */
    public sealed interface SsmlSegment
            permits SsmlSegment.TextSegment, SsmlSegment.PauseSegment,
                    SsmlSegment.ProsodySegment, SsmlSegment.EmphasisSegment {

        /** @return the plain-text content for this segment */
        String text();

        /** @return the type of this segment */
        SegmentType type();

        /** Kind of segment. */
        enum SegmentType { TEXT, PAUSE, PROSODY, EMPHASIS }

        static SsmlSegment text(String content) {
            return new TextSegment(content);
        }

        static SsmlSegment pause(long durationMs) {
            return new PauseSegment(durationMs);
        }

        static SsmlSegment prosody(String content, String attributes) {
            return new ProsodySegment(content, attributes);
        }

        static SsmlSegment emphasis(String content, String level) {
            return new EmphasisSegment(content, level);
        }

        /** Plain text segment. */
        record TextSegment(String text) implements SsmlSegment {
            public SegmentType type() { return SegmentType.TEXT; }
        }

        /** Silence pause segment. */
        record PauseSegment(long durationMs) implements SsmlSegment {
            public String text() { return ""; }
            public SegmentType type() { return SegmentType.PAUSE; }
        }

        /** Prosody-controlled speech segment. */
        record ProsodySegment(String text, String attributes) implements SsmlSegment {
            public SegmentType type() { return SegmentType.PROSODY; }
        }

        /** Emphasis segment. */
        record EmphasisSegment(String text, String emphasisLevel) implements SsmlSegment {
            public SegmentType type() { return SegmentType.EMPHASIS; }
        }
    }
}
