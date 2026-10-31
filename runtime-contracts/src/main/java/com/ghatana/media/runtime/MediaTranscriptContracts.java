package com.ghatana.media.runtime;

import java.util.List;
import java.util.Map;
import java.util.Objects;

/** Immutable, tenant scoped transcript revision persistence contract. */
public final class MediaTranscriptContracts {
    private MediaTranscriptContracts() { }

    /** Legacy constructor value; stores must reject it because no purpose was bound. */
    public static final String UNBOUND_PURPOSE_REF = "__UNBOUND_PURPOSE_REF__";
    /** Legacy constructor value; stores must reject it because no effective purpose was resolved. */
    public static final String UNRESOLVED_PROCESSING_PURPOSE = "__UNRESOLVED_PROCESSING_PURPOSE__";

    /** Per-segment timing tags; every tag is explicit — nothing is inferred or flattened. */
    public enum SegmentTimingTag { NOT_SUPPLIED, PROVIDER_TIME_UNQUALIFIED, SOURCE_TICKS }

    /**
     * Transcript-level aggregate over the exact per-segment timing tags. It is a summary
     * only — never registration eligibility — and a {@link #MIXED} aggregate must never
     * be promoted to {@link #SOURCE_CLOCK_BOUND}.
     */
    public enum TimingAvailability { NOT_SUPPLIED, PROVIDER_TIME_UNQUALIFIED, SOURCE_CLOCK_BOUND, MIXED }

    /**
     * Tagged per-segment timing union. {@link SegmentTimingTag#SOURCE_TICKS} carries
     * explicit start/end ticks plus the exact qualified
     * {@code sourceClockId}/{@code sourceTicksPerSecond}/{@code sourceDurationTicks}
     * tuple; {@link SegmentTimingTag#PROVIDER_TIME_UNQUALIFIED} preserves the original
     * provider values and declared unit verbatim and is never relabelled as source
     * ticks; {@link SegmentTimingTag#NOT_SUPPLIED} is explicit absence and carries no
     * timing fields.
     */
    public record TranscriptSegmentTiming(
            SegmentTimingTag tag, long start, long end, String declaredUnit,
            String sourceClockId, long sourceTicksPerSecond, long sourceDurationTicks) {
        public TranscriptSegmentTiming {
            java.util.Objects.requireNonNull(tag, "tag");
            declaredUnit = declaredUnit == null ? "" : declaredUnit.trim();
            sourceClockId = sourceClockId == null ? "" : sourceClockId.trim();
            switch (tag) {
                case NOT_SUPPLIED -> {
                    if (start != -1 || end != -1 || !declaredUnit.isEmpty()
                            || !sourceClockId.isEmpty() || sourceTicksPerSecond != 0
                            || sourceDurationTicks != -1) {
                        throw new IllegalArgumentException(
                                "NOT_SUPPLIED segment timing carries no timing fields");
                    }
                }
                case PROVIDER_TIME_UNQUALIFIED -> {
                    if (start < 0 || end < start || declaredUnit.isBlank()
                            || declaredUnit.length() > 64
                            || declaredUnit.chars().anyMatch(Character::isISOControl)) {
                        throw new IllegalArgumentException(
                                "unqualified provider segment timing is malformed");
                    }
                    if (!sourceClockId.isEmpty() || sourceTicksPerSecond != 0
                            || sourceDurationTicks != -1) {
                        throw new IllegalArgumentException(
                                "unqualified provider segment timing carries no source clock");
                    }
                }
                case SOURCE_TICKS -> {
                    if (start < 0 || end <= start || sourceClockId.isBlank()
                            || sourceClockId.length() > 512
                            || sourceClockId.chars().anyMatch(Character::isISOControl)
                            || sourceTicksPerSecond < 1 || sourceDurationTicks < 0) {
                        throw new IllegalArgumentException("source-tick segment timing is malformed");
                    }
                    if (sourceDurationTicks > 0 && end > sourceDurationTicks) {
                        throw new IllegalArgumentException(
                                "source-tick segment ends beyond the declared source duration");
                    }
                    if (!declaredUnit.isEmpty()) {
                        throw new IllegalArgumentException(
                                "source-tick segment timing carries no provider unit");
                    }
                }
            }
        }

        public static TranscriptSegmentTiming notSupplied() {
            return new TranscriptSegmentTiming(SegmentTimingTag.NOT_SUPPLIED, -1, -1, "", "", 0, -1);
        }

        public static TranscriptSegmentTiming providerTimeUnqualified(
                long start, long end, String declaredUnit) {
            return new TranscriptSegmentTiming(
                    SegmentTimingTag.PROVIDER_TIME_UNQUALIFIED, start, end,
                    declaredUnit, "", 0, -1);
        }

        public static TranscriptSegmentTiming sourceTicks(
                long startTick, long endTick, String sourceClockId,
                long sourceTicksPerSecond, long sourceDurationTicks) {
            return new TranscriptSegmentTiming(
                    SegmentTimingTag.SOURCE_TICKS, startTick, endTick, "",
                    sourceClockId, sourceTicksPerSecond, sourceDurationTicks);
        }

        public Map<String, Object> toParametersValue() {
            Map<String, Object> value = new java.util.LinkedHashMap<>();
            value.put("tag", tag.name());
            switch (tag) {
                case PROVIDER_TIME_UNQUALIFIED -> {
                    value.put("start", start);
                    value.put("end", end);
                    value.put("declaredUnit", declaredUnit);
                }
                case SOURCE_TICKS -> {
                    value.put("startTick", start);
                    value.put("endTick", end);
                    value.put("sourceClockId", sourceClockId);
                    value.put("sourceTicksPerSecond", sourceTicksPerSecond);
                    value.put("sourceDurationTicks", sourceDurationTicks);
                }
                default -> { }
            }
            return java.util.Collections.unmodifiableMap(value);
        }
    }

