package com.ghatana.audio.video.integration;

import com.ghatana.media.production.delivery.MediaDeliveryEngine;
import com.ghatana.media.runtime.MediaCreationContracts;
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.Optional;

import static com.ghatana.media.production.delivery.MediaDeliveryEngine.*;
import static org.assertj.core.api.Assertions.assertThat;

/**
 * Source-free J-22 scenario guard: transport acceptance with a receipt scoped
 * to another destination remains uncertain and cannot be presented as delivered.
 * The fake destination is only a protocol fixture, not a real publication target.
 */
class DeliveryDestinationReceiptScenarioTest {
    private static final Instant NOW = Instant.parse("2026-11-05T12:00:00Z");

    @Test
    void wrongDestinationReceiptRemainsUnknownAndHasNoDeliveredReceiptReference() {
        byte[] content = new byte[] { 0x12, 0x34, 0x56 };
        Artifact artifact = new Artifact("tenant-j22", "artifact-j22", "version-3",
                MediaCreationContracts.sha256(content), content);
        ExportRequest request = new ExportRequest("tenant-j22", "principal-j22", "request-j22",
                artifact, "destination:requested");

        AuthorizationPort authorization = new AuthorizationPort() {
            @Override
            public TransferAuthorization authorize(ExportRequest export) {
                return new TransferAuthorization("fixture-grant", export.tenantId(), export.principalId(),
                        export.requestId(), export.artifact().artifactId(), export.artifact().versionRef(),
                        export.artifact().digest(), export.destinationRef(), NOW.plusSeconds(60));
            }

            @Override
            public Boolean isCurrent(TransferAuthorization grant, Instant now) {
                return Boolean.TRUE;
            }
        };

        DestinationPort destination = new DestinationPort() {
            @Override
            public ChunkReceipt sendChunk(ExportRequest export, int offset, byte[] chunk, String chunkDigest,
                                          TransferAuthorization grant) {
                int nextOffset = offset + chunk.length;
                return new ChunkReceipt("fixture-chunk-receipt", export.tenantId(), export.principalId(),
                        export.requestId(), export.artifact().artifactId(), export.artifact().versionRef(),
                        export.destinationRef(), export.artifact().digest(), offset, chunkDigest,
                        chunk.length, nextOffset);
            }

            @Override
            public Reconciliation reconcile(ExportRequest export) {
                DestinationReceipt receipt = new DestinationReceipt("forged-destination-receipt",
                        export.tenantId(), export.principalId(), export.requestId(), export.artifact().artifactId(),
                        export.artifact().versionRef(), export.artifact().digest(), "destination:other",
                        export.artifact().bytes().length, export.artifact().digest());
                return new Reconciliation(export.artifact().bytes().length, Optional.of(receipt));
            }
        };

        MediaDeliveryEngine engine = new MediaDeliveryEngine(authorization, destination, () -> NOW);
        DeliveryResult first = engine.export(request);
        DeliveryResult replay = engine.export(request);

        assertThat(first.status()).isEqualTo(Status.OUTCOME_UNKNOWN);
        assertThat(first.acknowledgedBytes()).isEqualTo(content.length);
        assertThat(first.destinationReceiptRef()).isEmpty();
        assertThat(replay).isEqualTo(first);
        assertThat(engine.find(request.tenantId(), request.requestId()).orElseThrow().status())
                .isNotEqualTo(Status.DESTINATION_CONFIRMED);
    }
}
