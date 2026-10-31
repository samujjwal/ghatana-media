package com.ghatana.media.runtime;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.regex.Pattern;

/**
 * Immutable caption-version registration contract for J-03, implementing
 * media.operation.caption-version-write: append-only versions, exact typed
 * parent and source-clock binding, and a deterministic request fingerprint.
 * Registration never approves content, mutates the parent, or establishes
 * delivery or publication.
 */
public final class MediaCaptionContracts {
    private MediaCaptionContracts() { }

    public enum ParentVersionKind { TRANSCRIPT_VERSION, CAPTION_VERSION }
    public enum SegmentOrigin { RECOGNIZED, USER_EDITED }
    public enum LanguageDisposition { NOT_SELECTED, DECLARED_BY_USER, UNCERTAIN }

    public enum RegistrationError {
        INVALID_REQUEST, ACCESS_DENIED, VERSION_REGISTRATION_NOT_ALLOWED, SOURCE_NOT_READY,
        CAPTION_DRAFT_EMPTY, CAPTION_ALIGNMENT_REQUIRED, CAPTION_VERSION_CONFLICT,
        IDEMPOTENCY_CONFLICT, UNAVAILABLE, UNKNOWN_OUTCOME
    }

    public static final class CaptionRegistrationException extends RuntimeException {
        private final RegistrationError error;

        public CaptionRegistrationException(RegistrationError error, String detail) {
            super(error + ": " + detail);
            this.error = error;
        }

        public RegistrationError error() {
            return error;
        }
    }

    private static final Pattern REQUEST_ID = Pattern.compile("[A-Za-z0-9._~\\-]{1,128}");
    private static final Pattern IDENTIFIER = Pattern.compile("[A-Za-z0-9][A-Za-z0-9_.:\\-]{0,255}");
    private static final int PURPOSE_MAX_CODE_POINTS = 240;
    private static final int MAX_SEGMENTS = 4096;

    /** One immutable caption segment; registration requires explicit source ticks. */
    public record CaptionSegment(String segmentId, String text, long startTick, long endTick,
                                 SegmentOrigin origin, Optional<String> speakerLabel) {
        public CaptionSegment {
            segmentId = required(segmentId, "segmentId");
            if (!IDENTIFIER.matcher(segmentId).matches()) {
                throw new CaptionRegistrationException(RegistrationError.INVALID_REQUEST, "segmentId");
            }
            text = Objects.requireNonNull(text, "text");
            if (text.codePointCount(0, text.length()) > 100_000) {
                throw new CaptionRegistrationException(RegistrationError.INVALID_REQUEST, "segment text bound");
            }
            origin = Objects.requireNonNull(origin, "origin");
            speakerLabel = speakerLabel == null ? Optional.empty() : speakerLabel;
            speakerLabel.ifPresent(label -> {
                if (label.codePointCount(0, label.length()) > 256) {
                    throw new CaptionRegistrationException(RegistrationError.INVALID_REQUEST, "speakerLabel bound");
                }
            });
            if (!safeInteger(startTick) || !safeInteger(endTick)) {
                throw new CaptionRegistrationException(RegistrationError.CAPTION_ALIGNMENT_REQUIRED,
                        "segment ticks must be nonnegative safe integers");
            }
        }

        public static CaptionSegment of(String segmentId, String text, long startTick, long endTick,
                                        SegmentOrigin origin) {
            return new CaptionSegment(segmentId, text, startTick, endTick, origin, Optional.empty());
        }
    }

