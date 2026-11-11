package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class MediaLauncherTest {
    @Test
    void shutdownCleanupKeepsFirstFailureAndSuppressesLaterFailuresInOrder() {
        RuntimeException timelineFailure = new RuntimeException("timeline close failed");
        RuntimeException captionFailure = new RuntimeException("caption close failed");
        RuntimeException consentFailure = new RuntimeException("consent close failed");

        RuntimeException primary = MediaLauncher.appendShutdownFailure(null, timelineFailure);
        primary = MediaLauncher.appendShutdownFailure(primary, captionFailure);
        primary = MediaLauncher.appendShutdownFailure(primary, consentFailure);

        assertThat(primary).isSameAs(timelineFailure);
        assertThat(primary.getSuppressed()).containsExactly(captionFailure, consentFailure);
    }

    @Test
    void repeatedCleanupFailureInstanceDoesNotInterruptShutdownAggregation() {
        RuntimeException repeatedFailure = new RuntimeException("shared close failure");

        RuntimeException primary = MediaLauncher.appendShutdownFailure(null, repeatedFailure);
        RuntimeException afterRepeated = MediaLauncher.appendShutdownFailure(primary, repeatedFailure);
        RuntimeException laterFailure = new RuntimeException("later close failure");
        RuntimeException afterLater = MediaLauncher.appendShutdownFailure(afterRepeated, laterFailure);

        assertThat(afterLater).isSameAs(repeatedFailure);
        assertThat(afterLater.getSuppressed()).containsExactly(laterFailure);
    }
}
