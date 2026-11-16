package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentContracts.Resolution;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ResolutionRequest;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Verdict;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.SerializationFeature;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.InputStream;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.channels.FileChannel;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.TreeMap;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.Semaphore;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.locks.ReentrantLock;
import java.util.stream.Stream;
import java.util.zip.CRC32;

/**
 * DEV_ONLY live media session authority (J-29 {@code media.dev.outcome-live-session-recovery}).
 *
 * <p><b>What a session is.</b> An authenticated owner opens a session bound to an exact consent subject (an artifact
 * version with a current {@code PROCESSING} or {@code VOICE_OR_LIKENESS_USE} attestation resolved through the rights
 * and consent authority), streams fixed-size PCM16 frames over plain HTTP ({@code POST .../frames}, a binary record
 * stream that may be chunked), and ends the stream with an end-of-stream request that stores the received media as a
 * WAV artifact plus a JSON PTS index artifact. Every frame carries a sequence number, an exact PTS in samples and a
 * CRC-32; the PTS must equal {@code startPts + sequence * samplesPerFrame}.</p>
 *
 * <p><b>Ordering and recovery.</b> Frames inside a bounded window past the next expected sequence are held and written
 * in order when the gap fills; a frame beyond the window is refused, never buffered. A duplicate of a stored frame is
 * acknowledged without being stored again and a conflicting duplicate is refused. Written frames go to an owner-only
 * append-only spool (record = seq, pts, length, crc, payload) that survives a launcher restart: the acknowledgement
 * ({@code ackedThroughSequence}) is exactly the contiguous written prefix, so a reconnecting client resumes from it
 * with no duplicates and no loss. After a kill the spool is rescanned and a torn tail is cut.</p>
 *
 * <p><b>Honest terminal outcomes.</b> A session ends COMPLETED (artifacts registered), ABORTED, EXPIRED (lease),
 * REVOKED (consent no longer admitted: spool destroyed, nothing registered) or FAILED. The outcome is never silently
 * "completed": a session the launcher no longer knows is a typed 404, and an interrupted finalization is FINALIZING
 * until the end-of-stream request is repeated (registration is idempotent per session).</p>
 *
 * <p><b>Bounded resources.</b> The only memory held per session is the reorder window; a global byte budget bounds the
 * held frames of all sessions and an out-of-order frame that cannot be held is refused with a typed backpressure
 * outcome. Each session has a byte ceiling and a lease; the number of open sessions is capped.</p>
 *
 * <p>Limits of this DEV_ONLY slice: audio only; state lives in a local spool directory, not PostgreSQL (one launcher
 * instance owns it); a consent revocation is observed within the poll interval, not instantaneously.</p>
 */
final class MediaDevLiveSessionRuntime implements AutoCloseable {
    static final String SCHEMA = "media.dev.live-session.v1";
    static final String SCHEMA_INDEX = "media.dev.live-pts-index.v1";
    static final String ENV_DIR = "MEDIA_DEV_LIVE_SESSION_DIR";
    static final String ENV_BUDGET = "MEDIA_DEV_LIVE_GLOBAL_BUFFER_BYTES";
    static final String ENV_POLL = "MEDIA_DEV_LIVE_REVOCATION_POLL_MS";
    static final String ENV_MAX_OPEN = "MEDIA_DEV_LIVE_MAX_OPEN_SESSIONS";
    static final String ENV_MAX_BYTES = "MEDIA_DEV_LIVE_MAX_SESSION_BYTES";
    static final int HEADER_BYTES = 24;
    static final int MAX_FRAME_SAMPLES = 4_800;
    static final int MIN_FRAME_SAMPLES = 80;
    static final int MAX_WINDOW = 64;
    static final int MAX_LEASE_SECONDS = 300;
    static final long MAX_LIFETIME_MILLIS = Duration.ofMinutes(15).toMillis();
    static final Set<Integer> RATES = Set.of(16_000, 24_000, 48_000);
    static final Set<Scope> SCOPES = Set.of(Scope.PROCESSING, Scope.VOICE_OR_LIKENESS_USE);
    private static final int MAX_TOMBSTONES = 512;
    private static final long LOCK_WAIT_MILLIS = 2_000;
    private static final int BUDGET_UNIT = 1024;
    private static final ObjectMapper JSON = JsonMapper.builder().enable(SerializationFeature.ORDER_MAP_ENTRIES_BY_KEYS).build();
    private static final Logger log = LoggerFactory.getLogger(MediaDevLiveSessionRuntime.class);

    enum State { OPEN, FINALIZING, COMPLETED, ABORTED, EXPIRED, REVOKED, FAILED;
        boolean terminal() { return this != OPEN && this != FINALIZING; } }

    /** A typed refusal with an HTTP status; carries no media content. */
    static final class LiveException extends RuntimeException {
        private final int status;
        private final String code;
        private final Map<String, Object> details;

        LiveException(int status, String code, String message, Map<String, Object> details) {
            super(message, null, false, false);
            this.status = status;
            this.code = code;
            this.details = details == null ? Map.of() : details;
        }

        int status() { return status; }
        String code() { return code; }
        Map<String, Object> details() { return details; }
    }

    record Config(Path directory, long globalBufferBytes, long revocationPollMillis, int maxOpenSessions,
                  long maxSessionBytes) {
        Config {
            Objects.requireNonNull(directory, "directory");
            if (!directory.isAbsolute()) throw new IllegalArgumentException(ENV_DIR + " must be an absolute path");
            if (globalBufferBytes < 64 * 1024 || globalBufferBytes > 512L * 1024 * 1024) {
                throw new IllegalArgumentException(ENV_BUDGET + " must be 65536..536870912");
            }
            if (revocationPollMillis < 20 || revocationPollMillis > 30_000) {
                throw new IllegalArgumentException(ENV_POLL + " must be 20..30000");
            }
            if (maxOpenSessions < 1 || maxOpenSessions > 4096) throw new IllegalArgumentException(ENV_MAX_OPEN + " must be 1..4096");
            if (maxSessionBytes < 64 * 1024 || maxSessionBytes > 64L * 1024 * 1024) {
                throw new IllegalArgumentException(ENV_MAX_BYTES + " must be 65536..67108864");
            }
        }

        static Config from(Map<String, String> environment) {
            String configured = environment.get(ENV_DIR);
            Path directory = configured != null && !configured.isBlank() ? Path.of(configured)
                    : Path.of(System.getProperty("java.io.tmpdir"), "media-dev-live-sessions-" + System.getProperty("user.name", "user"));
            return new Config(directory, number(environment, ENV_BUDGET, 16L * 1024 * 1024),
                    number(environment, ENV_POLL, 250), (int) number(environment, ENV_MAX_OPEN, 256),
                    number(environment, ENV_MAX_BYTES, 16L * 1024 * 1024));
        }

        private static long number(Map<String, String> environment, String key, long fallback) {
            String raw = environment.get(key);
            if (raw == null || raw.isBlank()) return fallback;
            try { return Long.parseLong(raw.trim()); }
            catch (NumberFormatException invalid) { throw new IllegalArgumentException(key + " must be an integer"); }
        }
    }