    /** Validated registration request; parent and source-clock identity is exact. */
    public record RegistrationRequest(String requestId, String sourceArtifactId, String sourceArtifactVersionId,
                                      ParentVersionKind parentVersionKind, String parentVersionId,
                                      String sourceClockId, long ticksPerSecond, long sourceDurationTicks,
                                      LanguageDisposition languageDisposition, Optional<String> languageTag,
                                      List<CaptionSegment> captionSegments, Optional<String> purpose) {
        public RegistrationRequest {
            if (requestId == null || !REQUEST_ID.matcher(requestId).matches()) {
                throw new CaptionRegistrationException(RegistrationError.INVALID_REQUEST, "requestId");
            }
            for (String[] pair : new String[][] {
                    {"sourceArtifactId", sourceArtifactId}, {"sourceArtifactVersionId", sourceArtifactVersionId},
                    {"parentVersionId", parentVersionId}, {"sourceClockId", sourceClockId}}) {
                if (pair[1] == null || !IDENTIFIER.matcher(pair[1]).matches()) {
                    throw new CaptionRegistrationException(RegistrationError.INVALID_REQUEST, pair[0]);
                }
            }
            parentVersionKind = Objects.requireNonNull(parentVersionKind, "parentVersionKind");
            if (!safeInteger(ticksPerSecond) || ticksPerSecond < 1) {
                throw new CaptionRegistrationException(RegistrationError.INVALID_REQUEST, "ticksPerSecond");
            }
            if (!safeInteger(sourceDurationTicks)) {
                throw new CaptionRegistrationException(RegistrationError.INVALID_REQUEST, "sourceDurationTicks");
            }
            languageDisposition = Objects.requireNonNull(languageDisposition, "languageDisposition");
            languageTag = languageTag == null ? Optional.empty() : languageTag;
            languageTag.ifPresent(tag -> {
                if (tag.isBlank() || tag.codePointCount(0, tag.length()) > 64) {
                    throw new CaptionRegistrationException(RegistrationError.INVALID_REQUEST, "languageTag");
                }
            });
            captionSegments = List.copyOf(Objects.requireNonNull(captionSegments, "captionSegments"));
            if (captionSegments.isEmpty()) {
                throw new CaptionRegistrationException(RegistrationError.CAPTION_DRAFT_EMPTY, "no segments");
            }
            if (captionSegments.size() > MAX_SEGMENTS) {
                throw new CaptionRegistrationException(RegistrationError.INVALID_REQUEST, "segment bound");
            }
            java.util.Set<String> seen = new java.util.HashSet<>();
            for (CaptionSegment segment : captionSegments) {
                if (segment == null || !seen.add(segment.segmentId())) {
                    throw new CaptionRegistrationException(RegistrationError.INVALID_REQUEST, "duplicate segmentId");
                }
                if (segment.startTick() >= segment.endTick() || segment.endTick() > sourceDurationTicks) {
                    throw new CaptionRegistrationException(RegistrationError.CAPTION_ALIGNMENT_REQUIRED,
                            "segment tick range exceeds source clock");
                }
            }
            purpose = purpose == null ? Optional.empty() : purpose;
            purpose = purpose.map(String::trim);
            purpose.ifPresent(value -> {
                if (value.isEmpty() || value.codePointCount(0, value.length()) > PURPOSE_MAX_CODE_POINTS) {
                    throw new CaptionRegistrationException(RegistrationError.INVALID_REQUEST,
                            "purpose must be 1-240 Unicode scalars after trimming");
                }
            });
        }
    }

    public sealed interface RegistrationResult permits Registered, Rejected {
        String requestId();
    }

    /** Authoritative durable registration receipt; echoes the exact requestId. */
    public record Registered(String requestId, String requestFingerprint, String captionVersionId,
                             String registrationReceiptId, String sourceArtifactId, String sourceArtifactVersionId,
                             ParentVersionKind parentVersionKind, String parentVersionId,
                             LanguageDisposition languageDisposition, String sourceClockId, long registeredAt)
            implements RegistrationResult {
    }

    /** Definitive typed rejection before commit; echoes the exact requestId. */
    public record Rejected(String requestId, String requestFingerprint, RegistrationError error, boolean retryable)
            implements RegistrationResult {
    }

    /**
     * Complete durable readback of one registered caption version: the {@link Registered}
     * receipt fields plus the immutable clock tuple, language tag, purpose and segment
     * payload. It supports the {@code EXACT_PAIR} selector of
     * {@code media.operation.caption-version-read}; it never approves content or proves
     * delivery.
     */
    public record CaptionVersionSnapshot(String requestId, String requestFingerprint,
                                         String captionVersionId, String registrationReceiptId,
                                         String sourceArtifactId, String sourceArtifactVersionId,
                                         ParentVersionKind parentVersionKind, String parentVersionId,
                                         String sourceClockId, long ticksPerSecond, long sourceDurationTicks,
                                         LanguageDisposition languageDisposition, Optional<String> languageTag,
                                         List<CaptionSegment> captionSegments, Optional<String> purpose,
                                         long registeredAt) {
        public CaptionVersionSnapshot {
            Objects.requireNonNull(parentVersionKind, "parentVersionKind");
            Objects.requireNonNull(languageDisposition, "languageDisposition");
            languageTag = languageTag == null ? Optional.empty() : languageTag;
            captionSegments = List.copyOf(Objects.requireNonNull(captionSegments, "captionSegments"));
            purpose = purpose == null ? Optional.empty() : purpose;
        }
    }

    /** Trusted authority facts the durable store cannot fabricate. */
    public interface RegistrationAuthority {
        Decision check(AuthorityCheck check);

        enum Decision { ADMITTED, DENIED, UNAVAILABLE }

        /** Current source-scoped derived-version + rights/retention decision inputs. */
        record AuthorityCheck(String tenantId, String principalId, String sourceArtifactId,
                              String sourceArtifactVersionId, ParentVersionKind parentVersionKind,
                              String parentVersionId) { }
    }

