package com.ghatana.media.launcher;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.media.runtime.MediaRuntimeContracts.ArtifactContentReadReceipt;
import com.ghatana.media.runtime.MediaRuntimeContracts.AttemptFinality;
import com.ghatana.media.runtime.MediaRuntimeContracts.CancellationOutcome;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptIdentity;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptObservation;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderAttemptQuery;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderDataRetention;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProviderSubmission;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.OutputStream;
import java.nio.charset.StandardCharsets;
import java.nio.file.AtomicMoveNotSupportedException;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.function.BiPredicate;
import java.util.regex.Pattern;
import java.util.stream.Stream;

/**
 * DEV_ONLY real, CPU-only {@code TRANSCODE} provider ({@code local-ffmpeg-transcode}): it decodes the exact source
 * artifact bytes with the operator-configured absolute FFmpeg binary and re-encodes them to a FLAC or WAV file with a
 * bounded sample rate and channel count. It exists so the canonical job lifecycle (ACCEPTED, RUNNING, terminal,
 * restart reconciliation, cancellation) can be exercised against a genuine effect instead of the deterministic
 * diagnostic provider.
 *
 * <p>The effect is made verifiable and restart-reconcilable by a small spool protocol under
 * {@code <spool>/<sha256(operationId)>/}:</p>
 * <ol>
 *   <li>{@code begin.json}: written before any source byte is read; names the launcher process that owns the run.
 *       Its absence proves the effect never started.</li>
 *   <li>{@code out.part}: FFmpeg output; never visible as a result.</li>
 *   <li>{@code out.bin} then {@code receipt.json}: an atomic rename, then the receipt (itself written atomically).
 *       The receipt is the single commit point; it carries the output SHA-256 which a reader recomputes.</li>
 * </ol>
 * <p>{@link #reconcileAttempt} is read-only apart from discarding an uncommitted partial output whose owner process
 * is provably gone: a verified receipt is {@code SUCCEEDED}; a dead owner with no receipt (or no begin marker) is
 * {@code NO_EFFECT_PROVEN}; a live or unprovable owner is {@code UNKNOWN}. It never re-runs the transcode.</p>
 */
final class MediaDevFfmpegTranscodeProvider implements MediaProcessingProvider {
    static final String PROVIDER_ID = "local-ffmpeg-transcode";
    static final String SPOOL_ENV = "MEDIA_DEV_FFMPEG_JOB_SPOOL";
    /** Days a terminal attempt directory is kept before pruning; positive integer, default 7. */
    static final String RETENTION_ENV = "MEDIA_DEV_FFMPEG_JOB_SPOOL_RETENTION_DAYS";
    static final int DEFAULT_RETENTION_DAYS = 7;
    static final int MAXIMUM_RETENTION_DAYS = 3650;
    private static final Pattern ATTEMPT_DIRECTORY = Pattern.compile("[0-9a-f]{40}");
    /** Test-only fault gate directory: a {@code hold-<phase>-<first 16 hex of the source SHA-256>} file pauses that run at that phase. */
    static final String GATE_ENV = "MEDIA_DEV_FFMPEG_JOB_FAULT_GATE_DIR";
    static final String PHASE_BEFORE_EFFECT = "before-effect";
    static final String PHASE_AFTER_FFMPEG = "after-ffmpeg";
    static final String PHASE_AFTER_COMMIT = "after-commit";
    private static final long MAX_SOURCE_BYTES = 256L * 1024 * 1024;
    private static final long MAX_OUTPUT_BYTES = 512L * 1024 * 1024;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final Logger log = LoggerFactory.getLogger(MediaDevFfmpegTranscodeProvider.class);
    private static final ExecutorService EXECUTOR = Executors.newFixedThreadPool(8, task -> {
        Thread thread = new Thread(task, "media-dev-ffmpeg-transcode");
        thread.setDaemon(true);
        return thread;
    });

    private final Path ffmpeg;
    private final Path ffprobe;
    private final Path spool;
    private final Path gateDir;
    private final Duration retention;
    private final String owner = MediaDevRequestLedger.localOwner();
    private final ConcurrentHashMap<String, Active> active = new ConcurrentHashMap<>();

    /** One run of one job inside this process. {@code lock} orders the commit against a cancellation. */
    private static final class Active {
        final Object lock = new Object();
        final BoundedProcessRunner.CancellationSource cancelled = new BoundedProcessRunner.CancellationSource();
        volatile boolean committed;
    }

