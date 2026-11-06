package com.ghatana.media.provider.aws;

import org.flywaydb.core.Flyway;
import org.flywaydb.core.api.MigrationInfo;
import org.flywaydb.core.api.MigrationVersion;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.charset.CharacterCodingException;
import java.nio.charset.CodingErrorAction;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Instant;
import java.time.LocalDateTime;
import java.time.OffsetDateTime;
import java.time.format.DateTimeFormatter;
import java.time.format.DateTimeParseException;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;

/**
 * Read-only candidate analysis of a supplied Flyway CSV export. Expected V001-V016 values
 * come from the source-pinned legacy manifest; V017-V029 and V031-V033 are resolved by Flyway from the
 * checked-in canonical Media migration resources. V030 remains a separately scoped test migration.
 * The in-memory H2 connection is used only
 * by Flyway's info resolver and is never migrated or persisted.
 *
 * <p>Run through {@code scripts/ip06/reconcile-flyway-history.sh}. Output is always
 * {@code UNVERIFIED_CANDIDATE_PENDING_OPERATOR_PROVENANCE}; this utility cannot establish
 * deployed history, writer identity/fencing, acceptance, or cutover authority.</p>
 */
public final class Ip06FlywayHistoryCandidateReconciler {
    static final String DISPOSITION = "UNVERIFIED_CANDIDATE_PENDING_OPERATOR_PROVENANCE";
    private static final String LEGACY_MANIFEST =
            "/db/legacy-media-runtime-v001-v016/manifest.csv";
    private static final String LEGACY_FIXTURE_DIRECTORY = "/db/legacy-media-runtime-v001-v016/";
    private static final String MEDIA_LOCATION = "classpath:db/media-runtime";
    private static final int MAX_EXPORT_BYTES = 2 * 1024 * 1024;
    private static final List<String> EXPORT_HEADER = List.of("installed_rank", "version", "description", "type",
            "script", "checksum", "installed_by", "installed_on", "execution_time", "success");
    private static final List<String> LEGACY_HEADER =
            List.of("version", "description", "flyway_checksum", "source_sha256");

    private Ip06FlywayHistoryCandidateReconciler() { }

    public static void main(String[] args) throws Exception {
        int exitCode = run(args, System.out, System.err);
        if (exitCode != 0) System.exit(exitCode);
    }

    static int run(String[] args, java.io.PrintStream out, java.io.PrintStream err) throws IOException {
        if (args.length != 1) {
            err.println("Usage: reconcile-flyway-history.sh <operator-supplied-flyway-history.csv>");
            return 2;
        }
        Report report = reconcile(Path.of(args[0]));
        out.println(report.asText());
        return report.exitCode();
    }

    static Report reconcile(Path export) throws IOException {
        byte[] bytes = readBounded(export);
        if (bytes.length > MAX_EXPORT_BYTES) return tooLargeExportReport();
        return reconcile(bytes);
    }

