package com.ghatana.media.runtime.localmodel;

import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.InputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Server-owned manifest for one locally installed open model (weights, voices, licence file).
 *
 * <p>The manifest is the only source of a speech profile's artifact identity. A profile derived from it is
 * usable only when {@link #verify(Path, String)} re-hashes every listed file on disk and every digest matches,
 * the SPDX identifier is the one the owner decision allows for the modality, and the verbatim owner decision is
 * recorded. Verification proves artifact identity and licence provenance only; it is NOT an ASR/TTS quality
 * qualification, a rights decision, or a consent decision, and it never grants production eligibility on its
 * own (see {@link Admission#productionEligible()}).</p>
 */
public record LocalModelManifest(
        String schema,
        String modelKey,
        Modality modality,
        String modelId,
        Source source,
        List<FileEntry> files,
        License license,
        OwnerDecision ownerDecision,
        Attribution attribution,
        Admission admission,
        Set<String> verifiedLanguages,
        RuntimeBinding runtime,
        String voiceCloning,
        String fileSetSha256,
        List<LanguageAdmission> languageAdmissions) {

    public static final String SCHEMA = "ghatana.media.local-model-manifest.v1";
    /** Verbatim owner decision given in chat on 2026-11-14; manifests must carry exactly this text. */
    public static final String OWNER_DECISION_DATE = "2026-11-14";
    public static final String OWNER_DECISION_QUOTE =
            "Local open models (Recommended): Whisper large-v3-turbo via whisper.cpp for speech-to-text (MIT). "
                    + "Kokoro-82M for text-to-speech (Apache-2.0, no voice cloning). Florence-2 for vision (MIT). "
                    + "Qwen2.5-VL-7B for multimodal (Apache-2.0). Media stays on this machine, with no per-use cost.";
    public static final String OWNER_LICENSE_STATEMENT = "we will abide by all license requirements.";
    /** Date of the Spanish DEV_ONLY speech-lane admission by the Media owner delegate (quoted verbatim below). */
    public static final String SPANISH_ADMISSION_DATE = "2026-11-15";
    /**
     * Verbatim owner decision (Media owner delegate, 2026-11-15) that admits Spanish for the DEV_ONLY speech lanes. Any
     * verified language other than English must carry it plus the digest of the measured round-trip evidence.
     */
    public static final String SPANISH_ADMISSION_QUOTE =
            "Admit Spanish (es) for the DEV_ONLY speech lanes only, using the already-installed Kokoro-82M Spanish "
                    + "stock voices (same Apache-2.0 model licence) and Whisper large-v3-turbo (MIT, multilingual), with "
                    + "machine translation by the already-admitted local Qwen2.5-VL-7B-Instruct (Apache-2.0) in "
                    + "text-only mode. Admission is gated on measured round-trip evidence recorded in the manifest; it "
                    + "is not a quality qualification and productionEligible stays false.";
    /** Manifest file name used by the {@link #parseDirectoryManifest directory layout} (vision / multimodal). */
    public static final String DIRECTORY_MANIFEST_FILE = "ghatana-model-manifest.json";
    private static final java.util.regex.Pattern REVISION_40_HEX = java.util.regex.Pattern.compile("^[0-9a-f]{40}$");
    private static final java.util.regex.Pattern DIRECTORY_REL_PATH =
            java.util.regex.Pattern.compile("^[A-Za-z0-9._-][A-Za-z0-9._/-]*$");
    private static final java.util.regex.Pattern WEIGHT_FILE =
            java.util.regex.Pattern.compile(".*\\.(safetensors|bin|pth|pt|gguf|onnx)$");
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();
    private static final long MAX_MANIFEST_BYTES = 256 * 1024;

    public enum Modality {
        SPEECH_TO_TEXT("MIT"), TEXT_TO_SPEECH("Apache-2.0"), VISION("MIT"), MULTIMODAL_QA("Apache-2.0");
        private final String allowedSpdx;
        Modality(String allowedSpdx) { this.allowedSpdx = allowedSpdx; }
        public String allowedSpdx() { return allowedSpdx; }
    }

    public enum FileRole { WEIGHTS, CONFIG, VOICE, LICENSE, MODEL_CARD }

    public record Source(String url, String revision) { }

    public record FileEntry(FileRole role, String path, String sha256, long sizeBytes) { }

    public record License(String spdx, String licenseSourceUrl, String verifiedOn) { }

    public record OwnerDecision(String date, String quote, String licenseStatement) { }

    public record Attribution(boolean noticeRequired, String notice) { }

    /** Admission switches. {@code productionEligible} stays false until real quality evidence exists. */
    public record Admission(String scope, boolean productionEligible) { }

    /**
     * Optional runtime pin; an executable digest, when present, is enforced. {@code workerSha256} optionally pins the persistent worker script (empty when the runtime has none); an older
     * manifest without it stays valid and simply offers no worker.
     */
    public record RuntimeBinding(String name, String version, String revision, String executableSha256,
                                 String workerSha256, Set<String> additionalWorkerSha256) {
        public RuntimeBinding {
            additionalWorkerSha256 = additionalWorkerSha256 == null ? Set.of() : Set.copyOf(additionalWorkerSha256);
        }

        public RuntimeBinding(String name, String version, String revision, String executableSha256,
                              String workerSha256) {
            this(name, version, revision, executableSha256, workerSha256, Set.of());
        }

        public RuntimeBinding(String name, String version, String revision, String executableSha256) {
            this(name, version, revision, executableSha256, "", Set.of());
        }

        /** True when {@code digest} is the pinned worker digest or one of the additionally accepted ones. */
        public boolean acceptsWorkerSha256(String digest) {
            return !workerSha256.isEmpty() && (workerSha256.equals(digest) || additionalWorkerSha256.contains(digest));
        }
    }

    /**
     * A non-English language admitted for the DEV_ONLY speech lanes: the verbatim owner decision and the SHA-256 of the
     * checked-in measured round-trip evidence file. It records that the language was measured and admitted; it is not a
     * quality qualification.
     */
    public record LanguageAdmission(String language, String ownerDecisionDate, String ownerDecisionQuote,
                                    String evidencePath, String evidenceSha256) { }

    public enum Status { VERIFIED, MANIFEST_INVALID, FILE_MISSING, DIGEST_MISMATCH, SIZE_MISMATCH,
        LICENSE_NOT_ALLOWED, OWNER_DECISION_MISMATCH }

    /** Outcome of re-hashing the files listed by the manifest. Non-VERIFIED outcomes carry no paths. */
    public record Verification(Status status, String detail, String manifestSha256, Map<String, Path> paths) {
        public boolean verified() { return status == Status.VERIFIED; }
        public Path path(String relativePath) {
            Path found = paths.get(relativePath);
            if (found == null) throw new IllegalStateException("file is not part of the verified manifest");
            return found;
        }
    }

    public LocalModelManifest {
        files = List.copyOf(files);
        verifiedLanguages = Set.copyOf(verifiedLanguages);
        languageAdmissions = languageAdmissions == null ? List.of() : List.copyOf(languageAdmissions);
    }

    public static LocalModelManifest read(Path manifestFile) throws IOException {
        return parse(readBounded(manifestFile));
    }

    public static String manifestSha256(Path manifestFile) throws IOException {
        return hex(digest(readBounded(manifestFile)));
    }

    private static byte[] readBounded(Path file) throws IOException {
        if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_MANIFEST_BYTES) {
            throw new IOException("manifest must be a regular file of at most " + MAX_MANIFEST_BYTES + " bytes");
        }
        return Files.readAllBytes(file);
    }

    /** Strict parse; any structural problem is an {@link IllegalArgumentException}. */
    public static LocalModelManifest parse(byte[] json) {
        final JsonNode root;
        try {
            root = JSON.readTree(json);
        } catch (RuntimeException invalid) {
            throw new IllegalArgumentException("manifest is not valid JSON");
        }
        if (root == null || !root.isObject()) throw new IllegalArgumentException("manifest must be a JSON object");
        if (!SCHEMA.equals(text(root, "schema"))) throw new IllegalArgumentException("unsupported manifest schema");
        Modality modality;
        try {
            modality = Modality.valueOf(text(root, "modality"));
        } catch (IllegalArgumentException unknown) {
            throw new IllegalArgumentException("modality must be one of " + java.util.Arrays.toString(Modality.values()));
        }
        JsonNode source = object(root, "source");
        JsonNode license = object(root, "license");
        JsonNode owner = object(root, "ownerDecision");
        JsonNode attribution = object(root, "attribution");
        JsonNode admission = object(root, "admission");
        List<FileEntry> files = new ArrayList<>();
        JsonNode fileNodes = root.get("files");
        if (fileNodes == null || !fileNodes.isArray() || fileNodes.isEmpty() || fileNodes.size() > 64) {
            throw new IllegalArgumentException("files must list 1-64 entries");
        }
        Set<String> seen = new LinkedHashSet<>();
        for (JsonNode node : fileNodes) {
            String path = text(node, "path");
            if (!path.matches("[A-Za-z0-9][A-Za-z0-9._-]*(/[A-Za-z0-9][A-Za-z0-9._-]*)*") || !seen.add(path)) {
                throw new IllegalArgumentException("file path must be a unique relative path without traversal");
            }
            String sha = text(node, "sha256");
            if (!sha.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("sha256 must be lowercase hex");
            long size = node.path("sizeBytes").asLong(-1);
            if (size < 1) throw new IllegalArgumentException("sizeBytes must be positive");
            FileRole role;
            try {
                role = FileRole.valueOf(text(node, "role"));
            } catch (IllegalArgumentException unknown) {
                throw new IllegalArgumentException("unknown file role");
            }
            files.add(new FileEntry(role, path, sha, size));
        }
        Set<String> languages = new LinkedHashSet<>();
        JsonNode langNodes = root.get("verifiedLanguages");
        if (langNodes != null && langNodes.isArray()) {
            for (JsonNode lang : langNodes) {
                String tag = lang.asString("");
                if (!tag.matches("[a-z]{2,3}")) throw new IllegalArgumentException("language tags are 2-3 letters");
                languages.add(tag);
            }
        }
        List<LanguageAdmission> admissions = new ArrayList<>();
        JsonNode admissionNodes = root.get("languageAdmissions");
        if (admissionNodes != null && admissionNodes.isArray()) {
            for (JsonNode node : admissionNodes) {
                String language = text(node, "language");
                String evidenceSha = text(node, "evidenceSha256");
                if (!language.matches("[a-z]{2,3}") || !evidenceSha.matches("[0-9a-f]{64}")) {
                    throw new IllegalArgumentException("language admission is malformed");
                }
                admissions.add(new LanguageAdmission(language, text(node, "ownerDecisionDate"),
                        text(node, "ownerDecisionQuote"), text(node, "evidencePath"), evidenceSha));
            }
        }
        JsonNode runtimeNode = root.get("runtime");
        Set<String> additionalWorkers = new LinkedHashSet<>();
        if (runtimeNode != null && runtimeNode.path("additionalWorkerSha256").isArray()) {
            for (JsonNode digest : runtimeNode.path("additionalWorkerSha256")) {
                if (!digest.asString("").matches("[0-9a-f]{64}")) {
                    throw new IllegalArgumentException("runtime.additionalWorkerSha256 must be lowercase hex");
                }
                additionalWorkers.add(digest.asString());
            }
        }
        RuntimeBinding runtime = runtimeNode == null || !runtimeNode.isObject() ? null
                : new RuntimeBinding(text(runtimeNode, "name"), text(runtimeNode, "version"),
                        runtimeNode.path("revision").asString(""), runtimeNode.path("executableSha256").asString(""),
                        runtimeNode.path("workerSha256").asString(""), additionalWorkers);
        if (runtime != null && !runtime.executableSha256().isEmpty()
                && !runtime.executableSha256().matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("runtime.executableSha256 must be lowercase hex");
        }
        if (runtime != null && !runtime.workerSha256().isEmpty() && !runtime.workerSha256().matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("runtime.workerSha256 must be lowercase hex");
        }
        return new LocalModelManifest(SCHEMA, text(root, "modelKey"), modality, text(root, "modelId"),
                new Source(text(source, "url"), text(source, "revision")), files,
                new License(text(license, "spdx"), text(license, "licenseSourceUrl"), text(license, "verifiedOn")),
                new OwnerDecision(text(owner, "date"), text(owner, "quote"), text(owner, "licenseStatement")),
                new Attribution(attribution.path("noticeRequired").asBoolean(false),
                        attribution.path("notice").asString("")),
                new Admission(text(admission, "scope"), admission.path("productionEligible").asBoolean(false)),
                languages, runtime, root.path("voiceCloning").asString(""), "", admissions);
    }

    /** Reads {@code <modelDir>/ghatana-model-manifest.json} (the vision / multimodal directory layout). */
    public static LocalModelManifest readDirectory(Path modelDir) {
        Path file = modelDir.resolve(DIRECTORY_MANIFEST_FILE);
        try {
            return parseDirectoryManifest(readBounded(file));
        } catch (IOException unreadable) {
            throw new IllegalArgumentException("manifest is missing, not a regular file or too large");
        }
    }

    /**
     * Strict parse of the directory layout written by {@code tools/model-runtimes/vision/make_manifest.py}
     * ({@code schemaVersion}, {@code role}, {@code spdxLicense}, {@code licenseFile}, {@code fileSetSha256}). The result
     * is the same record as the speech layout, so every consumer applies the identical digest, SPDX and owner-decision
     * checks in {@link #verify}. The weights role is derived from the file extension; the licence file must be an
     * inventoried file with a matching digest.
     */
    public static LocalModelManifest parseDirectoryManifest(byte[] json) {
        final JsonNode root;
        try {
            root = JSON.readTree(json);
        } catch (RuntimeException malformed) {
            throw new IllegalArgumentException("manifest is not valid JSON");
        }
        if (root == null || !root.isObject()) throw new IllegalArgumentException("manifest must be an object");
        if (!SCHEMA.equals(text(root, "schemaVersion"))) {
            throw new IllegalArgumentException("unsupported manifest schema version");
        }
        Modality modality;
        switch (text(root, "role")) {
            case "VISION" -> modality = Modality.VISION;
            case "MULTIMODAL_QA" -> modality = Modality.MULTIMODAL_QA;
            default -> throw new IllegalArgumentException("role must be VISION or MULTIMODAL_QA");
        }
        String revision = text(root, "revision");
        if (!REVISION_40_HEX.matcher(revision).matches()) {
            throw new IllegalArgumentException("revision must be a 40-hex commit");
        }
        String spdx = text(root, "spdxLicense");
        if (!java.util.Set.of("MIT", "Apache-2.0").contains(spdx)) {
            throw new IllegalArgumentException("licence is not an admitted SPDX id");
        }
        String fileSet = text(root, "fileSetSha256");
        if (!fileSet.matches("[0-9a-f]{64}")) throw new IllegalArgumentException("fileSetSha256 is malformed");
        JsonNode filesNode = root.get("files");
        if (filesNode == null || !filesNode.isArray() || filesNode.isEmpty() || filesNode.size() > 256) {
            throw new IllegalArgumentException("files must be a non-empty bounded array");
        }
        JsonNode licenseNode = root.get("licenseFile");
        String licensePath = licenseNode == null ? "" : text(licenseNode, "path");
        String licenseSha = licenseNode == null ? "" : text(licenseNode, "sha256");
        List<FileEntry> entries = new ArrayList<>();
        Set<String> seen = new LinkedHashSet<>();
        boolean licenseInventoried = false;
        for (JsonNode node : filesNode) {
            String path = text(node, "path");
            String sha = text(node, "sha256");
            if (!DIRECTORY_REL_PATH.matcher(path).matches() || path.contains("..") || path.contains("//")
                    || !sha.matches("[0-9a-f]{64}") || !node.has("sizeBytes") || node.get("sizeBytes").asLong(-1) < 0
                    || !seen.add(path)) {
                throw new IllegalArgumentException("file entry is malformed");
            }
            FileRole role;
            if (path.equals(licensePath)) {
                if (!sha.equals(licenseSha)) {
                    throw new IllegalArgumentException(
                            "licence file is not an inventoried file with a matching digest");
                }
                role = FileRole.LICENSE;
                licenseInventoried = true;
            } else {
                role = WEIGHT_FILE.matcher(path).matches() ? FileRole.WEIGHTS : FileRole.CONFIG;
            }
            entries.add(new FileEntry(role, path, sha, node.get("sizeBytes").asLong()));
        }
        if (!licenseInventoried) {
            throw new IllegalArgumentException("licence file is not an inventoried file with a matching digest");
        }
        JsonNode owner = object(root, "ownerDecision");
        JsonNode runtime = object(root, "runtime");
        String sourceUrl = text(root, "sourceUrl");
        return new LocalModelManifest(SCHEMA, text(root, "modelId"), modality, text(root, "modelId"),
                new Source(sourceUrl, revision), entries,
                new License(spdx, licenseNode.path("source").asString(sourceUrl), ""),
                new OwnerDecision(text(owner, "decidedOn"), text(owner, "quote"), text(owner, "licenseNote")),
                new Attribution(true, text(root, "attribution")),
                new Admission("LOCAL_ARTIFACT_IDENTITY_AND_LICENSE_ONLY", false), Set.of(),
                new RuntimeBinding(text(runtime, "kind"), text(runtime, "quantization"), "", ""), "", fileSet, List.of());
    }

    /**
     * Re-hashes every listed file under {@code modelRoot}. Symlinks are refused so the verified bytes are the
     * bytes later read. Returns a typed non-VERIFIED outcome instead of throwing for a mismatch.
     */
    public Verification verify(Path modelRoot, String manifestSha256) {
        Objects.requireNonNull(modelRoot, "modelRoot");
        if (!modality.allowedSpdx().equals(license.spdx())) {
            return fail(Status.LICENSE_NOT_ALLOWED, "licence " + license.spdx() + " is not the owner-approved "
                    + modality.allowedSpdx(), manifestSha256);
        }
        if (!OWNER_DECISION_DATE.equals(ownerDecision.date()) || !OWNER_DECISION_QUOTE.equals(ownerDecision.quote())
                || !OWNER_LICENSE_STATEMENT.equals(ownerDecision.licenseStatement())) {
            return fail(Status.OWNER_DECISION_MISMATCH, "owner decision text/date does not match the record",
                    manifestSha256);
        }
        for (String language : verifiedLanguages) {
            if ("en".equals(language)) continue;
            LanguageAdmission admission = languageAdmissions.stream()
                    .filter(candidate -> candidate.language().equals(language)).findFirst().orElse(null);
            if (admission == null) {
                return fail(Status.MANIFEST_INVALID, "language " + language
                        + " is verified without a recorded owner admission and evidence digest", manifestSha256);
            }
            if (!SPANISH_ADMISSION_DATE.equals(admission.ownerDecisionDate())
                    || !SPANISH_ADMISSION_QUOTE.equals(admission.ownerDecisionQuote())) {
                return fail(Status.OWNER_DECISION_MISMATCH, "language " + language
                        + " admission text/date does not match the record", manifestSha256);
            }
        }
        if (files.stream().noneMatch(f -> f.role() == FileRole.WEIGHTS)
                || files.stream().noneMatch(f -> f.role() == FileRole.LICENSE)) {
            return fail(Status.MANIFEST_INVALID, "manifest needs WEIGHTS and LICENSE entries", manifestSha256);
        }
        Path root = modelRoot.toAbsolutePath().normalize();
        Map<String, Path> verified = new LinkedHashMap<>();
        for (FileEntry entry : files) {
            Path file = root.resolve(entry.path()).normalize();
            if (!file.startsWith(root) || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
                return fail(Status.FILE_MISSING, "missing file " + entry.path(), manifestSha256);
            }
            try {
                if (Files.size(file) != entry.sizeBytes()) {
                    return fail(Status.SIZE_MISMATCH, "size mismatch for " + entry.path(), manifestSha256);
                }
                if (!entry.sha256().equals(FileDigestCache.shared().sha256(file))) {
                    return fail(Status.DIGEST_MISMATCH, "digest mismatch for " + entry.path(), manifestSha256);
                }
            } catch (IOException unreadable) {
                return fail(Status.FILE_MISSING, "unreadable file " + entry.path(), manifestSha256);
            }
            verified.put(entry.path(), file);
        }
        return new Verification(Status.VERIFIED, "all " + files.size() + " files match", manifestSha256,
                Map.copyOf(verified));
    }

    /** SHA-256 over the weights/config/voice digests in manifest order; stable identity of the profile config. */
    public String configurationDigest(String decodingConfiguration) {
        StringBuilder canonical = new StringBuilder("local-model-profile-v1\n").append(modelKey).append('\n')
                .append(source.revision()).append('\n').append(decodingConfiguration).append('\n');
        for (FileEntry entry : files) canonical.append(entry.role()).append(':').append(entry.path())
                .append(':').append(entry.sha256()).append('\n');
        return hex(digest(canonical.toString().getBytes(StandardCharsets.UTF_8)));
    }

    public FileEntry first(FileRole role) {
        return files.stream().filter(f -> f.role() == role).findFirst()
                .orElseThrow(() -> new IllegalStateException("manifest has no " + role + " entry"));
    }

    private static Verification fail(Status status, String detail, String manifestSha256) {
        return new Verification(status, detail, manifestSha256, Map.of());
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node == null ? null : node.get(field);
        if (value == null || !value.isString() || value.asString().isBlank() || value.asString().length() > 4096) {
            throw new IllegalArgumentException("manifest field '" + field + "' is required");
        }
        return value.asString();
    }

    private static JsonNode object(JsonNode node, String field) {
        JsonNode value = node.get(field);
        if (value == null || !value.isObject()) throw new IllegalArgumentException(field + " must be an object");
        return value;
    }

    public static String sha256(Path file) throws IOException {
        MessageDigest digest = newDigest();
        try (InputStream in = Files.newInputStream(file, LinkOption.NOFOLLOW_LINKS)) {
            byte[] buffer = new byte[1 << 20];
            int read;
            while ((read = in.read(buffer)) >= 0) digest.update(buffer, 0, read);
        }
        return hex(digest.digest());
    }

    private static byte[] digest(byte[] value) { return newDigest().digest(value); }
    private static String hex(byte[] value) { return HexFormat.of().formatHex(value); }
    private static MessageDigest newDigest() {
        try { return MessageDigest.getInstance("SHA-256"); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
}
