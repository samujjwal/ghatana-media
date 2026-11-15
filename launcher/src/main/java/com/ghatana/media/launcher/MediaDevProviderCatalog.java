package com.ghatana.media.launcher;

import com.ghatana.audio.video.vision.local.LocalModelAdmission;
import com.ghatana.audio.video.vision.local.LocalVisionEngine;
import com.ghatana.audio.video.vision.local.LocalVisionSidecarClient;
import com.ghatana.audiovideo.observability.MediaWorkflowMetrics.LocalProvider;
import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.localmodel.FileDigestCache;
import com.ghatana.media.runtime.localmodel.LocalModelInstall;
import com.ghatana.media.runtime.localmodel.LocalModelManifest;
import com.ghatana.stt.provider.LocalWhisperCppSttProvider;
import com.ghatana.tts.local.LocalKokoroSynthesizer;
import com.ghatana.tts.local.LocalKokoroTtsProvider;
import com.ghatana.tts.local.LocalKokoroWorker;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeSet;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;
import java.util.concurrent.locks.ReentrantLock;
import java.util.function.Consumer;
import java.util.regex.Pattern;

/**
 * DEV_ONLY catalog of the local providers (Whisper STT, Kokoro TTS, Florence-2, Qwen2.5-VL and the FFmpeg
 * render/encode toolchain) with their real readiness. The state is observed, never configured:
 *
 * <ul>
 *   <li>{@code READY}: the manifest digests verified, the binary or worker or sidecar answered a bounded probe
 *       (whisper-cli {@code -h}, the Kokoro worker {@code /v1/health}, the vision sidecar {@code /v1/health},
 *       {@code ffmpeg -version}) in time;</li>
 *   <li>{@code NOT_ADMITTED}: a manifest, identity, licence or digest check failed; the reason is a stable code;</li>
 *   <li>{@code WITHDRAWN}: it was admitted or verified and a file changed after that (a swapped weight or binary);</li>
 *   <li>{@code UNAVAILABLE}: the process, port, binary or worker is absent or refuses;</li>
 *   <li>{@code DEGRADED}: the provider answers but not within its probe budget, or only part of it can be probed.</li>
 * </ul>
 *
 * <p>Probing is bounded: the observation is cached for a short TTL, one refresh runs at a time (callers during a
 * refresh wait for it and share its result), probes run on a pool capped at {@code maxConcurrentProbes} and each probe
 * has a hard deadline after which that provider is reported UNAVAILABLE with {@code PROBE_TIMEOUT}.
 * {@code productionEligible} is always false: this catalog never asserts production eligibility. The view contains no
 * filesystem path, endpoint or token; production-like profiles additionally omit device names and runtime versions.</p>
 */
final class MediaDevProviderCatalog {
    static final String SCHEMA = "media.dev.provider-catalog.v1";
    static final String TTL_ENV = "MEDIA_DEV_PROVIDER_CATALOG_TTL_SECONDS";
    static final String CONCURRENCY_ENV = "MEDIA_DEV_PROVIDER_CATALOG_MAX_CONCURRENT_PROBES";
    static final Duration DEFAULT_TTL = Duration.ofSeconds(5);
    static final int DEFAULT_CONCURRENCY = 3;
    static final Duration PROBE_DEADLINE = Duration.ofSeconds(12);
    static final Duration SLOW_PROBE = Duration.ofMillis(2_000);
    private static final Duration SIDECAR_PROBE_BUDGET = Duration.ofSeconds(4);
    private static final Duration TOOL_PROBE_BUDGET = Duration.ofSeconds(5);
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final Pattern FFMPEG_VERSION = Pattern.compile("^(ffmpeg|ffprobe) version (\\S+)");

    enum State { READY, DEGRADED, UNAVAILABLE, NOT_ADMITTED, WITHDRAWN }