    static Report reconcile(byte[] exportBytes) {
        String exportText;
        try {
            if (exportBytes.length > MAX_EXPORT_BYTES) {
                return tooLargeExportReport();
            }
            exportText = decodeUtf8(exportBytes);
        } catch (IllegalArgumentException e) {
            return invalidExport(exportBytes, e.getMessage());
        }
        List<String> findings = new ArrayList<>();
        List<Row> supplied;
        try {
            supplied = parseCsv(exportText);
        } catch (IllegalArgumentException e) {
            return invalidExport(exportBytes, "CSV_INVALID: " + e.getMessage());
        }

        Map<Integer, Expected> expected;
        try {
            expected = expectedMigrations();
        } catch (RuntimeException e) {
            return new Report(DISPOSITION, sha256(exportBytes), "UNAVAILABLE", "SOURCE_INVALID",
                    List.of("SOURCE_MANIFEST_INVALID: " + safeMessage(e)));
        }
        Map<Integer, Expected> currentMedia = currentMediaMigrations();
        Map<Integer, List<Row>> byVersion = new TreeMap<>();
        int priorRank = 0;
        int priorVersion = Integer.MIN_VALUE;
        for (Row row : supplied) {
            byVersion.computeIfAbsent(row.version(), ignored -> new ArrayList<>()).add(row);
            if (row.installedRank() != priorRank + 1) {
                findings.add("INSTALLED_RANK_GAP_OR_ORDER: expected rank %d, got %d at V%03d"
                        .formatted(priorRank + 1, row.installedRank(), row.version()));
            }
            if (row.installedRank() <= priorRank) {
                findings.add("OUT_OF_ORDER_INSTALLED_RANK: version V%03d has rank %d after rank %d"
                        .formatted(row.version(), row.installedRank(), priorRank));
            }
            priorRank = row.installedRank();
            if (row.version() <= priorVersion) {
                findings.add("OUT_OF_ORDER_VERSION: V%03d occurs after V%03d in installed-rank order"
                        .formatted(row.version(), priorVersion));
            }
            priorVersion = row.version();
            if (!row.success()) {
                findings.add("FAILED_HISTORY_ROW: V%03d success=false".formatted(row.version()));
            }
        }

        for (Map.Entry<Integer, List<Row>> entry : byVersion.entrySet()) {
            if (entry.getValue().size() > 1) {
                findings.add("DUPLICATE_VERSION: V%03d occurs %d times"
                        .formatted(entry.getKey(), entry.getValue().size()));
            }
        }
        for (int version : expected.keySet()) {
            Expected source = expected.get(version);
            if (source == null) {
                findings.add("EXPECTED_SOURCE_MISSING: V%03d has no canonical source mapping"
                        .formatted(version));
                continue;
            }
            List<Row> rows = byVersion.getOrDefault(version, List.of());
            if (rows.isEmpty()) {
                findings.add("MISSING_VERSION: V%03d".formatted(version));
                continue;
            }
            for (Row row : rows) {
                compare(row, source, findings);
                if (version >= 7 && version <= 9) {
                    Expected current = currentMedia.get(version);
                    if (current != null && (!source.script().equals(current.script())
                            || !source.description().equals(current.description())
                            || !source.checksum().equals(current.checksum()))) {
                        findings.add("LINEAGE_DISTINCTION: V%03d expected legacy source %s checksum %s; "
                                        .formatted(version, source.script(), source.checksum())
                                + "current Media source is %s checksum %s"
                                        .formatted(current.script(), current.checksum()));
                    }
                }
            }
        }
        for (Integer version : byVersion.keySet()) {
            if (!expected.containsKey(version)) {
                findings.add("UNEXPECTED_VERSION: V%03d outside expected V001-V029/V031-V033 chain".formatted(version));
            }
        }
        if (supplied.isEmpty()) {
            findings.add("NO_HISTORY_ROWS: CSV contains no versioned history rows");
        }
        String status = findings.stream().allMatch(f -> f.startsWith("LINEAGE_DISTINCTION:"))
                ? "SOURCE_MATCH" : "SOURCE_MISMATCH_OR_INCOMPLETE";
        return new Report(DISPOSITION, sha256(exportBytes), expectedManifestHash(expected), status,
                List.copyOf(findings));
    }

    private static Report invalidExport(byte[] exportBytes, String reason) {
        String manifestHash;
        try { manifestHash = expectedManifestHash(expectedMigrations()); }
        catch (RuntimeException e) { manifestHash = "UNAVAILABLE"; }
        return new Report(DISPOSITION, sha256(exportBytes), manifestHash, "INVALID_INPUT", List.of(reason));
    }

    private static byte[] readBounded(Path path) throws IOException {
        try (InputStream input = Files.newInputStream(path)) {
            // One byte beyond the cap distinguishes an exact-size file from an oversized file.
            return input.readNBytes(MAX_EXPORT_BYTES + 1);
        }
    }