    /** Validated session-open request. */
    record Open(String requestId, String consentArtifactId, String consentVersionId, Scope scope, int sampleRate,
                int channels, int samplesPerFrame, long startPts, int window, int leaseSeconds) {
        int frameBytes() { return samplesPerFrame * channels * 2; }
    }

    /** One end-of-stream request. */
    record End(long finalSequence) { }

    /** Outcome of one frames request: the session view after the request and the typed stop reason, if any. */
    record Ingest(Map<String, Object> view, int accepted, int duplicates, int bufferedNow, LiveException stop) { }

    private static final class Frame {
        final long pts;
        final byte[] payload;
        final int crc;
        Frame(long pts, byte[] payload, int crc) { this.pts = pts; this.payload = payload; this.crc = crc; }
    }

    private static final class Session {
        final String id;
        final String tenantId;
        final String principalId;
        final String fingerprint;
        final Open open;
        final String consentSha256;
        final long createdAtMs;
        final Path directory;
        final ReentrantLock lock = new ReentrantLock();
        final TreeMap<Long, Frame> pending = new TreeMap<>();
        int[] crcs = new int[256];
        long nextExpected;
        long pendingBytes;
        long bytesWritten;
        long leaseExpiresAtMs;
        long persistedLeaseMs;
        volatile State state = State.OPEN;
        String terminalCode = "";
        String terminalDetail = "";
        long duplicates;
        long reordered;
        long refusedWindow;
        long backpressure;
        long finalSequence = -1;
        int recoveries;
        boolean recovered;
        volatile long lastRightsCheckMs;
        final java.util.concurrent.atomic.AtomicBoolean rightsCheckRunning = new java.util.concurrent.atomic.AtomicBoolean();
        volatile String lastVerdict = "ADMITTED";
        List<String> attestationIds = List.of();
        Map<String, Object> outputs = Map.of();
        FileChannel spool;

        Session(String id, String tenantId, String principalId, String fingerprint, Open open, String consentSha256,
                long createdAtMs, Path directory) {
            this.id = id; this.tenantId = tenantId; this.principalId = principalId; this.fingerprint = fingerprint;
            this.open = open; this.consentSha256 = consentSha256; this.createdAtMs = createdAtMs; this.directory = directory;
        }

        Path spoolPath() { return directory.resolve("frames.spool"); }
        Path manifestPath() { return directory.resolve("manifest.json"); }

        void remember(long sequence, int crc) {
            if (sequence >= crcs.length) crcs = Arrays.copyOf(crcs, Math.max(crcs.length * 2, (int) sequence + 1));
            crcs[(int) sequence] = crc;
        }
    }

    private final MediaRuntime runtime;
    private final RightsConsentResolver rights;
    private final MediaDevProjectRenderRuntime.OutputRegistrar registrar;
    private final Config config;
    private final Clock clock;
    private final Semaphore budget;
    private final Map<String, Session> sessions = new ConcurrentHashMap<>();
    private final Map<String, Object[]> rightsCache = new ConcurrentHashMap<>();
    private final ScheduledExecutorService sweeper;
    private final java.util.concurrent.ExecutorService rightsPool = Executors.newFixedThreadPool(4, task -> {
        Thread thread = new Thread(task, "media-dev-live-consent");
        thread.setDaemon(true);
        return thread;
    });
    private final long budgetUnits;
    /** Test hook run under the session lock before each spool write (simulates a slow consumer). */
    volatile Runnable beforeSpoolWrite;

    MediaDevLiveSessionRuntime(MediaRuntime runtime, RightsConsentResolver rights,
                               MediaDevProjectRenderRuntime.OutputRegistrar registrar, Config config, Clock clock) {
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.rights = rights == null ? RightsConsentResolver.unavailable() : rights;
        this.registrar = Objects.requireNonNull(registrar, "registrar");
        this.config = Objects.requireNonNull(config, "config");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.budgetUnits = Math.max(1, config.globalBufferBytes() / BUDGET_UNIT);
        this.budget = new Semaphore((int) budgetUnits);
        try {
            Files.createDirectories(config.directory());
            try { Files.setPosixFilePermissions(config.directory(), PosixFilePermissions.fromString("rwx------")); }
            catch (UnsupportedOperationException | IOException ignored) { /* best effort on non-POSIX stores */ }
        } catch (IOException failure) {
            throw new IllegalStateException("the live session directory is not usable", failure);
        }
        recover();
        this.sweeper = Executors.newSingleThreadScheduledExecutor(task -> {
            Thread thread = new Thread(task, "media-dev-live-sweeper");
            thread.setDaemon(true);
            return thread;
        });
        long tick = Math.max(10, Math.min(100, config.revocationPollMillis() / 2));
        sweeper.scheduleWithFixedDelay(this::sweepQuietly, tick, tick, TimeUnit.MILLISECONDS);
    }