    /** One ordered transcript segment: stable identity, exact text, explicit origin, explicit timing tag. */
    public record TranscriptSegment(
            String segmentId, String text, String origin, TranscriptSegmentTiming timing) {
        public TranscriptSegment {
            segmentId = required(segmentId, "segmentId");
            if (segmentId.length() > 512 || segmentId.chars().anyMatch(Character::isISOControl)) {
                throw new IllegalArgumentException("segmentId is malformed");
            }
            text = java.util.Objects.requireNonNull(text, "text");
            origin = required(origin, "origin");
            if (origin.length() > 64 || origin.chars().anyMatch(Character::isISOControl)) {
                throw new IllegalArgumentException("segment origin is malformed");
            }
            timing = java.util.Objects.requireNonNull(timing, "timing");
        }

        public Map<String, Object> toParametersValue() {
            Map<String, Object> value = new java.util.LinkedHashMap<>();
            value.put("segmentId", segmentId);
            value.put("text", text);
            value.put("origin", origin);
            value.put("timing", timing.toParametersValue());
            return java.util.Collections.unmodifiableMap(value);
        }
    }

    /**
     * Aggregates the exact per-segment timing tags: every {@code NOT_SUPPLIED} tag
     * yields {@code NOT_SUPPLIED}; every {@code PROVIDER_TIME_UNQUALIFIED} tag yields
     * {@code PROVIDER_TIME_UNQUALIFIED}; {@code SOURCE_CLOCK_BOUND} requires every
     * segment tagged {@code SOURCE_TICKS} sharing one qualified source-clock tuple;
     * differing tags or inconsistent tuples are {@code MIXED}. An empty segment list is
     * explicit absence, never an inferred claim.
     */
    public static TimingAvailability aggregateTimingAvailability(java.util.List<TranscriptSegment> segments) {
        if (segments == null || segments.isEmpty()) return TimingAvailability.NOT_SUPPLIED;
        boolean allNotSupplied = true, allUnqualified = true, allTicks = true, consistent = true;
        String clockId = null;
        long ticksPerSecond = -1, durationTicks = -1;
        for (TranscriptSegment segment : segments) {
            TranscriptSegmentTiming timing = segment.timing();
            switch (timing.tag()) {
                case NOT_SUPPLIED -> { allUnqualified = false; allTicks = false; }
                case PROVIDER_TIME_UNQUALIFIED -> { allNotSupplied = false; allTicks = false; }
                case SOURCE_TICKS -> {
                    allNotSupplied = false;
                    allUnqualified = false;
                    if (clockId == null) {
                        clockId = timing.sourceClockId();
                        ticksPerSecond = timing.sourceTicksPerSecond();
                        durationTicks = timing.sourceDurationTicks();
                    } else if (!clockId.equals(timing.sourceClockId())
                            || ticksPerSecond != timing.sourceTicksPerSecond()
                            || durationTicks != timing.sourceDurationTicks()) {
                        consistent = false;
                    }
                }
            }
        }
        if (allNotSupplied) return TimingAvailability.NOT_SUPPLIED;
        if (allUnqualified) return TimingAvailability.PROVIDER_TIME_UNQUALIFIED;
        if (allTicks && consistent) return TimingAvailability.SOURCE_CLOCK_BOUND;
        return TimingAvailability.MIXED;
    }

