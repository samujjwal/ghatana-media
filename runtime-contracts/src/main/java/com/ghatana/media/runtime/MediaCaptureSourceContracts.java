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

    public static final int MAX_CAPTURED_FRAME_BYTES = 64 * 1024 * 1024;
    private static final long MAX_SAFE_TIMESTAMP_MILLIS = 9_007_199_254_740_991L;

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

    /** Source-defined, observation-only result of capture.probe.v1. */
    public enum ProbeDisposition { QUALIFIED, NOT_QUALIFIED, UNAVAILABLE, DENIED }

    /** Exact capture.probe.v1 request fields; this operation cannot start capture. */
    public record ProbeRequest(
            String tenantId,
            String sourceId,
            String providerProfileId,
            java.util.List<String> requestedSignals,
            String policyRef) {
        public ProbeRequest {
            requireCaptureField(tenantId);
            requireCaptureField(sourceId);
            requireCaptureField(providerProfileId);
            requireCaptureField(policyRef);
            if (requestedSignals == null || requestedSignals.isEmpty() || requestedSignals.size() > 32) {
                throw new IllegalArgumentException("requestedSignals must contain 1..32 entries");
            }
            requestedSignals = java.util.List.copyOf(requestedSignals);
            requestedSignals.forEach(MediaCaptureSourceContracts::requireCaptureField);
        }
    }

    /** Typed probe result. Qualification is an observation and never starts capture. */
    public record ProbeResult(ProbeDisposition disposition) {
        public ProbeResult {
            Objects.requireNonNull(disposition, "disposition");
        }
    }

    /** Trusted observation seam; no implementation is admitted by default. */
    @FunctionalInterface
    public interface AdapterProbe {
        ProbeResult probe(ProbeRequest request);

        static AdapterProbe none() {
            return request -> new ProbeResult(ProbeDisposition.NOT_QUALIFIED);
        }
    }

    /** Calls the observation seam with an immutable bounded request snapshot. */
    public static ProbeResult probe(AdapterProbe adapterProbe, ProbeRequest request) {
        Objects.requireNonNull(adapterProbe, "adapterProbe");
        Objects.requireNonNull(request, "request");
        try {
            ProbeResult result = adapterProbe.probe(request);
            return result == null
                    ? new ProbeResult(ProbeDisposition.UNAVAILABLE)
                    : result;
        } catch (RuntimeException ignored) {
            // Probe error text can contain credentials or source details.
            return new ProbeResult(ProbeDisposition.UNAVAILABLE);
        }
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
            String exactRightsScope,
            String sourceVersionRef,
            String secretsRef,
            String frameClockRef) {
        public CaptureRequest {
            Objects.requireNonNull(kind, "kind");
            for (String field : new String[]{
                    sourceIdentity, purposeRef, exactRightsScope, sourceVersionRef, secretsRef, frameClockRef}) {
                requireCaptureField(field);
            }
        }
    }

    /** Actual captured output — real bytes with their frame clock, or nothing. */
    public record CapturedBytes(
            String sourceIdentity,
            String purposeRef,
            String exactRightsScope,
            String sourceVersionRef,
            String frameClockRef,
            byte[] bytes,
            long capturedAtEpochMillis) {
        public CapturedBytes {
            requireCaptureField(sourceIdentity);
            requireCaptureField(purposeRef);
            requireCaptureField(exactRightsScope);
            requireCaptureField(sourceVersionRef);
            requireCaptureField(frameClockRef);
            Objects.requireNonNull(bytes, "bytes");
            if (bytes.length == 0 || bytes.length > MAX_CAPTURED_FRAME_BYTES) {
                throw new IllegalArgumentException("captured bytes must be non-empty and bounded");
            }
            if (capturedAtEpochMillis < 0 || capturedAtEpochMillis > MAX_SAFE_TIMESTAMP_MILLIS) {
                throw new IllegalArgumentException("capture timestamp must be a non-negative safe integer");
            }
            bytes = bytes.clone();
        }

        @Override public byte[] bytes() {
            return bytes.clone();
        }

        /** Output provenance must bind the full authorized request, not just its clock. */
        public boolean isBoundTo(CaptureRequest request) {
            return request != null
                    && sourceIdentity.equals(request.sourceIdentity())
                    && purposeRef.equals(request.purposeRef())
                    && exactRightsScope.equals(request.exactRightsScope())
                    && sourceVersionRef.equals(request.sourceVersionRef())
                    && frameClockRef.equals(request.frameClockRef());
        }
    }

    private static void requireCaptureField(String field) {
        if (field == null || field.isBlank() || field.length() > 384 || !field.equals(field.strip())) {
            throw new IllegalArgumentException("capture field is required, canonical and bounded");
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
        Objects.requireNonNull(eligibility, "eligibility");
        Objects.requireNonNull(request, "request");
        return eligibility.check(request) == Eligibility.ADMITTED;
    }
}