    static MediaDevLiveSessionRuntime compose(MediaRuntime runtime, Map<String, String> environment,
                                              RightsConsentResolver rights) {
        MediaDevLiveSessionRuntime live = new MediaDevLiveSessionRuntime(runtime, rights,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), Config.from(environment), Clock.systemUTC());
        live.registerBudgets(runtime.laneMetrics());
        return live;
    }

    /** Export the live open-session and reorder-buffer budgets and the spool volume's free space. */
    void registerBudgets(com.ghatana.audiovideo.observability.MediaLaneMetrics metrics) {
        metrics.registerBudget(com.ghatana.audiovideo.observability.MediaLaneMetrics.Budget.LIVE_SESSIONS,
                config::maxOpenSessions,
                () -> config.maxOpenSessions() - sessions.values().stream().filter(s -> !s.state.terminal()).count());
        metrics.registerBudget(com.ghatana.audiovideo.observability.MediaLaneMetrics.Budget.LIVE_BUFFER_BYTES,
                () -> (double) budgetUnits * BUDGET_UNIT, () -> (double) budget.availablePermits() * BUDGET_UNIT);
        metrics.registerDisk(com.ghatana.audiovideo.observability.MediaLaneMetrics.Volume.LIVE_SPOOL,
                () -> config.directory().toFile().getUsableSpace(),
                () -> (double) config.maxOpenSessions() * config.maxSessionBytes());
    }

    @Override
    public void close() {
        sweeper.shutdownNow();
        rightsPool.shutdownNow();
        for (Session session : sessions.values()) {
            session.lock.lock();
            try { closeSpool(session); } finally { session.lock.unlock(); }
        }
    }

    // ---------------------------------------------------------------------------------------------- status

    Map<String, Object> status() {
        long open = sessions.values().stream().filter(s -> s.state == State.OPEN || s.state == State.FINALIZING).count();
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("scope", "DEV_ONLY");
        out.put("schema", SCHEMA);
        out.put("ready", rights.ready());
        Map<String, Object> limits = new LinkedHashMap<>();
        limits.put("codec", "PCM_S16LE");
        limits.put("sampleRatesHz", RATES.stream().sorted().toList());
        limits.put("channels", List.of(1, 2));
        limits.put("samplesPerFrame", List.of(MIN_FRAME_SAMPLES, MAX_FRAME_SAMPLES));
        limits.put("reorderWindowFrames", List.of(1, MAX_WINDOW));
        limits.put("leaseSeconds", List.of(1, MAX_LEASE_SECONDS));
        limits.put("maxLifetimeSeconds", MAX_LIFETIME_MILLIS / 1000);
        limits.put("maxSessionBytes", config.maxSessionBytes());
        limits.put("maxOpenSessions", config.maxOpenSessions());
        limits.put("globalReorderBufferBytes", config.globalBufferBytes());
        limits.put("revocationPollMillis", config.revocationPollMillis());
        limits.put("frameHeaderBytes", HEADER_BYTES);
        out.put("limits", limits);
        out.put("openSessions", open);
        out.put("reorderBufferBytesInUse", (budgetUnits - budget.availablePermits()) * (long) BUDGET_UNIT);
        out.put("consentScopes", SCOPES.stream().map(Enum::name).sorted().toList());
        out.put("frameFormat", "big-endian records: u64 sequence, u64 ptsSamples, u32 payloadBytes, u32 crc32(payload), payload");
        return out;
    }

    // ---------------------------------------------------------------------------------------------- create

    Map<String, Object> create(String tenantId, String principalId, Open request) {
        String id = "ls-" + MediaDevProjectRenderRuntime.sha256Hex(tenantId + "\u0000" + principalId + "\u0000"
                + request.requestId()).substring(0, 24);
        String fingerprint = MediaDevProjectRenderRuntime.sha256Hex(request.toString());
        Session existing = sessions.get(id);
        if (existing != null) {
            if (!existing.fingerprint.equals(fingerprint)) {
                throw new LiveException(409, "LIVE_REQUEST_ID_REUSED", "requestId was already used with a different session request", Map.of());
            }
            Map<String, Object> view = view(existing);
            view.put("replayed", true);
            return view;
        }
        MediaArtifact consent = runtime.artifact(tenantId, principalId, request.consentArtifactId())
                .filter(found -> found.version().value().equals(request.consentVersionId()))
                .orElseThrow(() -> new LiveException(404, "CONSENT_SUBJECT_NOT_FOUND",
                        "the exact consent artifact version is not available to this DEV_ONLY principal", Map.of()));
        Resolution resolution = resolve(tenantId, consent.artifactId(), consent.version().value(), consent.sha256(), request.scope(), 0);
        if (!resolution.admitted()) throw notAdmitted(resolution, request.scope());
        long open = sessions.values().stream().filter(s -> !s.state.terminal()).count();
        if (open >= config.maxOpenSessions()) {
            throw new LiveException(429, "LIVE_CAPACITY_EXHAUSTED", "the open live session ceiling is reached; retry later",
                    Map.of("maxOpenSessions", config.maxOpenSessions()));
        }
        long now = clock.millis();
        Session session = new Session(id, tenantId, principalId, fingerprint, request, consent.sha256(), now, config.directory().resolve(id));
        session.leaseExpiresAtMs = now + request.leaseSeconds() * 1000L;
        session.lastRightsCheckMs = now;
        session.attestationIds = resolution.attestationIds();
        try {
            Files.createDirectories(session.directory);
            session.spool = FileChannel.open(session.spoolPath(), StandardOpenOption.CREATE_NEW, StandardOpenOption.WRITE, StandardOpenOption.READ);
            try { Files.setPosixFilePermissions(session.spoolPath(), PosixFilePermissions.fromString("rw-------")); }
            catch (UnsupportedOperationException ignored) { /* non-POSIX */ }
            persist(session);
        } catch (IOException failure) {
            throw new LiveException(503, "LIVE_STORAGE_UNAVAILABLE", "the session spool could not be created", Map.of());
        }
        Session raced = sessions.putIfAbsent(id, session);
        if (raced != null) { // concurrent identical create: the first one wins, the loser did nothing durable twice
            closeSpool(session);
            Map<String, Object> view = view(raced);
            view.put("replayed", true);
            return view;
        }
        prune();
        Map<String, Object> view = view(session);
        view.put("replayed", false);
        return view;
    }

    // ---------------------------------------------------------------------------------------------- read / abort

    Map<String, Object> read(String tenantId, String principalId, String sessionId) {
        Session session = owned(tenantId, principalId, sessionId);
        lock(session);
        try { return view(session); } finally { session.lock.unlock(); }
    }

    Map<String, Object> abort(String tenantId, String principalId, String sessionId) {
        Session session = owned(tenantId, principalId, sessionId);
        lock(session);
        try {
            if (session.state == State.OPEN || session.state == State.FINALIZING) {
                terminate(session, State.ABORTED, "ABORTED_BY_OWNER", "the owner discarded the session; nothing was stored");
            }
            return view(session);
        } finally { session.lock.unlock(); }
    }

    // ---------------------------------------------------------------------------------------------- ingest

    Ingest ingest(String tenantId, String principalId, String sessionId, InputStream body, long maxBytes) {
        Session session = owned(tenantId, principalId, sessionId);
        int accepted = 0;
        int duplicates = 0;
        long consumed = 0;
        LiveException stop = null;
        byte[] header = new byte[HEADER_BYTES];
        boolean wrote = false;
        try {
            while (true) {
                int got = readFully(body, header, 0, HEADER_BYTES);
                if (got == 0) break; // clean end of the request body, on a record boundary
                if (got < HEADER_BYTES) {
                    stop = new LiveException(400, "FRAME_TRUNCATED", "the request ended inside a frame header; the partial frame was discarded", Map.of());
                    break;
                }
                ByteBuffer h = ByteBuffer.wrap(header).order(ByteOrder.BIG_ENDIAN);
                long sequence = h.getLong();
                long pts = h.getLong();
                long length = h.getInt() & 0xFFFFFFFFL;
                int crc = h.getInt();
                if (length != session.open.frameBytes()) {
                    stop = new LiveException(422, "FRAME_SIZE_INVALID", "payloadBytes must equal samplesPerFrame * channels * 2",
                            Map.of("expectedBytes", session.open.frameBytes(), "actualBytes", length, "sequence", sequence));
                    break;
                }
                consumed += HEADER_BYTES + length;
                if (consumed > maxBytes) {
                    stop = new LiveException(413, "REQUEST_TOO_LARGE", "this request exceeded the per-request byte ceiling; split it",
                            Map.of("maxRequestBytes", maxBytes));
                    break;
                }
                byte[] payload = new byte[(int) length];
                if (readFully(body, payload, 0, payload.length) < payload.length) {
                    stop = new LiveException(400, "FRAME_TRUNCATED", "the request ended inside a frame payload; the partial frame was discarded",
                            Map.of("sequence", sequence));
                    break;
                }
                Outcome outcome = apply(session, sequence, pts, crc, payload);
                if (outcome == Outcome.DUPLICATE) duplicates++;
                else accepted++;
                if (outcome == Outcome.WRITTEN) wrote = true;
            }
        } catch (LiveException refused) {
            stop = refused;
        } catch (IOException readFailure) {
            stop = new LiveException(400, "FRAME_STREAM_BROKEN", "the request body ended abnormally; accepted frames are kept", Map.of());
        }
        int buffered;
        Map<String, Object> view;
        lock(session);
        try {
            if (wrote && session.spool != null && session.spool.isOpen()) {
                try { session.spool.force(false); } catch (IOException ignored) { /* ack is process-crash safe regardless */ }
            }
            persistThrottled(session);
            buffered = session.pending.size();
            view = view(session);
        } finally { session.lock.unlock(); }
        return new Ingest(view, accepted, duplicates, buffered, stop);
    }

    private enum Outcome { WRITTEN, BUFFERED, DUPLICATE }

    private Outcome apply(Session session, long sequence, long pts, int crc, byte[] payload) {
        long maxFrames = Math.min(config.maxSessionBytes() / session.open.frameBytes(), Integer.MAX_VALUE - 8);
        if (sequence < 0 || sequence >= maxFrames) {
            throw new LiveException(413, "SESSION_BYTES_EXCEEDED", "the session byte ceiling is reached; end the stream",
                    Map.of("maxFrames", maxFrames, "sequence", sequence));
        }
        if (pts != session.open.startPts() + sequence * session.open.samplesPerFrame()) {
            throw new LiveException(422, "PTS_MISMATCH", "ptsSamples must equal startPts + sequence * samplesPerFrame; the frame was not stored",
                    Map.of("sequence", sequence, "expectedPts", session.open.startPts() + sequence * session.open.samplesPerFrame(), "actualPts", pts));
        }
        CRC32 digest = new CRC32();
        digest.update(payload);
        if ((int) digest.getValue() != crc) {
            throw new LiveException(422, "FRAME_CRC_MISMATCH", "the payload does not match its CRC-32; the frame was not stored",
                    Map.of("sequence", sequence));
        }
        long now = clock.millis();
        // The sweeper owns the periodic consent poll; a request re-checks itself only when the sweeper is late (watchdog).
        if (now - session.lastRightsCheckMs >= 3 * config.revocationPollMillis()) refreshRights(session, now, true);
        lock(session);
        boolean reserved = false;
        try {
            checkOpen(session, now);
            if (sequence < session.nextExpected) {
                if (session.crcs[(int) sequence] != crc) throw conflict(sequence);
                session.duplicates++;
                renew(session, now);
                return Outcome.DUPLICATE;
            }
            Frame held = session.pending.get(sequence);
            if (held != null) {
                if (held.crc != crc || !Arrays.equals(held.payload, payload)) throw conflict(sequence);
                session.duplicates++;
                renew(session, now);
                return Outcome.DUPLICATE;
            }
            if (sequence > session.nextExpected) {
                if (sequence - session.nextExpected >= session.open.window()) {
                    session.refusedWindow++;
                    throw new LiveException(409, "SEQUENCE_WINDOW_EXCEEDED",
                            "the frame is beyond the reorder window past the next expected sequence; it was not buffered",
                            Map.of("sequence", sequence, "nextExpectedSequence", session.nextExpected, "windowFrames", session.open.window()));
                }
                int permits = (int) Math.ceil(payload.length / (double) BUDGET_UNIT);
                if (!budget.tryAcquire(permits)) {
                    session.backpressure++;
                    throw new LiveException(429, "BACKPRESSURE_SLOW_CONSUMER",
                            "the shared reorder buffer is full; the frame was not accepted, resend it from ackedThroughSequence",
                            Map.of("retryAfterMillis", 100, "sequence", sequence, "nextExpectedSequence", session.nextExpected));
                }
                reserved = true;
                session.pending.put(sequence, new Frame(pts, payload, crc));
                session.pendingBytes += payload.length;
                reserved = false; // ownership moved to the pending map
                renew(session, now);
                return Outcome.BUFFERED;
            }
            writeFrame(session, sequence, pts, crc, payload);
            while (!session.pending.isEmpty() && session.pending.firstKey() == session.nextExpected) {
                Map.Entry<Long, Frame> next = session.pending.pollFirstEntry();
                writeFrame(session, next.getKey(), next.getValue().pts, next.getValue().crc, next.getValue().payload);
                session.pendingBytes -= next.getValue().payload.length;
                budget.release((int) Math.ceil(next.getValue().payload.length / (double) BUDGET_UNIT));
                session.reordered++;
            }
            renew(session, now);
            return Outcome.WRITTEN;
        } finally {
            if (reserved) budget.release((int) Math.ceil(payload.length / (double) BUDGET_UNIT));
            session.lock.unlock();
        }
    }

    private static LiveException conflict(long sequence) {
        return new LiveException(409, "DUPLICATE_SEQUENCE_CONFLICT",
                "a different frame was already received for this sequence; the new frame was not stored", Map.of("sequence", sequence));
    }

    private void writeFrame(Session session, long sequence, long pts, int crc, byte[] payload) {
        Runnable hook = beforeSpoolWrite;
        if (hook != null) hook.run();
        ByteBuffer record = ByteBuffer.allocate(HEADER_BYTES + payload.length).order(ByteOrder.BIG_ENDIAN);
        record.putLong(sequence).putLong(pts).putInt(payload.length).putInt(crc).put(payload).flip();
        try {
            long position = session.spool.size();
            while (record.hasRemaining()) position += session.spool.write(record, position);
        } catch (IOException failure) {
            terminate(session, State.FAILED, "SPOOL_WRITE_FAILED", "the session spool could not be written");
            throw new LiveException(503, "LIVE_STORAGE_UNAVAILABLE", "the session spool could not be written; the session failed", Map.of());
        }
        session.remember(sequence, crc);
        session.nextExpected = sequence + 1;
        session.bytesWritten += payload.length;
    }

    private void checkOpen(Session session, long now) {
        if (session.state == State.OPEN && now > session.leaseExpiresAtMs) {
            terminate(session, State.EXPIRED, "LEASE_EXPIRED", "the session lease expired; received media was discarded");
        }
        if (session.state == State.OPEN) {
            if ("UNAVAILABLE".equals(session.lastVerdict)) {
                throw new LiveException(503, "RIGHTS_AUTHORITY_UNAVAILABLE",
                        "the consent authority could not be reached; nothing new is stored while consent cannot be confirmed", Map.of());
            }
            return;
        }
        if (session.state == State.FINALIZING) {
            throw new LiveException(409, "SESSION_FINALIZING", "the session is finalizing; repeat the end-of-stream request", stateDetail(session));
        }
        throw terminalError(session);
    }

    private LiveException terminalError(Session session) {
        Map<String, Object> details = stateDetail(session);
        return new LiveException(410, "SESSION_" + session.state.name(), session.terminalDetail.isEmpty()
                ? "the session is " + session.state : session.terminalDetail, details);
    }

    private Map<String, Object> stateDetail(Session session) {
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("state", session.state.name());
        details.put("terminalCode", session.terminalCode);
        details.put("ackedThroughSequence", session.nextExpected - 1);
        return details;
    }

    private void renew(Session session, long now) {
        session.leaseExpiresAtMs = Math.min(now + session.open.leaseSeconds() * 1000L, session.createdAtMs + MAX_LIFETIME_MILLIS);
    }

    // ---------------------------------------------------------------------------------------------- end of stream

    Map<String, Object> end(String tenantId, String principalId, String sessionId, End request) {
        Session session = owned(tenantId, principalId, sessionId);
        long now = clock.millis();
        lock(session);
        try {
            if (session.state == State.COMPLETED) {
                Map<String, Object> view = view(session);
                view.put("replayed", true);
                return view;
            }
            if (session.state.terminal()) throw terminalError(session);
            if (session.state == State.OPEN && now > session.leaseExpiresAtMs) {
                terminate(session, State.EXPIRED, "LEASE_EXPIRED", "the session lease expired; received media was discarded");
                throw terminalError(session);
            }
        } finally { session.lock.unlock(); }
        // A fresh, uncached consent decision gates finalization.
        Resolution resolution = resolve(tenantId, session.open.consentArtifactId(), session.open.consentVersionId(),
                session.consentSha256, session.open.scope(), 0);
        lock(session);
        try {
            if (session.state.terminal()) throw terminalError(session);
            observeRights(session, resolution);
            if (!"ADMITTED".equals(session.lastVerdict)) {
                if ("UNAVAILABLE".equals(session.lastVerdict)) {
                    throw new LiveException(503, "RIGHTS_AUTHORITY_UNAVAILABLE",
                            "the consent authority could not be reached; the stream was not finalized and stays open", Map.of());
                }
                throw terminalError(session);
            }
            if (session.state == State.OPEN) {
                long last = session.nextExpected - 1;
                if (request.finalSequence() > last || !session.pending.isEmpty()) {
                    List<Long> missing = new ArrayList<>();
                    for (long seq = session.nextExpected; seq <= request.finalSequence() && missing.size() < 32; seq++) {
                        if (!session.pending.containsKey(seq)) missing.add(seq);
                    }
                    Map<String, Object> details = new LinkedHashMap<>();
                    details.put("missingSequences", missing);
                    details.put("ackedThroughSequence", last);
                    details.put("finalSequence", request.finalSequence());
                    throw new LiveException(409, "EOS_GAP", "frames are missing before the declared final sequence; the session stays open", details);
                }
                if (request.finalSequence() < last) {
                    throw new LiveException(409, "EOS_BEFORE_RECEIVED_FRAMES",
                            "frames beyond the declared final sequence were already acknowledged; the declared end is not the received end",
                            Map.of("ackedThroughSequence", last, "finalSequence", request.finalSequence()));
                }
                if (last < 0) throw new LiveException(422, "EOS_EMPTY", "no frame was received; an empty stream is not stored", Map.of());
                session.finalSequence = request.finalSequence();
                session.state = State.FINALIZING;
                persistQuiet(session);
            } else if (request.finalSequence() != session.finalSequence) {
                throw new LiveException(409, "EOS_FINAL_SEQUENCE_CHANGED", "this session is finalizing with a different final sequence",
                        Map.of("finalSequence", session.finalSequence));
            }
            Map<String, Object> outputs = finalizeOutputs(session);
            session.outputs = outputs;
            session.state = State.COMPLETED;
            session.terminalCode = "COMPLETED";
            closeSpool(session);
            deleteQuietly(session.spoolPath());
            persistQuiet(session);
            Map<String, Object> view = view(session);
            view.put("replayed", false);
            return view;
        } finally { session.lock.unlock(); }
    }

    /** Builds the WAV and the PTS index from the validated spool, re-checks consent, registers both exactly once. */
    private Map<String, Object> finalizeOutputs(Session session) {
        long t0 = System.nanoTime();
        Open open = session.open;
        int frames = (int) (session.finalSequence + 1);
        short[] samples = new short[frames * open.samplesPerFrame() * open.channels()];
        List<Map<String, Object>> index = new ArrayList<>(frames);
        CRC32 digest = new CRC32();
        java.security.MessageDigest sha;
        try { sha = java.security.MessageDigest.getInstance("SHA-256"); }
        catch (java.security.NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
        try {
            ByteBuffer header = ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.BIG_ENDIAN);
            long position = 0;
            for (int i = 0; i < frames; i++) {
                header.clear();
                if (session.spool.read(header, position) < HEADER_BYTES) throw new IOException("short spool header");
                header.flip();
                long sequence = header.getLong();
                long pts = header.getLong();
                int length = header.getInt();
                int crc = header.getInt();
                if (sequence != i || length != open.frameBytes() || pts != open.startPts() + (long) i * open.samplesPerFrame()) {
                    throw new IOException("spool record " + i + " is out of order");
                }
                ByteBuffer payload = ByteBuffer.allocate(length);
                if (session.spool.read(payload, position + HEADER_BYTES) < length) throw new IOException("short spool payload");
                digest.reset();
                digest.update(payload.array());
                if ((int) digest.getValue() != crc) throw new IOException("spool record " + i + " fails its CRC");
                sha.update(payload.array());
                payload.flip().order(ByteOrder.LITTLE_ENDIAN).asShortBuffer().get(samples, i * open.samplesPerFrame() * open.channels(),
                        open.samplesPerFrame() * open.channels());
                Map<String, Object> entry = new LinkedHashMap<>();
                entry.put("sequence", sequence);
                entry.put("ptsSamples", pts);
                entry.put("samples", open.samplesPerFrame());
                entry.put("crc32", Integer.toUnsignedLong(crc));
                index.add(entry);
                position += HEADER_BYTES + length;
            }
        } catch (IOException corrupt) {
            terminate(session, State.FAILED, "SPOOL_CORRUPT", "the stored frames failed validation; nothing was registered");
            throw new LiveException(500, "LIVE_SPOOL_CORRUPT", "the stored frames failed validation; nothing was registered", Map.of());
        }
        String pcmSha = HexFormat.of().formatHex(sha.digest());
        String comment = "ghatana-media DEV_ONLY live session " + session.id;
        byte[] wav = MediaDevAudioWav.write(new MediaDevAudioWav.Pcm(open.sampleRate(), open.channels(), samples), comment);
        String wavSha = MediaDevProjectRenderRuntime.sha256Hex(wav);
        Map<String, Object> document = new LinkedHashMap<>();
        document.put("schema", SCHEMA_INDEX);
        document.put("scope", "DEV_ONLY");
        document.put("sessionId", session.id);
        document.put("timebase", Map.of("numerator", 1, "denominator", open.sampleRate()));
        document.put("startPtsSamples", open.startPts());
        document.put("samplesPerFrame", open.samplesPerFrame());
        document.put("channels", open.channels());
        document.put("frameCount", frames);
        document.put("totalSamplesPerChannel", (long) frames * open.samplesPerFrame());
        document.put("pcmSha256", pcmSha);
        document.put("wavSha256", wavSha);
        document.put("frames", index);
        byte[] indexBytes = json(document);
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("liveSessionSchema", SCHEMA);
        lineage.put("scope", "DEV_ONLY");
        lineage.put("sessionId", session.id);
        lineage.put("frameCount", frames);
        lineage.put("pcmSha256", pcmSha);
        lineage.put("startPtsSamples", open.startPts());
        lineage.put("consentArtifactId", open.consentArtifactId());
        lineage.put("consentArtifactVersionId", open.consentVersionId());
        lineage.put("consentScope", open.scope().name());
        lineage.put("consentAttestationIds", session.attestationIds);
        lineage.put("claims", "DEV_ONLY received live PCM; no rights clearance, quality, approval or production claim");
        long t1 = System.nanoTime();
        // Consent is decided again immediately before anything is registered.
        Resolution last = resolve(session.tenantId, open.consentArtifactId(), open.consentVersionId(), session.consentSha256,
                open.scope(), 0);
        observeRights(session, last);
        if (!"ADMITTED".equals(session.lastVerdict)) {
            if ("UNAVAILABLE".equals(session.lastVerdict)) {
                session.state = State.OPEN; // nothing was registered; the stream stays open and can end again
                throw new LiveException(503, "RIGHTS_AUTHORITY_UNAVAILABLE", "consent could not be re-confirmed; nothing was registered", Map.of());
            }
            throw terminalError(session);
        }
        Map<String, Object> wavLineage = new LinkedHashMap<>(lineage);
        wavLineage.put("kind", "LIVE_SESSION_WAV");
        Map<String, Object> indexLineage = new LinkedHashMap<>(lineage);
        indexLineage.put("kind", "LIVE_SESSION_PTS_INDEX");
        indexLineage.put("wavSha256", wavSha);
        long t2 = System.nanoTime();
        MediaArtifact wavArtifact = register(session, "wav", wav, "audio/wav", "live-" + session.id + ".wav", wavLineage);
        MediaArtifact indexArtifact = register(session, "index", indexBytes, "application/json", "live-" + session.id + ".pts.json", indexLineage);
        long t3 = System.nanoTime();
        log.info("DEV live session finalized session={} frames={} buildMs={} consentMs={} registerMs={}", session.id, frames,
                (t1 - t0) / 1_000_000, (t2 - t1) / 1_000_000, (t3 - t2) / 1_000_000);
        Map<String, Object> outputs = new LinkedHashMap<>();
        outputs.put("wav", artifactView(wavArtifact));
        outputs.put("ptsIndex", artifactView(indexArtifact));
        outputs.put("pcmSha256", pcmSha);
        outputs.put("frameCount", frames);
        return outputs;
    }

    private MediaArtifact register(Session session, String part, byte[] bytes, String contentType, String fileName,
                                   Map<String, Object> metadata) {
        String sha = MediaDevProjectRenderRuntime.sha256Hex(bytes);
        Map<String, Object> lineage = new LinkedHashMap<>(metadata);
        lineage.put("purpose", "live-session-output");
        UploadRequest upload = new UploadRequest(session.tenantId, session.principalId, fileName, contentType, bytes.length, sha,
                "INTERNAL", Duration.ofDays(30), lineage);
        String key = "dev-live:" + session.id + ":" + part;
        try {
            MediaArtifact artifact = registrar.register(session.tenantId, session.principalId, upload, key, bytes).artifact();
            if (!artifact.sha256().equals(sha)) throw new IllegalStateException("registered digest does not match the produced bytes");
            return artifact;
        } catch (RuntimeException failure) {
            log.warn("DEV live session output registration failed session={} cause={}", session.id, String.valueOf(failure));
            throw new LiveException(502, "LIVE_OUTPUT_REGISTRATION_FAILED",
                    "the output was not registered; repeat the end-of-stream request to resume", Map.of());
        }
    }

    private static Map<String, Object> artifactView(MediaArtifact artifact) {
        return Map.of("artifactId", artifact.artifactId(), "artifactVersionId", artifact.version().value(),
                "contentType", artifact.contentType(), "sizeBytes", artifact.sizeBytes(), "sha256", artifact.sha256(),
                "artifactPath", "/api/v1/artifacts/" + artifact.artifactId(),
                "contentPath", "/dev/v1/artifacts/" + artifact.artifactId() + "/content");
    }

    // ---------------------------------------------------------------------------------------------- rights

    private Resolution resolve(String tenantId, String artifactId, String versionId, String sha, Scope scope, long maxAgeMillis) {
        String key = tenantId + "\u0000" + artifactId + "\u0000" + versionId + "\u0000" + scope;
        long now = clock.millis();
        if (maxAgeMillis > 0) {
            Object[] cached = rightsCache.get(key);
            if (cached != null && now - (Long) cached[0] <= maxAgeMillis) return (Resolution) cached[1];
        }
        Resolution resolution;
        try {
            resolution = rights.resolve(new ResolutionRequest(tenantId, artifactId, versionId, sha, scope));
        } catch (RuntimeException failure) {
            resolution = Resolution.unavailable(rights.resolverId());
        }
        rightsCache.put(key, new Object[] {now, resolution});
        return resolution;
    }

    private static LiveException notAdmitted(Resolution resolution, Scope scope) {
        boolean unavailable = resolution.verdict() == Verdict.UNAVAILABLE;
        Map<String, Object> details = new LinkedHashMap<>();
        details.put("scope", scope.name());
        details.put("verdict", resolution.verdict().name());
        details.put("reasons", resolution.reasons().stream().map(Enum::name).sorted().toList());
        return new LiveException(unavailable ? 503 : 403, unavailable ? "RIGHTS_AUTHORITY_UNAVAILABLE" : "RIGHTS_NOT_ADMITTED",
                "the consent subject has no current " + scope + " admission; no session was opened", details);
    }

    /** Re-resolves consent when the last decision is older than the poll interval (cached across sessions with one subject). */
    private void refreshRights(Session session, long now, boolean wait) {
        if (session.state != State.OPEN || now - session.lastRightsCheckMs < config.revocationPollMillis()) return;
        Resolution resolution = resolve(session.tenantId, session.open.consentArtifactId(), session.open.consentVersionId(),
                session.consentSha256, session.open.scope(), Math.max(10, config.revocationPollMillis() / 2));
        if (wait) session.lock.lock();
        else if (!session.lock.tryLock()) return;
        try { observeRights(session, resolution); } finally { session.lock.unlock(); }
    }

    /** Must hold the session lock. A definite non-admission is terminal; an unreachable authority only refuses new frames. */
    private void observeRights(Session session, Resolution resolution) {
        session.lastRightsCheckMs = clock.millis();
        session.lastVerdict = resolution.verdict().name();
        if (resolution.admitted()) {
            session.attestationIds = resolution.attestationIds();
            return;
        }
        if (resolution.verdict() != Verdict.UNAVAILABLE && !session.state.terminal()) {
            terminate(session, State.REVOKED, "CONSENT_" + resolution.verdict().name(),
                    "consent is no longer admitted (" + resolution.verdict() + "); the session stopped and its media was destroyed, nothing was stored");
        }
    }

    // ---------------------------------------------------------------------------------------------- sweeping

    private void sweepQuietly() {
        try { sweep(); } catch (RuntimeException failure) { log.warn("live session sweep failed", failure); }
    }

    private void sweep() {
        long now = clock.millis();
        for (Session session : sessions.values()) {
            if (session.state.terminal()) continue;
            if (now > session.leaseExpiresAtMs) {
                if (session.lock.tryLock()) {
                    try {
                        if (!session.state.terminal() && now > session.leaseExpiresAtMs) {
                            terminate(session, State.EXPIRED, "LEASE_EXPIRED", "the session lease expired; received media was discarded");
                        }
                    } finally { session.lock.unlock(); }
                }
                continue;
            }
            if (session.state == State.OPEN && now - session.lastRightsCheckMs >= config.revocationPollMillis()
                    && session.rightsCheckRunning.compareAndSet(false, true)) {
                try {
                    rightsPool.execute(() -> {
                        try { refreshRights(session, clock.millis(), false); }
                        catch (RuntimeException failure) { log.warn("live session consent check failed session={}", session.id); }
                        finally { session.rightsCheckRunning.set(false); }
                    });
                } catch (RuntimeException rejected) {
                    session.rightsCheckRunning.set(false);
                }
            }
        }
    }

    // ---------------------------------------------------------------------------------------------- state

    private Session owned(String tenantId, String principalId, String sessionId) {
        Session session = sessions.get(sessionId);
        if (session == null || !session.tenantId.equals(tenantId) || !session.principalId.equals(principalId)) {
            throw new LiveException(404, "SESSION_NOT_FOUND", "no such live session is known to this launcher for this principal", Map.of());
        }
        return session;
    }

    private void lock(Session session) {
        try {
            if (!session.lock.tryLock(LOCK_WAIT_MILLIS, TimeUnit.MILLISECONDS)) {
                session.backpressure++;
                throw new LiveException(503, "BACKPRESSURE_SLOW_CONSUMER",
                        "the session storage did not accept the request in time; retry from ackedThroughSequence",
                        Map.of("retryAfterMillis", 250));
            }
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            throw new LiveException(503, "INTERRUPTED", "the request was interrupted", Map.of());
        }
    }

    /** Must hold the lock. Drops held frames, destroys the spool and records the typed terminal state. */
    private void terminate(Session session, State state, String code, String detail) {
        session.state = state;
        session.terminalCode = code;
        session.terminalDetail = detail;
        releasePending(session);
        closeSpool(session);
        deleteQuietly(session.spoolPath());
        try { persist(session); } catch (IOException failure) { log.warn("live session tombstone not written session={}", session.id); }
    }

    private void releasePending(Session session) {
        for (Frame frame : session.pending.values()) budget.release((int) Math.ceil(frame.payload.length / (double) BUDGET_UNIT));
        session.pending.clear();
        session.pendingBytes = 0;
    }

    private static void closeSpool(Session session) {
        if (session.spool != null) {
            try { session.spool.close(); } catch (IOException ignored) { /* closing */ }
            session.spool = null;
        }
    }

    private static void deleteQuietly(Path path) {
        try { Files.deleteIfExists(path); } catch (IOException ignored) { /* retried by pruning */ }
    }

    private Map<String, Object> view(Session s) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("schema", SCHEMA);
        out.put("scope", "DEV_ONLY");
        out.put("sessionId", s.id);
        out.put("state", s.state.name());
        out.put("terminalCode", s.terminalCode);
        out.put("terminalDetail", s.terminalDetail);
        out.put("ackedThroughSequence", s.nextExpected - 1);
        out.put("nextExpectedSequence", s.nextExpected);
        out.put("bufferedFrames", s.pending.size());
        List<Long> missing = new ArrayList<>();
        if (!s.pending.isEmpty()) {
            for (long seq = s.nextExpected; seq < s.pending.lastKey() && missing.size() < 32; seq++) {
                if (!s.pending.containsKey(seq)) missing.add(seq);
            }
        }
        out.put("missingSequences", missing);
        out.put("framesStored", s.nextExpected);
        out.put("bytesStored", s.bytesWritten);
        out.put("duplicateFrames", s.duplicates);
        out.put("reorderedFrames", s.reordered);
        out.put("refusedBeyondWindow", s.refusedWindow);
        out.put("backpressureRefusals", s.backpressure);
        out.put("finalSequence", s.finalSequence);
        out.put("recovered", s.recovered);
        out.put("recoveries", s.recoveries);
        out.put("leaseExpiresAt", Instant.ofEpochMilli(s.leaseExpiresAtMs).toString());
        out.put("leaseMillisRemaining", Math.max(0, s.leaseExpiresAtMs - clock.millis()));
        Map<String, Object> format = new LinkedHashMap<>();
        format.put("codec", "PCM_S16LE");
        format.put("sampleRate", s.open.sampleRate());
        format.put("channels", s.open.channels());
        format.put("samplesPerFrame", s.open.samplesPerFrame());
        format.put("frameBytes", s.open.frameBytes());
        format.put("startPtsSamples", s.open.startPts());
        format.put("reorderWindowFrames", s.open.window());
        format.put("leaseSeconds", s.open.leaseSeconds());
        out.put("format", format);
        Map<String, Object> consent = new LinkedHashMap<>();
        consent.put("artifactId", s.open.consentArtifactId());
        consent.put("artifactVersionId", s.open.consentVersionId());
        consent.put("scope", s.open.scope().name());
        consent.put("lastVerdict", s.lastVerdict);
        consent.put("lastCheckedAt", Instant.ofEpochMilli(s.lastRightsCheckMs).toString());
        consent.put("attestationIds", s.attestationIds);
        out.put("consent", consent);
        out.put("outputs", s.outputs);
        out.put("note", "DEV_ONLY live session; the acknowledged prefix is the contiguous written prefix. Terminal states are never reported as completed unless artifacts were registered");
        return out;
    }

    // ---------------------------------------------------------------------------------------------- persistence

    private void persistQuiet(Session session) {
        try { persist(session); } catch (IOException failure) { log.warn("live session manifest not written session={}", session.id); }
    }

    private void persistThrottled(Session session) {
        long now = clock.millis();
        if (session.state == State.OPEN && now - session.persistedLeaseMs < 1_000) return;
        try { persist(session); } catch (IOException failure) { log.warn("live session manifest not written session={}", session.id); }
    }

    private void persist(Session s) throws IOException {
        Map<String, Object> doc = new LinkedHashMap<>();
        doc.put("schema", SCHEMA);
        doc.put("sessionId", s.id);
        doc.put("tenantId", s.tenantId);
        doc.put("principalId", s.principalId);
        doc.put("fingerprint", s.fingerprint);
        doc.put("state", s.state.name());
        doc.put("terminalCode", s.terminalCode);
        doc.put("terminalDetail", s.terminalDetail);
        doc.put("createdAtMs", s.createdAtMs);
        doc.put("leaseExpiresAtMs", s.leaseExpiresAtMs);
        doc.put("finalSequence", s.finalSequence);
        doc.put("recoveries", s.recoveries);
        doc.put("duplicates", s.duplicates);
        doc.put("reordered", s.reordered);
        doc.put("framesStored", s.nextExpected);
        doc.put("bytesWritten", s.bytesWritten);
        doc.put("consentSha256", s.consentSha256);
        doc.put("attestationIds", s.attestationIds);
        doc.put("outputs", s.outputs);
        Open o = s.open;
        doc.put("open", Map.of("requestId", o.requestId(), "consentArtifactId", o.consentArtifactId(), "consentVersionId", o.consentVersionId(),
                "scope", o.scope().name(), "sampleRate", o.sampleRate(), "channels", o.channels(), "samplesPerFrame", o.samplesPerFrame(),
                "startPts", o.startPts(), "window", o.window(), "leaseSeconds", o.leaseSeconds()));
        Path tmp = s.directory.resolve("manifest.json.tmp");
        Files.write(tmp, JSON.writeValueAsBytes(doc));
        Files.move(tmp, s.manifestPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
        s.persistedLeaseMs = clock.millis();
    }

    @SuppressWarnings("unchecked")
    private void recover() {
        long now = clock.millis();
        try (Stream<Path> directories = Files.list(config.directory())) {
            for (Path directory : directories.filter(Files::isDirectory).toList()) {
                Path manifest = directory.resolve("manifest.json");
                if (!Files.isRegularFile(manifest)) { deleteTree(directory); continue; }
                try {
                    Map<String, Object> doc = JSON.readValue(Files.readString(manifest, StandardCharsets.UTF_8), new TypeReference<Map<String, Object>>() { });
                    Map<String, Object> o = (Map<String, Object>) doc.get("open");
                    Open open = new Open((String) o.get("requestId"), (String) o.get("consentArtifactId"), (String) o.get("consentVersionId"),
                            Scope.valueOf((String) o.get("scope")), ((Number) o.get("sampleRate")).intValue(), ((Number) o.get("channels")).intValue(),
                            ((Number) o.get("samplesPerFrame")).intValue(), ((Number) o.get("startPts")).longValue(), ((Number) o.get("window")).intValue(),
                            ((Number) o.get("leaseSeconds")).intValue());
                    Session s = new Session((String) doc.get("sessionId"), (String) doc.get("tenantId"), (String) doc.get("principalId"),
                            (String) doc.get("fingerprint"), open, (String) doc.get("consentSha256"), ((Number) doc.get("createdAtMs")).longValue(), directory);
                    s.state = State.valueOf((String) doc.get("state"));
                    s.terminalCode = (String) doc.get("terminalCode");
                    s.terminalDetail = (String) doc.get("terminalDetail");
                    s.leaseExpiresAtMs = ((Number) doc.get("leaseExpiresAtMs")).longValue();
                    s.finalSequence = ((Number) doc.get("finalSequence")).longValue();
                    s.recoveries = ((Number) doc.get("recoveries")).intValue();
                    s.duplicates = ((Number) doc.get("duplicates")).longValue();
                    s.reordered = ((Number) doc.get("reordered")).longValue();
                    s.attestationIds = (List<String>) doc.get("attestationIds");
                    s.outputs = (Map<String, Object>) doc.get("outputs");
                    s.lastRightsCheckMs = 0; // consent is re-resolved on first use after a restart
                    if (!s.state.terminal()) {
                        s.recovered = true;
                        s.recoveries++;
                        s.spool = FileChannel.open(s.spoolPath(), StandardOpenOption.CREATE, StandardOpenOption.WRITE, StandardOpenOption.READ);
                        scanSpool(s);
                        // A restart must not itself end a session the client can still resume: the lease restarts from now.
                        s.leaseExpiresAtMs = Math.min(now + open.leaseSeconds() * 1000L, s.createdAtMs + MAX_LIFETIME_MILLIS);
                        if (s.leaseExpiresAtMs <= now) terminate(s, State.EXPIRED, "LEASE_EXPIRED", "the session exceeded its maximum lifetime");
                        else persist(s);
                    }
                    sessions.put(s.id, s);
                } catch (IOException | RuntimeException unreadable) {
                    log.warn("DEV live session {} could not be recovered and was removed: {}", directory.getFileName(), unreadable.toString());
                    deleteTree(directory);
                }
            }
        } catch (IOException failure) {
            throw new IllegalStateException("the live session directory could not be scanned", failure);
        }
    }

    /** Rebuilds the acknowledged prefix from the spool and cuts a torn or corrupt tail. */
    private void scanSpool(Session s) throws IOException {
        ByteBuffer header = ByteBuffer.allocate(HEADER_BYTES).order(ByteOrder.BIG_ENDIAN);
        long position = 0;
        long size = s.spool.size();
        CRC32 digest = new CRC32();
        s.nextExpected = 0;
        s.bytesWritten = 0;
        while (position + HEADER_BYTES <= size) {
            header.clear();
            if (s.spool.read(header, position) < HEADER_BYTES) break;
            header.flip();
            long sequence = header.getLong();
            long pts = header.getLong();
            int length = header.getInt();
            int crc = header.getInt();
            if (sequence != s.nextExpected || length != s.open.frameBytes()
                    || pts != s.open.startPts() + sequence * s.open.samplesPerFrame() || position + HEADER_BYTES + length > size) break;
            ByteBuffer payload = ByteBuffer.allocate(length);
            if (s.spool.read(payload, position + HEADER_BYTES) < length) break;
            digest.reset();
            digest.update(payload.array());
            if ((int) digest.getValue() != crc) break;
            s.remember(sequence, crc);
            s.nextExpected = sequence + 1;
            s.bytesWritten += length;
            position += HEADER_BYTES + length;
        }
        if (position < size) s.spool.truncate(position);
        if (s.state == State.FINALIZING && s.nextExpected - 1 < s.finalSequence) {
            terminate(s, State.FAILED, "SPOOL_INCOMPLETE_AFTER_RESTART", "the stored frames are fewer than the declared final sequence; nothing was registered");
        }
    }

    private void prune() {
        List<Session> done = sessions.values().stream().filter(s -> s.state.terminal())
                .sorted(Comparator.comparingLong(s -> s.createdAtMs)).toList();
        for (int i = 0; i < done.size() - MAX_TOMBSTONES; i++) {
            Session old = done.get(i);
            sessions.remove(old.id);
            deleteTree(old.directory);
        }
    }

    private static void deleteTree(Path root) {
        try (Stream<Path> paths = Files.walk(root)) {
            paths.sorted(Comparator.reverseOrder()).forEach(path -> { try { Files.deleteIfExists(path); } catch (IOException ignored) { /* best effort */ } });
        } catch (IOException ignored) { /* best effort */ }
    }

    private static byte[] json(Object value) {
        return JSON.writeValueAsBytes(value);
    }

    private static int readFully(InputStream in, byte[] target, int offset, int length) throws IOException {
        int total = 0;
        while (total < length) {
            int n = in.read(target, offset + total, length - total);
            if (n < 0) break;
            total += n;
        }
        return total;
    }

}
