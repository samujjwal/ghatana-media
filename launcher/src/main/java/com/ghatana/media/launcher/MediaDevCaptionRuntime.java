package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * DEV_ONLY human caption correction (outside the canonical manifest/OpenAPI).
 *
 * <p>A correction takes one exact owner-visible WebVTT caption version (the unreviewed Whisper rendering from
 * {@link MediaDevSpeechRuntime}, or an earlier correction) and registers the caller's edited cues as a NEW immutable
 * {@code text/vtt} artifact. The base is never modified. Lineage records the exact parent version and digest, the
 * machine version the chain started from, the corrector principal (the authenticated caller; no request field names a
 * principal), the source audio and the rights decision.</p>
 *
 * <ul>
 *   <li><b>Optimistic concurrency, no overwrite:</b> the request names the exact version it edited
 *       ({@code expectedVersionId}); a different current version is {@code CAPTION_VERSION_CONFLICT}. Each parent
 *       version has at most one child: the child is registered under an idempotency key derived from the parent, so the
 *       durable idempotency store makes the race between two correctors atomic. The loser gets a conflict.</li>
 *   <li><b>Rights are re-resolved</b> for the exact source audio ({@code Scope.PROCESSING}) on every correction. A
 *       revoked, stale or unavailable decision refuses the correction with no new artifact.</li>
 *   <li><b>Use gate:</b> {@link #captionUseGate()} lets a timeline render require that the exact caption version has a
 *       current ACCEPT from an assigned reviewer and still-admitted rights.</li>
 * </ul>
 *
 * <p>Honesty boundary: the corrector is a DEV_ONLY authenticated principal, not a verified human; a correction is a
 * statement by that principal, makes no quality or approval claim and authorizes no delivery.</p>
 */
public final class MediaDevCaptionRuntime {
    public static final String SCHEMA = "media.dev.caption-version.v1";
    public static final String KIND_CORRECTED = "LOCAL_CAPTION_USER_CORRECTED";
    public static final String REVIEW_REQUIRED_ENV = "MEDIA_DEV_CAPTION_REVIEW_REQUIRED";
    static final long MAX_MILLIS = 24L * 3_600_000L;

    record CueInput(long startMillis, long endMillis, String text) { }

    public record CorrectionRequest(String requestId, String baseArtifactId, String expectedVersionId,
                                    List<CueInput> cues) {
        public CorrectionRequest {
            requestId = boundedId(requestId, "requestId");
            baseArtifactId = boundedId(baseArtifactId, "baseArtifactId");
            expectedVersionId = Objects.requireNonNull(expectedVersionId, "expectedVersionId");
            cues = List.copyOf(Objects.requireNonNull(cues, "cues"));
        }
    }

    /** Registered caption version with its durable lineage and parsed cues. */
    public record CaptionVersion(MediaArtifact artifact, Map<String, Object> lineage, List<MediaDevWebVtt.Cue> cues,
                                 boolean replayed) { }

    /** Typed refusal; code and message never carry content. */
    public static final class CaptionRefusedException extends RuntimeException {
        private final int status;
        private final String code;
        private final Map<String, Object> details;
        CaptionRefusedException(int status, String code, String message) { this(status, code, message, Map.of()); }
        CaptionRefusedException(int status, String code, String message, Map<String, Object> details) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
            this.details = details;
        }
        public int status() { return status; }
        public String code() { return code; }
        public Map<String, Object> details() { return details; }
    }

    public static final class CaptionRegistrationFailedException extends IllegalStateException {
        CaptionRegistrationFailedException(Throwable cause) {
            super("caption version could not be registered as an immutable artifact", cause);
        }
    }

    /** Render-time check that one exact caption version may be used. */
    interface CaptionUseGate {
        /** @throws MediaDevProjectRenderRuntime.RenderNotSupportedException when the exact version may not be used. */
        void requireReviewed(String tenantId, String principalId, MediaArtifact caption);
    }


    private final MediaRuntime runtime;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;
    private final RightsConsentResolver rights;
    private final MediaDevReviewRuntime reviews;
    private final MediaDevRequestLedger ledger;
    static final String LANE_CORRECT = "captions.correct";

    MediaDevCaptionRuntime(MediaRuntime runtime, MediaDevProjectRenderRuntime.OutputRegistrar registrar,
                           RightsConsentResolver rights, MediaDevReviewRuntime reviews) {
        this(runtime, registrar, rights, reviews, MediaDevRequestLedger.inMemory());
    }

    MediaDevCaptionRuntime(MediaRuntime runtime, MediaDevProjectRenderRuntime.OutputRegistrar registrar,
                           RightsConsentResolver rights, MediaDevReviewRuntime reviews,
                           MediaDevRequestLedger ledger) {
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.registrar = Objects.requireNonNull(registrar, "registrar");
        this.rights = rights == null ? RightsConsentResolver.unavailable() : rights;
        this.reviews = reviews;
    }

    static MediaDevCaptionRuntime compose(MediaRuntime runtime, RightsConsentResolver rights,
                                          MediaDevReviewRuntime reviews) {
        return compose(runtime, rights, reviews, MediaDevRequestLedger.inMemory());
    }

    static MediaDevCaptionRuntime compose(MediaRuntime runtime, RightsConsentResolver rights,
                                          MediaDevReviewRuntime reviews, MediaDevRequestLedger ledger) {
        return new MediaDevCaptionRuntime(runtime, MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), rights,
                reviews, ledger);
    }

    // ---- read ----

    /** Reopens one caption version for its owner, or empty when absent, not a caption, or another owner's. */
    public Optional<CaptionVersion> reopen(String tenantId, String principalId, String artifactId) {
        Optional<MediaArtifact> found = runtime.artifact(tenantId, principalId, artifactId)
                .filter(MediaDevCaptionRuntime::isCaptionVersion);
        if (found.isEmpty()) return Optional.empty();
        MediaArtifact artifact = found.get();
        List<MediaDevWebVtt.Cue> cues = parse(readExact(tenantId, principalId, artifact));
        return Optional.of(new CaptionVersion(artifact, lineageOf(artifact), cues, true));
    }

    /** Review use of the exact version, when the review lane is enabled. */
    public Optional<MediaDevReviewRuntime.SubjectReviewStatus> reviewStatus(String tenantId, String principalId,
                                                                            MediaArtifact artifact) {
        if (reviews == null) return Optional.empty();
        return Optional.of(reviews.artifactReviewStatus(tenantId, principalId, artifact.artifactId(),
                artifact.version().value()));
    }

    // ---- correct ----

    public CaptionVersion correct(String tenantId, String principalId, CorrectionRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "caption_correct", tenantId,
                () -> correctAdmitted(tenantId, principalId, request));
    }

    private CaptionVersion correctAdmitted(String tenantId, String principalId, CorrectionRequest request) {
        MediaArtifact base = runtime.artifact(tenantId, principalId, request.baseArtifactId())
                .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        if (!base.version().value().equals(request.expectedVersionId())) {
            throw new CaptionRefusedException(409, "CAPTION_VERSION_CONFLICT",
                    "the caption version you edited is not the current version of this caption; reload it",
                    Map.of("expectedVersionId", request.expectedVersionId(),
                            "currentVersionId", base.version().value()));
        }
        if (!isCaptionVersion(base)) {
            throw new CaptionRefusedException(422, "CAPTION_BASE_NOT_SUPPORTED",
                    "only a DEV_ONLY machine WebVTT or an earlier correction can be corrected");
        }
        Map<String, Object> baseLineage = lineageOf(base);
        Map<String, Object> source = map(baseLineage.get("source"));
        if (source == null) {
            throw new CaptionRefusedException(422, "CAPTION_BASE_NOT_SUPPORTED",
                    "the caption version has no recorded source audio to authorize against");
        }
        String rightsEvidence = requireRights(tenantId, source);

        List<MediaDevWebVtt.Cue> parentCues = parse(readExact(tenantId, principalId, base));
        List<MediaDevWebVtt.Cue> cues = validate(request.cues());
        Edit edit = Edit.between(parentCues, cues);
        if (edit.unchanged()) {
            throw new CaptionRefusedException(422, "CAPTION_UNCHANGED",
                    "the edited cues are identical to the base version; nothing was registered");
        }
        byte[] bytes = serialize(cues);
        parse(bytes);

        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("captionSchema", SCHEMA);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("kind", KIND_CORRECTED);
        lineage.put("requestId", request.requestId());
        Map<String, Object> parent = new LinkedHashMap<>();
        parent.put("artifactId", base.artifactId());
        parent.put("artifactVersionId", base.version().value());
        parent.put("sha256", base.sha256());
        parent.put("kind", String.valueOf(baseLineage.get("kind")));
        lineage.put("parent", parent);
        Map<String, Object> machine = map(baseLineage.get("machineVersion"));
        if (machine == null) {
            machine = new LinkedHashMap<>();
            machine.put("artifactId", base.artifactId());
            machine.put("artifactVersionId", base.version().value());
            machine.put("sha256", base.sha256());
        }
        lineage.put("machineVersion", machine);
        Object priorNumber = baseLineage.get("correctionNumber");
        lineage.put("correctionNumber", (priorNumber instanceof Number number ? number.intValue() : 0) + 1);
        lineage.put("correctedByPrincipalId", principalId);
        lineage.put("source", source);
        lineage.put("language", baseLineage.getOrDefault("language", "en"));
        lineage.put("rightsDecision", rightsEvidence);
        lineage.put("cueCount", cues.size());
        lineage.put("edit", edit.view());
        lineage.put("note", "Human-edited caption text and timing registered as a new version by a DEV_ONLY "
                + "authenticated principal; not reviewed until an assigned reviewer decides, and not a quality, "
                + "approval or delivery claim.");
        // Rights were re-resolved above on every call (a revoked source refuses even a replay). The ledger maps the
        // requestId to the registered correction, so a retry of the same correction replays it (200) and the same
        // requestId with different cues is refused.
        StringBuilder cueCanonical = new StringBuilder();
        for (MediaDevWebVtt.Cue cue : cues) {
            cueCanonical.append(cue.startMillis()).append('>').append(cue.endMillis()).append('=')
                    .append(cue.text().length()).append(':').append(cue.text()).append('|');
        }
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.caption.correct.v1", base.artifactId(),
                base.version().value(), base.sha256(), cueCanonical.toString());
        return ledger.run(tenantId, principalId, LANE_CORRECT, request.requestId(), fingerprint,
                outputs -> {
                    OutputRef ref = outputs.getFirst();
                    return reopen(tenantId, principalId, ref.artifactId())
                            .filter(found -> found.artifact().version().value().equals(ref.versionId()))
                            .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE_CORRECT));
                },
                () -> registerCorrection(tenantId, principalId, request, base, lineage, cues, bytes),
                version -> List.of(new OutputRef("caption", version.artifact().artifactId(),
                        version.artifact().version().value())),
                () -> new CaptionRefusedException(409, "CAPTION_REQUEST_ID_REUSED",
                        "this requestId was already used with a different caption correction",
                        Map.of("expectedVersionId", request.expectedVersionId())));
    }

    private CaptionVersion registerCorrection(String tenantId, String principalId, CorrectionRequest request,
                                              MediaArtifact base, Map<String, Object> lineage,
                                              List<MediaDevWebVtt.Cue> cues, byte[] bytes) {
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "caption-correction");
        UploadRequest upload = new UploadRequest(tenantId, principalId,
                "captions-corrected-" + safeName(base.artifactId()) + ".vtt", "text/vtt", bytes.length,
                MediaDevProjectRenderRuntime.sha256Hex(bytes), base.classification(), Duration.ofDays(30), metadata);
        // One child per parent version: the idempotency key binds the parent, so a second corrector of the same
        // parent collides in the durable idempotency store instead of silently forking or overwriting the chain.
        String idempotencyKey = "dev-caption:v1:" + MediaDevProjectRenderRuntime.sha256Hex(
                (tenantId + "\u0000" + principalId + "\u0000" + base.artifactId() + "\u0000"
                        + base.version().value()).getBytes(StandardCharsets.UTF_8));
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new CaptionRefusedException(409, "CAPTION_VERSION_CONFLICT",
                        "this caption version already has a correction (or the requestId was used for different "
                                + "cues); reload the caption and edit the current version",
                        Map.of("expectedVersionId", request.expectedVersionId()));
            }
            throw new CaptionRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new CaptionRegistrationFailedException(failure);
        }
        MediaArtifact artifact = registered.artifact();
        if (!artifact.sha256().equals(upload.expectedSha256())) {
            throw new CaptionRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match the corrected cues"));
        }
        return new CaptionVersion(artifact, lineage, cues, registered.replayed());
    }

    // ---- use gate ----

    CaptionUseGate captionUseGate() {
        return (tenantId, principalId, caption) -> {
            if (!isCaptionVersion(caption)) {
                throw new MediaDevProjectRenderRuntime.RenderNotSupportedException("CAPTION_NOT_REVIEWED",
                        "review-required rendering accepts only DEV_ONLY caption versions");
            }
            if (reviews == null) {
                throw new MediaDevProjectRenderRuntime.RenderNotSupportedException("CAPTION_NOT_REVIEWED",
                        "the DEV_ONLY review lane is not enabled, so no caption version can be reviewed");
            }
            var status = reviews.artifactReviewStatus(tenantId, principalId, caption.artifactId(),
                    caption.version().value());
            if (!status.acceptedByAssignedReviewer()) {
                throw new MediaDevProjectRenderRuntime.RenderNotSupportedException("CAPTION_NOT_REVIEWED",
                        "the exact caption version has no current ACCEPT from an assigned reviewer");
            }
            Map<String, Object> source = map(lineageOf(caption).get("source"));
            if (source == null) {
                throw new MediaDevProjectRenderRuntime.RenderNotSupportedException("CAPTION_NOT_REVIEWED",
                        "the caption version has no recorded source audio to authorize against");
            }
            try {
                requireRights(tenantId, source);
            } catch (CaptionRefusedException refused) {
                throw new MediaDevProjectRenderRuntime.RenderNotSupportedException("CAPTION_RIGHTS_NOT_ADMITTED",
                        "source rights no longer admit use of this caption version: " + refused.code());
            }
        };
    }

    // ---- helpers ----

    private String requireRights(String tenantId, Map<String, Object> source) {
        Resolution resolution;
        try {
            resolution = rights.resolve(new ResolutionRequest(tenantId, str(source.get("artifactId")),
                    str(source.get("artifactVersionId")), str(source.get("sha256")), Scope.PROCESSING));
        } catch (RuntimeException unavailable) {
            throw new CaptionRefusedException(422, "RIGHTS_AUTHORITY_UNAVAILABLE",
                    "source rights and consent could not be resolved for this correction");
        }
        return switch (resolution.verdict()) {
            case ADMITTED -> "rights-attestation:" + String.join(",", resolution.attestationIds());
            case UNAVAILABLE -> throw new CaptionRefusedException(422, "RIGHTS_AUTHORITY_UNAVAILABLE",
                    "source rights and consent could not be resolved for this correction");
            case DENIED -> throw denied("RIGHTS_DECISION_DENIED");
            case REVOKED -> throw denied("RIGHTS_DECISION_REVOKED");
            case STALE -> throw denied("RIGHTS_DECISION_STALE");
            case MISMATCH -> throw denied("RIGHTS_DECISION_MISMATCH");
        };
    }

    private static CaptionRefusedException denied(String code) {
        return new CaptionRefusedException(403, code,
                "source rights and consent do not admit this caption correction; nothing was registered",
                Map.of("operation", "CAPTION_CORRECTION"));
    }

    static boolean isCaptionVersion(MediaArtifact artifact) {
        Object kind = artifact.metadata().get("kind");
        String type = artifact.contentType().toLowerCase(java.util.Locale.ROOT);
        if (!(type.equals("text/vtt") || type.startsWith("text/vtt;"))) return false;
        return MediaDevSpeechRuntime.KIND_CAPTIONS.equals(kind) && MediaDevSpeechRuntime.SCHEMA.equals(
                artifact.metadata().get("speechSchema"))
                || KIND_CORRECTED.equals(kind) && SCHEMA.equals(artifact.metadata().get("captionSchema"));
    }

    static Map<String, Object> lineageOf(MediaArtifact artifact) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        for (String key : List.of("speechSchema", "captionSchema", "scope", "kind", "requestId", "engine", "source",
                "language", "model", "runtime", "rightsDecision", "cueCount", "transcriptArtifactId", "parent",
                "machineVersion", "correctionNumber", "correctedByPrincipalId", "edit", "note")) {
            if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
        }
        return lineage;
    }

    @SuppressWarnings("unchecked")
    private static Map<String, Object> map(Object value) {
        return value instanceof Map<?, ?> m ? (Map<String, Object>) m : null;
    }

    private static String str(Object value) {
        if (!(value instanceof String text) || text.isBlank()) {
            throw new CaptionRefusedException(422, "CAPTION_BASE_NOT_SUPPORTED",
                    "the caption version has an incomplete source reference");
        }
        return text;
    }

    private byte[] readExact(String tenantId, String principalId, MediaArtifact artifact) {
        if (artifact.sizeBytes() > MediaDevWebVtt.MAX_BYTES) {
            throw new CaptionRefusedException(422, "CAPTION_LIMIT_EXCEEDED", "caption exceeds the byte ceiling");
        }
        ByteArrayOutputStream staged = new ByteArrayOutputStream((int) artifact.sizeBytes());
        try {
            runtime.copyArtifactContent(tenantId, principalId, artifact.artifactId(), artifact.version(), staged,
                    MediaDevWebVtt.MAX_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        } catch (IOException failure) {
            throw new IllegalStateException("caption artifact content could not be read", failure);
        }
        return staged.toByteArray();
    }

    private static List<MediaDevWebVtt.Cue> parse(byte[] bytes) {
        try {
            return MediaDevWebVtt.parse(bytes);
        } catch (MediaDevWebVtt.WebVttException refused) {
            throw new CaptionRefusedException(422, refused.code(), refused.getMessage());
        }
    }

    /** Bounded, strict cue validation; never repairs or reorders the caller's cues. */
    static List<MediaDevWebVtt.Cue> validate(List<CueInput> inputs) {
        if (inputs.isEmpty()) {
            throw new CaptionRefusedException(422, "CAPTION_DRAFT_EMPTY", "a caption needs at least one cue");
        }
        if (inputs.size() > MediaDevWebVtt.MAX_CUES) {
            throw new CaptionRefusedException(422, "CAPTION_LIMIT_EXCEEDED", "too many cues");
        }
        List<MediaDevWebVtt.Cue> cues = new ArrayList<>(inputs.size());
        long previousEnd = 0;
        int index = 0;
        for (CueInput input : inputs) {
            index++;
            if (input.startMillis() < 0 || input.endMillis() > MAX_MILLIS || input.endMillis() <= input.startMillis()) {
                throw new CaptionRefusedException(422, "CAPTION_TIMING_INVALID",
                        "cue " + index + " must end after it starts, within [0, 24h]");
            }
            if (input.startMillis() < previousEnd) {
                throw new CaptionRefusedException(422, "CAPTION_TIMING_INVALID",
                        "cue " + index + " starts before the previous cue ends; cues must be ordered and not overlap");
            }
            String text = input.text() == null ? "" : input.text().replace("\r\n", "\n").replace('\r', '\n').strip();
            if (text.isEmpty()) {
                throw new CaptionRefusedException(422, "CAPTION_TEXT_EMPTY", "cue " + index + " has no text");
            }
            if (text.indexOf('<') >= 0) {
                throw new CaptionRefusedException(422, "CAPTION_MARKUP_NOT_SUPPORTED",
                        "cue " + index + " contains '<'; cue text is plain text");
            }
            if (text.contains("-->")) {
                throw new CaptionRefusedException(422, "CAPTION_TEXT_INVALID",
                        "cue " + index + " contains the cue timing separator");
            }
            for (int i = 0; i < text.length(); i++) {
                char ch = text.charAt(i);
                if (ch != '\n' && (ch < 0x20 || ch == 0x7f)) {
                    throw new CaptionRefusedException(422, "CAPTION_TEXT_INVALID",
                            "cue " + index + " contains a control character");
                }
            }
            if (text.length() > MediaDevWebVtt.MAX_CUE_TEXT_CHARS) {
                throw new CaptionRefusedException(422, "CAPTION_LIMIT_EXCEEDED", "cue " + index + " text is too long");
            }
            text = text.replaceAll("\n{2,}", "\n").replaceAll("[ \t]+\n", "\n");
            cues.add(new MediaDevWebVtt.Cue(input.startMillis(), input.endMillis(), text));
            previousEnd = input.endMillis();
        }
        return cues;
    }

    static byte[] serialize(List<MediaDevWebVtt.Cue> cues) {
        StringBuilder out = new StringBuilder("WEBVTT\n\n");
        int index = 1;
        for (MediaDevWebVtt.Cue cue : cues) {
            out.append(index++).append('\n').append(timestamp(cue.startMillis())).append(" --> ")
                    .append(timestamp(cue.endMillis())).append('\n').append(cue.text()).append("\n\n");
        }
        return out.toString().getBytes(StandardCharsets.UTF_8);
    }

    private static String timestamp(long millis) {
        return "%02d:%02d:%02d.%03d".formatted(millis / 3_600_000, millis / 60_000 % 60, millis / 1_000 % 60,
                millis % 1_000);
    }

    /** Per-cue difference summary between the parent and the corrected cues. */
    record Edit(int textChanged, int timingChanged, int added, int removed, int unchangedCues) {
        static Edit between(List<MediaDevWebVtt.Cue> parent, List<MediaDevWebVtt.Cue> corrected) {
            int text = 0, timing = 0, same = 0;
            int common = Math.min(parent.size(), corrected.size());
            for (int i = 0; i < common; i++) {
                boolean t = !parent.get(i).text().equals(corrected.get(i).text());
                boolean m = parent.get(i).startMillis() != corrected.get(i).startMillis()
                        || parent.get(i).endMillis() != corrected.get(i).endMillis();
                if (t) text++;
                if (m) timing++;
                if (!t && !m) same++;
            }
            return new Edit(text, timing, Math.max(0, corrected.size() - parent.size()),
                    Math.max(0, parent.size() - corrected.size()), same);
        }
        boolean unchanged() { return textChanged == 0 && timingChanged == 0 && added == 0 && removed == 0; }
        Map<String, Object> view() {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("textChanged", textChanged);
            view.put("timingChanged", timingChanged);
            view.put("added", added);
            view.put("removed", removed);
            view.put("unchanged", unchangedCues);
            return view;
        }
    }

    private static String safeName(String value) {
        String safe = value.replaceAll("[^A-Za-z0-9._-]", "_");
        return safe.length() > 64 ? safe.substring(0, 64) : safe;
    }

    private static String boundedId(String value, String name) {
        if (value == null || !value.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
            throw new IllegalArgumentException(name + " must be a 1-128 character opaque id");
        }
        return value;
    }
}
