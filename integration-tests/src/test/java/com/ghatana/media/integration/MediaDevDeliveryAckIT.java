package com.ghatana.media.integration;

import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.MethodOrderer;
import org.junit.jupiter.api.Order;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestMethodOrder;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.containers.localstack.LocalStackContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import org.testcontainers.utility.DockerImageName;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.util.List;

import static com.ghatana.media.integration.MediaDevAckRig.*;
import static com.ghatana.media.integration.MediaDevLiveFixtures.JSON;
import static com.ghatana.media.integration.MediaDevLiveFixtures.send;
import static org.assertj.core.api.Assertions.assertThat;
import static org.testcontainers.containers.localstack.LocalStackContainer.Service.S3;

/**
 * J-22 through a real launcher process: export of a stored artifact to an independent signed-ACK receiver. DELIVERED is
 * recorded only from a verified, signed, byte-bound receipt. Faults: lost ACK (stored, dropped, stalled), dropped before
 * store, credential revoked before and mid-export, rights revoked mid-export, forged ACK signature, wrong receiver
 * identity, checksum mismatch at the destination, foreign object at the key, duplicate export, wrong tenant/destination/
 * permission, multi-part resume after a hard launcher kill.
 */
@Testcontainers(disabledWithoutDocker = true)
@Tag("integration")
@TestMethodOrder(MethodOrderer.OrderAnnotation.class)
class MediaDevDeliveryAckIT {
    @Container
    private static final PostgreSQLContainer<?> POSTGRES = new PostgreSQLContainer<>(DockerImageName.parse("postgres:16-alpine"));
    @Container
    private static final LocalStackContainer LOCALSTACK = new LocalStackContainer(
            DockerImageName.parse("localstack/localstack:3.8")).withServices(S3);

    private static MediaDevAckRig rig;
    private static MediaDevAckRig.Artifact small;
    private static MediaDevAckRig.Artifact large;

    @BeforeAll
    static void start() throws Exception {
        rig = new MediaDevAckRig(POSTGRES, LOCALSTACK, "2500");
        rig.start();
        small = rig.artifact("small", 160, 120, true);
        large = rig.artifact("large", 1100, 800, true); // > 2 MiB incompressible: three 1 MiB parts
        assertThat(small.bytes().length).isLessThan(MediaDevAckRig.PART);
        assertThat(large.bytes().length).isGreaterThan(2 * MediaDevAckRig.PART);
    }

    @AfterAll
    static void stop() {
        if (rig != null) rig.close();
    }

    private static JsonNode body(HttpResponse<String> response, int status) throws Exception {
        assertThat(response.statusCode()).as(response.body()).isEqualTo(status);
        return JSON.readTree(response.body());
    }

    @Test @Order(1)
    void exportIsDeliveredOnlyFromAVerifiedSignedReceiptAndDuplicateExportsAreIdempotent() throws Exception {
        String request = "happy-" + rig.run;
        JsonNode first = body(rig.export(request, small), 201);
        assertThat(first.path("status").asString()).isEqualTo("DESTINATION_CONFIRMED");
        assertThat(first.path("ackState").asString()).isEqualTo("DELIVERED");
        assertThat(first.path("failure").isNull()).isTrue();
        assertThat(first.path("destinationReceiptRef").asString()).startsWith("dev-http-receiver-receipt:");
        String key = rig.objectKey(request);
        assertThat(rig.receiver.storedBytes(key)).isEqualTo(small.bytes());
        assertThat(rig.ledgerStatus(request)).isEqualTo("DESTINATION_CONFIRMED:" + small.bytes().length);
        int puts = rig.receiver.putRequests();

        // Duplicate export: replayed read, no second PUT, one object, one ledger row.
        JsonNode replay = body(rig.export(request, small), 200);
        assertThat(replay.path("replayed").asBoolean()).isTrue();
        assertThat(replay.path("ackState").asString()).isEqualTo("DELIVERED");
        assertThat(replay.path("destinationReceiptRef").asString()).isEqualTo(first.path("destinationReceiptRef").asString());
        assertThat(rig.receiver.putRequests()).isEqualTo(puts);
        assertThat(rig.receiver.partWrites().stream().filter(write -> write.objectKey().equals(key))).hasSize(1);
        assertThat(rig.ledgerRows(request)).isEqualTo(1);
        // Reconcile of a delivered export is a read.
        assertThat(body(rig.reconcile(request, true), 200).path("ackState").asString()).isEqualTo("DELIVERED");
        assertThat(rig.receiver.putRequests()).isEqualTo(puts);
        assertThat(rig.read(request).path("ackState").asString()).isEqualTo("DELIVERED");
    }

