package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRuntimeContracts.Cancellation;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobLease;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifactStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaJobStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamSessionStore;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaStreamingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamAck;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamKind;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.StreamState;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.ConcurrentMap;

/**
 * Explicit local/test implementations; none are production eligible.
 *
 * @doc.type class
 * @doc.purpose Provide Local Media Runtime Support behavior
 * @doc.layer product
 * @doc.pattern Component
 */
public final class LocalMediaRuntimeSupport {
    private LocalMediaRuntimeSupport() { }

    public static final class FileArtifactStore implements MediaArtifactStore {
        private final Path root;
        private final ConcurrentMap<String, UploadSession> uploads = new ConcurrentHashMap<>();
        private final ConcurrentMap<String, Duration> retention = new ConcurrentHashMap<>();
        private final ConcurrentMap<String, MediaArtifact> artifacts = new ConcurrentHashMap<>();

        public FileArtifactStore(Path root) {
            try {
                this.root = root.toAbsolutePath().normalize();
                Files.createDirectories(this.root.resolve("uploads"));
                Files.createDirectories(this.root.resolve("artifacts"));
            } catch (IOException failure) {
                throw new IllegalStateException("Unable to initialize local media artifact store", failure);
            }
        }

        @Override public String storeId() { return "local-file-artifacts"; }

        @Override
        public UploadSession begin(UploadRequest request) {
            java.util.Objects.requireNonNull(request, "request");
            String uploadId = UUID.randomUUID().toString();
            Instant now = Instant.now();
            UploadSession session = new UploadSession(
                    uploadId, request.tenantId(), request.principalId(), safeName(request.fileName()), request.contentType(),
                    request.expectedSizeBytes(), request.expectedSha256(), request.classification(),
                    now, now.plusSeconds(3_600), 0L, 0, UploadStatus.OPEN, request.metadata());
            String key = key(request.tenantId(), uploadId);
            uploads.put(key, session);
            retention.put(key, request.retention());
            try { Files.createFile(uploadPath(uploadId)); }
            catch (IOException failure) {
                uploads.remove(key);
                retention.remove(key);
                throw unavailable("create upload", failure);
            }
            return session;
        }

        @Override
        public UploadSession append(String tenantId, String principalId, String uploadId, int chunkIndex, byte[] bytes) {
            if (bytes == null || bytes.length == 0) throw new IllegalArgumentException("chunk bytes are required");
            String key = key(tenantId, uploadId);
            synchronized (key.intern()) {
                UploadSession current = uploads.get(key);
                if (current == null || !current.principalId().equals(principalId)
                        || current.status() != UploadStatus.OPEN) {
                    throw new IllegalArgumentException("Open upload session not found");
                }
                if (!current.expiresAt().isAfter(Instant.now())) {
                    uploads.put(key, copy(current, current.bytesReceived(), current.nextChunkIndex(), UploadStatus.EXPIRED));
                    throw new IllegalStateException("Upload session expired");
                }
                if (chunkIndex != current.nextChunkIndex()) {
                    throw new IllegalArgumentException("Expected chunk index " + current.nextChunkIndex());
                }
                long total = current.bytesReceived() + bytes.length;
                if (total > current.expectedSizeBytes()) throw new IllegalArgumentException("Upload exceeds expected size");
                try { Files.write(uploadPath(uploadId), bytes, StandardOpenOption.APPEND); }
                catch (IOException failure) { throw unavailable("append upload chunk", failure); }
                UploadSession updated = copy(current, total, chunkIndex + 1, UploadStatus.OPEN);
                uploads.put(key, updated);
                return updated;
            }
        }

