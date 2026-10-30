package com.ghatana.audio.video.infrastructure.cache;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Cache keys can embed tenant, principal, artifact or transcript identity.
 * Diagnostics must expose only a bounded, correlatable reference — never the
 * raw key material or a secret marker.
 */
class AudioVideoCacheKeyRedactionTest {

    @Test
    void keyReferenceIsBoundedDeterministicAndDisclosesNoKeyMaterial() {
        String tenantKey = "media-cache:tenant-987-secret:transcript-654-private";

        String reference = AudioVideoCache.keyReference(tenantKey);
        assertThat(reference).matches("sha256:[0-9a-f]{12}");
        assertThat(reference).isEqualTo(AudioVideoCache.keyReference(tenantKey));
        assertThat(reference).doesNotContain("tenant-987-secret", "transcript-654-private",
                "tenant", "secret");
        assertThat(AudioVideoCache.keyReference(
                        "media-cache:tenant-987-secret:other-id"))
                .isNotEqualTo(reference);
        assertThat(AudioVideoCache.keyReference(12345)).matches("sha256:[0-9a-f]{12}");
    }
}