    private static Report tooLargeExportReport() {
        String manifestHash;
        try { manifestHash = expectedManifestHash(expectedMigrations()); }
        catch (RuntimeException e) { manifestHash = "UNAVAILABLE"; }
        return new Report(DISPOSITION, "UNAVAILABLE_NOT_COMPUTED", manifestHash, "INVALID_INPUT",
                List.of("CSV_TOO_LARGE: maximum input size is " + MAX_EXPORT_BYTES + " bytes"));
    }

    private static void compare(Row row, Expected expected, List<String> findings) {
        String version = "V%03d".formatted(row.version());
        if (!expected.script().equals(row.script())) {
            findings.add("SCRIPT_MISMATCH: %s expected %s, got %s".formatted(version,
                    expected.script(), row.script()));
        }
        if (!expected.type().equals(row.type())) {
            findings.add("TYPE_MISMATCH: %s expected %s, got %s".formatted(version,
                    expected.type(), row.type()));
        }
        if (!expected.checksum().equals(row.checksum())) {
            findings.add("CHECKSUM_MISMATCH: %s expected %s, got %s".formatted(version,
                    expected.checksum(), row.checksum()));
        }
        if (!expected.description().equals(row.description())) {
            findings.add("DESCRIPTION_MISMATCH: %s expected %s, got %s".formatted(version,
                    expected.description(), row.description()));
        }
    }

    static Map<Integer, Expected> expectedMigrations() {
        Map<Integer, Expected> result = readLegacyManifest();
        currentMediaMigrations().forEach((version, migration) -> {
            if ((version >= 17 && version <= 29) || (version >= 31 && version <= 33)) result.put(version, migration);
        });
        return result;
    }

    private static Map<Integer, Expected> readLegacyManifest() {
        try (var stream = Ip06FlywayHistoryCandidateReconciler.class.getResourceAsStream(LEGACY_MANIFEST)) {
            if (stream == null) throw new IllegalStateException("Missing source-pinned legacy manifest");
            return parseLegacyManifest(stream.readAllBytes(), Ip06FlywayHistoryCandidateReconciler::readLegacyFixture);
        } catch (IOException | RuntimeException e) {
            throw new IllegalStateException("Cannot load pinned V001-V016 legacy manifest", e);
        }
    }

    static Map<Integer, Expected> parseLegacyManifest(byte[] bytes,
                                                       java.util.function.Function<String, byte[]> fixtureReader) {
        final String contents;
        try { contents = decodeUtf8(bytes); }
        catch (IllegalArgumentException e) { throw new IllegalArgumentException("manifest is not valid UTF-8", e); }
        List<List<String>> records = parseRecords(contents).stream()
                .filter(row -> !row.isEmpty() && !row.getFirst().stripLeading().startsWith("#"))
                .filter(row -> !(row.size() == 1 && row.getFirst().isBlank()))
                .toList();
        if (records.isEmpty() || !records.getFirst().equals(LEGACY_HEADER)) {
            throw new IllegalArgumentException("manifest header must exactly be " + String.join(",", LEGACY_HEADER));
        }
        Map<Integer, Expected> result = new LinkedHashMap<>();
        for (int index = 1; index < records.size(); index++) {
            List<String> fields = records.get(index);
            if (fields.size() != LEGACY_HEADER.size()) {
                throw new IllegalArgumentException("manifest record " + (index + 1)
                        + " must have exactly " + LEGACY_HEADER.size() + " fields");
            }
            final int version;
            try { version = Integer.parseInt(fields.get(0)); }
            catch (NumberFormatException e) {
                throw new IllegalArgumentException("manifest record " + (index + 1) + " has invalid version", e);
            }
            if (version != index) {
                throw new IllegalArgumentException("legacy manifest version at row " + (index + 1)
                        + " must be V%03d, got V%03d".formatted(index, version));
            }
            if (version < 1 || version > 16) {
                throw new IllegalArgumentException("legacy manifest version outside V001-V016: " + version);
            }
            if (result.containsKey(version)) {
                throw new IllegalArgumentException("duplicate legacy manifest version V%03d".formatted(version));
            }
            String description = fields.get(1);
            String checksum = fields.get(2);
            String sourceSha256 = fields.get(3);
            if (!checksum.matches("-?[0-9]+")) {
                throw new IllegalArgumentException("invalid Flyway checksum for V%03d".formatted(version));
            }
            if (!sourceSha256.matches("[0-9a-f]{64}")) {
                throw new IllegalArgumentException("invalid source_sha256 for V%03d".formatted(version));
            }
            String script = "V%03d__%s.sql".formatted(version, description.replace(' ', '_'));
            byte[] fixture = fixtureReader.apply(script);
            String actualSourceSha256 = sha256(fixture);
            if (!sourceSha256.equals(actualSourceSha256)) {
                throw new IllegalArgumentException("source_sha256 mismatch for V%03d: manifest=%s fixture=%s"
                        .formatted(version, sourceSha256, actualSourceSha256));
            }
            result.put(version, new Expected(version, description, "SQL", script, checksum,
                    "LEGACY_SOURCE_LINEAGE", sourceSha256));
        }
        if (result.size() != 16) {
            throw new IllegalArgumentException("legacy manifest must contain exactly V001-V016");
        }
        for (int version = 1; version <= 16; version++) {
            if (!result.containsKey(version)) {
                throw new IllegalArgumentException("legacy manifest missing V%03d".formatted(version));
            }
        }
        return result;
    }

