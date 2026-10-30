package com.ghatana.media.runtime;

import java.util.Objects;

/**
 * H-04: capture-source adapter contracts — eligibility for every declared
 * capture surface is decided per adapter through the trusted seam, never by
 * a caller flag.
 *
 * <p>A capture adapter is usable only with source identity, rights/purpose
 * and version, controlled secrets and a real frame clock producing actual
 * captured bytes. Disabled or unadmitted adapters return
 * {@link Eligibility#NOT_ADMITTED}; nothing fabricates screen pixels,
 * device availability or product success.
 *
 * @doc.type class
 * @doc.purpose Capture adapter eligibility + capture request contracts
 * @doc.layer product
 * @doc.pattern Contracts
 */
public final class MediaCaptureSourceContracts {

    private MediaCaptureSourceContracts() {
    }

    /** Declared capture adapter kinds. */
    public enum CaptureSourceKind {
        BROWSER, DESKTOP, MOBILE, TERMINAL, HTTP_API, GRPC_API, CAMERA, MEDIA_FILE
    }

    /** Whether an adapter may capture for one request. */
    public enum Eligibility {
        /** Adapter qualified and admitted for this request. */
        ADMITTED,
        /** Not admitted — device rights, consent or implementation missing. */
        NOT_ADMITTED,
        /** Eligibility cannot be decided — fail closed. */
        UNAVAILABLE
    }

    /**
     * One capture request: the immutable identity of what may be captured,
     * for what purpose, at which source revision. Secrets are referenced,
     * never embedded.
     */
    public record CaptureRequest(
            CaptureSourceKind kind,
            String sourceIdentity,
            String purposeRef,
            String sourceVersionRef,
            String secretsRef,
            String frameClockRef) {
        public CaptureRequest {
            Objects.requireNonNull(kind, "kind");
            for (String field : new String[]{
                    sourceIdentity, purposeRef, sourceVersionRef, secretsRef, frameClockRef}) {
                if (field == null || field.isBlank() || field.length() > 384) {
                    throw new IllegalArgumentException("capture request field is required and bounded");
                }
            }
        }
    }

    /** Actual captured output — real bytes with their frame clock, or nothing. */
    public record CapturedBytes(
            String sourceIdentity,
            String frameClockRef,
            byte[] bytes,
            long capturedAtEpochMillis) {
        public CapturedBytes {
            Objects.requireNonNull(sourceIdentity, "sourceIdentity");
            Objects.requireNonNull(frameClockRef, "frameClockRef");
            Objects.requireNonNull(bytes, "bytes");
        }
    }

    /** Trusted adapter eligibility seam; caller assertions are not inputs. */
    @FunctionalInterface
    public interface AdapterEligibility {
        Eligibility check(CaptureRequest request);

        /** No adapter admitted — every kind fails closed. */
        static AdapterEligibility none() {
            return request -> Eligibility.NOT_ADMITTED;
        }
    }

    /**
     * Evaluates a capture request against the eligibility seam. Only an
     * ADMITTED adapter may produce bytes; every other outcome is denied.
     */
    public static boolean mayCapture(AdapterEligibility eligibility, CaptureRequest request) {
        return eligibility.check(request) == Eligibility.ADMITTED;
    }
}