    /** What one probe observed; every field is observed, none is copied from configuration alone. */
    record Observation(State state, String reason, String detail, String modelId, String revision, String licenseSpdx,
                       Boolean noticeRequired, String notice, Map<String, String> digests, Set<String> languages,
                       Set<String> voices, Map<String, Object> device, Map<String, Object> extras) {
        Observation {
            Objects.requireNonNull(state, "state");
            reason = reason == null ? "" : reason;
            detail = detail == null ? "" : detail;
            digests = digests == null ? Map.of() : Map.copyOf(digests);
            languages = languages == null ? Set.of() : Set.copyOf(languages);
            voices = voices == null ? Set.of() : Set.copyOf(voices);
            device = device == null ? unreportedDevice("") : Map.copyOf(device);
            extras = extras == null ? Map.of() : Map.copyOf(extras);
        }

        static Observation of(State state, String reason) {
            return new Observation(state, reason, "", null, null, null, null, null, null, null, null, null, null);
        }

        /** Mutable collector used by a probe while it verifies; {@link #build} freezes it with the final verdict. */
        static final class Builder {
            String modelId;
            String revision;
            String licenseSpdx;
            Boolean noticeRequired;
            String notice;
            final Map<String, String> digests = new LinkedHashMap<>();
            Set<String> languages = Set.of();
            Set<String> voices = Set.of();
            Map<String, Object> device;
            final Map<String, Object> extras = new LinkedHashMap<>();

            Observation build(State state, String reason, String detail) {
                return new Observation(state, reason, detail, modelId, revision, licenseSpdx, noticeRequired, notice,
                        digests, languages, voices, device, extras);
            }
        }
    }

    /** One provider and how to verify it right now. {@link #observe()} must not throw for an ordinary failure. */
    interface Probe {
        LocalProvider provider();

        /** Stable kind label, for example {@code SPEECH_TO_TEXT}. */
        String kind();

        Observation observe();
    }

    /** One provider's cached result. */
    record Entry(LocalProvider provider, String kind, Observation observation, Instant checkedAt, long probeMillis) { }

    private record Snapshot(Instant checkedAt, long takenNanos, List<Entry> entries) { }

    private final List<Probe> probes;
    private final Duration ttl;
    private final Clock clock;
    private final boolean detailed;
    private final Consumer<Entry> onObservation;
    private final ExecutorService pool;
    private final ReentrantLock refreshLock = new ReentrantLock();
    private final Duration probeDeadline;
    private volatile Snapshot snapshot;
    private final java.util.concurrent.atomic.AtomicLong refreshCount = new java.util.concurrent.atomic.AtomicLong();

    MediaDevProviderCatalog(List<Probe> probes, Duration ttl, int maxConcurrentProbes, boolean productionLike,
                            Clock clock, Duration probeDeadline, Consumer<Entry> onObservation) {
        this.probes = List.copyOf(Objects.requireNonNull(probes, "probes"));
        this.ttl = Objects.requireNonNull(ttl, "ttl");
        if (ttl.isNegative()) throw new IllegalArgumentException("ttl must not be negative");
        if (maxConcurrentProbes < 1 || maxConcurrentProbes > 8) {
            throw new IllegalArgumentException("maxConcurrentProbes must be within [1, 8]");
        }
        this.clock = Objects.requireNonNull(clock, "clock");
        this.detailed = !productionLike;
        this.probeDeadline = Objects.requireNonNull(probeDeadline, "probeDeadline");
        this.onObservation = onObservation == null ? entry -> { } : onObservation;
        this.pool = Executors.newFixedThreadPool(maxConcurrentProbes, runnable -> {
            Thread thread = new Thread(runnable, "media-dev-provider-probe");
            thread.setDaemon(true);
            return thread;
        });
    }

    /** Number of completed refreshes; a test and operations aid for the bounded-probing contract. */
    long refreshCount() { return refreshCount.get(); }

    /**
     * The catalog view. A cached observation younger than the TTL is returned as is; otherwise exactly one caller
     * refreshes and the others wait for that refresh and reuse it. If the refresh does not finish in time the stale
     * view is returned with {@code stale=true}; with no previous view the call is refused as busy.
     */
    Map<String, Object> view() {
        Snapshot current = snapshot;
        if (current == null || expired(current)) {
            current = refresh(current);
        }
        return render(current);
    }

    private boolean expired(Snapshot value) {
        return System.nanoTime() - value.takenNanos() >= ttl.toNanos();
    }