    @Test @Order(2)
    void deniedAndMisdirectedExportsSendNothing() throws Exception {
        int before = rig.receiver.putRequests() + rig.receiver.statusRequests();
        // Missing rights: a version with no EXTERNAL_DELIVERY attestation.
        MediaDevAckRig.Artifact unattested = rig.artifact("unattested", 64, 64, false);
        JsonNode denied = body(rig.export("no-rights-" + rig.run, unattested), 403);
        assertThat(denied.path("error").path("code").asString()).isEqualTo("EXPORT_RIGHTS_NOT_ADMITTED");
        // Revoked rights.
        MediaDevAckRig.Artifact revoked = rig.artifact("revoked", 64, 64, false);
        String attestation = rig.attest(revoked.artifactId(), revoked.versionId());
        rig.revokeAttestation(attestation);
        JsonNode afterRevoke = body(rig.export("revoked-rights-" + rig.run, revoked), 403);
        assertThat(afterRevoke.path("error").path("code").asString()).isEqualTo("EXPORT_RIGHTS_NOT_ADMITTED");
        // Unregistered destination.
        HttpResponse<String> unknown = send(rig.port, rig.tenant, rig.ownerToken(), "POST", "/dev/v1/exports",
                rig.exportBody("unregistered-" + rig.run, small, "somewhere-else"));
        assertThat(body(unknown, 404).path("error").path("code").asString()).isEqualTo("DESTINATION_NOT_FOUND");
        // Registered destination, but not for this tenant.
        HttpResponse<String> notPermitted = send(rig.port, rig.otherTenant, rig.token(rig.otherTenant, rig.owner), "POST",
                "/dev/v1/exports", rig.exportBody("other-tenant-" + rig.run, small, DEST));
        assertThat(notPermitted.statusCode()).as(notPermitted.body()).isIn(403, 404);
        // Missing EXTERNAL delivery export permission.
        HttpResponse<String> noPermission = send(rig.port, rig.tenant, rig.readOnlyToken(), "POST", "/dev/v1/exports",
                rig.exportBody("no-permission-" + rig.run, small, DEST));
        assertThat(noPermission.statusCode()).as(noPermission.body()).isEqualTo(403);
        // Wrong tenant / other principal cannot read the delivered export.
        assertThat(send(rig.port, rig.otherTenant, rig.token(rig.otherTenant, rig.owner), "GET",
                "/dev/v1/exports/happy-" + rig.run, null).statusCode()).isEqualTo(404);
        assertThat(send(rig.port, rig.tenant, rig.token(rig.tenant, rig.confirmer), "GET",
                "/dev/v1/exports/happy-" + rig.run, null).statusCode()).isEqualTo(404);
        // Same request id for another destination is a typed conflict, not a second effect.
        assertThat(rig.receiver.putRequests() + rig.receiver.statusRequests()).isEqualTo(before);
        for (String request : List.of("no-rights-", "revoked-rights-", "unregistered-", "other-tenant-", "no-permission-")) {
            assertThat(rig.ledgerRows(request + rig.run)).as(request).isZero();
        }
    }

