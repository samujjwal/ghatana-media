package com.ghatana.audio.video.integration;

import static com.ghatana.media.runtime.MediaProjectTimelineContracts.Actor;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.production.timeline.InMemoryProjectTimelineStore;
import com.ghatana.media.production.timeline.ProjectTimelineEngine;
import java.util.concurrent.atomic.AtomicInteger;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

/**
 * Focused J-01 negative boundary for the owner-defined create-project replay key.
 * The local store is only a deterministic fixture; this does not establish host identity,
 * authorization, durable runtime admission, or the complete first-use journey.
 *
 * <p>Source binding: PDP-1 operations.yaml#individualOperationContracts/records/@id=
 * media.operation-slice.create-project/ownerWireSchema/requestSchema (requestId is a
 * 1-128-character ASCII opaque key).
 */
@DisplayName("J-01 create request identity boundary (fixture only)")
class FirstUseCreateRequestIdentityBoundaryTest {
    @Test
    void invalidRequestIdentityIsRejectedBeforeProjectAndRevisionIdsAreAllocated() {
        AtomicInteger ids = new AtomicInteger();
        var store = new InMemoryProjectTimelineStore();
        var engine = new ProjectTimelineEngine(store, () -> "j01-request-id-" + ids.incrementAndGet());
        var actor = new Actor("tenant-j01-request-id", "creator-j01-request-id");

        for (String invalidRequestId : new String[] {
            null, "", " ", "contains space", "contains/slash", "clé", "r".repeat(129)
        }) {
            assertThatThrownBy(() -> engine.createProject(actor, "workspace-j01", "First cut", invalidRequestId))
                    .as("requestId %s is outside the owner wire schema", invalidRequestId)
                    .isInstanceOf(IllegalArgumentException.class);
        }

        assertThat(ids).as("rejected requests must not allocate aggregate identities").hasValue(0);

        var accepted = engine.createProject(actor, "workspace-j01", "First cut", "valid.request-1");

        assertThat(accepted.createdNow()).isTrue();
        assertThat(ids).hasValue(3);
        assertThat(accepted.project().headRevisionId()).isEqualTo(accepted.initialRevision().revisionId());
        assertThat(accepted.initialRevision().graph().scenes()).isEmpty();
        assertThat(store.project(actor, accepted.project().projectId())).isEqualTo(accepted.project());
    }
}