    /** JSON-safe projection of the ordered segment array for durable persistence. */
    public static java.util.List<Map<String, Object>> segmentsToParametersValue(
            java.util.List<TranscriptSegment> segments) {
        if (segments == null || segments.isEmpty()) return java.util.List.of();
        java.util.List<Map<String, Object>> value = new java.util.ArrayList<>(segments.size());
        for (TranscriptSegment segment : segments) value.add(segment.toParametersValue());
        return java.util.List.copyOf(value);
    }

    /**
     * Strictly parses the ordered segment array a provider declared. Absent input is
     * explicit {@code NOT_SUPPLIED}; any malformed segment, timing tag or field fails
     * closed rather than silently dropping a supplied disposition.
     */
    public static java.util.List<TranscriptSegment> segmentsFromParameterValue(Object value) {
        if (value == null) return java.util.List.of();
        if (!(value instanceof java.util.List<?> list) || list.size() > 4096) {
            throw new IllegalArgumentException("transcript segments must be a bounded ordered array");
        }
        java.util.List<TranscriptSegment> segments = new java.util.ArrayList<>(list.size());
        for (Object item : list) {
            if (!(item instanceof Map<?, ?> map)
                    || !(map.get("segmentId") instanceof String segmentId)
                    || !(map.get("text") instanceof String text)
                    || !(map.get("origin") instanceof String origin)
                    || !(map.get("timing") instanceof Map<?, ?> timingMap)
                    || !(timingMap.get("tag") instanceof String tag)) {
                throw new IllegalArgumentException("transcript segment is malformed");
            }
            TranscriptSegmentTiming timing = switch (tag) {
                case "NOT_SUPPLIED" -> TranscriptSegmentTiming.notSupplied();
                case "PROVIDER_TIME_UNQUALIFIED" -> TranscriptSegmentTiming.providerTimeUnqualified(
                        integral(timingMap.get("start"), "start"),
                        integral(timingMap.get("end"), "end"),
                        timingMap.get("declaredUnit") instanceof String unit ? unit : "");
                case "SOURCE_TICKS" -> TranscriptSegmentTiming.sourceTicks(
                        integral(timingMap.get("startTick"), "startTick"),
                        integral(timingMap.get("endTick"), "endTick"),
                        timingMap.get("sourceClockId") instanceof String clockId ? clockId : "",
                        integral(timingMap.get("sourceTicksPerSecond"), "sourceTicksPerSecond"),
                        integral(timingMap.get("sourceDurationTicks"), "sourceDurationTicks"));
                default -> throw new IllegalArgumentException("unknown transcript segment timing tag");
            };
            segments.add(new TranscriptSegment(segmentId, text, origin, timing));
        }
        return java.util.List.copyOf(segments);
    }

    private static long integral(Object value, String name) {
        if (!(value instanceof Number number)
                || (value instanceof Double d && (d.isNaN() || d.isInfinite()))
                || (value instanceof Float f && (f.isNaN() || f.isInfinite()))) {
            throw new IllegalArgumentException("transcript segment " + name + " must be integral");
        }
        return number.longValue();
    }

