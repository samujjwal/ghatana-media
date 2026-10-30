package com.ghatana.stt.provider;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import com.ghatana.media.runtime.MediaModalityContracts;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Trusted, bounded snapshot of an independently produced frozen-holdout ASR
 * evaluation report (the output contract of
 * {@code scripts/qualification/evaluate-fleurs-asr.mjs}).
 *
 * <p>The snapshot is a small JSON envelope that binds a measured report to one
 * exact provider identity, model revision/export digest, dataset source
 * revision, measurement scope and measurement time. It is parsed once at
 * composition time and retained immutable; {@link #latest} performs no file or
 * network I/O, so a metrics scrape can never trigger an unbounded read.
 *
 * <p>This is telemetry evidence only. An ACTIVE snapshot produces a
 * source-linked {@link MediaModalityContracts.ProviderQualityObservation}; a
 * missing, revoked, mismatched or stale snapshot produces {@link Optional#empty()},
 * which the runtime exports as {@code NaN}. The record never establishes model
 * qualification, dataset rights or traffic admission.
 */
public final class FrozenHoldoutQualityEvidence implements WhisperOnnxSttProvider.QualityEvidenceReader {

    /** Pinned FLEURS dataset source revision the evaluator was authorized to score. */
    public static final String FLEURS_SOURCE_REVISION =
            "70bb2e84b976b7e960aa89f1c648e09c59f894dd";
    public static final String SCHEMA_VERSION = "media.stt-quality-evidence.v1";
    /** Evidence snapshots are small JSON documents; larger input is rejected before parse. */
    public static final int MAX_EVIDENCE_BYTES = 256 * 1024;

    private static final ObjectMapper MAPPER = new ObjectMapper();
    private static final Set<String> REPORT_LOCALES = Set.of("eng", "hin", "npi");
    private static final String TOKEN = "[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}";
    private static final String SHA256_HEX = "[0-9a-f]{64}";
    private static final String SHA256_REF = "sha256:" + SHA256_HEX;
    private static final double RATE_TOLERANCE = 1e-9;
    /**
     * Owner-registered holdout depth for a qualified-scope claim
     * (R10 {@code qualityHoldoutMinimumPerLocale}); smaller frozen pilots stay
     * {@code REFERENCE_ONLY}.
     */
    static final int MIN_QUALIFIED_HOLDOUT_CLIPS_PER_LOCALE = 100;

    /** Provenance disposition of the measured report; never an admission flag. */
    public enum Scope { REFERENCE_ONLY, INDEPENDENT_QUALIFIED_HOLDOUT }

    /** One per-locale measured result, exactly as produced by the frozen evaluator. */
    public record LocaleMeasurement(String locale, int clipCount, long wordErrors,
            long referenceWords, double wer, long charErrors,
            long referenceCodepoints, double cer,
            Double ci95Lower, Double ci95Upper) {
        public LocaleMeasurement {
            if (!REPORT_LOCALES.contains(locale)) {
                throw new IllegalArgumentException("unsupported report locale");
            }
            if (clipCount < 1 || wordErrors < 0 || referenceWords < 1
                    || charErrors < 0 || referenceCodepoints < 1) {
                throw new IllegalArgumentException("locale counts must be positive");
            }
            if (!Double.isFinite(wer) || wer < 0 || !Double.isFinite(cer) || cer < 0) {
                throw new IllegalArgumentException("locale rates must be finite and nonnegative");
            }
            if (Math.abs(wer - (double) wordErrors / referenceWords) > RATE_TOLERANCE
                    || Math.abs(cer - (double) charErrors / referenceCodepoints) > RATE_TOLERANCE) {
                throw new IllegalArgumentException(
                        "locale rates are inconsistent with measured error counts");
            }
            if ((ci95Lower == null) != (ci95Upper == null)) {
                throw new IllegalArgumentException(
                        "confidence interval bounds must be present together or not at all");
            }
            if (ci95Lower != null && (!Double.isFinite(ci95Lower) || !Double.isFinite(ci95Upper)
                    || ci95Lower < 0 || ci95Upper < ci95Lower)) {
                throw new IllegalArgumentException("confidence interval bounds are invalid");
            }
        }
    }

    private final String providerId;
    private final String providerVersion;
    private final String modelRevision;
    private final String modelExportSha256;
    private final Scope scope;
    private final Instant measuredAt;
    private final String reportSha256;
    private final Map<String, LocaleMeasurement> locales;
    private final double worstWer;
    private final boolean revoked;
    private final Clock clock;
    private final Duration maxEvidenceAge;

    private FrozenHoldoutQualityEvidence(
            String providerId, String providerVersion, String modelRevision,
            String modelExportSha256, Scope scope, Instant measuredAt,
            String reportSha256, Map<String, LocaleMeasurement> locales,
            boolean revoked, Clock clock, Duration maxEvidenceAge) {
        this.providerId = providerId;
        this.providerVersion = providerVersion;
        this.modelRevision = modelRevision;
        this.modelExportSha256 = modelExportSha256;
        this.scope = scope;
        this.measuredAt = measuredAt;
        this.reportSha256 = reportSha256;
        this.locales = Map.copyOf(locales);
        this.worstWer = locales.values().stream()
                .mapToDouble(LocaleMeasurement::wer).max().orElseThrow();
        this.revoked = revoked;
        this.clock = clock;
        this.maxEvidenceAge = maxEvidenceAge;
    }

    /**
     * Parses a trusted evidence snapshot from bytes already in memory. The
     * snapshot sha256 is computed over the exact supplied bytes. Any schema,
     * identity, dataset-revision, consistency or freshness violation fails
     * closed with {@link IllegalArgumentException}; no partial evidence is kept.
     */
    public static FrozenHoldoutQualityEvidence parse(
            byte[] evidenceBytes, Clock clock, Duration maxEvidenceAge) {
        if (evidenceBytes == null || evidenceBytes.length == 0
                || evidenceBytes.length > MAX_EVIDENCE_BYTES) {
            throw new IllegalArgumentException("evidence snapshot exceeds bounded size");
        }
        if (clock == null || maxEvidenceAge == null || maxEvidenceAge.isNegative()
                || maxEvidenceAge.isZero()) {
            throw new IllegalArgumentException("clock and positive max evidence age are required");
        }
        String reportSha256 = sha256Hex(evidenceBytes);
        JsonNode root = readJson(evidenceBytes);
        require(text(root, "schemaVersion").equals(SCHEMA_VERSION),
                "unsupported evidence schemaVersion");
        String status = text(root, "status");
        require(status.equals("ACTIVE") || status.equals("REVOKED"),
                "evidence status must be ACTIVE or REVOKED");

        JsonNode provider = required(root, "provider");
        String providerId = boundedToken(provider, "id");
        String providerVersion = boundedToken(provider, "version");
        JsonNode model = required(root, "model");
        String modelRevision = boundedToken(model, "revision");
        String modelExportSha256 = boundedRef(model, "exportSha256");
        JsonNode dataset = required(root, "dataset");
        require(text(dataset, "name").equals("google/fleurs"),
                "evidence dataset must be google/fleurs");
        String datasetRevision = text(dataset, "sourceRevision");
        require(datasetRevision.equals(FLEURS_SOURCE_REVISION),
                "evidence dataset source revision is not the pinned FLEURS revision");
        if (dataset.hasNonNull("manifestSha256")) {
            boundedRef(dataset, "manifestSha256");
        }
        Scope scope = parseScope(text(root, "scope"));
        Instant measuredAt = parseInstant(text(root, "measuredAt"));
        require(!measuredAt.isAfter(clock.instant().plusSeconds(60)),
                "evidence measurement time cannot be in the future");

        Map<String, LocaleMeasurement> locales =
                parseReport(required(root, "report"), datasetRevision, scope);
        return new FrozenHoldoutQualityEvidence(providerId, providerVersion, modelRevision,
                modelExportSha256, scope, measuredAt, reportSha256, locales,
                status.equals("REVOKED"), clock, maxEvidenceAge);
    }

    /**
     * Loads a trusted evidence snapshot from a local path. The file size is
     * checked before reading and the same bounded-content rules as
     * {@link #parse} apply. A missing file is an {@link IOException} at
     * composition time, never an admitted observation.
     */
    public static FrozenHoldoutQualityEvidence load(
            Path path, Clock clock, Duration maxEvidenceAge) throws IOException {
        long size = Files.size(path);
        if (size < 1 || size > MAX_EVIDENCE_BYTES) {
            throw new IllegalArgumentException("evidence snapshot exceeds bounded size");
        }
        return parse(Files.readAllBytes(path), clock, maxEvidenceAge);
    }

    /**
     * Returns the source-linked conservative single-series observation: the
     * maximum measured holdout WER across report locales, so no failing locale
     * is hidden by an average. Empty for any identity mismatch, a revoked
     * snapshot, or a measurement older than the bound evidence age.
     */
    @Override
    public Optional<MediaModalityContracts.ProviderQualityObservation> latest(
            String providerId, String providerVersion, String modelRevision) {
        if (revoked
                || !this.providerId.equals(providerId)
                || !this.providerVersion.equals(providerVersion)
                || !this.modelRevision.equals(modelRevision)
                || clock.instant().isAfter(measuredAt.plus(maxEvidenceAge))) {
            return Optional.empty();
        }
        return Optional.of(new MediaModalityContracts.ProviderQualityObservation(
                providerId, providerVersion, JobType.SPEECH_TO_TEXT, modelRevision,
                MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                worstWer, measuredAt, reportSha256, "", qualityScope()));
    }

    /**
     * The full measured series for the exact bound identity: the aggregate
     * worst-locale WER row plus one row per locale for each measured metric
     * (WER, CER and, when the report carries a speaker-cluster interval, the
     * 95% bounds the registered threshold decision actually compares). Revoked,
     * mismatched or stale evidence emits no rows.
     */
    @Override
    public java.util.List<MediaModalityContracts.ProviderQualityObservation> latestAll(
            String providerId, String providerVersion, String modelRevision) {
        Optional<MediaModalityContracts.ProviderQualityObservation> aggregate =
                latest(providerId, providerVersion, modelRevision);
        if (aggregate.isEmpty()) {
            return java.util.List.of();
        }
        java.util.List<MediaModalityContracts.ProviderQualityObservation> rows =
                new java.util.ArrayList<>(aggregate.stream().toList());
        for (LocaleMeasurement measurement : locales.values()) {
            rows.add(row(measurement,
                    MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                    measurement.wer()));
            rows.add(row(measurement,
                    MediaModalityContracts.ProviderQualityObservation.Metric.CER,
                    measurement.cer()));
            if (measurement.ci95Lower() != null) {
                rows.add(row(measurement,
                        MediaModalityContracts.ProviderQualityObservation.Metric.WER_CI95_LOWER,
                        measurement.ci95Lower()));
                rows.add(row(measurement,
                        MediaModalityContracts.ProviderQualityObservation.Metric.WER_CI95_UPPER,
                        measurement.ci95Upper()));
            }
        }
        return java.util.List.copyOf(rows);
    }

    private MediaModalityContracts.ProviderQualityObservation row(
            LocaleMeasurement measurement,
            MediaModalityContracts.ProviderQualityObservation.Metric metric, double value) {
        return new MediaModalityContracts.ProviderQualityObservation(
                providerId, providerVersion, JobType.SPEECH_TO_TEXT, modelRevision,
                metric, value, measuredAt, reportSha256,
                measurement.locale(), qualityScope());
    }

    private MediaModalityContracts.ProviderQualityObservation.QualityScope qualityScope() {
        return scope == Scope.INDEPENDENT_QUALIFIED_HOLDOUT
                ? MediaModalityContracts.ProviderQualityObservation.QualityScope.INDEPENDENT_QUALIFIED
                : MediaModalityContracts.ProviderQualityObservation.QualityScope.REFERENCE_ONLY;
    }

    /** Measured per-locale results for the exact bound model; unmodifiable. */
    public Map<String, LocaleMeasurement> localeMeasurements() {
        return locales;
    }

    public Scope scope() { return scope; }
    public Instant measuredAt() { return measuredAt; }
    public String reportSha256() { return reportSha256; }
    public String modelExportSha256() { return modelExportSha256; }

    private static Map<String, LocaleMeasurement> parseReport(
            JsonNode report, String datasetRevision, Scope scope) {
        require(text(report, "status").equals("MEASURED_ON_FROZEN_HOLDOUT"),
                "report is not a frozen-holdout measurement");
        require(text(report, "sourceRevision").equals(datasetRevision),
                "report source revision does not match the bound dataset revision");
        JsonNode results = required(report, "results");
        require(results.isObject(), "report results must be an object");
        Map<String, Double[]> intervals = new LinkedHashMap<>();
        Map<String, Double> decisionWer = new LinkedHashMap<>();
        if (report.hasNonNull("qualityDecision")) {
            JsonNode decision = report.get("qualityDecision");
            require(text(decision, "status").equals(
                            "PROVISIONAL_REFERENCE_EVALUATED_NOT_MODEL_OR_PRODUCTION_ADMISSION"),
                    "report quality decision must remain provisional and non-admitting");
            JsonNode byLocale = required(decision, "byLocale");
            for (String locale : REPORT_LOCALES) {
                JsonNode entry = required(byLocale, locale);
                JsonNode interval = required(entry, "interval");
                intervals.put(locale, new Double[]{
                        requiredDouble(interval, "lower"),
                        requiredDouble(interval, "upper")});
                decisionWer.put(locale, requiredDouble(entry, "observedWer"));
            }
        }
        Map<String, LocaleMeasurement> locales = new LinkedHashMap<>();
        for (String locale : REPORT_LOCALES) {
            JsonNode row = required(results, locale);
            Double[] interval = intervals.get(locale);
            LocaleMeasurement measurement = new LocaleMeasurement(locale,
                    requiredInt(row, "clipCount"),
                    requiredLong(row, "wordErrors"),
                    requiredLong(row, "referenceWords"),
                    requiredDouble(row, "wer"),
                    requiredLong(row, "charErrors"),
                    requiredLong(row, "referenceCodepoints"),
                    requiredDouble(row, "cer"),
                    interval == null ? null : interval[0],
                    interval == null ? null : interval[1]);
            Double observed = decisionWer.get(locale);
            if (observed != null) {
                require(Math.abs(observed - measurement.wer()) <= RATE_TOLERANCE,
                        "quality decision WER does not match measured results");
            }
            locales.put(locale, measurement);
        }
        if (scope == Scope.INDEPENDENT_QUALIFIED_HOLDOUT) {
            for (LocaleMeasurement measurement : locales.values()) {
                require(measurement.ci95Lower() != null && measurement.ci95Upper() != null,
                        "an independently qualified holdout requires measured interval bounds");
                require(measurement.clipCount() >= MIN_QUALIFIED_HOLDOUT_CLIPS_PER_LOCALE,
                        "an independently qualified holdout requires at least "
                                + MIN_QUALIFIED_HOLDOUT_CLIPS_PER_LOCALE + " clips per locale");
            }
        }
        return locales;
    }

    private static JsonNode readJson(byte[] bytes) {
        try {
            JsonNode root = MAPPER.readTree(bytes);
            if (root == null || !root.isObject()) {
                throw new IllegalArgumentException("evidence snapshot must be a JSON object");
            }
            return root;
        } catch (RuntimeException failure) {
            throw new IllegalArgumentException("evidence snapshot is not valid JSON", failure);
        }
    }

    private static JsonNode required(JsonNode node, String field) {
        JsonNode value = node == null ? null : node.get(field);
        if (value == null || value.isNull()) {
            throw new IllegalArgumentException("evidence field is required: " + field);
        }
        return value;
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = required(node, field);
        if (!value.isString()) {
            throw new IllegalArgumentException("evidence field must be a string: " + field);
        }
        return value.asString();
    }

    private static String boundedToken(JsonNode node, String field) {
        String value = text(node, field).trim();
        if (!value.matches(TOKEN)) {
            throw new IllegalArgumentException("evidence field is not a bounded token: " + field);
        }
        return value;
    }

    private static String boundedRef(JsonNode node, String field) {
        String value = text(node, field).trim();
        if (!value.matches(SHA256_REF)) {
            throw new IllegalArgumentException(
                    "evidence field must be sha256:<lowercase hex>: " + field);
        }
        return value;
    }

    private static int requiredInt(JsonNode node, String field) {
        JsonNode value = required(node, field);
        if (!value.canConvertToInt() || !value.isIntegralNumber()) {
            throw new IllegalArgumentException("evidence field must be an integer: " + field);
        }
        return value.intValue();
    }

    private static long requiredLong(JsonNode node, String field) {
        JsonNode value = required(node, field);
        if (!value.isIntegralNumber() || !value.canConvertToLong()) {
            throw new IllegalArgumentException("evidence field must be an integer: " + field);
        }
        return value.longValue();
    }

    private static double requiredDouble(JsonNode node, String field) {
        JsonNode value = required(node, field);
        if (!value.isNumber() || !Double.isFinite(value.doubleValue())) {
            throw new IllegalArgumentException("evidence field must be a finite number: " + field);
        }
        return value.doubleValue();
    }

    private static Scope parseScope(String value) {
        try {
            return Scope.valueOf(value);
        } catch (IllegalArgumentException failure) {
            throw new IllegalArgumentException("evidence scope must be REFERENCE_ONLY "
                    + "or INDEPENDENT_QUALIFIED_HOLDOUT", failure);
        }
    }

    private static Instant parseInstant(String value) {
        try {
            return Instant.parse(value.trim());
        } catch (java.time.format.DateTimeParseException failure) {
            throw new IllegalArgumentException("evidence measuredAt must be an ISO instant", failure);
        }
    }

    private static void require(boolean condition, String message) {
        if (!condition) {
            throw new IllegalArgumentException(message);
        }
    }

    private static String sha256Hex(byte[] value) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(value));
        } catch (NoSuchAlgorithmException failure) {
            throw new IllegalStateException("SHA-256 is unavailable", failure);
        }
    }
}
