package com.ghatana.media.launcher;

import com.ghatana.launcher.config.RuntimeSecretReference;
import com.ghatana.media.production.delivery.DeliveryOperationStore;
import com.ghatana.media.production.delivery.MediaDeliveryEngine;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.ChunkReceipt;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.DestinationReceipt;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.ExportRequest;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.FencedChunkReceipt;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.FencedDestinationReceipt;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.FencedReconciliation;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.TransferAuthorization;
import com.ghatana.media.runtime.MediaCreationContracts;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.IOException;
import java.net.InetAddress;
import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.security.GeneralSecurityException;
import java.security.MessageDigest;
import java.security.SecureRandom;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * DEV_ONLY delivery destination that speaks the signed-ACK receiver protocol to one receiver on a loopback address.
 * The receiver is a separate process that this launcher does not control: it holds its own copy of the bytes, its own
 * revocable upload credential and an independent ACK signing key.
 *
 * <p>Nothing here treats a write, a 2xx or a body as proof. Every part acknowledgement and every status read is an
 * HMAC-SHA256 signed document that is verified (constant time) and then bound field by field to the exact request:
 * receiver identity, object key, a fresh per-call nonce, offsets, and for the final receipt the byte count and the
 * SHA-256 the receiver computed over what it stored. The engine, not this adapter, decides whether that checksum equals
 * the artifact digest; this adapter additionally classifies why a receipt was not usable, so that the host can report a
 * typed failure instead of a generic unknown.
 *
 * <p>Protocol (all calls carry {@code Authorization: Bearer <credential>} and {@code X-Ack-Nonce}):
 * <ul>
 *   <li>{@code PUT /v1/objects/{objectKey}/parts?offset=N} with {@code X-Part-Sha256}, {@code X-Object-Size},
 *       {@code X-Object-Sha256}; answers a signed PART ack.</li>
 *   <li>{@code GET /v1/objects/{objectKey}} answers a signed STATUS document (ABSENT, PARTIAL or COMPLETE).</li>
 * </ul>
 * Receiver responses are signed over their exact body bytes in {@code X-Ack-Signature: v1=<hex>}.
 */
final class MediaDevHttpReceiverDestination implements MediaDeliveryEngine.FencedDestinationPort {
    static final String DESTINATION_ID = "dev-http-receiver";
    static final String URL_ENV = "MEDIA_DELIVERY_DEV_RECEIVER_URL";
    static final String IDENTITY_ENV = "MEDIA_DELIVERY_DEV_RECEIVER_IDENTITY";
    static final String CREDENTIAL_REFERENCE_ENV = "MEDIA_DELIVERY_DEV_RECEIVER_CREDENTIAL_REFERENCE";
    static final String ACK_KEY_REFERENCE_ENV = "MEDIA_DELIVERY_DEV_RECEIVER_ACK_KEY_REFERENCE";
    static final String TENANTS_ENV = "MEDIA_DELIVERY_DEV_RECEIVER_TENANTS";
    static final String TIMEOUT_ENV = "MEDIA_DELIVERY_DEV_RECEIVER_TIMEOUT_MS";
    private static final Pattern KEY = Pattern.compile("[0-9a-f]{64}");
    private static final Pattern IDENTITY = Pattern.compile("[A-Za-z0-9][A-Za-z0-9._:-]{0,127}");
    private static final int MAX_OBSERVATIONS = 2048;
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final SecureRandom RANDOM = new SecureRandom();

    /** Why a receiver interaction did not yield usable evidence, or what it verifiably showed. */
    enum Finding {
        ACK_VERIFIED, OBJECT_ABSENT, PARTIAL, CREDENTIAL_REVOKED, ACK_SIGNATURE_INVALID,
        DESTINATION_IDENTITY_MISMATCH, CHECKSUM_MISMATCH, DESTINATION_UNREACHABLE, DESTINATION_REJECTED;

        boolean failure() {
            return switch (this) {
                case ACK_VERIFIED, OBJECT_ABSENT, PARTIAL -> false;
                default -> true;
            };
        }
    }

