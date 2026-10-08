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
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadBeginResult;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadCompletionResult;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadSession;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadStatus;
import com.ghatana.media.runtime.MediaUploadRequestFingerprint;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.StandardCopyOption;
import java.nio.file.AtomicMoveNotSupportedException;
import java.security.MessageDigest;
import java.time.Duration;
import java.time.Instant;
import java.util.Comparator;
import java.util.ArrayList;
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
        @FunctionalInterface
        interface ManifestReplaceHook {
            void beforeReplace(Path manifest) throws IOException;
        }

        private final Path root;
        private final Path metadataRoot;
        private final ObjectMapper manifestMapper =
                JsonMapper.builder().addModules(tools.jackson.databind.cfg.MapperBuilder.findModules()).build();
        private final ConcurrentMap<String, UploadSession> uploads = new ConcurrentHashMap<>();
        private final ConcurrentMap<String, Duration> retention = new ConcurrentHashMap<>();
        private final ConcurrentMap<String, MediaArtifact> artifacts = new ConcurrentHashMap<>();
        private final ConcurrentMap<String, String> completedArtifactByUpload = new ConcurrentHashMap<>();
        private final ConcurrentMap<String, UploadIdempotency> idempotency = new ConcurrentHashMap<>();
        private final ConcurrentMap<String, LocalUploadManifest> manifests = new ConcurrentHashMap<>();
        private final Object beginLock = new Object();
        private final ManifestReplaceHook replaceHook;
        private final java.util.concurrent.atomic.AtomicBoolean failedClosed = new java.util.concurrent.atomic.AtomicBoolean();
        private final java.util.concurrent.atomic.AtomicBoolean closed = new java.util.concurrent.atomic.AtomicBoolean();

        public FileArtifactStore(Path root) {
            this(root, manifest -> { });
        }

        FileArtifactStore(Path root, ManifestReplaceHook replaceHook) {
            try {
                this.root = root.toAbsolutePath().normalize();
                this.replaceHook = java.util.Objects.requireNonNull(replaceHook, "replaceHook");
                Files.createDirectories(this.root.resolve("uploads"));
                Files.createDirectories(this.root.resolve("artifacts"));
                this.metadataRoot = this.root.resolve("metadata");
                Files.createDirectories(metadataRoot);
                for (Path directory : List.of(this.root, this.root.resolve("uploads"),
                        this.root.resolve("artifacts"), metadataRoot)) {
                    if (Files.isSymbolicLink(directory)
                            || !Files.isDirectory(directory, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                        throw new IllegalStateException("Local Media storage paths must be confined regular directories");
                    }
                }
                if (Files.isSymbolicLink(this.root) || Files.isSymbolicLink(metadataRoot)
                        || !Files.isDirectory(metadataRoot, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                    throw new IllegalStateException("Local Media metadata path must be a confined regular directory");
                }
                recoverManifests();
            } catch (IOException failure) {
                throw new IllegalStateException("Unable to initialize local media artifact store", failure);
            }
        }

        @Override public String storeId() { return "local-file-artifacts"; }

        @Override
        public UploadSession begin(UploadRequest request, String idempotencyKey) {
            return beginWithDisposition(request, idempotencyKey).session();
        }

        @Override
        public UploadBeginResult beginWithDisposition(UploadRequest request, String idempotencyKey) {
            ensureActive();
            java.util.Objects.requireNonNull(request, "request");
            requireIdempotencyKey(idempotencyKey);
            String fingerprint = MediaUploadRequestFingerprint.compute(request);
            String replayKey = idempotencyKey(request.tenantId(), request.principalId(), idempotencyKey);
            synchronized (beginLock) {
                UploadIdempotency existing = idempotency.get(replayKey);
                if (existing != null) {
                    if (existing.fingerprint() == null || !existing.fingerprint().equals(fingerprint)) {
                        throw new IllegalArgumentException("Idempotency-Key was already used with a different upload request");
                    }
                    UploadSession session = uploads.get(key(request.tenantId(), existing.uploadId()));
                    if (session == null) throw new IllegalStateException("Media upload idempotency index is inconsistent");
                    if (session.status() == UploadStatus.OPEN) {
                        Path source = uploadPath(session.uploadId());
                        validateUploadFile(source);
                        if (!Files.exists(source, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                            throw new IllegalStateException("Idempotent Media upload is missing its source bytes");
                        }
                    }
                    if (session.status() == UploadStatus.COMPLETED) {
                        String artifactId = completedArtifactByUpload.get(key(request.tenantId(), session.uploadId()));
                        if (artifactId == null || !artifacts.containsKey(key(request.tenantId(), artifactId))) {
                            throw new IllegalStateException("Completed Media upload is missing its stored artifact");
                        }
                    }
                    return new UploadBeginResult(session, false);
                }
                String uploadId = UUID.randomUUID().toString();
                Instant now = Instant.ofEpochMilli(System.currentTimeMillis());
                UploadSession session = new UploadSession(
                        uploadId, request.tenantId(), request.principalId(), safeName(request.fileName()), request.contentType(),
                        request.expectedSizeBytes(), request.expectedSha256(), request.classification(),
                        now, now.plusSeconds(3_600), 0L, 0, UploadStatus.OPEN, request.metadata());
                String uploadKey = key(request.tenantId(), uploadId);
                LocalUploadManifest manifest = manifest(request, idempotencyKey, fingerprint, session,
                        request.retention(), null, null, null);
                saveManifest(manifest);
                try { Files.createFile(uploadPath(uploadId)); }
                catch (IOException failure) {
                    failedClosed.set(true);
                    throw unavailable("create upload", failure);
                }
                uploads.put(uploadKey, session);
                retention.put(uploadKey, request.retention());
                manifests.put(uploadKey, manifest);
                idempotency.put(replayKey, new UploadIdempotency(uploadId, fingerprint));
                return new UploadBeginResult(session, true);
            }
        }

        @Override
        public UploadSession append(String tenantId, String principalId, String uploadId, int chunkIndex, byte[] bytes) {
            ensureActive();
            if (chunkIndex < 0) throw new IllegalArgumentException("chunkIndex must not be negative");
            if (bytes == null || bytes.length == 0) throw new IllegalArgumentException("chunk bytes are required");
            String key = key(tenantId, uploadId);
            synchronized (key.intern()) {
                UploadSession current = uploads.get(key);
                if (current == null || !current.principalId().equals(principalId)
                        || current.status() != UploadStatus.OPEN) {
                    throw new IllegalArgumentException("Open upload session not found");
                }
                if (!current.expiresAt().isAfter(Instant.now())) {
                    UploadSession expired = copy(current, current.bytesReceived(), current.nextChunkIndex(), UploadStatus.EXPIRED);
                    LocalUploadManifest manifest = withSession(manifests.get(key), expired);
                    saveManifest(manifest);
                    manifests.put(key, manifest);
                    uploads.put(key, expired);
                    throw new IllegalStateException("Upload session expired");
                }
                LocalUploadManifest currentManifest = manifests.get(key);
                if (currentManifest == null || currentManifest.chunkReceipts() == null) {
                    throw new IllegalStateException("Upload chunk receipts are missing; retry is unsafe");
                }
                String chunkDigest = sha256(bytes);
                if (chunkIndex < current.nextChunkIndex()) {
                    if (chunkIndex >= currentManifest.chunkReceipts().size()) {
                        throw new IllegalStateException("Upload chunk receipt index is inconsistent");
                    }
                    ChunkReceipt receipt = currentManifest.chunkReceipts().get(chunkIndex);
                    if (receipt.chunkIndex() != chunkIndex || receipt.length() != bytes.length
                            || !receipt.sha256().equals(chunkDigest)) {
                        throw new IllegalStateException("Upload chunk index already exists with different content");
                    }
                    Path source = uploadPath(uploadId);
                    if (!matchesChunkReceipt(source, receipt)) {
                        failedClosed.set(true);
                        throw new IllegalStateException("Stored upload chunk does not match its persisted receipt");
                    }
                    return current;
                }
                if (chunkIndex != current.nextChunkIndex()) {
                    throw new IllegalArgumentException("Expected chunk index " + current.nextChunkIndex());
                }
                long total = current.bytesReceived() + bytes.length;
                if (total > current.expectedSizeBytes()) throw new IllegalArgumentException("Upload exceeds expected size");
                try {
                    Path source = uploadPath(uploadId);
                    validateRegularFileIfPresent(source);
                    if (!Files.exists(source, java.nio.file.LinkOption.NOFOLLOW_LINKS)
                            || Files.size(source) != current.bytesReceived()) {
                        throw new IllegalStateException("Upload bytes and persisted chunk progress disagree; retry is unsafe");
                    }
                } catch (IOException failure) {
                    throw unavailable("inspect upload progress", failure);
                } catch (IllegalStateException failure) {
                    if (failure.getMessage() != null && failure.getMessage().contains("non-symlink")) {
                        failedClosed.set(true);
                    }
                    throw failure;
                }
                try {
                    Path source = uploadPath(uploadId);
                    validateRegularFileIfPresent(source);
                    Files.write(source, bytes, StandardOpenOption.APPEND);
                }
                catch (IOException failure) {
                    failedClosed.set(true);
                    throw unavailable("append upload chunk", failure);
                } catch (IllegalStateException failure) {
                    failedClosed.set(true);
                    throw failure;
                }
                UploadSession updated = copy(current, total, chunkIndex + 1, UploadStatus.OPEN);
                List<ChunkReceipt> receipts = new ArrayList<>(currentManifest.chunkReceipts());
                receipts.add(new ChunkReceipt(chunkIndex, current.bytesReceived(), bytes.length, chunkDigest));
                LocalUploadManifest manifest = withSession(currentManifest, updated, receipts);
                try {
                    saveManifest(manifest);
                } catch (RuntimeException failure) {
                    failedClosed.set(true);
                    throw failure;
                }
                manifests.put(key, manifest);
                uploads.put(key, updated);
                return updated;
            }
        }

        @Override
        public MediaArtifact complete(String tenantId, String principalId, String uploadId) {
            return completeWithDisposition(tenantId, principalId, uploadId).artifact();
        }

        @Override
        public UploadCompletionResult completeWithDisposition(String tenantId, String principalId, String uploadId) {
            ensureActive();
            String key = key(tenantId, uploadId);
            synchronized (key.intern()) {
                UploadSession current = uploads.get(key);
                if (current == null || !current.principalId().equals(principalId)) {
                    throw new IllegalArgumentException("Open upload session not found");
                }
                if (current.status() == UploadStatus.COMPLETED) {
                    String artifactId = completedArtifactByUpload.get(key);
                    MediaArtifact existing = artifactId == null ? null : artifacts.get(key(tenantId, artifactId));
                    if (existing != null) return new UploadCompletionResult(existing, false);
                    throw new IllegalStateException("Completed upload is missing its stored artifact");
                }
                if (current.status() == UploadStatus.FINALIZING) {
                    LocalUploadManifest pending = manifests.get(key);
                    if (pending == null) throw new IllegalStateException("Finalizing upload is missing its persisted manifest");
                    return new UploadCompletionResult(finishLocalFinalization(key, pending), false);
                }
                if (current.status() != UploadStatus.OPEN) throw new IllegalArgumentException("Open upload session not found");
                if (!current.expiresAt().isAfter(Instant.now())) {
                    UploadSession expired = copy(current, current.bytesReceived(), current.nextChunkIndex(),
                            UploadStatus.EXPIRED);
                    LocalUploadManifest expiredManifest = withSession(manifests.get(key), expired);
                    saveManifest(expiredManifest);
                    manifests.put(key, expiredManifest);
                    uploads.put(key, expired);
                    throw new IllegalStateException("Upload session expired");
                }
                if (current.bytesReceived() != current.expectedSizeBytes()) {
                    throw new IllegalStateException("Upload size does not match expected size");
                }
                Path upload = uploadPath(uploadId);
                validateUploadFile(upload);
                String digest = sha256(upload);
                if (!digest.equals(current.expectedSha256())) {
                    throw new IllegalStateException("Upload checksum does not match expected SHA-256");
                }
                long createdAt = Instant.now().toEpochMilli();
                Duration requestedRetention = retention.getOrDefault(key, Duration.ofDays(1));
                long expiresAt = Instant.ofEpochMilli(createdAt).plus(requestedRetention).toEpochMilli();
                LocalUploadManifest pending = withFinalization(manifests.get(key), UUID.randomUUID().toString(),
                        createdAt, expiresAt);
                saveManifest(pending);
                manifests.put(key, pending);
                UploadSession finalizing = copy(current, current.bytesReceived(), current.nextChunkIndex(), UploadStatus.FINALIZING);
                uploads.put(key, finalizing);
                return new UploadCompletionResult(finishLocalFinalization(key, pending), true);
            }
        }

        @Override public Optional<UploadSession> upload(String tenantId, String uploadId) {
            ensureActive();
            return Optional.ofNullable(uploads.get(key(tenantId, uploadId)));
        }
        @Override public Optional<MediaArtifact> artifact(String tenantId, String artifactId) {
            ensureActive();
            return Optional.ofNullable(artifacts.get(key(tenantId, artifactId)))
                    .filter(value -> value.expiresAt().isAfter(Instant.now()));
        }
        @Override public boolean durable() { return false; }
        @Override public boolean productionEligible() { return false; }
        @Override public boolean ready() {
            return !closed.get() && !failedClosed.get() && writableDirectory(root)
                    && writableDirectory(root.resolve("uploads"))
                    && writableDirectory(root.resolve("artifacts"))
                    && writableDirectory(metadataRoot);
        }
        @Override public void close() {
            if (!closed.compareAndSet(false, true)) return;
            uploads.clear(); retention.clear(); artifacts.clear(); completedArtifactByUpload.clear(); idempotency.clear();
            manifests.clear();
        }

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

        private void ensureActive() {
            if (closed.get()) throw new IllegalStateException("Local Media artifact store is closed");
            if (failedClosed.get()) throw new IllegalStateException("Local Media artifact store failed closed after an uncertain metadata write");
            for (Path directory : List.of(root, root.resolve("uploads"), root.resolve("artifacts"), metadataRoot)) {
                if (Files.isSymbolicLink(directory)
                        || !Files.isDirectory(directory, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                    failedClosed.set(true);
                    throw new IllegalStateException("Local Media storage path escaped its confined directory");
                }
            }
        }

        private void validateUploadFile(Path path) {
            try {
                validateRegularFileIfPresent(path);
            } catch (IllegalStateException failure) {
                failedClosed.set(true);
                throw failure;
            }
        }

        private LocalUploadManifest manifest(
                UploadRequest request, String idempotencyKey, String fingerprint, UploadSession session,
                Duration requestedRetention, String artifactId, Long artifactCreatedAt, Long artifactExpiresAt) {
            return new LocalUploadManifest(2, session.tenantId(), session.principalId(), session.uploadId(),
                    request.fileName(), session.fileName(), session.contentType(), session.expectedSizeBytes(),
                    session.expectedSha256(), session.classification(), requestedRetention.getSeconds(),
                    requestedRetention.getNano(), session.createdAt().toEpochMilli(), session.expiresAt().toEpochMilli(),
                    session.bytesReceived(), session.nextChunkIndex(), List.of(), session.status().name(), session.metadata(),
                    idempotencyKey, fingerprint, artifactId, artifactCreatedAt, artifactExpiresAt);
        }

        private LocalUploadManifest withSession(LocalUploadManifest manifest, UploadSession session) {
            return withSession(manifest, session, manifest == null ? null : manifest.chunkReceipts());
        }

        private LocalUploadManifest withSession(
                LocalUploadManifest manifest, UploadSession session, List<ChunkReceipt> chunkReceipts) {
            if (manifest == null) throw new IllegalStateException("Local Media upload is missing its persisted manifest");
            return new LocalUploadManifest(manifest.manifestVersion(), manifest.tenantId(), manifest.principalId(),
                    manifest.uploadId(), manifest.requestFileName(), manifest.fileName(), manifest.contentType(),
                    manifest.expectedSizeBytes(), manifest.expectedSha256(), manifest.classification(),
                    manifest.retentionSeconds(), manifest.retentionNanos(), manifest.createdAt(), manifest.expiresAt(),
                    session.bytesReceived(), session.nextChunkIndex(), chunkReceipts, session.status().name(), manifest.metadata(),
                    manifest.idempotencyKey(), manifest.requestFingerprint(), manifest.artifactId(),
                    manifest.artifactCreatedAt(), manifest.artifactExpiresAt());
        }

        private LocalUploadManifest withFinalization(LocalUploadManifest manifest, String artifactId,
                long artifactCreatedAt, long artifactExpiresAt) {
            if (manifest == null) throw new IllegalStateException("Local Media upload is missing its persisted manifest");
            return new LocalUploadManifest(manifest.manifestVersion(), manifest.tenantId(), manifest.principalId(),
                    manifest.uploadId(), manifest.requestFileName(), manifest.fileName(), manifest.contentType(),
                    manifest.expectedSizeBytes(), manifest.expectedSha256(), manifest.classification(),
                    manifest.retentionSeconds(), manifest.retentionNanos(), manifest.createdAt(), manifest.expiresAt(),
                    manifest.bytesReceived(), manifest.nextChunkIndex(), manifest.chunkReceipts(), UploadStatus.FINALIZING.name(),
                    manifest.metadata(), manifest.idempotencyKey(), manifest.requestFingerprint(), artifactId,
                    artifactCreatedAt, artifactExpiresAt);
        }

        private LocalUploadManifest asCompleted(LocalUploadManifest manifest) {
            return new LocalUploadManifest(manifest.manifestVersion(), manifest.tenantId(), manifest.principalId(),
                    manifest.uploadId(), manifest.requestFileName(), manifest.fileName(), manifest.contentType(),
                    manifest.expectedSizeBytes(), manifest.expectedSha256(), manifest.classification(),
                    manifest.retentionSeconds(), manifest.retentionNanos(), manifest.createdAt(), manifest.expiresAt(),
                    manifest.bytesReceived(), manifest.nextChunkIndex(), manifest.chunkReceipts(), UploadStatus.COMPLETED.name(),
                    manifest.metadata(), manifest.idempotencyKey(), manifest.requestFingerprint(), manifest.artifactId(),
                    manifest.artifactCreatedAt(), manifest.artifactExpiresAt());
        }

        private MediaArtifact finishLocalFinalization(String uploadKey, LocalUploadManifest pending) {
            if (pending.artifactId() == null || pending.artifactCreatedAt() == null
                    || pending.artifactExpiresAt() == null) {
                throw new IllegalStateException("Finalizing Media upload has incomplete persisted artifact identity");
            }
            Path source = uploadPath(checkedUuid(pending.uploadId()));
            Path destination = artifactPath(checkedUuid(pending.artifactId()));
            validateRegularFileIfPresent(source);
            validateRegularFileIfPresent(destination);
            boolean sourceExists = Files.exists(source, java.nio.file.LinkOption.NOFOLLOW_LINKS);
            boolean destinationExists = Files.exists(destination, java.nio.file.LinkOption.NOFOLLOW_LINKS);
            if (sourceExists == destinationExists) {
                throw new IllegalStateException("Finalizing Media upload has ambiguous source/destination bytes");
            }
            Path bytes = sourceExists ? source : destination;
            validateBytes(bytes, pending.expectedSizeBytes(), pending.expectedSha256());
            validateChunkReceipts(bytes, pending);
            if (sourceExists) {
                try {
                    Files.move(source, destination, StandardCopyOption.ATOMIC_MOVE);
                } catch (AtomicMoveNotSupportedException unsupported) {
                    failedClosed.set(true);
                    throw new IllegalStateException("Atomic local artifact finalization is not supported", unsupported);
                } catch (IOException failure) {
                    failedClosed.set(true);
                    throw unavailable("finalize artifact", failure);
                }
            }
            MediaArtifact artifact = new MediaArtifact(
                    pending.tenantId(), pending.principalId(), pending.artifactId(), pending.fileName(),
                    pending.contentType(), pending.expectedSizeBytes(), pending.expectedSha256(),
                    destination.toUri().toString(), pending.classification(),
                    Instant.ofEpochMilli(pending.artifactCreatedAt()), Instant.ofEpochMilli(pending.artifactExpiresAt()),
                    pending.metadata());
            LocalUploadManifest completed = asCompleted(pending);
            saveManifest(completed);
            manifests.put(uploadKey, completed);
            uploads.put(uploadKey, completed.session());
            retention.remove(uploadKey);
            artifacts.put(key(pending.tenantId(), pending.artifactId()), artifact);
            completedArtifactByUpload.put(uploadKey, pending.artifactId());
            return artifact;
        }

        private void recoverManifests() throws IOException {
            try (var paths = Files.list(metadataRoot)) {
                for (Path path : paths.filter(item -> item.getFileName().toString().endsWith(".json")).toList()) {
                    if (Files.isSymbolicLink(path) || !Files.isRegularFile(path, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                        throw new IllegalStateException("Local Media upload manifest must be a regular non-symlink file");
                    }
                    LocalUploadManifest manifest = manifestMapper.readValue(path.toFile(), LocalUploadManifest.class);
                    validateManifest(manifest, path);
                }
            }
        }

        private void validateManifest(LocalUploadManifest manifest, Path path) {
            if (manifest.manifestVersion() != 2) throw new IllegalStateException("Unsupported local Media manifest version");
            String uploadId = checkedUuid(manifest.uploadId());
            if (!path.equals(manifestPath(uploadId))) throw new IllegalStateException("Local Media manifest identity/path mismatch");
            requireManifestText(manifest.tenantId(), "tenantId");
            requireManifestText(manifest.principalId(), "principalId");
            requireManifestText(manifest.requestFileName(), "requestFileName");
            requireManifestText(manifest.idempotencyKey(), "idempotencyKey");
            requireManifestText(manifest.requestFingerprint(), "requestFingerprint");
            Duration duration = Duration.ofSeconds(manifest.retentionSeconds(), manifest.retentionNanos());
            UploadRequest request = new UploadRequest(manifest.tenantId(), manifest.principalId(),
                    manifest.requestFileName(), manifest.contentType(), manifest.expectedSizeBytes(),
                    manifest.expectedSha256(), manifest.classification(), duration, manifest.metadata());
            if (!MediaUploadRequestFingerprint.compute(request).equals(manifest.requestFingerprint())) {
                throw new IllegalStateException("Local Media upload manifest request fingerprint is invalid");
            }
            String replayKey = idempotencyKey(manifest.tenantId(), manifest.principalId(), manifest.idempotencyKey());
            UploadIdempotency old = idempotency.putIfAbsent(
                    replayKey, new UploadIdempotency(uploadId, manifest.requestFingerprint()));
            if (old != null) throw new IllegalStateException("Duplicate local Media upload idempotency manifest");
            UploadSession session = manifest.session();
            String uploadKey = key(manifest.tenantId(), uploadId);
            UploadStatus status = session.status();
            if (status == UploadStatus.OPEN) {
                Path source = uploadPath(uploadId);
                validateRegularFileIfPresent(source);
                if (!Files.exists(source, java.nio.file.LinkOption.NOFOLLOW_LINKS)
                        || size(source) != manifest.bytesReceived()) {
                    throw new IllegalStateException("Local Media upload bytes and manifest progress disagree");
                }
                validateChunkReceipts(source, manifest);
            } else if (status == UploadStatus.FINALIZING) {
                LocalUploadManifest completed = recoverFinalizingManifest(uploadKey, manifest);
                session = completed.session();
                manifest = completed;
            } else if (status == UploadStatus.COMPLETED) {
                validateCompleted(manifest);
                Path artifactPath = artifactPath(checkedUuid(manifest.artifactId()));
                validateChunkReceipts(artifactPath, manifest);
                artifacts.put(key(manifest.tenantId(), manifest.artifactId()), artifact(manifest, artifactPath));
                completedArtifactByUpload.put(uploadKey, manifest.artifactId());
            }
            uploads.put(uploadKey, session);
            retention.put(uploadKey, duration);
            manifests.put(uploadKey, manifest);
        }

        private static void validateChunkReceipts(Path path, LocalUploadManifest manifest) {
            List<ChunkReceipt> receipts = manifest.chunkReceipts();
            if (receipts == null || receipts.size() != manifest.nextChunkIndex()) {
                throw new IllegalStateException("Local Media chunk receipt count does not match upload progress");
            }
            long offset = 0L;
            for (int index = 0; index < receipts.size(); index++) {
                ChunkReceipt receipt = receipts.get(index);
                if (receipt == null || receipt.chunkIndex() != index || receipt.offset() != offset
                        || receipt.length() < 1 || receipt.sha256() == null
                        || !receipt.sha256().matches("[0-9a-f]{64}")
                        || !matchesChunkReceipt(path, receipt)) {
                    throw new IllegalStateException("Local Media chunk receipt chain is invalid");
                }
                offset = Math.addExact(offset, receipt.length());
            }
            if (offset != manifest.bytesReceived() || size(path) != manifest.bytesReceived()) {
                throw new IllegalStateException("Local Media chunk receipts disagree with stored byte progress");
            }
        }

        private static boolean matchesChunkReceipt(Path path, ChunkReceipt receipt) {
            validateRegularFileIfPresent(path);
            if (!Files.exists(path, java.nio.file.LinkOption.NOFOLLOW_LINKS)) return false;
            try (var file = new java.io.RandomAccessFile(path.toFile(), "r")) {
                if (receipt.offset() < 0 || receipt.length() < 1
                        || receipt.offset() + receipt.length() > file.length()) return false;
                byte[] bytes = new byte[receipt.length()];
                file.seek(receipt.offset());
                file.readFully(bytes);
                return sha256(bytes).equals(receipt.sha256());
            } catch (IOException failure) {
                throw unavailable("verify local Media chunk receipt", failure);
            }
        }

        private LocalUploadManifest recoverFinalizingManifest(String uploadKey, LocalUploadManifest pending) {
            LocalUploadManifest completed = asCompleted(pending);
            finishLocalFinalization(uploadKey, pending);
            return completed;
        }

        private void validateCompleted(LocalUploadManifest manifest) {
            if (manifest.artifactId() == null || manifest.artifactCreatedAt() == null
                    || manifest.artifactExpiresAt() == null) {
                throw new IllegalStateException("Completed local Media upload has no persisted artifact identity");
            }
            Path artifact = artifactPath(checkedUuid(manifest.artifactId()));
            validateRegularFileIfPresent(artifact);
            if (!Files.exists(artifact, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                throw new IllegalStateException("Completed local Media artifact bytes are missing");
            }
            validateBytes(artifact, manifest.expectedSizeBytes(), manifest.expectedSha256());
        }

        private MediaArtifact artifact(LocalUploadManifest manifest, Path artifactPath) {
            return new MediaArtifact(manifest.tenantId(), manifest.principalId(), manifest.artifactId(),
                    manifest.fileName(), manifest.contentType(), manifest.expectedSizeBytes(),
                    manifest.expectedSha256(), artifactPath.toUri().toString(), manifest.classification(),
                    Instant.ofEpochMilli(manifest.artifactCreatedAt()), Instant.ofEpochMilli(manifest.artifactExpiresAt()),
                    manifest.metadata());
        }

        private void saveManifest(LocalUploadManifest manifest) {
            Path destination = manifestPath(checkedUuid(manifest.uploadId()));
            Path temporary = null;
            try {
                temporary = Files.createTempFile(metadataRoot, manifest.uploadId() + ".", ".tmp");
                manifestMapper.writeValue(temporary.toFile(), manifest);
                if (Files.isSymbolicLink(temporary) || !Files.isRegularFile(temporary, java.nio.file.LinkOption.NOFOLLOW_LINKS)) {
                    throw new IllegalStateException("Temporary local Media manifest is not a regular file");
                }
                replaceHook.beforeReplace(destination);
                Files.move(temporary, destination, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING);
            } catch (AtomicMoveNotSupportedException unsupported) {
                failedClosed.set(true);
                throw new IllegalStateException("Atomic local Media manifest replacement is not supported", unsupported);
            } catch (IOException failure) {
                failedClosed.set(true);
                throw unavailable("persist upload manifest", failure);
            } catch (RuntimeException failure) {
                failedClosed.set(true);
                throw failure;
            } finally {
                if (temporary != null) {
                    try { Files.deleteIfExists(temporary); } catch (IOException ignored) { }
                }
            }
        }

        private void validateBytes(Path path, long expectedSize, String expectedDigest) {
            if (size(path) != expectedSize || !sha256(path).equals(expectedDigest)) {
                throw new IllegalStateException("Local Media artifact bytes failed manifest integrity verification");
            }
        }

        private static long size(Path path) {
            try { return Files.size(path); }
            catch (IOException failure) { throw unavailable("inspect local Media bytes", failure); }
        }

        private static void validateRegularFileIfPresent(Path path) {
            if (Files.exists(path, java.nio.file.LinkOption.NOFOLLOW_LINKS)
                    && (Files.isSymbolicLink(path)
                    || !Files.isRegularFile(path, java.nio.file.LinkOption.NOFOLLOW_LINKS))) {
                throw new IllegalStateException("Local Media bytes must be a confined regular non-symlink file");
            }
        }

        private Path manifestPath(String id) { return safeResolve(metadataRoot, id + ".json"); }

        private static String checkedUuid(String id) {
            try {
                String parsed = UUID.fromString(id).toString();
                if (!parsed.equalsIgnoreCase(id)) throw new IllegalArgumentException("non-canonical UUID");
                return parsed;
            } catch (RuntimeException failure) {
                throw new IllegalStateException("Local Media manifest contains an invalid opaque identity", failure);
            }
        }

        private static void requireManifestText(String value, String field) {
            if (value == null || value.isBlank()) throw new IllegalStateException("Local Media manifest is missing " + field);
        }

        private static String idempotencyKey(String tenantId, String principalId, String key) {
            return tenantId.length() + ":" + tenantId + principalId.length() + ":" + principalId + key;
        }

        private record LocalUploadManifest(
                int manifestVersion, String tenantId, String principalId, String uploadId,
                String requestFileName, String fileName, String contentType, long expectedSizeBytes,
                String expectedSha256, String classification, long retentionSeconds, int retentionNanos,
                long createdAt, long expiresAt, long bytesReceived, int nextChunkIndex,
                List<ChunkReceipt> chunkReceipts, String status,
                Map<String, Object> metadata, String idempotencyKey, String requestFingerprint,
                String artifactId, Long artifactCreatedAt, Long artifactExpiresAt) {
            UploadSession session() {
                return new UploadSession(uploadId, tenantId, principalId, fileName, contentType,
                        expectedSizeBytes, expectedSha256, classification, Instant.ofEpochMilli(createdAt),
                        Instant.ofEpochMilli(expiresAt), bytesReceived, nextChunkIndex,
                        UploadStatus.valueOf(status), metadata);
            }
        }

        private record ChunkReceipt(int chunkIndex, long offset, int length, String sha256) { }

        private static void requireIdempotencyKey(String value) {
            if (value == null || value.isBlank() || value.length() > 255) {
                throw new IllegalArgumentException("Idempotency-Key must contain between 1 and 255 characters");
            }
        }
        private record UploadIdempotency(String uploadId, String fingerprint) { }
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

    private static String sha256(byte[] bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
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