    private Snapshot refresh(Snapshot previous) {
        boolean locked;
        try {
            locked = refreshLock.tryLock(probeDeadline.toMillis() * 2 + 1_000, TimeUnit.MILLISECONDS);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            locked = false;
        }
        if (!locked) {
            if (previous != null) return previous;
            throw new CatalogBusyException();
        }
        try {
            Snapshot again = snapshot;
            if (again != null && !expired(again)) return again; // another caller refreshed while this one waited
            Instant checkedAt = clock.instant();
            List<Future<Entry>> futures = new ArrayList<>();
            for (Probe probe : probes) futures.add(pool.submit(() -> probeOne(probe, checkedAt)));
            List<Entry> entries = new ArrayList<>();
            for (int i = 0; i < probes.size(); i++) {
                Probe probe = probes.get(i);
                Entry entry;
                try {
                    entry = futures.get(i).get(probeDeadline.toMillis(), TimeUnit.MILLISECONDS);
                } catch (TimeoutException late) {
                    futures.get(i).cancel(true);
                    entry = new Entry(probe.provider(), probe.kind(),
                            Observation.of(State.UNAVAILABLE, "PROBE_TIMEOUT"), checkedAt, probeDeadline.toMillis());
                } catch (ExecutionException | RuntimeException failed) {
                    entry = new Entry(probe.provider(), probe.kind(),
                            Observation.of(State.UNAVAILABLE, "PROBE_FAILED"), checkedAt, 0);
                } catch (InterruptedException interrupted) {
                    Thread.currentThread().interrupt();
                    entry = new Entry(probe.provider(), probe.kind(),
                            Observation.of(State.UNAVAILABLE, "PROBE_INTERRUPTED"), checkedAt, 0);
                }
                entries.add(entry);
            }
            Snapshot fresh = new Snapshot(checkedAt, System.nanoTime(), List.copyOf(entries));
            snapshot = fresh;
            refreshCount.incrementAndGet();
            for (Entry entry : entries) {
                try { onObservation.accept(entry); } catch (RuntimeException observationFailure) { /* observational */ }
            }
            return fresh;
        } finally {
            refreshLock.unlock();
        }
    }

    private Entry probeOne(Probe probe, Instant checkedAt) {
        long started = System.nanoTime();
        Observation observation;
        try {
            observation = probe.observe();
        } catch (RuntimeException failure) {
            observation = Observation.of(State.UNAVAILABLE, "PROBE_FAILED");
        }
        return new Entry(probe.provider(), probe.kind(), observation, checkedAt,
                (System.nanoTime() - started) / 1_000_000);
    }

    /** Typed refusal when no observation exists and a refresh could not start in time. */
    static final class CatalogBusyException extends RuntimeException {
        CatalogBusyException() { super("the provider catalog is being refreshed; retry shortly", null, false, false); }
    }

    private Map<String, Object> render(Snapshot value) {
        Map<String, Object> view = new LinkedHashMap<>();
        view.put("schema", SCHEMA);
        view.put("scope", "DEV_ONLY");
        view.put("checkedAt", value.checkedAt().toString());
        view.put("cacheTtlSeconds", ttl.toSeconds());
        view.put("productionEligible", false);
        view.put("fallbackPolicy", MediaDevOutage.FALLBACK_POLICY);
        view.put("note", "Observed readiness of local development providers; not a quality, rights, approval or "
                + "production-eligibility claim. Readiness comes from manifest digest checks and live probes.");
        List<Map<String, Object>> providers = new ArrayList<>();
        for (Entry entry : value.entries()) providers.add(renderEntry(entry));
        view.put("providers", providers);
        return view;
    }

    private Map<String, Object> renderEntry(Entry entry) {
        Observation o = entry.observation();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("providerId", entry.provider().label());
        out.put("kind", entry.kind());
        out.put("state", o.state().name());
        out.put("reason", o.reason());
        if (!o.detail().isBlank()) out.put("detail", o.detail());
        if (o.modelId() != null) out.put("modelId", o.modelId());
        if (o.revision() != null) out.put("revision", o.revision());
        Map<String, Object> license = new LinkedHashMap<>();
        license.put("spdx", o.licenseSpdx());
        license.put("noticeRequired", o.noticeRequired());
        license.put("notice", o.notice());
        out.put("license", license);
        out.put("digests", new java.util.TreeMap<>(o.digests()));
        out.put("verifiedLanguages", new TreeSet<>(o.languages()));
        out.put("voices", new TreeSet<>(o.voices()));
        Map<String, Object> device = new LinkedHashMap<>(o.device());
        if (!detailed) {
            device.remove("name");
            device.remove("runtimeVersion");
            device.remove("note");
        }
        out.put("device", device);
        if (detailed) {
            Map<String, Object> extras = new LinkedHashMap<>(o.extras());
            if (!extras.isEmpty()) out.put("runtime", extras);
        }
        out.put("productionEligible", false);
        out.put("fallback", "NONE");
        out.put("lastCheckedAt", entry.checkedAt().toString());
        out.put("probeMillis", entry.probeMillis());
        return out;
    }

