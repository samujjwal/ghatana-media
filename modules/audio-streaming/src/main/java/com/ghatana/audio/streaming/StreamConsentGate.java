package com.ghatana.audio.streaming;

import java.util.Objects;

/**
 * Live consent seam for stream sessions.
 *
 * <p>AS-05: consent is re-evaluated at every guarded transition — connect,
 * frame submit, provider dispatch and reconnect — never cached from session
 * open. Caller-supplied consent strings are deliberately not an input; the
 * trusted {@link Source} resolves the current decision for the immutable
 * session identity and generation.
 *
 * @doc.type interface
 * @doc.purpose Per-transition consent evaluation for stream sessions
 * @doc.layer product
 * @doc.pattern Policy Gate
 */
public final class StreamConsentGate {

    private StreamConsentGate() {
    }

    /** The decision a trusted consent source returns for one transition. */
    public enum Decision {
        /** The transition may proceed; frames and external effects are allowed. */
        ADMITTED,
        /** The purpose is revoked or the identity is unauthorized — fail closed. */
        DENIED,
        /** No consent record is admitted for this context — fail closed. */
        NOT_ADMITTED,
        /** The consent grant has expired — equivalent to revoked for new work. */
        EXPIRED
    }

    /**
     * Immutable consent context for one guarded transition. The session
     * generation lets a stale reconnect generation be distinguished from the
     * current authorized one.
     */
    public record ConsentContext(
            String tenantId,
            String principalId,
            String purposeRef,
            long sessionGeneration) {
        public ConsentContext {
            Objects.requireNonNull(tenantId, "tenantId");
            Objects.requireNonNull(principalId, "principalId");
            Objects.requireNonNull(purposeRef, "purposeRef");
            if (sessionGeneration < 0) {
                throw new IllegalArgumentException("sessionGeneration must be >= 0");
            }
        }
    }

    /** Trusted consent source; re-queried at every transition, never cached. */
    @FunctionalInterface
    public interface Source {
        Decision authorize(ConsentContext context);

        /** A source with no admitted consent — every transition fails closed. */
        static Source unavailable() {
            return context -> Decision.NOT_ADMITTED;
        }
    }

    /**
     * Returns true only when the decision permits new frames or external
     * provider effects. DENIED, NOT_ADMITTED and EXPIRED all fail closed.
     */
    public static boolean permits(Decision decision) {
        return decision == Decision.ADMITTED;
    }
}
