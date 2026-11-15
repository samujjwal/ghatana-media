package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevReferenceSceneImaging.Raster;
import com.ghatana.media.launcher.MediaDevReferenceSceneImaging.Rect;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import tools.jackson.core.type.TypeReference;

import javax.imageio.ImageIO;
import javax.imageio.ImageReader;
import javax.imageio.stream.ImageInputStream;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;

/**
 * DEV_ONLY rights-checked reference-conditioned scenes (J-10 {@code media.dev.outcome-reference-continuity}).
 *
 * <p><b>Two modes, one honest.</b> {@code TEMPLATE} composes scenes from authored, versioned templates (a floor line,
 * palette, optional ring, seeded layout drift and scale push, recoloured references, seeded sparkles) with the verified
 * {@code AnimationRenderer}; the references are genuinely used (decoded, area-scaled, recoloured and placed per the
 * template parameters) and the output is reproducible from the seed. {@code MODEL} is a generative model: none is admitted
 * here (the local models understand media, they do not generate it), so it is a typed {@code 503 MODEL_UNAVAILABLE}
 * with zero artifacts and NO fallback to a template.</p>
 *
 * <p><b>Rights.</b> A reference set is a durable, versioned list of exact artifact versions, each of which must resolve
 * ADMITTED for {@link Scope#PROCESSING} when the set is registered and again on EVERY run, replay and regeneration; a
 * missing, revoked or unavailable statement is a typed refusal and no content is read. A slot that names a reference not
 * in the set is a typed 422. Provenance (template id and version, seed, parameters, exact reference versions and rights
 * decisions, per-scene digests) is stored in a manifest artifact, from which {@link #regenerate} reproduces the scenes
 * byte for byte.</p>
 *
 * <p><b>Continuity</b> is measured on the DECODED output PNGs: reference-region colour histogram distance, global luma
 * SSIM and difference-hash distance of each placed reference against the reference scaled to its placed size, the
 * render fidelity (maximum channel difference of the decoded crop against the independently recoloured expectation),
 * cross-scene histogram and hash distance of the reference crop against scene 0, and palette adherence of everything
 * outside the references. A threshold failure is the typed {@code CONTINUITY_THRESHOLD_FAILED} and nothing is
 * registered.</p>
 */
final class MediaDevReferenceSceneRuntime {
    static final String SET_SCHEMA = "media.dev.reference-set.v1";
    static final String RUN_SCHEMA = "media.dev.reference-scene-run.v1";
    static final String KIND_SET = "REFERENCE_SET";
    static final String KIND_SCENE = "REFERENCE_SCENE_PNG";
    static final String KIND_MANIFEST = "REFERENCE_SCENE_MANIFEST";
    static final String LANE_SET = "reference-scene.set";
    static final String LANE_RUN = "reference-scene.run";
    static final int MAX_REFERENCES = 6;
    static final int MAX_ASSET_BYTES = 2 * 1024 * 1024;
    static final long MAX_ASSET_PIXELS = 1_048_576L;
    static final int MAX_DOCUMENT_BYTES = 4 * 1024 * 1024;
    static final int FIDELITY_TOLERANCE = 2;
    static final String CLAIMS = "DEV_ONLY authored-template composition of rights-checked reference images; no generative "
            + "model was used; no quality, rights, approval or production claim";
    private static final List<String> LINEAGE_KEYS = List.of("referenceSceneSchema", "scope", "kind", "requestId",
            "sceneIndex", "templateId", "templateVersion", "seed", "specSha256", "set", "sources", "parent", "siblings",
            "canonicalPngSha256", "pixelSha256", "rightsDecision", "resultSha256", "claims");

    /** A typed refusal with an HTTP status; carries no request content. */
    static final class RefSceneRefusedException extends RuntimeException {
        private final int status;
        private final String code;
        private final Map<String, Object> details;

        RefSceneRefusedException(int status, String code, String message, Map<String, Object> details) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
            this.details = details;
        }

