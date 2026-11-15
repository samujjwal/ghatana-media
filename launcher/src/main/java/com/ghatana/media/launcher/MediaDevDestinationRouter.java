package com.ghatana.media.launcher;

import com.ghatana.media.production.delivery.DeliveryOperationStore;
import com.ghatana.media.production.delivery.MediaDeliveryEngine;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.ExportRequest;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.FencedChunkReceipt;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.FencedReconciliation;
import com.ghatana.media.production.delivery.MediaDeliveryEngine.TransferAuthorization;

import java.util.Map;
import java.util.Objects;

/**
 * Routes each engine call to the destination registered under the request's exact destination id. An id that is not
 * registered is never defaulted to another destination: it is a state error, not a write.
 */
final class MediaDevDestinationRouter implements MediaDeliveryEngine.FencedDestinationPort {
    private final Map<String, MediaDeliveryEngine.FencedDestinationPort> registered;

    MediaDevDestinationRouter(Map<String, MediaDeliveryEngine.FencedDestinationPort> registered) {
        this.registered = Map.copyOf(registered);
    }

    boolean isRegistered(String destinationId) { return registered.containsKey(destinationId); }

    private MediaDeliveryEngine.FencedDestinationPort port(ExportRequest request) {
        return Objects.requireNonNull(registered.get(request.destinationRef()), "destination is not registered");
    }

    @Override public void preflight(ExportRequest request) { port(request).preflight(request); }

    @Override
    public FencedChunkReceipt sendChunk(ExportRequest request, int offset, byte[] chunk, String chunkDigest,
                                        TransferAuthorization authorization,
                                        DeliveryOperationStore.DispatchClaim claim) {
        return port(request).sendChunk(request, offset, chunk, chunkDigest, authorization, claim);
    }

    @Override
    public FencedReconciliation reconcile(ExportRequest request, DeliveryOperationStore.DispatchClaim claim) {
        return port(request).reconcile(request, claim);
    }
}