    record Observation(Finding finding, long receivedBytes, Instant at) { }

    /** Typed receiver failure; carries only the classification, never a body or credential. */
    static final class ReceiverException extends RuntimeException {
        private final Finding finding;
        ReceiverException(Finding finding, String message) { super(message); this.finding = finding; }
        Finding finding() { return finding; }
    }

    private record Status(String state, long receivedBytes, long size, String sha256, String ackId) { }

    private final URI base;
    private final String identity;
    private final String credential;
    private final byte[] ackKey;
    private final Set<String> tenants;
    private final Duration timeout;
    private final DeliveryOperationStore operations;
    private final HttpClient client;
    private final Map<String, Observation> observations = new LinkedHashMap<>();

    MediaDevHttpReceiverDestination(URI base, String identity, String credential, byte[] ackKey, Set<String> tenants,
                                    Duration timeout, DeliveryOperationStore operations) {
        this.base = requireLoopback(base);
        if (identity == null || !IDENTITY.matcher(identity).matches()) {
            throw new IllegalArgumentException("receiver identity must be an opaque id");
        }
        this.identity = identity;
        if (credential == null || credential.isBlank() || ackKey == null || ackKey.length < 16) {
            throw new IllegalArgumentException("receiver credential and a 16-byte-or-longer ACK key are required");
        }
        this.credential = credential;
        this.ackKey = ackKey.clone();
        this.tenants = Set.copyOf(tenants);
        this.timeout = Objects.requireNonNull(timeout, "timeout");
        this.operations = Objects.requireNonNull(operations, "operations");
        this.client = HttpClient.newBuilder().followRedirects(HttpClient.Redirect.NEVER)
                .connectTimeout(Duration.ofSeconds(3)).build();
    }

    /** Null when no receiver is configured; throws when it is configured badly (fail closed, never silent). */
    static MediaDevHttpReceiverDestination compose(Map<String, String> environment, DeliveryOperationStore operations) {
        String url = environment.getOrDefault(URL_ENV, "").trim();
        if (url.isEmpty()) return null;
        String credential = RuntimeSecretReference.resolveOptionalEnvironment(environment,
                environment.getOrDefault(CREDENTIAL_REFERENCE_ENV, ""), "delivery receiver credential", true);
        String ackKey = RuntimeSecretReference.resolveOptionalEnvironment(environment,
                environment.getOrDefault(ACK_KEY_REFERENCE_ENV, ""), "delivery receiver ACK key", true);
        String tenants = environment.getOrDefault(TENANTS_ENV, "").trim();
        if (tenants.isEmpty()) throw new IllegalArgumentException(TENANTS_ENV + " must list the permitted tenants");
        long timeoutMs = Long.parseLong(environment.getOrDefault(TIMEOUT_ENV, "15000").trim());
        if (timeoutMs < 200 || timeoutMs > 120_000) throw new IllegalArgumentException(TIMEOUT_ENV + " is out of range");
        return new MediaDevHttpReceiverDestination(URI.create(url), environment.getOrDefault(IDENTITY_ENV, "").trim(),
                credential, ackKey.getBytes(StandardCharsets.UTF_8),
                Set.of(tenants.split("\\s*,\\s*")), Duration.ofMillis(timeoutMs), operations);
    }

    private static URI requireLoopback(URI uri) {
        Objects.requireNonNull(uri, "receiver url");
        try {
            if (!"http".equals(uri.getScheme()) || uri.getHost() == null || uri.getUserInfo() != null
                    || uri.getQuery() != null || uri.getFragment() != null
                    || (uri.getPath() != null && !uri.getPath().isEmpty() && !"/".equals(uri.getPath()))) {
                throw new IllegalArgumentException("receiver url must be a bare http origin");
            }
            if (!InetAddress.getByName(uri.getHost()).isLoopbackAddress()) {
                throw new IllegalArgumentException("DEV_ONLY receiver must be on a loopback address");
            }
        } catch (java.net.UnknownHostException failure) {
            throw new IllegalArgumentException("receiver host cannot be resolved", failure);
        }
        return URI.create("http://" + uri.getHost() + ":" + uri.getPort());
    }

