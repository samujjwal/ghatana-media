package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevCompositePlan.CaptionMode;
import com.ghatana.media.launcher.MediaDevCompositePlan.Color;
import com.ghatana.media.launcher.MediaDevCompositePlan.GapPolicy;
import com.ghatana.media.launcher.MediaDevSpeechRuntime.SpeechRefusedException;
import com.ghatana.media.launcher.MediaDevStoryboardSpec.Kind;
import com.ghatana.media.launcher.MediaDevStoryboardSpec.Ref;
import com.ghatana.media.launcher.MediaDevStoryboardSpec.Shot;
import com.ghatana.media.launcher.MediaDevStoryboardSpec.Storyboard;
import com.ghatana.media.production.review.ReviewContracts.SubjectKind;
import com.ghatana.media.production.timeline.ProjectTimelineEngine.AddScene;
import com.ghatana.media.production.timeline.ProjectTimelineEngine.AddTrack;
import com.ghatana.media.production.timeline.ProjectTimelineEngine.Edit;
import com.ghatana.media.production.timeline.ProjectTimelineEngine.PutClip;
import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.LineageOwnershipException;
import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.Version;
import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.VersionLedger;
import com.ghatana.media.runtime.MediaArtifactVersionLedgerContracts.VersionLedgerFactory;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Clip;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Clock;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.RationalTime;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Revision;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.SourceVersion;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.Track;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.TrackKind;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.State;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.locks.ReentrantLock;

/**
 * DEV_ONLY versioned storyboard and shot plan (journey J-09, {@code media.dev.outcome-brief-to-reviewed-media}).
 *
 * <p>A brief becomes a versioned storyboard ({@link MediaDevStoryboardSpec}): every version is an immutable JSON artifact
 * registered through the canonical artifact store and appended to an owner-scoped lineage of the existing DEV_ONLY version
 * ledger, so versions are durable, gapless and survive a launcher restart. An edit names the version it was made against;
 * any other head is {@code 409 STORYBOARD_VERSION_STALE} and nothing is written.</p>
 *
 * <p><b>No fake readiness.</b> {@link #readiness} derives, from live state on every call, whether each shot can be
 * rendered: the renderer must be composed, a placeholder is never renderable, a stored asset must be visible, decodable,
 * long enough and carry a current ADMITTED PROCESSING rights decision, an animation needs its renderer and the rights
 * statement for the authored content. Each reason is typed and names the JSON path. A render is refused (403 for rights,
 * 422 otherwise) while any shot is blocked.</p>
 *
 * <p><b>Render.</b> Animation shots are rendered by the J-12 lane (exact frames for the shot duration), the shots, the
 * per-scene narration and the caption file are placed at their derived story times on a project timeline and rendered by
 * the J-18 composite lane into one MP4. The render lineage names the storyboard version and every source version, so
 * erasing any asset erases the render. The render is a normal artifact version for J-21 review; this class tells the review
 * runtime that a render is superseded once its storyboard gains a later version.</p>
 */
final class MediaDevStoryboardRuntime implements AutoCloseable {
    static final String ENABLED = "MEDIA_DEV_STORYBOARD_ENABLED";
    static final String RENDER_SCHEMA = "media.dev.storyboard-render.v1";
    static final String LANE_CREATE = "storyboard.create";
    static final String LANE_EDIT = "storyboard.edit";
    static final String LANE_RENDER = "storyboard.render";
    private static final String TIMELINE = "timeline-main";
    private static final Set<String> VIDEO_TYPES = Set.of("video/mp4", "video/quicktime", "video/webm", "video/x-matroska");
    private static final Set<String> AUDIO_TYPES = Set.of("audio/wav", "audio/x-wav", "audio/wave", "audio/mpeg",
            "audio/mp4", "audio/aac", "audio/flac", "audio/ogg");

    /** One stored version of a storyboard, loaded from its immutable artifact. */
    record StoryboardVersion(String storyboardId, int versionNumber, MediaArtifact artifact, Storyboard storyboard,
                             int headVersion) {
        boolean head() { return versionNumber == headVersion; }
    }

    record Written(StoryboardVersion version, boolean replayed) { }

    /** A typed reason a shot, scene or the whole storyboard cannot render. */
    record Blocker(String code, String path, String sceneId, String shotId, String message, Map<String, Object> details) {
        boolean rights() { return code.contains("RIGHTS_"); }

        Map<String, Object> view() {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("code", code);
            view.put("path", path);
            if (sceneId != null) view.put("sceneId", sceneId);
            if (shotId != null) view.put("shotId", shotId);
            view.put("message", message);
            if (!details.isEmpty()) view.put("details", details);
            return view;
        }
    }

    record Readiness(boolean renderable, List<Blocker> blockers, List<Map<String, Object>> shots,
                     Map<String, Long> narrationMs) {
        Map<String, Object> view() {
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("renderable", renderable);
            view.put("blockers", blockers.stream().map(Blocker::view).toList());
            view.put("shots", shots);
            return view;
        }
    }

    record Rendered(StoryboardVersion version, MediaArtifact artifact, Map<String, Object> lineage, boolean replayed) { }

    private final MediaRuntime runtime;
    private final MediaDevProjectTimelineRuntime projects;
    private final MediaDevDubSupport support;
    private final MediaDevRequestLedger ledger;
    private final VersionLedger versions;
    private final MediaDevCompositeRenderRuntime composite;
    private final MediaDevAnimationRuntime animation;
    private final MediaDevReviewRuntime reviews;
    private final ConcurrentHashMap<String, ReentrantLock> locks = new ConcurrentHashMap<>();

