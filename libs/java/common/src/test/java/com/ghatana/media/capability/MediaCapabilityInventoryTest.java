package com.ghatana.media.capability;

import org.junit.jupiter.api.Test;

import java.util.EnumMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaCapabilityInventoryTest {
    @Test
    void inventoryOwnsAnImmutableSnapshotOfCapabilityStatuses() {
        var supplied = new EnumMap<MediaCapabilityInventory.Capability, MediaCapabilityInventory.Status>(
                MediaCapabilityInventory.Capability.class);
        supplied.put(MediaCapabilityInventory.Capability.STT,
                MediaCapabilityInventory.Status.PROVIDER_OPTIONAL);

        MediaCapabilityInventory inventory = new MediaCapabilityInventory(supplied);
        supplied.put(MediaCapabilityInventory.Capability.STT,
                MediaCapabilityInventory.Status.RUNTIME_SUPPORTED);

        assertThat(inventory.status(MediaCapabilityInventory.Capability.STT))
                .isEqualTo(MediaCapabilityInventory.Status.PROVIDER_OPTIONAL);
        assertThatThrownBy(() -> inventory.capabilities().put(
                MediaCapabilityInventory.Capability.STT,
                MediaCapabilityInventory.Status.RUNTIME_SUPPORTED))
                .isInstanceOf(UnsupportedOperationException.class);
    }

    @Test
    void missingCapabilitiesDefaultToNonRuntimeStates() {
        MediaCapabilityInventory inventory = new MediaCapabilityInventory(Map.of(
                MediaCapabilityInventory.Capability.OBJECT_DETECTION,
                MediaCapabilityInventory.Status.RUNTIME_SUPPORTED));

        assertThat(inventory.available(MediaCapabilityInventory.Capability.OBJECT_DETECTION)).isTrue();
        assertThat(inventory.status(MediaCapabilityInventory.Capability.CAPTION))
                .isEqualTo(MediaCapabilityInventory.Status.NOT_IMPLEMENTED);
        assertThatThrownBy(() -> inventory.requireAvailable(
                MediaCapabilityInventory.Capability.CAPTION))
                .isInstanceOf(IllegalStateException.class);
    }
}