    /** Resolves the authoritative clock metadata of the typed parent in the same source scope. */
    @FunctionalInterface
    public interface ParentClockLookup {
        /** @return clock facts or empty when the parent is not current/readable in this source scope. */
        Optional<ParentFacts> resolve(ParentVersionKind kind, String parentVersionId,
                                      String sourceArtifactId, String sourceArtifactVersionId);

        record ParentFacts(String sourceClockId, long ticksPerSecond, long sourceDurationTicks) { }
    }

    public interface MediaCaptionStore extends AutoCloseable {
        /**
         * Register one immutable caption version. Same key (tenant, principal, requestId) and same
         * fingerprint returns the original receipt; same key different fingerprint is
         * {@link RegistrationError#IDEMPOTENCY_CONFLICT}.
         */
        RegistrationResult register(String tenantId, String principalId, RegistrationRequest request,
                                    RegistrationAuthority authority, ParentClockLookup parentLookup);

        /** Principal-scoped readback of every registered version for one source artifact version. */
        List<Registered> versions(String tenantId, String principalId, String sourceArtifactId,
                                String sourceArtifactVersionId);

        /**
         * Principal-scoped readback of one complete registered caption version, including its
         * immutable segment payload. The default fails closed; implementations that cannot scope
         * the read to tenant and principal must not return content.
         */
        default Optional<CaptionVersionSnapshot> version(String tenantId, String principalId,
                                                         String captionVersionId) {
            return Optional.empty();
        }

        /**
         * Resolves the immutable source-clock tuple a registered caption version was bound to, but
         * only when that version belongs to the same source artifact/version scope. This backs the
         * {@link ParentVersionKind#CAPTION_VERSION} branch of {@link ParentClockLookup}; the default
         * fails closed so an unsupporting store can never fabricate parent clock facts.
         */
        default Optional<ParentClockLookup.ParentFacts> parentClock(String tenantId, String principalId,
                String captionVersionId, String sourceArtifactId, String sourceArtifactVersionId) {
            return Optional.empty();
        }

        /** True only when the durable caption schema and storage connection are currently usable. */
        default boolean ready() { return false; }

        /** True when the store may serve production-grade registration; absence fails closed. */
        default boolean productionEligible() { return false; }
    }

    /**
     * media.caption-registration-request.v1 fingerprint: SHA-256 over the UTF-8
     * compact-JSON tuple in the declared field order, no whitespace outside strings.
     */
    public static String fingerprint(String tenantId, String principalId, RegistrationRequest request) {
        StringBuilder json = new StringBuilder(512).append('[');
        field(json, "media.caption-registration-request.v1");
        field(json, required(tenantId, "tenantId"));
        field(json, required(principalId, "principalId"));
        field(json, request.sourceArtifactId());
        field(json, request.sourceArtifactVersionId());
        field(json, request.parentVersionKind().name());
        field(json, request.parentVersionId());
        field(json, request.sourceClockId());
        json.append(request.ticksPerSecond()).append(',');
        json.append(request.sourceDurationTicks()).append(',');
        field(json, request.languageDisposition().name());
        json.append(request.languageTag().isPresent()).append(',');
        request.languageTag().ifPresentOrElse(tag -> appendJsonString(json, tag), () -> json.append("null"));
        json.append(",[");
        List<CaptionSegment> segments = request.captionSegments();
        for (int i = 0; i < segments.size(); i++) {
            if (i > 0) json.append(',');
            CaptionSegment s = segments.get(i);
            json.append('[');
            field(json, s.segmentId());
            field(json, s.text());
            json.append(s.startTick()).append(',');
            json.append(s.endTick()).append(',');
            field(json, s.origin().name());
            json.append(s.speakerLabel().isPresent()).append(',');
            s.speakerLabel().ifPresentOrElse(label -> appendJsonString(json, label), () -> json.append("null"));
            json.append(']');
        }
        json.append(']').append(',');
        json.append(request.purpose().isPresent()).append(',');
        request.purpose().ifPresentOrElse(value -> appendJsonString(json, value), () -> json.append("null"));
        json.append(']');
        return sha256Hex(json.toString());
    }

    /** Ordered segment serialization for durable storage. */
    public static String segmentsJson(List<CaptionSegment> segments) {
        StringBuilder out = new StringBuilder(segments.size() * 48).append('[');
        for (int i = 0; i < segments.size(); i++) {
            if (i > 0) out.append(',');
            CaptionSegment s = segments.get(i);
            out.append('[');
            field(out, s.segmentId());
            field(out, s.text());
            out.append(s.startTick()).append(',');
            out.append(s.endTick()).append(',');
            field(out, s.origin().name());
            s.speakerLabel().ifPresentOrElse(label -> appendJsonString(out, label), () -> out.append("null"));
            out.append(']');
        }
        return out.append(']').toString();
    }

