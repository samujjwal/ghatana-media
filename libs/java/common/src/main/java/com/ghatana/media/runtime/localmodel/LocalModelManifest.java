package com.ghatana.media.runtime.localmodel;

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
        String voiceCloning) {

    public static final String SCHEMA = "ghatana.media.local-model-manifest.v1";
    /** Verbatim owner decision given in chat on 2026-11-14; manifests must carry exactly this text. */
    public static final String OWNER_DECISION_DATE = "2026-11-14";
    public static final String OWNER_DECISION_QUOTE =
            "Local open models (Recommended): Whisper large-v3-turbo via whisper.cpp for speech-to-text (MIT). "
                    + "Kokoro-82M for text-to-speech (Apache-2.0, no voice cloning). Florence-2 for vision (MIT). "
                    + "Qwen2.5-VL-7B for multimodal (Apache-2.0). Media stays on this machine, with no per-use cost.";
    public static final String OWNER_LICENSE_STATEMENT = "we will abide by all license requirements.";
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final long MAX_MANIFEST_BYTES = 256 * 1024;

    public enum Modality {
        SPEECH_TO_TEXT("MIT"), TEXT_TO_SPEECH("Apache-2.0");
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

    /** Optional runtime pin; an executable digest, when present, is enforced. */
    public record RuntimeBinding(String name, String version, String revision, String executableSha256) { }

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
            throw new IllegalArgumentException("modality must be SPEECH_TO_TEXT or TEXT_TO_SPEECH");
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
        JsonNode runtimeNode = root.get("runtime");
        RuntimeBinding runtime = runtimeNode == null || !runtimeNode.isObject() ? null
                : new RuntimeBinding(text(runtimeNode, "name"), text(runtimeNode, "version"),
                        runtimeNode.path("revision").asString(""), runtimeNode.path("executableSha256").asString(""));
        if (runtime != null && !runtime.executableSha256().isEmpty()
                && !runtime.executableSha256().matches("[0-9a-f]{64}")) {
            throw new IllegalArgumentException("runtime.executableSha256 must be lowercase hex");
        }
        return new LocalModelManifest(SCHEMA, text(root, "modelKey"), modality, text(root, "modelId"),
                new Source(text(source, "url"), text(source, "revision")), files,
                new License(text(license, "spdx"), text(license, "licenseSourceUrl"), text(license, "verifiedOn")),
                new OwnerDecision(text(owner, "date"), text(owner, "quote"), text(owner, "licenseStatement")),
                new Attribution(attribution.path("noticeRequired").asBoolean(false),
                        attribution.path("notice").asString("")),
                new Admission(text(admission, "scope"), admission.path("productionEligible").asBoolean(false)),
                languages, runtime, root.path("voiceCloning").asString(""));
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
                if (!entry.sha256().equals(sha256(file))) {
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