    @Test @Order(3)
    void aLostAckIsUnknownThenReconciliationFindsTheStoredObjectWithoutAnotherUpload() throws Exception {
        String request = "lost-ack-" + rig.run;
        rig.receiver.dropAckAfterStore(1);
        JsonNode first = body(rig.export(request, small), 202);
        assertThat(first.path("status").asString()).isEqualTo("OUTCOME_UNKNOWN");
        assertThat(first.path("ackState").asString()).isEqualTo("UNKNOWN");
        assertThat(first.path("failure").asString()).isEqualTo("DESTINATION_UNREACHABLE");
        String key = rig.objectKey(request);
        assertThat(rig.receiver.storedBytes(key)).as("the receiver did store the object").isEqualTo(small.bytes());
        int puts = rig.receiver.putRequests();
        // Read-only reconciliation: the signed status holds exactly these bytes; the engine records DELIVERED.
        JsonNode resolved = body(rig.reconcile(request, false), 200);
        assertThat(resolved.path("ackState").asString()).isEqualTo("DELIVERED");
        assertThat(resolved.path("destinationReceiptRef").asString()).startsWith("dev-http-receiver-receipt:");
        assertThat(rig.receiver.putRequests()).as("no blind duplicate upload").isEqualTo(puts);
        assertThat(rig.receiver.partWrites().stream().filter(write -> write.objectKey().equals(key))).hasSize(1);
        assertThat(rig.ledgerStatus(request)).startsWith("DESTINATION_CONFIRMED");
    }

    @Test @Order(4)
    void anAckLostBeforeTheStoreReconcilesToNotDeliveredThenResumesWithExactlyOneStoredPart() throws Exception {
        String request = "dropped-before-store-" + rig.run;
        rig.receiver.dropBeforeStore(1);
        JsonNode first = body(rig.export(request, small), 202);
        assertThat(first.path("ackState").asString()).isEqualTo("UNKNOWN");
        String key = rig.objectKey(request);
        assertThat(rig.receiver.received(key)).isZero();
        JsonNode absent = body(rig.reconcile(request, false), 200);
        assertThat(absent.path("ackState").asString()).isEqualTo("NOT_DELIVERED");
        assertThat(absent.path("destinationReceivedBytes").asLong()).isZero();
        assertThat(rig.receiver.storedObjects() == 0 || rig.receiver.received(key) == 0).isTrue();
        // Now that the destination verifiably holds nothing, resuming sends the bytes once.
        JsonNode resumed = body(rig.reconcile(request, true), 200);
        assertThat(resumed.path("ackState").asString()).isEqualTo("DELIVERED");
        assertThat(rig.receiver.storedBytes(key)).isEqualTo(small.bytes());
        assertThat(rig.receiver.partWrites().stream().filter(write -> write.objectKey().equals(key))).hasSize(1);
    }

    @Test @Order(5)
    void aRevokedDestinationCredentialIsATypedFailureAndNothingIsDeliveredUntilItIsRestored() throws Exception {
        // Revoked before the transfer: refused before any effect.
        String early = "revoked-early-" + rig.run;
        rig.receiver.revokeCredential();
        JsonNode refused = body(rig.export(early, small), 202);
        assertThat(refused.path("status").asString()).isEqualTo("UNAVAILABLE");
        assertThat(refused.path("ackState").asString()).isEqualTo("NOT_DELIVERED");
        assertThat(refused.path("failure").asString()).isEqualTo("CREDENTIAL_REVOKED");
        assertThat(rig.receiver.received(rig.objectKey(early))).isZero();
        rig.receiver.restoreCredential();

        // Revoked mid-export: part 1 lands, the credential is revoked, part 2 is refused.
        String mid = "revoked-mid-" + rig.run;
        String key = rig.objectKey(mid);
        rig.receiver.revokeAfterStoredParts(1);
        JsonNode partial = body(rig.export(mid, large), 202);
        assertThat(partial.path("ackState").asString()).isEqualTo("UNKNOWN");
        assertThat(partial.path("failure").asString()).isEqualTo("CREDENTIAL_REVOKED");
        assertThat(partial.path("acknowledgedBytes").asInt()).isEqualTo(PART);
        assertThat(rig.receiver.received(key)).isEqualTo(PART);
        assertThat(rig.ledgerStatus(mid)).doesNotStartWith("DESTINATION_CONFIRMED");
        // While revoked, reconciliation cannot read the destination either; still not delivered.
        JsonNode stillRevoked = body(rig.reconcile(mid, true), 200);
        assertThat(stillRevoked.path("ackState").asString()).isEqualTo("UNKNOWN");
        assertThat(stillRevoked.path("failure").asString()).isEqualTo("CREDENTIAL_REVOKED");
        // Restored: resume continues from the receiver-verified offset; part 0 is never sent again.
        rig.receiver.restoreCredential();
        JsonNode done = body(rig.reconcile(mid, true), 200);
        assertThat(done.path("ackState").asString()).isEqualTo("DELIVERED");
        assertThat(rig.receiver.storedBytes(key)).isEqualTo(large.bytes());
        assertThat(rig.receiver.partWrites().stream().filter(write -> write.objectKey().equals(key)).map(LocalAckReceiver.PartWrite::offset))
                .containsExactly(0, PART, 2 * PART);
    }

