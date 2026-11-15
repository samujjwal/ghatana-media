package com.ghatana.media.launcher;

import com.ghatana.audio.video.vision.tracking.SourceBox;
import com.ghatana.audio.video.vision.tracking.VideoTimeline;
import com.ghatana.media.launcher.MediaDevRegionMask.FrameMask;
import com.ghatana.media.launcher.MediaDevRegionMask.Observation;
import com.ghatana.media.launcher.MediaDevRegionMask.Rect;
import com.ghatana.media.launcher.MediaDevRegionPixels.Effect;
import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Appended;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Kind;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.LineageExistsException;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Proposal;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.RegionEditLedger;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.RegionEditLedgerFactory;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.StaleHeadException;
import com.ghatana.media.runtime.MediaRegionEditLedgerContracts.Version;
import com.ghatana.media.runtime.InMemoryMediaRegionEditLedger;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.TreeMap;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.stream.Stream;

/**
 * DEV_ONLY tracked region edit with exact version compare-and-set and undo (J-11
 * {@code media.dev.outcome-reversible-tracked-edit}).
 *
 * <p><b>What it does.</b> A user names a stored video as the BASE of a lineage. An edit takes a TRACK produced by the
 * launcher's own vision tracking lane (verified against the durable request ledger, the exact source version and the
 * video's frame timeline), derives a per-frame mask from it on the exact presentation timeline (linear in PTS, so a
 * variable-frame-rate clip is mapped exactly), applies a blur, pixelate or fill inside the mask on the decoded
 * {@code yuv420p} frames and re-encodes with the real FFmpeg with every frame's PTS preserved. The result is a NEW
 * immutable artifact (plus a manifest of the per-frame masks and measurements) appended to the lineage as the next
 * version; the source bytes are never touched.</p>
 *
 * <p><b>Verification before registration.</b> The output is re-probed (codec, pixel format, geometry, frame count, time
 * base, every frame's PTS) and decoded again beside the source: the samples outside every mask are compared and, for a
 * lossless encode, must be bit-identical; the samples inside must have changed. Anything else registers nothing.</p>
 *
 * <p><b>Versioning.</b> {@link RegionEditLedger} is the compare-and-set: an edit or undo names the base version it saw
 * and succeeds only if that is still the head, so of two concurrent editors exactly one wins and the other gets
 * {@code 409 STALE_BASE_VERSION}. An undo appends a version that points at the exact artifact of the version it
 * restores, so its bytes and metadata are that artifact's. The request ledger makes a retry (including one after a
 * launcher kill mid-render) exactly-once.</p>
 *
 * <p><b>Rights.</b> The root source of the lineage must resolve ADMITTED for PROCESSING on every edit and undo, a replay
 * included; a missing statement or a revocation is a typed 403 and nothing is read, rendered or registered.</p>
 */
final class MediaDevRegionEditRuntime implements AutoCloseable {
    static final String ENABLED = "MEDIA_DEV_REGION_EDIT_ENABLED";
    static final String SCHEMA = "media.dev.region-edit.v1";
    static final String MANIFEST_SCHEMA = "media.dev.region-edit-manifest.v1";
    static final String KIND_VIDEO = "REGION_EDIT_VIDEO";
    static final String KIND_MANIFEST = "REGION_EDIT_MANIFEST";
    static final String LANE_EDIT = "region.edit";
    static final String LANE_UNDO = "region.undo";
    static final int MAX_FRAMES = 600;
    static final long MAX_PIXELS = 1_280L * 720L;
    static final long MAX_SOURCE_BYTES = 128L * 1024 * 1024;
    static final long MAX_OUTPUT_BYTES = 256L * 1024 * 1024;
    static final int MAX_PADDING = 64;
    static final int MAX_CRF = 30;
    /** A lossy edit must keep every sample outside the masks at least this close to the source (PSNR, dB). */
    static final double LOSSY_OUTSIDE_MIN_PSNR_DB = 30.0;
    private static final Duration PROBE_TIMEOUT = Duration.ofSeconds(60);
    private static final Duration PIPELINE_TIMEOUT = Duration.ofMinutes(5);
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final Logger log = LoggerFactory.getLogger(MediaDevRegionEditRuntime.class);

    /** A typed refusal with an HTTP status; carries no request content or process output. */
    static final class RegionEditRefusedException extends RuntimeException {
        private final int status;
        private final String code;
        private final Map<String, Object> details;

        RegionEditRefusedException(int status, String code, String message, Map<String, Object> details) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
            this.details = details;
        }