        @Override
        public MediaArtifact complete(String tenantId, String principalId, String uploadId) {
            String key = key(tenantId, uploadId);
            synchronized (key.intern()) {
                UploadSession current = uploads.get(key);
                if (current == null || !current.principalId().equals(principalId)
                        || current.status() != UploadStatus.OPEN) {
                    throw new IllegalArgumentException("Open upload session not found");
                }
                if (current.bytesReceived() != current.expectedSizeBytes()) {
                    throw new IllegalStateException("Upload size does not match expected size");
                }
                Path upload = uploadPath(uploadId);
                String digest = sha256(upload);
                if (!digest.equals(current.expectedSha256())) {
                    throw new IllegalStateException("Upload checksum does not match expected SHA-256");
                }
                String artifactId = UUID.randomUUID().toString();
                Path artifactPath = artifactPath(artifactId);
                try { Files.move(upload, artifactPath); }
                catch (IOException failure) { throw unavailable("finalize artifact", failure); }
                Duration requestedRetention = retention.getOrDefault(key, Duration.ofDays(1));
                MediaArtifact artifact = new MediaArtifact(
                        tenantId, current.principalId(), artifactId, current.fileName(), current.contentType(), current.bytesReceived(),
                        digest, artifactPath.toUri().toString(), current.classification(), Instant.now(),
                        Instant.now().plus(requestedRetention), current.metadata());
                artifacts.put(key(tenantId, artifactId), artifact);
                uploads.put(key, copy(current, current.bytesReceived(), current.nextChunkIndex(), UploadStatus.COMPLETED));
                retention.remove(key);
                return artifact;
            }
        }

        @Override public Optional<UploadSession> upload(String tenantId, String uploadId) {
            return Optional.ofNullable(uploads.get(key(tenantId, uploadId)));
        }
        @Override public Optional<MediaArtifact> artifact(String tenantId, String artifactId) {
            return Optional.ofNullable(artifacts.get(key(tenantId, artifactId)))
                    .filter(value -> value.expiresAt().isAfter(Instant.now()));
        }
        @Override public boolean durable() { return false; }
        @Override public boolean productionEligible() { return false; }
        @Override public boolean ready() {
            return writableDirectory(root)
                    && writableDirectory(root.resolve("uploads"))
                    && writableDirectory(root.resolve("artifacts"));
        }
        @Override public void close() { uploads.clear(); retention.clear(); artifacts.clear(); }

        private Path uploadPath(String id) { return safeResolve(root.resolve("uploads"), id + ".part"); }
        private Path artifactPath(String id) { return safeResolve(root.resolve("artifacts"), id + ".bin"); }
        private static Path safeResolve(Path directory, String file) {
            Path resolved = directory.resolve(file).normalize();
            if (!resolved.startsWith(directory)) throw new SecurityException("Invalid media storage path");
            return resolved;
        }
        private static String safeName(String value) {
            return Path.of(value).getFileName().toString().replaceAll("[\\r\\n]", "_");
        }
        private static UploadSession copy(UploadSession current, long bytes, int next, UploadStatus status) {
            return new UploadSession(current.uploadId(), current.tenantId(), current.principalId(), current.fileName(), current.contentType(),
                    current.expectedSizeBytes(), current.expectedSha256(), current.classification(), current.createdAt(),
                    current.expiresAt(), bytes, next, status, current.metadata());
        }
    }

    public static final class JobStore implements MediaJobStore {
        private final ConcurrentMap<String, ProcessingJob> jobs = new ConcurrentHashMap<>();
        private final ConcurrentMap<String, String> requests = new ConcurrentHashMap<>();
        private final ConcurrentMap<String, JobLease> leases = new ConcurrentHashMap<>();
        private final boolean clearStateOnClose;

        public JobStore() {
            this(true);
        }

        /**
         * Creates the local store with explicit close-state behavior for lifecycle tests.
         *
         * <p>The default clears the in-memory state. A restart test may retain the state to
         * model a durable store while still using the local implementation; it remains
         * non-durable and non-production-eligible.
         */
        JobStore(boolean clearStateOnClose) {
            this.clearStateOnClose = clearStateOnClose;
        }