    /** Draft contains provider supplied transcript data; this contract never creates STT output. */
    public record TranscriptDraft(
            String tenantId, String principalId, String transcriptId,
            String sourceArtifactId, String sourceVersion, String sourceSha256,
            String jobId, String profileId, String providerId, String modelId,
            String language, String timebase, String text,
            String consentDecisionId, String rightsDecisionId, String policyVersion,
            String purposeRef, String processingPurpose,
            java.util.List<TranscriptSegment> segments) {
        /** Source-compatible bound constructor; no supplied segments means explicit absence. */
        public TranscriptDraft(String tenantId, String principalId, String transcriptId,
                String sourceArtifactId, String sourceVersion, String sourceSha256,
                String jobId, String profileId, String providerId, String modelId,
                String language, String timebase, String text,
                String consentDecisionId, String rightsDecisionId, String policyVersion,
                String purposeRef, String processingPurpose) {
            this(tenantId, principalId, transcriptId, sourceArtifactId, sourceVersion, sourceSha256,
                    jobId, profileId, providerId, modelId, language, timebase, text,
                    consentDecisionId, rightsDecisionId, policyVersion,
                    purposeRef, processingPurpose, java.util.List.of());
        }

        /**
         * Source-compatible constructor for existing callers. The resulting draft is deliberately
         * unbound and persistence implementations must reject it until callers provide a purpose.
         */
        public TranscriptDraft(String tenantId, String principalId, String transcriptId,
                String sourceArtifactId, String sourceVersion, String sourceSha256,
                String jobId, String profileId, String providerId, String modelId,
                String language, String timebase, String text,
                String consentDecisionId, String rightsDecisionId, String policyVersion) {
            this(tenantId, principalId, transcriptId, sourceArtifactId, sourceVersion, sourceSha256,
                    jobId, profileId, providerId, modelId, language, timebase, text,
                    consentDecisionId, rightsDecisionId, policyVersion,
                    UNBOUND_PURPOSE_REF, UNRESOLVED_PROCESSING_PURPOSE);
        }

        /** Aggregate over the exact per-segment timing tags; a summary, never registration eligibility. */
        public TimingAvailability timingAvailability() {
            return aggregateTimingAvailability(segments);
        }

        public TranscriptDraft {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            transcriptId = required(transcriptId, "transcriptId");
            sourceArtifactId = required(sourceArtifactId, "sourceArtifactId");
            sourceVersion = required(sourceVersion, "sourceVersion");
            sourceSha256 = required(sourceSha256, "sourceSha256").toLowerCase(java.util.Locale.ROOT);
            if (!sourceSha256.matches("[0-9a-f]{64}") || !sourceVersion.equals("sha256:" + sourceSha256)) {
                throw new IllegalArgumentException("source version and SHA-256 must identify the same bytes");
            }
            jobId = required(jobId, "jobId");
            profileId = required(profileId, "profileId");
            providerId = required(providerId, "providerId");
            modelId = required(modelId, "modelId");
            language = required(language, "language");
            timebase = required(timebase, "timebase");
            text = Objects.requireNonNull(text, "text");
            consentDecisionId = required(consentDecisionId, "consentDecisionId");
            rightsDecisionId = required(rightsDecisionId, "rightsDecisionId");
            policyVersion = required(policyVersion, "policyVersion");
            purposeRef = required(purposeRef, "purposeRef");
            processingPurpose = required(processingPurpose, "processingPurpose");
            if (purposeRef.codePointCount(0, purposeRef.length()) > 256) {
                throw new IllegalArgumentException("purposeRef exceeds 256 characters");
            }
            if (processingPurpose.codePointCount(0, processingPurpose.length()) > 255) {
                throw new IllegalArgumentException("processingPurpose exceeds 255 characters");
            }
            segments = java.util.List.copyOf(
                    java.util.Objects.requireNonNull(segments, "segments"));
            if (segments.size() > 4096) {
                throw new IllegalArgumentException("transcript segments exceed the bounded array limit");
            }
            java.util.Set<String> seen = new java.util.HashSet<>();
            for (TranscriptSegment segment : segments) {
                if (segment == null || !seen.add(segment.segmentId())) {
                    throw new IllegalArgumentException(
                            "transcript segments require stable nonempty unique segmentIds");
                }
            }
        }
    }

    /** Returned revisions are immutable; every correction is a subsequent number. */
    public record TranscriptRevision(TranscriptDraft draft, int revision, long createdAt, String admissionStatus) {
        public TranscriptRevision {
            draft = Objects.requireNonNull(draft, "draft");
            if (revision < 1) throw new IllegalArgumentException("revision must be positive");
            admissionStatus = required(admissionStatus, "admissionStatus");
        }
    }

