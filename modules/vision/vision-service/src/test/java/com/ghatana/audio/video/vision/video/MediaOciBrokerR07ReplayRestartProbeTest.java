package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;

import static org.assertj.core.api.Assertions.assertThat;

/** Source-free restart check for the broker's durable nonce replay window. */
class MediaOciBrokerR07ReplayRestartProbeTest {

    private static final String TOKEN = "broker-replay-test-key-material-0123456789abcdef";

    @TempDir Path stateDirectory;

    @Test
    void replayedAuthenticatedNonceRemainsRejectedAfterJournalAndGuardRestart() throws Exception {
        String nonce = "replay-across-restart-012345";
        long timestamp = System.currentTimeMillis();
        Files.setPosixFilePermissions(stateDirectory, PosixFilePermissions.fromString("rwx------"));

        try (var journal = MediaOciBrokerNonceJournal.open(stateDirectory, TOKEN)) {
            var firstBrokerProcess = new MediaOciBrokerPolicy.NonceReplayGuard(journal);
            long admissionNow = System.currentTimeMillis();
            assertThat(firstBrokerProcess.admit(nonce, timestamp, admissionNow)).isTrue();
            assertThat(firstBrokerProcess.admit(nonce, timestamp, admissionNow))
                    .as("same-process replay").isFalse();
        }

        try (var journal = MediaOciBrokerNonceJournal.open(stateDirectory, TOKEN)) {
            var restartedBrokerProcess = new MediaOciBrokerPolicy.NonceReplayGuard(journal);
            long admissionNow = System.currentTimeMillis();
            assertThat(restartedBrokerProcess.admit(nonce, timestamp, admissionNow))
                    .as("replay after broker restart")
                    .isFalse();
            assertThat(restartedBrokerProcess.admit("fresh-after-restart-nonce-012345", timestamp, admissionNow))
                    .isTrue();
        }
    }
}