        int status() { return status; }
        String code() { return code; }
        Map<String, Object> details() { return details; }
    }

    /** The render or probe process did not finish (killed, timed out): outcome UNKNOWN, nothing was registered. */
    static final class RegionEditOutcomeUnknownException extends RuntimeException {
        RegionEditOutcomeUnknownException(String phase) {
            super("the " + phase + " process did not finish; the outcome is unknown", null, false, false);
        }
    }

    static final class RegionEditRequestReusedException extends IllegalStateException {
        RegionEditRequestReusedException() { super("region edit requestId was already used for a different request"); }
    }

    static final class RegionEditRegistrationFailedException extends IllegalStateException {
        RegionEditRegistrationFailedException(Throwable cause) {
            super("region edit output could not be registered as an immutable artifact", cause);
        }
    }

    /** {@code trackId} is the id inside the tracks document of the named, launcher-produced tracks artifact. */
    record TrackRef(String artifactId, String artifactVersionId, String trackId) {
        TrackRef {
            Objects.requireNonNull(artifactId, "track.artifactId");
            Objects.requireNonNull(artifactVersionId, "track.artifactVersionId");
            Objects.requireNonNull(trackId, "track.trackId");
        }
    }

    record EditRequest(String requestId, int baseVersion, TrackRef track, Effect effect, int paddingPx, boolean holdEnds,
                       Double maxDriftPx, int crf) {
        EditRequest {
            requestId = MediaDevDubSupport.boundedId(requestId, "requestId");
            if (baseVersion < 1) throw invalid("$.baseVersion", "baseVersion must be a positive version number");
            Objects.requireNonNull(track, "track");
            Objects.requireNonNull(effect, "effect");
            if (paddingPx < 0 || paddingPx > MAX_PADDING) {
                throw invalid("$.paddingPx", "paddingPx must be within [0, " + MAX_PADDING + "]");
            }
            if (maxDriftPx != null && !(maxDriftPx >= 0.5 && maxDriftPx <= 500)) {
                throw invalid("$.maxDriftPx", "maxDriftPx must be within [0.5, 500]");
            }
            if (crf < 0 || crf > MAX_CRF) throw invalid("$.encoder.crf", "crf must be within [0, " + MAX_CRF + "]");
        }
    }

    record UndoRequest(String requestId, int baseVersion) {
        UndoRequest {
            requestId = MediaDevDubSupport.boundedId(requestId, "requestId");
            if (baseVersion < 1) throw invalid("$.baseVersion", "baseVersion must be a positive version number");
        }
    }

    /** One version of a lineage plus the manifest document of an EDIT; {@code replayed} marks a stored result. */
    record Outcome(Version version, Map<String, Object> manifest, boolean replayed)
            implements MediaDevRenderAdmission.ReplayAware {
        @Override public boolean replayedResult() { return replayed; }
    }

    private record Verification(Map<String, Object> summary, List<Double> insideMeanAbsDiff, long insideChanged,
                                int outsideMaxAbsDiff, Double outsidePsnrDb) { }

    private record Tags(String colorSpace, String colorPrimaries, String colorTransfer, String colorRange) { }

    private record Geometry(VideoTimeline timeline, Tags tags, String ffprobeVersion) { }

    private record TrackInput(MediaArtifact artifact, String trackId, String label, List<Observation> observations,
                              Map<String, Object> model) { }

    private final MediaRuntime runtime;
    private final Path ffmpeg;
    private final Path ffprobe;
    private final RegionEditLedger regionLedger;
    private final MediaDevRequestLedger requestLedger;
    private final MediaDevDubSupport support;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;
    private final RightsConsentResolver rights;
    private final AtomicBoolean closed = new AtomicBoolean();
    private volatile String ffmpegVersion;

    MediaDevRegionEditRuntime(MediaRuntime runtime, Path ffmpeg, Path ffprobe, RegionEditLedger regionLedger,
                              MediaDevRequestLedger requestLedger, RightsConsentResolver rights,
                              MediaDevProjectRenderRuntime.OutputRegistrar registrar) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        if (ffmpeg == null || ffprobe == null || !ffmpeg.isAbsolute() || !ffprobe.isAbsolute()) {
            throw new IllegalArgumentException("ffmpeg and ffprobe must be absolute paths");
        }
        this.ffmpeg = ffmpeg;
        this.ffprobe = ffprobe;
        this.regionLedger = Objects.requireNonNull(regionLedger, "regionLedger");
        this.requestLedger = Objects.requireNonNull(requestLedger, "requestLedger");
        this.rights = rights == null ? RightsConsentResolver.unavailable() : rights;
        this.registrar = Objects.requireNonNull(registrar, "registrar");
        this.support = new MediaDevDubSupport(runtime, registrar, this.rights);
    }

    /**
     * Null unless {@link #ENABLED} is true; requires profile=dev, the DEV identity, the shared request ledger and an
     * absolute FFmpeg and FFprobe pair. The edit history is PostgreSQL when the canonical datasource is configured, else
     * a process-local ledger that is logged as non-durable.
     */
    static MediaDevRegionEditRuntime compose(MediaRuntime runtime, Map<String, String> environment,
                                             RightsConsentResolver rights, MediaDevRequestLedger requestLedger) {
        String flag = environment.getOrDefault(ENABLED, "false");
        if (!"true".equalsIgnoreCase(flag) && !"false".equalsIgnoreCase(flag)) {
            throw new IllegalArgumentException(ENABLED + " must be true or false");
        }
        if (!"true".equalsIgnoreCase(flag)) return null;
        String profile = environment.getOrDefault("MEDIA_RUNTIME_ENVIRONMENT",
                environment.getOrDefault("MEDIA_PROFILE", "")).trim().toLowerCase(Locale.ROOT);
        if (!"dev".equals(profile)
                || !"true".equalsIgnoreCase(environment.getOrDefault("MEDIA_DEV_IDENTITY_ENABLED", "false"))) {
            throw new IllegalArgumentException("DEV_ONLY region edit requires profile=dev and MEDIA_DEV_IDENTITY_ENABLED=true");
        }
        String ffmpeg = environment.getOrDefault(MediaDevProjectRenderRuntime.FFMPEG_ENV, "").trim();
        String ffprobe = environment.getOrDefault(MediaDevProjectRenderRuntime.FFPROBE_ENV, "").trim();
        if (ffmpeg.isEmpty() || ffprobe.isEmpty() || !Path.of(ffmpeg).isAbsolute() || !Path.of(ffprobe).isAbsolute()
                || !Files.isExecutable(Path.of(ffmpeg)) || !Files.isExecutable(Path.of(ffprobe))) {
            throw new IllegalArgumentException(ENABLED + " requires absolute executable " + MediaDevProjectRenderRuntime.FFMPEG_ENV
                    + " and " + MediaDevProjectRenderRuntime.FFPROBE_ENV);
        }
        if (requestLedger == null) throw new IllegalArgumentException(ENABLED + " requires the DEV request ledger");
        RegionEditLedger ledger;
        if (!environment.getOrDefault("MEDIA_POSTGRES_JDBC_URL", "").isBlank()) {
            List<RegionEditLedgerFactory> factories = ServiceLoader.load(RegionEditLedgerFactory.class).stream()
                    .map(ServiceLoader.Provider::get)
                    .filter(factory -> "postgresql-dev-region-edit-ledger".equals(factory.factoryId())).toList();
            if (factories.size() != 1) {
                throw new IllegalStateException("exactly one PostgreSQL DEV_ONLY region edit ledger factory is required");
            }
            ledger = factories.getFirst().createDevOnly(Map.copyOf(environment));
        } else {
            log.warn("DEV region edit history is process-local (non-durable): no canonical PostgreSQL datasource is configured");
            ledger = new InMemoryMediaRegionEditLedger();
        }
        return new MediaDevRegionEditRuntime(runtime, Path.of(ffmpeg), Path.of(ffprobe), ledger, requestLedger, rights,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime));
    }

    Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", "DEV_ONLY");
        out.put("ready", regionLedger.ready());
        out.put("schema", SCHEMA);
        out.put("effects", List.of("BLUR", "PIXELATE", "FILL"));
        Map<String, Object> limits = new LinkedHashMap<>();
        limits.put("maxFrames", MAX_FRAMES);
        limits.put("maxPixelsPerFrame", MAX_PIXELS);
        limits.put("maxSourceBytes", MAX_SOURCE_BYTES);
        limits.put("maxOutputBytes", MAX_OUTPUT_BYTES);
        limits.put("maxPaddingPx", MAX_PADDING);
        limits.put("maxBlockSize", Effect.MAX_BLOCK);
        limits.put("maxBlurRadius", Effect.MAX_RADIUS);
        limits.put("crfRange", List.of(0, MAX_CRF));
        out.put("limits", limits);
        out.put("encoder", Map.of("codec", "libx264", "container", "mp4", "pixelFormat", "yuv420p",
                "defaultCrf", 0, "crf0", "LOSSLESS: samples outside every mask are bit-identical to the source",
                "lossyOutsideMinPsnrDb", LOSSY_OUTSIDE_MIN_PSNR_DB));
        out.put("source", Map.of("streams", "exactly one video stream, pixel format yuv420p, even width and height",
                "audio", "NOT_SUPPORTED"));
        out.put("history", Map.of("ledgerId", regionLedger.ledgerId(), "compareAndSet", "expected head version"));
        out.put("rightsAuthority", Map.of("resolverId", rights.resolverId(), "ready", rights.ready(),
                "scope", Scope.PROCESSING.name()));
        out.put("trackProvenance", "launcher vision.track ledger entry for this principal, exact source version, timeline");
        return out;
    }

    static RegionEditRefusedException invalid(String path, String message) {
        return new RegionEditRefusedException(422, "REGION_EDIT_INVALID", message, Map.of("path", path));
    }

    // ------------------------------------------------------------------ lineage

    /** Names a stored video as version 1 (BASE) of a lineage; the same owner naming the same version again is a no-op. */
    Outcome createLineage(String tenantId, String principalId, String lineageId, String artifactId, String artifactVersionId) {
        ensureOpen();
        String id = MediaDevDubSupport.boundedId(lineageId, "lineageId");
        MediaArtifact artifact = exact(tenantId, principalId, artifactId, artifactVersionId);
        if (!artifact.contentType().toLowerCase(Locale.ROOT).startsWith("video/")) {
            throw new RegionEditRefusedException(422, "SOURCE_FORMAT_NOT_SUPPORTED",
                    "a lineage starts from a video/* artifact version", Map.of());
        }
        if (artifact.sizeBytes() > MAX_SOURCE_BYTES) {
            throw new RegionEditRefusedException(422, "REGION_EDIT_LIMIT_EXCEEDED", "source exceeds the byte ceiling",
                    Map.of("limit", MAX_SOURCE_BYTES));
        }
        try {
            Appended base = regionLedger.createLineage(tenantId, principalId, id, "lineage-base", artifact.artifactId(),
                    artifact.version().value(), artifact.sha256(), artifact.sizeBytes(),
                    json(Map.of("kind", "BASE", "note", "the user's own video, registered by reference and never changed")));
            return new Outcome(base.version(), null, base.deduplicated());
        } catch (LineageExistsException exists) {
            throw new RegionEditRefusedException(409, "LINEAGE_EXISTS",
                    "the lineage id is already used for a different video or by another owner", Map.of());
        } catch (IllegalStateException unavailable) {
            throw ledgerUnavailable();
        }
    }

    List<Version> versions(String tenantId, String principalId, String lineageId) {
        ensureOpen();
        try {
            return regionLedger.versions(tenantId, principalId, lineageId);
        } catch (IllegalStateException unavailable) {
            throw ledgerUnavailable();
        }
    }

    // ------------------------------------------------------------------ edit

    Outcome edit(String tenantId, String principalId, String lineageId, EditRequest request) {
        ensureOpen();
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "region_edit", tenantId,
                () -> editAdmitted(tenantId, principalId, lineageId, request));
    }

    private Outcome editAdmitted(String tenantId, String principalId, String lineageId, EditRequest request) {
        List<Version> rows = existing(tenantId, principalId, lineageId);
        Version head = rows.getLast();
        MediaArtifact headArtifact = exact(tenantId, principalId, head.artifactId(), head.artifactVersionId());
        // Rights are re-resolved on every call, a replay included: a revoked or missing statement refuses before anything runs.
        MediaDevDubSupport.Rights decision = requireProcessing(tenantId, principalId, headArtifact);
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.region.edit.v1", lineageId, request.baseVersion(),
                head.artifactVersionId(), request.track().artifactId(), request.track().artifactVersionId(),
                request.track().trackId(), effectCanonical(request.effect()), request.paddingPx(), request.holdEnds(),
                request.maxDriftPx(), request.crf());
        return requestLedger.run(tenantId, principalId, LANE_EDIT, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, lineageId, request.requestId(), LANE_EDIT),
                () -> produceEdit(tenantId, principalId, lineageId, request, decision),
                outcome -> outputsOf(outcome.version()),
                RegionEditRequestReusedException::new);
    }

    private Outcome produceEdit(String tenantId, String principalId, String lineageId, EditRequest request,
                                MediaDevDubSupport.Rights decision) {
        List<Version> rows = existing(tenantId, principalId, lineageId);
        Optional<Version> done = rows.stream().filter(version -> version.requestId().equals(request.requestId())).findFirst();
        if (done.isPresent()) return outcomeOf(tenantId, principalId, done.get(), true); // appended, then the run was cut
        Version head = rows.getLast();
        requireHead(request.baseVersion(), head);
        Version root = rows.getFirst();
        MediaArtifact headArtifact = exact(tenantId, principalId, head.artifactId(), head.artifactVersionId());
        MediaArtifact rootArtifact = exact(tenantId, principalId, root.artifactId(), root.artifactVersionId());
        if (headArtifact.sizeBytes() > MAX_SOURCE_BYTES) {
            throw new RegionEditRefusedException(422, "REGION_EDIT_LIMIT_EXCEEDED", "source exceeds the byte ceiling",
                    Map.of("limit", MAX_SOURCE_BYTES));
        }
        Path dir = privateTempDirectory();
        try {
            Path input = dir.resolve("in.bin");
            try (OutputStream out = Files.newOutputStream(input)) {
                runtime.copyArtifactContent(tenantId, principalId, headArtifact.artifactId(), headArtifact.version(), out,
                        MAX_SOURCE_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
            }
            Geometry geometry = probeSource(input, dir);
            VideoTimeline timeline = geometry.timeline();
            TrackInput track = loadTrack(tenantId, principalId, request.track(), rootArtifact, timeline);
            long[] pts = timeline.frames().stream().mapToLong(VideoTimeline.FrameTime::pts).toArray();
            MediaDevRegionMask.Drift drift = MediaDevRegionMask.drift(track.observations());
            if (request.maxDriftPx() != null && drift.maxCenterErrorPx() > request.maxDriftPx()) {
                throw new RegionEditRefusedException(422, "TRACK_DRIFT_EXCEEDED",
                        "the track's own observations disagree with their interpolation by more than the allowed drift",
                        Map.of("maxCenterErrorPx", drift.maxCenterErrorPx(), "allowedPx", request.maxDriftPx()));
            }
            List<FrameMask> masks;
            try {
                masks = MediaDevRegionMask.derive(pts, timeline.width(), timeline.height(), track.observations(),
                        request.paddingPx(), request.holdEnds());
            } catch (IllegalArgumentException refused) {
                throw new RegionEditRefusedException(422, "TRACK_TIMELINE_MISMATCH", refused.getMessage(), Map.of());
            }
            if (masks.stream().noneMatch(mask -> mask.rect() != null)) {
                throw new RegionEditRefusedException(422, "REGION_EDIT_EMPTY_MASK",
                        "the track leaves no frame with a mask; nothing was rendered", Map.of());
            }
            String maskSha = MediaDevProjectRenderRuntime.sha256Hex(MediaDevRegionMask.canonical(masks));
            Path output = dir.resolve("out.mp4");
            renderPipeline(input, output, dir, geometry, pts, masks, request, maskSha);
            Verification verification = verify(input, output, dir, geometry, pts, masks, request);
            byte[] mp4 = Files.readAllBytes(output);
            return register(tenantId, principalId, lineageId, request, headArtifact, rootArtifact, head, track, geometry,
                    masks, drift, maskSha, verification, mp4, decision);
        } catch (IOException failure) {
            throw new RegionEditRefusedException(503, "REGION_EDIT_TOOLS_UNAVAILABLE",
                    "the video tools could not be run; nothing was registered", Map.of());
        } finally {
            deleteTree(dir);
        }
    }

    // ------------------------------------------------------------------ undo

    Outcome undo(String tenantId, String principalId, String lineageId, UndoRequest request) {
        ensureOpen();
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "region_undo", tenantId,
                () -> undoAdmitted(tenantId, principalId, lineageId, request));
    }

    private Outcome undoAdmitted(String tenantId, String principalId, String lineageId, UndoRequest request) {
        List<Version> rows = existing(tenantId, principalId, lineageId);
        MediaArtifact headArtifact = exact(tenantId, principalId, rows.getLast().artifactId(),
                rows.getLast().artifactVersionId());
        MediaDevDubSupport.Rights decision = requireProcessing(tenantId, principalId, headArtifact);
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.region.undo.v1", lineageId, request.baseVersion());
        return requestLedger.run(tenantId, principalId, LANE_UNDO, request.requestId(), fingerprint,
                outputs -> replay(tenantId, principalId, lineageId, request.requestId(), LANE_UNDO),
                () -> produceUndo(tenantId, principalId, lineageId, request, decision),
                outcome -> outputsOf(outcome.version()),
                RegionEditRequestReusedException::new);
    }

    private Outcome produceUndo(String tenantId, String principalId, String lineageId, UndoRequest request,
                                MediaDevDubSupport.Rights decision) {
        List<Version> rows = existing(tenantId, principalId, lineageId);
        Optional<Version> done = rows.stream().filter(version -> version.requestId().equals(request.requestId())).findFirst();
        if (done.isPresent()) return outcomeOf(tenantId, principalId, done.get(), true);
        Version head = rows.getLast();
        requireHead(request.baseVersion(), head);
        // The version whose edit is currently in effect: follow UNDO rows to the version whose content they restore.
        Version effective = head;
        while (effective.kind() == Kind.UNDO) effective = rows.get(effective.restoresVersionNumber() - 1);
        if (effective.kind() == Kind.BASE) {
            throw new RegionEditRefusedException(409, "NOTHING_TO_UNDO",
                    "the head is the original video; there is no edit to undo", Map.of("headVersion", head.versionNumber()));
        }
        Version target = rows.get(effective.parentVersionNumber() - 1);
        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("kind", "UNDO");
        detail.put("undoes", effective.versionNumber());
        detail.put("restores", target.versionNumber());
        detail.put("rightsDecision", rightsView(decision));
        detail.put("note", "points at the exact artifact of the restored version; no bytes were copied or re-encoded");
        Proposal proposal = new Proposal(Kind.UNDO, request.requestId(), target.artifactId(), target.artifactVersionId(),
                target.contentSha256(), target.sizeBytes(), null, null, target.versionNumber(), json(detail));
        Appended appended = append(tenantId, principalId, lineageId, head.versionNumber(), proposal);
        return outcomeOf(tenantId, principalId, appended.version(), appended.deduplicated());
    }

    // ------------------------------------------------------------------ shared steps

    private Outcome replay(String tenantId, String principalId, String lineageId, String requestId, String lane) {
        Version version = regionLedger.byRequest(tenantId, principalId, lineageId, requestId)
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(lane));
        return outcomeOf(tenantId, principalId, version, true);
    }

    private Outcome outcomeOf(String tenantId, String principalId, Version version, boolean replayed) {
        Map<String, Object> manifest = null;
        if (version.kind() == Kind.EDIT) {
            MediaArtifact artifact = exact(tenantId, principalId, version.manifestArtifactId(),
                    version.manifestArtifactVersionId());
            manifest = readManifest(tenantId, principalId, artifact);
        }
        return new Outcome(version, manifest, replayed);
    }

    private Map<String, Object> readManifest(String tenantId, String principalId, MediaArtifact manifest) {
        try {
            JsonNode node = support.readDocument(tenantId, principalId, manifest);
            return JSON.convertValue(node, new TypeReference<LinkedHashMap<String, Object>>() { });
        } catch (MediaDevSpeechRuntime.SpeechRefusedException unreadable) {
            throw new RegionEditRefusedException(422, "REGION_EDIT_MANIFEST_INVALID",
                    "the stored manifest is not a readable JSON document", Map.of());
        }
    }

    private static List<OutputRef> outputsOf(Version version) {
        List<OutputRef> outputs = new ArrayList<>();
        outputs.add(new OutputRef("version", version.artifactId(), version.artifactVersionId()));
        if (version.manifestArtifactId() != null) {
            outputs.add(new OutputRef("manifest", version.manifestArtifactId(), version.manifestArtifactVersionId()));
        }
        return outputs;
    }

    private Appended append(String tenantId, String principalId, String lineageId, int expectedHead, Proposal proposal) {
        try {
            return regionLedger.append(tenantId, principalId, lineageId, expectedHead, proposal);
        } catch (StaleHeadException stale) {
            throw staleBase(stale.expected(), stale.actual());
        } catch (IllegalStateException unavailable) {
            throw ledgerUnavailable();
        }
    }

    private static void requireHead(int baseVersion, Version head) {
        if (baseVersion != head.versionNumber()) throw staleBase(baseVersion, head.versionNumber());
    }

    private static RegionEditRefusedException staleBase(int expected, int actual) {
        return new RegionEditRefusedException(409, "STALE_BASE_VERSION",
                "the base version is no longer the head of the lineage; reload it and decide again",
                Map.of("expectedVersion", expected, "headVersion", actual));
    }

    private static RegionEditRefusedException ledgerUnavailable() {
        return new RegionEditRefusedException(503, "REGION_EDIT_LEDGER_UNAVAILABLE",
                "the version history is unavailable; nothing was recorded, retry the same requestId", Map.of());
    }

    private List<Version> existing(String tenantId, String principalId, String lineageId) {
        List<Version> rows = versions(tenantId, principalId, MediaDevDubSupport.boundedId(lineageId, "lineageId"));
        if (rows.isEmpty()) {
            throw new RegionEditRefusedException(404, "LINEAGE_NOT_FOUND",
                    "no such lineage in this tenant and owner scope", Map.of());
        }
        return rows;
    }

    private MediaArtifact exact(String tenantId, String principalId, String artifactId, String versionId) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(found -> found.version().value().equals(versionId))
                .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
    }

    private MediaDevDubSupport.Rights requireProcessing(String tenantId, String principalId, MediaArtifact artifact) {
        try {
            return support.requireProcessing(tenantId, principalId, artifact);
        } catch (MediaDevSpeechRuntime.SpeechRefusedException refused) {
            throw new RegionEditRefusedException(refused.status(), refused.code(), refused.getMessage(), refused.details());
        }
    }

    // ------------------------------------------------------------------ track trust

    /**
     * The track must be a tracks artifact this launcher produced for this principal (a COMPLETED {@code vision.track}
     * ledger entry names exactly this artifact version), computed on the lineage's root source, and agree with the
     * video's own frame timeline frame for frame. An uploaded file that merely claims to be a track is refused.
     */
    private TrackInput loadTrack(String tenantId, String principalId, TrackRef ref, MediaArtifact root, VideoTimeline timeline) {
        MediaArtifact artifact;
        try {
            artifact = exact(tenantId, principalId, ref.artifactId(), ref.artifactVersionId());
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException missing) {
            throw new RegionEditRefusedException(404, "TRACK_NOT_FOUND",
                    "the tracks artifact version is not available to this principal", Map.of());
        }
        Map<String, Object> metadata = artifact.metadata();
        if (!"application/json".equalsIgnoreCase(artifact.contentType())
                || !MediaDevVisionTrackingRuntime.KIND_TRACKS.equals(metadata.get("kind"))
                || !MediaDevVisionRuntime.SCHEMA.equals(metadata.get("visionSchema"))
                || !(metadata.get("requestId") instanceof String trackRequestId)) {
            throw untrusted("TRACK_NOT_A_TRACKS_ARTIFACT", "the artifact is not a launcher tracks artifact");
        }
        boolean produced;
        try {
            produced = requestLedger.find(tenantId, principalId, MediaDevVisionTrackingRuntime.LANE_TRACK, trackRequestId)
                    .filter(entry -> entry.state() == com.ghatana.media.runtime.MediaRequestLedgerContracts.State.COMPLETED)
                    .map(entry -> entry.outputs().stream().anyMatch(output -> output.artifactId().equals(artifact.artifactId())
                            && output.versionId().equals(artifact.version().value())))
                    .orElse(false);
        } catch (IllegalArgumentException malformedRequestId) {
            produced = false;
        }
        if (!produced) {
            throw untrusted("TRACK_PROVENANCE_UNVERIFIED",
                    "no completed launcher vision.track request of this principal produced this artifact version");
        }
        if (!(metadata.get("source") instanceof Map<?, ?> source)
                || !root.artifactId().equals(source.get("artifactId"))
                || !root.version().value().equals(source.get("artifactVersionId"))
                || !root.sha256().equals(source.get("sha256"))) {
            throw untrusted("TRACK_SOURCE_MISMATCH", "the track was not computed on this lineage's original video");
        }
        JsonNode document = readTrackDocument(tenantId, principalId, artifact);
        if (!MediaDevVisionTrackingRuntime.TRACKS_SCHEMA.equals(document.path("schema").asString(""))
                || !root.sha256().equals(document.path("source").path("sha256").asString(""))) {
            throw untrusted("TRACK_SOURCE_MISMATCH", "the tracks document does not describe this lineage's original video");
        }
        JsonNode video = document.path("video");
        if (video.path("width").asInt(-1) != timeline.width() || video.path("height").asInt(-1) != timeline.height()
                || video.path("timeBase").path("num").asLong(-1) != timeline.timeBaseNum()
                || video.path("timeBase").path("den").asLong(-1) != timeline.timeBaseDen()
                || video.path("frameCount").asInt(-1) != timeline.frames().size()) {
            throw untrusted("TRACK_TIMELINE_MISMATCH", "the track's video geometry or time base differs from the video");
        }
        for (JsonNode frame : document.path("frames")) {
            int index = frame.path("frameIndex").asInt(-1);
            if (index < 0 || index >= timeline.frames().size() || timeline.frames().get(index).pts() != frame.path("pts").asLong(Long.MIN_VALUE)) {
                throw untrusted("TRACK_TIMELINE_MISMATCH", "a sampled frame's PTS differs from the video's frame timeline");
            }
        }
        JsonNode chosen = null;
        for (JsonNode candidate : document.path("tracks")) {
            if (ref.trackId().equals(candidate.path("trackId").asString(""))) chosen = candidate;
        }
        if (chosen == null) {
            throw new RegionEditRefusedException(404, "TRACK_ID_NOT_FOUND", "the tracks document has no such trackId", Map.of());
        }
        List<Observation> observations = new ArrayList<>();
        try {
            for (JsonNode o : chosen.path("observations")) {
                JsonNode box = o.path("box");
                SourceBox checked = new SourceBox(box.path("x").asDouble(Double.NaN), box.path("y").asDouble(Double.NaN),
                        box.path("width").asDouble(Double.NaN), box.path("height").asDouble(Double.NaN));
                if (!checked.withinFrame(timeline.width(), timeline.height())) {
                    throw new IllegalArgumentException("an observation box is outside the frame");
                }
                observations.add(new Observation(o.path("frameIndex").asInt(-1), o.path("pts").asLong(Long.MIN_VALUE),
                        checked.x(), checked.y(), checked.width(), checked.height()));
            }
            MediaDevRegionMask.requireOrdered(observations,
                    timeline.frames().stream().mapToLong(VideoTimeline.FrameTime::pts).toArray());
        } catch (IllegalArgumentException refused) {
            throw untrusted("TRACK_TIMELINE_MISMATCH", refused.getMessage());
        }
        Map<String, Object> model = document.path("model").isObject()
                ? JSON.convertValue(document.path("model"), new TypeReference<LinkedHashMap<String, Object>>() { })
                : Map.of();
        return new TrackInput(artifact, ref.trackId(), chosen.path("label").asString(""), observations, model);
    }

    private JsonNode readTrackDocument(String tenantId, String principalId, MediaArtifact artifact) {
        try {
            return support.readDocument(tenantId, principalId, artifact);
        } catch (MediaDevSpeechRuntime.SpeechRefusedException unreadable) {
            throw untrusted("TRACK_DOCUMENT_INVALID", "the tracks artifact is not a readable bounded JSON document");
        }
    }

    private static RegionEditRefusedException untrusted(String code, String message) {
        return new RegionEditRefusedException(422, code, message, Map.of());
    }

    // ------------------------------------------------------------------ probe

    private Geometry probeSource(Path video, Path dir) throws IOException {
        BoundedProcessRunner.Result streams = BoundedProcessRunner.run(List.of(ffprobe.toString(), "-v", "error",
                "-show_entries", "stream=index,codec_type,pix_fmt,width,height,color_space,color_primaries,color_transfer,color_range",
                "-of", "json", video.toString()), dir, Map.of(), PROBE_TIMEOUT, 1 << 20, 8192,
                BoundedProcessRunner.CancellationToken.NEVER, null, 0);
        classify(streams, "probe", "SOURCE_NOT_PROBEABLE");
        JsonNode root = parseJson(streams.stdout(), "SOURCE_NOT_PROBEABLE");
        JsonNode list = root.path("streams");
        if (!list.isArray() || list.size() != 1 || !"video".equals(list.get(0).path("codec_type").asString(""))) {
            throw new RegionEditRefusedException(422, "SOURCE_STREAMS_UNSUPPORTED",
                    "the video must have exactly one video stream and no audio or other streams", Map.of());
        }
        JsonNode stream = list.get(0);
        if (!"yuv420p".equals(stream.path("pix_fmt").asString(""))) {
            throw new RegionEditRefusedException(422, "SOURCE_PIXEL_FORMAT_UNSUPPORTED",
                    "only yuv420p video is supported, so samples outside the mask can stay bit-exact",
                    Map.of("pixelFormat", stream.path("pix_fmt").asString("")));
        }
        BoundedProcessRunner.Result frames = BoundedProcessRunner.run(List.of(ffprobe.toString(), "-v", "error",
                "-select_streams", "v:0", "-show_entries",
                "frame=pts,best_effort_timestamp:stream=width,height,time_base:stream_side_data=rotation",
                "-of", "json", video.toString()), dir, Map.of(), PROBE_TIMEOUT, 24 * 1024 * 1024, 8192,
                BoundedProcessRunner.CancellationToken.NEVER, null, 0);
        classify(frames, "probe", "SOURCE_NOT_PROBEABLE");
        VideoTimeline timeline;
        try {
            timeline = VideoTimeline.parse(new String(frames.stdout(), StandardCharsets.UTF_8));
        } catch (VideoTimeline.TimelineException untrustedTimeline) {
            throw new RegionEditRefusedException(422, "VIDEO_TIMELINE_UNTRUSTED",
                    "the video frame timeline is not usable: " + untrustedTimeline.getMessage(), Map.of());
        }
        if (timeline.frames().size() > MAX_FRAMES || (long) timeline.width() * timeline.height() > MAX_PIXELS) {
            throw new RegionEditRefusedException(422, "REGION_EDIT_LIMIT_EXCEEDED",
                    "the video exceeds the frame or pixel ceiling",
                    Map.of("maxFrames", MAX_FRAMES, "maxPixels", MAX_PIXELS));
        }
        if (timeline.width() % 2 != 0 || timeline.height() % 2 != 0) {
            throw new RegionEditRefusedException(422, "SOURCE_GEOMETRY_UNSUPPORTED",
                    "width and height must be even for 4:2:0 masks", Map.of());
        }
        return new Geometry(timeline, new Tags(tag(stream, "color_space"), tag(stream, "color_primaries"),
                tag(stream, "color_transfer"), range(stream)), "ffprobe");
    }

    private static String tag(JsonNode stream, String field) {
        String value = stream.path(field).asString("");
        return value.matches("[a-z0-9-]{1,24}") && !value.equals("unknown") && !value.equals("unspecified")
                && !value.equals("reserved") ? value : null;
    }

    private static String range(JsonNode stream) {
        String value = stream.path("color_range").asString("");
        return value.equals("tv") || value.equals("pc") ? value : null;
    }

    private static JsonNode parseJson(byte[] bytes, String code) {
        try {
            return JSON.readTree(new String(bytes, StandardCharsets.UTF_8));
        } catch (RuntimeException unreadable) {
            throw new RegionEditRefusedException(422, code, "the probe output was not readable", Map.of());
        }
    }

    // ------------------------------------------------------------------ render

    /**
     * Decodes the source to raw yuv420p frames (every frame, PTS order, no rate conversion), applies the effect inside
     * each frame's mask and encodes the result with every frame's source PTS restored exactly through a generated
     * {@code setpts} table. The encoder is single-threaded and bit-exact; the request id is in the container comment so two
     * requests never share bytes.
     */
    private void renderPipeline(Path input, Path output, Path dir, Geometry geometry, long[] pts, List<FrameMask> masks,
                                EditRequest request, String maskSha) throws IOException {
        VideoTimeline timeline = geometry.timeline();
        int width = timeline.width();
        int height = timeline.height();
        int frameBytes = MediaDevRegionPixels.frameBytes(width, height);
        StringBuilder table = new StringBuilder("settb=1/").append(timeline.timeBaseDen()).append(",setpts='");
        if (timeline.timeBaseNum() != 1) {
            throw new RegionEditRefusedException(422, "VIDEO_TIMELINE_UNTRUSTED",
                    "only a time base of the form 1/N is supported", Map.of());
        }
        for (int i = 0; i < pts.length; i++) {
            if (i > 0) table.append('+');
            table.append("eq(N\\,").append(i).append(")*").append(pts[i]);
        }
        table.append('\'');
        Path script = dir.resolve("pts.filter");
        Files.writeString(script, table.toString(), StandardCharsets.US_ASCII);

        List<String> decode = List.of(ffmpeg.toString(), "-nostdin", "-v", "error", "-i", input.toString(), "-an", "-sn",
                "-dn", "-map", "0:v:0", "-fps_mode", "passthrough", "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1");
        List<String> encode = new ArrayList<>(List.of(ffmpeg.toString(), "-nostdin", "-hide_banner", "-v", "error",
                "-xerror", "-f", "rawvideo", "-pix_fmt", "yuv420p", "-s", width + "x" + height, "-framerate", "25",
                "-i", "pipe:0", "-filter_script:v", script.toString(), "-c:v", "libx264"));
        if (request.crf() == 0) {
            encode.addAll(List.of("-qp", "0", "-preset", "medium"));
        } else {
            encode.addAll(List.of("-crf", Integer.toString(request.crf()), "-preset", "medium", "-profile:v", "high"));
        }
        encode.addAll(List.of("-pix_fmt", "yuv420p", "-bf", "0", "-threads", "1"));
        Tags tags = geometry.tags();
        if (tags.colorSpace() != null) encode.addAll(List.of("-colorspace", tags.colorSpace()));
        if (tags.colorPrimaries() != null) encode.addAll(List.of("-color_primaries", tags.colorPrimaries()));
        if (tags.colorTransfer() != null) encode.addAll(List.of("-color_trc", tags.colorTransfer()));
        if (tags.colorRange() != null) encode.addAll(List.of("-color_range", tags.colorRange()));
        encode.addAll(List.of("-fflags", "+bitexact", "-flags:v", "+bitexact", "-map_metadata", "-1",
                "-metadata", "comment=media.dev.region-edit request=" + request.requestId() + " mask=" + maskSha,
                "-video_track_timescale", Long.toString(timeline.timeBaseDen()), "-fps_mode", "passthrough",
                "-use_editlist", "0", "-movflags", "+faststart", "-an", "-y", output.toString()));

        Path decodeErr = dir.resolve("decode.err");
        Path encodeErr = dir.resolve("encode.err");
        Process decoder = start(decode, dir, decodeErr, null);
        Process encoder;
        try {
            encoder = start(encode, dir, encodeErr, null);
        } catch (IOException failure) {
            decoder.destroyForcibly();
            throw failure;
        }
        Watchdog watchdog = new Watchdog(List.of(decoder, encoder), output, MAX_OUTPUT_BYTES, PIPELINE_TIMEOUT);
        watchdog.start();
        boolean frameCountMismatch = false;
        try (InputStream raw = decoder.getInputStream(); OutputStream sink = encoder.getOutputStream()) {
            byte[] frame = new byte[frameBytes];
            for (int i = 0; i < masks.size(); i++) {
                int read = raw.readNBytes(frame, 0, frameBytes);
                if (read != frameBytes) {
                    frameCountMismatch = true;
                    break;
                }
                Rect rect = masks.get(i).rect();
                if (rect != null) MediaDevRegionPixels.apply(frame, width, height, rect, request.effect());
                sink.write(frame);
            }
            if (!frameCountMismatch && raw.read() != -1) frameCountMismatch = true;
        } catch (IOException pipeFailure) {
            // The encoder or decoder went away: classified below from the exit codes and the watchdog.
            log.debug("region edit pipe closed early");
        } finally {
            watchdog.stopAfter(encoder, decoder);
        }
        if (watchdog.fired()) {
            if (watchdog.outputTooLarge()) {
                throw new RegionEditRefusedException(422, "REGION_EDIT_OUTPUT_TOO_LARGE",
                        "the encoded video exceeds the output byte ceiling; use a lossy crf or a shorter clip",
                        Map.of("limit", MAX_OUTPUT_BYTES));
            }
            throw new RegionEditOutcomeUnknownException("render");
        }
        int decoderExit = exit(decoder);
        int encoderExit = exit(encoder);
        if (signalled(decoderExit) || signalled(encoderExit)) throw new RegionEditOutcomeUnknownException("render");
        if (decoderExit != 0) {
            throw new RegionEditRefusedException(422, "SOURCE_NOT_DECODABLE",
                    "the video could not be decoded to the end; nothing was registered", Map.of());
        }
        if (frameCountMismatch) {
            throw new RegionEditRefusedException(422, "VIDEO_TIMELINE_UNTRUSTED",
                    "the decoded frame count differs from the probed timeline; nothing was registered", Map.of());
        }
        if (encoderExit != 0 || !Files.isRegularFile(output)) {
            throw new RegionEditRefusedException(422, "REGION_EDIT_ENCODE_FAILED",
                    "the encode step failed; nothing was registered", Map.of());
        }
    }

    private static Process start(List<String> command, Path dir, Path stderr, Path stdout) throws IOException {
        ProcessBuilder builder = new ProcessBuilder(command).directory(dir.toFile())
                .redirectError(ProcessBuilder.Redirect.to(stderr.toFile()));
        if (stdout != null) builder.redirectOutput(ProcessBuilder.Redirect.to(stdout.toFile()));
        builder.environment().clear();
        return builder.start();
    }

    private static int exit(Process process) {
        try {
            return process.waitFor();
        } catch (InterruptedException interrupted) {
            process.destroyForcibly();
            Thread.currentThread().interrupt();
            return 137;
        }
    }

    private static boolean signalled(int exitCode) { return exitCode >= 128 || exitCode < 0; }

    /** Kills both processes at the deadline or when the output file passes its ceiling. */
    private static final class Watchdog extends Thread {
        private final List<Process> processes;
        private final Path output;
        private final long maxBytes;
        private final long deadline;
        private volatile boolean done;
        private volatile boolean fired;
        private volatile boolean tooLarge;

        Watchdog(List<Process> processes, Path output, long maxBytes, Duration timeout) {
            super("media-dev-region-edit-watchdog");
            setDaemon(true);
            this.processes = processes;
            this.output = output;
            this.maxBytes = maxBytes;
            this.deadline = System.nanoTime() + timeout.toNanos();
        }

        @Override public void run() {
            while (!done) {
                try {
                    long size = Files.exists(output) ? Files.size(output) : 0;
                    if (size > maxBytes) {
                        tooLarge = true;
                        kill();
                        return;
                    }
                } catch (IOException ignored) { /* the file may be mid-creation */ }
                if (System.nanoTime() >= deadline) {
                    kill();
                    return;
                }
                try {
                    Thread.sleep(200);
                } catch (InterruptedException interrupted) {
                    return;
                }
            }
        }

        private void kill() {
            fired = true;
            for (Process process : processes) process.destroyForcibly();
        }

        void stopAfter(Process encoder, Process decoder) {
            exit(encoder);
            exit(decoder);
            done = true;
            interrupt();
        }

        boolean fired() { return fired; }
        boolean outputTooLarge() { return tooLarge; }
    }

    // ------------------------------------------------------------------ verification

    private Verification verify(Path source, Path output, Path dir, Geometry geometry, long[] pts, List<FrameMask> masks,
                                EditRequest request) throws IOException {
        VideoTimeline timeline = geometry.timeline();
        BoundedProcessRunner.Result probe = BoundedProcessRunner.run(List.of(ffprobe.toString(), "-v", "error",
                "-select_streams", "v:0", "-show_entries",
                "stream=codec_name,profile,pix_fmt,width,height,time_base,nb_read_frames:frame=pts", "-of", "json",
                output.toString()), dir, Map.of(), PROBE_TIMEOUT, 4 * 1024 * 1024, 8192,
                BoundedProcessRunner.CancellationToken.NEVER, null, 0);
        classify(probe, "probe", "REGION_EDIT_VERIFICATION_FAILED");
        JsonNode root = parseJson(probe.stdout(), "REGION_EDIT_VERIFICATION_FAILED");
        JsonNode stream = root.path("streams").path(0);
        List<Long> outPts = new ArrayList<>();
        for (JsonNode frame : root.path("frames")) outPts.add(frame.path("pts").asLong(Long.MIN_VALUE));
        outPts.sort(Comparator.naturalOrder());
        String problem = null;
        if (!"h264".equals(stream.path("codec_name").asString())) problem = "codec";
        else if (!"yuv420p".equals(stream.path("pix_fmt").asString())) problem = "pixel format";
        else if (stream.path("width").asInt() != timeline.width() || stream.path("height").asInt() != timeline.height()) problem = "geometry";
        else if (!("1/" + timeline.timeBaseDen()).equals(stream.path("time_base").asString())) problem = "time base";
        else if (outPts.size() != pts.length) problem = "frame count";
        for (int i = 0; problem == null && i < pts.length; i++) {
            if (outPts.get(i) != pts[i]) problem = "frame " + i + " presentation timestamp";
        }
        if (problem != null) {
            throw new RegionEditRefusedException(500, "REGION_EDIT_VERIFICATION_FAILED",
                    "the encoded video does not match the source timeline (" + problem + "); nothing was registered",
                    Map.of("mismatch", problem));
        }
        int frameBytes = MediaDevRegionPixels.frameBytes(timeline.width(), timeline.height());
        MediaDevRegionPixels.Comparison comparison = new MediaDevRegionPixels.Comparison();
        List<Double> insideMean = new ArrayList<>();
        Process before = start(decodeCommand(source), dir, dir.resolve("verify-source.err"), null);
        Process after;
        try {
            after = start(decodeCommand(output), dir, dir.resolve("verify-output.err"), null);
        } catch (IOException failure) {
            before.destroyForcibly();
            throw failure;
        }
        Watchdog watchdog = new Watchdog(List.of(before, after), dir.resolve("none"), Long.MAX_VALUE, PIPELINE_TIMEOUT);
        watchdog.start();
        boolean truncated = false;
        try (InputStream a = before.getInputStream(); InputStream b = after.getInputStream()) {
            byte[] sourceFrame = new byte[frameBytes];
            byte[] editedFrame = new byte[frameBytes];
            for (int i = 0; i < masks.size(); i++) {
                if (a.readNBytes(sourceFrame, 0, frameBytes) != frameBytes || b.readNBytes(editedFrame, 0, frameBytes) != frameBytes) {
                    truncated = true;
                    break;
                }
                double mean = comparison.compareFrame(sourceFrame, editedFrame, timeline.width(), timeline.height(),
                        masks.get(i).rect());
                if (masks.get(i).rect() != null) insideMean.add(MediaDevRegionMask.round3(mean));
            }
        } catch (IOException pipeFailure) {
            truncated = true;
        } finally {
            watchdog.stopAfter(before, after);
        }
        if (watchdog.fired()) throw new RegionEditOutcomeUnknownException("verification");
        if (truncated) {
            throw new RegionEditRefusedException(500, "REGION_EDIT_VERIFICATION_FAILED",
                    "the edited video could not be decoded frame for frame; nothing was registered", Map.of());
        }
        Double psnr = comparison.outsidePsnrDb();
        boolean lossless = request.crf() == 0;
        if (lossless && comparison.outsideMaxAbsDiff != 0) {
            throw new RegionEditRefusedException(500, "REGION_EDIT_VERIFICATION_FAILED",
                    "samples outside the masks changed in a lossless edit; nothing was registered",
                    Map.of("outsideMaxAbsDiff", comparison.outsideMaxAbsDiff));
        }
        if (!lossless && psnr != null && psnr < LOSSY_OUTSIDE_MIN_PSNR_DB) {
            throw new RegionEditRefusedException(500, "REGION_EDIT_VERIFICATION_FAILED",
                    "samples outside the masks drifted more than a lossy encode allows; nothing was registered",
                    Map.of("outsidePsnrDb", psnr));
        }
        if (comparison.insideChangedSamples == 0) {
            throw new RegionEditRefusedException(422, "REGION_EDIT_NO_VISIBLE_CHANGE",
                    "the effect changed no sample inside any mask (the region may already be flat); nothing was registered",
                    Map.of());
        }
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("verifiedBy", "ffprobe stream+frame pts on the output; independent decode of source and output, sample by sample");
        summary.put("codec", "h264");
        summary.put("profile", stream.path("profile").asString(""));
        summary.put("pixelFormat", "yuv420p");
        summary.put("frameCount", pts.length);
        summary.put("timeBase", "1/" + timeline.timeBaseDen());
        summary.put("ptsExact", true);
        summary.put("outsideLossless", lossless);
        summary.put("outsideSamples", comparison.outsideSamples);
        summary.put("outsideMaxAbsDiff", comparison.outsideMaxAbsDiff);
        summary.put("outsidePsnrDb", psnr == null ? "INFINITE" : psnr);
        summary.put("insideSamples", comparison.insideSamples);
        summary.put("insideChangedSamples", comparison.insideChangedSamples);
        summary.put("insideMeanAbsDiffLuma", insideMean);
        return new Verification(summary, insideMean, comparison.insideChangedSamples, comparison.outsideMaxAbsDiff, psnr);
    }

    private List<String> decodeCommand(Path file) {
        return List.of(ffmpeg.toString(), "-nostdin", "-v", "error", "-i", file.toString(), "-an", "-sn", "-dn", "-map",
                "0:v:0", "-fps_mode", "passthrough", "-pix_fmt", "yuv420p", "-f", "rawvideo", "pipe:1");
    }

    /** Throws unless the process exited 0. A signal exit or a timeout is UNKNOWN; any other exit is a typed failure. */
    private static void classify(BoundedProcessRunner.Result result, String phase, String failureCode) {
        if (result.succeeded()) return;
        boolean signalled = result.end() == BoundedProcessRunner.End.EXITED && signalled(result.exitCode());
        if (result.end() == BoundedProcessRunner.End.TIMED_OUT || result.end() == BoundedProcessRunner.End.CANCELLED || signalled) {
            throw new RegionEditOutcomeUnknownException(phase);
        }
        throw new RegionEditRefusedException(422, failureCode, "the " + phase + " step failed; nothing was registered", Map.of());
    }

    // ------------------------------------------------------------------ registration

    private Outcome register(String tenantId, String principalId, String lineageId, EditRequest request,
                             MediaArtifact headArtifact, MediaArtifact rootArtifact, Version head, TrackInput track,
                             Geometry geometry, List<FrameMask> masks, MediaDevRegionMask.Drift drift, String maskSha,
                             Verification verification, byte[] mp4, MediaDevDubSupport.Rights decision) {
        String mp4Sha = MediaDevProjectRenderRuntime.sha256Hex(mp4);
        Map<String, Object> effect = effectView(request.effect());
        Map<String, Object> encoder = new LinkedHashMap<>();
        encoder.put("videoCodec", "libx264");
        encoder.put("crf", request.crf());
        encoder.put("lossless", request.crf() == 0);
        encoder.put("preset", "medium");
        encoder.put("bFrames", 0);
        encoder.put("threads", 1);
        encoder.put("pixelFormat", "yuv420p");
        encoder.put("timescale", geometry.timeline().timeBaseDen());
        encoder.put("tool", ffmpegVersion());
        Map<String, Object> trackRef = new LinkedHashMap<>(MediaDevDubSupport.ref(track.artifact()));
        trackRef.put("trackId", track.trackId());
        trackRef.put("label", track.label());
        trackRef.put("observations", track.observations().size());
        trackRef.put("model", track.model());
        Map<String, Object> driftView = driftView(drift);
        String claims = "DEV_ONLY region edit: a deterministic effect inside a mask interpolated from a local open-model track. "
                + "The mask follows the detector's boxes, not ground truth; no accuracy, rights, approval or production claim";

        Map<String, Object> shared = new LinkedHashMap<>();
        shared.put("regionEditSchema", SCHEMA);
        shared.put("scope", "DEV_ONLY");
        shared.put("requestId", request.requestId());
        shared.put("lineageId", lineageId);
        shared.put("source", MediaDevDubSupport.ref(rootArtifact));
        shared.put("parent", MediaDevDubSupport.ref(headArtifact));
        shared.put("baseVersionNumber", head.versionNumber());
        shared.put("track", trackRef);
        shared.put("effect", effect);
        shared.put("paddingPx", request.paddingPx());
        shared.put("holdEnds", request.holdEnds());
        shared.put("maskSha256", maskSha);
        shared.put("drift", driftView);
        shared.put("encoder", encoder);
        shared.put("rightsDecision", rightsView(decision));
        shared.put("claims", claims);

        Map<String, Object> videoLineage = new LinkedHashMap<>(shared);
        videoLineage.put("kind", KIND_VIDEO);
        videoLineage.put("resultSha256", mp4Sha);
        videoLineage.put("verification", verification.summary());
        MediaArtifact video = registerOne(tenantId, principalId, "video", request.requestId(), mp4, "video/mp4", "mp4",
                "region-edit-" + MediaDevDubSupport.safeName(request.requestId()), videoLineage);

        Map<String, Object> manifest = new LinkedHashMap<>();
        manifest.put("schema", MANIFEST_SCHEMA);
        manifest.put("scope", "DEV_ONLY");
        manifest.put("requestId", request.requestId());
        manifest.put("lineageId", lineageId);
        manifest.put("baseVersionNumber", head.versionNumber());
        manifest.put("source", MediaDevDubSupport.ref(rootArtifact));
        manifest.put("base", MediaDevDubSupport.ref(headArtifact));
        manifest.put("video", MediaDevDubSupport.ref(video));
        manifest.put("track", trackRef);
        manifest.put("effect", effect);
        manifest.put("paddingPx", request.paddingPx());
        manifest.put("holdEnds", request.holdEnds());
        Map<String, Object> geometryView = new LinkedHashMap<>();
        geometryView.put("width", geometry.timeline().width());
        geometryView.put("height", geometry.timeline().height());
        geometryView.put("coordinateSpace", "SOURCE_FRAME_PIXELS_TOP_LEFT_ORIGIN");
        geometryView.put("timeBase", Map.of("num", geometry.timeline().timeBaseNum(), "den", geometry.timeline().timeBaseDen()));
        geometryView.put("frameCount", masks.size());
        geometryView.put("variableFrameRate", geometry.timeline().variableFrameRate());
        manifest.put("videoGeometry", geometryView);
        manifest.put("maskDefinition", "box interpolated linearly in exact PTS between tracker observations, padded by paddingPx "
                + "and snapped outward to even pixel coordinates, clamped to the frame");
        manifest.put("maskSha256", maskSha);
        List<Map<String, Object>> frames = new ArrayList<>();
        int masked = 0;
        for (FrameMask mask : masks) {
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("frameIndex", mask.frameIndex());
            entry.put("pts", mask.pts());
            entry.put("ptsMicros", geometry.timeline().ptsMicros(mask.pts()));
            entry.put("source", mask.source());
            if (mask.rect() != null) {
                entry.put("mask", Map.of("x", mask.rect().x(), "y", mask.rect().y(), "width", mask.rect().width(),
                        "height", mask.rect().height()));
                masked++;
            } else {
                entry.put("mask", null);
            }
            frames.add(entry);
        }
        manifest.put("frames", frames);
        manifest.put("maskedFrames", masked);
        manifest.put("drift", driftView);
        manifest.put("encoder", encoder);
        manifest.put("verification", verification.summary());
        manifest.put("rightsDecision", rightsView(decision));
        manifest.put("claims", claims);
        Map<String, Object> manifestLineage = new LinkedHashMap<>(shared);
        manifestLineage.put("kind", KIND_MANIFEST);
        manifestLineage.put("siblings", Map.of("video", MediaDevDubSupport.ref(video)));
        MediaArtifact manifestArtifact = registerOne(tenantId, principalId, "manifest", request.requestId(),
                MediaDevDubSupport.json(manifest), "application/json", "json",
                "region-edit-manifest-" + MediaDevDubSupport.safeName(request.requestId()), manifestLineage);

        Map<String, Object> detail = new LinkedHashMap<>();
        detail.put("kind", "EDIT");
        detail.put("track", trackRef);
        detail.put("effect", effect);
        detail.put("paddingPx", request.paddingPx());
        detail.put("holdEnds", request.holdEnds());
        detail.put("maskedFrames", masked);
        detail.put("maskSha256", maskSha);
        detail.put("drift", driftView);
        detail.put("outsideMaxAbsDiff", verification.outsideMaxAbsDiff());
        detail.put("outsidePsnrDb", verification.outsidePsnrDb() == null ? "INFINITE" : verification.outsidePsnrDb());
        detail.put("insideChangedSamples", verification.insideChanged());
        detail.put("encoder", encoder);
        detail.put("rightsDecision", rightsView(decision));
        Proposal proposal = new Proposal(Kind.EDIT, request.requestId(), video.artifactId(), video.version().value(),
                video.sha256(), video.sizeBytes(), manifestArtifact.artifactId(), manifestArtifact.version().value(), null,
                json(detail));
        // The compare-and-set: of concurrent editors of this head exactly one appends; the loser's rendered artifacts stay
        // registered but unreferenced by the lineage.
        Appended appended = append(tenantId, principalId, lineageId, head.versionNumber(), proposal);
        return new Outcome(appended.version(), manifest, appended.deduplicated());
    }

    private MediaArtifact registerOne(String tenantId, String principalId, String role, String requestId, byte[] bytes,
                                      String contentType, String extension, String namePrefix, Map<String, Object> lineage) {
        String sha256 = MediaDevProjectRenderRuntime.sha256Hex(bytes);
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "region-edit-output");
        UploadRequest upload = new UploadRequest(tenantId, principalId, namePrefix + "." + extension, contentType,
                bytes.length, sha256, "INTERNAL", Duration.ofDays(30), metadata);
        String idempotencyKey = "dev-region:" + role + ":" + MediaDevProjectRenderRuntime.sha256Hex(
                tenantId + "\u0000" + principalId + "\u0000" + requestId);
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new RegionEditRequestReusedException();
            }
            throw new RegionEditRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new RegionEditRegistrationFailedException(failure);
        }
        MediaArtifact artifact = registered.artifact();
        if (!artifact.sha256().equals(sha256)) {
            throw new RegionEditRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match produced bytes"));
        }
        return artifact;
    }

    // ------------------------------------------------------------------ views

    /** Wire view of one version; {@code artifact.metadataSha256} is the digest of the stored artifact record's metadata. */
    Map<String, Object> versionView(String tenantId, String principalId, Version version) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("versionNumber", version.versionNumber());
        view.put("kind", version.kind().name());
        view.put("requestId", version.requestId());
        view.put("parentVersionNumber", version.parentVersionNumber());
        view.put("restoresVersionNumber", version.restoresVersionNumber());
        Map<String, Object> artifact = new LinkedHashMap<>();
        artifact.put("artifactId", version.artifactId());
        artifact.put("artifactVersionId", version.artifactVersionId());
        artifact.put("sha256", version.contentSha256());
        artifact.put("sizeBytes", version.sizeBytes());
        artifact.put("metadataSha256", metadataDigest(tenantId, principalId, version.artifactId()));
        artifact.put("contentPath", "/dev/v1/artifacts/" + version.artifactId() + "/content");
        view.put("artifact", artifact);
        if (version.manifestArtifactId() != null) {
            view.put("manifestArtifact", Map.of("artifactId", version.manifestArtifactId(),
                    "artifactVersionId", version.manifestArtifactVersionId(),
                    "contentPath", "/dev/v1/artifacts/" + version.manifestArtifactId() + "/content"));
        }
        try {
            view.put("detail", JSON.readValue(version.detailJson(), new TypeReference<LinkedHashMap<String, Object>>() { }));
        } catch (RuntimeException unreadable) {
            view.put("detail", Map.of());
        }
        view.put("createdAt", version.createdAt().toString());
        return view;
    }

    /** SHA-256 over the canonical (sorted-key) JSON of the artifact record's metadata; null when unreadable. */
    private String metadataDigest(String tenantId, String principalId, String artifactId) {
        try {
            Optional<MediaArtifact> artifact = runtime.artifact(tenantId, principalId, artifactId);
            if (artifact.isEmpty()) return null;
            return MediaDevProjectRenderRuntime.sha256Hex(JSON.writeValueAsString(sorted(artifact.get().metadata())));
        } catch (RuntimeException unreadable) {
            return null;
        }
    }

    private static Object sorted(Object value) {
        if (value instanceof Map<?, ?> map) {
            Map<String, Object> out = new TreeMap<>();
            for (Map.Entry<?, ?> entry : map.entrySet()) out.put(String.valueOf(entry.getKey()), sorted(entry.getValue()));
            return out;
        }
        if (value instanceof List<?> list) {
            List<Object> out = new ArrayList<>();
            for (Object item : list) out.add(sorted(item));
            return out;
        }
        return value;
    }

    private static Map<String, Object> effectView(Effect effect) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("type", effect.type().name());
        switch (effect.type()) {
            case PIXELATE -> view.put("blockSize", effect.blockSize());
            case BLUR -> {
                view.put("radius", effect.radius());
                view.put("passes", 2);
            }
            case FILL -> view.put("color", effect.fillColor());
        }
        return view;
    }

    private static String effectCanonical(Effect effect) {
        return effect.type() + ":" + effect.blockSize() + ":" + effect.radius() + ":" + effect.fillColor();
    }

    private static Map<String, Object> driftView(MediaDevRegionMask.Drift drift) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("method", "leave-one-out linear interpolation of the tracker's own observations in PTS time");
        view.put("observations", drift.observations());
        view.put("maxGapFrames", drift.maxGapFrames());
        view.put("maxGapTicks", drift.maxGapTicks());
        view.put("heldOutObservations", drift.heldOutObservations());
        view.put("maxCenterErrorPx", drift.maxCenterErrorPx());
        view.put("meanCenterErrorPx", drift.meanCenterErrorPx());
        view.put("minIou", drift.minIou());
        return view;
    }

    private static Map<String, Object> rightsView(MediaDevDubSupport.Rights decision) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("kind", "RIGHTS_CONSENT_ATTESTATION");
        view.put("scope", Scope.PROCESSING.name());
        view.put("evidenceRef", decision.evidenceRef());
        view.put("subjects", decision.subjects());
        view.put("productionGrant", false);
        return view;
    }

    private static String json(Object value) {
        try {
            return JSON.writeValueAsString(value);
        } catch (RuntimeException failure) {
            throw new IllegalStateException("value could not be serialized", failure);
        }
    }

    private String ffmpegVersion() {
        String known = ffmpegVersion;
        if (known != null) return known;
        try {
            BoundedProcessRunner.Result result = BoundedProcessRunner.run(List.of(ffmpeg.toString(), "-version"), null,
                    Map.of(), Duration.ofSeconds(20), 8192, 8192, BoundedProcessRunner.CancellationToken.NEVER, null, 0);
            String first = new String(result.stdout(), StandardCharsets.UTF_8).lines().findFirst().orElse("ffmpeg");
            known = first.length() > 120 ? first.substring(0, 120) : first;
        } catch (IOException failure) {
            known = "ffmpeg (version unavailable)";
        }
        ffmpegVersion = known;
        return known;
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("DEV_ONLY region edit is closed");
    }

    private static Path privateTempDirectory() {
        try {
            return Files.createTempDirectory("media-dev-region-edit-",
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        } catch (IOException failure) {
            throw new IllegalStateException("private working directory could not be created", failure);
        }
    }

    private static void deleteTree(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
        } catch (IOException ignored) {
            // best effort: the directory is private (0700) under the OS temp root
        }
    }

    @Override public void close() {
        if (closed.compareAndSet(false, true)) regionLedger.close();
    }
}
