package com.ghatana.media.provider.aws;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.ByteArrayOutputStream;
import java.io.PrintStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class Ip06FlywayHistoryCandidateReconcilerTest {
    private static final String HEADER = "installed_rank,version,description,type,script,checksum,installed_by,installed_on,execution_time,success\n";
    private static final String MANIFEST_HEADER = "version,description,flyway_checksum,source_sha256";

    @Test
    void cleanSyntheticHistoryMatchesSourceButAlwaysRemainsUnverifiedCandidate() {
        String csv = syntheticHistory();

        var report = Ip06FlywayHistoryCandidateReconciler.reconcile(csv.getBytes(StandardCharsets.UTF_8));

        assertThat(report.disposition())
                .isEqualTo("UNVERIFIED_CANDIDATE_PENDING_OPERATOR_PROVENANCE");
        assertThat(report.comparisonStatus()).isEqualTo("SOURCE_MATCH");
        assertThat(report.exitCode()).isZero();
        assertThat(report.exportSha256()).hasSize(64);
        assertThat(report.manifestSha256()).hasSize(64);
        assertThat(report.findings()).containsExactly(
                "LINEAGE_DISTINCTION: V007 expected legacy source V007__media_job_unknown_provider_outcome.sql checksum -2036800623; current Media source is V007__media_job_unknown_outcome.sql checksum " + currentChecksum(7),
                "LINEAGE_DISTINCTION: V008 expected legacy source V008__media_job_artifact_content_version.sql checksum -863726996; current Media source is V008__media_job_request_fingerprint.sql checksum " + currentChecksum(8),
                "LINEAGE_DISTINCTION: V009 expected legacy source V009__media_job_attempts_and_outbox.sql checksum -392192638; current Media source is V009__media_upload_idempotency.sql checksum " + currentChecksum(9));
        assertThat(report.asText())
                .contains("Candidate comparison only")
                .doesNotContain("DEPLOYED", "ACCEPTED", "CUTOVER_APPROVED");
    }

    @Test
    void detectsDuplicateMissingOutOfOrderFailedAndUnexpectedRows() {
        List<String> rows = csvRows();
        String v4 = rows.get(3);
        rows.set(3, rows.get(4));
        rows.set(4, v4);
        rows.add(rows.get(0));
        rows.remove(10); // leave V011 absent
        rows.add("30,31,unowned migration,SQL,V031__unowned.sql,1,test,2026-11-02T00:00:00Z,0,true");
        rows.set(0, rows.get(0).replace(",true", ",false"));

        var report = Ip06FlywayHistoryCandidateReconciler.reconcile(
                (HEADER + String.join("\n", rows) + "\n").getBytes(StandardCharsets.UTF_8));

        assertThat(report.findings()).anyMatch(f -> f.startsWith("DUPLICATE_VERSION: V001"));
        assertThat(report.findings()).anyMatch(f -> f.startsWith("MISSING_VERSION: V011"));
        assertThat(report.findings()).anyMatch(f -> f.startsWith("OUT_OF_ORDER_VERSION:"));
        assertThat(report.findings()).anyMatch(f -> f.startsWith("FAILED_HISTORY_ROW: V001"));
        assertThat(report.findings()).anyMatch(f -> f.startsWith("UNEXPECTED_VERSION: V031"));
        assertThat(report.disposition()).isEqualTo("UNVERIFIED_CANDIDATE_PENDING_OPERATOR_PROVENANCE");
    }

    @Test
    void detectsScriptTypeAndChecksumMismatchWithoutTrustingExportMetadata() {
        List<String> rows = csvRows();
        rows.set(20, rows.get(20).replace("SQL", "JDBC").replace("V021__", "V021__tampered_").replace(
                checksum(21), "123"));

        var report = Ip06FlywayHistoryCandidateReconciler.reconcile(
                (HEADER + String.join("\n", rows) + "\n").getBytes(StandardCharsets.UTF_8));

        assertThat(report.findings()).anyMatch(f -> f.startsWith("SCRIPT_MISMATCH: V021"));
        assertThat(report.findings()).anyMatch(f -> f.startsWith("TYPE_MISMATCH: V021"));
        assertThat(report.findings()).anyMatch(f -> f.startsWith("CHECKSUM_MISMATCH: V021"));
        assertThat(report.comparisonStatus()).isEqualTo("SOURCE_MISMATCH_OR_INCOMPLETE");
        assertThat(report.exitCode()).isEqualTo(1);
    }

    @Test
    void malformedCsvIsReportedAsCandidateInputFinding() {
        var report = Ip06FlywayHistoryCandidateReconciler.reconcile(
                "installed_rank,version,description\n1,\"unterminated".getBytes(StandardCharsets.UTF_8));

        assertThat(report.disposition()).isEqualTo("UNVERIFIED_CANDIDATE_PENDING_OPERATOR_PROVENANCE");
        assertThat(report.findings()).anyMatch(f -> f.startsWith("CSV_INVALID:"));
        assertThat(report.exitCode()).isEqualTo(1);
    }

    @Test
    void rejectsDuplicateOrMissingCsvHeadersAndExactFieldCountErrors() {
        assertInvalidCsv(HEADER.replace("version,description", "version,version"), csvRows());
        assertInvalidCsv(HEADER.replace("installed_rank,", ""), csvRows());
        List<String> shortRow = csvRows();
        shortRow.set(0, "1,1,short");
        assertInvalidCsv(HEADER, shortRow);
    }

    @Test
    void rejectsMalformedQuotePlacementAndInvalidSuccessValues() {
        List<String> rows = csvRows();
        rows.set(0, rows.get(0).replace("media runtime state", "media \"runtime\" state"));
        assertInvalidCsv(HEADER, rows);
        rows = csvRows();
        rows.set(0, rows.get(0).replace("media runtime state", "\"media runtime state\"x"));
        assertInvalidCsv(HEADER, rows);
        rows = csvRows();
        rows.set(0, rows.get(0).replace(",true", ",yes"));
        assertInvalidCsv(HEADER, rows);
    }

    @Test
    void rejectsMissingOrInvalidFlywayInstalledMetadata() {
        String valid = csvRows().getFirst();
        assertInvalidCsv(HEADER, List.of(valid.replace(",test,", ",,")));
        assertInvalidCsv(HEADER, List.of(valid.replace(",2026-11-02T00:00:00Z,", ",,")));
        assertInvalidCsv(HEADER, List.of(valid.replace(",2026-11-02T00:00:00Z,", ",yesterday,")));
        assertInvalidCsv(HEADER, List.of(valid.replace(",1,true", ",not-an-integer,true")));
        assertInvalidCsv(HEADER, List.of(valid.replace(",1,true", ",2147483648,true")));
        assertInvalidCsv(HEADER, List.of(valid.replace(",1,true", ",-1,true")));

        List<String> rows = csvRows();
        rows.set(0, rows.getFirst().replace(",2026-11-02T00:00:00Z,", ",2026-11-02 08:23:15.372722,"));
        assertThat(Ip06FlywayHistoryCandidateReconciler.reconcile(
                (HEADER + String.join("\n", rows) + "\n").getBytes(StandardCharsets.UTF_8)).comparisonStatus())
                .isEqualTo("SOURCE_MATCH");

        rows = csvRows();
        rows.set(0, rows.getFirst().replace(",2026-11-02T00:00:00Z,", ",2026-11-02T10:23:15.372722+02:00,"));
        assertThat(Ip06FlywayHistoryCandidateReconciler.reconcile(
                (HEADER + String.join("\n", rows) + "\n").getBytes(StandardCharsets.UTF_8)).comparisonStatus())
                .isEqualTo("SOURCE_MATCH");

        rows = csvRows();
        rows.set(0, rows.getFirst().replace(",1,true", ",0,true"));
        assertThat(Ip06FlywayHistoryCandidateReconciler.reconcile(
                (HEADER + String.join("\n", rows) + "\n").getBytes(StandardCharsets.UTF_8)).comparisonStatus())
                .isEqualTo("SOURCE_MATCH");
    }

    @Test
    void rejectsInvalidUtf8AndOversizedExports(@TempDir Path tempDir) throws Exception {
        var invalidUtf8 = Ip06FlywayHistoryCandidateReconciler.reconcile(new byte[]{(byte) 0xc3, 0x28});
        assertThat(invalidUtf8.findings()).containsExactly("CSV_INVALID_UTF8: input is not valid UTF-8");
        assertThat(invalidUtf8.exitCode()).isEqualTo(1);

        byte[] oversized = new byte[2 * 1024 * 1024 + 1];
        var tooLarge = Ip06FlywayHistoryCandidateReconciler.reconcile(oversized);
        assertThat(tooLarge.findings()).containsExactly("CSV_TOO_LARGE: maximum input size is 2097152 bytes");
        assertThat(tooLarge.exportSha256()).isEqualTo("UNAVAILABLE_NOT_COMPUTED");
        assertThat(tooLarge.exitCode()).isEqualTo(1);

        Path oversizedPath = tempDir.resolve("oversized-history.csv");
        Files.write(oversizedPath, oversized);
        var tooLargePath = Ip06FlywayHistoryCandidateReconciler.reconcile(oversizedPath);
        assertThat(tooLargePath.findings()).containsExactly("CSV_TOO_LARGE: maximum input size is 2097152 bytes");
        assertThat(tooLargePath.exportSha256()).isEqualTo("UNAVAILABLE_NOT_COMPUTED");
        assertThat(tooLargePath.exitCode()).isEqualTo(1);
    }

    @Test
    void validatesLegacyManifestAgainstAllPinnedFixtureDigests() throws Exception {
        byte[] manifest = resource("/db/legacy-media-runtime-v001-v016/manifest.csv");
        Map<Integer, Ip06FlywayHistoryCandidateReconciler.Expected> parsed =
                Ip06FlywayHistoryCandidateReconciler.parseLegacyManifest(manifest,
                        Ip06FlywayHistoryCandidateReconcilerTest::fixture);
        assertThat(parsed).hasSize(16);
        for (var expected : parsed.values()) {
            assertThat(expected.sourceSha256()).isEqualTo(sha256(fixture(expected.script())));
        }
    }

    @Test
    void rejectsLegacyManifestHeaderFieldCountDuplicateMissingAndFixtureDigestDrift() throws Exception {
        byte[] valid = resource("/db/legacy-media-runtime-v001-v016/manifest.csv");
        String text = new String(valid, StandardCharsets.UTF_8);
        assertManifestInvalid(text.replace(MANIFEST_HEADER, "version,description,checksum,source_sha256"));
        assertManifestInvalid(text.replace("1,media runtime state,2011091060,", "1,media runtime state,2011091060,extra,"));

        String firstRow = text.lines().filter(line -> line.startsWith("1,")).findFirst().orElseThrow();
        assertManifestInvalid(text + firstRow + "\n");
        assertManifestInvalid(text.replaceFirst("(?m)^2,[^\\n]*\\n", ""));
        assertManifestInvalid(text.replaceFirst("(?m)^(1,[^,]*,[^,]*,)[0-9a-f]{64}$", "$1"
                + "0".repeat(64)));
    }

    @Test
    void sourceMismatchOrIncompleteChainHasNonzeroRunStatusButLineageNotesDoNot(@TempDir Path tempDir)
            throws Exception {
        Path cleanInput = tempDir.resolve("ip06-candidate-clean.csv");
        Path incompleteInput = tempDir.resolve("ip06-candidate-incomplete.csv");
        Files.writeString(cleanInput, syntheticHistory(), StandardCharsets.UTF_8);
        Files.writeString(incompleteInput, HEADER + String.join("\n", csvRows().subList(0, 16)) + "\n",
                StandardCharsets.UTF_8);
        java.io.ByteArrayOutputStream output = new java.io.ByteArrayOutputStream();
        try (var stream = new java.io.PrintStream(output, true, StandardCharsets.UTF_8)) {
            assertThat(Ip06FlywayHistoryCandidateReconciler.run(new String[]{cleanInput.toString()}, stream,
                    System.err)).isZero();
            assertThat(Ip06FlywayHistoryCandidateReconciler.run(new String[]{incompleteInput.toString()}, stream,
                    System.err)).isEqualTo(1);
        }
        assertThat(output.toString(StandardCharsets.UTF_8))
                .contains("comparison_status=SOURCE_MATCH")
                .contains("comparison_status=SOURCE_MISMATCH_OR_INCOMPLETE")
                .contains("exit_code=0")
                .contains("exit_code=1")
                .contains("UNVERIFIED_CANDIDATE_PENDING_OPERATOR_PROVENANCE");
    }

    @Test
    void requiresInstalledRankToStartAtOneAndIncreaseWithoutGaps() {
        List<String> rows = csvRows();
        rows.set(0, rows.get(0).replaceFirst("^1,", "2,"));
        var startsLate = Ip06FlywayHistoryCandidateReconciler.reconcile(
                (HEADER + String.join("\n", rows) + "\n").getBytes(StandardCharsets.UTF_8));
        assertThat(startsLate.findings()).anyMatch(f -> f.startsWith("INSTALLED_RANK_GAP_OR_ORDER: expected rank 1, got 2"));
        assertThat(startsLate.exitCode()).isEqualTo(1);

        rows = csvRows();
        rows.set(4, rows.get(4).replaceFirst("^5,", "6,"));
        var hasGap = Ip06FlywayHistoryCandidateReconciler.reconcile(
                (HEADER + String.join("\n", rows) + "\n").getBytes(StandardCharsets.UTF_8));
        assertThat(hasGap.findings()).anyMatch(f -> f.startsWith("INSTALLED_RANK_GAP_OR_ORDER: expected rank 5, got 6"));
        assertThat(hasGap.exitCode()).isEqualTo(1);
    }

    @Test
    void cliReadsSuppliedSyntheticCsvAndWritesOnlyCandidateReport(@TempDir Path tempDir) throws Exception {
        Path input = tempDir.resolve("synthetic-history.csv");
        Files.writeString(input, syntheticHistory(), StandardCharsets.UTF_8);
        PrintStream original = System.out;
        ByteArrayOutputStream captured = new ByteArrayOutputStream();
        try (PrintStream replacement = new PrintStream(captured, true, StandardCharsets.UTF_8)) {
            System.setOut(replacement);
            Ip06FlywayHistoryCandidateReconciler.main(new String[]{input.toString()});
        } finally {
            System.setOut(original);
        }
        assertThat(captured.toString(StandardCharsets.UTF_8))
                .contains("disposition=UNVERIFIED_CANDIDATE_PENDING_OPERATOR_PROVENANCE")
                .contains("supplied_export_sha256=")
                .contains("source_derived_manifest_sha256=")
                .contains("operator provenance, deployed truth, acceptance, writer fencing, and cutover are unverified");
    }

    private static String syntheticHistory() {
        return HEADER + String.join("\n", csvRows()) + "\n";
    }

    private static List<String> csvRows() {
        Map<Integer, Ip06FlywayHistoryCandidateReconciler.Expected> expected =
                Ip06FlywayHistoryCandidateReconciler.expectedMigrations();
        List<String> rows = new ArrayList<>();
        for (int version = 1; version <= 29; version++) {
            var migration = expected.get(version);
            rows.add("%d,%d,%s,%s,%s,%s,test,2026-11-02T00:00:00Z,1,true".formatted(
                    version, version, migration.description(), migration.type(), migration.script(),
                    migration.checksum()));
        }
        return rows;
    }

    private static String currentChecksum(int version) {
        return Ip06FlywayHistoryCandidateReconciler.currentMediaMigrations().get(version).checksum();
    }

    private static String checksum(int version) {
        return Ip06FlywayHistoryCandidateReconciler.expectedMigrations().get(version).checksum();
    }

    private static void assertInvalidCsv(String header, List<String> rows) {
        var report = Ip06FlywayHistoryCandidateReconciler.reconcile(
                (header + String.join("\n", rows) + "\n").getBytes(StandardCharsets.UTF_8));
        assertThat(report.comparisonStatus()).isEqualTo("INVALID_INPUT");
        assertThat(report.exitCode()).isEqualTo(1);
        assertThat(report.findings()).anyMatch(f -> f.startsWith("CSV_INVALID:"));
        assertThat(report.disposition()).isEqualTo("UNVERIFIED_CANDIDATE_PENDING_OPERATOR_PROVENANCE");
    }

    private static void assertManifestInvalid(String text) {
        assertThat(org.assertj.core.api.Assertions.catchThrowable(() ->
                Ip06FlywayHistoryCandidateReconciler.parseLegacyManifest(text.getBytes(StandardCharsets.UTF_8),
                        Ip06FlywayHistoryCandidateReconcilerTest::fixture)))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static byte[] fixture(String script) {
        try { return resource("/db/legacy-media-runtime-v001-v016/" + script); }
        catch (Exception e) { throw new IllegalArgumentException("missing test fixture " + script, e); }
    }

    private static byte[] resource(String path) throws Exception {
        try (var input = Ip06FlywayHistoryCandidateReconcilerTest.class.getResourceAsStream(path)) {
            if (input == null) throw new IllegalStateException("missing resource " + path);
            return input.readAllBytes();
        }
    }

    private static String sha256(byte[] bytes) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
    }
}
