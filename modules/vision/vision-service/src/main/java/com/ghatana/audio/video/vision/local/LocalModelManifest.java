package com.ghatana.audio.video.vision.local;

import tools.jackson.core.StreamReadFeature;
import tools.jackson.core.json.JsonFactory;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.List;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Parsed, strictly validated {@code ghatana-model-manifest.json} that sits next to a local model's
 * weights outside the repository (schema: {@code tools/model-runtimes/schemas/local-model-manifest.schema.json}).
 * The manifest is the only source of the model identity, revision, licence and expected digests; a
 * caller-supplied model hint is never evidence.
 *
 * @doc.type record
 * @doc.purpose Typed local-model manifest
 * @doc.layer product
 * @doc.pattern Value Object
 */
public record LocalModelManifest(
        String modelId,
        String role,
        String sourceUrl,
        String revision,
        String spdxLicense,
        String licenseFilePath,
        List<FileEntry> files,
        String fileSetSha256,
        String ownerDecisionQuote,
        String ownerDecisionDate,
        String runtimeKind,
        String quantization,
        String attribution) {

    public static final String SCHEMA_VERSION = "ghatana.media.local-model-manifest.v1";
    public static final String MANIFEST_FILE = "ghatana-model-manifest.json";
    private static final Pattern SHA256 = Pattern.compile("^[0-9a-f]{64}$");
    private static final Pattern REVISION = Pattern.compile("^[0-9a-f]{40}$");
    private static final Pattern REL_PATH = Pattern.compile("^[A-Za-z0-9._-][A-Za-z0-9._/-]*$");
    private static final Set<String> SPDX = Set.of("MIT", "Apache-2.0");
    private static final long MAX_MANIFEST_BYTES = 256 * 1024;
    private static final ObjectMapper JSON = JsonMapper.builder(JsonFactory.builder()
            .enable(StreamReadFeature.STRICT_DUPLICATE_DETECTION).build()).build();

    /** One file the model needs, with the digest it must have on disk. */
    public record FileEntry(String path, String sha256, long sizeBytes) { }

    /** A manifest that is malformed or internally inconsistent (never an admission by itself). */
    public static final class InvalidManifestException extends IllegalArgumentException {
        public InvalidManifestException(String message) { super(message); }
    }

    public static LocalModelManifest read(Path modelDir) {
        Path file = modelDir.resolve(MANIFEST_FILE);
        try {
            if (!Files.isRegularFile(file) || Files.size(file) > MAX_MANIFEST_BYTES) {
                throw new InvalidManifestException("manifest is missing or too large");
            }
            return parse(new String(Files.readAllBytes(file), StandardCharsets.UTF_8));
        } catch (IOException io) {
            throw new InvalidManifestException("manifest could not be read");
        }
    }

    public static LocalModelManifest parse(String json) {
        final JsonNode root;
        try {
            root = JSON.readTree(json);
        } catch (RuntimeException malformed) {
            throw new InvalidManifestException("manifest is not valid JSON");
        }
        if (root == null || !root.isObject()) throw new InvalidManifestException("manifest must be an object");
        if (!SCHEMA_VERSION.equals(text(root, "schemaVersion"))) {
            throw new InvalidManifestException("unsupported manifest schema version");
        }
        String revision = text(root, "revision");
        if (!REVISION.matcher(revision).matches()) throw new InvalidManifestException("revision must be a 40-hex commit");
        String spdx = text(root, "spdxLicense");
        if (!SPDX.contains(spdx)) throw new InvalidManifestException("licence is not an admitted SPDX id");
        String fileSet = text(root, "fileSetSha256");
        if (!SHA256.matcher(fileSet).matches()) throw new InvalidManifestException("fileSetSha256 is malformed");
        JsonNode filesNode = root.get("files");
        if (filesNode == null || !filesNode.isArray() || filesNode.isEmpty() || filesNode.size() > 256) {
            throw new InvalidManifestException("files must be a non-empty bounded array");
        }
        List<FileEntry> files = new ArrayList<>();
        for (JsonNode node : filesNode) {
            String path = text(node, "path");
            String sha = text(node, "sha256");
            if (!REL_PATH.matcher(path).matches() || path.contains("..") || path.contains("//")
                    || !SHA256.matcher(sha).matches() || !node.has("sizeBytes") || node.get("sizeBytes").asLong(-1) < 0) {
                throw new InvalidManifestException("file entry is malformed");
            }
            files.add(new FileEntry(path, sha, node.get("sizeBytes").asLong()));
        }
        JsonNode license = root.get("licenseFile");
        String licensePath = license == null ? "" : text(license, "path");
        String licenseSha = license == null ? "" : text(license, "sha256");
        FileEntry licenseEntry = files.stream().filter(f -> f.path().equals(licensePath)).findFirst().orElse(null);
        if (licenseEntry == null || !licenseEntry.sha256().equals(licenseSha)) {
            throw new InvalidManifestException("licence file is not an inventoried file with a matching digest");
        }
        JsonNode owner = root.get("ownerDecision");
        if (owner == null) throw new InvalidManifestException("owner decision is missing");
        JsonNode runtime = root.get("runtime");
        if (runtime == null) throw new InvalidManifestException("runtime is missing");
        return new LocalModelManifest(text(root, "modelId"), text(root, "role"), text(root, "sourceUrl"),
                revision, spdx, licensePath, List.copyOf(files), fileSet,
                text(owner, "quote"), text(owner, "decidedOn"), text(runtime, "kind"), text(runtime, "quantization"),
                text(root, "attribution"));
    }

    private static String text(JsonNode node, String field) {
        JsonNode value = node == null ? null : node.get(field);
        if (value == null || !value.isString() || value.asString().isBlank() || value.asString().length() > 4096) {
            throw new InvalidManifestException("manifest field is missing or invalid: " + field);
        }
        return value.asString();
    }
}
