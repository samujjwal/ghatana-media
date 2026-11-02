package com.ghatana.audio.video.multimodal.datacloud;

import com.ghatana.audio.video.vision.video.SourceMediaTimestamp;
import com.ghatana.datacloud.semantic.OperationalSemanticContext.SemanticObject;

import java.util.Objects;
import java.util.Optional;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;

/**
 * DC-04: publish Media-derived semantic observations into Data Cloud through
 * admitted public clients with a live source-readback authority check and an
 * idempotent outbox — never a synchronous double write.
 *
 * <p>One logical downstream projection is keyed by tenant, source event and
 * source artifact version, then bound to a fingerprint of the full immutable
 * observation. A replay returns the recorded outcome only when that binding
 * matches. A dispatch whose receipt is
 * missing or ambiguous is recorded {@link Outcome#OUTCOME_UNKNOWN} and is
 * never republished blindly — reconciliation must first read the
 * destination's actual state.
 *
 * <p>The coordinator performs no transport work itself: live source and
 * disclosure authorities, the destination publication client and the durable
 * outbox are separate admitted seams owned by their respective public
 * contracts. A locally projected consent or redaction reference alone is not
 * publication authority.
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

    /** Live policy/consent/redaction readback for the complete immutable candidate. */
    @FunctionalInterface
    public interface DisclosureReadbackAuthority {
        Decision verify(MediaSemanticObservationProjector.MediaDerivedObservation observation);

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
            if (receiptId == null || receiptId.isBlank()) throw new IllegalArgumentException("receiptId is required");
            if (publicationVersion == null || publicationVersion.isBlank()) {
                throw new IllegalArgumentException("publicationVersion is required");
            }
        }
    }

    /** Terminal or intermediate outcome recorded durably for one dedup key. */
    public enum Outcome {
        /** Receipt acknowledged by the destination. */
        PUBLISHED,
        /** Dispatch outcome ambiguous — reconciliation required before any retry. */
        OUTCOME_UNKNOWN,
        /** Source readback or admission denied the publication. */
        DENIED,
        /** Required durable exclusive outbox claim is unavailable. */
        NOT_ADMITTED
    }

    /** One durable outbox record — the single logical projection per key. */
    public record Recorded(
            String dedupKey,
            Outcome outcome,
            String receiptId,
            String bindingFingerprint) {
        /** Source-compatible constructor for pre-binding records; these fail closed on read. */
        public Recorded(String dedupKey, Outcome outcome, String receiptId) {
            this(dedupKey, outcome, receiptId, null);
        }
        public Recorded {
            Objects.requireNonNull(dedupKey, "dedupKey");
            Objects.requireNonNull(outcome, "outcome");
        }
    }

    /** Result of atomically checking/reserving one durable publication key. */
    public enum ClaimStatus { ACQUIRED, RECORDED, IN_PROGRESS, UNAVAILABLE }

    public record ClaimResult(ClaimStatus status, Optional<Recorded> recorded, String bindingFingerprint) {
        public ClaimResult(ClaimStatus status, Optional<Recorded> recorded) {
            this(status, recorded, recorded.map(Recorded::bindingFingerprint).orElse(null));
        }
        public ClaimResult {
            Objects.requireNonNull(status, "status");
            Objects.requireNonNull(recorded, "recorded");
            if ((status == ClaimStatus.RECORDED) != recorded.isPresent()) {
                throw new IllegalArgumentException("only RECORDED claims carry a recorded outcome");
            }
        }
    }

    /** Idempotent durable outbox seam owned by the shared outbox contract. */
    public interface PublicationOutbox {
        Optional<Recorded> find(String dedupKey);

        /**
         * Atomically and durably returns an exclusive unresolved claim, an
         * existing final outcome, another owner's unresolved claim, or
         * UNAVAILABLE. The default is deliberately fail-closed. Once ACQUIRED
         * is returned, failure to record a final outcome must leave the key
         * claimed so another publisher cannot dispatch blindly. Implementors
         * must atomically reconcile or reject legacy unscoped keys; if that
         * migration guard is unavailable they must keep returning UNAVAILABLE.
         */
        default ClaimResult claim(String dedupKey, String legacyDedupKey, String bindingFingerprint) {
            return new ClaimResult(ClaimStatus.UNAVAILABLE, Optional.empty());
        }

        /** Finalizes a claim monotonically; implementations must not erase a terminal receipt. */
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
    private final DisclosureReadbackAuthority disclosureAuthority;
    private final PublicationClient destination;
    private final PublicationOutbox outbox;

    /**
     * Compatibility constructor without a live disclosure authority. It is
     * intentionally fail-closed; non-empty consent or redaction references
     * in a projection candidate are not proof of current authorization.
     */
    public MediaObservationPublicationCoordinator(
            MediaSemanticObservationProjector projector,
            SourceReadbackAuthority sourceAuthority,
            PublicationClient destination,
            PublicationOutbox outbox) {
        this(projector, sourceAuthority,
                observation -> DisclosureReadbackAuthority.Decision.NOT_ADMITTED,
                destination, outbox);
    }

    public MediaObservationPublicationCoordinator(
            MediaSemanticObservationProjector projector,
            SourceReadbackAuthority sourceAuthority,
            DisclosureReadbackAuthority disclosureAuthority,
            PublicationClient destination,
            PublicationOutbox outbox) {
        this.projector = Objects.requireNonNull(projector, "projector");
        this.sourceAuthority = Objects.requireNonNull(sourceAuthority, "sourceAuthority");
        this.disclosureAuthority = Objects.requireNonNull(disclosureAuthority, "disclosureAuthority");
        this.destination = Objects.requireNonNull(destination, "destination");
        this.outbox = Objects.requireNonNull(outbox, "outbox");
    }

    /** One logical projection identity: the source event at one exact version. */
    static String dedupKeyOf(MediaSemanticObservationProjector.MediaDerivedObservation o) {
        return frame(o.tenantId()) + frame(o.sourceEventId()) + frame(o.sourceArtifactVersionId());
    }

    static String legacyDedupKeyOf(MediaSemanticObservationProjector.MediaDerivedObservation o) {
        return o.sourceEventId() + "|" + o.sourceArtifactVersionId();
    }

    private static String frame(String value) {
        return value.length() + ":" + value;
    }

    /** Hashes every bounded source, rights, provenance and projected-value input without storing raw values. */
    private static String bindingFingerprintOf(
            MediaSemanticObservationProjector.MediaDerivedObservation o) {
        StringBuilder canonical = new StringBuilder();
        append(canonical, "media.data-cloud-publication-binding.v2");
        append(canonical, o.tenantId());
        append(canonical, o.sourceTenantId());
        append(canonical, o.artifactId());
        append(canonical, o.requestedArtifactVersionId());
        append(canonical, o.sourceArtifactVersionId());
        append(canonical, o.observationId());
        append(canonical, o.observationType());
        append(canonical, o.redactedValue());
        append(canonical, o.observedAt().toString());
        append(canonical, o.recordedAt().toString());
        append(canonical, o.sourceSystem());
        append(canonical, o.sourceEventId());
        append(canonical, o.providerId());
        append(canonical, o.providerVersion());
        append(canonical, o.redactionDecisionRef());
        append(canonical, o.consentOwnerService());
        append(canonical, o.consentRef());
        append(canonical, o.ownerId());
        append(canonical, o.stewardId());
        append(canonical, o.sourceClassification());
        append(canonical, o.classification());
        append(canonical, Integer.toString(o.permittedPurposes().size()));
        o.permittedPurposes().forEach(value -> append(canonical, value));
        append(canonical, o.residency());
        append(canonical, o.retentionPolicyRef().orElse(""));
        append(canonical, Integer.toString(o.qualityScore()));
        append(canonical, o.trustGrade());
        append(canonical, Boolean.toString(o.sourceTimestamp().isPresent()));
        o.sourceTimestamp().ifPresent(timestamp -> appendSourceTimestamp(canonical, timestamp));
        try {
            MessageDigest digest = MessageDigest.getInstance("SHA-256");
            // Hash Java UTF-16 code units directly. UTF-8 encoders replace
            // isolated surrogates, which could collapse distinct observations.
            for (int index = 0; index < canonical.length(); index++) {
                char codeUnit = canonical.charAt(index);
                digest.update((byte) (codeUnit >>> 8));
                digest.update((byte) codeUnit);
            }
            return "sha256:" + HexFormat.of().formatHex(digest.digest());
        } catch (NoSuchAlgorithmException unavailable) {
            throw new IllegalStateException("SHA-256 unavailable", unavailable);
        }
    }

    private static void append(StringBuilder target, String value) {
        target.append(value.length()).append(':').append(value);
    }

    private static void appendSourceTimestamp(StringBuilder target, SourceMediaTimestamp timestamp) {
        append(target, timestamp.status().name());
        appendNullable(target, timestamp.pts());
        appendNullable(target, timestamp.timeBaseNumerator());
        appendNullable(target, timestamp.timeBaseDenominator());
        appendNullable(target, timestamp.timestampMs());
        appendNullable(target, timestamp.reason());
    }

    private static void appendNullable(StringBuilder target, Object value) {
        append(target, value == null ? "<null>" : value.toString());
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

        // Build and validate the exact local projection before any replay can
        // be returned. The digest binds all bounded input/provenance fields.
        SemanticObject projection = projector.project(observation);
        String bindingFingerprint = bindingFingerprintOf(observation);

        // Live source-owner readback precedes every replay so a revoked caller
        // cannot retrieve a prior outcome or receipt.
        SourceReadbackAuthority.Decision authority;
        try {
            authority = sourceAuthority.verify(observation.tenantId(), observation.artifactId(),
                    observation.sourceArtifactVersionId());
        } catch (RuntimeException unavailable) {
            authority = SourceReadbackAuthority.Decision.UNAVAILABLE;
        }
        if (authority == SourceReadbackAuthority.Decision.DENIED) {
            return new PublishResult(
                    Outcome.DENIED, dedupKey, Optional.empty(), "source authority denied publication");
        }
        if (authority != SourceReadbackAuthority.Decision.ADMITTED) {
            return notAdmitted(dedupKey, "source authority is unavailable or not admitted");
        }

        DisclosureReadbackAuthority.Decision disclosure;
        try {
            disclosure = disclosureAuthority.verify(observation);
        } catch (RuntimeException unavailable) {
            disclosure = DisclosureReadbackAuthority.Decision.UNAVAILABLE;
        }
        if (disclosure == DisclosureReadbackAuthority.Decision.DENIED) {
            return new PublishResult(
                    Outcome.DENIED, dedupKey, Optional.empty(), "disclosure policy denied publication");
        }
        if (disclosure != DisclosureReadbackAuthority.Decision.ADMITTED) {
            return notAdmitted(dedupKey, "disclosure policy is unavailable or not admitted");
        }

        Optional<Recorded> prior;
        try {
            prior = outbox.find(dedupKey);
        } catch (RuntimeException unavailable) {
            return notAdmitted(dedupKey, "publication outbox read is unavailable");
        }
        if (prior.isPresent()) {
            if (!hasExpectedBinding(prior.get(), dedupKey, bindingFingerprint)) {
                return notAdmitted(dedupKey, "recorded publication is unbound or has a different request scope");
            }
            return replay(prior.get(), dedupKey);
        }

        ClaimResult claim;
        try {
            claim = outbox.claim(dedupKey, legacyDedupKeyOf(observation), bindingFingerprint);
        } catch (RuntimeException unavailable) {
            return notAdmitted(dedupKey, "durable publication claim is unavailable");
        }
        if (claim == null) {
            return notAdmitted(dedupKey, "durable publication claim is unavailable");
        }
        switch (claim.status()) {
            case RECORDED -> {
                Recorded recorded = claim.recorded().orElseThrow();
                if (!hasExpectedBinding(recorded, dedupKey, bindingFingerprint)
                        || !bindingFingerprint.equals(claim.bindingFingerprint())) {
                    return notAdmitted(dedupKey, "atomic claim returned a different request binding");
                }
                return replay(recorded, dedupKey);
            }
            case IN_PROGRESS -> {
                if (!bindingFingerprint.equals(claim.bindingFingerprint())) {
                    return notAdmitted(dedupKey, "active claim belongs to a different request binding");
                }
                return new PublishResult(Outcome.OUTCOME_UNKNOWN, dedupKey, Optional.empty(),
                        "another durable publication claim is unresolved");
            }
            case UNAVAILABLE -> { return notAdmitted(dedupKey, "durable publication claim is unavailable"); }
            case ACQUIRED -> {
                if (!bindingFingerprint.equals(claim.bindingFingerprint())) {
                    return notAdmitted(dedupKey, "atomic claim does not bind this request");
                }
            }
        }

        PublicationReceipt receipt;
        try {
            receipt = destination.publish(observation.tenantId(), projection);
        } catch (Exception ambiguous) {
            return finalizeUnknown(dedupKey, bindingFingerprint);
        }
        if (receipt == null) {
            return finalizeUnknown(dedupKey, bindingFingerprint);
        }

        try {
            outbox.record(new Recorded(dedupKey, Outcome.PUBLISHED, receipt.receiptId(), bindingFingerprint));
        } catch (RuntimeException completionFailure) {
            // The destination did return a receipt, but durable finality did
            // not. Preserve the exclusive claim and report UNKNOWN unless a
            // readback proves the PUBLISHED record was committed before error.
            try {
                Optional<Recorded> persisted = outbox.find(dedupKey);
                if (persisted.filter(recorded -> hasExpectedBinding(recorded, dedupKey, bindingFingerprint)
                        && recorded.outcome() == Outcome.PUBLISHED
                        && receipt.receiptId().equals(recorded.receiptId())).isPresent()) {
                    return new PublishResult(Outcome.PUBLISHED, dedupKey, Optional.of(receipt),
                            "publication receipt confirmed by outbox readback");
                }
            } catch (RuntimeException ignored) {
                // The unresolved claim below still prevents a blind second dispatch.
            }
            return finalizeUnknown(dedupKey, bindingFingerprint);
        }

        return new PublishResult(
                Outcome.PUBLISHED, dedupKey, Optional.of(receipt), "published");
    }

    private PublishResult finalizeUnknown(String dedupKey, String bindingFingerprint) {
        try {
            outbox.record(new Recorded(dedupKey, Outcome.OUTCOME_UNKNOWN, null, bindingFingerprint));
        } catch (RuntimeException ignored) {
            // The durable ACQUIRED claim must remain unresolved on write failure.
        }
        return new PublishResult(Outcome.OUTCOME_UNKNOWN, dedupKey, Optional.empty(),
                "publication outcome is unconfirmed; reconciliation is required");
    }

    private static PublishResult replay(Recorded recorded, String dedupKey) {
        // Recorded stores receipt identity only; never invent a destination version.
        return new PublishResult(recorded.outcome(), dedupKey, Optional.empty(),
                "replay of recorded " + recorded.outcome());
    }

    private static boolean hasExpectedBinding(Recorded recorded, String dedupKey, String fingerprint) {
        if (!dedupKey.equals(recorded.dedupKey()) || !fingerprint.equals(recorded.bindingFingerprint())) {
            return false;
        }
        return switch (recorded.outcome()) {
            case PUBLISHED -> recorded.receiptId() != null && !recorded.receiptId().isBlank();
            case OUTCOME_UNKNOWN, DENIED -> recorded.receiptId() == null;
            case NOT_ADMITTED -> false;
        };
    }

    private static PublishResult notAdmitted(String dedupKey, String detail) {
        return new PublishResult(Outcome.NOT_ADMITTED, dedupKey, Optional.empty(), detail);
    }
}