    boolean permits(String tenantId) { return tenants.contains(tenantId); }

    synchronized Optional<Observation> observation(String tenantId, String requestId) {
        return Optional.ofNullable(observations.get(tenantId + "\u0000" + requestId));
    }

    private synchronized void observe(ExportRequest request, Finding finding, long received) {
        String key = request.tenantId() + "\u0000" + request.requestId();
        observations.remove(key);
        observations.put(key, new Observation(finding, received, Instant.now()));
        while (observations.size() > MAX_OBSERVATIONS) {
            observations.remove(observations.keySet().iterator().next());
        }
    }

    static String objectKey(ExportRequest request) {
        return MediaDevLocalDirectoryDestination.objectName(request.tenantId(), request.principalId(), request.requestId());
    }

    /**
     * Effect-free read of what the receiver holds, recorded as the latest observation. Used by explicit reconciliation
     * that must not send anything; the engine path uses {@link #reconcile}.
     */
    Observation inspect(ExportRequest request) {
        try {
            Status status = status(request);
            return observation(request, status);
        } catch (ReceiverException failure) {
            observe(request, failure.finding(), 0);
            return new Observation(failure.finding(), 0, Instant.now());
        }
    }

    private Observation observation(ExportRequest request, Status status) {
        Finding finding;
        switch (status.state()) {
            case "ABSENT" -> finding = Finding.OBJECT_ABSENT;
            case "PARTIAL" -> finding = Finding.PARTIAL;
            default -> finding = status.size() == request.artifact().bytes().length
                    && ("sha256:" + status.sha256()).equals(request.artifact().digest())
                    ? Finding.ACK_VERIFIED : Finding.CHECKSUM_MISMATCH;
        }
        observe(request, finding, status.receivedBytes());
        return new Observation(finding, status.receivedBytes(), Instant.now());
    }

    @Override
    public void preflight(ExportRequest request) {
        objectKey(request);
        Status status = status(request); // authenticated, identity-bound, signed: proves reachability and credential
        if (observation(request, status).finding() == Finding.CHECKSUM_MISMATCH) {
            // Another party's bytes already sit at this write-once key: refuse before any write is attempted.
            throw new ReceiverException(Finding.CHECKSUM_MISMATCH, "a different object already exists at the destination key");
        }
    }

    @Override
    public FencedChunkReceipt sendChunk(ExportRequest request, int offset, byte[] chunk, String chunkDigest,
                                        TransferAuthorization authorization,
                                        DeliveryOperationStore.DispatchClaim claim) {
        requireCurrentClaim(request, claim);
        if (authorization == null || !authorization.requestId().equals(request.requestId())
                || !authorization.destinationRef().equals(request.destinationRef())) {
            throw new IllegalStateException("transfer authorization does not match this destination write");
        }
        if (!MediaCreationContracts.sha256(chunk).equals(chunkDigest)) {
            throw new IllegalStateException("chunk digest does not match chunk bytes");
        }
        byte[] artifact = request.artifact().bytes();
        if (offset < 0 || offset + chunk.length > artifact.length
                || !java.util.Arrays.equals(chunk, java.util.Arrays.copyOfRange(artifact, offset, offset + chunk.length))) {
            throw new IllegalStateException("chunk is not the exact artifact range");
        }
        String key = objectKey(request);
        String nonce = nonce();
        HttpRequest put = HttpRequest.newBuilder(base.resolve("/v1/objects/" + key + "/parts?offset=" + offset))
                .timeout(timeout).header("Authorization", "Bearer " + credential).header("X-Ack-Nonce", nonce)
                .header("X-Part-Sha256", hex(chunkDigest)).header("X-Object-Size", Integer.toString(artifact.length))
                .header("X-Object-Sha256", hex(request.artifact().digest()))
                .PUT(HttpRequest.BodyPublishers.ofByteArray(chunk)).build();
        JsonNode ack = signedBody(request, send(request, put), nonce, key, "PART");
        if (ack.path("offset").asLong(-1) != offset || ack.path("nextOffset").asLong(-1) != offset + chunk.length
                || !hex(chunkDigest).equals(ack.path("partSha256").asString())) {
            observe(request, Finding.DESTINATION_REJECTED, offset);
            throw new ReceiverException(Finding.DESTINATION_REJECTED, "part ACK does not bind the exact part");
        }
        observe(request, Finding.PARTIAL, offset + chunk.length);
        ChunkReceipt receipt = new ChunkReceipt("dev-http-receiver-part:" + ack.path("ackId").asString(),
                request.tenantId(), request.principalId(), request.requestId(), request.artifact().artifactId(),
                request.artifact().versionRef(), request.destinationRef(), request.artifact().digest(),
                offset, chunkDigest, chunk.length, offset + chunk.length);
        return new FencedChunkReceipt(receipt, claim.fence());
    }

