package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
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
import java.util.stream.Stream;

/**
 * DEV_ONLY grounded cross-modal answer lane. For one exact video source version it (1) requires current PROCESSING
 * rights, (2) derives the source clock (container start_time and stream timebases) with ffprobe, (3) runs two
 * independent evidence children (speech-to-text and vision) whose results must repeat the parent's exact source
 * version, clock id, timebase and container start, (4) asks Qwen2.5-VL a question constrained to the offered evidence
 * ids, (5) validates every citation server-side and (6) registers the typed result as an immutable artifact through
 * the canonical idempotent upload path.
 *
 * <p>Honesty rules: an uncited, unknown, un-offered or out-of-range citation is flagged and never presented as
 * grounded; a failed child is reported (typed failure by default, partial only when the caller opts in) and its
 * evidence is never invented; a child whose outcome is unknown (sidecar lost mid-run) makes the whole request
 * OUTCOME_UNKNOWN with nothing registered. The Document Intelligence child is reported UNAVAILABLE: no DI v1 gateway
 * client is wired in this launcher. Local open-model output; no quality, entailment or production claim.
 *
 * @doc.type class
 * @doc.purpose DEV_ONLY grounded typed answer over exact-source STT and vision evidence with citation validation
 * @doc.layer product
 * @doc.pattern Service
 */
public final class MediaDevGroundedAnswerRuntime {
    public static final String SCHEMA = "media.dev.grounded-answer.v1";
    public static final String KIND = "LOCAL_GROUNDED_ANSWER";
    static final int MAX_SOURCE_BYTES = 128 * 1024 * 1024;
    private static final List<String> LINEAGE_KEYS = List.of("groundedSchema", "scope", "kind", "requestId", "source",
            "question", "sourceClockId", "answerStatus", "children", "evidenceCompleteness", "models", "rightsDecision",
            "resultSha256");
    private static final ObjectMapper JSON = JsonMapper.builder().build();

    // ---- seams ----

    /** Staged source: the artifact record, its exact bytes and a private file holding them (removed afterwards). */
    record Source(MediaArtifact artifact, byte[] bytes, Path file) { }

    /** Derives the source clock of the staged file; a failure is a typed refusal, never a defaulted clock. */
    interface Probe {
        MediaDevGroundedClock probe(Source source) throws IOException;
    }

    /** One child's attempt outcome. */
    enum ChildStatus { COMPLETED, UNAVAILABLE, FAILED, OUTCOME_UNKNOWN, TIMED_OUT }

    /**
     * What one evidence child returns. {@code pin} is what the child states about the source version and clock its
     * evidence is on; the parent compares it with its own. {@code frameForQuestion} is the PNG of the first sampled
     * frame (vision child only); it is never persisted.
     */
    record ChildResult(String kind, ChildStatus status, MediaDevGroundedClock.Pin pin,
                       List<MediaDevGroundedEvidence.Item> items, Map<String, Object> model, String reason,
                       int droppedItems, byte[] frameForQuestion) {
        ChildResult {
            items = items == null ? List.of() : List.copyOf(items);
            model = model == null ? Map.of() : model;
            reason = reason == null ? "" : reason;
        }
        static ChildResult failed(String kind, ChildStatus status, String reason) {
            return new ChildResult(kind, status, null, List.of(), Map.of(), reason, 0, null);
        }
    }

    /** The question answerer: Qwen2.5-VL over the first sampled frame and the bounded evidence prompt. */
    record Answered(String reply, Map<String, Object> model) { }

    interface Children {
        ChildResult speech(Source source, MediaDevGroundedClock clock, MediaDevGroundedClock.Pin pin, String language);
        ChildResult vision(Source source, MediaDevGroundedClock clock, MediaDevGroundedClock.Pin pin);
        Answered answer(byte[] framePng, String prompt);
        /** Status for the DEV status route; never discloses paths. */
        Map<String, Object> status();
    }

    // ---- request / result ----