        @Override public String storeId() { return "local-job-store"; }
        @Override public ProcessingJob create(ProcessingJob job) {
            String requestKey = key(job.tenantId(), job.requestId());
            // Publish the request index and job as one operation. Without this lock, a concurrent
            // idempotent replay can observe the index between putIfAbsent and jobs.put and fail
            // spuriously with "request index is inconsistent".
            synchronized (requestKey.intern()) {
                String existingJobId = requests.get(requestKey);
                if (existingJobId != null) {
                    ProcessingJob existing = jobs.get(key(job.tenantId(), existingJobId));
                    if (existing == null) throw new IllegalStateException("Media request index is inconsistent");
                    verifyRequestIdentity(existing, job);
                    return existing;
                }
                String jobKey = key(job.tenantId(), job.jobId());
                if (jobs.putIfAbsent(jobKey, job) != null) {
                    throw new IllegalStateException("Media job already exists");
                }
                requests.put(requestKey, job.jobId());
                return job;
            }
        }
        @Override public ProcessingJob update(ProcessingJob expected, ProcessingJob updated) {
            if (!expected.jobId().equals(updated.jobId()) || !expected.tenantId().equals(updated.tenantId())
                    || !expected.requestFingerprint().equals(updated.requestFingerprint())
                    || updated.version() != expected.version() + 1) {
                throw new IllegalArgumentException("Media job identity/version is invalid");
            }
            if (!jobs.replace(key(expected.tenantId(), expected.jobId()), expected, updated)) {
                throw new com.ghatana.media.runtime.MediaRuntimeContracts.MediaJobStoreConflictException(
                        "Media job version changed concurrently");
            }
            return updated;
        }
        @Override public ProcessingJob update(JobLease lease, ProcessingJob expected, ProcessingJob updated) {
            if (lease == null || !lease.tenantId().equals(expected.tenantId())
                    || !lease.jobId().equals(expected.jobId())) {
                throw new IllegalArgumentException("Media job lease identity is invalid");
            }
            String jobKey = key(expected.tenantId(), expected.jobId());
            synchronized (jobKey.intern()) {
                if (!leaseValid(lease)) throw new IllegalStateException("Media job lease fence is stale");
                return update(expected, updated);
            }
        }
        @Override public Optional<ProcessingJob> find(String tenantId, String jobId) {
            return Optional.ofNullable(jobs.get(key(tenantId, jobId)));
        }
        @Override public List<ProcessingJob> list(String tenantId, int limit) {
            return jobs.values().stream().filter(job -> job.tenantId().equals(tenantId))
                    .sorted(Comparator.comparing(ProcessingJob::createdAt).reversed())
                    .limit(Math.max(1, Math.min(limit, 1_000))).toList();
        }
        @Override public JobLease claim(ProcessingJob expected, String ownerId, Instant expiresAt) {
            String key = key(expected.tenantId(), expected.jobId());
            synchronized (key.intern()) {
                ProcessingJob current = jobs.get(key);
                if (current == null || current.version() != expected.version()
                        || current.status() == JobStatus.OUTCOME_UNKNOWN
                        || Set.of(JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED)
                        .contains(current.status())) {
                    throw new IllegalStateException("Media job cannot be leased from stale state");
                }
                JobLease previous = leases.get(key);
                if (previous != null && previous.expiresAt().isAfter(Instant.now())
                        && !previous.ownerId().equals(ownerId)) {
                    throw new IllegalStateException("Media job is leased by another worker");
                }
                JobLease lease = new JobLease(expected.tenantId(), expected.jobId(), ownerId,
                        previous == null ? 1L : previous.fencingToken() + 1L, expiresAt);
                leases.put(key, lease);
                return lease;
            }
        }
        @Override public boolean leaseValid(JobLease lease) {
            if (lease == null || !lease.equals(leases.get(key(lease.tenantId(), lease.jobId())))
                    || !lease.expiresAt().isAfter(Instant.now())) {
                return false;
            }
            ProcessingJob current = jobs.get(key(lease.tenantId(), lease.jobId()));
            return current != null && current.status() != JobStatus.OUTCOME_UNKNOWN
                    && !Set.of(JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED)
                    .contains(current.status());
        }
        @Override public void release(JobLease lease) {
            if (lease != null) {
                String jobKey = key(lease.tenantId(), lease.jobId());
                synchronized (jobKey.intern()) {
                    leases.remove(jobKey, lease);
                }
            }
        }
        @Override public List<ProcessingJob> recoverable(int limit) {
            return jobs.values().stream()
                    .filter(job -> job.status() == JobStatus.ACCEPTED || job.status() == JobStatus.RUNNING)
                    .sorted(Comparator.comparing(ProcessingJob::createdAt))
                    .limit(Math.max(1, Math.min(limit, 1_000)))
                    .toList();
        }
        @Override public boolean durable() { return false; }
        @Override public boolean productionEligible() { return false; }
        @Override public boolean ready() { return true; }
        @Override public void close() {
            if (clearStateOnClose) {
                jobs.clear();
                requests.clear();
                leases.clear();
            }
        }

