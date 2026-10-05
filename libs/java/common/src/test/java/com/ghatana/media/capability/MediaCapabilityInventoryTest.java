package com.ghatana.media.capability;

import org.junit.jupiter.api.Test;

import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaCapabilityInventoryTest {
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