    private static byte[] readLegacyFixture(String script) {
        try (var input = Ip06FlywayHistoryCandidateReconciler.class
                .getResourceAsStream(LEGACY_FIXTURE_DIRECTORY + script)) {
            if (input == null) throw new IllegalArgumentException("missing legacy migration fixture " + script);
            return input.readAllBytes();
        } catch (IOException e) {
            throw new IllegalArgumentException("cannot read legacy migration fixture " + script, e);
        }
    }

    static Map<Integer, Expected> currentMediaMigrations() {
        // Flyway.info resolves SQL resources and checksums but does not invoke migrate().
        String jdbcUrl = "jdbc:h2:mem:ip06_candidate_" + java.util.UUID.randomUUID().toString().replace("-", "");
        MigrationInfo[] migrations = Flyway.configure()
                .dataSource(jdbcUrl, "sa", "")
                .locations(MEDIA_LOCATION)
                .validateMigrationNaming(true)
                .load()
                .info()
                .all();
        Map<Integer, Expected> result = new TreeMap<>();
        for (MigrationInfo migration : migrations) {
            MigrationVersion flywayVersion = migration.getVersion();
            if (flywayVersion == null) continue;
            int version = Integer.parseInt(flywayVersion.getVersion());
            if (version > 29 && (version < 31 || version > 33)) continue;
            String script = migration.getScript();
            result.put(version, new Expected(version, migration.getDescription(), String.valueOf(migration.getType()),
                    script, String.valueOf(migration.getChecksum()), "MEDIA_CURRENT_SOURCE",
                    sha256(readMediaMigration(script))));
        }
        return result;
    }

    private static byte[] readMediaMigration(String script) {
        try (var input = Ip06FlywayHistoryCandidateReconciler.class
                .getResourceAsStream("/db/media-runtime/" + script)) {
            if (input == null) throw new IllegalStateException("Missing Media migration source " + script);
            return input.readAllBytes();
        } catch (IOException e) {
            throw new IllegalStateException("Cannot read Media migration source " + script, e);
        }
    }

    private static String expectedManifestHash(Map<Integer, Expected> expected) {
        String canonical = expected.values().stream().sorted(Comparator.comparingInt(Expected::version))
                .map(e -> "%03d|%s|%s|%s|%s|%s|%s".formatted(e.version(), e.description(), e.type(),
                        e.script(), e.checksum(), e.lineage(), e.sourceSha256()))
                .reduce((a, b) -> a + "\n" + b).orElse("");
        return sha256(canonical.getBytes(StandardCharsets.UTF_8));
    }