        private static void verifyRequestIdentity(ProcessingJob existing, ProcessingJob requested) {
            if (existing.requestFingerprint().isBlank() || requested.requestFingerprint().isBlank()) {
                throw new IllegalStateException(
                        "Media request has no semantic fingerprint; replay safety cannot be established");
            }
            if (!existing.principalId().equals(requested.principalId())
                    || !existing.artifactId().equals(requested.artifactId())
                    || existing.jobType() != requested.jobType()
                    || !existing.requestFingerprint().equals(requested.requestFingerprint())) {
                throw new IllegalStateException("Media request ID was reused for a different job payload");
            }
        }
    }

    public static final class StreamStore implements MediaStreamSessionStore {
        private final ConcurrentMap<String, StoredStream> sessions = new ConcurrentHashMap<>();
        @Override public String storeId() { return "local-stream-store"; }
        @Override public StreamSession create(StreamSession session, String tokenHash) {
            if (sessions.putIfAbsent(key(session.tenantId(), session.sessionId()),
                    new StoredStream(session, tokenHash)) != null) {
                throw new IllegalStateException("Media stream session already exists");
            }
            return session;
        }
        @Override public Optional<StreamSession> find(String tenantId, String sessionId) {
            return Optional.ofNullable(sessions.get(key(tenantId, sessionId))).map(StoredStream::session);
        }
        @Override public StreamSession connect(StreamSession expected, String tokenHash, Instant leaseExpiresAt) {
            requireToken(expected, tokenHash);
            if (expected.state() != StreamState.OPEN
                    && expected.state() != StreamState.CONNECTED
                    && expected.state() != StreamState.DEGRADED) {
                throw new IllegalStateException("Media stream state cannot connect: " + expected.state());
            }
            if (leaseExpiresAt == null || !leaseExpiresAt.isAfter(Instant.now())) {
                throw new IllegalArgumentException("Media stream lease must expire in the future");
            }
            StreamSession updated = copy(expected, StreamState.CONNECTED, expected.lastSequence(),
                    expected.bufferedBytes(), expected.reconnectCount() + 1, leaseExpiresAt, expected.version() + 1);
            replace(expected, updated, tokenHash);
            return updated;
        }
        @Override public StreamSession recordFrame(StreamSession expected, long sequence, long buffered, boolean end) {
            if (expected.state() != StreamState.CONNECTED && expected.state() != StreamState.DEGRADED) {
                throw new IllegalStateException("Media stream must be connected before accepting frames");
            }
            if (expected.leaseExpiresAt() == null || !expected.leaseExpiresAt().isAfter(Instant.now())) {
                throw new IllegalStateException("Media stream lease is absent or expired");
            }
            if (sequence != expected.lastSequence() + 1) throw new IllegalArgumentException("Stream frame sequence is not contiguous");
            if (buffered < 0 || buffered > expected.maximumBufferedBytes()) {
                throw new IllegalStateException("Stream buffer limit exceeded");
            }
            StreamSession updated = copy(expected, end ? StreamState.DRAINING : expected.state(), sequence,
                    buffered, expected.reconnectCount(), expected.leaseExpiresAt(), expected.version() + 1);
            StoredStream current = sessions.get(key(expected.tenantId(), expected.sessionId()));
            replace(expected, updated, current == null ? "" : current.tokenHash());
            return updated;
        }
        @Override public StreamSession transition(StreamSession expected, StreamState target) {
            if (!allowed(expected.state(), target)) {
                throw new IllegalStateException(
                        "Invalid Media stream transition " + expected.state() + " -> " + target);
            }
            StreamSession updated = copy(expected, target, expected.lastSequence(), expected.bufferedBytes(),
                    expected.reconnectCount(), expected.leaseExpiresAt(), expected.version() + 1);
            StoredStream current = sessions.get(key(expected.tenantId(), expected.sessionId()));
            replace(expected, updated, current == null ? "" : current.tokenHash());
            return updated;
        }
        @Override public boolean tokenMatches(String tenantId, String sessionId, String tokenHash) {
            StoredStream value = sessions.get(key(tenantId, sessionId));
            if (tokenHash == null || tokenHash.isBlank()) return false;
            return value != null && MessageDigest.isEqual(
                    value.tokenHash().getBytes(java.nio.charset.StandardCharsets.UTF_8),
                    tokenHash.getBytes(java.nio.charset.StandardCharsets.UTF_8));
        }
        @Override public boolean durable() { return false; }
        @Override public boolean productionEligible() { return false; }
        @Override public boolean ready() { return true; }
        @Override public void close() { sessions.clear(); }