    static Map<String, Object> unreportedDevice(String note) {
        Map<String, Object> device = new LinkedHashMap<>();
        device.put("kind", "UNREPORTED");
        device.put("reported", false);
        device.put("name", "");
        device.put("note", note);
        return device;
    }

    static Map<String, Object> device(String kind, String name, String runtimeVersion) {
        Map<String, Object> device = new LinkedHashMap<>();
        device.put("kind", kind);
        device.put("reported", true);
        device.put("name", name == null ? "" : name);
        device.put("runtimeVersion", runtimeVersion == null ? "" : runtimeVersion);
        return device;
    }

    void close() { pool.shutdownNow(); }

    // ------------------------------------------------------------------------------------------- composition

    /** Server-owned composition from the DEV lanes' real provider objects and environment. */
    static MediaDevProviderCatalog compose(MediaRuntime runtime, Map<String, String> environment,
                                           LocalWhisperCppSttProvider stt, LocalKokoroTtsProvider tts,
                                           LocalVisionEngine vision) {
        Duration ttl = seconds(environment, TTL_ENV, DEFAULT_TTL, 0, 300);
        int concurrency = (int) seconds(environment, CONCURRENCY_ENV, Duration.ofSeconds(DEFAULT_CONCURRENCY), 1, 8)
                .toSeconds();
        List<Probe> probes = List.of(
                new WhisperProbe(stt, environment),
                new KokoroProbe(tts),
                new VisionProbe(LocalProvider.FLORENCE, "VISION", vision, false),
                new VisionProbe(LocalProvider.QWEN, "MULTIMODAL_QA", vision, true),
                new FfmpegProbe(environment));
        var metrics = runtime.workflowMetrics();
        return new MediaDevProviderCatalog(probes, ttl, concurrency, runtime.config().productionLike(),
                Clock.systemUTC(), PROBE_DEADLINE, entry -> metrics.recordLocalProviderState(entry.provider(),
                        com.ghatana.audiovideo.observability.MediaWorkflowMetrics.LocalProviderState
                                .valueOf(entry.observation().state().name()), entry.checkedAt()));
    }

    private static Duration seconds(Map<String, String> environment, String name, Duration fallback, long min, long max) {
        String raw = environment.get(name);
        if (raw == null || raw.isBlank()) return fallback;
        try {
            long value = Long.parseLong(raw.trim());
            if (value < min || value > max) throw new NumberFormatException();
            return Duration.ofSeconds(value);
        } catch (NumberFormatException invalid) {
            throw new IllegalArgumentException(name + " must be an integer within [" + min + ", " + max + "]");
        }
    }

    // ------------------------------------------------------------------------------------- shared install map

    /** Maps a model installation that is not usable (or was withdrawn) to its catalog observation, else null. */
    private static Observation installProblem(LocalModelInstall install) {
        if (install == null) return Observation.of(State.UNAVAILABLE, "NOT_CONFIGURED");
        return switch (install.state()) {
            case NOT_INSTALLED -> Observation.of(State.NOT_ADMITTED, "MODEL_NOT_INSTALLED");
            case MANIFEST_INVALID -> Observation.of(State.NOT_ADMITTED, "MODEL_MANIFEST_INVALID");
            case WRONG_MODEL -> Observation.of(State.NOT_ADMITTED, "MODEL_IDENTITY_MISMATCH");
            case REJECTED -> Observation.of(State.NOT_ADMITTED,
                    "MODEL_" + (install.verificationStatus() == null ? "REJECTED" : install.verificationStatus().name()));
            case VERIFIED -> install.stillCurrent() ? null : withdrawnInstall(install);
        };
    }

