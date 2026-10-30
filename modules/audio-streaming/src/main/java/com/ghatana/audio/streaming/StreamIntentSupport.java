package com.ghatana.audio.streaming;

import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * Truthful support matrix for the 17 PDP {@code media.stream.*} leaf
 * capability intents.
 *
 * <p>AS-06: abstract ordered-stream semantics implemented and tested in this
 * module are distinguished from real transport qualification. No WebRTC,
 * adaptive-HTTP, HLS or DASH transport exists in this repository, so those
 * intents are {@link Support#NOT_ADMITTED} — never claimed, never behind a
 * fabricated HTTP/WebRTC route or a hidden local media relay. Intents owned
 * by other product surfaces (recording, live processing, live captions) are
 * {@link Support#DELEGATED} with the owning surface recorded.
 *
 * @doc.type class
 * @doc.purpose Per-intent stream support classification bound to PDP-0 leaves
 * @doc.layer product
 * @doc.pattern Support Matrix
 */
public final class StreamIntentSupport {

    /** How one stream intent is satisfied today. */
    public enum Support {
        /** Implemented in this module and proven by executable tests. */
        IMPLEMENTED,
        /** Owned by another product surface; this module does not implement it. */
        DELEGATED,
        /** Not admitted — no qualified implementation or transport exists. */
        NOT_ADMITTED
    }

    /** One intent's classification with its reason or owning surface. */
    public record IntentDisposition(
            String intentId,
            Support support,
            /** Owning surface for DELEGATED, or the concrete gap for NOT_ADMITTED. */
            String basis) {
        public IntentDisposition {
            Objects.requireNonNull(intentId, "intentId");
            Objects.requireNonNull(support, "support");
            Objects.requireNonNull(basis, "basis");
        }
    }

    private static final String IMPLEMENTED_BASIS =
            "implemented and tested in modules/audio-streaming";
    private static final String NO_QUALIFIED_TRANSPORT =
            "no qualified transport implementation exists in this repository";

    /**
     * Exact support matrix keyed by the PDP-0 {@code media.stream} leaf IDs.
     * The set is complete and immutable — an intent absent here was never
     * evaluated and must not be silently claimed.
     */
    private static final Map<String, IntentDisposition> MATRIX = Map.ofEntries(
            implemented("media.stream.session.open"),
            implemented("media.stream.session.connect"),
            implemented("media.stream.frame.submit"),
            implemented("media.stream.frame.acknowledge"),
            implemented("media.stream.session.close"),
            implemented("media.stream.session.reconnect"),
            implemented("media.stream.ordering.enforce"),
            implemented("media.stream.buffer.bound"),
            implemented("media.stream.backpressure.apply"),
            notAdmitted("media.stream.lease.renew",
                    "no stream lease primitive exists in this module"),
            delegated("media.stream.recording.integrate",
                    "media.recording surface owner"),
            delegated("media.stream.live-processing.integrate",
                    "intelligence/live-processing surface owner"),
            notAdmitted("media.stream.transport.webrtc", NO_QUALIFIED_TRANSPORT),
            notAdmitted("media.stream.transport.adaptive-http", NO_QUALIFIED_TRANSPORT),
            notAdmitted("media.stream.transport.hls", NO_QUALIFIED_TRANSPORT),
            notAdmitted("media.stream.transport.dash", NO_QUALIFIED_TRANSPORT),
            delegated("media.stream.caption.live",
                    "speech/STT captioning surface owner"));

    private static Map.Entry<String, IntentDisposition> implemented(String intentId) {
        return Map.entry(intentId,
                new IntentDisposition(intentId, Support.IMPLEMENTED, IMPLEMENTED_BASIS));
    }

    private static Map.Entry<String, IntentDisposition> delegated(String intentId, String owner) {
        return Map.entry(intentId,
                new IntentDisposition(intentId, Support.DELEGATED, owner));
    }

    private static Map.Entry<String, IntentDisposition> notAdmitted(String intentId, String gap) {
        return Map.entry(intentId,
                new IntentDisposition(intentId, Support.NOT_ADMITTED, gap));
    }

    private StreamIntentSupport() {
    }

    /** All 17 PDP {@code media.stream} leaf intent IDs covered by this matrix. */
    public static Set<String> coveredIntents() {
        return Set.copyOf(MATRIX.keySet());
    }

    /**
     * The disposition of one intent, or {@code null} when the ID is not a
     * covered {@code media.stream} leaf — an unknown intent is never
     * reported as supported.
     */
    public static IntentDisposition dispositionOf(String intentId) {
        return MATRIX.get(intentId);
    }

    /**
     * Whether frames or effects for this intent may proceed through this
     * module. Only {@link Support#IMPLEMENTED} admits; delegated and
     * unadmitted intents fail closed here and are resolved by their owner.
     */
    public static boolean admittedHere(String intentId) {
        IntentDisposition disposition = MATRIX.get(intentId);
        return disposition != null && disposition.support() == Support.IMPLEMENTED;
    }
}