        int status() { return status; }
        String code() { return code; }
        Map<String, Object> details() { return details; }
    }

    static final class RefSceneRequestReusedException extends IllegalStateException {
        RefSceneRequestReusedException() { super("reference scene requestId was already used for a different request"); }
    }

    static final class RefSceneRegistrationFailedException extends IllegalStateException {
        RefSceneRegistrationFailedException(Throwable cause) {
            super("reference scene output could not be registered as an immutable artifact", cause);
        }
    }

    record RefInput(String referenceId, String artifactId, String artifactVersionId) { }

    record SetRequest(String requestId, String name, List<RefInput> references) { }

    record RefSet(MediaArtifact artifact, Map<String, Object> document, boolean replayed)
            implements MediaDevRenderAdmission.ReplayAware {
        @Override public boolean replayedResult() { return replayed; }
    }

    record RunRequest(String requestId, String referenceSetId, Object template, Object seed, Object sceneCount,
                      Object parameters, Object continuity) { }

    record Run(List<MediaArtifact> scenes, MediaArtifact manifest, Map<String, Object> document, boolean replayed)
            implements MediaDevRenderAdmission.ReplayAware {
        @Override public boolean replayedResult() { return replayed; }
    }

    private record Resolved(Map<String, Object> entry, MediaArtifact artifact, Resolution resolution) { }

    private record SceneResult(int index, byte[] canonicalPng, String canonicalSha, String pixelSha, List<Rect> rects,
                               Map<String, Object> metrics, List<Map<String, Object>> violations) { }

    private final MediaRuntime runtime;
    private final RightsConsentResolver rights;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;
    private final MediaDevRequestLedger ledger;

    MediaDevReferenceSceneRuntime(MediaRuntime runtime, RightsConsentResolver rights,
                                  MediaDevProjectRenderRuntime.OutputRegistrar registrar, MediaDevRequestLedger ledger) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.rights = rights == null ? RightsConsentResolver.unavailable() : rights;
        this.registrar = Objects.requireNonNull(registrar, "registrar");
        this.ledger = Objects.requireNonNull(ledger, "ledger");
    }

    /** Null when there is no durable request ledger; scenes are never produced without exactly-once registration. */
    static MediaDevReferenceSceneRuntime compose(MediaRuntime runtime, RightsConsentResolver rights,
                                                 MediaDevRequestLedger ledger) {
        if (ledger == null) return null;
        return new MediaDevReferenceSceneRuntime(runtime, rights, MediaDevProjectRenderRuntime.canonicalRegistrar(runtime),
                ledger);
    }

    Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", "DEV_ONLY");
        out.put("ready", true);
        out.put("schema", RUN_SCHEMA);
        out.put("templates", MediaDevReferenceSceneSpec.catalog());
        Map<String, Object> limits = new LinkedHashMap<>();
        limits.put("maxScenes", MediaDevReferenceSceneSpec.MAX_SCENES);
        limits.put("maxSlots", MediaDevReferenceSceneSpec.MAX_SLOTS);
        limits.put("maxReferencesPerSet", MAX_REFERENCES);
        limits.put("minWidth", MediaDevReferenceSceneSpec.MIN_WIDTH);
        limits.put("maxWidth", MediaDevReferenceSceneSpec.MAX_WIDTH);
        limits.put("minHeight", MediaDevReferenceSceneSpec.MIN_HEIGHT);
        limits.put("maxHeight", MediaDevReferenceSceneSpec.MAX_HEIGHT);
        limits.put("maxPalette", MediaDevReferenceSceneSpec.MAX_PALETTE);
        limits.put("maxSparkles", MediaDevReferenceSceneSpec.MAX_SPARKLES);
        limits.put("maxDriftPixels", MediaDevReferenceSceneSpec.MAX_DRIFT);
        limits.put("maxReferenceBytes", MAX_ASSET_BYTES);
        limits.put("maxReferencePixels", MAX_ASSET_PIXELS);
        out.put("limits", limits);
        out.put("modes", List.of("TEMPLATE", "MODEL"));
        Map<String, Object> model = new LinkedHashMap<>();
        model.put("available", false);
        model.put("reason", "NO_ADMITTED_GENERATIVE_MODEL");
        model.put("fallback", "NONE");
        model.put("note", "The local models (Whisper, Kokoro, Florence-2, Qwen2.5-VL) understand media; none generates "
                + "images or video. MODEL mode is refused with MODEL_UNAVAILABLE and creates nothing.");
        out.put("model", model);
        out.put("defaultContinuityThresholds", MediaDevReferenceSceneSpec.Thresholds.DEFAULT.view());
        out.put("metrics", List.of("histogramDistance", "ssim", "hashDistance", "renderMaxAbsDiff", "crossScene",
                "paletteAdherence"));
        out.put("rightsAuthority", Map.of("resolverId", rights.resolverId(), "ready", rights.ready(),
                "scope", Scope.PROCESSING.name(), "appliesTo", "every reference image, on every run"));
        return out;
    }

    /** MODEL mode: no admitted generative model, so a typed refusal; no rights lookup, no read, no artifact, no fallback. */
    RefSceneRefusedException modelUnavailable() {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("reason", "NO_ADMITTED_GENERATIVE_MODEL");
        details.put("fallback", "NONE");
        details.put("artifactsCreated", 0);
        return new RefSceneRefusedException(503, "MODEL_UNAVAILABLE",
                "no generative image or video model is admitted on this host; nothing was generated and no template "
                        + "was substituted", details);
    }

    // ------------------------------------------------------------------ reference sets

    RefSet registerSet(String tenantId, String principalId, SetRequest request) {
        Objects.requireNonNull(request, "request");
        MediaDevDubSupport.boundedId(request.requestId(), "requestId");
        if (request.name() != null && (request.name().isBlank() || request.name().length() > 80)) {
            throw MediaDevReferenceSceneSpec.invalid("$.name", "name must be 1-80 characters");
        }
        if (request.references() == null || request.references().isEmpty() || request.references().size() > MAX_REFERENCES) {
            throw MediaDevReferenceSceneSpec.invalid("$.references", "references must list 1 to " + MAX_REFERENCES
                    + " exact artifact versions");
        }
        Set<String> ids = new HashSet<>();
        for (int i = 0; i < request.references().size(); i++) {
            RefInput ref = request.references().get(i);
            if (ref.referenceId() == null || !ref.referenceId().matches("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}")) {
                throw MediaDevReferenceSceneSpec.invalid("$.references[" + i + "].referenceId",
                        "referenceId must be a 1-128 character opaque id");
            }
            if (!ids.add(ref.referenceId())) {
                throw MediaDevReferenceSceneSpec.invalid("$.references[" + i + "].referenceId", "referenceId is duplicated");
            }
            if (ref.artifactId() == null || ref.artifactId().isBlank()) {
                throw MediaDevReferenceSceneSpec.invalid("$.references[" + i + "].artifactId", "is required");
            }
            if (ref.artifactVersionId() == null || ref.artifactVersionId().isBlank()) {
                throw MediaDevReferenceSceneSpec.invalid("$.references[" + i + "].artifactVersionId", "is required");
            }
        }
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "reference_set", tenantId,
                () -> registerSetAdmitted(tenantId, principalId, request));
    }

    private RefSet registerSetAdmitted(String tenantId, String principalId, SetRequest request) {
        List<Resolved> resolved = new ArrayList<>();
        StringBuilder digests = new StringBuilder();
        for (int i = 0; i < request.references().size(); i++) {
            RefInput ref = request.references().get(i);
            String path = "$.references[" + i + "]";
            MediaArtifact artifact = runtime.artifact(tenantId, principalId, ref.artifactId())
                    .filter(found -> found.version().value().equals(ref.artifactVersionId()))
                    .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
            checkImage(artifact, path);
            Resolution resolution = admit(tenantId, artifact, path);
            Map<String, Object> entry = new LinkedHashMap<>();
            entry.put("referenceId", ref.referenceId());
            entry.putAll(MediaDevDubSupport.ref(artifact));
            entry.put("contentType", artifact.contentType());
            resolved.add(new Resolved(entry, artifact, resolution));
            digests.append(ref.referenceId()).append('=').append(artifact.artifactId()).append('@')
                    .append(artifact.version().value()).append(';');
        }
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.reference-set.v1",
                request.name() == null ? "" : request.name(), digests.toString());
        return ledger.run(tenantId, principalId, LANE_SET, request.requestId(), fingerprint,
                outputs -> replaySet(tenantId, principalId, outputs),
                () -> produceSet(tenantId, principalId, request, resolved),
                set -> List.of(new OutputRef("set", set.artifact().artifactId(), set.artifact().version().value())),
                RefSceneRequestReusedException::new);
    }

    private RefSet produceSet(String tenantId, String principalId, SetRequest request, List<Resolved> resolved) {
        List<Map<String, Object>> entries = new ArrayList<>();
        List<Map<String, Object>> sources = new ArrayList<>();
        List<String> attestations = new ArrayList<>();
        for (Resolved item : resolved) {
            Raster raster = decodeReference(tenantId, principalId, item.artifact(), (String) item.entry().get("referenceId"));
            Map<String, Object> entry = new LinkedHashMap<>(item.entry());
            entry.put("width", raster.width());
            entry.put("height", raster.height());
            entry.put("rights", admission(item.resolution()));
            entries.add(entry);
            Map<String, Object> source = new LinkedHashMap<>(MediaDevDubSupport.ref(item.artifact()));
            source.put("assetId", item.entry().get("referenceId"));
            sources.add(source);
            attestations.addAll(item.resolution().attestationIds());
        }
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", SET_SCHEMA);
        document.put("scope", "DEV_ONLY");
        document.put("requestId", request.requestId());
        if (request.name() != null) document.put("name", request.name());
        document.put("references", entries);
        document.put("claims", "DEV_ONLY list of exact reference versions; each held a PROCESSING statement when listed; "
                + "every run re-checks it");
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("referenceSceneSchema", SET_SCHEMA);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("kind", KIND_SET);
        lineage.put("requestId", request.requestId());
        lineage.put("sources", sources);
        lineage.put("parent", sources.getFirst());
        lineage.put("rightsDecision", rightsDecision(resolved.size(), attestations));
        lineage.put("claims", CLAIMS);
        byte[] bytes = MediaDevDubSupport.json(document);
        lineage.put("resultSha256", MediaDevReferenceSceneImaging.sha256(bytes));
        MediaArtifact artifact = registerOne(tenantId, principalId, "set", request.requestId(), bytes, "application/json",
                "json", "refset-" + MediaDevDubSupport.safeName(request.requestId()), lineage);
        return new RefSet(artifact, document, false);
    }

    private RefSet replaySet(String tenantId, String principalId, List<OutputRef> outputs) {
        OutputRef ref = outputs.stream().filter(candidate -> candidate.role().equals("set")).findFirst()
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE_SET));
        return reopenSet(tenantId, principalId, ref.artifactId())
                .filter(found -> found.artifact().version().value().equals(ref.versionId()))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE_SET));
    }

    Optional<RefSet> reopenSet(String tenantId, String principalId, String setId) {
        Optional<MediaArtifact> artifact = runtime.artifact(tenantId, principalId, setId)
                .filter(found -> SET_SCHEMA.equals(found.metadata().get("referenceSceneSchema"))
                        && KIND_SET.equals(found.metadata().get("kind")));
        return artifact.map(found -> new RefSet(found, readDocument(tenantId, principalId, found), true));
    }

    // ------------------------------------------------------------------ runs

    Run generate(String tenantId, String principalId, RunRequest request) {
        Objects.requireNonNull(request, "request");
        MediaDevDubSupport.boundedId(request.requestId(), "requestId");
        if (request.referenceSetId() == null || request.referenceSetId().isBlank()) {
            throw MediaDevReferenceSceneSpec.invalid("$.referenceSetId", "is required");
        }
        // Parse and budget first: an invalid request costs no permit, no lookup and no rights call.
        MediaDevReferenceSceneSpec.Parsed spec = MediaDevReferenceSceneSpec.parse(request.template(), request.seed(),
                request.sceneCount(), request.parameters(), request.continuity());
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "reference_scene", tenantId,
                () -> generateAdmitted(tenantId, principalId, request, spec));
    }

    private Run generateAdmitted(String tenantId, String principalId, RunRequest request,
                                 MediaDevReferenceSceneSpec.Parsed spec) {
        RefSet set = reopenSet(tenantId, principalId, request.referenceSetId()).orElseThrow(() ->
                new RefSceneRefusedException(404, "REFERENCE_SET_NOT_FOUND",
                        "The reference set is not available in this tenant and owner scope", Map.of()));
        List<Resolved> used = resolveUsed(tenantId, principalId, spec, set);
        String specSha = MediaDevReferenceSceneImaging.sha256(MediaDevDubSupport.json(spec.canonical()));
        StringBuilder digests = new StringBuilder();
        for (Resolved item : used) {
            digests.append(item.entry().get("referenceId")).append('=').append(item.artifact().artifactId()).append('@')
                    .append(item.artifact().version().value()).append(';');
        }
        String fingerprint = MediaDevRequestLedger.fingerprint("media.dev.reference-scene.run.v1", specSha,
                set.artifact().artifactId() + "@" + set.artifact().version().value(), digests.toString());
        return ledger.run(tenantId, principalId, LANE_RUN, request.requestId(), fingerprint,
                outputs -> replayRun(tenantId, principalId, outputs),
                () -> produce(tenantId, principalId, request, spec, specSha, set, used),
                run -> {
                    List<OutputRef> refs = new ArrayList<>();
                    refs.add(new OutputRef("manifest", run.manifest().artifactId(), run.manifest().version().value()));
                    for (int i = 0; i < run.scenes().size(); i++) {
                        refs.add(new OutputRef("scene-" + i, run.scenes().get(i).artifactId(),
                                run.scenes().get(i).version().value()));
                    }
                    return refs;
                },
                RefSceneRequestReusedException::new);
    }

    /** Every slot's reference must be in the set (422), visible at the exact version (404) and currently admitted (403/503). */
    private List<Resolved> resolveUsed(String tenantId, String principalId, MediaDevReferenceSceneSpec.Parsed spec,
                                       RefSet set) {
        Map<String, Map<String, Object>> byId = new LinkedHashMap<>();
        for (Object entry : (List<?>) set.document().get("references")) {
            @SuppressWarnings("unchecked") Map<String, Object> map = (Map<String, Object>) entry;
            byId.put((String) map.get("referenceId"), map);
        }
        // Membership and layout are validated BEFORE any rights lookup, ledger claim or content read.
        List<Map<String, Object>> members = new ArrayList<>();
        List<int[]> dimensions = new ArrayList<>();
        for (int k = 0; k < spec.slots().size(); k++) {
            String referenceId = spec.slots().get(k).referenceId();
            Map<String, Object> entry = byId.get(referenceId);
            if (entry == null) {
                String path = spec.spotlight() ? "$.parameters.subject.referenceId" : "$.parameters.slots[" + k + "].referenceId";
                throw new RefSceneRefusedException(422, "REFERENCE_NOT_IN_SET",
                        "the slot names a reference that is not in the reference set; nothing was read or rendered",
                        Map.of("path", path, "referenceId", referenceId));
            }
            members.add(entry);
            dimensions.add(new int[] {((Number) entry.get("width")).intValue(), ((Number) entry.get("height")).intValue()});
        }
        MediaDevReferenceSceneImaging.layout(spec, dimensions);
        List<Resolved> resolved = new ArrayList<>();
        Map<String, Resolved> cache = new LinkedHashMap<>();
        for (int k = 0; k < spec.slots().size(); k++) {
            String referenceId = spec.slots().get(k).referenceId();
            String path = spec.spotlight() ? "$.parameters.subject.referenceId" : "$.parameters.slots[" + k + "].referenceId";
            Map<String, Object> entry = members.get(k);
            Resolved known = cache.get(referenceId);
            if (known == null) {
                MediaArtifact artifact = runtime.artifact(tenantId, principalId, (String) entry.get("artifactId"))
                        .filter(found -> found.version().value().equals(entry.get("artifactVersionId")))
                        .orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
                checkImage(artifact, path);
                known = new Resolved(entry, artifact, admit(tenantId, artifact, path));
                cache.put(referenceId, known);
            }
            resolved.add(known);
        }
        return resolved;
    }

    private Run replayRun(String tenantId, String principalId, List<OutputRef> outputs) {
        OutputRef ref = outputs.stream().filter(candidate -> candidate.role().equals("manifest")).findFirst()
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE_RUN));
        return reopen(tenantId, principalId, ref.artifactId())
                .filter(found -> found.manifest().version().value().equals(ref.versionId()))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE_RUN));
    }

    Optional<Run> reopen(String tenantId, String principalId, String manifestId) {
        Optional<MediaArtifact> manifest = runtime.artifact(tenantId, principalId, manifestId)
                .filter(found -> RUN_SCHEMA.equals(found.metadata().get("referenceSceneSchema"))
                        && KIND_MANIFEST.equals(found.metadata().get("kind")));
        if (manifest.isEmpty()) return Optional.empty();
        Map<String, Object> document = readDocument(tenantId, principalId, manifest.get());
        List<MediaArtifact> scenes = new ArrayList<>();
        for (Object entry : (List<?>) document.get("scenes")) {
            if (!(entry instanceof Map<?, ?> scene) || !(scene.get("artifact") instanceof Map<?, ?> ref)) return Optional.empty();
            Optional<MediaArtifact> artifact = runtime.artifact(tenantId, principalId, (String) ref.get("artifactId"))
                    .filter(found -> found.version().value().equals(ref.get("artifactVersionId"))
                            && KIND_SCENE.equals(found.metadata().get("kind")));
            if (artifact.isEmpty()) return Optional.empty();
            scenes.add(artifact.get());
        }
        return Optional.of(new Run(scenes, manifest.get(), document, true));
    }

    private Run produce(String tenantId, String principalId, RunRequest request, MediaDevReferenceSceneSpec.Parsed spec,
                        String specSha, RefSet set, List<Resolved> used) {
        List<SceneResult> results = renderAll(tenantId, principalId, spec, used, specSha);
        List<Map<String, Object>> violations = new ArrayList<>();
        for (SceneResult result : results) violations.addAll(result.violations());
        if (!violations.isEmpty()) {
            Map<String, Object> details = new LinkedHashMap<>();
            details.put("violationCount", violations.size());
            details.put("violations", violations.size() > 20 ? violations.subList(0, 20) : violations);
            details.put("thresholds", spec.thresholds().view());
            details.put("artifactsCreated", 0);
            throw new RefSceneRefusedException(422, "CONTINUITY_THRESHOLD_FAILED",
                    "the generated scenes broke the continuity thresholds; nothing was registered", details);
        }
        return register(tenantId, principalId, request, spec, specSha, set, used, results);
    }

    // ------------------------------------------------------------------ rendering and measurement

    private List<SceneResult> renderAll(String tenantId, String principalId, MediaDevReferenceSceneSpec.Parsed spec,
                                        List<Resolved> used, String specSha) {
        Map<String, Raster> decoded = new LinkedHashMap<>();
        List<Raster> references = new ArrayList<>();
        for (Resolved item : used) {
            String referenceId = (String) item.entry().get("referenceId");
            Raster raster = decoded.get(referenceId);
            if (raster == null) {
                raster = decodeReference(tenantId, principalId, item.artifact(), referenceId);
                decoded.put(referenceId, raster);
            }
            references.add(raster);
        }
        List<int[]> dimensions = new ArrayList<>();
        for (Raster reference : references) dimensions.add(new int[] {reference.width(), reference.height()});
        List<List<Rect>> layout = MediaDevReferenceSceneImaging.layout(spec, dimensions);
        List<SceneResult> results = new ArrayList<>();
        List<Raster> baselineCrops = new ArrayList<>();
        for (int scene = 0; scene < spec.sceneCount(); scene++) {
            List<Rect> rects = layout.get(scene);
            List<Raster> scaled = new ArrayList<>();
            List<Raster> prepared = new ArrayList<>();
            for (int k = 0; k < rects.size(); k++) {
                Raster fitted = MediaDevReferenceSceneImaging.boxScale(references.get(k), rects.get(k).width(),
                        rects.get(k).height());
                scaled.add(fitted);
                MediaDevReferenceSceneSpec.Slot slot = spec.slots().get(k);
                prepared.add(slot.tinted() ? MediaDevReferenceSceneImaging.tint(fitted, slot.tintRgb(), slot.tintPermille())
                        : fitted);
            }
            byte[] png;
            Raster output;
            try {
                png = MediaDevReferenceSceneImaging.compose(spec, scene, rects, prepared, specSha);
                output = MediaDevReferenceSceneImaging.decode(png);
            } catch (RuntimeException failure) {
                throw new RefSceneRefusedException(500, "REFERENCE_SCENE_RENDER_FAILED",
                        "the renderer failed; nothing was registered", Map.of("scene", scene));
            }
            List<Map<String, Object>> slotMetrics = new ArrayList<>();
            List<Map<String, Object>> violations = new ArrayList<>();
            for (int k = 0; k < rects.size(); k++) {
                Raster crop = MediaDevReferenceSceneImaging.crop(output, rects.get(k));
                boolean[] mask = MediaDevReferenceSceneImaging.opaqueMask(scaled.get(k));
                int fidelity = MediaDevReferenceSceneImaging.maxChannelDifference(crop, prepared.get(k), mask);
                if (fidelity > FIDELITY_TOLERANCE) {
                    throw new RefSceneRefusedException(500, "REFERENCE_SCENE_FIDELITY_FAILED",
                            "the decoded output does not carry the reference as composed; nothing was registered",
                            Map.of("scene", scene, "slot", k, "maxAbsDiff", fidelity));
                }
                double histogram = MediaDevReferenceSceneImaging.histogramDistance(crop, scaled.get(k), mask);
                double ssim = MediaDevReferenceSceneImaging.ssim(crop, scaled.get(k), mask);
                int hash = Long.bitCount(MediaDevReferenceSceneImaging.dHash(crop)
                        ^ MediaDevReferenceSceneImaging.dHash(MediaDevReferenceSceneImaging.merged(scaled.get(k), crop, mask)));
                Map<String, Object> metric = new LinkedHashMap<>();
                metric.put("slot", k);
                metric.put("referenceId", spec.slots().get(k).referenceId());
                metric.put("rect", rects.get(k).view());
                metric.put("histogramDistance", histogram);
                metric.put("ssim", ssim);
                metric.put("hashDistance", hash);
                metric.put("renderMaxAbsDiff", fidelity);
                if (histogram > spec.thresholds().maxHistogramDistance()) {
                    violations.add(violation(scene, k, "histogramDistance", histogram, spec.thresholds().maxHistogramDistance(), "MAX"));
                }
                if (ssim < spec.thresholds().minSsim()) {
                    violations.add(violation(scene, k, "ssim", ssim, spec.thresholds().minSsim(), "MIN"));
                }
                if (hash > spec.thresholds().maxHashDistance()) {
                    violations.add(violation(scene, k, "hashDistance", hash, spec.thresholds().maxHashDistance(), "MAX"));
                }
                Raster normalised = MediaDevReferenceSceneImaging.boxScale(crop, 32, 32);
                if (scene == 0) {
                    baselineCrops.add(normalised);
                } else {
                    double cross = MediaDevReferenceSceneImaging.histogramDistance(normalised, baselineCrops.get(k), null);
                    int crossHash = Long.bitCount(MediaDevReferenceSceneImaging.dHash(normalised)
                            ^ MediaDevReferenceSceneImaging.dHash(baselineCrops.get(k)));
                    Map<String, Object> crossScene = new LinkedHashMap<>();
                    crossScene.put("baselineScene", 0);
                    crossScene.put("histogramDistance", cross);
                    crossScene.put("hashDistance", crossHash);
                    metric.put("crossScene", crossScene);
                    if (cross > spec.thresholds().maxCrossSceneHistogramDistance()) {
                        violations.add(violation(scene, k, "crossSceneHistogramDistance", cross,
                                spec.thresholds().maxCrossSceneHistogramDistance(), "MAX"));
                    }
                }
                slotMetrics.add(metric);
            }
            double adherence = MediaDevReferenceSceneImaging.paletteAdherence(output, rects, spec.palette());
            if (adherence < spec.thresholds().minPaletteAdherence()) {
                violations.add(violation(scene, -1, "paletteAdherence", adherence, spec.thresholds().minPaletteAdherence(), "MIN"));
            }
            Map<String, Object> metrics = new LinkedHashMap<>();
            metrics.put("paletteAdherence", adherence);
            metrics.put("slots", slotMetrics);
            results.add(new SceneResult(scene, png, MediaDevReferenceSceneImaging.sha256(png),
                    MediaDevReferenceSceneImaging.pixelDigest(output), rects, metrics, violations));
        }
        return results;
    }

    private static Map<String, Object> violation(int scene, int slot, String metric, double value, double threshold, String kind) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scene", scene);
        if (slot >= 0) out.put("slot", slot);
        out.put("metric", metric);
        out.put("value", value);
        out.put("threshold", threshold);
        out.put("limit", kind);
        return out;
    }

    // ------------------------------------------------------------------ registration

    private Run register(String tenantId, String principalId, RunRequest request, MediaDevReferenceSceneSpec.Parsed spec,
                         String specSha, RefSet set, List<Resolved> used, List<SceneResult> results) {
        List<Map<String, Object>> sources = new ArrayList<>();
        List<String> attestations = new ArrayList<>();
        Set<String> seen = new HashSet<>();
        List<Map<String, Object>> referenceViews = new ArrayList<>();
        for (Resolved item : used) {
            String referenceId = (String) item.entry().get("referenceId");
            if (!seen.add(referenceId)) continue;
            Map<String, Object> source = new LinkedHashMap<>(MediaDevDubSupport.ref(item.artifact()));
            source.put("assetId", referenceId);
            source.put("contentType", item.artifact().contentType());
            source.put("rights", admission(item.resolution()));
            sources.add(source);
            referenceViews.add(source);
            attestations.addAll(item.resolution().attestationIds());
        }
        Map<String, Object> setRef = MediaDevDubSupport.ref(set.artifact());
        Map<String, Object> rightsDecision = rightsDecision(sources.size(), attestations);

        List<MediaArtifact> sceneArtifacts = new ArrayList<>();
        List<Map<String, Object>> sceneViews = new ArrayList<>();
        for (SceneResult result : results) {
            byte[] tagged = MediaDevReferenceSceneImaging.tag(result.canonicalPng(),
                    request.requestId() + ":" + result.index());
            Map<String, Object> lineage = new LinkedHashMap<>();
            lineage.put("referenceSceneSchema", RUN_SCHEMA);
            lineage.put("scope", "DEV_ONLY");
            lineage.put("kind", KIND_SCENE);
            lineage.put("requestId", request.requestId());
            lineage.put("sceneIndex", result.index());
            lineage.put("templateId", spec.templateId());
            lineage.put("templateVersion", spec.templateVersion());
            lineage.put("seed", spec.seed());
            lineage.put("specSha256", specSha);
            lineage.put("set", setRef);
            lineage.put("sources", sources);
            lineage.put("parent", sources.getFirst());
            lineage.put("canonicalPngSha256", result.canonicalSha());
            lineage.put("pixelSha256", result.pixelSha());
            lineage.put("rightsDecision", rightsDecision);
            lineage.put("resultSha256", MediaDevReferenceSceneImaging.sha256(tagged));
            lineage.put("claims", CLAIMS);
            MediaArtifact artifact = registerOne(tenantId, principalId, "scene-" + result.index(), request.requestId(),
                    tagged, "image/png", "png",
                    "refscene-" + MediaDevDubSupport.safeName(request.requestId()) + "-" + result.index(), lineage);
            sceneArtifacts.add(artifact);
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("index", result.index());
            view.put("artifact", MediaDevDubSupport.ref(artifact));
            view.put("canonicalPngSha256", result.canonicalSha());
            view.put("pixelSha256", result.pixelSha());
            List<Map<String, Object>> placed = new ArrayList<>();
            for (Rect rect : result.rects()) placed.add(rect.view());
            view.put("placed", placed);
            view.put("metrics", result.metrics());
            sceneViews.add(view);
        }

        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", RUN_SCHEMA);
        document.put("scope", "DEV_ONLY");
        document.put("requestId", request.requestId());
        document.put("mode", "TEMPLATE");
        document.put("outcome", "CONTINUITY_PASSED");
        Map<String, Object> generator = new LinkedHashMap<>();
        generator.put("kind", "AUTHORED_TEMPLATE");
        generator.put("templateId", spec.templateId());
        generator.put("templateVersion", spec.templateVersion());
        generator.put("seed", spec.seed());
        generator.put("renderer", "AnimationRenderer (deterministic, no antialiasing)");
        generator.put("generativeModelUsed", false);
        document.put("generator", generator);
        document.put("request", spec.canonical());
        document.put("specSha256", specSha);
        document.put("set", setRef);
        document.put("references", referenceViews);
        document.put("rightsDecision", rightsDecision);
        document.put("thresholds", spec.thresholds().view());
        document.put("scenes", sceneViews);
        document.put("summary", summary(results));
        document.put("reproduction", "POST /dev/v1/reference-scenes/runs/{runId}/regenerations re-checks rights, re-renders "
                + "from this manifest and compares canonicalPngSha256; the stored PNG minus its tEXt '"
                + MediaDevReferenceSceneImaging.PNG_TAG_KEYWORD + "' request tag IS the canonical PNG");
        document.put("claims", CLAIMS);
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("referenceSceneSchema", RUN_SCHEMA);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("kind", KIND_MANIFEST);
        lineage.put("requestId", request.requestId());
        lineage.put("templateId", spec.templateId());
        lineage.put("templateVersion", spec.templateVersion());
        lineage.put("seed", spec.seed());
        lineage.put("specSha256", specSha);
        lineage.put("set", setRef);
        lineage.put("sources", sources);
        lineage.put("parent", sources.getFirst());
        List<Map<String, Object>> siblings = new ArrayList<>();
        for (MediaArtifact scene : sceneArtifacts) siblings.add(MediaDevDubSupport.ref(scene));
        lineage.put("siblings", siblings);
        lineage.put("rightsDecision", rightsDecision);
        lineage.put("claims", CLAIMS);
        MediaArtifact manifest = registerOne(tenantId, principalId, "manifest", request.requestId(),
                MediaDevDubSupport.json(document), "application/json", "json",
                "refscene-manifest-" + MediaDevDubSupport.safeName(request.requestId()), lineage);
        return new Run(sceneArtifacts, manifest, document, false);
    }

    private static Map<String, Object> summary(List<SceneResult> results) {
        double maxHistogram = 0;
        double minSsim = 1;
        int maxHash = 0;
        double maxCross = 0;
        double minPalette = 1;
        for (SceneResult result : results) {
            minPalette = Math.min(minPalette, (double) result.metrics().get("paletteAdherence"));
            for (Object slotObject : (List<?>) result.metrics().get("slots")) {
                Map<?, ?> slot = (Map<?, ?>) slotObject;
                maxHistogram = Math.max(maxHistogram, (double) slot.get("histogramDistance"));
                minSsim = Math.min(minSsim, (double) slot.get("ssim"));
                maxHash = Math.max(maxHash, (int) slot.get("hashDistance"));
                if (slot.get("crossScene") instanceof Map<?, ?> cross) {
                    maxCross = Math.max(maxCross, (double) cross.get("histogramDistance"));
                }
            }
        }
        Map<String, Object> summary = new LinkedHashMap<>();
        summary.put("maxHistogramDistance", MediaDevReferenceSceneImaging.round6(maxHistogram));
        summary.put("minSsim", MediaDevReferenceSceneImaging.round6(minSsim));
        summary.put("maxHashDistance", maxHash);
        summary.put("maxCrossSceneHistogramDistance", MediaDevReferenceSceneImaging.round6(maxCross));
        summary.put("minPaletteAdherence", MediaDevReferenceSceneImaging.round6(minPalette));
        return summary;
    }

    // ------------------------------------------------------------------ regeneration

    /**
     * Re-checks rights, re-renders the run from its stored manifest and compares with it and with the stored bytes.
     * Registers nothing. The stored PNG with its request tag removed must equal the regenerated canonical PNG.
     */
    Map<String, Object> regenerate(String tenantId, String principalId, String runId) {
        Run run = reopen(tenantId, principalId, runId).orElseThrow(() -> new RefSceneRefusedException(404,
                "REFERENCE_SCENE_RUN_NOT_FOUND", "The run is not available in this tenant and owner scope", Map.of()));
        return runtime.devAdmission().run(MediaDevRenderAdmission.LANE_CREATIVE, "reference_scene", tenantId, () -> {
            Map<String, Object> document = run.document();
            @SuppressWarnings("unchecked") Map<String, Object> request = (Map<String, Object>) document.get("request");
            MediaDevReferenceSceneSpec.Parsed spec = MediaDevReferenceSceneSpec.parse(request.get("template"),
                    request.get("seed"), request.get("sceneCount"), request.get("parameters"), request.get("continuity"));
            @SuppressWarnings("unchecked") Map<String, Object> setRef = (Map<String, Object>) document.get("set");
            RefSet set = reopenSet(tenantId, principalId, (String) setRef.get("artifactId")).orElseThrow(() ->
                    new RefSceneRefusedException(404, "REFERENCE_SET_NOT_FOUND",
                            "The reference set is not available in this tenant and owner scope", Map.of()));
            List<Resolved> used = resolveUsed(tenantId, principalId, spec, set);
            String specSha = MediaDevReferenceSceneImaging.sha256(MediaDevDubSupport.json(spec.canonical()));
            List<SceneResult> results = renderAll(tenantId, principalId, spec, used, specSha);
            List<?> stored = (List<?>) document.get("scenes");
            List<Map<String, Object>> comparisons = new ArrayList<>();
            boolean allIdentical = specSha.equals(document.get("specSha256"));
            for (SceneResult result : results) {
                Map<?, ?> storedScene = (Map<?, ?>) stored.get(result.index());
                MediaArtifact artifact = run.scenes().get(result.index());
                byte[] storedBytes = readBytes(tenantId, principalId, artifact);
                String storedCanonical = MediaDevReferenceSceneImaging.sha256(MediaDevReferenceSceneImaging.untag(storedBytes));
                boolean manifestMatches = result.canonicalSha().equals(storedScene.get("canonicalPngSha256"))
                        && result.pixelSha().equals(storedScene.get("pixelSha256"));
                boolean bytesMatch = result.canonicalSha().equals(storedCanonical);
                boolean metricsMatch = MediaDevDubSupport.JSON.valueToTree(result.metrics())
                        .equals(MediaDevDubSupport.JSON.valueToTree(storedScene.get("metrics")));
                allIdentical &= manifestMatches && bytesMatch && metricsMatch;
                Map<String, Object> comparison = new LinkedHashMap<>();
                comparison.put("index", result.index());
                comparison.put("regeneratedCanonicalPngSha256", result.canonicalSha());
                comparison.put("manifestCanonicalPngSha256", storedScene.get("canonicalPngSha256"));
                comparison.put("storedArtifactMinusTagSha256", storedCanonical);
                comparison.put("manifestMatches", manifestMatches);
                comparison.put("storedBytesMatch", bytesMatch);
                comparison.put("metricsMatch", metricsMatch);
                comparisons.add(comparison);
            }
            Map<String, Object> out = new LinkedHashMap<>();
            out.put("schema", "media.dev.reference-scene-regeneration.v1");
            out.put("scope", "DEV_ONLY");
            out.put("runId", run.manifest().artifactId());
            out.put("byteIdentical", allIdentical);
            out.put("rightsRechecked", true);
            out.put("artifactsCreated", 0);
            out.put("scenes", comparisons);
            return out;
        });
    }

    // ------------------------------------------------------------------ inputs and rights

    private void checkImage(MediaArtifact artifact, String path) {
        String type = artifact.contentType().toLowerCase(Locale.ROOT);
        if (!type.equals("image/png") && !type.equals("image/jpeg")) {
            throw new RefSceneRefusedException(422, "REFERENCE_NOT_SUPPORTED",
                    "a reference must be an image/png or image/jpeg artifact version", Map.of("path", path));
        }
        if (artifact.sizeBytes() > MAX_ASSET_BYTES) {
            throw new RefSceneRefusedException(422, "REFERENCE_TOO_LARGE", "the reference exceeds the byte ceiling",
                    Map.of("path", path, "ceiling", MAX_ASSET_BYTES, "requested", artifact.sizeBytes()));
        }
    }

    private Resolution admit(String tenantId, MediaArtifact artifact, String path) {
        Resolution resolution;
        try {
            resolution = rights.resolve(new ResolutionRequest(tenantId, artifact.artifactId(),
                    artifact.version().value(), artifact.sha256(), Scope.PROCESSING));
        } catch (RuntimeException failure) {
            resolution = Resolution.unavailable(rights.resolverId());
        }
        if (resolution.admitted()) return resolution;
        boolean unavailable = resolution.verdict() == Verdict.UNAVAILABLE;
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("scope", "PROCESSING");
        details.put("path", path);
        details.put("artifactId", artifact.artifactId());
        details.put("verdict", resolution.verdict().name());
        details.put("reasons", resolution.reasons().stream().map(Enum::name).sorted().toList());
        details.put("artifactsCreated", 0);
        throw new RefSceneRefusedException(unavailable ? 503 : 403,
                unavailable ? "RIGHTS_AUTHORITY_UNAVAILABLE" : "RIGHTS_NOT_ADMITTED",
                "a reference image has no current PROCESSING rights and consent admission; nothing was generated", details);
    }

    private static Map<String, Object> admission(Resolution resolution) {
        Map<String, Object> admission = new LinkedHashMap<>();
        admission.put("scope", "PROCESSING");
        admission.put("verdict", resolution.verdict().name());
        admission.put("resolverId", resolution.resolverId());
        admission.put("attestationIds", resolution.attestationIds());
        return admission;
    }

    private static Map<String, Object> rightsDecision(int count, List<String> attestations) {
        Map<String, Object> decision = new LinkedHashMap<>();
        decision.put("kind", "RIGHTS_CONSENT_ATTESTATION");
        decision.put("scope", Scope.PROCESSING.name());
        decision.put("referenceCount", count);
        decision.put("attestationIds", attestations);
        decision.put("productionGrant", false);
        return decision;
    }

    private Raster decodeReference(String tenantId, String principalId, MediaArtifact artifact, String referenceId) {
        byte[] bytes = readBytes(tenantId, principalId, artifact);
        if (!MediaDevReferenceSceneImaging.sha256(bytes).equals(artifact.sha256())) {
            throw new RefSceneRefusedException(500, "REFERENCE_CONTENT_MISMATCH",
                    "the stored reference does not match its registered digest; nothing was generated",
                    Map.of("referenceId", referenceId));
        }
        try (ImageInputStream input = ImageIO.createImageInputStream(new ByteArrayInputStream(bytes))) {
            Iterator<ImageReader> readers = ImageIO.getImageReaders(input);
            if (!readers.hasNext()) throw unsupported(referenceId);
            ImageReader reader = readers.next();
            try {
                reader.setInput(input, true, true);
                long pixels = (long) reader.getWidth(0) * reader.getHeight(0);
                if (pixels > MAX_ASSET_PIXELS) {
                    throw new RefSceneRefusedException(422, "REFERENCE_TOO_LARGE", "the reference exceeds the pixel ceiling",
                            Map.of("referenceId", referenceId, "ceiling", MAX_ASSET_PIXELS, "requested", pixels));
                }
                BufferedImage image = reader.read(0);
                int width = image.getWidth();
                int height = image.getHeight();
                int[] argb = image.getRGB(0, 0, width, height, null, 0, width);
                image.flush();
                return new Raster(width, height, argb);
            } finally {
                reader.dispose();
            }
        } catch (IOException | RuntimeException failure) {
            if (failure instanceof RefSceneRefusedException refused) throw refused;
            throw unsupported(referenceId);
        }
    }

    private static RefSceneRefusedException unsupported(String referenceId) {
        return new RefSceneRefusedException(422, "REFERENCE_NOT_SUPPORTED", "the reference bytes are not a decodable image",
                Map.of("referenceId", referenceId));
    }

    private byte[] readBytes(String tenantId, String principalId, MediaArtifact artifact) {
        ByteArrayOutputStream content = new ByteArrayOutputStream((int) Math.max(1, artifact.sizeBytes()));
        try {
            runtime.copyArtifactContent(tenantId, principalId, artifact.artifactId(), artifact.version(), content,
                    MAX_DOCUMENT_BYTES).orElseThrow(MediaDevProjectRenderRuntime.SourceVersionUnavailableException::new);
        } catch (IOException unreadable) {
            throw new RefSceneRefusedException(503, "REFERENCE_SCENE_STORE_UNAVAILABLE",
                    "an artifact could not be read; nothing was registered", Map.of());
        }
        return content.toByteArray();
    }

    private Map<String, Object> readDocument(String tenantId, String principalId, MediaArtifact artifact) {
        if (artifact.sizeBytes() > MAX_DOCUMENT_BYTES) {
            throw new RefSceneRefusedException(422, "REFERENCE_SCENE_DOCUMENT_TOO_LARGE",
                    "the stored document exceeds the byte ceiling", Map.of());
        }
        try {
            return MediaDevDubSupport.JSON.readValue(readBytes(tenantId, principalId, artifact),
                    new TypeReference<LinkedHashMap<String, Object>>() { });
        } catch (RuntimeException unreadable) {
            if (unreadable instanceof RefSceneRefusedException refused) throw refused;
            if (unreadable instanceof MediaDevProjectRenderRuntime.SourceVersionUnavailableException missing) throw missing;
            throw new RefSceneRefusedException(422, "REFERENCE_SCENE_DOCUMENT_INVALID",
                    "the stored document is not readable JSON", Map.of());
        }
    }

    static Map<String, Object> lineageOf(MediaArtifact artifact) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        for (String key : LINEAGE_KEYS) {
            if (artifact.metadata().containsKey(key)) lineage.put(key, artifact.metadata().get(key));
        }
        return lineage;
    }

    // ------------------------------------------------------------------ registration helper

    private MediaArtifact registerOne(String tenantId, String principalId, String role, String requestId, byte[] bytes,
                                      String contentType, String extension, String namePrefix, Map<String, Object> lineage) {
        String sha256 = MediaDevReferenceSceneImaging.sha256(bytes);
        Map<String, Object> metadata = new LinkedHashMap<>(lineage);
        metadata.put("purpose", "reference-scene-output");
        UploadRequest upload = new UploadRequest(tenantId, principalId, namePrefix + "." + extension, contentType,
                bytes.length, sha256, "INTERNAL", Duration.ofDays(30), metadata);
        String idempotencyKey = "dev-refscene:" + role + ":" + MediaDevProjectRenderRuntime.sha256Hex(
                tenantId + "\u0000" + principalId + "\u0000" + requestId);
        MediaDevProjectRenderRuntime.Registered registered;
        try {
            registered = registrar.register(tenantId, principalId, upload, idempotencyKey, bytes);
        } catch (IllegalArgumentException conflict) {
            if (conflict.getMessage() != null && conflict.getMessage().contains("Idempotency-Key")) {
                throw new RefSceneRequestReusedException();
            }
            throw new RefSceneRegistrationFailedException(conflict);
        } catch (RuntimeException failure) {
            throw new RefSceneRegistrationFailedException(failure);
        }
        MediaArtifact artifact = registered.artifact();
        if (!artifact.sha256().equals(sha256)) {
            throw new RefSceneRegistrationFailedException(
                    new IllegalStateException("registered artifact digest does not match produced bytes"));
        }
        return artifact;
    }
}