    MediaDevFfmpegTranscodeProvider(Path ffmpeg, Path ffprobe, Path spool, Path gateDir) {
        this(ffmpeg, ffprobe, spool, gateDir, Duration.ofDays(DEFAULT_RETENTION_DAYS));
    }

    MediaDevFfmpegTranscodeProvider(Path ffmpeg, Path ffprobe, Path spool, Path gateDir, Duration retention) {
        if (!ffmpeg.isAbsolute() || !ffprobe.isAbsolute() || !spool.isAbsolute()
                || (gateDir != null && !gateDir.isAbsolute())) {
            throw new IllegalArgumentException("ffmpeg, ffprobe, spool and gate paths must be absolute");
        }
        if (retention.isNegative() || retention.isZero()) {
            throw new IllegalArgumentException("spool retention must be positive");
        }
        this.ffmpeg = ffmpeg;
        this.ffprobe = ffprobe;
        this.spool = spool;
        this.gateDir = gateDir;
        this.retention = retention;
        try {
            Files.createDirectories(spool);
        } catch (IOException failure) {
            throw new IllegalStateException("DEV ffmpeg job spool is not creatable", failure);
        }
    }

    /** Empty unless the DEV spool and absolute FFmpeg/FFprobe paths are all configured. */
    static Optional<MediaDevFfmpegTranscodeProvider> from(Map<String, String> environment) {
        String spool = environment.getOrDefault(SPOOL_ENV, "");
        String ffmpeg = environment.getOrDefault(MediaDevProjectRenderRuntime.FFMPEG_ENV, "");
        String ffprobe = environment.getOrDefault(MediaDevProjectRenderRuntime.FFPROBE_ENV, "");
        if (spool.isBlank() || ffmpeg.isBlank() || ffprobe.isBlank()) return Optional.empty();
        String gate = environment.getOrDefault(GATE_ENV, "");
        return Optional.of(new MediaDevFfmpegTranscodeProvider(Path.of(ffmpeg), Path.of(ffprobe), Path.of(spool),
                gate.isBlank() ? null : Path.of(gate), retention(environment)));
    }

    /** Parses {@link #RETENTION_ENV}; an absent value is the default, a malformed or out-of-range value fails startup. */
    static Duration retention(Map<String, String> environment) {
        String raw = environment.getOrDefault(RETENTION_ENV, "").strip();
        if (raw.isEmpty()) return Duration.ofDays(DEFAULT_RETENTION_DAYS);
        int days;
        try {
            days = Integer.parseInt(raw);
        } catch (NumberFormatException malformed) {
            throw new IllegalArgumentException(RETENTION_ENV + " must be an integer number of days", malformed);
        }
        if (days < 1 || days > MAXIMUM_RETENTION_DAYS) {
            throw new IllegalArgumentException(RETENTION_ENV + " must be within [1, " + MAXIMUM_RETENTION_DAYS + "] days");
        }
        return Duration.ofDays(days);
    }

    @Override public String providerId() { return PROVIDER_ID; }
    @Override public String providerVersion() { return "local-ffmpeg-transcode-v1"; }
    @Override public String modelVersion(JobType modality) { return "ffmpeg-flac-wav-v1"; }
    @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
    @Override public boolean ready() {
        return Files.isExecutable(ffmpeg) && Files.isExecutable(ffprobe) && Files.isDirectory(spool);
    }
    @Override public boolean productionEligible() { return false; }
    /** Ties break after the diagnostic provider, so a hint-less TRANSCODE never selects a real ffmpeg run. */
    @Override public int priority() { return Integer.MAX_VALUE; }
    @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
    @Override public String processingRegion() { return "local"; }
    @Override public ProviderDataRetention providerDataRetention() { return ProviderDataRetention.TRANSIENT; }
    @Override public boolean reconcilesExpiredAttempts() { return true; }

    /** Validated transcode parameters; anything else is refused before any attempt is dispatched. */
    record Params(String container, int sampleRateHz, int channels) {
        String contentType() { return "flac".equals(container) ? "audio/flac" : "audio/wav"; }
    }