    /** Durable lineage for one candidate transcript revision; contains identifiers and digests only. */
    public record TranscriptAttemptBinding(
            String jobId, int attemptNumber, long fencingToken, String providerId,
            String providerOperationId, String providerReceiptId, String requestFingerprint,
            String sourceArtifactVersionRef, String transcriptVersionRef, String resultDigest) {
        public TranscriptAttemptBinding {
            jobId = required(jobId, "jobId");
            if (attemptNumber <= 0 || fencingToken <= 0) {
                throw new IllegalArgumentException("attempt number and fencing token must be positive");
            }
            providerId = required(providerId, "providerId");
            providerOperationId = required(providerOperationId, "providerOperationId");
            providerReceiptId = required(providerReceiptId, "providerReceiptId");
            requestFingerprint = digest(requestFingerprint, "requestFingerprint");
            sourceArtifactVersionRef = required(sourceArtifactVersionRef, "sourceArtifactVersionRef");
            transcriptVersionRef = required(transcriptVersionRef, "transcriptVersionRef");
            resultDigest = digest(resultDigest, "resultDigest");
        }

        private static String digest(String value, String name) {
            String normalized = required(value, name).toLowerCase(java.util.Locale.ROOT);
            if (!normalized.matches("[0-9a-f]{64}")) throw new IllegalArgumentException(name + " must be SHA-256");
            return normalized;
        }
    }

    /** Derived operations that must remain fail-closed until their owning evidence exists. */
    public enum TranscriptDerivedCapability {
        FORCED_ALIGNMENT,
        TRANSLATION,
        CAPTION_VERSION_REGISTRATION
    }

    public enum TranscriptCapabilityBlocker {
        QUALIFIED_ENGINE_UNAVAILABLE,
        CANONICAL_TRANSCRIPT_VERSION_UNAVAILABLE,
        AUTHORITATIVE_SOURCE_CLOCK_UNAVAILABLE,
        DERIVED_CONTENT_AUTHORITY_UNAVAILABLE
    }

    public enum TranscriptCapabilityDisposition {
        UNMET_CAPABILITY
    }

    /** Typed no-effect result; it never represents a transcript or caption version. */
    public record TranscriptCapabilityResult(
            TranscriptDerivedCapability capability,
            TranscriptCapabilityDisposition disposition,
            List<TranscriptCapabilityBlocker> blockers,
            boolean effectOccurred) {
        public TranscriptCapabilityResult {
            capability = Objects.requireNonNull(capability, "capability");
            disposition = Objects.requireNonNull(disposition, "disposition");
            blockers = List.copyOf(Objects.requireNonNull(blockers, "blockers"));
            if (blockers.isEmpty() || effectOccurred) {
                throw new IllegalArgumentException("Unavailable transcript capabilities must report typed no-effect");
            }
        }
    }

    /** A transcript revision changed after the writer's expected latest revision was observed. */
    public static final class TranscriptRevisionConflictException extends IllegalStateException {
        private static final long serialVersionUID = 1L;
        private final int expectedLatestRevision;
        private final int actualLatestRevision;

        public TranscriptRevisionConflictException(int expectedLatestRevision, int actualLatestRevision) {
            super("Transcript revision conflict: expected latest " + expectedLatestRevision
                    + " but found " + actualLatestRevision);
            if (expectedLatestRevision < 0 || actualLatestRevision < 0) {
                throw new IllegalArgumentException("transcript revisions cannot be negative");
            }
            this.expectedLatestRevision = expectedLatestRevision;
            this.actualLatestRevision = actualLatestRevision;
        }

        public int expectedLatestRevision() { return expectedLatestRevision; }
        public int actualLatestRevision() { return actualLatestRevision; }
    }

    /** A transcript identifier is already owned by another principal in the tenant. */
    public static final class TranscriptPrincipalConflictException extends SecurityException {
        private static final long serialVersionUID = 1L;

        public TranscriptPrincipalConflictException() {
            super("Transcript identifier is already bound to another principal");
        }
    }

