package com.ghatana.media.launcher;

import com.ghatana.media.production.delivery.DeliveryOperationStore;
import com.ghatana.media.production.delivery.InMemoryDeliveryOperationStore;
import com.ghatana.media.production.delivery.MediaDeliveryEngine;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.sun.net.httpserver.HttpServer;
import org.junit.jupiter.api.Test;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.databind.json.JsonMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.Base64;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Random;
import java.util.Set;
import java.util.concurrent.CompletableFuture;
import java.util.function.UnaryOperator;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * DEV_ONLY hosted export through the real HTTP host, the real {@link MediaDeliveryEngine} and the real
 * local-directory destination. Destination-confirmed is asserted to come only from a readback receipt.
 */
class MediaDevDeliveryHttpTest {
    private static final String TENANT = "tenant-local";
    private static final String PRINCIPAL = "principal-local";
    private static final String OTHER = "principal-other";
    private static final String SECRET = "test-only-dev-project-secret-at-least-32-bytes";
    private static final String ISSUER = "urn:ghatana:media:dev-only";
    private static final String AUDIENCE = "ghatana-media-dev";
    private static final java.time.Clock CLOCK =
            java.time.Clock.fixed(Instant.parse("2026-11-13T20:00:00Z"), java.time.ZoneOffset.UTC);
    private static final Set<String> EXPORT_PERMISSIONS = Set.of(
            "media:delivery:dev:export", "media:delivery:dev:read", "media:artifact:read", "media:artifact:create");
    private static final ObjectMapper JSON = JsonMapper.builder().build();
    private static final String DESTINATION = MediaDevDeliveryRuntime.DESTINATION_ID;