    /** A file changed after verification; re-hash to say why (cheap when the digest cache already knows). */
    private static Observation withdrawnInstall(LocalModelInstall install) {
        String cause = "UNKNOWN";
        try {
            LocalModelInstall again = LocalModelInstall.inspect(install.modelDir(), install.manifest().modelKey(),
                    install.manifest().modality());
            cause = again.usable() ? "FILES_TOUCHED_DIGESTS_MATCH"
                    : again.verificationStatus() != null ? again.verificationStatus().name() : again.state().name();
        } catch (RuntimeException ignored) { /* the withdrawal itself is already established */ }
        return new Observation(State.WITHDRAWN, "MODEL_FILES_CHANGED", cause, null, null, null, null, null, null, null,
                null, null, null);
    }

    private static Observation.Builder identityOf(LocalModelInstall install) {
        LocalModelManifest manifest = install.manifest();
        Observation.Builder builder = new Observation.Builder();
        builder.modelId = manifest.modelId();
        builder.revision = manifest.source().revision();
        builder.licenseSpdx = manifest.license().spdx();
        builder.noticeRequired = manifest.attribution().noticeRequired();
        builder.notice = manifest.attribution().notice();
        builder.digests.put("manifestSha256", install.manifestSha256());
        LocalModelManifest.FileEntry weights = manifest.first(LocalModelManifest.FileRole.WEIGHTS);
        if (weights != null) builder.digests.put("weightsSha256", weights.sha256());
        builder.languages = manifest.verifiedLanguages();
        return builder;
    }

    // ------------------------------------------------------------------------------------------------ probes

    /** Whisper.cpp: manifest digests, the pinned executable digest and a real {@code whisper-cli -h} run. */
    static final class WhisperProbe implements Probe {
        private final LocalWhisperCppSttProvider stt;
        private final Map<String, String> environment;
        private volatile boolean everReady;

        WhisperProbe(LocalWhisperCppSttProvider stt, Map<String, String> environment) {
            this.stt = stt;
            this.environment = environment;
        }

        @Override public LocalProvider provider() { return LocalProvider.WHISPER; }
        @Override public String kind() { return "SPEECH_TO_TEXT"; }

        @Override
        public Observation observe() {
            if (stt == null) return Observation.of(State.UNAVAILABLE, "NOT_CONFIGURED");
            Observation problem = installProblem(stt.install());
            if (problem != null) return problem;
            Observation.Builder identity = identityOf(stt.install());
            String bin = environment.get(LocalWhisperCppSttProvider.ENV_WHISPER_BIN);
            if (bin == null || bin.isBlank() || !Path.of(bin).isAbsolute()) {
                return identity.build(State.UNAVAILABLE, "RUNTIME_NOT_CONFIGURED", "");
            }
            Path executable = Path.of(bin);
            if (!Files.isRegularFile(executable, LinkOption.NOFOLLOW_LINKS) || !Files.isExecutable(executable)) {
                return identity.build(State.UNAVAILABLE, "BINARY_MISSING", "");
            }
            LocalModelManifest.RuntimeBinding pin = stt.install().manifest().runtime();
            try {
                String actual = FileDigestCache.shared().sha256(executable);
                identity.digests.put("executableSha256", actual);
                if (pin == null || pin.executableSha256().isEmpty() || !pin.executableSha256().equals(actual)) {
                    return identity.build(everReady ? State.WITHDRAWN : State.NOT_ADMITTED,
                            everReady ? "BINARY_CHANGED" : "BINARY_DIGEST_MISMATCH", "");
                }
            } catch (IOException unreadable) {
                return identity.build(State.UNAVAILABLE, "BINARY_UNREADABLE", "");
            }
            if (pin.version() != null) identity.extras.put("runtimeVersion", pin.version());
            identity.device = unreportedDevice("whisper-cli reports its compute device only while it runs inference");
            long started = System.nanoTime();
            try {
                BoundedProcessRunner.Result run = BoundedProcessRunner.run(List.of(executable.toString(), "-h"),
                        executable.getParent(), Map.of(), TOOL_PROBE_BUDGET, 64 * 1024, 4096,
                        BoundedProcessRunner.CancellationToken.NEVER, null, 0);
                long elapsed = (System.nanoTime() - started) / 1_000_000;
                if (run.end() == BoundedProcessRunner.End.TIMED_OUT) {
                    return identity.build(State.DEGRADED, "BINARY_PROBE_TIMEOUT", "");
                }
                if (!run.succeeded()) return identity.build(State.UNAVAILABLE, "BINARY_NOT_EXECUTABLE", "");
                if (!stt.ready()) return identity.build(State.UNAVAILABLE, "RUNTIME_NOT_READY", "");
                everReady = true;
                return identity.build(elapsed > SLOW_PROBE.toMillis() ? State.DEGRADED : State.READY,
                        elapsed > SLOW_PROBE.toMillis() ? "PROBE_SLOW" : "VERIFIED_AND_PROBED", "");
            } catch (IOException cannotStart) {
                return identity.build(State.UNAVAILABLE, "BINARY_NOT_EXECUTABLE", "");
            }
        }
    }