    @Override
    public FencedReconciliation reconcile(ExportRequest request, DeliveryOperationStore.DispatchClaim claim) {
        requireCurrentClaim(request, claim);
        Status status = status(request);
        Observation observed = observation(request, status);
        int size = request.artifact().bytes().length;
        switch (status.state()) {
            case "ABSENT":
                return new FencedReconciliation(0, Optional.empty(), claim.fence());
            case "PARTIAL": {
                if (status.size() != size || status.receivedBytes() > size) {
                    observe(request, Finding.DESTINATION_REJECTED, status.receivedBytes());
                    throw new ReceiverException(Finding.DESTINATION_REJECTED, "receiver holds a differently sized object");
                }
                int verified = (int) (status.receivedBytes() - status.receivedBytes() % MediaDeliveryEngine.CHUNK_BYTES);
                return new FencedReconciliation(verified, Optional.empty(), claim.fence());
            }
            default:
                if (observed.finding() == Finding.CHECKSUM_MISMATCH) {
                    // The destination is write-once: bytes of another identity are already there. Never overwritten.
                    throw new ReceiverException(Finding.CHECKSUM_MISMATCH,
                            "receiver reports a checksum or size that differs from the artifact");
                }
                DestinationReceipt receipt = new DestinationReceipt("dev-http-receiver-receipt:" + status.ackId(),
                        request.tenantId(), request.principalId(), request.requestId(), request.artifact().artifactId(),
                        request.artifact().versionRef(), request.artifact().digest(), request.destinationRef(),
                        status.size(), "sha256:" + status.sha256());
                return new FencedReconciliation(size,
                        Optional.of(new FencedDestinationReceipt(receipt, claim.fence())), claim.fence());
        }
    }

    private Status status(ExportRequest request) {
        String key = objectKey(request);
        String nonce = nonce();
        HttpRequest get = HttpRequest.newBuilder(base.resolve("/v1/objects/" + key)).timeout(timeout)
                .header("Authorization", "Bearer " + credential).header("X-Ack-Nonce", nonce).GET().build();
        JsonNode body = signedBody(request, send(request, get), nonce, key, "STATUS");
        String state = body.path("state").asString();
        if (!Set.of("ABSENT", "PARTIAL", "COMPLETE").contains(state)) {
            observe(request, Finding.DESTINATION_REJECTED, 0);
            throw new ReceiverException(Finding.DESTINATION_REJECTED, "receiver status state is unknown");
        }
        String sha = body.path("sha256").asString();
        if ("COMPLETE".equals(state) && !KEY.matcher(sha).matches()) {
            observe(request, Finding.DESTINATION_REJECTED, 0);
            throw new ReceiverException(Finding.DESTINATION_REJECTED, "COMPLETE status carries no object checksum");
        }
        return new Status(state, body.path("receivedBytes").asLong(0), body.path("size").asLong(0), sha,
                body.path("ackId").asString());
    }