    @Test @Order(6)
    void revokedRightsMidExportStopTheTransferAndDeliverNothing() throws Exception {
        MediaDevAckRig.Artifact guarded = rig.artifact("guarded", 1100, 800, false);
        String attestation = rig.attest(guarded.artifactId(), guarded.versionId());
        String request = "rights-mid-" + rig.run;
        String key = rig.objectKey(request);
        rig.receiver.afterPartStored(write -> {
            if (write.objectKey().equals(key)) {
                try { rig.revokeAttestation(attestation); } catch (Exception failure) { throw new IllegalStateException(failure); }
            }
        });
        JsonNode stopped = body(rig.export(request, guarded), 202);
        rig.receiver.afterPartStored(null);
        assertThat(stopped.path("ackState").asString()).isEqualTo("UNKNOWN");
        assertThat(rig.receiver.received(key)).isEqualTo(PART);
        int puts = rig.receiver.putRequests();
        JsonNode retry = body(rig.export(request, guarded), 403);
        assertThat(retry.path("error").path("code").asString()).isEqualTo("EXPORT_RIGHTS_NOT_ADMITTED");
        assertThat(rig.receiver.putRequests()).isEqualTo(puts);
        assertThat(rig.ledgerStatus(request)).doesNotStartWith("DESTINATION_CONFIRMED");
    }

    @Test @Order(7)
    void aChecksumMismatchAtTheDestinationIsATypedFailureNeverDelivered() throws Exception {
        String request = "corrupt-" + rig.run;
        rig.receiver.corruptStoredObjectOnComplete(true);
        JsonNode first = body(rig.export(request, small), 202);
        rig.receiver.corruptStoredObjectOnComplete(false);
        assertThat(first.path("status").asString()).isEqualTo("OUTCOME_UNKNOWN");
        assertThat(first.path("ackState").asString()).isEqualTo("UNKNOWN");
        assertThat(first.path("failure").asString()).isEqualTo("CHECKSUM_MISMATCH");
        JsonNode again = body(rig.reconcile(request, true), 200);
        assertThat(again.path("failure").asString()).isEqualTo("CHECKSUM_MISMATCH");
        assertThat(again.path("destinationConfirmed").asBoolean()).isFalse();
        assertThat(rig.ledgerStatus(request)).startsWith("OUTCOME_UNKNOWN");

        // A foreign object already at this request's key is never confirmed and never overwritten.
        String foreign = "foreign-" + rig.run;
        byte[] other = small.bytes().clone();
        other[other.length / 2] ^= 0x33;
        rig.receiver.plant(rig.objectKey(foreign), other);
        int putsBeforeForeign = rig.receiver.putRequests();
        JsonNode planted = body(rig.export(foreign, small), 202);
        assertThat(planted.path("status").asString()).as("refused before any write").isEqualTo("UNAVAILABLE");
        assertThat(planted.path("ackState").asString()).isEqualTo("NOT_DELIVERED");
        assertThat(planted.path("failure").asString()).isEqualTo("CHECKSUM_MISMATCH");
        assertThat(rig.receiver.putRequests() - putsBeforeForeign).isZero();
        assertThat(rig.receiver.storedBytes(rig.objectKey(foreign))).isEqualTo(other);
        assertThat(rig.receiver.partWrites().stream().filter(write -> write.objectKey().equals(rig.objectKey(foreign)))).isEmpty();
    }