    public record AskRequest(String requestId, String artifactId, String artifactVersionId, String question,
                             String language, boolean allowPartial) {
        public AskRequest {
            if (requestId == null || !requestId.matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
                throw new IllegalArgumentException("requestId must be a 1-128 character opaque id");
            }
            Objects.requireNonNull(artifactId, "artifactId");
            Objects.requireNonNull(artifactVersionId, "artifactVersionId");
            if (question == null || question.isBlank() || question.length() > 200
                    || question.chars().anyMatch(c -> c < 0x20)) {
                throw new IllegalArgumentException("question must be 1-200 printable characters");
            }
            language = language == null || language.isBlank() ? "en" : language;
            if (!language.matches("[a-z]{2,3}")) throw new IllegalArgumentException("language must be a 2-3 letter tag");
        }
    }

    /** Durable view of a registered grounded answer; {@code document} is the registered JSON (null if unread). */
    public record GroundedResult(MediaArtifact artifact, Map<String, Object> lineage, Map<String, Object> document,
                                 boolean replayed, Resolution admission)
            implements MediaDevRenderAdmission.ReplayAware {
        @Override public boolean replayedResult() { return replayed; }
    }

    /** Typed refusal or failure; {@code code} and {@code details} carry no content. */
    public static final class GroundedRefusedException extends RuntimeException {
        private final int status;
        private final String code;
        private final Map<String, Object> details;
        GroundedRefusedException(int status, String code, String message, Map<String, Object> details) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
            this.details = details;
        }
        GroundedRefusedException(int status, String code, String message) { this(status, code, message, Map.of()); }
        public int status() { return status; }
        public String code() { return code; }
        public Map<String, Object> details() { return details; }
    }

    public static final class GroundedRightsNotAdmittedException extends RuntimeException {
        private final String code;
        private final Resolution resolution;
        GroundedRightsNotAdmittedException(String code, Resolution resolution) {
            super("source rights/consent is not admitted for PROCESSING");
            this.code = code;
            this.resolution = resolution;
        }
        public String code() { return code; }
        public Resolution resolution() { return resolution; }
    }

    public static final class GroundedRequestReusedException extends IllegalStateException {
        GroundedRequestReusedException(Throwable cause) {
            super("grounded answer requestId was already used for a different request", cause);
        }
    }

    public static final class GroundedRegistrationFailedException extends IllegalStateException {
        GroundedRegistrationFailedException(Throwable cause) {
            super("grounded answer could not be registered as an immutable artifact", cause);
        }
    }

    private final MediaRuntime runtime;
    private final Probe probe;
    private final Children children;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;
    private final RightsConsentResolver rights;
    private final MediaDevRequestLedger ledger;
    static final String LANE = "grounded.answer";

    MediaDevGroundedAnswerRuntime(MediaRuntime runtime, Probe probe, Children children,
                                  RightsConsentResolver rights) {
        this(runtime, probe, children, rights, MediaDevProjectRenderRuntime.canonicalRegistrar(runtime));
    }

    MediaDevGroundedAnswerRuntime(MediaRuntime runtime, Probe probe, Children children,
                                  RightsConsentResolver rights, MediaDevRequestLedger ledger) {
        this(runtime, probe, children, rights, MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), ledger);
    }

    MediaDevGroundedAnswerRuntime(MediaRuntime runtime, Probe probe, Children children, RightsConsentResolver rights,
                                  MediaDevProjectRenderRuntime.OutputRegistrar registrar) {
        this(runtime, probe, children, rights, registrar, MediaDevRequestLedger.inMemory());
    }

    MediaDevGroundedAnswerRuntime(MediaRuntime runtime, Probe probe, Children children, RightsConsentResolver rights,
                                  MediaDevProjectRenderRuntime.OutputRegistrar registrar,
                                  MediaDevRequestLedger ledger) {
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.probe = Objects.requireNonNull(probe, "probe");
        this.children = Objects.requireNonNull(children, "children");
        this.rights = rights == null ? RightsConsentResolver.unavailable() : rights;
        this.registrar = Objects.requireNonNull(registrar, "registrar");
    }

    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>(children.status());
        out.put("rightsAuthority", Map.of("resolverId", rights.resolverId(), "ready", rights.ready(),
                "scope", Scope.PROCESSING.name()));
        out.put("documentIntelligence", documentIntelligenceUnavailable());
        out.put("scope", "DEV_ONLY");
        return out;
    }

    static Map<String, Object> documentIntelligenceUnavailable() {
        return Map.of("kind", "DOCUMENT_INTELLIGENCE", "status", ChildStatus.UNAVAILABLE.name(),
                "reason", "no Document Intelligence v1 gateway client is configured in this launcher; "
                        + "on-screen text evidence comes from the local Florence-2 region reader, not DI");
    }

    public GroundedResult ask(String tenantId, String principalId, AskRequest request) {
        Objects.requireNonNull(request, "request");
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "grounded_answer", tenantId,
                () -> execute(tenantId, principalId, request));
    }

    private GroundedResult execute(String tenantId, String principalId, AskRequest request) {
        MediaArtifact artifact = runtime.artifact(tenantId, principalId, request.artifactId())
                .filter(found -> found.version().value().equals(request.artifactVersionId()))
                .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        Resolution admission = requireRights(tenantId, artifact);
        if (!artifact.contentType().toLowerCase(Locale.ROOT).startsWith("video/")) {
            throw new GroundedRefusedException(422, "SOURCE_FORMAT_NOT_SUPPORTED",
                    "a grounded answer requires a video/* source artifact version");
        }
        if (artifact.sizeBytes() > MAX_SOURCE_BYTES) {
            throw new GroundedRefusedException(422, "GROUNDED_LIMIT_EXCEEDED", "source exceeds the byte ceiling");
        }
        // Rights were re-checked above on every call (a revoked source refuses even a replay). The ledger maps the
        // requestId to its registered answer, so the (nondeterministic) children and answering model run at most
        // once per request.
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.grounded.answer.v1", artifact.artifactId(),
                artifact.version().value(), artifact.sha256(), request.question(), request.language(),
                request.allowPartial());
        return ledger.run(tenantId, principalId, LANE, request.requestId(), fingerprint,
                outputs -> {
                    OutputRef ref = outputs.getFirst();
                    return reopen(tenantId, principalId, ref.artifactId())
                            .filter(found -> found.artifact().version().value().equals(ref.versionId()))
                            .map(found -> new GroundedResult(found.artifact(), found.lineage(), found.document(), true,
                                    admission))
                            .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE));
                },
                () -> produceAnswer(tenantId, principalId, request, artifact, admission),
                result -> List.of(new OutputRef("answer", result.artifact().artifactId(),
                        result.artifact().version().value())),
                () -> new GroundedRequestReusedException(new IllegalArgumentException("requestId used with a different request")));
    }

    private GroundedResult produceAnswer(String tenantId, String principalId, AskRequest request,
                                         MediaArtifact artifact, Resolution admission) {
        ByteArrayOutputStream staged = new ByteArrayOutputStream((int) Math.min(artifact.sizeBytes(), 1 << 26));
        try {
            runtime.copyArtifactContent(tenantId, principalId, artifact.artifactId(), artifact.version(), staged,
                    MAX_SOURCE_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        } catch (IOException failure) {
            throw new IllegalStateException("source artifact content could not be read", failure);
        }
        Path dir = null;
        try {
            dir = Files.createTempDirectory("media-dev-grounded-",
                    PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
            Path file = dir.resolve("source.bin");
            Files.write(file, staged.toByteArray());
            return run(tenantId, principalId, request, admission,
                    new Source(artifact, staged.toByteArray(), file));
        } catch (IOException failure) {
            throw new IllegalStateException("source staging failed", failure);
        } finally {
            if (dir != null) {
                try (Stream<Path> walk = Files.walk(dir)) {
                    walk.sorted(Comparator.reverseOrder()).forEach(path -> path.toFile().delete());
                } catch (IOException ignored) { /* best effort; the directory is private and empty of secrets */ }
            }
        }
    }

    private Resolution requireRights(String tenantId, MediaArtifact artifact) {
        Resolution resolution;
        try {
            resolution = rights.resolve(new ResolutionRequest(tenantId, artifact.artifactId(),
                    artifact.version().value(), artifact.sha256(), Scope.PROCESSING));
        } catch (RuntimeException failure) {
            resolution = Resolution.unavailable(rights.resolverId());
        }
        if (!resolution.admitted()) {
            throw new GroundedRightsNotAdmittedException(
                    resolution.verdict() == Verdict.UNAVAILABLE ? "RIGHTS_AUTHORITY_UNAVAILABLE"
                            : "RIGHTS_" + resolution.verdict().name(), resolution);
        }
        return resolution;
    }

    private GroundedResult run(String tenantId, String principalId, AskRequest request, Resolution admission,
                               Source source) {
        MediaArtifact artifact = source.artifact();
        final MediaDevGroundedClock clock;
        try {
            clock = probe.probe(source);
        } catch (MediaDevGroundedClock.ClockBindingException refused) {
            throw new GroundedRefusedException(422, refused.code(),
                    "the source clock (container start_time and timebase) could not be determined");
        } catch (IOException | RuntimeException failure) {
            throw new GroundedRefusedException(422, "SOURCE_CLOCK_UNDETERMINED",
                    "the source could not be probed for its clock");
        }
        if (!clock.video().present()) {
            throw new GroundedRefusedException(422, "SOURCE_FORMAT_NOT_SUPPORTED",
                    "a grounded answer requires a video stream to answer from");
        }
        MediaDevGroundedClock.Pin pin = clock.pin(artifact.version().value(), artifact.sha256());

        // Independent child attempts. A child that throws is recorded as FAILED; it never aborts its sibling.
        ChildResult speech = attempt("STT", () -> children.speech(source, clock, pin, request.language()));
        ChildResult vision = attempt("VISION", () -> children.vision(source, clock, pin));
        List<ChildResult> results = List.of(speech, vision);

        // Clock/version binding is checked before any status handling: a mismatched child is refused outright.
        List<MediaDevGroundedEvidence.Item> evidence = new ArrayList<>();
        int droppedBoxes = 0;
        for (ChildResult child : results) {
            if (child.status() != ChildStatus.COMPLETED) continue;
            clock.requireBound(pin, child.pin() == null ? null : child.pin(), child.kind());
            for (MediaDevGroundedEvidence.Item item : child.items()) {
                if (item.startMicros() > item.endMicros()
                        || item.startMicros() < clock.containerStartMicros() - MediaDevGroundedEvidence.TIME_TOLERANCE_MICROS
                        || item.endMicros() > clock.containerEndMicros() + MediaDevGroundedEvidence.TIME_TOLERANCE_MICROS) {
                    throw new MediaDevGroundedClock.ClockBindingException("SOURCE_CLOCK_MISMATCH",
                            child.kind() + " child evidence time is outside the source clock");
                }
                if (!MediaDevGroundedEvidence.inRange(item, clock)) {
                    droppedBoxes++;
                    continue;
                }
                evidence.add(item);
            }
            droppedBoxes += child.droppedItems();
        }

        for (ChildResult child : results) {
            if (child.status() == ChildStatus.OUTCOME_UNKNOWN) {
                throw new GroundedRefusedException(503, "GROUNDED_OUTCOME_UNKNOWN",
                        "a child outcome is unknown; nothing was registered and the same requestId may be retried",
                        Map.of("children", childViews(results, evidence)));
            }
        }
        for (ChildResult child : results) {
            if (child.status() == ChildStatus.TIMED_OUT) {
                throw new GroundedRefusedException(504, "GROUNDED_TIMEOUT",
                        "a child exceeded its time budget and was abandoned; nothing was registered and the same "
                                + "requestId may be retried", Map.of("children", childViews(results, evidence)));
            }
        }
        boolean partial = results.stream().anyMatch(child -> child.status() != ChildStatus.COMPLETED);
        if (partial && !request.allowPartial()
                && results.stream().anyMatch(child -> child.status() == ChildStatus.UNAVAILABLE)
                && results.stream().noneMatch(child -> child.status() == ChildStatus.FAILED)) {
            // Nothing ran for the unavailable child: report the outage as such, never as a generic failure.
            throw new GroundedRefusedException(503, "GROUNDED_UNAVAILABLE",
                    "an evidence provider is unavailable; nothing ran for it and no answer was produced (retry, or "
                            + "set allowPartial to accept the remaining evidence)",
                    Map.of("children", childViews(results, evidence)));
        }
        if (partial && !request.allowPartial()) {
            throw new GroundedRefusedException(502, "GROUNDED_CHILD_FAILED",
                    "an evidence child failed; no answer was produced (retry, or set allowPartial to accept the "
                            + "remaining evidence)", Map.of("children", childViews(results, evidence)));
        }
        if (evidence.isEmpty() || vision.status() != ChildStatus.COMPLETED || vision.frameForQuestion() == null) {
            throw new GroundedRefusedException(422, "GROUNDED_NO_EVIDENCE",
                    "no evidence is available to answer from; no answer was produced",
                    Map.of("children", childViews(results, evidence)));
        }

        MediaDevGroundedEvidence.Prompt prompt = MediaDevGroundedEvidence.prompt(request.question(), evidence);
        final Answered answered;
        try {
            answered = children.answer(vision.frameForQuestion(), prompt.text());
        } catch (GroundedRefusedException refused) {
            throw refused;
        } catch (RuntimeException failure) {
            throw new GroundedRefusedException(502, "GROUNDED_ANSWER_FAILED",
                    "the answering model failed; no answer was produced");
        }
        MediaDevGroundedEvidence.Answer answer = MediaDevGroundedEvidence.validate(answered.reply(), evidence,
                prompt.offeredIds(), clock);

        // Rights are re-resolved after the (long) inference: a revocation during the run leaves no effect.
        Resolution still = requireRights(tenantId, artifact);

        Map<String, Object> sourceRef = new LinkedHashMap<>();
        sourceRef.put("artifactId", artifact.artifactId());
        sourceRef.put("artifactVersionId", artifact.version().value());
        sourceRef.put("sha256", artifact.sha256());
        sourceRef.put("contentType", artifact.contentType());
        List<Map<String, Object>> childViews = childViews(results, evidence);
        String completeness = partial ? "PARTIAL" : "COMPLETE";

        Map<String, Object> reply = new LinkedHashMap<>();
        reply.put("modelReplyChars", answered.reply().length());
        reply.put("modelReplySha256", MediaDevProjectRenderRuntime.sha256Hex(answered.reply()));

        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", SCHEMA);
        document.put("scope", "DEV_ONLY");
        document.put("kind", KIND);
        document.put("requestId", request.requestId());
        document.put("question", request.question());
        document.put("source", sourceRef);
        document.put("sourceClock", clock.view());
        document.put("children", childViews);
        document.put("evidenceCompleteness", completeness);
        document.put("evidence", evidence.stream().map(MediaDevGroundedEvidence.Item::view).toList());
        document.put("evidenceOffered", prompt.offeredIds());
        document.put("evidenceOmittedForPromptBudget", prompt.omitted());
        document.put("droppedOutOfRangeItems", droppedBoxes);
        document.put("answer", answer.view());
        document.put("answerModel", answered.model());
        document.put("modelReply", reply);
        document.put("claims", Map.of("quality", "NONE", "note",
                "Local open-model output. Citation integrity is validated server-side; entailment of a claim by its "
                        + "cited evidence is not verified and no accuracy, rights or production claim is made."));
        final byte[] bytes;
        try {
            bytes = JSON.writeValueAsBytes(document);
        } catch (RuntimeException failure) {
            throw new GroundedRegistrationFailedException(failure);
        }

        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("groundedSchema", SCHEMA);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("kind", KIND);
        lineage.put("requestId", request.requestId());
        lineage.put("source", sourceRef);
        lineage.put("question", request.question());
        lineage.put("sourceClockId", clock.clockId());
        lineage.put("answerStatus", answer.status());
        lineage.put("children", childViews.stream().map(view -> Map.of("kind", view.get("kind"),
                "status", view.get("status"))).toList());
        lineage.put("evidenceCompleteness", completeness);
        List<Object> models = new ArrayList<>();
        for (ChildResult child : results) if (!child.model().isEmpty()) models.add(child.model());
        models.add(answered.model());
        lineage.put("models", models);
        Map<String, Object> rightsDecision = new LinkedHashMap<>();
        rightsDecision.put("kind", "RIGHTS_CONSENT_ATTESTATION");
        rightsDecision.put("scope", Scope.PROCESSING.name());
        rightsDecision.put("verdict", still.verdict().name());
        rightsDecision.put("resolverId", still.resolverId());
        rightsDecision.put("productionGrant", false);
        lineage.put("rightsDecision", rightsDecision);
        lineage.put("resultSha256", MediaDevProjectRenderRuntime.sha256Hex(bytes));
        return register(tenantId, principalId, request.requestId(), bytes, lineage, document, still);
    }

    private interface ChildCall { ChildResult call(); }

    private static ChildResult attempt(String kind, ChildCall call) {
        try {
            ChildResult result = call.call();
            return result == null ? ChildResult.failed(kind, ChildStatus.FAILED, "CHILD_RETURNED_NOTHING") : result;
        } catch (MediaDevGroundedClock.ClockBindingException refused) {
            throw refused;
        } catch (RuntimeException failure) {
            return ChildResult.failed(kind, ChildStatus.FAILED, "CHILD_FAILED");
        }
    }

    private static List<Map<String, Object>> childViews(List<ChildResult> results,
                                                        List<MediaDevGroundedEvidence.Item> evidence) {
        List<Map<String, Object>> out = new ArrayList<>();
        for (ChildResult child : results) {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("kind", child.kind());
            view.put("status", child.status().name());
            if (!child.reason().isEmpty()) view.put("reason", child.reason());
            if (!child.model().isEmpty()) view.put("model", child.model());
            view.put("evidenceCount", child.status() == ChildStatus.COMPLETED ? child.items().size() : 0);
            out.add(view);
        }
        out.add(new LinkedHashMap<>(documentIntelligenceUnavailable()));
        return out;
    }

    private GroundedResult register(String tenantId, String principalId, String requestId, byte[] bytes,
                                    Map<String, Object> lineage, Map<String, Object> document, Resolution resolution) {
        String sha256 = MediaDevProjectRenderRuntime.sha256Hex(bytes);
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "grounded-answer");
        UploadRequest upload = new UploadRequest(tenantId, principalId, "grounded-answer.json", "application/json",
                bytes.length, sha256, "INTERNAL", Duration.ofDays(30), metadata);
        String idempotencyKey = "dev-grounded:" + MediaDevProjectRenderRuntime.sha256Hex(
                tenantId + "\u0000" + principalId + "\u0000" + requestId);
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new GroundedRequestReusedException(conflict);
            }
            throw new GroundedRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new GroundedRegistrationFailedException(failure);
        }
        if (!registered.artifact().sha256().equals(sha256)) {
            throw new GroundedRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match produced bytes"));
        }
        return new GroundedResult(registered.artifact(), lineage, document, registered.replayed(), resolution);
    }

    /** Reopens a registered grounded answer for its owner, with its registered document, or returns empty. */
    public Optional<GroundedResult> reopen(String tenantId, String principalId, String artifactId) {
        return runtime.artifact(tenantId, principalId, artifactId)
                .filter(artifact -> SCHEMA.equals(artifact.metadata().get("groundedSchema")))
                .map(artifact -> {
                    Map<String, Object> lineage = new LinkedHashMap<>();
                    for (String key : LINEAGE_KEYS) {
                        if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
                    }
                    ByteArrayOutputStream content = new ByteArrayOutputStream();
                    try {
                        Optional<?> copied = runtime.copyArtifactContent(tenantId, principalId, artifactId,
                                artifact.version(), content, 4 * 1024 * 1024);
                        if (copied.isEmpty()) return null;
                        Map<String, Object> document = JSON.readValue(content.toByteArray(),
                                new tools.jackson.core.type.TypeReference<Map<String, Object>>() { });
                        return new GroundedResult(artifact, lineage, document, true, null);
                    } catch (IOException | RuntimeException unreadable) {
                        return null;
                    }
                });
    }

    static String preview(byte[] bytes) { return new String(bytes, StandardCharsets.UTF_8); }
}
