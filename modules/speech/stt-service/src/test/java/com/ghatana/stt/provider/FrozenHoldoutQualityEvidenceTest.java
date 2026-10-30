package com.ghatana.stt.provider;

import com.ghatana.media.runtime.MediaModalityContracts;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.HexFormat;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Trusted frozen-holdout report ingestion for the Whisper quality evidence
 * reader. A genuine report emits the conservative worst-locale WER with a
 * source-linked digest; missing, revoked, mismatched or stale evidence emits
 * nothing rather than a phantom measurement.
 */
class FrozenHoldoutQualityEvidenceTest {

    private static final Instant MEASURED_AT = Instant.parse("2026-10-29T12:00:00Z");
    private static final Duration MAX_AGE = Duration.ofDays(30);

    @TempDir
    Path tempDir;

    private static String reportJson() {
        return """
                {
                  "status": "MEASURED_ON_FROZEN_HOLDOUT",
                  "sourceRevision": "70bb2e84b976b7e960aa89f1c648e09c59f894dd",
                  "results": {
                    "eng": {"clipCount": 24, "wordErrors": 100, "referenceWords": 250,
                            "wer": 0.4, "charErrors": 200, "referenceCodepoints": 1250,
                            "cer": 0.16},
                    "hin": {"clipCount": 24, "wordErrors": 274, "referenceWords": 250,
                            "wer": 1.096, "charErrors": 400, "referenceCodepoints": 1250,
                            "cer": 0.32},
                    "npi": {"clipCount": 24, "wordErrors": 261, "referenceWords": 250,
                            "wer": 1.044, "charErrors": 300, "referenceCodepoints": 1250,
                            "cer": 0.24}
                  }
                }
                """;
    }

    private static String qualifiedReportJson() {
        return """
                {
                  "status": "MEASURED_ON_FROZEN_HOLDOUT",
                  "sourceRevision": "70bb2e84b976b7e960aa89f1c648e09c59f894dd",
                  "results": {
                    "eng": {"clipCount": 120, "wordErrors": 500, "referenceWords": 2000,
                            "wer": 0.25, "charErrors": 500, "referenceCodepoints": 10000,
                            "cer": 0.05},
                    "hin": {"clipCount": 120, "wordErrors": 800, "referenceWords": 2000,
                            "wer": 0.4, "charErrors": 1000, "referenceCodepoints": 10000,
                            "cer": 0.1},
                    "npi": {"clipCount": 120, "wordErrors": 1100, "referenceWords": 2000,
                            "wer": 0.55, "charErrors": 1500, "referenceCodepoints": 10000,
                            "cer": 0.15}
                  },
                  "qualityDecision": {
                    "status": "PROVISIONAL_REFERENCE_EVALUATED_NOT_MODEL_OR_PRODUCTION_ADMISSION",
                    "byLocale": {
                      "eng": {"observedWer": 0.25, "werMax": 0.3,
                              "interval": {"lower": 0.2, "upper": 0.3},
                              "provisionalReferenceThresholdMet": true},
                      "hin": {"observedWer": 0.4, "werMax": 0.45,
                              "interval": {"lower": 0.35, "upper": 0.45},
                              "provisionalReferenceThresholdMet": true},
                      "npi": {"observedWer": 0.55, "werMax": 0.55,
                              "interval": {"lower": 0.5, "upper": 0.6},
                              "provisionalReferenceThresholdMet": false}
                    },
                    "allReferenceThresholdsMet": false,
                    "legalRightsAndProviderQualification": "NOT_EVALUATED_BY_THIS_TOOL"
                  }
                }
                """;
    }

    private static String envelope(String status, String scope, String measuredAt,
            String providerId, String modelRevision) {
        return envelope(status, scope, measuredAt, providerId, modelRevision, reportJson());
    }

    private static String envelope(String status, String scope, String measuredAt,
            String providerId, String modelRevision, String report) {
        return """
                {
                  "schemaVersion": "media.stt-quality-evidence.v1",
                  "status": "%s",
                  "provider": {"id": "%s", "version": "whisper-v1"},
                  "model": {"revision": "%s",
                            "exportSha256": "sha256:%s"},
                  "dataset": {"name": "google/fleurs",
                              "sourceRevision": "70bb2e84b976b7e960aa89f1c648e09c59f894dd",
                              "manifestSha256": "sha256:%s"},
                  "scope": "%s",
                  "measuredAt": "%s",
                  "report": %s
                }
                """.formatted(status, providerId, modelRevision, "b".repeat(64),
                "c".repeat(64), scope, measuredAt, report);
    }