    MediaDevStoryboardRuntime(MediaRuntime runtime, MediaDevProjectTimelineRuntime projects, MediaDevDubSupport support,
                              MediaDevRequestLedger ledger, VersionLedger versions, MediaDevCompositeRenderRuntime composite,
                              MediaDevAnimationRuntime animation, MediaDevReviewRuntime reviews) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.projects = Objects.requireNonNull(projects, "projects");
        this.support = Objects.requireNonNull(support, "support");
        this.ledger = Objects.requireNonNull(ledger, "ledger");
        this.versions = Objects.requireNonNull(versions, "versions");
        this.composite = composite;
        this.animation = animation;
        this.reviews = reviews;
    }

    /** Null unless explicitly enabled; the storyboard needs the DEV_ONLY project timeline and the durable request ledger. */
    static MediaDevStoryboardRuntime compose(MediaRuntime runtime, Map<String, String> environment,
                                             MediaDevProjectTimelineRuntime projects, MediaDevCompositeRenderRuntime composite,
                                             MediaDevAnimationRuntime animation, RightsConsentResolver resolver,
                                             MediaDevRequestLedger ledger, MediaDevReviewRuntime reviews) {
        String flag = environment.getOrDefault(ENABLED, "false");
        if (!"true".equalsIgnoreCase(flag) && !"false".equalsIgnoreCase(flag)) {
            throw new IllegalArgumentException(ENABLED + " must be true or false");
        }
        if (!"true".equalsIgnoreCase(flag)) return null;
        if (projects == null || ledger == null) {
            throw new IllegalArgumentException(ENABLED + " requires " + MediaDevProjectTimelineRuntime.ENABLED
                    + "=true and the DEV_ONLY request ledger");
        }
        List<VersionLedgerFactory> factories = ServiceLoader.load(VersionLedgerFactory.class).stream()
                .map(ServiceLoader.Provider::get)
                .filter(factory -> "postgresql-dev-artifact-version-ledger".equals(factory.factoryId())).toList();
        if (factories.size() != 1) {
            throw new IllegalStateException("exactly one PostgreSQL DEV_ONLY artifact version ledger factory is required");
        }
        MediaDevStoryboardRuntime storyboards = new MediaDevStoryboardRuntime(runtime, projects,
                new MediaDevDubSupport(runtime, MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), resolver), ledger,
                factories.getFirst().createDevOnly(Map.copyOf(environment)), composite, animation, reviews);
        if (reviews != null) reviews.attachSupersession(storyboards::supersededBy);
        return storyboards;
    }

    Map<String, Object> capabilities() {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("scope", "DEV_ONLY");
        view.put("schema", MediaDevStoryboardSpec.SCHEMA);
        view.put("shotSources", List.of("ANIMATION", "ASSET", "PLACEHOLDER"));
        Map<String, Object> renderer = new LinkedHashMap<>();
        renderer.put("compositeAvailable", composite != null);
        renderer.put("animationAvailable", animation != null);
        renderer.put("reviewAvailable", reviews != null);
        view.put("renderer", renderer);
        view.put("limits", Map.of("maxScenes", MediaDevStoryboardSpec.MAX_SCENES, "maxShotsPerScene",
                MediaDevStoryboardSpec.MAX_SHOTS_PER_SCENE, "maxShots", MediaDevStoryboardSpec.MAX_SHOTS,
                "maxShotMs", MediaDevStoryboardSpec.MAX_SHOT_MS, "maxTimelineSeconds",
                composite == null ? 0 : composite.config().maxSeconds()));
        view.put("storyTime", "derived: scenes and shots play in array order, contiguous, frame aligned; never authored");
        view.put("note", "DEV_ONLY authored plan; a render is a version-specific review subject, never an approval.");
        return view;
    }

    // ================================================================== versions

    private static String lineageId(String tenantId, String principalId, String storyboardId) {
        return "sb." + MediaDevProjectRenderRuntime.sha256Hex((tenantId + "\u0000" + principalId)
                .getBytes(StandardCharsets.UTF_8)).substring(0, 16) + "." + storyboardId;
    }

    private static String hash(Object... parts) {
        return MediaDevRequestLedger.fingerprint("storyboard", parts);
    }

    private ReentrantLock lock(String lineage) {
        return locks.computeIfAbsent(lineage, key -> new ReentrantLock());
    }

    static Storyboard parseBody(Map<String, Object> body) {
        return MediaDevStoryboardSpec.parse(body);
    }

    /** Brief to storyboard: authored scenes when given, otherwise the deterministic one-placeholder-per-paragraph scaffold. */
    Written create(String tenantId, String principalId, String requestId, String storyboardId, Map<String, Object> body) {
        Map<String, Object> authored = new LinkedHashMap<>(body);
        if (!authored.containsKey("scenes") && authored.get("brief") instanceof Map<?, ?> brief
                && brief.get("text") instanceof String text) {
            authored.putAll(MediaDevStoryboardSpec.draftScenes(text));
        }
        Storyboard storyboard = parseBody(authored);
        String id = storyboardId != null ? storyboardId : "sb-" + MediaDevProjectRenderRuntime.sha256Hex(
                (tenantId + "\u0000" + principalId + "\u0000" + requestId).getBytes(StandardCharsets.UTF_8)).substring(0, 20);
        if (!id.matches("[a-z0-9][a-z0-9-]{0,47}")) {
            throw MediaDevStoryboardSpec.invalid("$.storyboardId", "storyboardId must be 1-48 lowercase letters, digits, hyphens");
        }
        String fingerprint = hash("create", id, canonical(storyboard.authored()));
        return ledger.run(tenantId, principalId, LANE_CREATE, requestId, fingerprint,
                outputs -> new Written(reopen(tenantId, principalId, outputs, LANE_CREATE), true),
                () -> new Written(append(tenantId, principalId, id, 0, storyboard), false),
                written -> List.of(output(written.version())), reused());
    }

    /** Appends the next version against the version the caller edited; any other head is a stale edit. */
    Written edit(String tenantId, String principalId, String requestId, String storyboardId, int expectedVersion,
                 Map<String, Object> body) {
        Storyboard storyboard = parseBody(body);
        String fingerprint = hash("edit", storyboardId, expectedVersion, canonical(storyboard.authored()));
        return ledger.run(tenantId, principalId, LANE_EDIT, requestId, fingerprint,
                outputs -> new Written(reopen(tenantId, principalId, outputs, LANE_EDIT), true),
                () -> new Written(append(tenantId, principalId, storyboardId, expectedVersion, storyboard), false),
                written -> List.of(output(written.version())), reused());
    }

    private static java.util.function.Supplier<RuntimeException> reused() {
        return () -> new MediaDevSpeechRuntime.SpeechRequestReusedException(
                new IllegalArgumentException("requestId used with a different request"));
    }

    private static OutputRef output(StoryboardVersion version) {
        return new OutputRef("version", version.artifact().artifactId(), version.artifact().version().value());
    }

    private StoryboardVersion reopen(String tenantId, String principalId, List<OutputRef> outputs, String lane) {
        OutputRef ref = outputs.stream().filter(candidate -> candidate.role().equals("version")).findFirst()
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(lane));
        MediaArtifact artifact = runtime.artifact(tenantId, principalId, ref.artifactId())
                .filter(found -> found.version().value().equals(ref.versionId()))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(lane));
        String id = String.valueOf(artifact.metadata().get("storyboardId"));
        int number = ((Number) artifact.metadata().get("versionNumber")).intValue();
        List<Version> all = versions.versions(tenantId, principalId, lineageId(tenantId, principalId, id));
        if (all.isEmpty()) throw MediaDevRequestLedger.outputUnavailable(lane);
        return load(tenantId, principalId, id, all.get(number - 1), all.getLast().versionNumber());
    }

    private StoryboardVersion append(String tenantId, String principalId, String id, int expectedHead, Storyboard storyboard) {
        String lineage = lineageId(tenantId, principalId, id);
        ReentrantLock lock = lock(lineage);
        lock.lock();
        try {
            List<Version> existing = versions.versions(tenantId, principalId, lineage);
            int head = existing.isEmpty() ? 0 : existing.getLast().versionNumber();
            if (expectedHead == 0 && head != 0) {
                throw new SpeechRefusedException(409, "STORYBOARD_EXISTS", "a storyboard with this id already exists",
                        Map.of("headVersion", head));
            }
            if (expectedHead != 0 && head == 0) throw notFound();
            if (head != expectedHead) {
                throw new SpeechRefusedException(409, "STORYBOARD_VERSION_STALE",
                        "the storyboard was edited against version " + expectedHead + " but its head is version " + head
                                + "; nothing was written",
                        Map.of("expectedVersion", expectedHead, "headVersion", head));
            }
            int number = head + 1;
            Map<String, Object> document = new LinkedHashMap<>();
            document.put("schema", MediaDevStoryboardSpec.SCHEMA);
            document.put("scope", "DEV_ONLY");
            document.put("storyboardId", id);
            document.put("versionNumber", number);
            document.put("parentVersionNumber", head == 0 ? null : head);
            document.putAll(storyboard.authored());
            byte[] bytes = canonical(document).getBytes(StandardCharsets.UTF_8);
            String sha = MediaDevProjectRenderRuntime.sha256Hex(bytes);
            Map<String, Object> metadata = new LinkedHashMap<>();
            metadata.put("storyboardSchema", MediaDevStoryboardSpec.SCHEMA);
            metadata.put("scope", "DEV_ONLY");
            metadata.put("storyboardId", id);
            metadata.put("versionNumber", number);
            metadata.put("contentSha256", sha);
            MediaDevDubSupport.Output output = support.register(tenantId, principalId, "INTERNAL", "storyboard",
                    id + ":v" + number + ":" + sha.substring(0, 16), bytes, "application/json", "json",
                    "storyboard-" + id + "-v" + number, "storyboard-version", metadata);
            MediaArtifact artifact = output.artifact();
            try {
                Version registered = versions.register(tenantId, principalId, lineage, artifact.artifactId(),
                        artifact.version().value(), artifact.sha256(), artifact.sizeBytes(), "{}").version();
                if (registered.versionNumber() != number) throw new IllegalStateException("storyboard version ledger skew");
            } catch (LineageOwnershipException concealed) {
                throw notFound();
            }
            return new StoryboardVersion(id, number, artifact, storyboard, number);
        } finally {
            lock.unlock();
        }
    }

    static SpeechRefusedException notFound() {
        return new SpeechRefusedException(404, "STORYBOARD_NOT_FOUND",
                "the storyboard is not available in this tenant and owner scope", Map.of());
    }

    private StoryboardVersion load(String tenantId, String principalId, String id, Version stored, int head) {
        MediaArtifact artifact = support.exact(tenantId, principalId, stored.artifactId(), stored.artifactVersionId());
        var document = support.readDocument(tenantId, principalId, artifact);
        Map<String, Object> map = MediaDevDubSupport.JSON.convertValue(document,
                new tools.jackson.core.type.TypeReference<LinkedHashMap<String, Object>>() { });
        if (!id.equals(map.get("storyboardId")) || !(map.get("versionNumber") instanceof Number number)
                || number.intValue() != stored.versionNumber()) {
            throw new SpeechRefusedException(502, "STORYBOARD_VERSION_UNREADABLE",
                    "the stored storyboard version does not match its ledger entry", Map.of());
        }
        Map<String, Object> authored = new LinkedHashMap<>();
        for (String key : List.of("brief", "format", "captions", "scenes")) authored.put(key, map.get(key));
        if (authored.get("captions") == null) authored.remove("captions");
        return new StoryboardVersion(id, stored.versionNumber(), artifact, parseBody(authored), head);
    }

    Optional<StoryboardVersion> head(String tenantId, String principalId, String id) {
        List<Version> all = versions.versions(tenantId, principalId, lineageId(tenantId, principalId, id));
        return all.isEmpty() ? Optional.empty()
                : Optional.of(load(tenantId, principalId, id, all.getLast(), all.getLast().versionNumber()));
    }

    Optional<StoryboardVersion> version(String tenantId, String principalId, String id, int number) {
        List<Version> all = versions.versions(tenantId, principalId, lineageId(tenantId, principalId, id));
        if (all.isEmpty() || number < 1 || number > all.size()) return Optional.empty();
        return Optional.of(load(tenantId, principalId, id, all.get(number - 1), all.getLast().versionNumber()));
    }

    List<Version> history(String tenantId, String principalId, String id) {
        return versions.versions(tenantId, principalId, lineageId(tenantId, principalId, id));
    }

    // ================================================================== readiness

    Readiness readiness(String tenantId, String principalId, StoryboardVersion version) {
        Storyboard sb = version.storyboard();
        List<Blocker> blockers = new ArrayList<>();
        List<Map<String, Object>> shotViews = new ArrayList<>();
        Map<String, Long> narrationMs = new LinkedHashMap<>();
        if (composite == null) {
            blockers.add(new Blocker("RENDERER_UNAVAILABLE", "$", null, null,
                    "the composite renderer is not configured on this launcher; nothing can be rendered", Map.of()));
        } else if (sb.totalMs() > composite.config().maxSeconds() * 1000.0) {
            blockers.add(new Blocker("RENDER_DURATION_BUDGET", "$.scenes", null, null,
                    "the storyboard is longer than the " + composite.config().maxSeconds() + " s render budget",
                    Map.of("totalMs", sb.totalMs())));
        }
        // The authored content (procedural animation) is covered by the rights statement on the storyboard version itself.
        Blocker anchor = null;
        boolean needsAnchor = sb.scenes().stream().flatMap(scene -> scene.shots().stream())
                .anyMatch(shot -> shot.kind() == Kind.ANIMATION);
        if (needsAnchor) {
            try {
                support.requireProcessing(tenantId, principalId, version.artifact());
            } catch (SpeechRefusedException refused) {
                anchor = new Blocker(rightsCode("AUTHORED_RIGHTS", refused), "$", null, null,
                        "the authored animation content needs a current ADMITTED PROCESSING rights statement for this exact "
                                + "storyboard version", merge(refused.details(), Map.of("artifactId",
                                version.artifact().artifactId(), "artifactVersionId", version.artifact().version().value())));
            }
        }
        for (MediaDevStoryboardSpec.Scene scene : sb.scenes()) {
            if (scene.narration() != null) {
                List<Blocker> reasons = new ArrayList<>();
                narration(tenantId, principalId, scene, reasons, narrationMs);
                blockers.addAll(reasons);
            }
            for (Shot shot : scene.shots()) {
                List<Blocker> reasons = new ArrayList<>();
                if (composite == null) {
                    reasons.add(new Blocker("RENDERER_UNAVAILABLE", shot.path() + ".source", scene.sceneId(), shot.shotId(),
                            "the composite renderer is not configured on this launcher", Map.of()));
                }
                switch (shot.kind()) {
                    case PLACEHOLDER -> reasons.add(new Blocker("PLACEHOLDER_NOT_RENDERABLE", shot.path() + ".source", scene.sceneId(),
                            shot.shotId(), "a placeholder is an authored intent; it has no source to render",
                            Map.of("note", shot.note())));
                    case ASSET -> asset(tenantId, principalId, scene, shot, reasons);
                    case ANIMATION -> animationShot(tenantId, principalId, scene, shot, anchor, reasons);
                }
                blockers.addAll(reasons);
                Map<String, Object> view = new LinkedHashMap<>();
                view.put("sceneId", scene.sceneId());
                view.put("shotId", shot.shotId());
                view.put("kind", shot.kind().name());
                view.put("startMs", shot.startMs());
                view.put("durationMs", shot.durationMs());
                view.put("state", reasons.isEmpty() ? "RENDERABLE" : "BLOCKED");
                view.put("reasons", reasons.stream().map(Blocker::view).toList());
                shotViews.add(view);
            }
        }
        if (sb.captions() != null) captions(tenantId, principalId, sb, blockers);
        return new Readiness(blockers.isEmpty(), List.copyOf(blockers), shotViews, narrationMs);
    }

    private void asset(String tenantId, String principalId, MediaDevStoryboardSpec.Scene scene, Shot shot,
                       List<Blocker> reasons) {
        String path = shot.path() + ".source";
        MediaArtifact artifact;
        try {
            artifact = support.exact(tenantId, principalId, shot.asset().artifactId(), shot.asset().artifactVersionId());
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException missing) {
            reasons.add(new Blocker("ASSET_UNAVAILABLE", path, scene.sceneId(), shot.shotId(),
                    "the exact asset version is not available (never uploaded, erased or not yours)", shot.asset().view()));
            return;
        }
        if (!VIDEO_TYPES.contains(baseType(artifact.contentType()))) {
            reasons.add(new Blocker("ASSET_NOT_VIDEO", path, scene.sceneId(), shot.shotId(),
                    "a shot asset must be a video artifact version",
                    Map.of("contentType", artifact.contentType())));
            return;
        }
        rights(tenantId, principalId, artifact, "RIGHTS", path, scene.sceneId(), shot.shotId(), reasons);
        if (composite == null || !reasons.isEmpty()) return;
        try {
            MediaDevCompositeRenderRuntime.Facts facts = composite.inspect(tenantId, principalId, artifact);
            if (!facts.hasVideo()) {
                reasons.add(new Blocker("ASSET_NOT_VIDEO", path, scene.sceneId(), shot.shotId(),
                        "the asset has no decodable video stream", Map.of()));
            } else if ((shot.sourceInMs() + shot.durationMs()) / 1000.0 > facts.durationSeconds() + 0.0005) {
                reasons.add(new Blocker("ASSET_TOO_SHORT", path, scene.sceneId(), shot.shotId(),
                        "the asset ends before the shot does (a clip is never stretched or looped)",
                        Map.of("assetSeconds", facts.durationSeconds(), "neededMs", shot.sourceInMs() + shot.durationMs())));
            }
        } catch (SpeechRefusedException refused) {
            reasons.add(new Blocker(refused.code(), path, scene.sceneId(), shot.shotId(), refused.getMessage(), Map.of()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException missing) {
            reasons.add(new Blocker("ASSET_UNAVAILABLE", path, scene.sceneId(), shot.shotId(),
                    "the asset content is not readable", shot.asset().view()));
        }
    }

    private void animationShot(String tenantId, String principalId, MediaDevStoryboardSpec.Scene scene, Shot shot,
                               Blocker anchor, List<Blocker> reasons) {
        String path = shot.path() + ".source";
        if (animation == null) {
            reasons.add(new Blocker("ANIMATION_RENDERER_UNAVAILABLE", path, scene.sceneId(), shot.shotId(),
                    "the animation renderer is not configured on this launcher", Map.of()));
        }
        if (anchor != null) {
            reasons.add(new Blocker(anchor.code(), path, scene.sceneId(), shot.shotId(), anchor.message(), anchor.details()));
        }
        Object assets = shot.animation().get("assets");
        if (assets instanceof List<?> list) {
            for (int i = 0; i < list.size(); i++) {
                if (!(list.get(i) instanceof Map<?, ?> asset) || !(asset.get("artifactId") instanceof String id)
                        || !(asset.get("artifactVersionId") instanceof String version)) continue;
                String assetPath = path + ".spec.assets[" + i + "]";
                try {
                    MediaArtifact artifact = support.exact(tenantId, principalId, id, version);
                    rights(tenantId, principalId, artifact, "RIGHTS", assetPath, scene.sceneId(), shot.shotId(), reasons);
                } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException missing) {
                    reasons.add(new Blocker("ANIMATION_ASSET_UNAVAILABLE", assetPath, scene.sceneId(), shot.shotId(),
                            "the animation's image asset version is not available",
                            Map.of("artifactId", id, "artifactVersionId", version)));
                }
            }
        }
    }

    private void narration(String tenantId, String principalId, MediaDevStoryboardSpec.Scene scene, List<Blocker> reasons,
                           Map<String, Long> narrationMs) {
        String path = scene.path() + ".narration";
        MediaArtifact artifact;
        try {
            artifact = support.exact(tenantId, principalId, scene.narration().artifactId(),
                    scene.narration().artifactVersionId());
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException missing) {
            reasons.add(new Blocker("NARRATION_UNAVAILABLE", path, scene.sceneId(), null,
                    "the exact narration version is not available (never uploaded, erased or not yours)",
                    scene.narration().view()));
            return;
        }
        if (!AUDIO_TYPES.contains(baseType(artifact.contentType()))) {
            reasons.add(new Blocker("NARRATION_NOT_AUDIO", path, scene.sceneId(), null,
                    "narration must be an audio artifact version", Map.of("contentType", artifact.contentType())));
            return;
        }
        int before = reasons.size();
        rights(tenantId, principalId, artifact, "RIGHTS", path, scene.sceneId(), null, reasons);
        if (reasons.size() > before || composite == null) return;
        try {
            MediaDevCompositeRenderRuntime.Facts facts = composite.inspect(tenantId, principalId, artifact);
            long ms = (long) Math.floor(facts.durationSeconds() * 1000.0 + 1e-6);
            if (!facts.hasAudio() || ms < 1) {
                reasons.add(new Blocker("NARRATION_NOT_AUDIO", path, scene.sceneId(), null,
                        "the narration has no decodable audio", Map.of()));
            } else if (ms > scene.durationMs()) {
                reasons.add(new Blocker("NARRATION_LONGER_THAN_SCENE", path, scene.sceneId(), null,
                        "the narration is longer than its scene (it is never cut or sped up)",
                        Map.of("narrationMs", ms, "sceneMs", scene.durationMs())));
            } else {
                narrationMs.put(scene.sceneId(), ms);
            }
        } catch (SpeechRefusedException refused) {
            reasons.add(new Blocker(refused.code(), path, scene.sceneId(), null, refused.getMessage(), Map.of()));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException missing) {
            reasons.add(new Blocker("NARRATION_UNAVAILABLE", path, scene.sceneId(), null,
                    "the narration content is not readable", scene.narration().view()));
        }
    }

    private void captions(String tenantId, String principalId, Storyboard sb, List<Blocker> blockers) {
        try {
            MediaArtifact artifact = support.exact(tenantId, principalId, sb.captions().artifactId(),
                    sb.captions().artifactVersionId());
            if (!"text/vtt".equals(baseType(artifact.contentType()))) {
                blockers.add(new Blocker("CAPTIONS_NOT_VTT", "$.captions", null, null,
                        "captions must be a text/vtt artifact version", Map.of("contentType", artifact.contentType())));
                return;
            }
            rights(tenantId, principalId, artifact, "RIGHTS", "$.captions", null, null, blockers);
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException missing) {
            blockers.add(new Blocker("CAPTIONS_UNAVAILABLE", "$.captions", null, null,
                    "the exact caption file version is not available", sb.captions().view()));
        }
    }

    private void rights(String tenantId, String principalId, MediaArtifact artifact, String prefix, String path,
                        String sceneId, String shotId, List<Blocker> into) {
        try {
            support.requireProcessing(tenantId, principalId, artifact);
        } catch (SpeechRefusedException refused) {
            into.add(new Blocker(rightsCode(prefix, refused), path, sceneId, shotId,
                    "source rights and consent do not admit PROCESSING of this exact version",
                    merge(refused.details(), Map.of("artifactId", artifact.artifactId(), "artifactVersionId",
                            artifact.version().value()))));
        } catch (MediaDevProjectRenderRuntime.SourceVersionUnavailableException chain) {
            into.add(new Blocker("ASSET_UNAVAILABLE", path, sceneId, shotId,
                    "a source in the derivation chain of this version is not available", Map.of()));
        }
    }

    private static String rightsCode(String prefix, SpeechRefusedException refused) {
        String code = refused.code();
        if ("RIGHTS_AUTHORITY_UNAVAILABLE".equals(code)) return prefix + "_NO_STATEMENT";
        if (code.startsWith("RIGHTS_DECISION_")) return prefix + "_" + code.substring("RIGHTS_DECISION_".length());
        return prefix + "_" + code;
    }

    private static Map<String, Object> merge(Map<String, Object> first, Map<String, Object> second) {
        Map<String, Object> merged = new LinkedHashMap<>();
        if (first != null) {
            first.forEach((key, value) -> { if ("scope".equals(key) || "verdict".equals(key)) merged.put(key, value); });
        }
        merged.putAll(second);
        return merged;
    }

    private static String baseType(String contentType) {
        String lower = contentType.toLowerCase(Locale.ROOT);
        int parameters = lower.indexOf(';');
        return (parameters < 0 ? lower : lower.substring(0, parameters)).trim();
    }

    // ================================================================== render

    private static String innerRequestId(String id, int number) {
        return "sbr-" + hash("render", id, number).substring(0, 40);
    }

    /** Renders the HEAD version. A stale version, a blocked shot or a missing renderer is refused before any effect. */
    Rendered render(String tenantId, String principalId, String requestId, String id, int number) {
        StoryboardVersion head = head(tenantId, principalId, id).orElseThrow(MediaDevStoryboardRuntime::notFound);
        if (number != head.versionNumber()) {
            throw new SpeechRefusedException(409, "STORYBOARD_VERSION_STALE",
                    "version " + number + " is not the head; only the head version renders (head is " + head.versionNumber() + ")",
                    Map.of("requestedVersion", number, "headVersion", head.versionNumber()));
        }
        Readiness readiness = readiness(tenantId, principalId, head);
        if (!readiness.renderable()) {
            boolean rights = readiness.blockers().stream().anyMatch(Blocker::rights);
            Map<String, Object> details = new LinkedHashMap<>();
            details.put("blockers", readiness.blockers().stream().map(Blocker::view).toList());
            details.put("storyboardVersion", number);
            throw new SpeechRefusedException(rights ? 403 : 422,
                    rights ? "STORYBOARD_RIGHTS_DENIED" : "STORYBOARD_NOT_RENDERABLE",
                    rights ? "source rights do not admit this render; nothing was rendered"
                            : "the storyboard has shots that cannot render; nothing was rendered", details);
        }
        String fingerprint = hash("render", id, number, head.artifact().version().value());
        return ledger.run(tenantId, principalId, LANE_RENDER, requestId, fingerprint,
                outputs -> replayRender(tenantId, principalId, head, outputs),
                () -> produce(tenantId, principalId, head, readiness),
                rendered -> List.of(new OutputRef("render", rendered.artifact().artifactId(),
                        rendered.artifact().version().value())),
                reused());
    }

    private Rendered replayRender(String tenantId, String principalId, StoryboardVersion version, List<OutputRef> outputs) {
        OutputRef ref = outputs.stream().filter(candidate -> candidate.role().equals("render")).findFirst()
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE_RENDER));
        return composite.reopen(tenantId, principalId, ref.artifactId())
                .filter(found -> found.artifact().version().value().equals(ref.versionId()))
                .map(found -> new Rendered(version, found.artifact(), found.lineage(), true))
                .orElseThrow(() -> MediaDevRequestLedger.outputUnavailable(LANE_RENDER));
    }

    private Rendered produce(String tenantId, String principalId, StoryboardVersion version, Readiness readiness) {
        Storyboard sb = version.storyboard();
        String id = version.storyboardId();
        int number = version.versionNumber();
        Map<String, MediaArtifact> shotVideo = new LinkedHashMap<>();
        Map<String, String> animationRenders = new LinkedHashMap<>();
        for (MediaDevStoryboardSpec.Scene scene : sb.scenes()) {
            for (Shot shot : scene.shots()) {
                if (shot.kind() == Kind.ASSET) {
                    shotVideo.put(shot.shotId(), support.exact(tenantId, principalId, shot.asset().artifactId(),
                            shot.asset().artifactVersionId()));
                } else {
                    var rendered = animation.render(tenantId, principalId, new MediaDevAnimationRuntime.RenderRequest(
                            "sba-" + hash("animation", id, number, shot.shotId()).substring(0, 40),
                            MediaDevStoryboardSpec.animationSpec(shot.animation(), sb.width(), sb.height(), sb.fps(),
                                    shot.durationMs()), MediaDevAnimationRuntime.DEFAULT_CRF, version.artifact()));
                    shotVideo.put(shot.shotId(), rendered.video());
                    animationRenders.put(shot.shotId(), rendered.manifest().artifactId());
                }
            }
        }
        Map<String, MediaArtifact> narration = new LinkedHashMap<>();
        for (MediaDevStoryboardSpec.Scene scene : sb.scenes()) {
            if (scene.narration() != null) {
                narration.put(scene.sceneId(), support.exact(tenantId, principalId, scene.narration().artifactId(),
                        scene.narration().artifactVersionId()));
            }
        }
        MediaArtifact captions = sb.captions() == null ? null : support.exact(tenantId, principalId,
                sb.captions().artifactId(), sb.captions().artifactVersionId());

        ReentrantLock lock = lock("project:" + lineageId(tenantId, principalId, id) + ":" + number);
        lock.lock();
        Revision revision;
        String projectId;
        try {
            String requestId = "sbp-" + hash("project", id, number).substring(0, 40);
            var created = projects.createProject(tenantId, principalId, projects.workspaceId(tenantId, principalId),
                    "Storyboard " + id + " v" + number, requestId);
            projectId = created.project().projectId();
            revision = created.createdNow() ? created.initialRevision() : projects.currentRevision(tenantId, principalId, projectId);
            boolean hasTimeline = revision.timelines().stream().anyMatch(t -> t.timelineId().equals(TIMELINE));
            if (!hasTimeline) {
                revision = projects.createTimeline(tenantId, principalId, projectId, revision.revisionId(), TIMELINE);
            }
            boolean placed = revision.timelines().stream().filter(t -> t.timelineId().equals(TIMELINE))
                    .anyMatch(t -> !t.graph().clips().isEmpty());
            if (!placed) {
                revision = projects.editTimeline(tenantId, principalId, projectId, TIMELINE, revision.revisionId(),
                        edits(sb, shotVideo, narration, readiness.narrationMs(), captions));
            }
        } finally {
            lock.unlock();
        }

        Map<String, Object> annotations = annotations(version, shotVideo, animationRenders, narration,
                readiness.narrationMs(), captions);
        var spec = new MediaDevCompositePlan.Spec(sb.width(), sb.height(), sb.fps(), GapPolicy.REFUSE,
                captions == null ? CaptionMode.NONE : CaptionMode.MUX, Color.NEUTRAL, List.of(), List.of());
        var result = composite.render(tenantId, principalId, new MediaDevCompositeRenderRuntime.Request(
                innerRequestId(id, number), projectId, revision.revisionId(), TIMELINE, spec,
                composite.config().maxOutputBytes(), annotations));
        return new Rendered(version, result.artifact(), result.lineage(), result.replayed());
    }

    private static RationalTime ms(long value, Clock clock) {
        return new RationalTime(value, 1000, 1, clock);
    }

    private static Clip clip(String clipId, String sceneId, String trackId, MediaArtifact source, long inMs, long startMs,
                             long durationMs) {
        return new Clip(clipId, sceneId, trackId, new SourceVersion(source.artifactId(), source.version().value()),
                ms(inMs, Clock.SOURCE_PRESENTATION), ms(inMs + durationMs, Clock.SOURCE_PRESENTATION),
                ms(startMs, Clock.STORY), ms(durationMs, Clock.STORY));
    }

    private static List<Edit> edits(Storyboard sb, Map<String, MediaArtifact> shotVideo, Map<String, MediaArtifact> narration,
                                    Map<String, Long> narrationMs, MediaArtifact captions) {
        List<Edit> edits = new ArrayList<>();
        int order = 0;
        for (MediaDevStoryboardSpec.Scene scene : sb.scenes()) {
            edits.add(new AddScene(new com.ghatana.media.runtime.MediaProjectTimelineContracts.Scene(scene.sceneId(), order++)));
        }
        for (int i = 0; i < sb.scenes().size(); i++) {
            MediaDevStoryboardSpec.Scene scene = sb.scenes().get(i);
            edits.add(new AddTrack(new Track("v-" + scene.sceneId(), scene.sceneId(), TrackKind.VIDEO, 0)));
            if (scene.narration() != null) {
                edits.add(new AddTrack(new Track("n-" + scene.sceneId(), scene.sceneId(), TrackKind.AUDIO, 1)));
            }
            if (i == 0 && captions != null) {
                edits.add(new AddTrack(new Track("caption-track", scene.sceneId(), TrackKind.CAPTION, 2)));
            }
        }
        for (MediaDevStoryboardSpec.Scene scene : sb.scenes()) {
            for (Shot shot : scene.shots()) {
                edits.add(new PutClip(clip("clip-" + shot.shotId(), scene.sceneId(), "v-" + scene.sceneId(),
                        shotVideo.get(shot.shotId()), shot.kind() == Kind.ASSET ? shot.sourceInMs() : 0, shot.startMs(),
                        shot.durationMs())));
            }
            if (scene.narration() != null) {
                edits.add(new PutClip(clip("nar-" + scene.sceneId(), scene.sceneId(), "n-" + scene.sceneId(),
                        narration.get(scene.sceneId()), 0, scene.startMs(), narrationMs.get(scene.sceneId()))));
            }
        }
        if (captions != null) {
            edits.add(new PutClip(clip("caption-clip", sb.scenes().getFirst().sceneId(), "caption-track", captions, 0, 0,
                    sb.totalMs())));
        }
        return edits;
    }

    private static Map<String, Object> annotations(StoryboardVersion version, Map<String, MediaArtifact> shotVideo,
                                                   Map<String, String> animationRenders, Map<String, MediaArtifact> narration,
                                                   Map<String, Long> narrationMs, MediaArtifact captions) {
        Storyboard sb = version.storyboard();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("storyboardId", version.storyboardId());
        out.put("storyboardVersion", version.versionNumber());
        out.put("storyboardArtifactId", version.artifact().artifactId());
        out.put("storyboardArtifactVersionId", version.artifact().version().value());
        out.put("totalMs", sb.totalMs());
        List<Object> shots = new ArrayList<>();
        for (MediaDevStoryboardSpec.Scene scene : sb.scenes()) {
            for (Shot shot : scene.shots()) {
                Map<String, Object> view = new LinkedHashMap<>();
                view.put("sceneId", scene.sceneId());
                view.put("shotId", shot.shotId());
                view.put("kind", shot.kind().name());
                view.put("clipId", "clip-" + shot.shotId());
                view.put("startMs", shot.startMs());
                view.put("endMs", shot.endMs());
                view.put("startFrame", shot.startMs() * sb.fps() / 1000);
                view.put("frames", shot.durationMs() * sb.fps() / 1000);
                MediaArtifact source = shotVideo.get(shot.shotId());
                view.put("artifactId", source.artifactId());
                view.put("artifactVersionId", source.version().value());
                if (animationRenders.containsKey(shot.shotId())) view.put("animationRenderId", animationRenders.get(shot.shotId()));
                shots.add(view);
            }
        }
        out.put("shots", shots);
        List<Object> narrations = new ArrayList<>();
        for (MediaDevStoryboardSpec.Scene scene : sb.scenes()) {
            MediaArtifact audio = narration.get(scene.sceneId());
            if (audio == null) continue;
            Map<String, Object> view = new LinkedHashMap<>();
            view.put("sceneId", scene.sceneId());
            view.put("clipId", "nar-" + scene.sceneId());
            view.put("artifactId", audio.artifactId());
            view.put("artifactVersionId", audio.version().value());
            view.put("startMs", scene.startMs());
            view.put("durationMs", narrationMs.get(scene.sceneId()));
            narrations.add(view);
        }
        out.put("narration", narrations);
        if (captions != null) {
            Map<String, Object> captionView = new LinkedHashMap<>();
            captionView.put("artifactId", captions.artifactId());
            captionView.put("artifactVersionId", captions.version().value());
            captionView.put("clipId", "caption-clip");
            out.put("captions", captionView);
        }
        return out;
    }

    /** The existing render of one storyboard version, or empty (never rendered, erased with a source, or no renderer). */
    Optional<MediaDevCompositeRenderRuntime.Result> renderOf(String tenantId, String principalId, String id, int number) {
        if (composite == null) return Optional.empty();
        var entry = ledger.find(tenantId, principalId, MediaDevCompositeRenderRuntime.LANE, innerRequestId(id, number));
        if (entry.isEmpty() || entry.get().state() != State.COMPLETED) return Optional.empty();
        return entry.get().outputs().stream().filter(ref -> ref.role().equals("render")).findFirst()
                .flatMap(ref -> composite.reopen(tenantId, principalId, ref.artifactId())
                        .filter(found -> found.artifact().version().value().equals(ref.versionId())));
    }

    // ================================================================== review handoff

    record Handoff(String reviewCaseId, boolean created, String artifactId, String artifactVersionId) { }

    /** Opens (or returns) the version-specific review case of this version's render. A superseded render is refused. */
    Handoff handoff(String tenantId, String principalId, String id, int number) {
        if (reviews == null) {
            throw new SpeechRefusedException(503, "REVIEW_UNAVAILABLE", "the DEV_ONLY review runtime is not enabled", Map.of());
        }
        if (version(tenantId, principalId, id, number).isEmpty()) throw notFound();
        var render = renderOf(tenantId, principalId, id, number).orElseThrow(() -> new SpeechRefusedException(404,
                "RENDER_NOT_FOUND", "this storyboard version has no render to review", Map.of()));
        try {
            var opened = reviews.open(tenantId, principalId, SubjectKind.ARTIFACT_VERSION, render.artifact().artifactId(),
                    render.artifact().version().value());
            return new Handoff(opened.reviewCase().reviewCaseId(), opened.created(), render.artifact().artifactId(),
                    render.artifact().version().value());
        } catch (MediaDevReviewRuntime.SubjectSupersededException superseded) {
            throw new SpeechRefusedException(409, "STORYBOARD_VERSION_STALE",
                    "the storyboard has a later version; this render can no longer be opened for review",
                    Map.of("requestedVersion", number));
        } catch (MediaDevReviewRuntime.SubjectNotFoundException missing) {
            throw new SpeechRefusedException(404, "RENDER_NOT_FOUND", "the render is not available for review", Map.of());
        }
    }

    Optional<MediaDevReviewRuntime.SubjectReviewStatus> reviewStatus(String tenantId, String principalId, String id, int number) {
        if (reviews == null) return Optional.empty();
        return renderOf(tenantId, principalId, id, number).map(render -> reviews.artifactReviewStatus(tenantId, principalId,
                render.artifact().artifactId(), render.artifact().version().value()));
    }

    /** Review hook: a render whose storyboard has a later version is superseded by that head. */
    Optional<String> supersededBy(String tenantId, String ownerPrincipalId, MediaArtifact artifact) {
        if (!(artifact.metadata().get("annotations") instanceof Map<?, ?> annotations)
                || !(annotations.get("storyboardId") instanceof String id)
                || !(annotations.get("storyboardVersion") instanceof Number number)
                || !MediaDevCompositeRenderRuntime.SCHEMA.equals(artifact.metadata().get("renderSchema"))) {
            return Optional.empty();
        }
        List<Version> all;
        try {
            all = versions.versions(tenantId, ownerPrincipalId, lineageId(tenantId, ownerPrincipalId, id));
        } catch (RuntimeException unavailable) {
            return Optional.empty();
        }
        if (all.isEmpty() || all.getLast().versionNumber() <= number.intValue()) return Optional.empty();
        return Optional.of("storyboard:" + id + "@v" + all.getLast().versionNumber());
    }

    // ================================================================== views

    Map<String, Object> view(StoryboardVersion version, boolean replayed) {
        Storyboard sb = version.storyboard();
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", MediaDevStoryboardSpec.SCHEMA);
        view.put("scope", "DEV_ONLY");
        view.put("storyboardId", version.storyboardId());
        view.put("versionNumber", version.versionNumber());
        view.put("headVersion", version.headVersion());
        view.put("head", version.head());
        MediaArtifact artifact = version.artifact();
        view.put("artifact", Map.of("artifactId", artifact.artifactId(), "artifactVersionId", artifact.version().value(),
                "contentType", artifact.contentType(), "sizeBytes", artifact.sizeBytes(), "sha256", artifact.sha256(),
                "artifactPath", "/api/v1/artifacts/" + artifact.artifactId()));
        view.putAll(sb.authored());
        Map<String, Object> timeline = new LinkedHashMap<>();
        timeline.put("totalMs", sb.totalMs());
        timeline.put("totalFrames", sb.totalMs() * sb.fps() / 1000);
        timeline.put("framesPerSecond", sb.fps());
        timeline.put("scenes", sb.timeline());
        view.put("timeline", timeline);
        view.put("replayed", replayed);
        return view;
    }

    Map<String, Object> renderView(Rendered rendered) {
        return renderView(rendered.version().storyboardId(), rendered.version().versionNumber(), rendered.artifact(),
                rendered.lineage(), rendered.replayed());
    }

    Map<String, Object> renderView(String id, int number, MediaArtifact artifact, Map<String, Object> lineage, boolean replayed) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", RENDER_SCHEMA);
        view.put("scope", "DEV_ONLY");
        view.put("storyboardId", id);
        view.put("storyboardVersion", number);
        view.put("renderId", artifact.artifactId());
        view.put("artifact", Map.of("artifactId", artifact.artifactId(), "artifactVersionId", artifact.version().value(),
                "contentType", artifact.contentType(), "sizeBytes", artifact.sizeBytes(), "sha256", artifact.sha256(),
                "artifactPath", "/api/v1/artifacts/" + artifact.artifactId()));
        view.put("lineage", lineage);
        view.put("replayed", replayed);
        return view;
    }

    private static String canonical(Object value) {
        return MediaDevDubSupport.JSON.writeValueAsString(value);
    }

    @Override public void close() {
        versions.close();
    }
}