    /** Kokoro: manifest digests, the pinned worker script and the persistent worker's own authenticated health. */
    static final class KokoroProbe implements Probe {
        private final LocalKokoroTtsProvider tts;

        KokoroProbe(LocalKokoroTtsProvider tts) { this.tts = tts; }

        @Override public LocalProvider provider() { return LocalProvider.KOKORO; }
        @Override public String kind() { return "TEXT_TO_SPEECH"; }

        @Override
        public Observation observe() {
            if (tts == null) return Observation.of(State.UNAVAILABLE, "NOT_CONFIGURED");
            Observation problem = installProblem(tts.install());
            if (problem != null) return problem;
            Observation.Builder identity = identityOf(tts.install());
            identity.extras.put("voiceCloning", String.valueOf(tts.install().manifest().voiceCloning()));
            if (tts.install().manifest().runtime() != null) {
                identity.extras.put("runtimeVersion", tts.install().manifest().runtime().version());
            }
            LocalKokoroSynthesizer synthesizer = tts.synthesizer();
            if (synthesizer == null) return identity.build(State.UNAVAILABLE, "RUNTIME_NOT_READY", "");
            identity.voices = tts.voices();
            LocalKokoroWorker worker = synthesizer.worker();
            if (worker == null) {
                identity.device = unreportedDevice("no persistent worker: each call starts a process that is not probed");
                return identity.build(State.DEGRADED, "NO_PERSISTENT_WORKER_TO_PROBE", "");
            }
            if (!worker.running()) {
                identity.voices = Set.of();
                return identity.build(State.UNAVAILABLE, "WORKER_NOT_RUNNING", "");
            }
            long started = System.nanoTime();
            String health = worker.healthJson();
            long elapsed = (System.nanoTime() - started) / 1_000_000;
            if (health == null) {
                identity.voices = Set.of();
                return identity.build(worker.running() ? State.DEGRADED : State.UNAVAILABLE,
                        worker.running() ? "WORKER_HEALTH_UNREACHABLE" : "WORKER_NOT_RUNNING", "");
            }
            Map<String, Object> body;
            try {
                body = JSON.readValue(health, new TypeReference<Map<String, Object>>() { });
            } catch (RuntimeException malformed) {
                identity.voices = Set.of();
                return identity.build(State.DEGRADED, "WORKER_HEALTH_MALFORMED", "");
            }
            String status = String.valueOf(body.get("status"));
            if (!"UP".equals(status)) {
                identity.voices = Set.of();
                return identity.build(State.WITHDRAWN, "WORKER_REFUSED", String.valueOf(body.getOrDefault("reason", "")));
            }
            String reported = String.valueOf(body.getOrDefault("device", "unknown"));
            String name = String.valueOf(body.getOrDefault("cudaDevice", ""));
            identity.device = device(reported.startsWith("cuda") ? "GPU" : "cpu".equals(reported) ? "CPU" : "UNKNOWN",
                    "null".equals(name) || name.isBlank() ? reported : name,
                    String.valueOf(body.getOrDefault("torch", "")));
            if (body.get("deviceNote") != null) identity.extras.put("deviceNote", String.valueOf(body.get("deviceNote")));
            return identity.build(elapsed > SLOW_PROBE.toMillis() ? State.DEGRADED : State.READY,
                    elapsed > SLOW_PROBE.toMillis() ? "PROBE_SLOW" : "VERIFIED_AND_PROBED", "");
        }
    }

    /** Florence-2 or Qwen2.5-VL: the directory manifest admission plus a bounded sidecar health probe. */
    static final class VisionProbe implements Probe {
        private final LocalProvider provider;
        private final String kind;
        private final LocalVisionEngine engine;
        private final boolean qwen;
        private volatile boolean everQualified;