    public interface MediaTranscriptStore extends AutoCloseable {
        /**
         * Append using the legacy contract. Implementations should permit creation and exact
         * idempotent retry only; a changed existing transcript requires the expected-revision API.
         */
        TranscriptRevision append(TranscriptDraft draft);

        /**
         * Append against the caller's observed latest revision (zero means no revision exists).
         * Repeating the exact latest draft is idempotent; a changed draft requires an exact CAS pin.
         */
        default TranscriptRevision append(TranscriptDraft draft, int expectedLatestRevision) {
            throw new UnsupportedOperationException("Expected-revision append is not supported by this store");
        }

        /**
         * Append only when the draft is an exact projection of the named successful durable attempt.
         * Compatibility implementations fail closed until they can validate and persist that binding.
         */
        default TranscriptRevision appendFromSuccessfulAttempt(TranscriptDraft draft, int expectedLatestRevision,
                int attemptNumber, long fencingToken, String requestFingerprint, String transcriptVersionRef) {
            throw new UnsupportedOperationException("Successful-attempt transcript append is not supported by this store");
        }

        /** Existing implementations retain their original tenant/transcript read contract. */
        List<TranscriptRevision> revisions(String tenantId, String transcriptId);

        /**
         * Principal-scoped readback is required for safe transcript access. The compatibility
         * default fails closed until an implementation can enforce the extra owner key.
         */
        default List<TranscriptRevision> revisions(String tenantId, String principalId, String transcriptId) {
            throw new UnsupportedOperationException("Principal-scoped transcript readback is not supported by this store");
        }

        /**
         * Exact immutable transcript-version readback scoped to tenant and principal: resolves the
         * single persisted revision durably bound to {@code transcriptVersionRef} through its
         * recorded provider-attempt lineage. This is the canonical transcript-version identity
         * used as a caption-registration parent — never the transcript aggregate id and never an
         * implicitly selected latest revision. The compatibility default fails closed; stores
         * that cannot prove exact version ownership must return empty, including when the
         * reference resolves to more than one persisted revision.
         */
        default java.util.Optional<TranscriptRevision> revisionByVersionRef(
                String tenantId, String principalId, String transcriptVersionRef) {
            return java.util.Optional.empty();
        }

        /**
         * Read exact persisted provider-attempt lineage for a principal-owned transcript revision.
         * Implementations must fail closed for another principal, tenant, or unknown revision.
         */
        default TranscriptAttemptBinding readAttemptBinding(
                String tenantId, String principalId, String transcriptId, int revision) {
            throw new UnsupportedOperationException("Scoped transcript attempt-binding readback is not supported by this store");
        }

        /**
         * Reports the current derived-operation boundary. Implementations must not create output
         * versions from these unavailable capabilities. Plain-text transcript CAS remains separate.
         */
        default TranscriptCapabilityResult capability(TranscriptDerivedCapability capability) {
            return unavailableCapability(capability);
        }

        /** True only when the durable transcript schema and storage connection are currently usable. */
        default boolean ready() { return false; }

        boolean productionEligible();
        @Override void close();
    }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " is required");
        return value.trim();
    }

    public static TranscriptCapabilityResult unavailableCapability(TranscriptDerivedCapability capability) {
        Objects.requireNonNull(capability, "capability");
        List<TranscriptCapabilityBlocker> blockers = switch (capability) {
            case FORCED_ALIGNMENT -> List.of(TranscriptCapabilityBlocker.QUALIFIED_ENGINE_UNAVAILABLE,
                    TranscriptCapabilityBlocker.AUTHORITATIVE_SOURCE_CLOCK_UNAVAILABLE);
            case TRANSLATION -> List.of(TranscriptCapabilityBlocker.QUALIFIED_ENGINE_UNAVAILABLE);
            case CAPTION_VERSION_REGISTRATION -> List.of(
                    TranscriptCapabilityBlocker.CANONICAL_TRANSCRIPT_VERSION_UNAVAILABLE,
                    TranscriptCapabilityBlocker.AUTHORITATIVE_SOURCE_CLOCK_UNAVAILABLE,
                    TranscriptCapabilityBlocker.DERIVED_CONTENT_AUTHORITY_UNAVAILABLE);
        };
        return new TranscriptCapabilityResult(capability, TranscriptCapabilityDisposition.UNMET_CAPABILITY,
                blockers, false);
    }
}