    /** Parse the durable segment array back into the same order. */
    public static List<CaptionSegment> parseSegmentsJson(String json) {
        List<CaptionSegment> out = new ArrayList<>();
        int[] i = {0};
        expect(json, i, '[');
        boolean first = true;
        while (true) {
            skipWs(json, i);
            if (i[0] >= json.length()) throw new IllegalArgumentException("unterminated segments");
            if (json.charAt(i[0]) == ']') { i[0]++; break; }
            if (!first) expect(json, i, ',');
            first = false;
            expect(json, i, '[');
            String id = parseString(json, i);
            expect(json, i, ',');
            String text = parseString(json, i);
            expect(json, i, ',');
            long start = parseNumber(json, i);
            expect(json, i, ',');
            long end = parseNumber(json, i);
            expect(json, i, ',');
            String origin = parseString(json, i);
            expect(json, i, ',');
            skipWs(json, i);
            String speaker = null;
            if (i[0] < json.length() && json.charAt(i[0]) == '"') speaker = parseString(json, i);
            else if (json.startsWith("null", i[0])) i[0] += 4;
            else throw new IllegalArgumentException("bad speakerLabel");
            skipWs(json, i);
            expect(json, i, ']');
            out.add(new CaptionSegment(id, text, start, end, SegmentOrigin.valueOf(origin), Optional.ofNullable(speaker)));
        }
        skipWs(json, i);
        if (i[0] != json.length()) throw new IllegalArgumentException("trailing data");
        return out;
    }

    private static void field(StringBuilder out, String value) {
        appendJsonString(out, value);
        out.append(',');
    }

    /** JSON string per spec: escapes quote and backslash, b/f/n/r/t short escapes, other controls lowercase hex escapes; slash unescaped; unpaired surrogates rejected. */
    private static void appendJsonString(StringBuilder out, String value) {
        out.append('"');
        for (int i = 0; i < value.length(); i++) {
            char c = value.charAt(i);
            if (Character.isSurrogate(c) && !surrogatePair(value, i)) {
                throw new CaptionRegistrationException(RegistrationError.INVALID_REQUEST, "unpaired surrogate");
            }
            switch (c) {
                case '"' -> out.append("\\\"");
                case '\\' -> out.append("\\\\");
                case '\b' -> out.append("\\b");
                case '\f' -> out.append("\\f");
                case '\n' -> out.append("\\n");
                case '\r' -> out.append("\\r");
                case '\t' -> out.append("\\t");
                default -> {
                    if (c < 0x20) out.append(String.format("\\u%04x", (int) c));
                    else out.append(c);
                }
            }
        }
        out.append('"');
    }

    private static boolean surrogatePair(String value, int i) {
        char c = value.charAt(i);
        if (Character.isHighSurrogate(c)) return i + 1 < value.length() && Character.isLowSurrogate(value.charAt(i + 1));
        return i > 0 && Character.isHighSurrogate(value.charAt(i - 1));
    }

    private static void expect(String s, int[] i, char c) {
        skipWs(s, i);
        if (i[0] >= s.length() || s.charAt(i[0]) != c) throw new IllegalArgumentException("expected " + c);
        i[0]++;
    }

    private static void skipWs(String s, int[] i) {
        while (i[0] < s.length() && (s.charAt(i[0]) == ' ' || s.charAt(i[0]) == '\n' || s.charAt(i[0]) == '\t' || s.charAt(i[0]) == '\r')) i[0]++;
    }

    private static String parseString(String s, int[] i) {
        expect(s, i, '"');
        StringBuilder out = new StringBuilder();
        while (true) {
            if (i[0] >= s.length()) throw new IllegalArgumentException("unterminated string");
            char c = s.charAt(i[0]++);
            if (c == '"') return out.toString();
            if (c == '\\') {
                char e = s.charAt(i[0]++);
                switch (e) {
                    case '"' -> out.append('"');
                    case '\\' -> out.append('\\');
                    case '/' -> out.append('/');
                    case 'b' -> out.append('\b');
                    case 'f' -> out.append('\f');
                    case 'n' -> out.append('\n');
                    case 'r' -> out.append('\r');
                    case 't' -> out.append('\t');
                    case 'u' -> {
                        out.append((char) Integer.parseInt(s.substring(i[0], i[0] + 4), 16));
                        i[0] += 4;
                    }
                    default -> throw new IllegalArgumentException("bad escape");
                }
            } else out.append(c);
        }
    }

    private static long parseNumber(String s, int[] i) {
        skipWs(s, i);
        int start = i[0];
        while (i[0] < s.length() && (Character.isDigit(s.charAt(i[0])) || s.charAt(i[0]) == '-')) i[0]++;
        return Long.parseLong(s.substring(start, i[0]));
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " required");
        return value;
    }

    private static boolean safeInteger(long value) {
        return value >= 0 && value <= 9007199254740991L;
    }

    private static String sha256Hex(String input) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(input.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException(impossible);
        }
    }
}
