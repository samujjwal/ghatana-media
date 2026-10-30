package com.ghatana.audio.video.multimodal.datacloud;

import com.ghatana.datacloud.semantic.OperationalSemanticContext.SemanticObject;

import java.util.Objects;
import java.util.Optional;

/**
 * DC-04: publish Media-derived semantic observations into Data Cloud through
 * admitted public clients with a live source-readback authority check and an
 * idempotent outbox — never a synchronous double write.
 *
 * <p>Exactly one logical downstream projection exists per (source event,
 * source artifact version). A replay of the same event/version returns the
 * recorded outcome instead of publishing twice. A dispatch whose receipt is
 * missing or ambiguous is recorded {@link Outcome#OUTCOME_UNKNOWN} and is
 * never republished blindly — reconciliation must first read the
 * destination's actual state.
 *
 * <p>The coordinator performs no transport work itself: source authority,
 * the destination publication client and the durable outbox are all admitted
 * seams owned by their respective public contracts.
 *
 * @doc.type class
 * @doc.purpose Idempotent rights-bound Data Cloud observation publication
 * @doc.layer product
 * @doc.pattern Coordinator
 */
public final class MediaObservationPublicationCoordinator {

    /** Live authority that the source owner still admits the observation read. */
    @FunctionalInterface
    public interface SourceReadbackAuthority {
        Decision verify(String tenantId, String artifactId, String sourceArtifactVersionId);

        enum Decision { ADMITTED, DENIED, NOT_ADMITTED, UNAVAILABLE }
    }

    /** Admitted Data Cloud destination client; returns the publication receipt. */
    @FunctionalInterface
    public interface PublicationClient {
        PublicationReceipt publish(String tenantId, SemanticObject projection)
                throws PublicationAmbiguousException;
    }

    /**
     * The dispatch may have taken effect but no usable receipt returned —
     * the downstream outcome is unknown and must not be retried blindly.
     */
    public static final class PublicationAmbiguousException extends Exception {
        public PublicationAmbiguousException(String message, Throwable cause) {
            super(message, cause);
        }
    }

    /** The destination's own acknowledgment of one logical publication. */
    public record PublicationReceipt(String receiptId, String publicationVersion) {
        public PublicationReceipt {
            Objects.requireNonNull(receiptId, "receiptId");
            Objects.requireNonNull(publicationVersion, "publicationVersion");
        }
    }

    /** Terminal or intermediate outcome recorded durably for one dedup key. */
    public enum Outcome {
        /** Receipt acknowledged by the destination. */
        PUBLISHED,
        /** Dispatch outcome ambiguous — reconciliation required before any retry. */
        OUTCOME_UNKNOWN,
        /** Source readback or admission denied the publication. */
        DENIED
    }

    /** One durable outbox record — the single logical projection per key. */
    public record Recorded(
            String dedupKey,
            Outcome outcome,
            String receiptId) {
        public Recorded {
            Objects.requireNonNull(dedupKey, "dedupKey");
            Objects.requireNonNull(outcome, "outcome");
        }
    }

    /** Idempotent durable outbox seam owned by the shared outbox contract. */
    public interface PublicationOutbox {
        Optional<Recorded> find(String dedupKey);
        void record(Recorded recorded);
    }

    /** The result the caller observes for one publish attempt. */
    public record PublishResult(
            Outcome outcome,
            String dedupKey,
            Optional<PublicationReceipt> receipt,
            String detail) {
    }

    private final MediaSemanticObservationProjector projector;
    private final SourceReadbackAuthority sourceAuthority;
    private final PublicationClient destination;
    private final PublicationOutbox outbox;

    public MediaObservationPublicationCoordinator(
            MediaSemanticObservationProjector projector,
            SourceReadbackAuthority sourceAuthority,
            PublicationClient destination,
            PublicationOutbox outbox) {
        this.projector = Objects.requireNonNull(projector, "projector");
        this.sourceAuthority = Objects.requireNonNull(sourceAuthority, "sourceAuthority");
        this.destination = Objects.requireNonNull(destination, "destination");
        this.outbox = Objects.requireNonNull(outbox, "outbox");
    }

    /** One logical projection identity: the source event at one exact version. */
    static String dedupKeyOf(MediaSemanticObservationProjector.MediaDerivedObservation o) {
        return o.sourceEventId() + "|" + o.sourceArtifactVersionId();
    }

    /**
     * Publishes one observation idempotently. A recorded PUBLISHED or
     * OUTCOME_UNKNOWN for the same key short-circuits — replays never cause
     * a second downstream write.
     */
    public PublishResult publish(
            MediaSemanticObservationProjector.MediaDerivedObservation observation) {
        Objects.requireNonNull(observation, "observation");
        String dedupKey = dedupKeyOf(observation);

        Optional<Recorded> prior = outbox.find(dedupKey);
        if (prior.isPresent()) {
            Recorded recorded = prior.get();
            return new PublishResult(
                    recorded.outcome(), dedupKey,
                    Optional.ofNullable(recorded.receiptId())
                            .map(id -> new PublicationReceipt(id, "recorded")),
                    "replay of recorded " + recorded.outcome());
        }

        // Live source-owner readback — a stale or revoked source is denied.
        SourceReadbackAuthority.Decision authority = sourceAuthority.verify(
                observation.tenantId(), observation.artifactId(),
                observation.sourceArtifactVersionId());
        if (authority != SourceReadbackAuthority.Decision.ADMITTED) {
            Recorded denied = new Recorded(dedupKey, Outcome.DENIED, null);
            outbox.record(denied);
            return new PublishResult(
                    Outcome.DENIED, dedupKey, Optional.empty(),
                    "source readback " + authority);
        }

        SemanticObject projection = projector.project(observation);

        PublicationReceipt receipt;
        try {
            receipt = destination.publish(observation.tenantId(), projection);
        } catch (PublicationAmbiguousException ambiguous) {
            // Dispatch may have landed: UNKNOWN is recorded, never republished.
            Recorded unknown = new Recorded(dedupKey, Outcome.OUTCOME_UNKNOWN, null);
            outbox.record(unknown);
            return new PublishResult(
                    Outcome.OUTCOME_UNKNOWN, dedupKey, Optional.empty(),
                    "publication receipt ambiguous: " + ambiguous.getMessage());
        }

        outbox.record(new Recorded(dedupKey, Outcome.PUBLISHED, receipt.receiptId()));
        return new PublishResult(
                Outcome.PUBLISHED, dedupKey, Optional.of(receipt), "published");
    }
}