    @Test @Order(8)
    void aForgedAckSignatureIsNeverAcceptedAndASignedStatusResolvesIt() throws Exception {
        String request = "forged-" + rig.run;
        rig.receiver.signWithWrongKey(1, 1); // preflight status verifies; the part ACK is signed with a different key
        JsonNode first = body(rig.export(request, small), 202);
        assertThat(first.path("ackState").asString()).isEqualTo("UNKNOWN");
        assertThat(first.path("failure").asString()).isEqualTo("ACK_SIGNATURE_INVALID");
        assertThat(first.path("destinationConfirmed").asBoolean()).isFalse();
        String key = rig.objectKey(request);
        assertThat(rig.receiver.received(key)).isEqualTo(small.bytes().length);
        JsonNode resolved = body(rig.reconcile(request, true), 200);
        assertThat(resolved.path("ackState").asString()).isEqualTo("DELIVERED");
        assertThat(rig.receiver.partWrites().stream().filter(write -> write.objectKey().equals(key))).hasSize(1);
    }

    @Test @Order(9)
    void aReceiverClaimingAnotherIdentityIsNotTheRegisteredDestination() throws Exception {
        String request = "wrong-identity-" + rig.run;
        rig.receiver.claimIdentity("some-other-receiver");
        JsonNode first = body(rig.export(request, small), 202);
        rig.receiver.claimIdentity(MediaDevAckRig.RECEIVER_IDENTITY);
        assertThat(first.path("status").asString()).isEqualTo("UNAVAILABLE");
        assertThat(first.path("ackState").asString()).isEqualTo("NOT_DELIVERED");
        assertThat(first.path("failure").asString()).isEqualTo("DESTINATION_IDENTITY_MISMATCH");
        assertThat(rig.receiver.received(rig.objectKey(request))).isZero();
    }

    @Test @Order(10)
    void aMultiPartExportResumesAfterAHardLauncherKillWithoutResendingStoredParts() throws Exception {
        String request = "kill-resume-" + rig.run;
        String key = rig.objectKey(request);
        rig.receiver.stallAfterStoreAtOffset(PART); // part 1 is stored, its ACK withheld
        java.util.concurrent.CompletableFuture<HttpResponse<String>> inFlight =
                java.util.concurrent.CompletableFuture.supplyAsync(() -> {
                    try { return rig.export(request, large); } catch (Exception failure) { throw new IllegalStateException(failure); }
                });
        assertThat(rig.receiver.awaitStall(60)).as("receiver reached the stalled part").isTrue();
        assertThat(rig.receiver.received(key)).isEqualTo(2 * PART);
        rig.kill();
        rig.receiver.releaseStall();
        try { inFlight.get(30, java.util.concurrent.TimeUnit.SECONDS); } catch (java.util.concurrent.ExecutionException expected) { }
        rig.start();
        JsonNode reopened = rig.read(request);
        assertThat(reopened.path("ackState").asString()).isEqualTo("UNKNOWN");
        assertThat(rig.ledgerStatus(request)).isEqualTo("OUTCOME_UNKNOWN:" + PART);
        // The dead dispatcher's lease must expire before takeover; until then a retry is an honest 202.
        JsonNode finished = null;
        long deadline = System.nanoTime() + java.time.Duration.ofSeconds(60).toNanos();
        while (System.nanoTime() < deadline) {
            HttpResponse<String> retry = rig.export(request, large);
            assertThat(retry.statusCode()).as(retry.body()).isIn(200, 202);
            JsonNode node = JSON.readTree(retry.body());
            if ("DELIVERED".equals(node.path("ackState").asString())) { finished = node; break; }
            Thread.sleep(500);
        }
        assertThat(finished).as("export resumed to DELIVERED after the lease expired").isNotNull();
        assertThat(rig.receiver.storedBytes(key)).isEqualTo(large.bytes());
        assertThat(rig.receiver.partWrites().stream().filter(write -> write.objectKey().equals(key)).map(LocalAckReceiver.PartWrite::offset))
                .as("every part was stored exactly once; part 0 and the stalled part 1 were not resent")
                .containsExactly(0, PART, 2 * PART);
        assertThat(rig.ledgerStatus(request)).isEqualTo("DESTINATION_CONFIRMED:" + large.bytes().length);
        assertThat(rig.ledgerRows(request)).isEqualTo(1);
        // The delivered state survives another restart.
        rig.restart();
        assertThat(rig.read(request).path("ackState").asString()).isEqualTo("DELIVERED");
        assertThat(rig.read("happy-" + rig.run).path("ackState").asString()).isEqualTo("DELIVERED");
    }
}
