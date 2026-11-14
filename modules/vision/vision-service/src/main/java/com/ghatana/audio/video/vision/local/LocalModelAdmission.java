package com.ghatana.audio.video.vision.local;

import java.io.IOException;
import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.HexFormat;
import java.util.List;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;

/**
 * Server-owned admission of one local model directory: the model is {@link State#QUALIFIED} only when
 * its manifest is valid, names the expected model id, role and SPDX licence, and every inventoried
 * file exists as a regular file (no symlink) with the exact size and SHA-256 the manifest pins.
 * Anything else — missing directory, absent or malformed manifest, wrong licence, missing file, size or
 * digest mismatch — is {@link State#NOT_ADMITTED} with a stable reason code and no model is ever
 * dispatched. Digests are recomputed whenever any file's size or modification time changes; an
 * unchanged tree reuses its previous verified result so a request does not rehash gigabytes.
 *
 * @doc.type class
 * @doc.purpose Digest-bound local model qualification
 * @doc.layer product
 * @doc.pattern Policy
 */
public final class LocalModelAdmission {

    public enum State { QUALIFIED, NOT_ADMITTED }

    public static final String NOT_ADMITTED_MANIFEST_MISSING = "MODEL_MANIFEST_MISSING_OR_INVALID";
    public static final String NOT_ADMITTED_IDENTITY = "MODEL_IDENTITY_MISMATCH";
    public static final String NOT_ADMITTED_LICENSE = "MODEL_LICENSE_MISMATCH";
    public static final String NOT_ADMITTED_FILE_MISSING = "MODEL_FILE_MISSING";
    public static final String NOT_ADMITTED_DIGEST = "MODEL_DIGEST_MISMATCH";

    /** Outcome of one admission evaluation. {@code manifest} is present only when it parsed. */
    public record Admission(State state, String reasonCode, LocalModelManifest manifest) {
        public boolean qualified() { return state == State.QUALIFIED; }
    }

    private record Fingerprint(List<String> parts) { }

    private record Cached(Fingerprint fingerprint, Admission admission) { }

    private final Path modelDir;
    private final String expectedModelId;
    private final String expectedRole;
    private final String expectedSpdx;
    private final ConcurrentHashMap<String, Cached> cache = new ConcurrentHashMap<>();

    public LocalModelAdmission(Path modelDir, String expectedModelId, String expectedRole, String expectedSpdx) {
        this.modelDir = Objects.requireNonNull(modelDir, "modelDir").toAbsolutePath().normalize();
        this.expectedModelId = Objects.requireNonNull(expectedModelId, "expectedModelId");
        this.expectedRole = Objects.requireNonNull(expectedRole, "expectedRole");
        this.expectedSpdx = Objects.requireNonNull(expectedSpdx, "expectedSpdx");
    }

    public Path modelDir() { return modelDir; }

    /** Evaluates admission now (cheap when nothing on disk changed since the last full verification). */
    public Admission evaluate() {
        LocalModelManifest manifest;
        try {
            manifest = LocalModelManifest.read(modelDir);
        } catch (LocalModelManifest.InvalidManifestException invalid) {
            return new Admission(State.NOT_ADMITTED, NOT_ADMITTED_MANIFEST_MISSING, null);
        }
        if (!expectedModelId.equals(manifest.modelId()) || !expectedRole.equals(manifest.role())) {
            return new Admission(State.NOT_ADMITTED, NOT_ADMITTED_IDENTITY, manifest);
        }
        if (!expectedSpdx.equals(manifest.spdxLicense())) {
            return new Admission(State.NOT_ADMITTED, NOT_ADMITTED_LICENSE, manifest);
        }
        Fingerprint fingerprint;
        try {
            fingerprint = fingerprint(manifest);
        } catch (IOException | RuntimeException missing) {
            return new Admission(State.NOT_ADMITTED, NOT_ADMITTED_FILE_MISSING, manifest);
        }
        Cached cached = cache.get(manifest.fileSetSha256());
        if (cached != null && cached.fingerprint().equals(fingerprint)) return cached.admission();
        Admission result = verifyDigests(manifest);
        cache.put(manifest.fileSetSha256(), new Cached(fingerprint, result));
        return result;
    }

    private Fingerprint fingerprint(LocalModelManifest manifest) throws IOException {
        List<String> parts = new ArrayList<>();
        parts.add(manifest.fileSetSha256());
        Path manifestFile = modelDir.resolve(LocalModelManifest.MANIFEST_FILE);
        parts.add(Files.size(manifestFile) + ":" + Files.getLastModifiedTime(manifestFile).toMillis());
        for (LocalModelManifest.FileEntry entry : manifest.files()) {
            Path file = resolve(entry);
            parts.add(entry.path() + ":" + Files.size(file) + ":" + Files.getLastModifiedTime(file).toMillis());
        }
        return new Fingerprint(List.copyOf(parts));
    }

    private Path resolve(LocalModelManifest.FileEntry entry) throws IOException {
        Path file = modelDir.resolve(entry.path()).normalize();
        if (!file.startsWith(modelDir) || !Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) {
            throw new IOException("model file is missing or not a regular file");
        }
        return file;
    }

    private Admission verifyDigests(LocalModelManifest manifest) {
        for (LocalModelManifest.FileEntry entry : manifest.files()) {
            try {
                Path file = resolve(entry);
                if (Files.size(file) != entry.sizeBytes() || !entry.sha256().equals(sha256(file))) {
                    return new Admission(State.NOT_ADMITTED, NOT_ADMITTED_DIGEST, manifest);
                }
            } catch (IOException missing) {
                return new Admission(State.NOT_ADMITTED, NOT_ADMITTED_FILE_MISSING, manifest);
            }
        }
        return new Admission(State.QUALIFIED, "QUALIFIED", manifest);
    }

    public static String sha256(Path file) throws IOException {
        try (InputStream in = Files.newInputStream(file)) {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            byte[] buffer = new byte[1 << 20];
            int read;
            while ((read = in.read(buffer)) > 0) digest.update(buffer, 0, read);
            return HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }
}