    static Params params(Map<String, Object> parameters) {
        Set<String> allowed = Set.of("container", "sampleRateHz", "channels");
        for (String key : parameters.keySet()) {
            if (!allowed.contains(key)) throw new IllegalArgumentException("unsupported transcode parameter: " + key);
        }
        String container = parameters.get("container") == null ? "flac" : String.valueOf(parameters.get("container"));
        if (!container.equals("flac") && !container.equals("wav")) {
            throw new IllegalArgumentException("container must be flac or wav");
        }
        return new Params(container, intParam(parameters, "sampleRateHz", 16_000, 8_000, 48_000),
                intParam(parameters, "channels", 1, 1, 2));
    }

    private static int intParam(Map<String, Object> parameters, String name, int fallback, int min, int max) {
        Object raw = parameters.get(name);
        if (raw == null) return fallback;
        if (!(raw instanceof Number number) || number.doubleValue() != Math.rint(number.doubleValue())) {
            throw new IllegalArgumentException(name + " must be an integer");
        }
        long value = number.longValue();
        if (value < min || value > max) throw new IllegalArgumentException(name + " must be within [" + min + ", " + max + "]");
        return (int) value;
    }

    @Override
    public void validateSubmission(ProcessingJobRequest request) {
        params(request.parameters());
    }

    @Override
    public Optional<ProviderAttemptIdentity> prepareAttemptIdentity(
            ProcessingJobRequest request, MediaArtifact artifact, ProviderAttemptContext attempt) {
        params(request.parameters());
        String operationId = PROVIDER_ID + ":" + attempt.jobId() + ":" + attempt.attemptNumber();
        return Optional.of(new ProviderAttemptIdentity(operationId,
                sha256(operationId + ":" + attempt.requestFingerprint())));
    }

    @Override
    public CompletableFuture<java.util.Map<String, Object>> process(ProcessingContext context) {
        return CompletableFuture.failedFuture(new IllegalStateException(
                "the DEV ffmpeg transcode provider only runs as a typed fenced attempt"));
    }

    @Override
    public CompletableFuture<ProviderSubmission> processAttempt(ProcessingContext context, ProviderAttemptContext attempt) {
        String key = key(attempt.tenantId(), attempt.jobId());
        Active run = new Active();
        if (active.putIfAbsent(key, run) != null) {
            return CompletableFuture.failedFuture(new IllegalStateException("this job is already running here"));
        }
        context.cancellation().onCancel(run.cancelled::cancel);
        CompletableFuture<ProviderSubmission> future = new CompletableFuture<>();
        EXECUTOR.execute(() -> {
            try {
                future.complete(run(context, attempt, run));
            } catch (Throwable failure) {
                future.completeExceptionally(failure);
            } finally {
                active.remove(key, run);
            }
        });
        future.whenComplete((ignored, failure) -> { if (future.isCancelled()) run.cancelled.cancel(); });
        return future;
    }

