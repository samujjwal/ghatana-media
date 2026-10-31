package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaCaptionContracts.MediaCaptionStore;
import com.ghatana.media.runtime.MediaCaptionContracts.ParentClockLookup;
import com.ghatana.media.runtime.MediaCaptionContracts.ParentVersionKind;
import com.ghatana.media.runtime.MediaTranscriptContracts;
import com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore;
import com.ghatana.media.runtime.MediaTranscriptContracts.TimingAvailability;
import com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision;

import java.util.Objects;
import java.util.Optional;

/**
 * Caller-scoped {@link ParentClockLookup} that resolves parent clock facts only from trusted
 * Media stores bound to the same tenant, principal and source artifact/version.
 *
 * <p>A {@code TRANSCRIPT_VERSION} parent resolves through the canonical transcript store's
 * exact immutable-version readback: {@code parentVersionId} is the persisted
 * {@code transcriptVersionRef}, never the transcript aggregate id. The bound revision's exact
 * segment-timing union must aggregate {@link TimingAvailability#SOURCE_CLOCK_BOUND} in the
 * requested source scope, otherwise the parent is not current/readable and resolves empty. A
 * {@code CAPTION_VERSION} parent resolves through the caption store's own immutable rows.
 * Callers that cannot prove the parent tuple get {@link Optional#empty()}, never an inferred
 * clock and never an implicitly selected latest revision.</p>
 */
final class MediaCaptionParentClockLookup implements ParentClockLookup {
    private final String tenantId;
    private final String principalId;
    private final MediaTranscriptStore transcriptStore;
    private final MediaCaptionStore captionStore;

    MediaCaptionParentClockLookup(String tenantId, String principalId,
                                  MediaTranscriptStore transcriptStore, MediaCaptionStore captionStore) {
        this.tenantId = Objects.requireNonNull(tenantId, "tenantId");
        this.principalId = Objects.requireNonNull(principalId, "principalId");
        this.transcriptStore = transcriptStore;
        this.captionStore = Objects.requireNonNull(captionStore, "captionStore");
    }

    @Override
    public Optional<ParentFacts> resolve(ParentVersionKind kind, String parentVersionId,
                                         String sourceArtifactId, String sourceArtifactVersionId) {
        Objects.requireNonNull(kind, "kind");
        return switch (kind) {
            case TRANSCRIPT_VERSION -> transcriptClock(parentVersionId, sourceArtifactId, sourceArtifactVersionId);
            case CAPTION_VERSION -> captionStore.parentClock(
                    tenantId, principalId, parentVersionId, sourceArtifactId, sourceArtifactVersionId);
        };
    }

    private Optional<ParentFacts> transcriptClock(String transcriptVersionRef,
                                                  String sourceArtifactId, String sourceArtifactVersionId) {
        if (transcriptStore == null) return Optional.empty();
        Optional<TranscriptRevision> versioned;
        try {
            versioned = transcriptStore.revisionByVersionRef(tenantId, principalId, transcriptVersionRef);
        } catch (UnsupportedOperationException unsupported) {
            return Optional.empty();
        }
        if (versioned.isEmpty()) return Optional.empty();
        var draft = versioned.get().draft();
        if (!sourceArtifactId.equals(draft.sourceArtifactId())
                || !sourceArtifactVersionId.equals(draft.sourceVersion())) {
            return Optional.empty();
        }
        if (MediaTranscriptContracts.aggregateTimingAvailability(draft.segments())
                != TimingAvailability.SOURCE_CLOCK_BOUND) {
            return Optional.empty();
        }
        var timing = draft.segments().get(0).timing();
        return Optional.of(new ParentFacts(
                timing.sourceClockId(), timing.sourceTicksPerSecond(), timing.sourceDurationTicks()));
    }
}