    private HttpResponse<byte[]> send(ExportRequest request, HttpRequest http) {
        HttpResponse<byte[]> response;
        try {
            response = client.send(http, HttpResponse.BodyHandlers.ofByteArray());
        } catch (IOException failure) {
            observe(request, Finding.DESTINATION_UNREACHABLE, 0);
            throw new ReceiverException(Finding.DESTINATION_UNREACHABLE, "receiver did not return a response");
        } catch (InterruptedException interrupted) {
            Thread.currentThread().interrupt();
            observe(request, Finding.DESTINATION_UNREACHABLE, 0);
            throw new ReceiverException(Finding.DESTINATION_UNREACHABLE, "receiver call interrupted");
        }
        int status = response.statusCode();
        if (status == 401 || status == 403) {
            observe(request, Finding.CREDENTIAL_REVOKED, 0);
            throw new ReceiverException(Finding.CREDENTIAL_REVOKED, "receiver refused the destination credential");
        }
        if (status >= 500) {
            observe(request, Finding.DESTINATION_UNREACHABLE, 0);
            throw new ReceiverException(Finding.DESTINATION_UNREACHABLE, "receiver is unavailable");
        }
        if (status != 200) {
            observe(request, Finding.DESTINATION_REJECTED, 0);
            throw new ReceiverException(Finding.DESTINATION_REJECTED, "receiver rejected the request with " + status);
        }
        return response;
    }

    /** Verifies the HMAC over the exact body, then binds identity, object key, kind and nonce. */
    private JsonNode signedBody(ExportRequest request, HttpResponse<byte[]> response, String nonce, String key, String kind) {
        String header = response.headers().firstValue("X-Ack-Signature").orElse("");
        byte[] body = response.body();
        if (!header.startsWith("v1=") || !MessageDigest.isEqual(
                header.substring(3).getBytes(StandardCharsets.US_ASCII),
                HexFormat.of().formatHex(hmac(body)).getBytes(StandardCharsets.US_ASCII))) {
            observe(request, Finding.ACK_SIGNATURE_INVALID, 0);
            throw new ReceiverException(Finding.ACK_SIGNATURE_INVALID, "receiver ACK signature did not verify");
        }
        JsonNode node;
        try { node = JSON.readTree(body); }
        catch (RuntimeException unreadable) {
            observe(request, Finding.ACK_SIGNATURE_INVALID, 0);
            throw new ReceiverException(Finding.ACK_SIGNATURE_INVALID, "receiver ACK body is unreadable");
        }
        if (!identity.equals(node.path("identity").asString()) || !DESTINATION_ID.equals(node.path("destinationId").asString())) {
            observe(request, Finding.DESTINATION_IDENTITY_MISMATCH, 0);
            throw new ReceiverException(Finding.DESTINATION_IDENTITY_MISMATCH,
                    "receiver identity is not the registered destination");
        }
        if (!key.equals(node.path("objectKey").asString()) || !kind.equals(node.path("kind").asString())
                || !nonce.equals(node.path("nonce").asString())) {
            observe(request, Finding.ACK_SIGNATURE_INVALID, 0);
            throw new ReceiverException(Finding.ACK_SIGNATURE_INVALID, "receiver ACK is not bound to this request");
        }
        return node;
    }

    private byte[] hmac(byte[] data) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(ackKey, "HmacSHA256"));
            return mac.doFinal(data);
        } catch (GeneralSecurityException failure) {
            throw new IllegalStateException("HMAC-SHA256 is unavailable", failure);
        }
    }

    private static String nonce() {
        byte[] bytes = new byte[16];
        RANDOM.nextBytes(bytes);
        return HexFormat.of().formatHex(bytes);
    }

    private static String hex(String digest) {
        return digest.startsWith("sha256:") ? digest.substring("sha256:".length()) : digest;
    }

    private void requireCurrentClaim(ExportRequest request, DeliveryOperationStore.DispatchClaim claim) {
        if (claim == null || !claim.requestId().equals(request.requestId())
                || !claim.tenantId().equals(request.tenantId())
                || !claim.principalId().equals(request.principalId())
                || !claim.destinationRef().equals(request.destinationRef())
                || !operations.isDispatchClaimCurrent(claim)) {
            throw new IllegalStateException("stale or foreign dispatch fence rejected by destination");
        }
    }
}