    private static List<Row> parseCsv(String csv) {
        List<List<String>> records = new ArrayList<>(parseRecords(csv));
        records.removeIf(record -> !record.isEmpty() && record.getFirst().stripLeading().startsWith("#"));
        records.removeIf(record -> record.size() == 1 && record.getFirst().isBlank());
        if (records.isEmpty()) throw new IllegalArgumentException("missing header");
        List<String> headerFields = records.get(0);
        if (!headerFields.equals(EXPORT_HEADER)) {
            Map<String, Integer> counts = new TreeMap<>();
            headerFields.forEach(name -> counts.merge(name, 1, Integer::sum));
            List<String> duplicates = counts.entrySet().stream().filter(entry -> entry.getValue() > 1)
                    .map(Map.Entry::getKey).toList();
            if (!duplicates.isEmpty()) {
                throw new IllegalArgumentException("duplicate header columns " + duplicates);
            }
            List<String> missing = EXPORT_HEADER.stream().filter(name -> !counts.containsKey(name)).toList();
            if (!missing.isEmpty()) throw new IllegalArgumentException("missing header columns " + missing);
            throw new IllegalArgumentException("header must exactly match " + String.join(",", EXPORT_HEADER));
        }
        Map<String, Integer> header = new LinkedHashMap<>();
        for (int i = 0; i < headerFields.size(); i++) header.put(headerFields.get(i), i);
        List<Row> rows = new ArrayList<>();
        for (int index = 1; index < records.size(); index++) {
            List<String> fields = records.get(index);
            if (fields.size() != headerFields.size()) {
                throw new IllegalArgumentException("record " + (index + 1) + " has " + fields.size()
                        + " fields; expected " + headerFields.size());
            }
            String successValue = value(fields, header, "success");
            if (!successValue.equals("true") && !successValue.equals("false")) {
                throw new IllegalArgumentException("record " + (index + 1)
                        + " has invalid success value; expected true or false");
            }
            int rank = integer(fields, header, "installed_rank", index);
            int version = integer(fields, header, "version", index);
            if (rank < 1 || version < 1) {
                throw new IllegalArgumentException("record " + (index + 1)
                        + " installed_rank and version must be positive integers");
            }
            if (value(fields, header, "installed_by").isBlank()) {
                throw new IllegalArgumentException("record " + (index + 1) + " has blank installed_by");
            }
            validateInstalledOn(value(fields, header, "installed_on"), index + 1);
            int executionTime = integer(fields, header, "execution_time", index);
            if (executionTime < 0) {
                throw new IllegalArgumentException("record " + (index + 1)
                        + " execution_time must not be negative");
            }
            rows.add(new Row(rank, version, value(fields, header, "description"),
                    value(fields, header, "type"), value(fields, header, "script"),
                    value(fields, header, "checksum"), successValue.equals("true")));
        }
        return rows;
    }

    private static int integer(List<String> fields, Map<String, Integer> header, String column, int record) {
        try { return Integer.parseInt(value(fields, header, column)); }
        catch (NumberFormatException e) { throw new IllegalArgumentException("record " + (record + 1)
                + " has invalid integer in " + column); }
    }

    private static void validateInstalledOn(String value, int record) {
        if (value.isBlank()) {
            throw new IllegalArgumentException("record " + record + " has blank installed_on");
        }
        try {
            Instant.parse(value);
            return;
        } catch (DateTimeParseException ignored) { }
        try {
            OffsetDateTime.parse(value, DateTimeFormatter.ISO_OFFSET_DATE_TIME);
            return;
        } catch (DateTimeParseException ignored) { }
        // PostgreSQL timestamp output may use a space separator and omit a zone because
        // Flyway's installed_on column is a timestamp without time zone on PostgreSQL.
        String localDateTime = value.indexOf(' ') == 10 ? value.substring(0, 10) + 'T' + value.substring(11) : value;
        try {
            LocalDateTime.parse(localDateTime, DateTimeFormatter.ISO_LOCAL_DATE_TIME);
        } catch (DateTimeParseException invalidTimestamp) {
            throw new IllegalArgumentException("record " + record
                    + " has invalid timestamp in installed_on; expected ISO instant/offset or PostgreSQL local timestamp");
        }
    }

