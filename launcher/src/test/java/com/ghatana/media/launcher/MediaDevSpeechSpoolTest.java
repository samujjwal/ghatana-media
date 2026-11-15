package com.ghatana.media.launcher;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaDevSpeechSpoolTest {
    @TempDir Path directory;

    private static Map<String, Object> lineage(long millis) {
        Map<String, Object> lineage = new LinkedHashMap<>();
        lineage.put("kind", "LOCAL_TTS_AUDIO");
        lineage.put("speakingRate", 1.0);
        lineage.put("inputTextChars", 12);
        lineage.put("audio", Map.of("sampleRate", 24000, "durationMillis", millis));
        return lineage;
    }

    @Test
    void anEntryIsReadBackExactlyAndNormalisedSoFirstUseAndReplayAgree() {
        MediaDevSpeechSpool spool = new MediaDevSpeechSpool(directory);
        byte[] wav = {1, 2, 3, 4};
        MediaDevSpeechSpool.Entry stored = spool.put("k1", "fp-1", wav, lineage(2500));
        assertThat(stored.wav()).containsExactly(1, 2, 3, 4);
        assertThat(stored.fingerprint()).isEqualTo("fp-1");
        // A later retry (also from another instance, i.e. after a restart) sees identical bytes and identical objects.
        MediaDevSpeechSpool.Entry again = new MediaDevSpeechSpool(directory).find("k1").orElseThrow();
        assertThat(again.wav()).containsExactly(1, 2, 3, 4);
        assertThat(again.lineage()).isEqualTo(stored.lineage());
        assertThat(spool.find("missing")).isEmpty();
    }

    @Test
    void filesAreOwnerOnlyAndAnIncompleteEntryIsInvisible() throws Exception {
        MediaDevSpeechSpool spool = new MediaDevSpeechSpool(directory);
        spool.put("k2", "fp", new byte[]{9}, lineage(1));
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(directory.resolve("k2.wav")))).isEqualTo("rw-------");
        assertThat(PosixFilePermissions.toString(Files.getPosixFilePermissions(directory.resolve("k2.json")))).isEqualTo("rw-------");
        Files.delete(directory.resolve("k2.json"));
        assertThat(spool.find("k2")).as("a wav without its json is not an entry").isEmpty();
        Files.writeString(directory.resolve("k3.json"), "{not json");
        Files.write(directory.resolve("k3.wav"), new byte[]{1});
        assertThat(spool.find("k3")).as("an unreadable entry is absent, never partially used").isEmpty();
    }

    @Test
    void theSpoolIsBoundedAndEvictsTheOldestEntries() throws Exception {
        MediaDevSpeechSpool spool = new MediaDevSpeechSpool(directory);
        for (int i = 0; i < MediaDevSpeechSpool.MAX_ENTRIES + 5; i++) {
            spool.put("e" + i, "fp", new byte[]{(byte) i}, lineage(i));
            Files.setLastModifiedTime(directory.resolve("e" + i + ".json"), java.nio.file.attribute.FileTime.fromMillis(1_000L + i));
        }
        try (var files = Files.list(directory)) {
            assertThat(files.filter(path -> path.toString().endsWith(".json")).count()).isLessThanOrEqualTo(MediaDevSpeechSpool.MAX_ENTRIES + 1);
        }
        assertThat(spool.find("e" + (MediaDevSpeechSpool.MAX_ENTRIES + 4))).isPresent();
    }

    @Test
    void theDirectoryComesFromAnAbsoluteConfiguredPathOnly() {
        assertThatThrownBy(() -> MediaDevSpeechSpool.fromEnvironment(Map.of(MediaDevSpeechSpool.ENV_DIR, "relative/dir")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(MediaDevSpeechSpool.fromEnvironment(Map.of(MediaDevSpeechSpool.ENV_DIR, directory.toString()))).isNotNull();
        assertThat(MediaDevSpeechSpool.fromEnvironment(Map.of())).isNotNull();
    }
}