        private void requireToken(StreamSession session, String tokenHash) {
            if (!tokenMatches(session.tenantId(), session.sessionId(), tokenHash)) {
                throw new SecurityException("Invalid media stream connection token");
            }
        }
        private void replace(StreamSession expected, StreamSession updated, String tokenHash) {
            if (!sessions.replace(key(expected.tenantId(), expected.sessionId()),
                    new StoredStream(expected, tokenHash), new StoredStream(updated, tokenHash))) {
                throw new IllegalStateException("Media stream session version changed concurrently");
            }
        }
        private static StreamSession copy(StreamSession value, StreamState state, long sequence, long buffered,
                                           int reconnects, Instant lease, long version) {
            Instant now = Instant.now();
            return new StreamSession(value.tenantId(), value.sessionId(), value.principalId(), value.streamKind(),
                    value.providerId(), state, sequence, buffered, value.maximumBufferedBytes(), reconnects,
                    lease, value.createdAt(), now,
                    state == StreamState.CLOSED || state == StreamState.FAILED ? now : value.closedAt(),
                    value.metadata(), version);
        }
        private static boolean allowed(StreamState from, StreamState to) {
            return switch (from) {
                case OPEN -> to == StreamState.CONNECTED || to == StreamState.CLOSED || to == StreamState.FAILED;
                case CONNECTED -> to == StreamState.DEGRADED || to == StreamState.DRAINING
                        || to == StreamState.CLOSED || to == StreamState.FAILED;
                case DEGRADED -> to == StreamState.CONNECTED || to == StreamState.DRAINING
                        || to == StreamState.CLOSED || to == StreamState.FAILED;
                case DRAINING -> to == StreamState.CLOSED || to == StreamState.FAILED;
                case CLOSED, FAILED -> false;
            };
        }
        private record StoredStream(StreamSession session, String tokenHash) { }
    }

    public static final class DiagnosticProcessor implements MediaProcessingProvider {
        @Override public String providerId() { return "local-diagnostic"; }
        @Override public String providerVersion() { return "local-diagnostic-v1"; }
        @Override public String modelVersion(JobType modality) { return "deterministic-diagnostic-v1"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.values()); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return Integer.MAX_VALUE; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            context.cancellation().throwIfCancelled();
            return CompletableFuture.completedFuture(Map.of(
                    "diagnostic", true,
                    "jobType", context.request().jobType().name(),
                    "artifactId", context.artifact().artifactId(),
                    "sizeBytes", context.artifact().sizeBytes(),
                    "sha256", context.artifact().sha256(),
                    "contentType", context.artifact().contentType(),
                    "rawMediaRead", false));
        }
    }

    public static final class DiagnosticStreamingProvider implements MediaStreamingProvider {
        @Override public String providerId() { return "local-stream-diagnostic"; }
        @Override public Set<StreamKind> capabilities() { return Set.of(StreamKind.values()); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return Integer.MAX_VALUE; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public String processingRegion() { return "local"; }
        @Override public CompletableFuture<StreamAck> accept(
                StreamContext context,
                com.ghatana.media.runtime.MediaRuntimeContracts.StreamFrame frame) {
            context.cancellation().throwIfCancelled();
            return CompletableFuture.completedFuture(new StreamAck(
                    frame.sequence(), context.session().bufferedBytes() + frame.payload().length, false));
        }
    }

    private static String key(String tenantId, String id) {
        if (tenantId == null || tenantId.isBlank() || id == null || id.isBlank()) {
            throw new IllegalArgumentException("tenantId and id are required");
        }
        return tenantId.length() + ":" + tenantId + ':' + id.length() + ':' + id;
    }

    private static String sha256(Path path) {
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            try (var input = Files.newInputStream(path)) {
                byte[] buffer = new byte[64 * 1024];
                int read;
                while ((read = input.read(buffer)) >= 0) digest.update(buffer, 0, read);
            }
            return HexFormat.of().formatHex(digest.digest());
        } catch (Exception failure) {
            throw new IllegalStateException("Unable to calculate media SHA-256", failure);
        }
    }

    private static IllegalStateException unavailable(String operation, IOException failure) {
        return new IllegalStateException("Unable to " + operation, failure);
    }

    private static boolean writableDirectory(Path path) {
        return Files.isDirectory(path) && Files.isWritable(path);
    }
}
