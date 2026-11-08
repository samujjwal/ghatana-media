package com.ghatana.audio.video.integration;

import com.ghatana.media.production.delivery.DeliveryOperationStore;
import com.ghatana.media.production.delivery.InMemoryDeliveryOperationStore;
import com.ghatana.media.production.delivery.MediaDeliveryEngine;
import com.ghatana.media.runtime.MediaCreationContracts;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.time.Instant;
import java.util.Optional;

import static com.ghatana.media.production.delivery.MediaDeliveryEngine.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Source-free J-22 protocol scenarios. The destination and authorization are fixture ports only;
 * these tests validate local reconciliation rules and do not prove a real transfer or authority.
 */
class DeliveryDestinationReceiptScenarioTest {
    private static final Instant NOW = Instant.parse("2026-11-05T12:00:00Z");

    @Test
    void wrongDestinationReceiptRemainsUnknownAndHasNoDeliveredReceiptReference() {
        byte[] content = new byte[] { 0x12, 0x34, 0x56 };
        ExportRequest request = request(content, "request-wrong-destination");
        FixtureDestination destination = new FixtureDestination(true, false);
        MediaDeliveryEngine engine = engine(request, destination);

        DeliveryResult first = engine.export(request);
        DeliveryResult replay = engine.export(request);

        assertThat(first.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(first.acknowledgedBytes()).isEqualTo(content.length);
        assertThat(first.destinationReceiptRef()).isEmpty();
        assertThat(replay).isEqualTo(first);
        assertThat(engine.find(request.tenantId(), request.requestId()).orElseThrow().status())
                .isNotEqualTo(Status.DESTINATION_CONFIRMED);
        assertThat(destination.sendCount).isEqualTo(1);
        assertThat(destination.reconcileCount).isEqualTo(1);
    }

    @Test
    void wrongArtifactDigestReceiptRemainsUnknownAndExactReplayDoesNotRepeatEffects() {
        byte[] content = new byte[] { 0x12, 0x34, 0x56 };
        ExportRequest request = request(content, "request-wrong-receipt-digest");
        FixtureDestination destination = new FixtureDestination(false, false, false, true);
        MediaDeliveryEngine engine = engine(request, destination);

        DeliveryResult first = engine.export(request);
        DeliveryResult replay = engine.export(request);

        assertThat(first.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(first.acknowledgedBytes()).isEqualTo(content.length);
        assertThat(first.destinationReceiptRef()).isEmpty();
        assertThat(replay).isEqualTo(first);
        assertThat(engine.find(request.tenantId(), request.requestId()).orElseThrow()).isEqualTo(first);
        assertThat(destination.sendCount).isEqualTo(1);
        assertThat(destination.reconcileCount).isEqualTo(1);
    }

    @Test
    void changedArtifactUnderSameRequestIdIsRejectedWithoutRepeatingDestinationEffect() {
        ExportRequest original = request(new byte[] { 0x12, 0x34, 0x56 }, "request-changed-content");
        FixtureDestination destination = new FixtureDestination(false, false, true);
        MediaDeliveryEngine engine = engine(original, destination);

        DeliveryResult first = engine.export(original);
        ExportRequest changed = request(new byte[] { 0x12, 0x34, 0x57 }, original.requestId());

        assertThat(first.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThatThrownBy(() -> engine.export(changed))
                .isInstanceOfSatisfying(DeliveryException.class, error ->
                        assertThat(error.code()).isEqualTo(DeliveryException.Code.IDEMPOTENCY_CONFLICT));
        assertThat(engine.find(original.tenantId(), original.requestId()).orElseThrow()).isEqualTo(first);
        assertThat(destination.sendCount).isEqualTo(1);
        assertThat(destination.reconcileCount).isEqualTo(1);
    }

    @Test
    void shortFinalReceiptRemainsUnknownAndReplayDoesNotResend() {
        byte[] content = new byte[] { 0x12, 0x34, 0x56 };
        ExportRequest request = request(content, "request-short-final-receipt");
        FixtureDestination destination = new FixtureDestination(false, false, true);
        MediaDeliveryEngine engine = engine(request, destination);

        DeliveryResult result = engine.export(request);
        DeliveryResult replay = engine.export(request);

        assertThat(result.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(result.acknowledgedBytes()).isEqualTo(content.length);
        assertThat(result.destinationReceiptRef()).isEmpty();
        assertThat(replay).isEqualTo(result);
        assertThat(engine.find(request.tenantId(), request.requestId()).orElseThrow().status())
                .isNotEqualTo(Status.DESTINATION_CONFIRMED);
        assertThat(destination.sendCount).isEqualTo(1);
        assertThat(destination.reconcileCount).isEqualTo(1);
    }

    @Test
    void revokedAuthorizationBeforeDispatchRecordsNoDestinationEffect() {
        byte[] content = new byte[] { 0x12, 0x34, 0x56 };
        ExportRequest request = request(content, "request-revoked-before-dispatch");
        FixtureDestination destination = new FixtureDestination(false, false);
        ClaimCapableFixtureStore operations = new ClaimCapableFixtureStore();
        AuthorizationPort revokedAuthorization = new AuthorizationPort() {
            @Override public TransferAuthorization authorize(ExportRequest export) {
                return new TransferAuthorization("fixture-revoked-grant", export.tenantId(), export.principalId(),
                        export.requestId(), export.artifact().artifactId(), export.artifact().versionRef(),
                        export.artifact().digest(), export.destinationRef(), NOW.plusSeconds(60));
            }
            @Override public Boolean isCurrent(TransferAuthorization grant, Instant now) { return Boolean.FALSE; }
        };
        MediaDeliveryEngine engine = new MediaDeliveryEngine(revokedAuthorization, destination, () -> NOW, operations);

        assertThatThrownBy(() -> engine.export(request))
                .isInstanceOfSatisfying(DeliveryException.class, error ->
                        assertThat(error.code()).isEqualTo(DeliveryException.Code.AUTHORIZATION_DENIED));
        assertThat(engine.find(request.tenantId(), request.requestId()).orElseThrow().status()).isEqualTo(Status.REVOKED);
        assertThat(operations.find(request.tenantId(), request.requestId()).orElseThrow().status()).isEqualTo(Status.REVOKED);
        assertThat(destination.sendCount).isZero();
        assertThat(destination.reconcileCount).isZero();
    }

    @Test
    void lostFinalChunkAcknowledgmentReconcilesExactVersionWithoutDuplicateTransfer() {
        byte[] content = new byte[] { 0x21, 0x43, 0x65, 0x7f };
        ExportRequest request = request(content, "request-lost-ack");
        FixtureDestination destination = new FixtureDestination(false, true);
        MediaDeliveryEngine engine = engine(request, destination);

        DeliveryResult uncertain = engine.export(request);
        assertThat(uncertain.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(destination.sendCount).isEqualTo(1); // Fixture accepted the chunk, then lost its ACK.

        DeliveryResult reconciled = engine.reconcileAndResume(request);
        assertThat(reconciled.status()).isEqualTo(Status.DESTINATION_CONFIRMED);
        assertThat(reconciled.artifactId()).isEqualTo(request.artifact().artifactId());
        assertThat(reconciled.versionRef()).isEqualTo(request.artifact().versionRef());
        assertThat(reconciled.artifactDigest()).isEqualTo(request.artifact().digest());
        assertThat(reconciled.destinationRef()).isEqualTo(request.destinationRef());
        assertThat(reconciled.acknowledgedBytes()).isEqualTo(content.length);
        assertThat(reconciled.destinationReceiptRef()).contains("fixture-final-receipt");

        assertThat(engine.export(request)).isEqualTo(reconciled);
        assertThat(destination.sendCount).isEqualTo(1); // Replay and reconciliation did not retransmit accepted bytes.
        assertThat(destination.offset).isEqualTo(content.length);
        assertThat(destination.reconcileCount).isEqualTo(1);
    }

    @Test
    void lostFinalChunkAcknowledgmentSurvivesCoordinatorRestartAndReconcilesWithoutReplay() {
        byte[] content = new byte[] { 0x31, 0x42, 0x53, 0x64 };
        ExportRequest request = request(content, "request-lost-ack-restart");
        FixtureDestination destination = new FixtureDestination(false, true);
        ClaimCapableFixtureStore durableFixtureStore = new ClaimCapableFixtureStore();

        MediaDeliveryEngine beforeRestart = engine(request, destination, durableFixtureStore);
        DeliveryResult uncertain = beforeRestart.export(request);

        assertThat(uncertain.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(uncertain.acknowledgedBytes()).isZero();
        assertThat(destination.sendCount).isEqualTo(1);
        assertThat(durableFixtureStore.find(request.tenantId(), request.requestId()).orElseThrow().status())
                .isEqualTo(Status.OUTCOME_UNKNOWN);

        // A fresh coordinator has no in-memory entry; only the fixture store and destination survive.
        MediaDeliveryEngine afterRestart = engine(request, destination, durableFixtureStore);
        DeliveryResult reconciled = afterRestart.reconcileAndResume(request);

        assertThat(reconciled.status()).isEqualTo(Status.DESTINATION_CONFIRMED);
        assertThat(reconciled.artifactId()).isEqualTo(request.artifact().artifactId());
        assertThat(reconciled.versionRef()).isEqualTo(request.artifact().versionRef());
        assertThat(reconciled.artifactDigest()).isEqualTo(request.artifact().digest());
        assertThat(reconciled.destinationRef()).isEqualTo(request.destinationRef());
        assertThat(reconciled.acknowledgedBytes()).isEqualTo(content.length);
        assertThat(reconciled.destinationReceiptRef()).contains("fixture-final-receipt");
        assertThat(afterRestart.export(request)).isEqualTo(reconciled);
        assertThat(destination.sendCount).isEqualTo(1);
        assertThat(destination.offset).isEqualTo(content.length);
        assertThat(destination.reconcileCount).isEqualTo(1);
    }

    private static ExportRequest request(byte[] content, String requestId) {
        Artifact artifact = new Artifact("tenant-j22", "artifact-j22", "version-3",
                MediaCreationContracts.sha256(content), content);
        return new ExportRequest("tenant-j22", "principal-j22", requestId, artifact, "destination:requested");
    }

    private static MediaDeliveryEngine engine(ExportRequest request, FixtureDestination destination) {
        return engine(request, destination, new ClaimCapableFixtureStore());
    }

    private static MediaDeliveryEngine engine(ExportRequest request, FixtureDestination destination,
                                              DeliveryOperationStore operations) {
        AuthorizationPort authorization = new AuthorizationPort() {
            @Override public TransferAuthorization authorize(ExportRequest export) {
                return new TransferAuthorization("fixture-grant", export.tenantId(), export.principalId(),
                        export.requestId(), export.artifact().artifactId(), export.artifact().versionRef(),
                        export.artifact().digest(), export.destinationRef(), NOW.plusSeconds(60));
            }
            @Override public Boolean isCurrent(TransferAuthorization grant, Instant now) { return Boolean.TRUE; }
        };
        return new MediaDeliveryEngine(authorization, destination, () -> NOW, operations);
    }

    private static final class FixtureDestination implements FencedDestinationPort {
        private final boolean wrongFinalDestination;
        private final boolean loseFirstAcknowledgment;
        private final boolean shortFinalReceipt;
        private final boolean wrongFinalArtifactDigest;
        private int sendCount;
        private int offset;
        private int reconcileCount;

        private FixtureDestination(boolean wrongFinalDestination, boolean loseFirstAcknowledgment) {
            this(wrongFinalDestination, loseFirstAcknowledgment, false, false);
        }

        private FixtureDestination(boolean wrongFinalDestination, boolean loseFirstAcknowledgment,
                                   boolean shortFinalReceipt) {
            this(wrongFinalDestination, loseFirstAcknowledgment, shortFinalReceipt, false);
        }

        private FixtureDestination(boolean wrongFinalDestination, boolean loseFirstAcknowledgment,
                                   boolean shortFinalReceipt, boolean wrongFinalArtifactDigest) {
            this.wrongFinalDestination = wrongFinalDestination;
            this.loseFirstAcknowledgment = loseFirstAcknowledgment;
            this.shortFinalReceipt = shortFinalReceipt;
            this.wrongFinalArtifactDigest = wrongFinalArtifactDigest;
        }

        @Override public FencedChunkReceipt sendChunk(ExportRequest request, int offset, byte[] chunk, String chunkDigest,
                TransferAuthorization authorization, DeliveryOperationStore.DispatchClaim claim) {
            sendCount++;
            this.offset = offset + chunk.length;
            if (loseFirstAcknowledgment && sendCount == 1) {
                throw new IllegalStateException("fixture accepted bytes but lost the response");
            }
            ChunkReceipt receipt = new ChunkReceipt("fixture-chunk-receipt", request.tenantId(), request.principalId(),
                    request.requestId(), request.artifact().artifactId(), request.artifact().versionRef(),
                    request.destinationRef(), request.artifact().digest(), offset, chunkDigest, chunk.length, this.offset);
            return new FencedChunkReceipt(receipt, claim.fence());
        }

        @Override public FencedReconciliation reconcile(ExportRequest request, DeliveryOperationStore.DispatchClaim claim) {
            reconcileCount++;
            Optional<FencedDestinationReceipt> receipt = Optional.empty();
            if (offset == request.artifact().bytes().length) {
                DestinationReceipt finalReceipt = new DestinationReceipt("fixture-final-receipt", request.tenantId(),
                        request.principalId(), request.requestId(), request.artifact().artifactId(),
                        request.artifact().versionRef(), wrongFinalArtifactDigest
                                ? "sha256:wrong-receipt-digest" : request.artifact().digest(),
                        wrongFinalDestination ? "destination:other" : request.destinationRef(),
                        request.artifact().bytes().length - (shortFinalReceipt ? 1 : 0),
                        request.artifact().digest());
                receipt = Optional.of(new FencedDestinationReceipt(finalReceipt, claim.fence()));
            }
            return new FencedReconciliation(offset, receipt, claim.fence());
        }
    }

    /** Local claim-capable test adapter only; it is not durable or evidence of production fencing. */
    private static final class ClaimCapableFixtureStore implements DeliveryOperationStore {
        private final InMemoryDeliveryOperationStore backing = new InMemoryDeliveryOperationStore(() -> NOW);
        @Override public Optional<Operation> find(String tenantId, String requestId) { return backing.find(tenantId, requestId); }
        @Override public boolean insertIfAbsent(Operation operation) { return backing.insertIfAbsent(operation); }
        @Override public boolean update(Operation operation) { return backing.update(operation); }
        @Override public boolean supportsDurableDispatchClaims() { return true; }
        @Override public Optional<DispatchClaim> acquireDispatchClaim(Operation operation, String ownerId, Duration lease) {
            return backing.acquireDispatchClaim(operation, ownerId, lease);
        }
        @Override public Optional<DispatchClaim> renewDispatchClaim(DispatchClaim claim, Duration lease) {
            return backing.renewDispatchClaim(claim, lease);
        }
        @Override public boolean isDispatchClaimCurrent(DispatchClaim claim) { return backing.isDispatchClaimCurrent(claim); }
        @Override public boolean releaseDispatchClaim(DispatchClaim claim) { return backing.releaseDispatchClaim(claim); }
        @Override public boolean update(Operation operation, DispatchClaim claim) { return backing.update(operation, claim); }
    }
}
