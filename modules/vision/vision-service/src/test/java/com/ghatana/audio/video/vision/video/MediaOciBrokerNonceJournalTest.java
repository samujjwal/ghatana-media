package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaOciBrokerNonceJournalTest {

    private static final String TOKEN = "broker-replay-test-key-material-0123456789abcdef";
    private static final String OTHER_TOKEN = "different-broker-key-material-0123456789abcdef";

    @TempDir Path root;

    @Test
    void tamperedReplayStateFailsClosedAtBrokerStartup() throws Exception {
        Path state = privateDirectory("tampered-state");
        try (var journal = MediaOciBrokerNonceJournal.open(state, TOKEN)) {
            long admissionNow = System.currentTimeMillis();
            journal.reserve("tamper-me-nonce-0123456789", admissionNow, admissionNow);
        }

        Path replayFile = state.resolve("media-oci-nonce-replay.v1");
        byte[] contents = Files.readAllBytes(replayFile);
        contents[contents.length - 2] = contents[contents.length - 2] == '0' ? (byte) '1' : (byte) '0';
        Files.write(replayFile, contents);

        assertThatThrownBy(() -> MediaOciBrokerNonceJournal.open(state, TOKEN))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("integrity");
    }

    @Test
    void changedBrokerTokenCannotReopenExistingReplayState() throws Exception {
        Path state = privateDirectory("rotated-token-state");
        try (var journal = MediaOciBrokerNonceJournal.open(state, TOKEN)) {
            long admissionNow = System.currentTimeMillis();
            journal.reserve("token-bound-nonce-0123456789", admissionNow, admissionNow);
        }

        assertThatThrownBy(() -> MediaOciBrokerNonceJournal.open(state, OTHER_TOKEN))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("integrity");
    }

    @Test
    void onlyOneBrokerProcessCanOwnTheReplayJournal() throws Exception {
        Path state = privateDirectory("locked-state");
        try (var first = MediaOciBrokerNonceJournal.open(state, TOKEN)) {
            assertThatThrownBy(() -> MediaOciBrokerNonceJournal.open(state, TOKEN))
                    .isInstanceOf(IOException.class)
                    .hasMessageContaining("Another broker process");
        }
        try (var afterClose = MediaOciBrokerNonceJournal.open(state, TOKEN)) {
            long admissionNow = System.currentTimeMillis();
            afterClose.reserve("after-close-nonce-0123456789", admissionNow, admissionNow);
        }
    }

    @Test
    void fullLiveWindowRejectsFreshAndReplayedNoncesAcrossRestart() throws Exception {
        Path state = privateDirectory("full-state");
        long timestamp = System.currentTimeMillis();
        try (var journal = MediaOciBrokerNonceJournal.open(state, TOKEN, 2)) {
            long admissionNow = System.currentTimeMillis();
            org.assertj.core.api.Assertions.assertThat(journal.reserve(
                    "first-live-nonce-0123456789", timestamp, admissionNow))
                    .isTrue();
            org.assertj.core.api.Assertions.assertThat(journal.reserve(
                    "second-live-nonce-0123456789", timestamp, admissionNow))
                    .isTrue();
            org.assertj.core.api.Assertions.assertThat(journal.reserve(
                    "third-live-nonce-0123456789", timestamp, admissionNow))
                    .isFalse();
            org.assertj.core.api.Assertions.assertThat(journal.reserve(
                    "first-live-nonce-0123456789", timestamp, admissionNow))
                    .isFalse();
        }
        try (var restarted = MediaOciBrokerNonceJournal.open(state, TOKEN, 2)) {
            org.assertj.core.api.Assertions.assertThat(
                    restarted.reserve("first-live-nonce-0123456789", timestamp, System.currentTimeMillis()))
                    .isFalse();
            org.assertj.core.api.Assertions.assertThat(
                    restarted.reserve("third-live-nonce-0123456789", timestamp, System.currentTimeMillis()))
                    .isFalse();
        }
    }

    @Test
    void persistedClockHighWaterRejectsRollbackAndTornFinalAppendIsRecovered() throws Exception {
        Path state = privateDirectory("clock-state");
        long now = System.currentTimeMillis();
        try (var journal = MediaOciBrokerNonceJournal.open(state, TOKEN)) {
            long admissionNow = System.currentTimeMillis();
            org.assertj.core.api.Assertions.assertThat(journal.reserve(
                    "clock-window-nonce-0123456789", now, admissionNow))
                    .isTrue();
        }
        try (var restarted = MediaOciBrokerNonceJournal.open(state, TOKEN)) {
            assertThatThrownBy(() -> restarted.reserve(
                    "clock-rollback-nonce-0123456789", now - 1, now - 1))
                    .isInstanceOf(IOException.class)
                    .hasMessageContaining("clock");
        }

        Path tornState = privateDirectory("torn-state");
        try (var journal = MediaOciBrokerNonceJournal.open(tornState, TOKEN)) {
            // No request was admitted before this incomplete tail was written.
        }
        Path replayFile = tornState.resolve("media-oci-nonce-replay.v1");
        long completeHeaderSize = Files.size(replayFile);
        Files.write(replayFile, new byte[]{'x', 'y', 'z'}, java.nio.file.StandardOpenOption.APPEND);
        try (var recovered = MediaOciBrokerNonceJournal.open(tornState, TOKEN)) {
            org.assertj.core.api.Assertions.assertThat(Files.size(replayFile)).isEqualTo(completeHeaderSize);
            long requestTime = System.currentTimeMillis();
            org.assertj.core.api.Assertions.assertThat(
                    recovered.reserve("after-torn-write-nonce-012345", requestTime, requestTime))
                    .isTrue();
        }
    }

    @Test
    void forcedCompactionPreservesReplayEvidenceAndClockFloorAcrossRestart() throws Exception {
        Path state = privateDirectory("compacted-state");
        String nonce = "compacted-live-nonce-0123456789";
        long timestamp = System.currentTimeMillis();
        try (var journal = MediaOciBrokerNonceJournal.open(state, TOKEN, 2, 1)) {
            long admissionNow = System.currentTimeMillis();
            org.assertj.core.api.Assertions.assertThat(journal.reserve(nonce, timestamp, admissionNow)).isTrue();
        }
        try (var restarted = MediaOciBrokerNonceJournal.open(state, TOKEN, 2, 1)) {
            long admissionNow = System.currentTimeMillis();
            org.assertj.core.api.Assertions.assertThat(restarted.reserve(nonce, timestamp, admissionNow))
                    .as("compaction cannot discard an unexpired nonce")
                    .isFalse();
            assertThatThrownBy(() -> restarted.reserve(
                    "clock-floor-rollback-nonce-012345", admissionNow - 1, admissionNow - 1))
                    .isInstanceOf(IOException.class)
                    .hasMessageContaining("clock");
        }
    }

    @Test
    void stateDirectoryMustBeOwnerOnly() throws Exception {
        Path state = Files.createDirectory(root.resolve("shared-state"));
        Files.setPosixFilePermissions(state, PosixFilePermissions.fromString("rwxr-x---"));

        assertThatThrownBy(() -> MediaOciBrokerNonceJournal.open(state, TOKEN))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("0700");
    }

    private Path privateDirectory(String name) throws IOException {
        Path directory = Files.createDirectory(root.resolve(name));
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        return directory;
    }
}
