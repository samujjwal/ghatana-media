package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.channels.FileChannel;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardOpenOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Durable registry tests; no OCI worker is launched by this suite. */
class MediaOciBrokerWhisperJournalTest {
    private static final String SECRET = "journal-test-key-material-0123456789abcdef";
    private static final String MODEL = "b".repeat(64);
    private static final String INPUT = "a".repeat(64);

    @TempDir Path root;

    private Path privateDirectory(String name) throws IOException {
        Path directory = root.resolve(name);
        Files.createDirectory(directory);
        Files.setPosixFilePermissions(directory, PosixFilePermissions.fromString("rwx------"));
        return directory;
    }

    private static MediaOciBrokerWhisperJournal.Identity identity() {
        return new MediaOciBrokerWhisperJournal.Identity(
                UUID.fromString("123e4567-e89b-12d3-a456-426614174000"),
                "whisper.en.reference.v1", "en-US", INPUT);
    }

    @Test
    void startedReservationRecoversAsUnknownAndCannotBeRerun() throws Exception {
        Path directory = privateDirectory("started-recovery");
        try (var journal = MediaOciBrokerWhisperJournal.open(directory, SECRET, 4)) {
            assertThat(journal.begin(identity()).kind())
                    .isEqualTo(MediaOciBrokerWhisperJournal.BeginKind.RESERVED);
        }

        try (var journal = MediaOciBrokerWhisperJournal.open(directory, SECRET, 4)) {
            assertThat(journal.lookup(identity()).status())
                    .isEqualTo(MediaOciBrokerWhisperJournal.Status.UNKNOWN_OUTCOME);
            var duplicate = journal.begin(identity());
            assertThat(duplicate.kind()).isEqualTo(MediaOciBrokerWhisperJournal.BeginKind.EXISTING);
            assertThat(duplicate.entry().status())
                    .isEqualTo(MediaOciBrokerWhisperJournal.Status.UNKNOWN_OUTCOME);
            assertThat(journal.recordCount()).isEqualTo(1);
        }
    }

    @Test
    void successIsAuthenticatedEncryptedAtRestAndReadBackExactlyAfterRestart() throws Exception {
        Path directory = privateDirectory("success-recovery");
        String transcript = "recognized private words 🌿";
        try (var journal = MediaOciBrokerWhisperJournal.open(directory, SECRET, 4)) {
            journal.begin(identity());
            var result = journal.completeSuccess(identity(), MODEL, transcript);
            assertThat(result.status()).isEqualTo(MediaOciBrokerWhisperJournal.Status.SUCCESS);
            assertThat(result.transcript()).isEqualTo(transcript);
        }

        byte[] journalBytes = Files.readAllBytes(directory.resolve("whisper-invocations.log"));
        assertThat(new String(journalBytes, java.nio.charset.StandardCharsets.UTF_8)).doesNotContain(transcript);
        try (var journal = MediaOciBrokerWhisperJournal.open(directory, SECRET, 4)) {
            var result = journal.lookup(identity());
            assertThat(result.status()).isEqualTo(MediaOciBrokerWhisperJournal.Status.SUCCESS);
            assertThat(result.modelSha256()).isEqualTo(MODEL);
            assertThat(result.transcript()).isEqualTo(transcript);
        }
        assertThatThrownBy(() -> MediaOciBrokerWhisperJournal.open(directory,
                "different-key-material-0123456789abcdef", 4))
                .isInstanceOf(IOException.class)
                .hasMessageContaining("integrity");
    }

    @Test
    void duplicateInvocationBindsProfileLocaleAndInputDigest() throws Exception {
        Path directory = privateDirectory("duplicate-binding");
        try (var journal = MediaOciBrokerWhisperJournal.open(directory, SECRET, 4)) {
            journal.begin(identity());
            var same = journal.begin(identity());
            assertThat(same.kind()).isEqualTo(MediaOciBrokerWhisperJournal.BeginKind.EXISTING);
            var conflict = new MediaOciBrokerWhisperJournal.Identity(identity().invocationId(),
                    identity().profileId(), "en", INPUT);
            assertThat(journal.begin(conflict).kind())
                    .isEqualTo(MediaOciBrokerWhisperJournal.BeginKind.IDENTITY_CONFLICT);
            assertThat(journal.lookup(conflict)).isNull();
            assertThatThrownBy(() -> journal.completeSuccess(conflict, MODEL, "no"))
                    .isInstanceOf(IOException.class).hasMessageContaining("mismatched");
        }
    }

    @Test
    void explicitUnknownIsTerminalAndCannotBeReplacedBySuccess() throws Exception {
        Path directory = privateDirectory("explicit-unknown");
        try (var journal = MediaOciBrokerWhisperJournal.open(directory, SECRET, 4)) {
            journal.begin(identity());
            assertThat(journal.markUnknown(identity()).status())
                    .isEqualTo(MediaOciBrokerWhisperJournal.Status.UNKNOWN_OUTCOME);
            assertThat(journal.markUnknown(identity()).status())
                    .isEqualTo(MediaOciBrokerWhisperJournal.Status.UNKNOWN_OUTCOME);
            assertThatThrownBy(() -> journal.completeSuccess(identity(), MODEL, "too late"))
                    .isInstanceOf(IOException.class).hasMessageContaining("STARTED");
        }
        try (var journal = MediaOciBrokerWhisperJournal.open(directory, SECRET, 4)) {
            assertThat(journal.lookup(identity()).status())
                    .isEqualTo(MediaOciBrokerWhisperJournal.Status.UNKNOWN_OUTCOME);
        }
    }

