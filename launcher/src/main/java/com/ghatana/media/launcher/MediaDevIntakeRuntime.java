package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.LineageOwnershipException;
import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.Registration;
import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.Removal;
import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.Version;
import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.VersionLedger;
import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.VersionLedgerFactory;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactVersion;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * DEV_ONLY versioned artifact intake (J-02). An artifact that the canonical upload store has already finalised (the
 * server verified the declared SHA-256 and size over the persisted bytes) is registered as the next immutable version
 * of a named lineage. Registration reads the verified bytes into private staging, probes them with ffprobe (container,
 * duration, per-stream codec; a file that cannot be probed is refused and nothing is registered), and appends the row.
 * Identical content registered again deduplicates to the existing version.
 *
 * <p>Rights: registration never grants anything. {@link #admission} reports the live PROCESSING verdict of the exact
 * version from the attestation authority; every processing lane re-resolves it itself and refuses without a statement.
 */
final class MediaDevIntakeRuntime implements AutoCloseable {
    static final String ENABLED = "MEDIA_DEV_INTAKE_ENABLED";
    static final String MAX_BYTES_ENV = "MEDIA_DEV_INTAKE_MAX_BYTES";
    static final String PROBE_TIMEOUT_ENV = "MEDIA_DEV_INTAKE_PROBE_TIMEOUT_SECONDS";
    static final long DEFAULT_MAX_BYTES = 256L * 1024 * 1024;
    private static final int PROBE_OUTPUT_LIMIT = 1 << 20;
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    /** Typed refusal with an HTTP status and a stable code. */
    static final class IntakeRefusedException extends RuntimeException {
        private final int status;
        private final String code;

        IntakeRefusedException(int status, String code, String message) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
        }

        int status() { return status; }
        String code() { return code; }
    }

    private final MediaRuntime runtime;
    private final VersionLedger ledger;
    private final RightsConsentResolver rights;
    private final Path ffprobe;
    private final long maxBytes;
    private final Duration probeTimeout;
    private final AtomicBoolean closed = new AtomicBoolean();
    private final java.util.concurrent.ConcurrentHashMap<String, java.util.concurrent.locks.ReentrantLock> lineageLocks =
            new java.util.concurrent.ConcurrentHashMap<>();

    MediaDevIntakeRuntime(MediaRuntime runtime, VersionLedger ledger, RightsConsentResolver rights, Path ffprobe,
                          long maxBytes, Duration probeTimeout) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.rights = rights;
        this.ffprobe = Objects.requireNonNull(ffprobe, "ffprobe");
        if (maxBytes < 1) throw new IllegalArgumentException("maxBytes must be positive");
        this.maxBytes = maxBytes;
        this.probeTimeout = Objects.requireNonNull(probeTimeout, "probeTimeout");
    }

    /** Null unless explicitly enabled; requires profile=dev, the DEV identity and an absolute ffprobe path. */
    static MediaDevIntakeRuntime compose(Map<String, String> environment, MediaRuntime runtime,
                                         RightsConsentResolver rights) {
        String flag = environment.getOrDefault(ENABLED, "false");
        if (!"true".equalsIgnoreCase(flag) && !"false".equalsIgnoreCase(flag)) {
            throw new IllegalArgumentException(ENABLED + " must be true or false");
        }
        if (!"true".equalsIgnoreCase(flag)) return null;
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "")).trim().toLowerCase(Locale.ROOT);
        if (!"dev".equals(profile)
                || !"true".equalsIgnoreCase(environment.getOrDefault("MEDIA_DEV_IDENTITY_ENABLED", "false"))) {
            throw new IllegalArgumentException("DEV_ONLY intake requires profile=dev and MEDIA_DEV_IDENTITY_ENABLED=true");
        }
        String probe = environment.getOrDefault(MediaDevProjectRenderRuntime.FFPROBE_ENV, "").trim();
        Path probePath = probe.isEmpty() ? null : Path.of(probe);
        if (probePath == null || !probePath.isAbsolute() || !Files.isExecutable(probePath)) {
            throw new IllegalArgumentException(
                    ENABLED + " requires " + MediaDevProjectRenderRuntime.FFPROBE_ENV + " to be an absolute executable path");
        }
        List<VersionLedgerFactory> factories = ServiceLoader.load(VersionLedgerFactory.class).stream()
                .map(ServiceLoader.Provider::get)
                .filter(factory -> "postgresql-dev-artifact-version-ledger".equals(factory.factoryId())).toList();
        if (factories.size() != 1) {
            throw new IllegalStateException("exactly one PostgreSQL DEV_ONLY artifact version ledger factory is required");
        }
        long max = DEFAULT_MAX_BYTES;
        String maxRaw = environment.get(MAX_BYTES_ENV);
        if (maxRaw != null && !maxRaw.isBlank()) max = Long.parseLong(maxRaw.trim());
        long timeout = 30;
        String timeoutRaw = environment.get(PROBE_TIMEOUT_ENV);
        if (timeoutRaw != null && !timeoutRaw.isBlank()) timeout = Long.parseLong(timeoutRaw.trim());
        return new MediaDevIntakeRuntime(runtime, factories.get(0).createDevOnly(Map.copyOf(environment)), rights,
                probePath, max, Duration.ofSeconds(timeout));
    }

    /** A registered version plus whether the call deduplicated onto an existing one. */
    record Registered(Version version, boolean deduplicated) { }

    Registered register(String tenantId, String principalId, String lineageId, String artifactId, String artifactVersionId) {
        ensureOpen();
        MediaArtifact artifact = exactArtifact(tenantId, principalId, artifactId, artifactVersionId);
        Optional<Version> existing = ledger.find(tenantId, principalId, lineageId, artifactVersionId);
        if (existing.isPresent()) return new Registered(existing.get(), true);
        if (artifact.sizeBytes() > maxBytes) {
            throw new IntakeRefusedException(413, "INTAKE_ARTIFACT_TOO_LARGE",
                    "The artifact exceeds the DEV_ONLY intake probe ceiling; nothing was registered");
        }
        String probeJson = probe(tenantId, principalId, artifact);
        try {
            // Serialised with review decisions on the same lineage (single launcher process): a decision either commits
            // before the new head exists or is refused as stale, never both.
            Registration registration = withLineageLock(tenantId, principalId, lineageId, () -> ledger.register(
                    tenantId, principalId, lineageId, artifact.artifactId(), artifact.version().value(),
                    artifact.sha256(), artifact.sizeBytes(), probeJson));
            return new Registered(registration.version(), registration.deduplicated());
        } catch (LineageOwnershipException concealed) {
            throw new IntakeRefusedException(404, "INTAKE_LINEAGE_NOT_FOUND", "No such lineage for this principal");
        } catch (IllegalStateException failure) {
            throw new IntakeRefusedException(503, "INTAKE_LEDGER_UNAVAILABLE", "The version ledger could not be updated");
        }
    }

    /**
     * Where one exact artifact version stands in its lineage. {@code superseded} is true when a later version of the
     * same lineage exists; {@code head} is that lineage's newest version. Used by review to make approvals of a
     * superseded version STALE (never transferred to the head).
     */
    record Standing(String lineageId, int versionNumber, Version head) {
        boolean superseded() { return head.versionNumber() > versionNumber; }
    }

    /** The most-superseded standing of this owner's lineages that hold the exact version; empty when in none. */
    Optional<Standing> standing(String tenantId, String ownerPrincipalId, String artifactId, String artifactVersionId) {
        ensureOpen();
        Standing worst = null;
        for (String lineageId : ledger.lineagesHolding(tenantId, ownerPrincipalId, artifactId, artifactVersionId)) {
            List<Version> all = ledger.versions(tenantId, ownerPrincipalId, lineageId);
            Version mine = all.stream().filter(v -> v.artifactVersionId().equals(artifactVersionId)).findFirst()
                    .orElse(null);
            if (mine == null) continue;
            Standing candidate = new Standing(lineageId, mine.versionNumber(), all.get(all.size() - 1));
            if (worst == null || candidate.superseded() && !worst.superseded()) worst = candidate;
        }
        return Optional.ofNullable(worst);
    }

    /**
     * The erasure that restored {@code head} as the lineage head, if any: the most recent removal of a version numbered
     * above the head. Empty when the head was registered (never restored). Used by review to say so, never to hide it.
     */
    Optional<Removal> restoredByErasure(String tenantId, String ownerPrincipalId, String lineageId, Version head) {
        ensureOpen();
        Removal latest = null;
        for (Removal removal : ledger.removals(tenantId, ownerPrincipalId, lineageId)) {
            if (removal.versionNumber() <= head.versionNumber()) continue;
            if (latest == null || removal.erasedAt().isAfter(latest.erasedAt())) latest = removal;
        }
        return Optional.ofNullable(latest);
    }

    /** Runs {@code action} while holding the lineage lock that serialises registration against review decisions. */
    <T> T withLineageLock(String tenantId, String principalId, String lineageId, java.util.function.Supplier<T> action) {
        java.util.concurrent.locks.ReentrantLock lock = lineageLocks.computeIfAbsent(
                tenantId + "\u0000" + principalId + "\u0000" + lineageId, key -> new java.util.concurrent.locks.ReentrantLock());
        lock.lock();
        try { return action.get(); } finally { lock.unlock(); }
    }

    /** Locks every lineage holding the exact version (sorted, so concurrent callers cannot deadlock). */
    <T> T withVersionLock(String tenantId, String ownerPrincipalId, String artifactId, String artifactVersionId,
                          java.util.function.Supplier<T> action) {
        List<String> lineages = ledger.lineagesHolding(tenantId, ownerPrincipalId, artifactId, artifactVersionId)
                .stream().sorted().toList();
        java.util.function.Supplier<T> chain = action;
        for (int index = lineages.size() - 1; index >= 0; index--) {
            String lineageId = lineages.get(index);
            java.util.function.Supplier<T> inner = chain;
            chain = () -> withLineageLock(tenantId, ownerPrincipalId, lineageId, inner);
        }
        return chain.get();
    }

    List<Version> versions(String tenantId, String principalId, String lineageId) {
        ensureOpen();
        try {
            return ledger.versions(tenantId, principalId, lineageId);
        } catch (IllegalStateException failure) {
            throw new IntakeRefusedException(503, "INTAKE_LEDGER_UNAVAILABLE", "The version ledger could not be read");
        }
    }

    /** Live PROCESSING verdict of the exact version, or null when no rights authority is configured. */
    Resolution admission(String tenantId, Version version) {
        if (rights == null) return null;
        try {
            return rights.resolve(new ResolutionRequest(tenantId, version.artifactId(), version.artifactVersionId(),
                    version.contentSha256(), Scope.PROCESSING));
        } catch (RuntimeException unavailable) {
            return null;
        }
    }

    private MediaArtifact exactArtifact(String tenantId, String principalId, String artifactId, String versionId) {
        Optional<MediaArtifact> found;
        try {
            found = runtime.artifact(tenantId, principalId, artifactId);
        } catch (IllegalStateException integrity) {
            throw new IntakeRefusedException(409, "INTAKE_ARTIFACT_INTEGRITY_FAILED",
                    "The artifact record does not match its immutable version; nothing was registered");
        }
        if (found.isEmpty() || !found.get().version().value().equals(versionId)) {
            throw new IntakeRefusedException(404, "ARTIFACT_VERSION_NOT_FOUND",
                    "The exact artifact version is not available to this DEV_ONLY principal");
        }
        return found.get();
    }

    /** Streams the verified bytes into private staging and probes them; returns the canonical probe JSON. */
    private String probe(String tenantId, String principalId, MediaArtifact artifact) {
        Path staged = null;
        try {
            staged = Files.createTempFile("media-dev-intake-", ".bin",
                    java.nio.file.attribute.PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
            try (OutputStream out = Files.newOutputStream(staged)) {
                var receipt = runtime.copyArtifactContent(tenantId, principalId, artifact.artifactId(),
                        ArtifactVersion.fromSha256(artifact.sha256()), out, maxBytes);
                if (receipt.isEmpty()) {
                    throw new IntakeRefusedException(404, "ARTIFACT_VERSION_NOT_FOUND",
                            "The exact artifact version is not available to this DEV_ONLY principal");
                }
            } catch (IllegalStateException integrity) {
                throw new IntakeRefusedException(409, "INTAKE_ARTIFACT_INTEGRITY_FAILED",
                        "Stored bytes do not match the immutable version; nothing was registered");
            }
            return runProbe(staged, artifact.sizeBytes());
        } catch (IOException failure) {
            throw new IntakeRefusedException(503, "INTAKE_STAGING_UNAVAILABLE", "Private probe staging failed");
        } finally {
            if (staged != null) try { Files.deleteIfExists(staged); } catch (IOException ignored) { }
        }
    }

    private String runProbe(Path file, long expectedSize) throws IOException {
        Process process = new ProcessBuilder(ffprobe.toString(), "-v", "error", "-print_format", "json",
                "-show_format", "-show_streams", "-show_program_version", file.toString())
                .redirectError(ProcessBuilder.Redirect.DISCARD).start();
        byte[] output;
        try {
            output = process.getInputStream().readNBytes(PROBE_OUTPUT_LIMIT);
            if (!process.waitFor(probeTimeout.toMillis(), TimeUnit.MILLISECONDS)) {
                process.destroyForcibly();
                throw new IntakeRefusedException(422, "INTAKE_MEDIA_NOT_PROBEABLE", "Media probe timed out");
            }
        } catch (InterruptedException interrupted) {
            process.destroyForcibly();
            Thread.currentThread().interrupt();
            throw new IntakeRefusedException(503, "INTAKE_PROBE_UNAVAILABLE", "Media probe was interrupted");
        }
        if (process.exitValue() != 0) {
            throw new IntakeRefusedException(422, "INTAKE_MEDIA_NOT_PROBEABLE",
                    "The file is not decodable media; nothing was registered");
        }
        JsonNode root;
        try { root = JSON.readTree(output); }
        catch (RuntimeException invalid) {
            throw new IntakeRefusedException(422, "INTAKE_MEDIA_NOT_PROBEABLE", "Probe output was not readable");
        }
        List<Map<String, Object>> streams = new ArrayList<>();
        for (JsonNode stream : root.path("streams")) {
            String type = stream.path("codec_type").asString("");
            if (!type.equals("audio") && !type.equals("video")) continue;
            Map<String, Object> s = new LinkedHashMap<>();
            s.put("index", stream.path("index").asInt());
            s.put("codecType", type);
            s.put("codecName", stream.path("codec_name").asString(""));
            number(s, "durationSeconds", stream.path("duration"));
            if (type.equals("audio")) {
                number(s, "sampleRate", stream.path("sample_rate"));
                s.put("channels", stream.path("channels").asInt());
            } else {
                s.put("width", stream.path("width").asInt());
                s.put("height", stream.path("height").asInt());
                s.put("frameRate", stream.path("avg_frame_rate").asString(""));
            }
            streams.add(s);
        }
        if (streams.isEmpty()) {
            throw new IntakeRefusedException(422, "INTAKE_MEDIA_NOT_PROBEABLE",
                    "The file has no audio or video stream; nothing was registered");
        }
        Map<String, Object> format = new LinkedHashMap<>();
        format.put("formatName", root.path("format").path("format_name").asString(""));
        number(format, "durationSeconds", root.path("format").path("duration"));
        number(format, "bitRate", root.path("format").path("bit_rate"));
        Map<String, Object> probe = new LinkedHashMap<>();
        probe.put("schemaVersion", "media.dev.intake-probe.v1");
        probe.put("tool", "ffprobe " + root.path("program_version").path("version").asString("unknown"));
        probe.put("sizeBytes", expectedSize);
        probe.put("format", format);
        probe.put("streams", streams);
        return JSON.writeValueAsString(probe);
    }

    private static void number(Map<String, Object> target, String key, JsonNode node) {
        if (node.isMissingNode() || node.isNull()) return;
        try { target.put(key, Double.parseDouble(node.asString())); } catch (NumberFormatException notNumeric) { /* N/A */ }
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("DEV_ONLY intake is closed");
    }

    @Override public void close() {
        if (closed.compareAndSet(false, true)) ledger.close();
    }
}
