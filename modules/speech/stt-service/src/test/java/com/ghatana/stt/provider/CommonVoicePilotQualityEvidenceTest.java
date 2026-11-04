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
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class CommonVoicePilotQualityEvidenceTest {

    private static final Instant MEASURED_AT = Instant.parse("2026-11-02T12:00:00Z");
    private static final Duration MAX_AGE = Duration.ofDays(30);

    @TempDir
    Path tempDir;
    private static final String EN_ROW = "\"en\":{\"clipCount\":24,\"wordErrors\":2,"
            + "\"referenceWords\":100,\"wer\":0.02,\"charErrors\":5,"
            + "\"referenceCodepoints\":500,\"cer\":0.01}";
    private static final String NE_ROW = "\"ne-NP\":{\"clipCount\":24,\"wordErrors\":4,"
            + "\"referenceWords\":100,\"wer\":0.04,\"charErrors\":10,"
            + "\"referenceCodepoints\":500,\"cer\":0.02}";

    private static String envelope(String status, String scope, String datasetName,
            String datasetLocales,
            String results, String measuredAt) {
        return """
                {
                  "schemaVersion":"media.stt-common-voice-pilot-evidence.v1",
                  "status":"%s",
                  "evidenceClass":"MEASURED_COMMON_VOICE_V27_PILOT",
                  "scope":"%s",
                  "provider":{"id":"whisper-provider","version":"whisper-v1"},
                  "model":{"revision":"whisper-tiny","exportSha256":"sha256:%s"},
                  "host":{"profileId":"local-cpu-pilot","os":"macos","architecture":"arm64"},
                  "dataset":{"name":"%s","locales":{%s}},
                  "measuredAt":"%s",
                  "results":{%s}
                }
                """.formatted(status, scope, "b".repeat(64), datasetName, datasetLocales,
                measuredAt, results);
    }

    private static String localeDataset(String datasetId, String revision, String split) {
        return "{\"datasetId\":\"" + datasetId + "\",\"sourceRevision\":\""
                + revision + "\",\"sourceSplit\":\"" + split
                + "\",\"clipManifestSha256\":\"sha256:"
                + (datasetId.startsWith("cmu5jpl") ? "c" : "d").repeat(64) + "\"}";
    }

    private static String validEnvelope() {
        return envelope("ACTIVE", "REFERENCE_ONLY", "Mozilla Common Voice Scripted Speech 27.0",
                "\"en\":" + localeDataset("cmu5jplf300nwmh07iqvk9leo",
                        "cv-corpus-27.0-2026-09-11", "test") + ","
                        + "\"ne-NP\":" + localeDataset("cmu61478v00j9o107alzuue1z",
                                "cv-corpus-27.0-2026-09-11", "test"),
                EN_ROW + "," + NE_ROW, MEASURED_AT.toString());
    }

    private static Map<String, String> trustedManifestPins(boolean includeNepali) {
        return includeNepali
                ? Map.of("en", "sha256:" + "c".repeat(64), "ne-NP", "sha256:" + "d".repeat(64))
                : Map.of("en", "sha256:" + "c".repeat(64));
    }

    private static byte[] bytes(String value) { return value.getBytes(StandardCharsets.UTF_8); }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }

    private static CommonVoicePilotQualityEvidence parse(String json) throws Exception {
        byte[] snapshot = bytes(json);
        return CommonVoicePilotQualityEvidence.parse(snapshot, "sha256:" + sha256(snapshot),
                trustedManifestPins(json.contains("\"ne-NP\":{")),
                Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE);
    }

    @Test
    void reportsOnlyReferenceScopeAggregateWorstLocaleAndLocaleWerCer() throws Exception {
        byte[] snapshot = bytes(validEnvelope());
        var evidence = CommonVoicePilotQualityEvidence.parse(snapshot, "sha256:" + sha256(snapshot),
                trustedManifestPins(true), Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE);
        var rows = evidence.latestAll("whisper-provider", "whisper-v1", "whisper-tiny");
        assertThat(rows).hasSize(5);
        assertThat(rows).allSatisfy(row -> {
            assertThat(row.providerId()).isEqualTo("whisper-provider");
            assertThat(row.modality()).isEqualTo(JobType.SPEECH_TO_TEXT);
            assertThat(row.measuredAt()).isEqualTo(MEASURED_AT);
            assertThat(row.reportSha256()).isEqualTo(sha256(snapshot));
            assertThat(row.scope()).isEqualTo(
                    MediaModalityContracts.ProviderQualityObservation.QualityScope.REFERENCE_ONLY);
        });
        assertThat(rows).anySatisfy(row -> {
            assertThat(row.locale()).isEmpty();
            assertThat(row.metric()).isEqualTo(MediaModalityContracts.ProviderQualityObservation.Metric.WER);
            assertThat(row.measuredValue()).isEqualTo(0.04);
        });
        assertThat(rows).anySatisfy(row -> {
            assertThat(row.locale()).isEqualTo("en");
            assertThat(row.metric()).isEqualTo(MediaModalityContracts.ProviderQualityObservation.Metric.CER);
            assertThat(row.measuredValue()).isEqualTo(0.01);
        });
        assertThat(rows).anySatisfy(row -> {
            assertThat(row.locale()).isEqualTo("ne-np");
            assertThat(row.metric()).isEqualTo(MediaModalityContracts.ProviderQualityObservation.Metric.WER);
            assertThat(row.measuredValue()).isEqualTo(0.04);
        });
        assertThat(evidence.localeMeasurements().keySet()).containsExactlyInAnyOrder("en", "ne-NP");
    }

    @Test
    void acceptsAnEnglishOnlyPilotBoundToItsExactDatasetId() throws Exception {
        var evidence = parse(envelope("ACTIVE", "REFERENCE_ONLY",
                "Mozilla Common Voice Scripted Speech 27.0",
                "\"en\":" + localeDataset("cmu5jplf300nwmh07iqvk9leo",
                        "cv-corpus-27.0-2026-09-11", "test"), EN_ROW,
                MEASURED_AT.toString()));
        assertThat(evidence.latest("whisper-provider", "whisper-v1", "whisper-tiny")).isEmpty();
        assertThat(evidence.latestAll("whisper-provider", "whisper-v1", "whisper-tiny")).hasSize(2);
    }

    @Test
    void modelExportDigestMustMatchAnExactPinnedPlainSha256() throws Exception {
        var evidence = parse(validEnvelope());
        assertThat(evidence.matchesModelExportSha256("b".repeat(64))).isTrue();
        assertThat(evidence.matchesModelExportSha256("a".repeat(64))).isFalse();
        assertThat(evidence.matchesModelExportSha256("sha256:" + "b".repeat(64))).isFalse();
        assertThat(evidence.matchesModelExportSha256("B".repeat(64))).isFalse();
        assertThat(evidence.matchesModelExportSha256(null)).isFalse();
        assertThat(evidence.matchesModelExportSha256("")).isFalse();
    }

    @Test
    void everyMeasuredLocaleRequiresItsExactTrustedManifestDigest() throws Exception {
        byte[] snapshot = bytes(validEnvelope());
        Clock clock = Clock.fixed(MEASURED_AT, ZoneOffset.UTC);
        String snapshotPin = "sha256:" + sha256(snapshot);
        assertThat(CommonVoicePilotQualityEvidence.parse(snapshot, snapshotPin,
                trustedManifestPins(true), clock, MAX_AGE)).isNotNull();
        assertThatThrownBy(() -> CommonVoicePilotQualityEvidence.parse(snapshot, snapshotPin,
                null, clock, MAX_AGE)).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exactly the measured locale keys");
        assertThatThrownBy(() -> CommonVoicePilotQualityEvidence.parse(snapshot, snapshotPin,
                Map.of("en", "sha256:" + "c".repeat(64)), clock, MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exactly the measured locale keys");
        assertThatThrownBy(() -> CommonVoicePilotQualityEvidence.parse(snapshot, snapshotPin,
                Map.of("en", "sha256:" + "c".repeat(64), "ne-NP", "sha256:" + "d".repeat(64),
                        "hi", "sha256:" + "e".repeat(64)), clock, MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("exactly the measured locale keys");
        assertThatThrownBy(() -> CommonVoicePilotQualityEvidence.parse(snapshot, snapshotPin,
                Map.of("en", "sha256:" + "d".repeat(64), "ne-NP", "sha256:" + "c".repeat(64)),
                clock, MAX_AGE)).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("does not match trusted pin");
        assertThatThrownBy(() -> CommonVoicePilotQualityEvidence.parse(snapshot, snapshotPin,
                Map.of("en", "sha256:" + "C".repeat(64), "ne-NP", "sha256:" + "d".repeat(64)),
                clock, MAX_AGE)).isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("trusted clip manifest pin");
    }

    @Test
    void requiresExactTrustedSnapshotDigestAndBoundedSize() throws Exception {
        byte[] snapshot = bytes(validEnvelope());
        assertThatThrownBy(() -> CommonVoicePilotQualityEvidence.parse(snapshot, null,
                trustedManifestPins(true), Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("trusted sha256");
        assertThatThrownBy(() -> CommonVoicePilotQualityEvidence.parse(snapshot, "sha256:" + "0".repeat(64),
                trustedManifestPins(true), Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("does not match");
        assertThatThrownBy(() -> CommonVoicePilotQualityEvidence.parse(
                new byte[CommonVoicePilotQualityEvidence.MAX_EVIDENCE_BYTES + 1],
                "sha256:" + "0".repeat(64), trustedManifestPins(true),
                Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("bounded size");
    }

    @Test
    void boundedFileLoadRequiresTheSameSnapshotAndPrivateManifestPins() throws Exception {
        byte[] snapshot = bytes(validEnvelope());
        Path report = tempDir.resolve("common-voice-reference-only.json");
        Files.write(report, snapshot);
        var loaded = CommonVoicePilotQualityEvidence.load(report, "sha256:" + sha256(snapshot),
                trustedManifestPins(true), Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE);
        assertThat(loaded.latestAll("whisper-provider", "whisper-v1", "whisper-tiny")).hasSize(5);

        Files.write(report, new byte[CommonVoicePilotQualityEvidence.MAX_EVIDENCE_BYTES + 1]);
        assertThatThrownBy(() -> CommonVoicePilotQualityEvidence.load(report,
                "sha256:" + "0".repeat(64), trustedManifestPins(true),
                Clock.fixed(MEASURED_AT, ZoneOffset.UTC), MAX_AGE))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("bounded size");
    }

    @Test
    void rejectsFleursLegacyLocaleAndHindiOrExtraLocale() throws Exception {
        assertInvalid(validEnvelope().replace("Mozilla Common Voice Scripted Speech 27.0", "google/fleurs"));
        assertInvalid(validEnvelope().replace("\"en\":{", "\"eng\":{"));
        String hindi = validEnvelope().replace("\"ne-NP\":{", "\"hi\":{");
        assertInvalid(hindi);
        assertInvalid(validEnvelope().replace("\"results\":{", "\"results\":{\"fr\":{},"));
    }

    @Test
    void rejectsWrongDatasetIdRevisionOrSplit() throws Exception {
        assertInvalid(validEnvelope().replace("cmu5jplf300nwmh07iqvk9leo", "old-dataset-id"));
        assertInvalid(validEnvelope().replace("cv-corpus-27.0-2026-09-11", "cv-corpus-26.0"));
        assertInvalid(validEnvelope().replace("\"sourceSplit\":\"test\"", "\"sourceSplit\":\"dev\""));
    }

    @Test
    void rejectsClipCountAndAnyScopePromotion() throws Exception {
        assertInvalid(validEnvelope().replace("\"clipCount\":24", "\"clipCount\":100"));
        assertInvalid(validEnvelope().replace("\"scope\":\"REFERENCE_ONLY\"", "\"scope\":\"INDEPENDENT_QUALIFIED\""));
        assertInvalid(validEnvelope().replace("\"scope\":\"REFERENCE_ONLY\"", "\"scope\":\"PRODUCTION_ADMITTED\""));
    }

    @Test
    void staleRevokedAndWrongIdentitySnapshotsEmitNoRows() throws Exception {
        var current = parse(validEnvelope());
        assertThat(current.latest("other", "whisper-v1", "whisper-tiny")).isEmpty();
        assertThat(current.latest("whisper-provider", "other", "whisper-tiny")).isEmpty();
        assertThat(current.latest("whisper-provider", "whisper-v1", "other")).isEmpty();
        assertThat(current.latestAll("other", "whisper-v1", "whisper-tiny")).isEmpty();
        var revoked = parse(validEnvelope().replace("\"status\":\"ACTIVE\"", "\"status\":\"REVOKED\""));
        assertThat(revoked.latestAll("whisper-provider", "whisper-v1", "whisper-tiny")).isEmpty();
        byte[] staleBytes = bytes(validEnvelope());
        var stale = CommonVoicePilotQualityEvidence.parse(staleBytes, "sha256:" + sha256(staleBytes),
                trustedManifestPins(true),
                Clock.fixed(MEASURED_AT.plus(MAX_AGE).plusSeconds(1), ZoneOffset.UTC), MAX_AGE);
        assertThat(stale.latest("whisper-provider", "whisper-v1", "whisper-tiny")).isEmpty();
    }

    @Test
    void rejectsInconsistentMetricsAndMalformedEvidence() throws Exception {
        assertInvalid(validEnvelope().replace("\"wer\":0.02", "\"wer\":0.5"));
        assertInvalid(validEnvelope().replace("\"referenceWords\":100", "\"referenceWords\":0"));
        assertInvalid(validEnvelope().replace("\"clipManifestSha256\":\"sha256:", "\"clipManifestSha256\":\"sha512:"));
        assertThatThrownBy(() -> parse("not-json")).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void rejectsExtraAndSensitiveFieldsAtEveryEnvelopeLevel() throws Exception {
        String valid = validEnvelope();
        assertInvalid(valid.replace("\"measuredAt\":", "\"transcript\":\"private text\",\"measuredAt\":"));
        assertInvalid(valid.replace("\"version\":\"whisper-v1\"", 
                "\"version\":\"whisper-v1\",\"speakerId\":\"private\""));
        assertInvalid(valid.replace("\"revision\":\"whisper-tiny\"", 
                "\"revision\":\"whisper-tiny\",\"prediction\":\"private\""));
        assertInvalid(valid.replace("\"architecture\":\"arm64\"", 
                "\"architecture\":\"arm64\",\"path\":\"/private/audio.mp3\""));
        assertInvalid(valid.replace("\"name\":\"Mozilla Common Voice Scripted Speech 27.0\"", 
                "\"name\":\"Mozilla Common Voice Scripted Speech 27.0\",\"demographics\":{}"));
        assertInvalid(valid.replace("\"clipManifestSha256\":\"sha256:" + "c".repeat(64) + "\"}",
                "\"clipManifestSha256\":\"sha256:" + "c".repeat(64) + "\",\"client_id\":\"private\"}"));
        assertInvalid(valid.replace("\"cer\":0.01}", "\"cer\":0.01,\"transcript\":\"private text\"}"));
    }

    @Test
    void rejectsDuplicateJsonKeysInsteadOfSilentlySelectingOneValue() throws Exception {
        String valid = validEnvelope();
        assertInvalid(valid.replace("\"status\":\"ACTIVE\"",
                "\"status\":\"ACTIVE\",\"status\":\"REVOKED\""));
        assertInvalid(valid.replace("\"clipCount\":24",
                "\"clipCount\":24,\"clipCount\":24"));
    }

    private static void assertInvalid(String json) throws Exception {
        assertThatThrownBy(() -> parse(json)).isInstanceOf(IllegalArgumentException.class);
    }
}
