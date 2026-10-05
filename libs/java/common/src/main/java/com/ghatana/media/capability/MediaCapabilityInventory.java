package com.ghatana.media.capability;

import java.util.EnumMap;
import java.util.Map;
import java.util.Objects;

/**
 * Explicit media capability inventory used by composition and transport layers.
 * An absent or unavailable provider is never represented as ready.
 *
 * @doc.type record
 * @doc.purpose Represent Media Capability Inventory values
 * @doc.layer product
 * @doc.pattern ValueObject
 */
public record MediaCapabilityInventory(Map<Capability, Status> capabilities) {
    public MediaCapabilityInventory {
        Objects.requireNonNull(capabilities, "capabilities");
        EnumMap<Capability, Status> copy = new EnumMap<>(Capability.class);
        copy.putAll(capabilities);
        for (Capability capability : Capability.values()) {
            copy.putIfAbsent(capability, Status.NOT_IMPLEMENTED);
        }
        capabilities = Map.copyOf(copy);
    }

    public Status status(Capability capability) {
        return capabilities.getOrDefault(capability, Status.NOT_IMPLEMENTED);
    }

    public boolean available(Capability capability) {
        return status(capability) == Status.RUNTIME_SUPPORTED;
    }

    /** Fails closed at the composition boundary when an operation is not actually available. */
    public void requireAvailable(Capability capability) {
        Objects.requireNonNull(capability, "capability");
        Status current = status(capability);
        if (current != Status.RUNTIME_SUPPORTED) {
            throw new IllegalStateException(
                    "Media capability " + capability + " is " + current + " and cannot be invoked");
        }
    }

    public enum Capability {
        STT, TTS, OBJECT_DETECTION, CLASSIFICATION, CAPTION, SEGMENTATION,
        TRACKING, AUDIO, VIDEO, TRANSCODING, MULTIMODAL
    }

    public enum Status {
        RUNTIME_SUPPORTED,
        LIBRARY_ONLY,
        PROVIDER_OPTIONAL,
        NOT_IMPLEMENTED,
        RETIRED
    }
}