    @Test
    void confirmsOnlyFromReadbackReplaysDuplicatesAndConflictsOnReuse() throws Exception {
        Fixture fixture = new Fixture(null);
        try {
            MediaArtifact artifact = fixture.upload("export-a.bin", bytes(5_000, 1), "a");
            MediaArtifact other = fixture.upload("export-b.bin", bytes(5_000, 2), "b");

            HttpResponse<String> first = fixture.export("export-1", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(first.statusCode()).as(first.body()).isEqualTo(201);
            Map<String, Object> view = read(first.body());
            assertThat(view).containsEntry("status", "DESTINATION_CONFIRMED")
                    .containsEntry("destinationConfirmed", true).containsEntry("replayed", false)
                    .containsEntry("scope", "DEV_ONLY").containsEntry("artifactId", artifact.artifactId())
                    .containsEntry("artifactVersionId", artifact.version().value())
                    .containsEntry("acknowledgedBytes", 5_000);
            assertThat((String) view.get("destinationReceiptRef")).startsWith("dev-local-directory-receipt:");
            // The destination file holds exactly the artifact bytes (independent read).
            Path object = fixture.objectPath("export-1");
            assertThat(Files.readAllBytes(object)).isEqualTo(fixture.artifactBytes(artifact));
            assertThat(fixture.destinationCalls.get()).isEqualTo(1);
            assertThat(Files.list(fixture.destinationRoot).map(p -> p.getFileName().toString()).toList())
                    .containsExactly(object.getFileName().toString());
            long modified = Files.getLastModifiedTime(object).toMillis();

            // Duplicate: replay, no second effect.
            HttpResponse<String> duplicate = fixture.export("export-1", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(duplicate.statusCode()).as(duplicate.body()).isEqualTo(200);
            assertThat(read(duplicate.body())).containsEntry("status", "DESTINATION_CONFIRMED")
                    .containsEntry("replayed", true)
                    .containsEntry("destinationReceiptRef", view.get("destinationReceiptRef"));
            assertThat(fixture.destinationCalls.get()).isEqualTo(1);
            assertThat(Files.getLastModifiedTime(object).toMillis()).isEqualTo(modified);

            // Conflicting reuse of the same requestId for another artifact version.
            HttpResponse<String> conflict = fixture.export("export-1", other, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(conflict.statusCode()).as(conflict.body()).isEqualTo(409);
            assertThat(conflict.body()).contains("EXPORT_REQUEST_CONFLICT");
            assertThat(Files.readAllBytes(object)).isEqualTo(fixture.artifactBytes(artifact));

            HttpResponse<String> read = fixture.get("export-1", PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(read.statusCode()).isEqualTo(200);
            assertThat(read(read.body())).containsEntry("status", "DESTINATION_CONFIRMED");
        } finally {
            fixture.close();
        }
    }

    @Test
    void operationReadsBackAfterRestartWithoutASecondEffect() throws Exception {
        Fixture fixture = new Fixture(null);
        try {
            MediaArtifact artifact = fixture.upload("restart.bin", bytes(3_000, 3), "restart");
            HttpResponse<String> first = fixture.export("restart-1", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(first.statusCode()).as(first.body()).isEqualTo(201);
            String receipt = (String) read(first.body()).get("destinationReceiptRef");
            int callsBefore = fixture.destinationCalls.get();

            fixture.restart(null); // new engine, empty caches; durable ledger + directory survive
            HttpResponse<String> reopened = fixture.get("restart-1", PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(reopened.statusCode()).as(reopened.body()).isEqualTo(200);
            assertThat(read(reopened.body())).containsEntry("status", "DESTINATION_CONFIRMED")
                    .containsEntry("destinationReceiptRef", receipt);
            HttpResponse<String> replay = fixture.export("restart-1", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(replay.statusCode()).as(replay.body()).isEqualTo(200);
            assertThat(read(replay.body())).containsEntry("replayed", true).containsEntry("destinationReceiptRef", receipt);
            assertThat(fixture.destinationCalls.get()).isEqualTo(callsBefore);
        } finally {
            fixture.close();
        }
    }

    @Test
    void lostAckIsReconciledByReadbackWithoutRewriting() throws Exception {
        LossyDestination[] lossy = new LossyDestination[1];
        Fixture fixture = new Fixture(port -> lossy[0] = new LossyDestination(port, 1, true));
        try {
            MediaArtifact artifact = fixture.upload("lost-ack.bin", bytes(4_000, 4), "lost");
            HttpResponse<String> first = fixture.export("lost-1", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
            // The write landed but the acknowledgement was lost: queued/sent are not confirmed.
            assertThat(first.statusCode()).as(first.body()).isEqualTo(202);
            assertThat(read(first.body())).containsEntry("status", "OUTCOME_UNKNOWN")
                    .containsEntry("destinationConfirmed", false).containsEntry("destinationReceiptRef", null);
            Path object = fixture.objectPath("lost-1");
            assertThat(Files.readAllBytes(object)).isEqualTo(fixture.artifactBytes(artifact));
            // The first POST already tried one reconcile; it had the object, but the exception path above
            // ran before it. Either way the ledger must now confirm by readback, never by re-sending.
            int writes = lossy[0].delegateWrites;
            long modified = Files.getLastModifiedTime(object).toMillis();

            HttpResponse<String> retry = fixture.export("lost-1", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(retry.statusCode()).as(retry.body()).isEqualTo(200);
            assertThat(read(retry.body())).containsEntry("status", "DESTINATION_CONFIRMED")
                    .containsEntry("destinationConfirmed", true).containsEntry("replayed", true);
            assertThat(lossy[0].delegateWrites).isEqualTo(writes);
            assertThat(Files.getLastModifiedTime(object).toMillis()).isEqualTo(modified);
        } finally {
            fixture.close();
        }
    }

    @Test
    void tamperedDestinationObjectIsNeverConfirmed() throws Exception {
        LossyDestination[] lossy = new LossyDestination[1];
        Fixture fixture = new Fixture(port -> lossy[0] = new LossyDestination(port, 1, true));
        try {
            MediaArtifact artifact = fixture.upload("tamper.bin", bytes(4_000, 5), "tamper");
            assertThat(fixture.export("tamper-1", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS).statusCode())
                    .isEqualTo(202);
            Path object = fixture.objectPath("tamper-1");
            byte[] tampered = Files.readAllBytes(object);
            tampered[17] ^= 0x01; // same size, different checksum
            Files.write(object, tampered);

            HttpResponse<String> retry = fixture.export("tamper-1", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(retry.statusCode()).as(retry.body()).isEqualTo(202);
            assertThat(read(retry.body())).containsEntry("status", "OUTCOME_UNKNOWN")
                    .containsEntry("destinationConfirmed", false).containsEntry("destinationReceiptRef", null);
            // Truncated objects are not confirmed either, and the adapter never overwrites the tampered file.
            Files.write(object, Arrays.copyOf(tampered, 100));
            HttpResponse<String> truncated = fixture.export("tamper-1", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(read(truncated.body())).containsEntry("destinationConfirmed", false);
            assertThat(Files.readAllBytes(object)).hasSize(100);
            assertThat(read(fixture.get("tamper-1", PRINCIPAL, EXPORT_PERMISSIONS).body()))
                    .containsEntry("destinationConfirmed", false);
        } finally {
            fixture.close();
        }
    }

    @Test
    void resumesMultiChunkTransferFromVerifiedOffsetAfterLostAck() throws Exception {
        LossyDestination[] lossy = new LossyDestination[1];
        // Fail (before writing) the second chunk send.
        Fixture fixture = new Fixture(port -> lossy[0] = new LossyDestination(port, 2, false));
        try {
            byte[] content = bytes(MediaDeliveryEngine.CHUNK_BYTES * 2 + 123, 6);
            MediaArtifact artifact = fixture.upload("big.bin", content, "big");
            HttpResponse<String> first = fixture.export("big-1", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(first.statusCode()).as(first.body()).isEqualTo(202);
            assertThat(read(first.body())).containsEntry("status", "OUTCOME_UNKNOWN")
                    .containsEntry("acknowledgedBytes", MediaDeliveryEngine.CHUNK_BYTES);
            assertThat(Files.exists(fixture.objectPath("big-1"))).isFalse();

            HttpResponse<String> retry = fixture.export("big-1", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(retry.statusCode()).as(retry.body()).isEqualTo(200);
            assertThat(read(retry.body())).containsEntry("status", "DESTINATION_CONFIRMED");
            assertThat(Files.readAllBytes(fixture.objectPath("big-1"))).isEqualTo(content);
            // Offsets sent: 0, 1 MiB (failed), 1 MiB, 2 MiB: chunk 0 was not resent.
            assertThat(lossy[0].offsets).containsExactly(0, MediaDeliveryEngine.CHUNK_BYTES,
                    MediaDeliveryEngine.CHUNK_BYTES, MediaDeliveryEngine.CHUNK_BYTES * 2);
        } finally {
            fixture.close();
        }
    }

    @Test
    void preexistingDestinationObjectIsVerifiedNeverBlindlyTrusted() throws Exception {
        Fixture fixture = new Fixture(null);
        try {
            MediaArtifact artifact = fixture.upload("seed.bin", bytes(2_000, 7), "seed");
            byte[] content = fixture.artifactBytes(artifact);
            // A write that landed before any ledger record (crash window): byte-identical object.
            Files.write(fixture.objectPath("seed-ok"), content);
            HttpResponse<String> confirmed = fixture.export("seed-ok", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(confirmed.statusCode()).as(confirmed.body()).isEqualTo(201);
            assertThat(read(confirmed.body())).containsEntry("destinationConfirmed", true);

            // A foreign object with the same size is refused: not overwritten, not confirmed.
            byte[] foreign = bytes(2_000, 99);
            Files.write(fixture.objectPath("seed-bad"), foreign);
            HttpResponse<String> refused = fixture.export("seed-bad", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(refused.statusCode()).as(refused.body()).isEqualTo(202);
            assertThat(read(refused.body())).containsEntry("destinationConfirmed", false);
            assertThat(Files.readAllBytes(fixture.objectPath("seed-bad"))).isEqualTo(foreign);
        } finally {
            fixture.close();
        }
    }

    @Test
    void symbolicLinkAtTheObjectPathIsRefusedAndTargetUntouched() throws Exception {
        Fixture fixture = new Fixture(null);
        try {
            MediaArtifact artifact = fixture.upload("link.bin", bytes(1_000, 8), "link");
            Path outside = Files.createTempFile("media-dev-delivery-outside-", ".bin");
            Files.write(outside, new byte[] {1, 2, 3});
            Files.createSymbolicLink(fixture.objectPath("link-1"), outside);
            HttpResponse<String> response = fixture.export("link-1", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(response.statusCode()).isEqualTo(202);
            assertThat(read(response.body())).containsEntry("destinationConfirmed", false);
            assertThat(Files.readAllBytes(outside)).containsExactly(1, 2, 3);
        } finally {
            fixture.close();
        }
    }

    @Test
    void deniesWrongPrincipalMissingPermissionsUnknownDestinationAndMalformedRequests() throws Exception {
        Fixture fixture = new Fixture(null);
        try {
            MediaArtifact artifact = fixture.upload("deny.bin", bytes(1_500, 9), "deny");
            assertThat(fixture.export("deny-1", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS).statusCode())
                    .isEqualTo(201);

            // Wrong principal cannot export the owner's artifact or read the owner's operation.
            HttpResponse<String> foreignExport = fixture.export("deny-2", artifact, DESTINATION, OTHER, EXPORT_PERMISSIONS);
            assertThat(foreignExport.statusCode()).isEqualTo(404);
            assertThat(foreignExport.body()).contains("ARTIFACT_VERSION_NOT_FOUND");
            assertThat(fixture.get("deny-1", OTHER, EXPORT_PERMISSIONS).statusCode()).isEqualTo(404);
            assertThat(Files.exists(fixture.objectPath("deny-2"))).isFalse();

            // Missing delivery or artifact permission.
            assertThat(fixture.export("deny-3", artifact, DESTINATION, PRINCIPAL,
                    Set.of("media:artifact:read")).statusCode()).isEqualTo(403);
            assertThat(fixture.export("deny-3", artifact, DESTINATION, PRINCIPAL,
                    Set.of("media:delivery:dev:export")).statusCode()).isEqualTo(403);
            assertThat(fixture.get("deny-1", PRINCIPAL, Set.of("media:artifact:read")).statusCode()).isEqualTo(403);

            // Unknown destination: typed 404 and no durable operation.
            HttpResponse<String> unknown = fixture.export("deny-4", artifact, "elsewhere", PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(unknown.statusCode()).isEqualTo(404);
            assertThat(unknown.body()).contains("DESTINATION_NOT_FOUND");
            assertThat(fixture.get("deny-4", PRINCIPAL, EXPORT_PERMISSIONS).statusCode()).isEqualTo(404);
            HttpResponse<String> traversal = fixture.export("deny-5", artifact, "../../etc", PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(traversal.statusCode()).isEqualTo(404);

            // Unknown artifact version: exact version required.
            MediaArtifact fake = artifact;
            HttpResponse<String> wrongVersion = fixture.send("POST", "/dev/v1/exports", JSON.writeValueAsString(Map.of(
                    "requestId", "deny-6", "artifactId", fake.artifactId(),
                    "artifactVersionId", "sha256:" + "0".repeat(64), "destinationId", DESTINATION)),
                    PRINCIPAL, EXPORT_PERMISSIONS);
            assertThat(wrongVersion.statusCode()).isEqualTo(404);

            // Malformed bodies and methods.
            assertThat(fixture.send("POST", "/dev/v1/exports", "{\"requestId\":\"x\"}", PRINCIPAL,
                    EXPORT_PERMISSIONS).statusCode()).isEqualTo(400);
            assertThat(fixture.send("POST", "/dev/v1/exports", JSON.writeValueAsString(Map.of(
                    "requestId", " bad ", "artifactId", artifact.artifactId(),
                    "artifactVersionId", artifact.version().value(), "destinationId", DESTINATION)),
                    PRINCIPAL, EXPORT_PERMISSIONS).statusCode()).isEqualTo(400);
            // An unmapped method/path is denied fail-closed by the security filter's route permission map.
            assertThat(fixture.send("GET", "/dev/v1/exports", null, PRINCIPAL, EXPORT_PERMISSIONS).statusCode())
                    .isIn(403, 405);
            assertThat(fixture.get("no-such-export", PRINCIPAL, EXPORT_PERMISSIONS).statusCode()).isEqualTo(404);
        } finally {
            fixture.close();
        }
    }

    @Test
    void absentOrInvalidDestinationConfigurationIsTypedUnavailableOrRejected() throws Exception {
        Path root = Files.createTempDirectory("media-dev-delivery-unavailable-");
        MediaRuntime runtime = Fixture.runtime(root);
        try {
            Map<String, String> base = Map.of("MEDIA_DELIVERY_DEV_ENABLED", "true",
                    "MEDIA_RUNTIME_ENVIRONMENT", "dev", "MEDIA_DEV_IDENTITY_ENABLED", "true");
            assertThat(MediaDevDeliveryRuntime.compose(Map.of(), runtime)).isNull();
            MediaDevDeliveryRuntime unconfigured = MediaDevDeliveryRuntime.compose(base, runtime);
            assertThat(unconfigured.available()).isFalse();
            assertThatThrownBy(() -> MediaDevDeliveryRuntime.compose(Map.of("MEDIA_DELIVERY_DEV_ENABLED", "true",
                    "MEDIA_RUNTIME_ENVIRONMENT", "prod", "MEDIA_DEV_IDENTITY_ENABLED", "true"), runtime))
                    .isInstanceOf(IllegalArgumentException.class);
            for (String bad : List.of("relative/dir", root + "/../escape", root + "/missing", " " + root)) {
                assertThatThrownBy(() -> MediaDevLocalDirectoryDestination.confineRoot(bad))
                        .as(bad).isInstanceOf(IllegalArgumentException.class);
            }
            Path file = Files.createTempFile(root, "not-a-dir", ".tmp");
            assertThatThrownBy(() -> MediaDevLocalDirectoryDestination.confineRoot(file.toString()))
                    .isInstanceOf(IllegalArgumentException.class);

            // Through HTTP: enabled but unconfigured is a typed 503, never a success.
            Fixture fixture = new Fixture(null, unconfigured);
            try {
                MediaArtifact artifact = fixture.upload("none.bin", bytes(100, 10), "none");
                HttpResponse<String> response = fixture.export("none-1", artifact, DESTINATION, PRINCIPAL, EXPORT_PERMISSIONS);
                assertThat(response.statusCode()).isEqualTo(503);
                assertThat(response.body()).contains("DELIVERY_DESTINATION_UNAVAILABLE");
                assertThat(fixture.get("none-1", PRINCIPAL, EXPORT_PERMISSIONS).statusCode()).isEqualTo(503);
            } finally {
                fixture.close();
            }
        } finally {
            runtime.close();
        }
    }

    // ---- fixtures ----

    private static byte[] bytes(int length, long seed) {
        byte[] bytes = new byte[length];
        new Random(seed).nextBytes(bytes);
        return bytes;
    }

    /** Fails the Nth send. If {@code writeBeforeFailing}, the bytes land first (a lost acknowledgement). */
    private static final class LossyDestination implements MediaDeliveryEngine.FencedDestinationPort {
        private final MediaDeliveryEngine.FencedDestinationPort delegate;
        private final int failingCall;
        private final boolean writeBeforeFailing;
        final List<Integer> offsets = new ArrayList<>();
        int delegateWrites;
        private int calls;

        LossyDestination(MediaDeliveryEngine.FencedDestinationPort delegate, int failingCall, boolean writeBeforeFailing) {
            this.delegate = delegate; this.failingCall = failingCall; this.writeBeforeFailing = writeBeforeFailing;
        }

        @Override public MediaDeliveryEngine.FencedChunkReceipt sendChunk(
                MediaDeliveryEngine.ExportRequest request, int offset, byte[] chunk, String chunkDigest,
                MediaDeliveryEngine.TransferAuthorization authorization,
                DeliveryOperationStore.DispatchClaim claim) {
            offsets.add(offset);
            calls++;
            boolean fail = calls == failingCall;
            if (fail && !writeBeforeFailing) throw new IllegalStateException("simulated lost acknowledgement");
            var receipt = delegate.sendChunk(request, offset, chunk, chunkDigest, authorization, claim);
            delegateWrites++;
            if (fail) throw new IllegalStateException("simulated lost acknowledgement after durable write");
            return receipt;
        }

        @Override public MediaDeliveryEngine.FencedReconciliation reconcile(
                MediaDeliveryEngine.ExportRequest request, DeliveryOperationStore.DispatchClaim claim) {
            return delegate.reconcile(request, claim);
        }
    }

    /** In-memory ledger that declares claim support; it is a deterministic test double, not durable evidence. */
    private static final class ClaimingStore implements DeliveryOperationStore {
        private final InMemoryDeliveryOperationStore delegate = new InMemoryDeliveryOperationStore();
        @Override public boolean supportsDurableDispatchClaims() { return true; }
        @Override public Optional<Operation> find(String tenantId, String requestId) { return delegate.find(tenantId, requestId); }
        @Override public boolean insertIfAbsent(Operation operation) { return delegate.insertIfAbsent(operation); }
        @Override public boolean update(Operation operation) { return delegate.update(operation); }
        @Override public Optional<DispatchClaim> acquireDispatchClaim(Operation operation, String ownerId, Duration lease) {
            return delegate.acquireDispatchClaim(operation, ownerId, lease);
        }
        @Override public Optional<DispatchClaim> renewDispatchClaim(DispatchClaim claim, Duration lease) {
            return delegate.renewDispatchClaim(claim, lease);
        }
        @Override public boolean isDispatchClaimCurrent(DispatchClaim claim) { return delegate.isDispatchClaimCurrent(claim); }
        @Override public boolean releaseDispatchClaim(DispatchClaim claim) { return delegate.releaseDispatchClaim(claim); }
        @Override public boolean update(Operation operation, DispatchClaim claim) { return delegate.update(operation, claim); }
    }

    private static final class Fixture {
        final Path destinationRoot;
        final MediaRuntime runtime;
        final ClaimingStore store = new ClaimingStore();
        final java.util.concurrent.atomic.AtomicInteger destinationCalls = new java.util.concurrent.atomic.AtomicInteger();
        MediaDevDeliveryRuntime delivery;
        HttpServer server;

        Fixture(UnaryOperator<MediaDeliveryEngine.FencedDestinationPort> wrapper) throws Exception {
            this(wrapper, null);
        }

        Fixture(UnaryOperator<MediaDeliveryEngine.FencedDestinationPort> wrapper,
                MediaDevDeliveryRuntime preset) throws Exception {
            Path root = Files.createTempDirectory("media-dev-delivery-http-");
            this.destinationRoot = Files.createDirectory(root.resolve("destination")).toRealPath();
            this.runtime = runtime(Files.createDirectory(root.resolve("artifacts")));
            if (preset != null) {
                this.delivery = preset;
                start();
            } else {
                restart(wrapper);
            }
        }

        void restart(UnaryOperator<MediaDeliveryEngine.FencedDestinationPort> wrapper) throws Exception {
            if (server != null) server.stop(0);
            UnaryOperator<MediaDeliveryEngine.FencedDestinationPort> counting = port -> {
                MediaDeliveryEngine.FencedDestinationPort inner = wrapper == null ? port : wrapper.apply(port);
                return new MediaDeliveryEngine.FencedDestinationPort() {
                    @Override public MediaDeliveryEngine.FencedChunkReceipt sendChunk(
                            MediaDeliveryEngine.ExportRequest request, int offset, byte[] chunk, String digest,
                            MediaDeliveryEngine.TransferAuthorization authorization,
                            DeliveryOperationStore.DispatchClaim claim) {
                        destinationCalls.incrementAndGet();
                        return inner.sendChunk(request, offset, chunk, digest, authorization, claim);
                    }
                    @Override public MediaDeliveryEngine.FencedReconciliation reconcile(
                            MediaDeliveryEngine.ExportRequest request, DeliveryOperationStore.DispatchClaim claim) {
                        return inner.reconcile(request, claim);
                    }
                };
            };
            delivery = new MediaDevDeliveryRuntime(runtime, store, destinationRoot, Instant::now, counting);
            start();
        }

        private void start() throws Exception {
            server = HttpServer.create(new InetSocketAddress("127.0.0.1", 0), 0);
            MediaHttpHandler handler = new MediaHttpHandler(runtime, null, null, null).withDevDelivery(delivery);
            server.createContext("/", new MediaSecurityFilter(handler, "dev",
                    Map.of("MEDIA_DEV_IDENTITY_ENABLED", "true", "MEDIA_DEV_JWT_HMAC_SECRET", SECRET), CLOCK));
            server.start();
        }

        void close() { server.stop(0); runtime.close(); }

        Path objectPath(String requestId) {
            return destinationRoot.resolve(MediaDevLocalDirectoryDestination.objectName(TENANT, PRINCIPAL, requestId) + ".bin");
        }

        MediaArtifact upload(String name, byte[] content, String key) throws Exception {
            String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(content));
            var session = runtime.beginUpload(new UploadRequest(TENANT, PRINCIPAL, name, "application/octet-stream",
                    content.length, digest, "INTERNAL", Duration.ofMinutes(30), Map.of()), key);
            int chunk = runtime.config().maximumChunkBytes();
            for (int offset = 0, index = 0; offset < content.length; offset += chunk, index++) {
                runtime.appendChunk(TENANT, PRINCIPAL, session.uploadId(), index,
                        Arrays.copyOfRange(content, offset, Math.min(content.length, offset + chunk)));
            }
            return runtime.completeUpload(TENANT, PRINCIPAL, session.uploadId());
        }

        byte[] artifactBytes(MediaArtifact artifact) throws Exception {
            var out = new java.io.ByteArrayOutputStream();
            runtime.copyArtifactContent(TENANT, PRINCIPAL, artifact.artifactId(), artifact.version(), out, 16 * 1024 * 1024)
                    .orElseThrow();
            return out.toByteArray();
        }

        HttpResponse<String> export(String requestId, MediaArtifact artifact, String destination,
                                    String principal, Set<String> permissions) throws Exception {
            return send("POST", "/dev/v1/exports", JSON.writeValueAsString(Map.of("requestId", requestId,
                    "artifactId", artifact.artifactId(), "artifactVersionId", artifact.version().value(),
                    "destinationId", destination)), principal, permissions);
        }

        HttpResponse<String> get(String requestId, String principal, Set<String> permissions) throws Exception {
            return send("GET", "/dev/v1/exports/" + requestId, null, principal, permissions);
        }

        HttpResponse<String> send(String method, String path, String body, String principal,
                                  Set<String> permissions) throws Exception {
            HttpRequest.Builder request = HttpRequest.newBuilder(
                            URI.create("http://127.0.0.1:" + server.getAddress().getPort() + path))
                    .header("Authorization", "Bearer " + token(principal, permissions))
                    .header("X-Tenant-Id", TENANT);
            if (body != null) request.header("Content-Type", "application/json");
            request.method(method, body == null ? HttpRequest.BodyPublishers.noBody()
                    : HttpRequest.BodyPublishers.ofString(body, StandardCharsets.UTF_8));
            return HttpClient.newHttpClient().send(request.build(), HttpResponse.BodyHandlers.ofString(StandardCharsets.UTF_8));
        }

        static MediaRuntime runtime(Path root) {
            return new MediaRuntime(
                    new MediaRuntimeConfig(true, "dev", 8094, 1_048_576, 131_072, 8_388_608,
                            Duration.ofSeconds(2), 2, "", "", true, false, root),
                    new LocalMediaRuntimeSupport.FileArtifactStore(root),
                    new LocalMediaRuntimeSupport.JobStore(false),
                    new LocalMediaRuntimeSupport.StreamStore(), null,
                    List.of(new NoEffectProvider()),
                    List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()));
        }
    }

    private static String token(String principal, Set<String> permissions) throws Exception {
        String header = encode("{\"alg\":\"HS256\",\"typ\":\"JWT\"}");
        String permissionJson = permissions.stream().sorted().map(permission -> "\"" + permission + "\"")
                .collect(java.util.stream.Collectors.joining(","));
        String payload = "{\"sub\":\"" + principal + "\",\"tenant_id\":\"" + TENANT
                + "\",\"iss\":\"" + ISSUER + "\",\"aud\":\"" + AUDIENCE + "\",\"dev_only\":true,"
                + "\"iat\":" + CLOCK.instant().getEpochSecond() + ",\"exp\":"
                + CLOCK.instant().plusSeconds(120).getEpochSecond() + ",\"permissions\":[" + permissionJson + "]}";
        String signingInput = header + "." + encode(payload);
        Mac mac = Mac.getInstance("HmacSHA256");
        mac.init(new SecretKeySpec(SECRET.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
        return signingInput + "." + Base64.getUrlEncoder().withoutPadding()
                .encodeToString(mac.doFinal(signingInput.getBytes(StandardCharsets.US_ASCII)));
    }

    private static String encode(String value) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(value.getBytes(StandardCharsets.UTF_8));
    }

    private static Map<String, Object> read(String json) throws Exception {
        return JSON.readValue(json, new TypeReference<Map<String, Object>>() { });
    }

    private static final class NoEffectProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "dev-delivery-http-no-effect"; }
        @Override public Set<JobType> capabilities() { return Set.of(JobType.TRANSCODE); }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public ProcessingBoundary processingBoundary() { return ProcessingBoundary.LOCAL; }
        @Override public CompletableFuture<Map<String, Object>> process(ProcessingContext context) {
            return CompletableFuture.failedFuture(new AssertionError("delivery routes must not invoke processing"));
        }
    }
}
