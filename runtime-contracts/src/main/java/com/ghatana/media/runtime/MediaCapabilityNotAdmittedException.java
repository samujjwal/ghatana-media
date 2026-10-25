package com.ghatana.media.runtime;

/** Typed, zero-effect refusal when a requested Media modality has no usable admitted provider. */
public class MediaCapabilityNotAdmittedException extends SecurityException {
    public enum Reason { NOT_ADMITTED, PROVIDER_UNAVAILABLE, POLICY_DENIED, SOURCE_VERSION_STALE }

    private final Reason reason;
    private final String modality;

    public MediaCapabilityNotAdmittedException(Reason reason, String modality) {
        super(message(reason, modality));
        this.reason = java.util.Objects.requireNonNull(reason, "reason");
        if (modality == null || modality.isBlank()) throw new IllegalArgumentException("modality is required");
        this.modality = modality;
    }

    public MediaCapabilityNotAdmittedException(Reason reason, String modality, String detail) {
        super(message(reason, modality)
                + (detail == null || detail.isBlank() ? "" : ": " + detail));
        this.reason = java.util.Objects.requireNonNull(reason, "reason");
        if (modality == null || modality.isBlank()) throw new IllegalArgumentException("modality is required");
        this.modality = modality;
    }

    public Reason reason() { return reason; }
    public String modality() { return modality; }

    private static String message(Reason reason, String modality) {
        java.util.Objects.requireNonNull(reason, "reason");
        return switch (reason) {
            case NOT_ADMITTED -> "Media capability is not admitted: " + modality;
            case PROVIDER_UNAVAILABLE -> "Admitted Media capability has no available provider: " + modality;
            case POLICY_DENIED -> "Media capability request was denied by policy";
            case SOURCE_VERSION_STALE -> "Media source version is stale";
        };
    }
}
