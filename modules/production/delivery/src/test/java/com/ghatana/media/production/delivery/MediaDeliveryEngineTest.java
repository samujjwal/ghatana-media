package com.ghatana.media.production.delivery;

import com.ghatana.media.runtime.MediaCreationContracts;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.concurrent.atomic.AtomicReference;

import static com.ghatana.media.production.delivery.MediaDeliveryEngine.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaDeliveryEngineTest {
    private static final Instant NOW = Instant.parse("2026-11-05T12:00:00Z");

    @Test
    void rejectsDeliveryRowsAndResultsWithoutAState() {
        assertThatThrownBy(() -> new DeliveryOperationStore.Operation(
                "tenant:1", "principal:1", "request:1", "artifact:1", "version:1", "sha256:artifact",
                "destination:1", "sha256:request", null, 0, null))
                .isInstanceOf(NullPointerException.class)
                .hasMessageContaining("status");

        assertThatThrownBy(() -> new DeliveryResult(
                "tenant:1", "principal:1", "request:1", "artifact:1", "version:1", "sha256:artifact",
                "destination:1", null, 0, Optional.empty()))
                .isInstanceOf(NullPointerException.class)
                .hasMessageContaining("status");
    }

    @Test
    void confirmedDeliveryRequiresANonBlankDestinationReceiptReference() {
        assertThatThrownBy(() -> new DeliveryOperationStore.Operation(
                "tenant:1", "principal:1", "request:1", "artifact:1", "version:1", "sha256:artifact",
                "destination:1", "sha256:request", Status.DESTINATION_CONFIRMED, 16, "  "))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("destinationReceiptRef must not be blank");

        assertThatThrownBy(() -> new DeliveryResult(
                "tenant:1", "principal:1", "request:1", "artifact:1", "version:1", "sha256:artifact",
                "destination:1", Status.DESTINATION_CONFIRMED, 16, Optional.of("  ")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("destinationReceiptRef must not be blank");

        assertThatThrownBy(() -> new DeliveryOperationStore.Operation(
                "tenant:1", "principal:1", "request:1", "artifact:1", "version:1", "sha256:artifact",
                "destination:1", "sha256:request", Status.DESTINATION_CONFIRMED, 16, "\u0000"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("destinationReceiptRef must not be blank");
        assertThatThrownBy(() -> new DeliveryResult(
                "tenant:1", "principal:1", "request:1", "artifact:1", "version:1", "sha256:artifact",
                "destination:1", Status.DESTINATION_CONFIRMED, 16, Optional.of("\u0000")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("destinationReceiptRef must not be blank");
    }

    @Test
    void rejectsAcknowledgedOffsetsThatCannotBelongToTheirDeliveryState() {
        assertThatThrownBy(() -> new DeliveryOperationStore.Operation(
                "tenant:1", "principal:1", "request:1", "artifact:1", "version:1", "sha256:artifact",
                "destination:1", "sha256:request", Status.QUEUED, 1, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("inconsistent with delivery status");
        assertThatThrownBy(() -> new DeliveryOperationStore.Operation(
                "tenant:1", "principal:1", "request:1", "artifact:1", "version:1", "sha256:artifact",
                "destination:1", "sha256:request", Status.SENT, 0, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("inconsistent with delivery status");
        assertThatThrownBy(() -> new DeliveryOperationStore.Operation(
                "tenant:1", "principal:1", "request:1", "artifact:1", "version:1", "sha256:artifact",
                "destination:1", "sha256:request", Status.REVOKED, 1, null))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("inconsistent with delivery status");

        assertThatThrownBy(() -> new DeliveryResult(
                "tenant:1", "principal:1", "request:1", "artifact:1", "version:1", "sha256:artifact",
                "destination:1", Status.DESTINATION_CONFIRMED, 0, Optional.of("receipt:1")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("inconsistent with delivery status");
    }

    @Test
    void delimiterBearingTenantAndRequestIdsRemainDistinctOperationKeys() {
        Fixture f = new Fixture();
        byte[] bytes = bytes(16);
        String digest = MediaCreationContracts.sha256(bytes);
        Artifact artifactA = new Artifact("tenant:1", "artifact:1", "version:1", digest, bytes);
        Artifact artifactB = new Artifact("tenant:1\u0000left", "artifact:1", "version:1", digest, bytes);
        ExportRequest requestA = new ExportRequest("tenant:1", "principal:1", "left\u0000request:1",
                artifactA, "destination:exact");
        ExportRequest requestB = new ExportRequest("tenant:1\u0000left", "principal:1", "request:1",
                artifactB, "destination:exact");
        assertThat(requestA.tenantId() + "\u0000" + requestA.requestId())
                .isEqualTo(requestB.tenantId() + "\u0000" + requestB.requestId());

        assertThat(f.engine.export(requestA).status()).isEqualTo(Status.DESTINATION_CONFIRMED);
        assertThat(f.engine.export(requestB).status()).isEqualTo(Status.DESTINATION_CONFIRMED);
        assertThat(f.operations.find(requestA.tenantId(), requestA.requestId())).isPresent();
        assertThat(f.operations.find(requestB.tenantId(), requestB.requestId())).isPresent();
        assertThat(f.engine.find(requestA.tenantId(), requestA.requestId())).get()
                .extracting(DeliveryResult::tenantId, DeliveryResult::requestId)
                .containsExactly(requestA.tenantId(), requestA.requestId());
        assertThat(f.engine.find(requestB.tenantId(), requestB.requestId())).get()
                .extracting(DeliveryResult::tenantId, DeliveryResult::requestId)
                .containsExactly(requestB.tenantId(), requestB.requestId());

        MediaDeliveryEngine restarted = new MediaDeliveryEngine(f.authorization, f.destination, () -> NOW, f.operations);
        assertThat(restarted.find(requestA.tenantId(), requestA.requestId())).get()
                .extracting(DeliveryResult::tenantId, DeliveryResult::requestId)
                .containsExactly(requestA.tenantId(), requestA.requestId());
        assertThat(restarted.find(requestB.tenantId(), requestB.requestId())).get()
                .extracting(DeliveryResult::tenantId, DeliveryResult::requestId)
                .containsExactly(requestB.tenantId(), requestB.requestId());
    }

    @Test
    void durableReadbackRejectsDelimiterCollisionInArtifactAndVersionScope() {
        Fixture f = new Fixture();
        byte[] content = bytes(16);
        String digest = MediaCreationContracts.sha256(content);
        ExportRequest first = new ExportRequest("tenant:1", "principal:1", "request:1",
                new Artifact("tenant:1", "artifact\nversion", "tail", digest, content), "destination:exact");
        ExportRequest collision = new ExportRequest("tenant:1", "principal:1", "request:1",
                new Artifact("tenant:1", "artifact", "version\ntail", digest, content), "destination:exact");

        assertThat(String.join("\n", first.tenantId(), first.principalId(), first.requestId(),
                first.artifact().artifactId(), first.artifact().versionRef(), first.artifact().digest(), first.destinationRef()))
                .isEqualTo(String.join("\n", collision.tenantId(), collision.principalId(), collision.requestId(),
                        collision.artifact().artifactId(), collision.artifact().versionRef(), collision.artifact().digest(),
                        collision.destinationRef()));
        assertThat(f.engine.export(first).status()).isEqualTo(Status.DESTINATION_CONFIRMED);

        MediaDeliveryEngine restarted = new MediaDeliveryEngine(f.authorization, f.destination, () -> NOW, f.operations);
        assertThatThrownBy(() -> restarted.export(collision))
                .isInstanceOf(DeliveryException.class)
                .extracting(error -> ((DeliveryException) error).code())
                .isEqualTo(DeliveryException.Code.IDEMPOTENCY_CONFLICT);
        assertThat(f.destination.sendCount).isEqualTo(1);
    }

    @Test
    void findUsesCachedTypedKeyAndRejectsMismatchedDurableReadback() {
        Fixture f = new Fixture();
        ExportRequest request = f.request(bytes(16));
        f.engine.export(request);
        DeliveryOperationStore.Operation mismatched = new DeliveryOperationStore.Operation(
                request.tenantId(), "principal:other", request.requestId(), "artifact:other",
                request.artifact().versionRef(), request.artifact().digest(), request.destinationRef(),
                "different-fingerprint", Status.DESTINATION_CONFIRMED, request.artifact().bytes().length,
                "destination-receipt:other");
        f.operations.overrideFind(mismatched);

        assertThatThrownBy(() -> f.engine.find(request.tenantId(), request.requestId()))
                .isInstanceOf(DeliveryException.class)
                .hasMessageContaining("readback differs from exact immutable request scope");
    }

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
    void chunkReceiptFromWrongDestinationCannotAdvanceAcknowledgedOffset() {
        Fixture f = new Fixture();
        f.destination.badChunkDestination = true;
        ExportRequest request = f.request(bytes(16));

        DeliveryResult result = f.engine.export(request);
        assertThat(result.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(result.acknowledgedBytes()).isZero();
        assertThat(result.destinationReceiptRef()).isEmpty();
        assertThat(f.engine.find(request.tenantId(), request.requestId()).orElseThrow())
                .extracting(DeliveryResult::status, DeliveryResult::acknowledgedBytes,
                        DeliveryResult::destinationReceiptRef)
                .containsExactly(Status.OUTCOME_UNKNOWN, 0, Optional.empty());
        assertThat(f.destination.sendCount).isEqualTo(1);
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
    void chunkReceiptWithWrongDigestCannotAdvanceAcknowledgedOffset() {
        Fixture f = new Fixture();
        f.destination.wrongChunkDigest = true;
        ExportRequest request = f.request(bytes(16));

        DeliveryResult uncertain = f.engine.export(request);
        assertThat(uncertain.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(uncertain.acknowledgedBytes()).isZero();
        assertThat(f.operations.find(request.tenantId(), request.requestId())).get()
                .extracting(DeliveryOperationStore.Operation::status,
                        DeliveryOperationStore.Operation::acknowledgedBytes,
                        DeliveryOperationStore.Operation::destinationReceiptRef)
                .containsExactly(Status.OUTCOME_UNKNOWN, 0, null);

        DeliveryResult reconciled = f.engine.reconcileAndResume(request);
        assertThat(reconciled.status()).isEqualTo(Status.DESTINATION_CONFIRMED);
        assertThat(reconciled.acknowledgedBytes()).isEqualTo(request.artifact().bytes().length);
        assertThat(reconciled.destinationReceiptRef()).contains("destination-receipt:1");
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
        assertThat(f.engine.export(request)).isEqualTo(resumed);
        assertThat(f.destination.sendCount).isEqualTo(2);
    }

    @Test
    void queuedOperationAfterPreDispatchCrashReauthorizesAndResumesAfterRestart() {
        Fixture f = new Fixture();
        ExportRequest request = f.request(bytes(24));
        DeliveryOperationStore crashBeforeUnknown = new DeliveryOperationStore() {
            @Override public Optional<Operation> find(String tenantId, String requestId) {
                return f.operations.find(tenantId, requestId);
            }
            @Override public boolean insertIfAbsent(Operation operation) {
                return f.operations.insertIfAbsent(operation);
            }
            @Override public boolean update(Operation operation) { return f.operations.update(operation); }
            @Override public boolean supportsDurableDispatchClaims() { return true; }
            @Override public Optional<DispatchClaim> acquireDispatchClaim(Operation operation, String ownerId,
                    Duration lease) { return f.operations.acquireDispatchClaim(operation, ownerId, lease); }
            @Override public Optional<DispatchClaim> renewDispatchClaim(DispatchClaim claim, Duration lease) {
                return f.operations.renewDispatchClaim(claim, lease);
            }
            @Override public boolean isDispatchClaimCurrent(DispatchClaim claim) {
                return f.operations.isDispatchClaimCurrent(claim);
            }
            @Override public boolean releaseDispatchClaim(DispatchClaim claim) {
                return f.operations.releaseDispatchClaim(claim);
            }
            @Override public boolean update(Operation operation, DispatchClaim claim) {
                if (operation.status() == Status.OUTCOME_UNKNOWN) {
                    throw new IllegalStateException("simulated process stop before pre-dispatch barrier");
                }
                return f.operations.update(operation, claim);
            }
        };
        MediaDeliveryEngine firstProcess = new MediaDeliveryEngine(
                f.authorization, f.destination, () -> NOW, crashBeforeUnknown);

        assertThatThrownBy(() -> firstProcess.export(request))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("before pre-dispatch barrier");
        assertThat(f.operations.find(request.tenantId(), request.requestId())).get()
                .extracting(DeliveryOperationStore.Operation::status,
                        DeliveryOperationStore.Operation::acknowledgedBytes)
                .containsExactly(Status.QUEUED, 0);
        assertThat(f.destination.sendCount).isZero();

        MediaDeliveryEngine restarted = new MediaDeliveryEngine(
                f.authorization, f.destination, () -> NOW, f.operations);
        assertThat(restarted.reconcileAndResume(request).status()).isEqualTo(Status.DESTINATION_CONFIRMED);
        assertThat(f.destination.offsets).containsExactly(0);
    }

    @Test
    void failedPreDispatchBarrierUpdateNeverCallsDestinationWhileClaimIsLive() {
        Fixture f = new Fixture();
        DeliveryOperationStore barrierFailure = new DeliveryOperationStore() {
            @Override public Optional<Operation> find(String tenantId, String requestId) {
                return f.operations.find(tenantId, requestId);
            }
            @Override public boolean insertIfAbsent(Operation operation) {
                return f.operations.insertIfAbsent(operation);
            }
            @Override public boolean update(Operation operation) { return f.operations.update(operation); }
            @Override public boolean supportsDurableDispatchClaims() { return true; }
            @Override public Optional<DispatchClaim> acquireDispatchClaim(Operation operation, String ownerId,
                    Duration lease) { return f.operations.acquireDispatchClaim(operation, ownerId, lease); }
            @Override public Optional<DispatchClaim> renewDispatchClaim(DispatchClaim claim, Duration lease) {
                return f.operations.renewDispatchClaim(claim, lease);
            }
            @Override public boolean isDispatchClaimCurrent(DispatchClaim claim) {
                return f.operations.isDispatchClaimCurrent(claim);
            }
            @Override public boolean releaseDispatchClaim(DispatchClaim claim) {
                return f.operations.releaseDispatchClaim(claim);
            }
            @Override public boolean update(Operation operation, DispatchClaim claim) {
                if (operation.status() == Status.OUTCOME_UNKNOWN) return false;
                return f.operations.update(operation, claim);
            }
        };
        MediaDeliveryEngine engine = new MediaDeliveryEngine(
                f.authorization, f.destination, () -> NOW, barrierFailure);

        assertThat(engine.export(f.request(bytes(24))).status()).isEqualTo(Status.QUEUED);
        assertThat(f.destination.sendCount).isZero();
        assertThat(f.operations.find("tenant:1", "request:1")).get()
                .extracting(DeliveryOperationStore.Operation::status,
                        DeliveryOperationStore.Operation::acknowledgedBytes)
                .containsExactly(Status.QUEUED, 0);
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
            @Override public boolean supportsDurableDispatchClaims() { return true; } // Deterministic test double only.
            @Override public boolean update(Operation operation) {
                if (operation.status() == Status.SENT) throw new IllegalStateException("simulated ledger write failure after ACK");
                return backing.update(operation);
            }
            @Override public Optional<DispatchClaim> acquireDispatchClaim(Operation operation, String ownerId,
                    Duration lease) { return backing.acquireDispatchClaim(operation, ownerId, lease); }
            @Override public Optional<DispatchClaim> renewDispatchClaim(DispatchClaim claim, Duration lease) {
                return backing.renewDispatchClaim(claim, lease);
            }
            @Override public boolean isDispatchClaimCurrent(DispatchClaim claim) {
                return backing.isDispatchClaimCurrent(claim);
            }
            @Override public boolean releaseDispatchClaim(DispatchClaim claim) {
                return backing.releaseDispatchClaim(claim);
            }
            @Override public boolean update(Operation operation, DispatchClaim claim) {
                if (operation.status() == Status.SENT) {
                    throw new IllegalStateException("simulated ledger write failure after ACK");
                }
                return backing.update(operation, claim);
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
    void revokedAuthorizationDuringLostAckResumeDoesNotSendAnotherChunk() {
        Fixture f = new Fixture();
        f.destination.loseFirstAckAfterAccept = true;
        ExportRequest request = f.request(bytes(CHUNK_BYTES + 7));

        DeliveryResult afterLostAck = f.engine.export(request);
        assertThat(afterLostAck.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(f.destination.sendCount).isEqualTo(1);

        f.authorization.revoked.set(true);
        DeliveryResult resumed = f.engine.reconcileAndResume(request);

        assertThat(resumed.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(resumed.acknowledgedBytes()).isEqualTo(CHUNK_BYTES);
        assertThat(resumed.destinationReceiptRef()).isEmpty();
        assertThat(f.destination.sendCount).isEqualTo(1);
        assertThat(f.destination.offsets).containsExactly(0);
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

    @Test
    void durableDispatchClaimFencesExpiredOwnerAndScopesExactOperation() {
        AtomicReference<Instant> now = new AtomicReference<>(NOW);
        InMemoryDeliveryOperationStore store = new InMemoryDeliveryOperationStore(now::get);
        Fixture fixture = new Fixture();
        ExportRequest request = fixture.request(bytes(8));
        DeliveryOperationStore.Operation operation = new DeliveryOperationStore.Operation(
                request.tenantId(), request.principalId(), request.requestId(), request.artifact().artifactId(),
                request.artifact().versionRef(), request.artifact().digest(), request.destinationRef(),
                "a".repeat(64), Status.QUEUED, 0, null);
        assertThat(store.insertIfAbsent(operation)).isTrue();
        DeliveryOperationStore.Operation illegalSent = new DeliveryOperationStore.Operation(
                operation.tenantId(), operation.principalId(), operation.requestId(), operation.artifactId(),
                operation.versionRef(), operation.artifactDigest(), operation.destinationRef(),
                operation.requestFingerprint(), Status.SENT, 8, null);
        assertThat(store.update(illegalSent)).isFalse();

        DeliveryOperationStore.DispatchClaim first = store.acquireDispatchClaim(
                operation, "worker-a", Duration.ofSeconds(10)).orElseThrow();
        assertThat(store.acquireDispatchClaim(operation, "worker-b", Duration.ofSeconds(10))).isEmpty();
        assertThat(store.update(illegalSent, first)).isFalse();
        assertThat(store.update(new DeliveryOperationStore.Operation(
                operation.tenantId(), operation.principalId(), operation.requestId(), operation.artifactId(),
                operation.versionRef(), operation.artifactDigest(), operation.destinationRef(),
                operation.requestFingerprint(), Status.UNAVAILABLE, 0, null))).isFalse();
        assertThat(first.matches(operation)).isTrue();
        assertThat(store.isDispatchClaimCurrent(first)).isTrue();
        now.set(NOW.plusSeconds(5));
        DeliveryOperationStore.DispatchClaim renewed = store.renewDispatchClaim(
                first, Duration.ofSeconds(10)).orElseThrow();
        assertThat(renewed.fence()).isEqualTo(first.fence());
        assertThat(renewed.expiresAt()).isAfter(first.expiresAt());

        now.set(NOW.plusSeconds(16));
        DeliveryOperationStore.DispatchClaim second = store.acquireDispatchClaim(
                operation, "worker-b", Duration.ofSeconds(10)).orElseThrow();
        assertThat(second.fence()).isGreaterThan(first.fence());
        assertThat(store.isDispatchClaimCurrent(first)).isFalse();
        assertThat(store.releaseDispatchClaim(renewed)).isFalse();
        assertThat(store.update(new DeliveryOperationStore.Operation(
                operation.tenantId(), operation.principalId(), operation.requestId(), operation.artifactId(),
                operation.versionRef(), operation.artifactDigest(), operation.destinationRef(),
                operation.requestFingerprint(), Status.SENT, 8, null), first)).isFalse();
        assertThat(store.isDispatchClaimCurrent(second)).isTrue();
        assertThat(store.releaseDispatchClaim(second)).isTrue();
        assertThat(store.acquireDispatchClaim(operation, "worker-c", Duration.ofSeconds(10))
                .orElseThrow().fence()).isGreaterThan(second.fence());
    }

    @Test
    void legacyUnfencedDestinationIsNeverCalled() {
        Fixture f = new Fixture();
        AtomicBoolean called = new AtomicBoolean();
        DestinationPort legacy = new DestinationPort() {
            @Override public ChunkReceipt sendChunk(ExportRequest request, int offset, byte[] chunk,
                    String digest, TransferAuthorization authorization) {
                called.set(true);
                throw new AssertionError("unfenced destination must not be called");
            }
            @Override public Reconciliation reconcile(ExportRequest request) {
                called.set(true);
                throw new AssertionError("unfenced destination must not be called");
            }
        };
        MediaDeliveryEngine engine = new MediaDeliveryEngine(f.authorization, legacy, () -> NOW, f.operations);

        assertThat(engine.export(f.request(bytes(8))).status()).isEqualTo(Status.UNAVAILABLE);
        assertThat(called).isFalse();
    }

    @Test
    void destinationReceiptAndReadbackMustEchoCurrentDispatchFence() {
        Fixture chunkFence = new Fixture();
        chunkFence.destination.wrongChunkFence = true;
        assertThat(chunkFence.engine.export(chunkFence.request(bytes(8))).status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(chunkFence.engine.find("tenant:1", "request:1").orElseThrow().destinationReceiptRef()).isEmpty();

        Fixture reconciliationFence = new Fixture();
        reconciliationFence.destination.wrongReconciliationFence = true;
        assertThat(reconciliationFence.engine.export(reconciliationFence.request(bytes(8))).status())
                .isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(reconciliationFence.destination.sendCount).isEqualTo(1);

        Fixture finalFence = new Fixture();
        finalFence.destination.wrongFinalReceiptFence = true;
        assertThat(finalFence.engine.export(finalFence.request(bytes(8))).status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(finalFence.engine.find("tenant:1", "request:1").orElseThrow().destinationReceiptRef()).isEmpty();
    }

    @Test
    void processLocalClaimStoreCannotAuthorizeDestinationDispatch() {
        Fixture f = new Fixture();
        MediaDeliveryEngine engine = new MediaDeliveryEngine(
                f.authorization, f.destination, () -> NOW, new InMemoryDeliveryOperationStore());

        assertThat(engine.export(f.request(bytes(8))).status()).isEqualTo(Status.UNAVAILABLE);
        assertThat(f.destination.sendCount).isZero();
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
        final ClaimCapableTestStore operations = new ClaimCapableTestStore();
        final MediaDeliveryEngine engine = new MediaDeliveryEngine(authorization, destination, () -> NOW, operations);
        ExportRequest request(byte[] bytes) {
            Artifact artifact = new Artifact("tenant:1", "artifact:1", "version:1", MediaCreationContracts.sha256(bytes), bytes);
        return new ExportRequest("tenant:1", "principal:1", "request:1", artifact, "destination:exact");
        }
    }

    /** In-memory test double for the durable-store capability; PostgreSQL tests prove persistence separately. */
    private static final class ClaimCapableTestStore implements DeliveryOperationStore {
        private final InMemoryDeliveryOperationStore backing = new InMemoryDeliveryOperationStore();
        private Operation findOverride;

        void overrideFind(Operation operation) { findOverride = operation; }

        @Override public Optional<Operation> find(String tenantId, String requestId) {
            if (findOverride != null && findOverride.tenantId().equals(tenantId)
                    && findOverride.requestId().equals(requestId)) return Optional.of(findOverride);
            return backing.find(tenantId, requestId);
        }
        @Override public boolean insertIfAbsent(Operation operation) { return backing.insertIfAbsent(operation); }
        @Override public boolean update(Operation operation) { return backing.update(operation); }
        @Override public boolean supportsDurableDispatchClaims() { return true; } // Test capability, not durable evidence.
        @Override public Optional<DispatchClaim> acquireDispatchClaim(Operation operation, String ownerId,
                Duration lease) { return backing.acquireDispatchClaim(operation, ownerId, lease); }
        @Override public Optional<DispatchClaim> renewDispatchClaim(DispatchClaim claim, Duration lease) {
            return backing.renewDispatchClaim(claim, lease);
        }
        @Override public boolean isDispatchClaimCurrent(DispatchClaim claim) {
            return backing.isDispatchClaimCurrent(claim);
        }
        @Override public boolean releaseDispatchClaim(DispatchClaim claim) {
            return backing.releaseDispatchClaim(claim);
        }
        @Override public boolean update(Operation operation, DispatchClaim claim) {
            return backing.update(operation, claim);
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

    private static final class FakeDestination implements FencedDestinationPort {
        int sendCount;
        int acceptedOffset;
        boolean loseFirstAckAfterAccept;
        boolean omitFinalReceipt;
        boolean badFinalChecksum;
        boolean badFinalDestination;
        boolean badChunkDestination;
        boolean badFinalPrincipal;
        boolean nullReconciliation;
        boolean wrongChunkFence;
        boolean wrongChunkDigest;
        boolean wrongReconciliationFence;
        boolean wrongFinalReceiptFence;
        Runnable afterFirstSend = () -> { };
        final List<Integer> offsets = new ArrayList<>();
        @Override public FencedChunkReceipt sendChunk(ExportRequest r, int offset, byte[] chunk, String chunkDigest,
                                                TransferAuthorization authorization,
                                                DeliveryOperationStore.DispatchClaim claim) {
            assertThat(claim.matches(new DeliveryOperationStore.Operation(
                    r.tenantId(), r.principalId(), r.requestId(), r.artifact().artifactId(),
                    r.artifact().versionRef(), r.artifact().digest(), r.destinationRef(),
                    claim.requestFingerprint(), Status.OUTCOME_UNKNOWN, offset, null))).isTrue();
            assertThat(claim.fence()).isPositive();
            sendCount++;
            offsets.add(offset);
            acceptedOffset = offset + chunk.length;
            if (sendCount == 1) afterFirstSend.run();
            if (loseFirstAckAfterAccept && sendCount == 1) throw new IllegalStateException("simulated response lost after destination accepted chunk");
            ChunkReceipt receipt = new ChunkReceipt("chunk-receipt:" + sendCount, r.tenantId(), r.principalId(), r.requestId(),
                    r.artifact().artifactId(), r.artifact().versionRef(),
                    badChunkDestination ? "destination:wrong" : r.destinationRef(),
                    r.artifact().digest(), offset, wrongChunkDigest ? "sha256:" + "0".repeat(64) : chunkDigest,
                    chunk.length, acceptedOffset);
            return new FencedChunkReceipt(receipt, claim.fence() + (wrongChunkFence ? 1 : 0));
        }
        @Override public FencedReconciliation reconcile(ExportRequest r, DeliveryOperationStore.DispatchClaim claim) {
            assertThat(claim.tenantId()).isEqualTo(r.tenantId());
            assertThat(claim.requestId()).isEqualTo(r.requestId());
            assertThat(claim.destinationRef()).isEqualTo(r.destinationRef());
            assertThat(claim.fence()).isPositive();
            if (nullReconciliation) return null;
            if (omitFinalReceipt || acceptedOffset != r.artifact().bytes().length) {
                return new FencedReconciliation(acceptedOffset, Optional.empty(),
                        claim.fence() + (wrongReconciliationFence ? 1 : 0));
            }
            DestinationReceipt receipt = new DestinationReceipt("destination-receipt:1", r.tenantId(),
                    badFinalPrincipal ? "principal:other" : r.principalId(), r.requestId(),
                    r.artifact().artifactId(), r.artifact().versionRef(), r.artifact().digest(),
                    badFinalDestination ? "destination:wrong" : r.destinationRef(),
                    r.artifact().bytes().length, badFinalChecksum ? "sha256:" + "0".repeat(64) : r.artifact().digest());
            return new FencedReconciliation(acceptedOffset,
                    Optional.of(new FencedDestinationReceipt(receipt,
                            claim.fence() + (wrongFinalReceiptFence ? 1 : 0))),
                    claim.fence() + (wrongReconciliationFence ? 1 : 0));
        }
    }
}