    @Test
    void capacityRefusesNewInvocationWithoutEviction() throws Exception {
        Path directory = privateDirectory("capacity");
        var first = identity();
        var second = new MediaOciBrokerWhisperJournal.Identity(UUID.randomUUID(),
                first.profileId(), first.locale(), INPUT);
        try (var journal = MediaOciBrokerWhisperJournal.open(directory, SECRET, 1)) {
            assertThat(journal.begin(first).kind()).isEqualTo(MediaOciBrokerWhisperJournal.BeginKind.RESERVED);
            assertThat(journal.begin(second).kind()).isEqualTo(MediaOciBrokerWhisperJournal.BeginKind.CAPACITY);
            assertThat(journal.lookup(first)).isNotNull();
            assertThat(journal.lookup(second)).isNull();
            assertThat(journal.recordCount()).isEqualTo(1);
        }
    }

    @Test
    void tornAndCorruptRecordsFailClosed() throws Exception {
        Path tornDirectory = privateDirectory("torn");
        try (var journal = MediaOciBrokerWhisperJournal.open(tornDirectory, SECRET, 4)) {
            journal.begin(identity());
        }
        Path tornFile = tornDirectory.resolve("whisper-invocations.log");
        try (FileChannel channel = FileChannel.open(tornFile, StandardOpenOption.WRITE)) {
            channel.truncate(Files.size(tornFile) - 1);
            channel.force(true);
        }
        assertThatThrownBy(() -> MediaOciBrokerWhisperJournal.open(tornDirectory, SECRET, 4))
                .isInstanceOf(IOException.class).hasMessageContaining("Torn");

        Path corruptDirectory = privateDirectory("corrupt");
        try (var journal = MediaOciBrokerWhisperJournal.open(corruptDirectory, SECRET, 4)) {
            journal.begin(identity());
        }
        Path corruptFile = corruptDirectory.resolve("whisper-invocations.log");
        byte[] bytes = Files.readAllBytes(corruptFile);
        bytes[bytes.length / 2] ^= 1;
        Files.write(corruptFile, bytes, StandardOpenOption.TRUNCATE_EXISTING);
        assertThatThrownBy(() -> MediaOciBrokerWhisperJournal.open(corruptDirectory, SECRET, 4))
                .isInstanceOf(IOException.class).hasMessageContaining("integrity");
    }

    @Test
    void journalRequiresOwnerOnlyNonSymlinkDirectoryAndFiles() throws Exception {
        Path broadDirectory = privateDirectory("broad-perms");
        Files.setPosixFilePermissions(broadDirectory,
                PosixFilePermissions.fromString("rwxr-x---"));
        assertThatThrownBy(() -> MediaOciBrokerWhisperJournal.open(broadDirectory, SECRET, 2))
                .isInstanceOf(IOException.class).hasMessageContaining("0700");

        Path symlinkDirectoryTarget = privateDirectory("symlink-target");
        Path directoryLink = root.resolve("directory-link");
        Files.createSymbolicLink(directoryLink, symlinkDirectoryTarget);
        assertThatThrownBy(() -> MediaOciBrokerWhisperJournal.open(directoryLink, SECRET, 2))
                .isInstanceOf(IOException.class).hasMessageContaining("non-symlink");

        Path fileDirectory = privateDirectory("file-link");
        Path target = fileDirectory.resolve("target");
        Files.writeString(target, "x");
        Files.setPosixFilePermissions(target, PosixFilePermissions.fromString("rw-------"));
        Files.createSymbolicLink(fileDirectory.resolve("whisper-invocations.log"), target);
        assertThatThrownBy(() -> MediaOciBrokerWhisperJournal.open(fileDirectory, SECRET, 2))
                .isInstanceOf(IOException.class).hasMessageContaining("non-symlink");
    }

    @Test
    void processLockExcludesSecondJournalInstance() throws Exception {
        Path directory = privateDirectory("lock");
        try (var journal = MediaOciBrokerWhisperJournal.open(directory, SECRET, 2)) {
            assertThatThrownBy(() -> MediaOciBrokerWhisperJournal.open(directory, SECRET, 2))
                    .isInstanceOf(IOException.class).hasMessageContaining("already open");
        }
        try (var reopened = MediaOciBrokerWhisperJournal.open(directory, SECRET, 2)) {
            assertThat(reopened.recordCount()).isZero();
        }
    }

    @Test
    void filesAreCreatedOwnerOnly() throws Exception {
        Path directory = privateDirectory("modes");
        try (var ignored = MediaOciBrokerWhisperJournal.open(directory, SECRET, 2)) {
            assertThat(Files.getPosixFilePermissions(directory.resolve("whisper-invocations.lock")))
                    .containsExactlyInAnyOrderElementsOf(PosixFilePermissions.fromString("rw-------"));
            assertThat(Files.getPosixFilePermissions(directory.resolve("whisper-invocations.log")))
                    .containsExactlyInAnyOrderElementsOf(PosixFilePermissions.fromString("rw-------"));
        }
    }
}
