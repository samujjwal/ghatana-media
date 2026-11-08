package com.ghatana.stt.provider;

import com.ghatana.media.runtime.MediaModalityContracts;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.DeserializationFeature;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Bounded, digest-pinned aggregate telemetry for a Common Voice v27 pilot.
 * This reader always emits reference-only observations; it carries no quality
 * thresholds and cannot admit a model or provider. Per-clip identifiers,
 * paths, references, and predictions are never copied into observations.
 */
public final class CommonVoicePilotQualityEvidence
        implements WhisperOnnxSttProvider.QualityEvidenceReader {

    public static final String SCHEMA_VERSION = "media.stt-common-voice-pilot-evidence.v1";
    public static final String DATASET_NAME = "Mozilla Common Voice Scripted Speech 27.0";
    public static final String SOURCE_REVISION = "cv-corpus-27.0-2026-09-11";
    public static final int MAX_EVIDENCE_BYTES = 256 * 1024;
    public static final int PILOT_CLIPS_PER_LOCALE = 24;

    private static final String EVIDENCE_CLASS = "MEASURED_COMMON_VOICE_V27_PILOT";
    private static final String TOKEN = "[A-Za-z0-9][A-Za-z0-9._:+-]{0,127}";
    private static final String SHA256_REF = "sha256:[0-9a-f]{64}";
    private static final Set<String> ACTIVE_LOCALES = Set.of("en", "ne-NP");
    private static final Map<String, String> DATASET_IDS = Map.of(
            "en", "cmu5jplf300nwmh07iqvk9leo",
            "ne-NP", "cmu61478v00j9o107alzuue1z");
    private static final double RATE_TOLERANCE = 1e-9;
    private static final ObjectMapper MAPPER = new ObjectMapper(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build())
            .rebuild().enable(DeserializationFeature.FAIL_ON_TRAILING_TOKENS).build();

    public record LocaleMeasurement(String locale, int clipCount, long wordErrors,
            long referenceWords, double wer, long charErrors,
            long referenceCodepoints, double cer) {
        public LocaleMeasurement {
            if (!ACTIVE_LOCALES.contains(locale)) {
                throw new IllegalArgumentException("unsupported Common Voice pilot locale");
            }
            if (clipCount != PILOT_CLIPS_PER_LOCALE || wordErrors < 0 || referenceWords < 1
                    || charErrors < 0 || referenceCodepoints < 1) {
                throw new IllegalArgumentException("pilot counts are invalid");
            }
            if (!Double.isFinite(wer) || wer < 0 || !Double.isFinite(cer) || cer < 0
                    || Math.abs(wer - (double) wordErrors / referenceWords) > RATE_TOLERANCE
                    || Math.abs(cer - (double) charErrors / referenceCodepoints) > RATE_TOLERANCE) {
                throw new IllegalArgumentException("pilot rates are invalid or inconsistent");
            }
        }
    }

    private final String providerId;
    private final String providerVersion;
    private final String modelRevision;
    private final String modelExportSha256;
    private final String reportSha256;
    private final Instant measuredAt;
    private final Map<String, LocaleMeasurement> locales;
    private final boolean revoked;
    private final Clock clock;
    private final Duration maxEvidenceAge;

    private CommonVoicePilotQualityEvidence(String providerId, String providerVersion,
            String modelRevision, String modelExportSha256, String reportSha256,
            Instant measuredAt, Map<String, LocaleMeasurement> locales, boolean revoked,
            Clock clock, Duration maxEvidenceAge) {
        this.providerId = providerId;
        this.providerVersion = providerVersion;
        this.modelRevision = modelRevision;
        this.modelExportSha256 = modelExportSha256;
        this.reportSha256 = reportSha256;
        this.measuredAt = measuredAt;
        this.locales = Map.copyOf(locales);
        this.revoked = revoked;
        this.clock = clock;
        this.maxEvidenceAge = maxEvidenceAge;
    }

    /** Parses and verifies one complete envelope against its trusted exact-byte digest. */
    public static CommonVoicePilotQualityEvidence parse(byte[] evidenceBytes,
            String expectedSnapshotSha256, Map<String, String> expectedClipManifestSha256,
            Clock clock, Duration maxEvidenceAge) {
        if (evidenceBytes == null || evidenceBytes.length == 0
                || evidenceBytes.length > MAX_EVIDENCE_BYTES) {
            throw new IllegalArgumentException("evidence snapshot exceeds bounded size");
        }
        if (expectedSnapshotSha256 == null || !expectedSnapshotSha256.matches(SHA256_REF)) {
            throw new IllegalArgumentException("a trusted sha256:<lowercase hex> snapshot pin is required");
        }
        byte[] snapshot = evidenceBytes.clone();
        String digest = sha256Hex(snapshot);
        if (!expectedSnapshotSha256.equals("sha256:" + digest)) {
            throw new IllegalArgumentException("evidence snapshot digest does not match trusted pin");
        }
        if (clock == null || maxEvidenceAge == null || maxEvidenceAge.isNegative()
                || maxEvidenceAge.isZero()) {
            throw new IllegalArgumentException("clock and positive max evidence age are required");
        }
        JsonNode root = readJson(snapshot);
        requireExactFields(root, Set.of("schemaVersion", "status", "evidenceClass", "scope",
                "provider", "model", "host", "dataset", "measuredAt", "results"), "envelope");
        require(text(root, "schemaVersion").equals(SCHEMA_VERSION), "unsupported evidence schemaVersion");
        require(text(root, "evidenceClass").equals(EVIDENCE_CLASS), "unsupported Common Voice evidence class");
        String status = text(root, "status");
        require(status.equals("ACTIVE") || status.equals("REVOKED"), "evidence status must be ACTIVE or REVOKED");
        require(text(root, "scope").equals("REFERENCE_ONLY"), "Common Voice pilot scope must be REFERENCE_ONLY");

        JsonNode provider = required(root, "provider");
        requireExactFields(provider, Set.of("id", "version"), "provider");
        String providerId = boundedToken(provider, "id");
        String providerVersion = boundedToken(provider, "version");
        JsonNode model = required(root, "model");
        requireExactFields(model, Set.of("revision", "exportSha256"), "model");
        String modelRevision = boundedToken(model, "revision");
        String modelExportSha256 = boundedRef(model, "exportSha256");
        JsonNode host = required(root, "host");
        requireExactFields(host, Set.of("profileId", "os", "architecture"), "host");
        boundedToken(host, "profileId");
        boundedToken(host, "os");
        boundedToken(host, "architecture");
        JsonNode dataset = required(root, "dataset");
        requireExactFields(dataset, Set.of("name", "locales"), "dataset");
        require(text(dataset, "name").equals(DATASET_NAME), "dataset must be Mozilla Common Voice Scripted Speech 27.0");
        Instant measuredAt = parseInstant(text(root, "measuredAt"));
        require(!measuredAt.isAfter(clock.instant().plusSeconds(60)), "evidence measurement time cannot be in the future");

        JsonNode results = required(root, "results");
        require(results.isObject(), "results must be an object");
        Set<String> locales = keys(results);
        require(!locales.isEmpty() && locales.size() <= ACTIVE_LOCALES.size()
                        && ACTIVE_LOCALES.containsAll(locales),
                "results must contain only active Common Voice locales en and ne-NP");
        JsonNode datasetLocales = required(dataset, "locales");
        require(datasetLocales.isObject() && keys(datasetLocales).equals(locales),
                "dataset locales must contain exactly the measured locale keys");
        require(expectedClipManifestSha256 != null
                        && expectedClipManifestSha256.keySet().equals(locales),
                "trusted clip manifest pins must contain exactly the measured locale keys");
        for (String locale : locales) {
            JsonNode localeDataset = required(datasetLocales, locale);
            requireExactFields(localeDataset, Set.of("datasetId", "sourceRevision",
                    "sourceSplit", "clipManifestSha256"), "dataset locale " + locale);
            require(text(localeDataset, "datasetId").equals(DATASET_IDS.get(locale)),
                    "dataset ID does not match active Common Voice locale " + locale);
            require(text(localeDataset, "sourceRevision").equals(SOURCE_REVISION),
                    "dataset source revision is not the pinned Common Voice v27 revision");
            require(text(localeDataset, "sourceSplit").equals("test"),
                    "dataset source split must be the official test split");
            String manifestDigest = boundedRef(localeDataset, "clipManifestSha256");
            String expectedManifestDigest = expectedClipManifestSha256.get(locale);
            require(expectedManifestDigest != null && expectedManifestDigest.matches(SHA256_REF),
                    "trusted clip manifest pin must be sha256:<lowercase hex> for " + locale);
            require(manifestDigest.equals(expectedManifestDigest),
                    "clip manifest digest does not match trusted pin for " + locale);
        }
        Map<String, LocaleMeasurement> measurements = new LinkedHashMap<>();
        for (String locale : locales) {
            JsonNode row = required(results, locale);
            requireExactFields(row, Set.of("clipCount", "wordErrors", "referenceWords", "wer",
                    "charErrors", "referenceCodepoints", "cer"), "result " + locale);
            LocaleMeasurement measurement = new LocaleMeasurement(locale,
                    requiredInt(row, "clipCount"), requiredLong(row, "wordErrors"),
                    requiredLong(row, "referenceWords"), requiredDouble(row, "wer"),
                    requiredLong(row, "charErrors"), requiredLong(row, "referenceCodepoints"),
                    requiredDouble(row, "cer"));
            measurements.put(locale, measurement);
        }
        return new CommonVoicePilotQualityEvidence(providerId, providerVersion, modelRevision,
                modelExportSha256, digest, measuredAt, measurements, status.equals("REVOKED"),
                clock, maxEvidenceAge);
    }

    public static CommonVoicePilotQualityEvidence load(Path path, String expectedSnapshotSha256,
            Map<String, String> expectedClipManifestSha256, Clock clock,
            Duration maxEvidenceAge) throws IOException {
        try (InputStream input = Files.newInputStream(path)) {
            return parse(readBoundedSnapshot(input), expectedSnapshotSha256,
                    expectedClipManifestSha256, clock, maxEvidenceAge);
        }
    }

    static byte[] readBoundedSnapshot(InputStream input) throws IOException {
        byte[] bytes = input.readNBytes(MAX_EVIDENCE_BYTES + 1);
        if (bytes.length > MAX_EVIDENCE_BYTES) {
            throw new IllegalArgumentException("evidence snapshot exceeds bounded size");
        }
        return bytes;
    }

    @Override
    public Optional<MediaModalityContracts.ProviderQualityObservation> latest(
            String providerId, String providerVersion, String modelRevision) {
        if (!eligible(providerId, providerVersion, modelRevision)) {
            return Optional.empty();
        }
        if (!hasBothActiveLocales()) {
            return Optional.empty();
        }
        double worstWer = locales.values().stream().mapToDouble(LocaleMeasurement::wer).max().orElseThrow();
        return Optional.of(observation(MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                worstWer, ""));
    }

    @Override
    public List<MediaModalityContracts.ProviderQualityObservation> latestAll(
            String providerId, String providerVersion, String modelRevision) {
        if (!eligible(providerId, providerVersion, modelRevision)) {
            return List.of();
        }
        List<MediaModalityContracts.ProviderQualityObservation> rows = new ArrayList<>();
        if (hasBothActiveLocales()) {
            rows.add(latest(providerId, providerVersion, modelRevision).orElseThrow());
        }
        for (LocaleMeasurement measurement : locales.values()) {
            rows.add(observation(MediaModalityContracts.ProviderQualityObservation.Metric.WER,
                    measurement.wer(), measurement.locale()));
            rows.add(observation(MediaModalityContracts.ProviderQualityObservation.Metric.CER,
                    measurement.cer(), measurement.locale()));
        }
        return List.copyOf(rows);
    }

    private boolean eligible(String requestedProvider, String requestedVersion, String requestedModel) {
        return !revoked && providerId.equals(requestedProvider) && providerVersion.equals(requestedVersion)
                && modelRevision.equals(requestedModel)
                && isWithinEvidenceAge(clock.instant());
    }

    private boolean isWithinEvidenceAge(Instant now) {
        // Compare elapsed time rather than adding the configured age to the
        // measurement instant: plus() can overflow for a valid large Duration.
        return !now.isAfter(measuredAt)
                || Duration.between(measuredAt, now).compareTo(maxEvidenceAge) <= 0;
    }

    private boolean hasBothActiveLocales() {
        return locales.keySet().equals(ACTIVE_LOCALES);
    }

    private MediaModalityContracts.ProviderQualityObservation observation(
            MediaModalityContracts.ProviderQualityObservation.Metric metric, double value, String locale) {
        return new MediaModalityContracts.ProviderQualityObservation(providerId, providerVersion,
                JobType.SPEECH_TO_TEXT, modelRevision, metric, value, measuredAt,
                reportSha256, locale.toLowerCase(java.util.Locale.ROOT),
                MediaModalityContracts.ProviderQualityObservation.QualityScope.REFERENCE_ONLY);
    }

    public Map<String, LocaleMeasurement> localeMeasurements() { return locales; }
    public Instant measuredAt() { return measuredAt; }
    public String reportSha256() { return reportSha256; }
    public String modelExportSha256() { return modelExportSha256; }

    @Override
    public boolean matchesModelExportSha256(String pinnedModelSha256) {
        return pinnedModelSha256 != null
                && pinnedModelSha256.matches("[0-9a-f]{64}")
                && modelExportSha256.equals("sha256:" + pinnedModelSha256);
    }

    private static JsonNode readJson(byte[] bytes) {
        try {
            JsonNode root = MAPPER.readTree(bytes);
            if (root == null || !root.isObject()) throw new IllegalArgumentException("evidence snapshot must be a JSON object");
            return root;
        } catch (RuntimeException failure) {
            throw new IllegalArgumentException("evidence snapshot is not valid JSON", failure);
        }
    }

    private static JsonNode required(JsonNode node, String field) {
        JsonNode value = node == null ? null : node.get(field);
        if (value == null || value.isNull()) throw new IllegalArgumentException("evidence field is required: " + field);
        return value;
    }
    private static String text(JsonNode node, String field) {
        JsonNode value = required(node, field);
        if (!value.isString()) throw new IllegalArgumentException("evidence field must be a string: " + field);
        return value.asString();
    }
    private static String boundedToken(JsonNode node, String field) {
        String value = text(node, field).trim();
        if (!value.matches(TOKEN)) throw new IllegalArgumentException("evidence field is not a bounded token: " + field);
        return value;
    }
    private static String boundedRef(JsonNode node, String field) {
        String value = text(node, field);
        if (!value.matches(SHA256_REF)) throw new IllegalArgumentException("evidence field must be sha256:<lowercase hex>: " + field);
        return value;
    }
    private static Set<String> keys(JsonNode node) {
        Set<String> keys = new java.util.HashSet<>();
        node.propertyNames().forEach(keys::add);
        return keys;
    }
    private static void requireExactFields(JsonNode node, Set<String> expected, String label) {
        require(node.isObject() && keys(node).equals(expected),
                label + " must contain exactly the registered fields");
    }
    private static int requiredInt(JsonNode node, String field) {
        JsonNode value = required(node, field);
        if (!value.isIntegralNumber() || !value.canConvertToInt()) throw new IllegalArgumentException("evidence field must be an integer: " + field);
        return value.intValue();
    }
    private static long requiredLong(JsonNode node, String field) {
        JsonNode value = required(node, field);
        if (!value.isIntegralNumber() || !value.canConvertToLong()) throw new IllegalArgumentException("evidence field must be an integer: " + field);
        return value.longValue();
    }
    private static double requiredDouble(JsonNode node, String field) {
        JsonNode value = required(node, field);
        if (!value.isNumber() || !Double.isFinite(value.doubleValue())) throw new IllegalArgumentException("evidence field must be a finite number: " + field);
        return value.doubleValue();
    }
    private static Instant parseInstant(String value) {
        try { return Instant.parse(value.trim()); }
        catch (java.time.format.DateTimeParseException failure) { throw new IllegalArgumentException("evidence measuredAt must be an ISO instant", failure); }
    }
    private static void require(boolean condition, String message) {
        if (!condition) throw new IllegalArgumentException(message);
    }
    private static String sha256Hex(byte[] value) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
        catch (NoSuchAlgorithmException failure) { throw new IllegalStateException("SHA-256 is unavailable", failure); }
    }
}