        VisionProbe(LocalProvider provider, String kind, LocalVisionEngine engine, boolean qwen) {
            this.provider = provider;
            this.kind = kind;
            this.engine = engine;
            this.qwen = qwen;
        }

        @Override public LocalProvider provider() { return provider; }
        @Override public String kind() { return kind; }

        @Override
        public Observation observe() {
            if (engine == null) return Observation.of(State.UNAVAILABLE, "NOT_CONFIGURED");
            LocalModelAdmission.Admission admission = qwen ? engine.qwenAdmission() : engine.florenceAdmission();
            Observation.Builder identity = new Observation.Builder();
            if (admission.manifest() != null) {
                LocalModelManifest manifest = admission.manifest();
                identity.modelId = manifest.modelId();
                identity.revision = manifest.source().revision();
                identity.licenseSpdx = manifest.license().spdx();
                identity.noticeRequired = manifest.attribution().noticeRequired();
                identity.notice = manifest.attribution().notice();
                identity.digests.put("fileSetSha256", manifest.fileSetSha256());
                LocalModelManifest.FileEntry weights = manifest.first(LocalModelManifest.FileRole.WEIGHTS);
                if (weights != null) identity.digests.put("weightsSha256", weights.sha256());
                identity.languages = manifest.verifiedLanguages();
            }
            if (!admission.qualified()) {
                boolean changed = everQualified && (LocalModelAdmission.NOT_ADMITTED_DIGEST.equals(admission.reasonCode())
                        || LocalModelAdmission.NOT_ADMITTED_FILE_MISSING.equals(admission.reasonCode())
                        || LocalModelAdmission.NOT_ADMITTED_MANIFEST_MISSING.equals(admission.reasonCode()));
                return identity.build(changed ? State.WITHDRAWN : State.NOT_ADMITTED,
                        changed ? "MODEL_FILES_CHANGED" : admission.reasonCode(),
                        changed ? admission.reasonCode() : "");
            }
            everQualified = true;
            LocalVisionSidecarClient.Health health = engine.sidecarHealth(SIDECAR_PROBE_BUDGET);
            return switch (health.state()) {
                case UNREACHABLE -> identity.build(State.UNAVAILABLE, "SIDECAR_UNREACHABLE", "");
                case REJECTED -> identity.build(State.UNAVAILABLE, "SIDECAR_REJECTED", "");
                case TIMED_OUT -> identity.build(State.DEGRADED, "SIDECAR_HEALTH_TIMEOUT", "");
                case UP -> {
                    Map<String, Object> body = health.body();
                    Object info = body.get("deviceInfo");
                    if (info instanceof Map<?, ?> map) {
                        identity.device = device(String.valueOf(map.get("kind")),
                                String.valueOf(map.get("name")), String.valueOf(map.get("torch")));
                    } else {
                        identity.device = unreportedDevice("the sidecar did not report a device");
                    }
                    identity.extras.put("modelLoaded", Boolean.TRUE.equals(body.get(qwen ? "qwenLoaded" : "floren2Loaded")));
                    yield identity.build(health.elapsedMillis() > SLOW_PROBE.toMillis() ? State.DEGRADED : State.READY,
                            health.elapsedMillis() > SLOW_PROBE.toMillis() ? "PROBE_SLOW" : "VERIFIED_AND_PROBED", "");
                }
            };
        }
    }

    /** FFmpeg and ffprobe as configured for the render and frame lanes: real {@code -version} and encoder checks. */
    static final class FfmpegProbe implements Probe {
        private final String ffmpeg;
        private final String ffprobe;

        FfmpegProbe(Map<String, String> environment) {
            this.ffmpeg = environment.getOrDefault(MediaDevProjectRenderRuntime.FFMPEG_ENV, "");
            this.ffprobe = environment.getOrDefault(MediaDevProjectRenderRuntime.FFPROBE_ENV, "");
        }

        @Override public LocalProvider provider() { return LocalProvider.FFMPEG; }
        @Override public String kind() { return "RENDER_ENCODE_TOOLCHAIN"; }