    private ProviderSubmission run(ProcessingContext context, ProviderAttemptContext attempt, Active run)
            throws Exception {
        Params params = params(context.request().parameters());
        Path dir = operationDir(attempt.providerOperationId());
        Files.createDirectories(dir, PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rwx------")));
        gate(PHASE_BEFORE_EFFECT, context, run);
        // Effect start marker: after this point a crash may leave an uncommitted partial output behind.
        writeAtomically(dir.resolve("begin.json"), JSON.writeValueAsBytes(Map.of(
                "owner", owner, "tenantId", attempt.tenantId(), "jobId", attempt.jobId(),
                "operationId", attempt.providerOperationId(), "startedAt", Instant.now().toString())));
        Path source = dir.resolve("source.bin");
        Path part = dir.resolve("out.part");
        try {
            ArtifactContentReadReceipt sourceReceipt;
            try (OutputStream out = Files.newOutputStream(source, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING,
                    StandardOpenOption.WRITE)) {
                sourceReceipt = context.sourceContentReader().copyTo(out, MAX_SOURCE_BYTES);
            }
            List<String> command = List.of(ffmpeg.toString(), "-nostdin", "-v", "error", "-y", "-i", source.toString(),
                    "-vn", "-map_metadata", "-1", "-ac", Integer.toString(params.channels()),
                    "-ar", Integer.toString(params.sampleRateHz()), "-fflags", "+bitexact", "-flags:a", "+bitexact",
                    "-f", params.container(), part.toString());
            long remainingMillis = Math.max(1_000L, Duration.ofNanos(
                    Math.max(0, context.monotonicDeadline().remainingNanos())).toMillis());
            BoundedProcessRunner.Result result = BoundedProcessRunner.run(command, dir, Map.of(),
                    Duration.ofMillis(remainingMillis), 1_024, 8_192, run.cancelled, part, MAX_OUTPUT_BYTES);
            if (run.cancelled.isCancelled()) {
                discard(dir);
                throw new java.util.concurrent.CancellationException("transcode cancelled before commit");
            }
            if (!result.succeeded() || !Files.isRegularFile(part) || Files.size(part) == 0) {
                discard(dir);
                // FFmpeg refused the input or failed before producing a committed output: no visible effect.
                String operationId = attempt.providerOperationId();
                return new ProviderSubmission(AttemptFinality.NO_EFFECT_PROVEN, operationId,
                        attempt.providerReceiptId(), Map.of(),
                        sha256("no-effect:" + operationId + ":" + result.end() + ":" + result.exitCode()),
                        Instant.now());
            }
            Map<String, Object> probed = probe(part);
            gate(PHASE_AFTER_FFMPEG, context, run);
            String outputSha = sha256(Files.readAllBytes(part));
            long outputBytes = Files.size(part);
            Map<String, Object> outputResult = new LinkedHashMap<>();
            outputResult.put("operationId", attempt.providerOperationId());
            outputResult.put("sourceSha256", sourceReceipt.sha256());
            outputResult.put("outputSha256", outputSha);
            outputResult.put("outputBytes", outputBytes);
            outputResult.put("outputContentType", params.contentType());
            outputResult.put("container", params.container());
            outputResult.put("sampleRateHz", params.sampleRateHz());
            outputResult.put("channels", params.channels());
            outputResult.put("durationMillis", probed.get("durationMillis"));
            outputResult.put("codec", probed.get("codec"));
            synchronized (run.lock) {
                if (run.cancelled.isCancelled()) {
                    discard(dir);
                    throw new java.util.concurrent.CancellationException("transcode cancelled before commit");
                }
                move(part, dir.resolve("out.bin"));
                Map<String, Object> receipt = new LinkedHashMap<>();
                receipt.put("tenantId", attempt.tenantId());
                receipt.put("jobId", attempt.jobId());
                receipt.put("attemptNumber", attempt.attemptNumber());
                receipt.put("requestFingerprint", attempt.requestFingerprint());
                receipt.put("operationId", attempt.providerOperationId());
                receipt.put("receiptId", attempt.providerReceiptId());
                receipt.put("result", outputResult);
                receipt.put("committedAt", Instant.now().toString());
                writeAtomically(dir.resolve("receipt.json"), JSON.writeValueAsBytes(receipt));
                run.committed = true;
            }
            Files.deleteIfExists(source);
            gate(PHASE_AFTER_COMMIT, context, run);
            return new ProviderSubmission(AttemptFinality.SUCCEEDED, attempt.providerOperationId(),
                    attempt.providerReceiptId(), outputResult, provenance(attempt.providerOperationId(), outputSha),
                    Instant.now());
        } finally {
            Files.deleteIfExists(source);
        }
    }

    @Override
    public CompletableFuture<ProviderAttemptObservation> reconcileAttempt(ProviderAttemptQuery query) {
        try {
            return CompletableFuture.completedFuture(observe(query));
        } catch (RuntimeException | IOException failure) {
            return CompletableFuture.completedFuture(unknown(query));
        }
    }

    private ProviderAttemptObservation unknown(ProviderAttemptQuery query) {
        return new ProviderAttemptObservation(query, AttemptFinality.UNKNOWN, query.providerReceiptId(), Map.of(), "",
                Instant.now());
    }

    @SuppressWarnings("unchecked")
    private ProviderAttemptObservation observe(ProviderAttemptQuery query) throws IOException {
        if (!PROVIDER_ID.equals(query.providerId())
                || !query.providerOperationId().equals(PROVIDER_ID + ":" + query.jobId() + ":" + query.attemptNumber())
                || !query.providerReceiptId().equals(sha256(query.providerOperationId() + ":" + query.requestFingerprint()))) {
            return unknown(query);
        }
        if (active.containsKey(key(query.tenantId(), query.jobId()))) return unknown(query);
        Path dir = operationDir(query.providerOperationId());
        Path receiptFile = dir.resolve("receipt.json");
        if (Files.isRegularFile(receiptFile)) {
            Map<String, Object> receipt = JSON.readValue(Files.readAllBytes(receiptFile), new TypeReference<>() { });
            Path out = dir.resolve("out.bin");
            if (!query.tenantId().equals(receipt.get("tenantId")) || !query.jobId().equals(receipt.get("jobId"))
                    || !query.requestFingerprint().equals(receipt.get("requestFingerprint"))
                    || !query.providerOperationId().equals(receipt.get("operationId"))
                    || !query.providerReceiptId().equals(receipt.get("receiptId"))
                    || !(receipt.get("result") instanceof Map<?, ?> committed)
                    || !Files.isRegularFile(out)) {
                return unknown(query);
            }
            Map<String, Object> result = new LinkedHashMap<>((Map<String, Object>) committed);
            String outputSha = sha256(Files.readAllBytes(out));
            if (!outputSha.equals(result.get("outputSha256"))) return unknown(query);
            return new ProviderAttemptObservation(query, AttemptFinality.SUCCEEDED, query.providerReceiptId(), result,
                    provenance(query.providerOperationId(), outputSha), Instant.now());
        }
        Path begin = dir.resolve("begin.json");
        String reason;
        if (!Files.isRegularFile(begin)) {
            reason = "never-started";
        } else {
            Map<String, Object> marker = JSON.readValue(Files.readAllBytes(begin), new TypeReference<>() { });
            if (!(marker.get("owner") instanceof String markerOwner)
                    || !MediaDevRequestLedger.ownerProcessIsGone(markerOwner)) {
                return unknown(query);
            }
            reason = "owner-gone-uncommitted";
        }
        // No receipt exists and no live process can still write one: the output was never visible.
        if (Files.isDirectory(dir)) discard(dir);
        return new ProviderAttemptObservation(query, AttemptFinality.NO_EFFECT_PROVEN, query.providerReceiptId(),
                Map.of(), sha256("no-effect:" + query.providerOperationId() + ":" + reason), Instant.now());
    }

    @Override
    public CancellationOutcome cancel(String tenantId, String principalId, String correlationId, String jobId) {
        Active run = active.get(key(tenantId, jobId));
        if (run == null) return CancellationOutcome.UNSUPPORTED;
        synchronized (run.lock) {
            // A committed output cannot be un-done; the typed success will finalize the job.
            if (run.committed) return CancellationOutcome.REQUESTED_UNCONFIRMED;
            run.cancelled.cancel();
            return CancellationOutcome.CONFIRMED;
        }
    }

    private void gate(String phase, ProcessingContext context, Active run) {
        if (gateDir == null) return;
        String tag = phase + "-" + context.artifact().sha256().substring(0, 16);
        Path hold = gateDir.resolve("hold-" + tag);
        if (!Files.exists(hold)) return;
        try {
            Files.writeString(gateDir.resolve("reached-" + tag), Instant.now().toString());
            while (Files.exists(hold) && (run.committed || !run.cancelled.isCancelled())) Thread.sleep(25);
        } catch (IOException failure) {
            throw new IllegalStateException("fault gate unavailable", failure);
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
        }
    }

    private Map<String, Object> probe(Path file) throws IOException {
        BoundedProcessRunner.Result result = BoundedProcessRunner.run(
                List.of(ffprobe.toString(), "-v", "error", "-select_streams", "a:0", "-show_entries",
                        "stream=codec_name,duration", "-of", "default=noprint_wrappers=1", file.toString()),
                file.getParent(), Map.of(), Duration.ofSeconds(20), 4_096, 4_096,
                BoundedProcessRunner.CancellationToken.NEVER, null, 0);
        String text = new String(result.stdout(), StandardCharsets.UTF_8);
        String codec = "";
        long millis = -1;
        for (String line : text.split("\n")) {
            if (line.startsWith("codec_name=")) codec = line.substring("codec_name=".length()).trim();
            if (line.startsWith("duration=")) {
                try { millis = Math.round(Double.parseDouble(line.substring("duration=".length()).trim()) * 1000); }
                catch (NumberFormatException ignored) { millis = -1; }
            }
        }
        if (!result.succeeded() || codec.isBlank()) throw new IOException("transcode output is not decodable audio");
        return Map.of("codec", codec, "durationMillis", millis);
    }

    /**
     * Removes attempt directories that restart reconciliation can no longer need, and returns how many were removed.
     *
     * <p>A directory is pruned only when every condition holds: its name is exactly the hash of the operation its own
     * marker names; its job is terminal according to {@code jobTerminal} (the job store, which is the authority; a
     * committed receipt alone is not enough, because a launcher that died after the commit still has to reconcile
     * the job to SUCCEEDED); no attempt for that job is active in this process; and the directory has not changed
     * within the retention window. Anything unreadable, unidentifiable, or still referenced is kept. At most
     * {@code maximumDirectories} candidates are examined per call, so one pass stays bounded.</p>
     */
    int pruneTerminalAttempts(BiPredicate<String, String> jobTerminal, Instant now, int maximumDirectories)
            throws IOException {
        if (!Files.isDirectory(spool)) return 0;
        Instant cutoff = now.minus(retention);
        int examined = 0;
        int pruned = 0;
        List<Path> entries;
        try (Stream<Path> listing = Files.list(spool)) {
            entries = listing.sorted().toList();
        }
        for (Path entry : entries) {
            if (examined >= maximumDirectories) break;
            String name = entry.getFileName().toString();
            if (!ATTEMPT_DIRECTORY.matcher(name).matches() || !Files.isDirectory(entry, LinkOption.NOFOLLOW_LINKS)) {
                continue;
            }
            examined++;
            try {
                if (Files.getLastModifiedTime(entry, LinkOption.NOFOLLOW_LINKS).toInstant().isAfter(cutoff)) continue;
                Optional<String[]> identity = attemptIdentity(entry, name);
                if (identity.isEmpty()) continue;
                String tenantId = identity.get()[0];
                String jobId = identity.get()[1];
                if (active.containsKey(key(tenantId, jobId))) continue;
                if (!jobTerminal.test(tenantId, jobId)) continue;
                discard(entry);
                pruned++;
            } catch (IOException | RuntimeException unreadable) {
                // Keep anything whose identity or terminality cannot be proven.
            }
        }
        return pruned;
    }

    /** {tenantId, jobId} of the attempt that owns this directory, or empty when it cannot be proven from its markers. */
    private static Optional<String[]> attemptIdentity(Path dir, String name) throws IOException {
        Path marker = Files.isRegularFile(dir.resolve("receipt.json"), LinkOption.NOFOLLOW_LINKS)
                ? dir.resolve("receipt.json") : dir.resolve("begin.json");
        if (!Files.isRegularFile(marker, LinkOption.NOFOLLOW_LINKS)) return Optional.empty();
        Map<String, Object> fields = JSON.readValue(Files.readAllBytes(marker), new TypeReference<>() { });
        if (!(fields.get("tenantId") instanceof String tenantId) || tenantId.isBlank()
                || !(fields.get("jobId") instanceof String jobId) || jobId.isBlank()
                || !(fields.get("operationId") instanceof String operationId)) {
            return Optional.empty();
        }
        if (!operationId.startsWith(PROVIDER_ID + ":" + jobId + ":")) return Optional.empty();
        if (!sha256(operationId).substring(0, 40).equals(name)) return Optional.empty();
        return Optional.of(new String[] {tenantId, jobId});
    }

    private Path operationDir(String operationId) {
        return spool.resolve(sha256(operationId).substring(0, 40));
    }

    private static String key(String tenantId, String jobId) { return tenantId + "\u0000" + jobId; }

    private static String provenance(String operationId, String outputSha256) {
        return sha256("provenance:" + PROVIDER_ID + ":" + operationId + ":" + outputSha256);
    }

    private static void discard(Path dir) {
        try (Stream<Path> walk = Files.walk(dir)) {
            walk.sorted(java.util.Comparator.reverseOrder()).forEach(path -> {
                try { Files.deleteIfExists(path); } catch (IOException ignored) { /* best effort */ }
            });
        } catch (IOException ignored) {
            log.warn("DEV ffmpeg transcode spool discard incomplete");
        }
    }

    private static void writeAtomically(Path target, byte[] bytes) throws IOException {
        Path temporary = target.resolveSibling(target.getFileName() + ".tmp");
        Files.write(temporary, bytes, StandardOpenOption.CREATE, StandardOpenOption.TRUNCATE_EXISTING,
                StandardOpenOption.WRITE);
        move(temporary, target);
    }

    private static void move(Path from, Path to) throws IOException {
        try {
            Files.move(from, to, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        } catch (AtomicMoveNotSupportedException unsupported) {
            throw new IOException("atomic rename is required for the DEV ffmpeg job spool", unsupported);
        }
    }

    private static String sha256(String value) { return sha256(value.getBytes(StandardCharsets.UTF_8)); }

    private static String sha256(byte[] value) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value));
        } catch (java.security.NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 unavailable", impossible);
        }
    }
}