    private static byte[] validSnapshot() {
        return envelope("ACTIVE", "REFERENCE_ONLY", MEASURED_AT.toString(),
                "whisper-provider", "whisper-tiny")
                .getBytes(StandardCharsets.UTF_8);
    }

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (java.security.NoSuchAlgorithmException failure) {
            throw new IllegalStateException(failure);
        }
    }

    @Test
    void genuineFrozenReportProducesSourceLinkedWorstLocaleWer() {
        byte[] snapshot = validSnapshot();
        var evidence = FrozenHoldoutQualityEvidence.parse(
                snapshot, Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE);

        Optional<MediaModalityContracts.ProviderQualityObservation> observation =
                evidence.latest("whisper-provider", "whisper-v1", "whisper-tiny");
        assertThat(observation).isPresent();
        var measured = observation.orElseThrow();
        assertThat(measured.providerId()).isEqualTo("whisper-provider");
        assertThat(measured.modality()).isEqualTo(JobType.SPEECH_TO_TEXT);
        assertThat(measured.modelRevision()).isEqualTo("whisper-tiny");
        assertThat(measured.metric())
                .isEqualTo(MediaModalityContracts.ProviderQualityObservation.Metric.WER);
        // The single series reports the worst measured locale so a failing
        // language cannot be hidden by aggregation.
        assertThat(measured.measuredValue()).isEqualTo(1.096);
        assertThat(measured.measuredAt()).isEqualTo(MEASURED_AT);
        assertThat(measured.reportSha256()).isEqualTo(sha256(snapshot));
        assertThat(evidence.localeMeasurements().keySet())
                .containsExactlyInAnyOrder("eng", "hin", "npi");
        assertThat(evidence.scope())
                .isEqualTo(FrozenHoldoutQualityEvidence.Scope.REFERENCE_ONLY);
    }

    @Test
    void identityMismatchRevocationAndStalenessEmitNoObservation() {
        byte[] snapshot = validSnapshot();
        var evidence = FrozenHoldoutQualityEvidence.parse(
                snapshot, Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE);
        assertThat(evidence.latest("other-provider", "whisper-v1", "whisper-tiny")).isEmpty();
        assertThat(evidence.latest("whisper-provider", "whisper-v2", "whisper-tiny")).isEmpty();
        assertThat(evidence.latest("whisper-provider", "whisper-v1", "whisper-base")).isEmpty();

        var revoked = FrozenHoldoutQualityEvidence.parse(
                envelope("REVOKED", "REFERENCE_ONLY", MEASURED_AT.toString(),
                        "whisper-provider", "whisper-tiny").getBytes(StandardCharsets.UTF_8),
                Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE);
        assertThat(revoked.latest("whisper-provider", "whisper-v1", "whisper-tiny")).isEmpty();

        var stale = FrozenHoldoutQualityEvidence.parse(
                snapshot,
                Clock.fixed(MEASURED_AT.plus(MAX_AGE).plusSeconds(1), ZoneOffset.UTC),
                MAX_AGE);
        assertThat(stale.latest("whisper-provider", "whisper-v1", "whisper-tiny")).isEmpty();
    }

    @Test
    void latestAllEmitsAggregateAndEveryMeasuredPerLocaleMetric() {
        byte[] snapshot = validSnapshot();
        var evidence = FrozenHoldoutQualityEvidence.parse(
                snapshot, Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE);

        var rows = evidence.latestAll("whisper-provider", "whisper-v1", "whisper-tiny");
        // Aggregate worst-locale WER plus WER and CER for each of three locales.
        assertThat(rows).hasSize(7);
        assertThat(rows).allSatisfy(row -> {
            assertThat(row.providerId()).isEqualTo("whisper-provider");
            assertThat(row.modality()).isEqualTo(JobType.SPEECH_TO_TEXT);
            assertThat(row.modelRevision()).isEqualTo("whisper-tiny");
            assertThat(row.measuredAt()).isEqualTo(MEASURED_AT);
            assertThat(row.reportSha256()).isEqualTo(sha256(snapshot));
            assertThat(row.scope()).isEqualTo(
                    MediaModalityContracts.ProviderQualityObservation.QualityScope.REFERENCE_ONLY);
        });
        var byLocale = new java.util.HashMap<String, java.util.List<Double>>();
        for (var row : rows) {
            if (row.locale().isEmpty()) {
                assertThat(row.metric())
                        .isEqualTo(MediaModalityContracts.ProviderQualityObservation.Metric.WER);
                assertThat(row.measuredValue()).isEqualTo(1.096);
                continue;
            }
            byLocale.computeIfAbsent(row.locale(), k -> new java.util.ArrayList<>())
                    .add(row.measuredValue());
        }
        assertThat(byLocale.get("hin")).containsExactlyInAnyOrder(1.096, 0.32);
        assertThat(evidence.latestAll("other-provider", "whisper-v1", "whisper-tiny")).isEmpty();
    }

    @Test
    void qualifiedScopeRequiresIndependentHoldoutIntervalsAndDepth() {
        byte[] qualified = envelope("ACTIVE", "INDEPENDENT_QUALIFIED_HOLDOUT",
                MEASURED_AT.toString(), "whisper-provider", "whisper-base",
                qualifiedReportJson()).getBytes(StandardCharsets.UTF_8);
        var evidence = FrozenHoldoutQualityEvidence.parse(
                qualified, Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE);

        var rows = evidence.latestAll("whisper-provider", "whisper-v1", "whisper-base");
        // Aggregate + WER/CER/CI95_LOWER/CI95_UPPER per locale.
        assertThat(rows).hasSize(13);
        assertThat(rows).allSatisfy(row -> assertThat(row.scope()).isEqualTo(
                MediaModalityContracts.ProviderQualityObservation.QualityScope.INDEPENDENT_QUALIFIED));
        assertThat(rows).anySatisfy(row -> {
            assertThat(row.locale()).isEqualTo("npi");
            assertThat(row.metric()).isEqualTo(
                    MediaModalityContracts.ProviderQualityObservation.Metric.WER_CI95_UPPER);
            assertThat(row.measuredValue()).isEqualTo(0.6);
        });
        // A pilot-depth or interval-free report cannot claim the qualified scope.
        assertThatThrownBy(() -> FrozenHoldoutQualityEvidence.parse(
                        envelope("ACTIVE", "INDEPENDENT_QUALIFIED_HOLDOUT",
                                MEASURED_AT.toString(), "whisper-provider", "whisper-tiny",
                                reportJson()).getBytes(StandardCharsets.UTF_8),
                        Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void boundedFileLoadReadsTheSameValidatedSnapshot() throws Exception {
        byte[] snapshot = validSnapshot();
        Path evidence = tempDir.resolve("whisper-quality-evidence.json");
        Files.write(evidence, snapshot);
        var loaded = FrozenHoldoutQualityEvidence.load(
                evidence, Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE);
        assertThat(loaded.latest("whisper-provider", "whisper-v1", "whisper-tiny"))
                .isPresent();
        assertThatThrownBy(() -> FrozenHoldoutQualityEvidence.load(
                        tempDir.resolve("absent.json"),
                        Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE))
                .isInstanceOf(java.io.IOException.class);
    }

    @Test
    void malformedTamperedOrUntrustedSnapshotsFailClosed() {
        Clock clock = Clock.fixed(MEASURED_AT, ZoneOffset.UTC);
        byte[] valid = validSnapshot();

        assertThatThrownBy(() -> FrozenHoldoutQualityEvidence.parse(
                        "not json".getBytes(StandardCharsets.UTF_8), clock, MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> FrozenHoldoutQualityEvidence.parse(
                        new byte[0], clock, MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> FrozenHoldoutQualityEvidence.parse(
                        new byte[FrozenHoldoutQualityEvidence.MAX_EVIDENCE_BYTES + 1],
                        clock, MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class);
        // Schema, dataset revision, scope, export digest and future time are all verified.
        assertThatThrownBy(() -> FrozenHoldoutQualityEvidence.parse(
                        new String(valid, StandardCharsets.UTF_8)
                                .replace("media.stt-quality-evidence.v1", "v0")
                                .getBytes(StandardCharsets.UTF_8), clock, MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> FrozenHoldoutQualityEvidence.parse(
                        new String(valid, StandardCharsets.UTF_8)
                                .replace("70bb2e84b976b7e960aa89f1c648e09c59f894dd",
                                        "0".repeat(40))
                                .getBytes(StandardCharsets.UTF_8), clock, MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> FrozenHoldoutQualityEvidence.parse(
                        new String(valid, StandardCharsets.UTF_8)
                                .replace("REFERENCE_ONLY", "PRODUCTION_ADMITTED")
                                .getBytes(StandardCharsets.UTF_8), clock, MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> FrozenHoldoutQualityEvidence.parse(
                        envelope("ACTIVE", "REFERENCE_ONLY",
                                MEASURED_AT.plusSeconds(3600).toString(),
                                "whisper-provider", "whisper-tiny")
                                .getBytes(StandardCharsets.UTF_8), clock, MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class);
        // A tampered WER that no longer matches its error counts is rejected.
        assertThatThrownBy(() -> FrozenHoldoutQualityEvidence.parse(
                        new String(valid, StandardCharsets.UTF_8)
                                .replace("\"wer\": 1.096", "\"wer\": 0.01")
                                .getBytes(StandardCharsets.UTF_8), clock, MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class);
        // A report that was not produced on a frozen holdout is rejected.
        assertThatThrownBy(() -> FrozenHoldoutQualityEvidence.parse(
                        new String(valid, StandardCharsets.UTF_8)
                                .replace("MEASURED_ON_FROZEN_HOLDOUT", "MEASURED_ON_TRAINING")
                                .getBytes(StandardCharsets.UTF_8), clock, MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