        @Override
        public Observation observe() {
            if (ffmpeg.isBlank() || ffprobe.isBlank() || !Path.of(ffmpeg).isAbsolute() || !Path.of(ffprobe).isAbsolute()) {
                return Observation.of(State.UNAVAILABLE, "NOT_CONFIGURED");
            }
            Path ffmpegPath = Path.of(ffmpeg);
            Path ffprobePath = Path.of(ffprobe);
            if (!executable(ffmpegPath)) return Observation.of(State.UNAVAILABLE, "FFMPEG_BINARY_MISSING");
            if (!executable(ffprobePath)) return Observation.of(State.UNAVAILABLE, "FFPROBE_BINARY_MISSING");
            Observation.Builder identity = new Observation.Builder();
            long started = System.nanoTime();
            String ffmpegText;
            String ffprobeText;
            String encoders;
            try {
                ffmpegText = capture(ffmpegPath, "-version");
                ffprobeText = capture(ffprobePath, "-version");
                encoders = capture(ffmpegPath, "-hide_banner", "-encoders");
            } catch (IOException | RuntimeException failed) {
                return Observation.of(State.UNAVAILABLE, "TOOL_PROBE_FAILED");
            }
            long elapsed = (System.nanoTime() - started) / 1_000_000;
            var ffmpegVersion = FFMPEG_VERSION.matcher(ffmpegText.lines().findFirst().orElse(""));
            var ffprobeVersion = FFMPEG_VERSION.matcher(ffprobeText.lines().findFirst().orElse(""));
            if (!ffmpegVersion.find() || !ffprobeVersion.find()) {
                return Observation.of(State.UNAVAILABLE, "TOOL_OUTPUT_UNRECOGNIZED");
            }
            identity.modelId = "ffmpeg-toolchain";
            identity.revision = ffmpegVersion.group(2);
            String configuration = ffmpegText.lines().filter(line -> line.startsWith("configuration:")).findFirst().orElse("");
            identity.licenseSpdx = spdxFromConfiguration(configuration);
            identity.noticeRequired = true;
            identity.notice = "FFmpeg is used as a separate external process and its SPDX identifier is derived from the "
                    + "binary's own configuration line. A GPL-configured build must not be redistributed with this "
                    + "product without GPL compliance.";
            try {
                identity.digests.put("ffmpegSha256", FileDigestCache.shared().sha256(ffmpegPath));
                identity.digests.put("ffprobeSha256", FileDigestCache.shared().sha256(ffprobePath));
            } catch (IOException unreadable) {
                return identity.build(State.UNAVAILABLE, "BINARY_UNREADABLE", "");
            }
            identity.extras.put("ffmpegVersion", ffmpegVersion.group(2));
            identity.extras.put("ffprobeVersion", ffprobeVersion.group(2));
            for (String encoder : List.of("libx264", "aac", "mov_text")) {
                if (!Pattern.compile("(?m)^\\s*[VAS][.A-Z]{5}\\s+" + encoder + "\\s").matcher(encoders).find()) {
                    return identity.build(State.UNAVAILABLE, "ENCODER_UNAVAILABLE", encoder);
                }
            }
            identity.device = device("CPU", "software encoders libx264/aac", ffmpegVersion.group(2));
            return identity.build(elapsed > SLOW_PROBE.toMillis() ? State.DEGRADED : State.READY,
                    elapsed > SLOW_PROBE.toMillis() ? "PROBE_SLOW" : "VERIFIED_AND_PROBED", "");
        }

        private static boolean executable(Path path) {
            return Files.isRegularFile(path, LinkOption.NOFOLLOW_LINKS) && Files.isExecutable(path);
        }

        private static String capture(Path tool, String... args) throws IOException {
            List<String> command = new ArrayList<>();
            command.add(tool.toString());
            Collections.addAll(command, args);
            BoundedProcessRunner.Result run = BoundedProcessRunner.run(command, tool.getParent(), Map.of(),
                    TOOL_PROBE_BUDGET, 1024 * 1024, 4096, BoundedProcessRunner.CancellationToken.NEVER, null, 0);
            if (!run.succeeded()) throw new IOException("tool probe failed");
            return new String(run.stdout(), StandardCharsets.UTF_8);
        }

        static String spdxFromConfiguration(String configuration) {
            if (configuration.contains("--enable-nonfree")) return "LicenseRef-FFmpeg-nonfree";
            boolean v3 = configuration.contains("--enable-version3");
            if (configuration.contains("--enable-gpl")) return v3 ? "GPL-3.0-or-later" : "GPL-2.0-or-later";
            return v3 ? "LGPL-3.0-or-later" : "LGPL-2.1-or-later";
        }
    }
}