    private static String value(List<String> fields, Map<String, Integer> header, String name) {
        return fields.get(header.get(name)).trim();
    }

    private static List<List<String>> parseRecords(String csv) {
        List<List<String>> records = new ArrayList<>();
        List<String> row = new ArrayList<>();
        StringBuilder field = new StringBuilder();
        boolean quoted = false;
        boolean quoteClosed = false;
        for (int i = 0; i < csv.length(); i++) {
            char c = csv.charAt(i);
            if (quoted) {
                if (c == '"' && i + 1 < csv.length() && csv.charAt(i + 1) == '"') {
                    field.append('"'); i++;
                } else if (c == '"') { quoted = false; quoteClosed = true; }
                else field.append(c);
            } else if (quoteClosed && c != ',' && c != '\n' && c != '\r') {
                throw new IllegalArgumentException("characters after closing quote before field delimiter");
            } else if (c == '"') {
                if (!field.isEmpty()) throw new IllegalArgumentException("quote in unquoted field");
                quoted = true;
            } else if (c == ',') { row.add(field.toString()); field.setLength(0); quoteClosed = false; }
            else if (c == '\n' || c == '\r') {
                if (c == '\r' && i + 1 < csv.length() && csv.charAt(i + 1) == '\n') i++;
                row.add(field.toString()); field.setLength(0);
                records.add(List.copyOf(row)); row.clear(); quoteClosed = false;
            } else field.append(c);
        }
        if (quoted) throw new IllegalArgumentException("unterminated quoted field");
        if (!field.isEmpty() || !row.isEmpty()) { row.add(field.toString()); records.add(List.copyOf(row)); }
        return records;
    }

    private static String decodeUtf8(byte[] bytes) {
        try {
            return StandardCharsets.UTF_8.newDecoder()
                    .onMalformedInput(CodingErrorAction.REPORT)
                    .onUnmappableCharacter(CodingErrorAction.REPORT)
                    .decode(ByteBuffer.wrap(bytes)).toString();
        } catch (CharacterCodingException e) {
            throw new IllegalArgumentException("CSV_INVALID_UTF8: input is not valid UTF-8", e);
        }
    }

    private static String safeMessage(Throwable throwable) {
        String message = throwable.getMessage();
        return message == null ? throwable.getClass().getSimpleName() : message;
    }

    private static String sha256(byte[] bytes) {
        try { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes)); }
        catch (Exception e) { throw new IllegalStateException("SHA-256 unavailable", e); }
    }

    record Expected(int version, String description, String type, String script, String checksum,
                    String lineage, String sourceSha256) { }
    record Row(int installedRank, int version, String description, String type, String script,
               String checksum, boolean success) { }
    record Report(String disposition, String exportSha256, String manifestSha256,
                  String comparisonStatus, List<String> findings) {
        int exitCode() {
            return comparisonStatus.equals("SOURCE_MATCH") ? 0 : 1;
        }

        String asText() {
            StringBuilder out = new StringBuilder();
            out.append("disposition=").append(disposition).append('\n')
                    .append("comparison_status=").append(comparisonStatus).append('\n')
                    .append("supplied_export_sha256=").append(exportSha256).append('\n')
                    .append("source_derived_manifest_sha256=").append(manifestSha256).append('\n')
                    .append("interpretation=Candidate comparison only; operator provenance, deployed truth, acceptance, writer fencing, and cutover are unverified.\n")
                    .append("exit_code=").append(exitCode()).append('\n')
                    .append("finding_count=").append(findings.size()).append('\n');
            findings.forEach(finding -> out.append("finding=").append(finding).append('\n'));
            return out.toString();
        }
    }
}
