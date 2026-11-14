package com.ghatana.audio.video.vision.local;

import com.ghatana.media.runtime.localmodel.LocalModelManifest;

import java.io.IOException;
import java.nio.file.Path;
import java.util.Objects;

/**
 * Server-owned admission of one local model directory: the model is {@link State#QUALIFIED} only when
 * its manifest is valid, names the expected model id, role and SPDX licence, carries the verbatim owner
 * decision, and every inventoried file exists as a regular file (no symlink) with the exact size and SHA-256
 * the manifest pins. Anything else — missing directory, absent or malformed manifest, wrong licence, missing
 * file, size or digest mismatch — is {@link State#NOT_ADMITTED} with a stable reason code and no model is ever
 * dispatched.
 *
 * <p>The manifest and every digest check are the shared {@link LocalModelManifest} implementation. Digests are
 * served by the shared {@code FileDigestCache}: a file is re-hashed whenever its size, modification time or inode
 * changes (and files modified within the last two seconds are always re-hashed), so an unchanged tree does not
 * rehash gigabytes per request while any change withdraws the qualification.</p>
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
    public static final String NOT_ADMITTED_OWNER_DECISION = "MODEL_OWNER_DECISION_MISMATCH";

    /** Outcome of one admission evaluation. {@code manifest} is present only when it parsed. */
    public record Admission(State state, String reasonCode, LocalModelManifest manifest) {
        public boolean qualified() { return state == State.QUALIFIED; }
    }

    private final Path modelDir;
    private final String expectedModelId;
    private final String expectedRole;
    private final String expectedSpdx;

    public LocalModelAdmission(Path modelDir, String expectedModelId, String expectedRole, String expectedSpdx) {
        this.modelDir = Objects.requireNonNull(modelDir, "modelDir").toAbsolutePath().normalize();
        this.expectedModelId = Objects.requireNonNull(expectedModelId, "expectedModelId");
        this.expectedRole = Objects.requireNonNull(expectedRole, "expectedRole");
        this.expectedSpdx = Objects.requireNonNull(expectedSpdx, "expectedSpdx");
    }

    public Path modelDir() { return modelDir; }

    /** Evaluates admission now (cheap when nothing on disk changed since the last full verification). */
    public Admission evaluate() {
        final LocalModelManifest manifest;
        final String manifestSha;
        try {
            Path file = modelDir.resolve(LocalModelManifest.DIRECTORY_MANIFEST_FILE);
            manifestSha = LocalModelManifest.manifestSha256(file);
            manifest = LocalModelManifest.readDirectory(modelDir);
        } catch (IOException | IllegalArgumentException invalid) {
            return new Admission(State.NOT_ADMITTED, NOT_ADMITTED_MANIFEST_MISSING, null);
        }
        if (!expectedModelId.equals(manifest.modelId()) || !expectedRole.equals(manifest.modality().name())) {
            return new Admission(State.NOT_ADMITTED, NOT_ADMITTED_IDENTITY, manifest);
        }
        if (!expectedSpdx.equals(manifest.license().spdx())) {
            return new Admission(State.NOT_ADMITTED, NOT_ADMITTED_LICENSE, manifest);
        }
        LocalModelManifest.Verification verification = manifest.verify(modelDir, manifestSha);
        return switch (verification.status()) {
            case VERIFIED -> new Admission(State.QUALIFIED, "QUALIFIED", manifest);
            case LICENSE_NOT_ALLOWED -> new Admission(State.NOT_ADMITTED, NOT_ADMITTED_LICENSE, manifest);
            case OWNER_DECISION_MISMATCH -> new Admission(State.NOT_ADMITTED, NOT_ADMITTED_OWNER_DECISION, manifest);
            case MANIFEST_INVALID -> new Admission(State.NOT_ADMITTED, NOT_ADMITTED_MANIFEST_MISSING, manifest);
            case FILE_MISSING -> new Admission(State.NOT_ADMITTED, NOT_ADMITTED_FILE_MISSING, manifest);
            case SIZE_MISMATCH, DIGEST_MISMATCH -> new Admission(State.NOT_ADMITTED, NOT_ADMITTED_DIGEST, manifest);
        };
    }
}
