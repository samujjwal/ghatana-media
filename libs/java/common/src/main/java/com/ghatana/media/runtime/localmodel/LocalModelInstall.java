package com.ghatana.media.runtime.localmodel;

import com.ghatana.media.runtime.localmodel.LocalModelManifest.Modality;
import com.ghatana.media.runtime.localmodel.LocalModelManifest.Status;
import com.ghatana.media.runtime.localmodel.LocalModelManifest.Verification;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;

/**
 * Result of inspecting one installed model directory ({@code <root>/models/<key>/manifest.json}).
 *
 * <p>An installation is {@link #usable()} only when the manifest parsed, belongs to the expected modality and
 * model key, and every listed file's SHA-256 matched on disk. Anything else (absent manifest, malformed JSON,
 * wrong modality, missing or altered weights, disallowed licence) is not usable and stays fail-closed. The
 * object remembers each verified file's size and modification time so {@link #stillCurrent()} can detect a
 * swap after verification without re-hashing gigabytes on every readiness probe.</p>
 */
public final class LocalModelInstall {
    public enum State { NOT_INSTALLED, MANIFEST_INVALID, WRONG_MODEL, VERIFIED, REJECTED }

    private final State state;
    private final String detail;
    private final Path modelDir;
    private final LocalModelManifest manifest;
    private final Verification verification;
    private final Map<Path, String> fileStamps;

    private LocalModelInstall(State state, String detail, Path modelDir, LocalModelManifest manifest,
                              Verification verification, Map<Path, String> fileStamps) {
        this.state = state;
        this.detail = detail;
        this.modelDir = modelDir;
        this.manifest = manifest;
        this.verification = verification;
        this.fileStamps = fileStamps;
    }

    private static final java.util.concurrent.ConcurrentHashMap<Path, LocalModelInstall> SHARED =
            new java.util.concurrent.ConcurrentHashMap<>();

    /**
     * Like {@link #inspect} but reuses a previous VERIFIED result while its files still carry the size and
     * modification time seen at verification, so several consumers in one JVM hash a multi-gigabyte weight file once.
     */
    public static LocalModelInstall inspectShared(Path modelDir, String expectedModelKey, Modality expectedModality) {
        if (modelDir == null) return absent("no model directory configured");
        Path key = modelDir.toAbsolutePath().normalize();
        LocalModelInstall cached = SHARED.get(key);
        if (cached != null && cached.usable() && cached.manifest().modelKey().equals(expectedModelKey)
                && cached.manifest().modality() == expectedModality && cached.stillCurrent()) {
            return cached;
        }
        LocalModelInstall fresh = inspect(modelDir, expectedModelKey, expectedModality);
        if (fresh.usable()) SHARED.put(key, fresh); else SHARED.remove(key);
        return fresh;
    }

    public static LocalModelInstall absent(String detail) {
        return new LocalModelInstall(State.NOT_INSTALLED, detail, null, null, null, Map.of());
    }

    /** Inspects {@code modelDir/manifest.json}; never throws for an unusable installation. */
    public static LocalModelInstall inspect(Path modelDir, String expectedModelKey, Modality expectedModality) {
        if (modelDir == null) return absent("no model directory configured");
        Path manifestFile = modelDir.resolve("manifest.json");
        if (!Files.isRegularFile(manifestFile, LinkOption.NOFOLLOW_LINKS)) {
            return absent("manifest.json is absent");
        }
        final LocalModelManifest manifest;
        final String manifestSha;
        try {
            manifestSha = LocalModelManifest.manifestSha256(manifestFile);
            manifest = LocalModelManifest.read(manifestFile);
        } catch (IOException | RuntimeException invalid) {
            return new LocalModelInstall(State.MANIFEST_INVALID, "manifest is unreadable or malformed",
                    modelDir, null, null, Map.of());
        }
        if (manifest.modality() != expectedModality || !manifest.modelKey().equals(expectedModelKey)) {
            return new LocalModelInstall(State.WRONG_MODEL, "manifest describes a different model", modelDir,
                    manifest, null, Map.of());
        }
        Verification verification = manifest.verify(modelDir, manifestSha);
        if (!verification.verified()) {
            return new LocalModelInstall(State.REJECTED, verification.status() + ": " + verification.detail(),
                    modelDir, manifest, verification, Map.of());
        }
        Map<Path, String> stamps = new LinkedHashMap<>();
        for (Path file : verification.paths().values()) stamps.put(file, stamp(file));
        stamps.put(manifestFile, stamp(manifestFile));
        return new LocalModelInstall(State.VERIFIED, verification.detail(), modelDir, manifest, verification,
                Map.copyOf(stamps));
    }

    public State state() { return state; }
    public String detail() { return detail; }
    public boolean usable() { return state == State.VERIFIED; }
    public Path modelDir() { return modelDir; }
    public Status verificationStatus() { return verification == null ? null : verification.status(); }

    public LocalModelManifest manifest() {
        if (manifest == null) throw new IllegalStateException("no manifest: " + state);
        return manifest;
    }

    public Verification verification() {
        if (!usable()) throw new IllegalStateException("model installation is not verified: " + state);
        return verification;
    }

    public String manifestSha256() { return usable() ? verification.manifestSha256() : ""; }

    /** True while every verified file (and the manifest) still has the size and mtime seen at verification. */
    public boolean stillCurrent() {
        if (!usable()) return false;
        for (Map.Entry<Path, String> entry : fileStamps.entrySet()) {
            if (!entry.getValue().equals(stamp(entry.getKey()))) return false;
        }
        return true;
    }

    private static String stamp(Path file) {
        try {
            if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS)) return "missing";
            return Files.size(file) + ":" + Files.getLastModifiedTime(file, LinkOption.NOFOLLOW_LINKS).toMillis();
        } catch (IOException unreadable) {
            return "unreadable";
        }
    }
}
