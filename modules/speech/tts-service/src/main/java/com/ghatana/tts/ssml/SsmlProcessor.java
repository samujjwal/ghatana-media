package com.ghatana.tts.ssml;

import java.io.StringReader;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import javax.xml.XMLConstants;
import javax.xml.parsers.DocumentBuilderFactory;
import org.w3c.dom.Document;
import org.w3c.dom.Element;
import org.w3c.dom.Node;
import org.xml.sax.InputSource;

/** Bounded, hardened parser for the supported canonical SSML subset. */
public final class SsmlProcessor {
    private static final String SSML_NAMESPACE = "http://www.w3.org/2001/10/synthesis";
    public static final int MAX_INPUT_CHARS = 65_536;
    public static final int MAX_DEPTH = 16;
    public static final long MAX_PAUSE_MS = 10_000;
    public static final long MAX_TOTAL_PAUSE_MS = 30_000;
    public static final int MAX_VOICE_NAME_CHARS = 255;

    private SsmlProcessor() {}

    public static SsmlProcessor create() { return new SsmlProcessor(); }

    public List<SsmlSegment> parse(String ssml) {
        Objects.requireNonNull(ssml, "ssml must not be null");
        if (ssml.isBlank()) throw new IllegalArgumentException("ssml must not be blank");
        if (ssml.length() > MAX_INPUT_CHARS) throw new IllegalArgumentException("SSML input exceeds maximum size");
        try {
            DocumentBuilderFactory factory = DocumentBuilderFactory.newInstance();
            factory.setNamespaceAware(false);
            factory.setXIncludeAware(false);
            factory.setExpandEntityReferences(false);
            factory.setFeature(XMLConstants.FEATURE_SECURE_PROCESSING, true);
            factory.setFeature("http://apache.org/xml/features/disallow-doctype-decl", true);
            factory.setFeature("http://xml.org/sax/features/external-general-entities", false);
            factory.setFeature("http://xml.org/sax/features/external-parameter-entities", false);
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_DTD, "");
            factory.setAttribute(XMLConstants.ACCESS_EXTERNAL_SCHEMA, "");
            // Bound parser work before constructing the DOM. The post-parse traversal check
            // below remains useful for the canonical SSML nesting rules, but cannot protect
            // the parser from allocating a deeply nested tree on its own.
            factory.setAttribute("http://www.oracle.com/xml/jaxp/properties/maxElementDepth",
                    Integer.toString(MAX_DEPTH));
            Document document = factory.newDocumentBuilder().parse(new InputSource(new StringReader(ssml)));
            Element root = document.getDocumentElement();
            if (root == null || !"speak".equals(root.getTagName())) {
                throw new IllegalArgumentException("SSML document must contain a <speak> root element");
            }
            validateAttributes(root, "speak");
            List<SsmlSegment> segments = new ArrayList<>();
            long[] totalPause = {0};
            appendChildren(root, segments, 1, totalPause);
            return Collections.unmodifiableList(segments);
        } catch (IllegalArgumentException exception) {
            throw exception;
        } catch (Exception exception) {
            throw new IllegalArgumentException("Malformed or unsafe SSML document", exception);
        }
    }

    public String toPlainText(String input) {
        Objects.requireNonNull(input, "ssml must not be null");
        if (input.length() > MAX_INPUT_CHARS) throw new IllegalArgumentException("SSML input exceeds maximum size");
        if (!input.stripLeading().startsWith("<")) return input.trim();
        return parse(input).stream().map(SsmlSegment::text).filter(s -> !s.isBlank()).reduce((a, b) -> a + " " + b).orElse("").trim();
    }

    private static void appendChildren(Element parent, List<SsmlSegment> out, int depth, long[] totalPause) {
        if (depth > MAX_DEPTH) throw new IllegalArgumentException("SSML nesting exceeds maximum depth");
        for (Node node = parent.getFirstChild(); node != null; node = node.getNextSibling()) {
            if (node.getNodeType() == Node.TEXT_NODE || node.getNodeType() == Node.CDATA_SECTION_NODE) {
                String text = node.getNodeValue().trim();
                if (!text.isEmpty()) out.add(SsmlSegment.text(text));
                continue;
            }
            if (node.getNodeType() != Node.ELEMENT_NODE) continue;
            Element element = (Element) node;
            String tag = element.getTagName().toLowerCase(Locale.ROOT);
            validateAttributes(element, tag);
            switch (tag) {
                case "break" -> {
                    long pause = parsePause(element.getAttribute("time"));
                    totalPause[0] = Math.addExact(totalPause[0], pause);
                    if (pause > MAX_PAUSE_MS || totalPause[0] > MAX_TOTAL_PAUSE_MS) {
                        throw new IllegalArgumentException("SSML pause exceeds configured duration limit");
                    }
                    out.add(SsmlSegment.pause(pause));
                }
                case "prosody" -> {
                    requireTextOnlyContent(element, tag);
                    out.add(SsmlSegment.prosody(element.getTextContent().trim(), canonicalAttributes(element)));
                }
                case "emphasis" -> {
                    requireTextOnlyContent(element, tag);
                    out.add(SsmlSegment.emphasis(element.getTextContent().trim(), element.getAttribute("level").toLowerCase(Locale.ROOT)));
                }
                case "phoneme" -> {
                    requireTextOnlyContent(element, tag);
                    out.add(SsmlSegment.phoneme(element.getTextContent().trim(),
                            element.getAttribute("alphabet"), element.getAttribute("ph")));
                }
                case "sub" -> {
                    requireTextOnlyContent(element, tag);
                    out.add(SsmlSegment.substitution(element.getTextContent().trim(), element.getAttribute("alias")));
                }
                case "lang" -> {
                    requireTextOnlyContent(element, tag);
                    String language = element.hasAttribute("xml:lang")
                            ? element.getAttribute("xml:lang") : element.getAttribute("lang");
                    if (language.isBlank()) throw new IllegalArgumentException("SSML lang requires xml:lang or lang");
                    out.add(SsmlSegment.language(element.getTextContent().trim(), language));
                }
                case "say-as" -> appendChildren(element, out, depth + 1, totalPause);
                case "voice" -> {
                    requireTextOnlyContent(element, tag);
                    out.add(SsmlSegment.voice(
                            element.getTextContent().trim(), element.getAttribute("name").trim()));
                }
                default -> throw new IllegalArgumentException("Unsupported SSML tag: " + tag);
            }
        }
    }

    private static long parsePause(String value) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException("SSML break requires time");
        String normalized = value.trim().toLowerCase(Locale.ROOT);
        try {
            if (normalized.endsWith("ms")) return Long.parseLong(normalized.substring(0, normalized.length() - 2));
            if (normalized.endsWith("s")) return Math.multiplyExact(Long.parseLong(normalized.substring(0, normalized.length() - 1)), 1000);
        } catch (ArithmeticException | NumberFormatException exception) {
            throw new IllegalArgumentException("Invalid SSML break duration", exception);
        }
        throw new IllegalArgumentException("SSML break time must use ms or s");
    }

    private static void requireTextOnlyContent(Element element, String tag) {
        for (Node child = element.getFirstChild(); child != null; child = child.getNextSibling()) {
            if (child.getNodeType() == Node.ELEMENT_NODE) {
                throw new IllegalArgumentException("Nested SSML elements are unsupported inside <" + tag + ">");
            }
            if (tag.equals("break") && (child.getNodeType() == Node.CDATA_SECTION_NODE
                    || child.getNodeType() == Node.TEXT_NODE && !child.getNodeValue().isBlank())) {
                throw new IllegalArgumentException("SSML break content must be empty");
            }
        }
    }

    private static void validateAttributes(Element element, String tag) {
        var attrs = element.getAttributes();
        for (int i = 0; i < attrs.getLength(); i++) {
            var attribute = attrs.item(i);
            String name = attribute.getNodeName().toLowerCase(Locale.ROOT);
            boolean allowed = switch (tag) {
                case "break" -> name.equals("time");
                case "prosody" -> List.of("rate", "pitch", "volume").contains(name);
                case "emphasis" -> name.equals("level");
                case "say-as" -> name.equals("interpret-as") || name.equals("format");
                case "phoneme" -> name.equals("alphabet") || name.equals("ph");
                case "voice" -> name.equals("name");
                case "lang" -> name.equals("xml:lang") || name.equals("lang");
                case "sub" -> name.equals("alias");
                case "speak" -> List.of("version", "xml:lang", "lang").contains(name);
                default -> false;
            };
            // The standard SSML document declares its default namespace on <speak>.
            // Keep namespace support narrow: prefixed/nested declarations and other
            // namespace URIs are not part of the currently supported subset.
            if (!allowed && tag.equals("speak") && name.equals("xmlns")
                    && SSML_NAMESPACE.equals(attribute.getNodeValue())) {
                allowed = true;
            }
            if (!allowed) throw new IllegalArgumentException("Unsupported SSML attribute " + name + " on " + tag);
        }
        if (tag.equals("emphasis") && !List.of("strong", "moderate", "reduced", "none").contains(element.getAttribute("level").toLowerCase(Locale.ROOT))) {
            throw new IllegalArgumentException("Unsupported emphasis level");
        }
        if (tag.equals("say-as") && !List.of("cardinal", "ordinal", "date", "time", "characters", "spell-out").contains(element.getAttribute("interpret-as").toLowerCase(Locale.ROOT))) {
            throw new IllegalArgumentException("Unsupported say-as interpretation");
        }
        if (tag.equals("phoneme") && (!element.getAttribute("alphabet").equalsIgnoreCase("ipa") || element.getAttribute("ph").isBlank())) {
            throw new IllegalArgumentException("Only phoneme alphabet=ipa with a nonblank ph value is supported");
        }
        if (tag.equals("sub") && element.getAttribute("alias").isBlank()) {
            throw new IllegalArgumentException("SSML sub requires a nonblank alias");
        }
        if (tag.equals("voice")) {
            String name = element.getAttribute("name").trim();
            if (name.isBlank()) throw new IllegalArgumentException("SSML voice requires a nonblank name");
            if (name.length() > MAX_VOICE_NAME_CHARS) {
                throw new IllegalArgumentException("SSML voice name exceeds maximum length");
            }
        }
        if (tag.equals("lang") && element.getAttribute(element.hasAttribute("xml:lang") ? "xml:lang" : "lang").isBlank()) {
            throw new IllegalArgumentException("SSML lang requires xml:lang or lang");
        }
        if (tag.equals("break")) {
            long pause = parsePause(element.getAttribute("time"));
            if (pause < 0) throw new IllegalArgumentException("SSML break duration must not be negative");
            requireTextOnlyContent(element, tag);
        }
        if (tag.equals("prosody")) {
            validateRate(element.getAttribute("rate"));
            validatePitch(element.getAttribute("pitch"));
            validateVolume(element.getAttribute("volume"));
        }
    }

    private static String canonicalAttributes(Element element) {
        List<String> parts = new ArrayList<>();
        for (String key : List.of("rate", "pitch", "volume")) if (element.hasAttribute(key)) parts.add(key + "=\"" + element.getAttribute(key).trim() + "\"");
        return String.join(" ", parts);
    }

    private static void validateRate(String value) {
        if (value.isBlank()) return;
        String v = value.trim().toLowerCase(Locale.ROOT);
        if (List.of("x-slow", "slow", "medium", "fast", "x-fast").contains(v)) return;
        double rate = parseFiniteUnit(v, "%", 1.0, "rate");
        if (rate < 50.0 || rate > 200.0) throw new IllegalArgumentException("SSML rate must be 50%..200%");
    }

    private static void validatePitch(String value) {
        if (value.isBlank()) return;
        String v = value.trim().toLowerCase(Locale.ROOT);
        double semitones;
        if (v.endsWith("st")) semitones = parseFiniteUnit(v, "st", 1.0, "pitch");
        else if (v.endsWith("%")) semitones = parseFiniteUnit(v, "%", 1.0, "pitch");
        else throw new IllegalArgumentException("SSML pitch requires % or st units");
        if (semitones < -12.0 || semitones > 12.0) throw new IllegalArgumentException("SSML pitch must be in [-12, 12]");
    }

    private static void validateVolume(String value) {
        if (value.isBlank()) return;
        String v = value.trim().toLowerCase(Locale.ROOT);
        if (List.of("silent", "x-soft", "soft", "medium", "loud", "x-loud", "default").contains(v)) return;
        if (v.endsWith("db")) {
            double db = parseFiniteUnit(v, "db", 1.0, "volume");
            if (db < -20.0 || db > 6.0) throw new IllegalArgumentException("SSML volume must be in [-20dB, 6dB]");
            return;
        }
        if (v.endsWith("%")) {
            double percent = parseFiniteUnit(v, "%", 1.0, "volume");
            if (percent < 0.0 || percent > 200.0) throw new IllegalArgumentException("SSML volume must be in [0%, 200%]");
            return;
        }
        throw new IllegalArgumentException("SSML volume requires a canonical level, % or dB units");
    }

    private static double parseFiniteUnit(String value, String suffix, double scale, String field) {
        try {
            String number = value.substring(0, value.length() - suffix.length()).trim();
            double parsed = Double.parseDouble(number);
            if (!Double.isFinite(parsed)) throw new NumberFormatException("not finite");
            return parsed * scale;
        } catch (NumberFormatException exception) {
            throw new IllegalArgumentException("Invalid SSML " + field + " value", exception);
        }
    }

    public sealed interface SsmlSegment permits SsmlSegment.TextSegment, SsmlSegment.PauseSegment,
            SsmlSegment.ProsodySegment, SsmlSegment.EmphasisSegment, SsmlSegment.PhonemeSegment,
            SsmlSegment.SubstitutionSegment, SsmlSegment.LanguageSegment, SsmlSegment.VoiceSegment {
        String text();
        SegmentType type();
        enum SegmentType { TEXT, PAUSE, PROSODY, EMPHASIS, PHONEME, SUBSTITUTION, LANGUAGE, VOICE }
        static SsmlSegment text(String content) { return new TextSegment(content); }
        static SsmlSegment pause(long durationMs) { return new PauseSegment(durationMs); }
        static SsmlSegment prosody(String content, String attributes) { return new ProsodySegment(content, attributes); }
        static SsmlSegment emphasis(String content, String level) { return new EmphasisSegment(content, level); }
        static SsmlSegment phoneme(String content, String alphabet, String phoneme) { return new PhonemeSegment(content, alphabet, phoneme); }
        static SsmlSegment substitution(String content, String alias) { return new SubstitutionSegment(content, alias); }
        static SsmlSegment language(String content, String languageTag) { return new LanguageSegment(content, languageTag); }
        static SsmlSegment voice(String content, String voiceName) { return new VoiceSegment(content, voiceName); }
        record TextSegment(String text) implements SsmlSegment { public SegmentType type() { return SegmentType.TEXT; } }
        record PauseSegment(long durationMs) implements SsmlSegment { public String text() { return ""; } public SegmentType type() { return SegmentType.PAUSE; } }
        record ProsodySegment(String text, String attributes) implements SsmlSegment { public SegmentType type() { return SegmentType.PROSODY; } }
        record EmphasisSegment(String text, String emphasisLevel) implements SsmlSegment { public SegmentType type() { return SegmentType.EMPHASIS; } }
        record PhonemeSegment(String text, String alphabet, String phoneme) implements SsmlSegment { public SegmentType type() { return SegmentType.PHONEME; } }
        record SubstitutionSegment(String text, String alias) implements SsmlSegment { public SegmentType type() { return SegmentType.SUBSTITUTION; } }
        record LanguageSegment(String text, String languageTag) implements SsmlSegment { public SegmentType type() { return SegmentType.LANGUAGE; } }
        /** Voice selector preserved as untrusted input; it is not an authorization grant. */
        record VoiceSegment(String text, String voiceName) implements SsmlSegment { public SegmentType type() { return SegmentType.VOICE; } }
    }
}
