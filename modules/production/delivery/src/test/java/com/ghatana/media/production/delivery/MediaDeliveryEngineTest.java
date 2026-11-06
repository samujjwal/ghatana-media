package com.ghatana.media.production.delivery;

import com.ghatana.media.runtime.MediaCreationContracts;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;

import static com.ghatana.media.production.delivery.MediaDeliveryEngine.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaDeliveryEngineTest {
    private static final Instant NOW = Instant.parse("2026-11-05T12:00:00Z");

    @Test
    void requiresExactDestinationReceiptAndChecksumForConfirmation() {
        Fixture f = new Fixture();
        f.destination.badFinalChecksum = true;
        DeliveryResult result = f.engine.export(f.request(bytes(16)));
        assertThat(result.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(result.destinationReceiptRef()).isEmpty();
    }

    @Test
    void receiptFromDifferentDestinationIsNeverConfirmation() {
        Fixture f = new Fixture();
        f.destination.badFinalDestination = true;
        DeliveryResult result = f.engine.export(f.request(bytes(16)));
        assertThat(result.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(result.destinationReceiptRef()).isEmpty();
    }

    @Test
    void transportCompletionWithoutDestinationReceiptIsNotConfirmation() {
        Fixture f = new Fixture();
        f.destination.omitFinalReceipt = true;
        DeliveryResult result = f.engine.export(f.request(bytes(16)));
        assertThat(result.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(f.destination.sendCount).isEqualTo(1);
    }

    @Test
    void lostAcknowledgmentReconcilesBeforeResumingAndConfirmsOnlyWithExactReceipt() {
        Fixture f = new Fixture();
        f.destination.loseFirstAckAfterAccept = true;
        ExportRequest request = f.request(bytes(CHUNK_BYTES + 7));
        DeliveryResult first = f.engine.export(request);
        assertThat(first.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(f.destination.sendCount).isEqualTo(1);

        DeliveryResult resumed = f.engine.reconcileAndResume(request.tenantId(), request.requestId());
        assertThat(resumed.status()).isEqualTo(Status.DESTINATION_CONFIRMED);
        assertThat(resumed.artifactId()).isEqualTo(request.artifact().artifactId());
        assertThat(resumed.versionRef()).isEqualTo(request.artifact().versionRef());
        assertThat(resumed.artifactDigest()).isEqualTo(request.artifact().digest());
        assertThat(resumed.destinationRef()).isEqualTo(request.destinationRef());
        assertThat(f.destination.sendCount).isEqualTo(2); // resumed from destination-reconciled offset
        assertThat(f.destination.offsets).containsExactly(0, CHUNK_BYTES);
    }

    @Test
    void operationLedgerReadbackSurvivesEngineRestartAndResumesExactArtifactVersion() {
        Fixture f = new Fixture();
        f.destination.loseFirstAckAfterAccept = true;
        ExportRequest request = f.request(bytes(CHUNK_BYTES + 7));
        DeliveryResult beforeRestart = f.engine.export(request);
        assertThat(beforeRestart.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(f.operations.find(request.tenantId(), request.requestId())).get()
                .extracting(DeliveryOperationStore.Operation::artifactId,
                        DeliveryOperationStore.Operation::versionRef,
                        DeliveryOperationStore.Operation::status)
                .containsExactly(request.artifact().artifactId(), request.artifact().versionRef(), Status.OUTCOME_UNKNOWN);

        MediaDeliveryEngine restarted = new MediaDeliveryEngine(f.authorization, f.destination, () -> NOW, f.operations);
        assertThat(restarted.find(request.tenantId(), request.requestId())).get()
                .extracting(DeliveryResult::artifactId, DeliveryResult::versionRef, DeliveryResult::status)
                .containsExactly(request.artifact().artifactId(), request.artifact().versionRef(), Status.OUTCOME_UNKNOWN);
        DeliveryResult resumed = restarted.reconcileAndResume(request);
        assertThat(resumed.status()).isEqualTo(Status.DESTINATION_CONFIRMED);
        assertThat(resumed.artifactId()).isEqualTo(request.artifact().artifactId());
        assertThat(resumed.versionRef()).isEqualTo(request.artifact().versionRef());
        assertThat(f.destination.offsets).containsExactly(0, CHUNK_BYTES);
    }

    @Test
    void failedPersistenceAfterChunkAckKeepsPriorUnknownStateVisible() {
        Fixture f = new Fixture();
        InMemoryDeliveryOperationStore backing = new InMemoryDeliveryOperationStore();
        DeliveryOperationStore failing = new DeliveryOperationStore() {
            @Override public Optional<Operation> find(String tenantId, String requestId) {
                return backing.find(tenantId, requestId);
            }
            @Override public boolean insertIfAbsent(Operation operation) { return backing.insertIfAbsent(operation); }
            @Override public boolean update(Operation operation) {
                if (operation.status() == Status.SENT) throw new IllegalStateException("simulated ledger write failure after ACK");
                return backing.update(operation);
            }
        };
        MediaDeliveryEngine engine = new MediaDeliveryEngine(f.authorization, f.destination, () -> NOW, failing);
        ExportRequest request = f.request(bytes(24));

        assertThatThrownBy(() -> engine.export(request)).isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("simulated ledger write failure");
        assertThat(engine.find(request.tenantId(), request.requestId())).get()
                .extracting(DeliveryResult::status, DeliveryResult::acknowledgedBytes)
                .containsExactly(Status.OUTCOME_UNKNOWN, 0);
        assertThat(backing.find(request.tenantId(), request.requestId())).get()
                .extracting(DeliveryOperationStore.Operation::status,
                        DeliveryOperationStore.Operation::acknowledgedBytes)
                .containsExactly(Status.OUTCOME_UNKNOWN, 0);
        assertThat(f.destination.sendCount).isEqualTo(1);
    }

    @Test
    void revokedTokenStopsBeforeFirstExternalChunk() {
        Fixture f = new Fixture();
        f.authorization.revoked.set(true);
        ExportRequest request = f.request(bytes(32));
        assertThatThrownBy(() -> f.engine.export(request))
                .isInstanceOf(DeliveryException.class)
                .extracting(e -> ((DeliveryException) e).code())
                .isEqualTo(DeliveryException.Code.AUTHORIZATION_DENIED);
        assertThat(f.engine.find(request.tenantId(), request.requestId()).orElseThrow().status()).isEqualTo(Status.REVOKED);
        assertThat(f.destination.sendCount).isZero();
    }

    @Test
    void currentnessNullOrFailureBeforeDispatchIsTypedUnavailable() {
        for (boolean throwsFailure : List.of(false, true)) {
            Fixture f = new Fixture();
            f.authorization.currentnessUnavailable = !throwsFailure;
            f.authorization.throwCurrentness = throwsFailure;
            ExportRequest request = f.request(bytes(12));
            assertThatThrownBy(() -> f.engine.export(request))
                    .isInstanceOf(DeliveryException.class)
                    .extracting(e -> ((DeliveryException) e).code())
                    .isEqualTo(DeliveryException.Code.AUTHORIZATION_UNAVAILABLE);
            assertThat(f.engine.find(request.tenantId(), request.requestId()).orElseThrow().status()).isEqualTo(Status.UNAVAILABLE);
            assertThat(f.destination.sendCount).isZero();
        }
    }

    @Test
    void currentnessNullOrFailureAfterPartialDispatchBecomesUnknown() {
        for (boolean throwsFailure : List.of(false, true)) {
            Fixture f = new Fixture();
            f.destination.afterFirstSend = () -> {
                f.authorization.currentnessUnavailable = !throwsFailure;
                f.authorization.throwCurrentness = throwsFailure;
            };
            DeliveryResult result = f.engine.export(f.request(bytes(CHUNK_BYTES + 5)));
            assertThat(result.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
            assertThat(f.destination.sendCount).isEqualTo(1);
        }
    }

    @Test
    void nullDestinationReconciliationRemainsOutcomeUnknown() {
        Fixture noReadback = new Fixture();
        noReadback.destination.nullReconciliation = true;
        assertThat(noReadback.engine.export(noReadback.request(bytes(12))).status()).isEqualTo(Status.OUTCOME_UNKNOWN);

        Fixture lostAck = new Fixture();
        lostAck.destination.loseFirstAckAfterAccept = true;
        ExportRequest request = lostAck.request(bytes(CHUNK_BYTES + 1));
        assertThat(lostAck.engine.export(request).status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        lostAck.destination.nullReconciliation = true;
        assertThat(lostAck.engine.reconcileAndResume(request.tenantId(), request.requestId()).status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(lostAck.destination.sendCount).isEqualTo(1);
    }

    @Test
    void revocationAfterPartialSendStopsFurtherChunksAndKeepsOutcomeUnknown() {
        Fixture f = new Fixture();
        f.destination.afterFirstSend = () -> f.authorization.revoked.set(true);
        DeliveryResult result = f.engine.export(f.request(bytes(CHUNK_BYTES + 2)));
        assertThat(result.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(result.acknowledgedBytes()).isEqualTo(CHUNK_BYTES);
        assertThat(f.destination.sendCount).isEqualTo(1);
    }

    @Test
    void duplicateExactExportDoesNotRepeatDestinationEffectAndKeyReuseConflicts() {
        Fixture f = new Fixture();
        ExportRequest request = f.request(bytes(32));
        DeliveryResult first = f.engine.export(request);
        DeliveryResult duplicate = f.engine.export(request);
        assertThat(first.status()).isEqualTo(Status.DESTINATION_CONFIRMED);
        assertThat(duplicate).isEqualTo(first);
        assertThat(f.destination.sendCount).isEqualTo(1);

        ExportRequest wrongDestination = new ExportRequest(request.tenantId(), request.principalId(), request.requestId(), request.artifact(), "destination:other");
        assertThatThrownBy(() -> f.engine.export(wrongDestination))
                .isInstanceOf(DeliveryException.class)
                .extracting(e -> ((DeliveryException) e).code())
                .isEqualTo(DeliveryException.Code.IDEMPOTENCY_CONFLICT);
    }

    @Test
    void wrongAuthorizationDestinationFailsClosed() {
        Fixture f = new Fixture();
        f.authorization.wrongDestination = true;
        ExportRequest request = f.request(bytes(16));
        assertThatThrownBy(() -> f.engine.export(request)).isInstanceOf(DeliveryException.class);
        assertThat(f.destination.sendCount).isZero();
    }

    @Test
    void principalMustMatchAuthorizationAndDestinationEvidenceScope() {
        Fixture badGrant = new Fixture();
        badGrant.authorization.wrongPrincipal = true;
        ExportRequest request = badGrant.request(bytes(16));
        assertThatThrownBy(() -> badGrant.engine.export(request)).isInstanceOf(DeliveryException.class);
        assertThat(badGrant.destination.sendCount).isZero();

        Fixture badReceipt = new Fixture();
        badReceipt.destination.badFinalPrincipal = true;
        assertThat(badReceipt.engine.export(badReceipt.request(bytes(16))).status()).isEqualTo(Status.OUTCOME_UNKNOWN);
    }

    @Test
    void invalidArtifactDigestAndOversizedContentAreRejectedAtBoundary() {
        byte[] content = bytes(8);
        assertThatThrownBy(() -> new Artifact("tenant", "a", "v1", "sha256:" + "0".repeat(64), content))
                .isInstanceOf(DeliveryException.class);
        byte[] oversized = bytes(MAX_ARTIFACT_BYTES + 1);
        assertThatThrownBy(() -> new Artifact("tenant", "a", "v1", "sha256:" + "0".repeat(64), oversized))
                .isInstanceOf(DeliveryException.class);
    }

    @Test
    void sourceArtifactBytesAreDefensivelyCopied() {
        byte[] source = bytes(24);
        Artifact artifact = new Artifact("tenant", "artifact", "version:7", MediaCreationContracts.sha256(source), source);
        source[0] ^= 0x7f;
        byte[] exposed = artifact.bytes();
        exposed[1] ^= 0x55;
        assertThat(artifact.digest()).isEqualTo(MediaCreationContracts.sha256(bytesPattern(24)));
    }

    private static byte[] bytes(int length) { return bytesPattern(length); }
    private static byte[] bytesPattern(int length) {
        byte[] value = new byte[length];
        for (int i = 0; i < length; i++) value[i] = (byte) (i * 31 + 7);
        return value;
    }

    private static final class Fixture {
        final FakeAuthorization authorization = new FakeAuthorization();
        final FakeDestination destination = new FakeDestination();
        final InMemoryDeliveryOperationStore operations = new InMemoryDeliveryOperationStore();
        final MediaDeliveryEngine engine = new MediaDeliveryEngine(authorization, destination, () -> NOW, operations);
        ExportRequest request(byte[] bytes) {
            Artifact artifact = new Artifact("tenant:1", "artifact:1", "version:1", MediaCreationContracts.sha256(bytes), bytes);
        return new ExportRequest("tenant:1", "principal:1", "request:1", artifact, "destination:exact");
        }
    }

    private static final class FakeAuthorization implements AuthorizationPort {
        final AtomicBoolean revoked = new AtomicBoolean();
        boolean wrongDestination;
        boolean wrongPrincipal;
        boolean currentnessUnavailable;
        boolean throwCurrentness;
        @Override public TransferAuthorization authorize(ExportRequest r) {
            return new TransferAuthorization("token:local", r.tenantId(), wrongPrincipal ? "principal:other" : r.principalId(), r.requestId(),
                    r.artifact().artifactId(), r.artifact().versionRef(), r.artifact().digest(),
                    wrongDestination ? "destination:wrong" : r.destinationRef(), NOW.plusSeconds(60));
        }
        @Override public Boolean isCurrent(TransferAuthorization a, Instant now) {
            if (throwCurrentness) throw new IllegalStateException("currentness authority unavailable");
            if (currentnessUnavailable) return null;
            return !revoked.get();
        }
    }

    private static final class FakeDestination implements DestinationPort {
        int sendCount;
        int acceptedOffset;
        boolean loseFirstAckAfterAccept;
        boolean omitFinalReceipt;
        boolean badFinalChecksum;
        boolean badFinalDestination;
        boolean badFinalPrincipal;
        boolean nullReconciliation;
        Runnable afterFirstSend = () -> { };
        final List<Integer> offsets = new ArrayList<>();
        @Override public ChunkReceipt sendChunk(ExportRequest r, int offset, byte[] chunk, String chunkDigest,
                                                TransferAuthorization authorization) {
            sendCount++;
            offsets.add(offset);
            acceptedOffset = offset + chunk.length;
            if (sendCount == 1) afterFirstSend.run();
            if (loseFirstAckAfterAccept && sendCount == 1) throw new IllegalStateException("simulated response lost after destination accepted chunk");
            return new ChunkReceipt("chunk-receipt:" + sendCount, r.tenantId(), r.principalId(), r.requestId(),
                    r.artifact().artifactId(), r.artifact().versionRef(), r.destinationRef(),
                    r.artifact().digest(), offset, chunkDigest, chunk.length, acceptedOffset);
        }
        @Override public Reconciliation reconcile(ExportRequest r) {
            if (nullReconciliation) return null;
            if (omitFinalReceipt || acceptedOffset != r.artifact().bytes().length) {
                return new Reconciliation(acceptedOffset, Optional.empty());
            }
            DestinationReceipt receipt = new DestinationReceipt("destination-receipt:1", r.tenantId(),
                    badFinalPrincipal ? "principal:other" : r.principalId(), r.requestId(),
                    r.artifact().artifactId(), r.artifact().versionRef(), r.artifact().digest(),
                    badFinalDestination ? "destination:wrong" : r.destinationRef(),
                    r.artifact().bytes().length, badFinalChecksum ? "sha256:" + "0".repeat(64) : r.artifact().digest());
            return new Reconciliation(acceptedOffset, Optional.of(receipt));
        }
    }
}
