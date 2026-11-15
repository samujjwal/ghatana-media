package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaErasureContracts.DeliveryRef;
import com.ghatana.media.runtime.MediaErasureContracts.LocalWork;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.Key;
import com.ghatana.media.runtime.MediaRequestLedgerContracts.OutputRef;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/** Host-local copies of erased content: the speech spool, delivered files and the process-local request ledger. */
class MediaDevErasureLocalCopiesTest {
    @TempDir Path directory;

    @Test
    void theSpoolIsErasedByContentDigestIncludingAnOrphanedAudioFileAndNothingElse() throws Exception {
        MediaDevSpeechSpool spool = new MediaDevSpeechSpool(directory);
        byte[] erased = "erased synthesized audio".getBytes();
        byte[] kept = "kept synthesized audio".getBytes();
        spool.put("tts-erased", "fp", erased, Map.of("kind", "LOCAL_TTS_AUDIO"));
        spool.put("tts-kept", "fp", kept, Map.of("kind", "LOCAL_TTS_AUDIO"));
        // A crash between the audio write and the json write leaves an orphaned audio file.
        Files.write(directory.resolve("orphan.wav"), erased);

        List<String> removed = spool.eraseByDigests(Set.of(MediaDevProjectRenderRuntime.sha256Hex(erased)));

        assertThat(removed).hasSize(2).containsOnly(MediaDevProjectRenderRuntime.sha256Hex(erased));
        assertThat(spool.find("tts-erased")).isEmpty();
        assertThat(directory.resolve("tts-erased.wav")).doesNotExist();
        assertThat(directory.resolve("tts-erased.json")).doesNotExist();
        assertThat(directory.resolve("orphan.wav")).doesNotExist();
        assertThat(spool.find("tts-kept")).isPresent();
        assertThat(spool.eraseByDigests(Set.of())).isEmpty();
        assertThat(new MediaDevSpeechSpool(directory.resolve("absent")).eraseByDigests(Set.of("a".repeat(64)))).isEmpty();
    }

    @Test
    void aDeliveredObjectAndItsPartialWriteAreErasedByTheirHashedNameOnly() throws Exception {
        String name = MediaDevLocalDirectoryDestination.objectName("tenant-a", "principal-a", "export-1");
        Files.write(directory.resolve(name + ".bin"), new byte[] {1, 2, 3});
        Files.write(directory.resolve(name + ".part"), new byte[] {1});
        String other = MediaDevLocalDirectoryDestination.objectName("tenant-a", "principal-a", "export-2");
        Files.write(directory.resolve(other + ".bin"), new byte[] {9});

        assertThat(MediaDevLocalDirectoryDestination.eraseDelivered(directory, "tenant-a", "principal-a", "export-1")).isEqualTo(2);
        assertThat(MediaDevLocalDirectoryDestination.eraseDelivered(directory, "tenant-a", "principal-a", "export-1")).isZero();
        assertThat(directory.resolve(other + ".bin")).exists();
        // The same request id of another tenant or principal names a different file.
        assertThat(MediaDevLocalDirectoryDestination.eraseDelivered(directory, "tenant-b", "principal-a", "export-2")).isZero();
        assertThat(directory.resolve(other + ".bin")).exists();
        assertThat(new LocalWork(List.of("a"), List.of(), List.of(new DeliveryRef("principal-a", "export-1"))).deliveries())
                .hasSize(1);
    }

    @Test
    void aProcessLocalLedgerRowOfAnErasedOutputAnswersErasedAndNeverReplays() {
        MediaDevRequestLedger ledger = MediaDevRequestLedger.inMemory();
        Key key = new Key("tenant-a", "principal-a", "speech.synthesize", "req-1");
        String fingerprint = "a".repeat(64);
        ledger.run("tenant-a", "principal-a", "speech.synthesize", "req-1", fingerprint,
                outputs -> "replayed", () -> "produced", result -> List.of(new OutputRef("audio", "artifact-1", "sha256:" + "1".repeat(64))),
                () -> new IllegalStateException("mismatch"));
        assertThat(ledger.run("tenant-a", "principal-a", "speech.synthesize", "req-1", fingerprint,
                outputs -> "replayed", () -> "produced-again", result -> List.of(), () -> new IllegalStateException("m")))
                .isEqualTo("replayed");

        assertThat(ledger.eraseOutputs("tenant-b", Set.of("artifact-1"))).as("another tenant is untouched").isZero();
        assertThat(ledger.eraseOutputs("tenant-a", Set.of("artifact-1"))).isEqualTo(1);

        for (String presented : List.of(fingerprint, "b".repeat(64))) {
            assertThat(org.assertj.core.api.Assertions.catchThrowable(() -> ledger.run("tenant-a", "principal-a",
                    "speech.synthesize", "req-1", presented, outputs -> "replayed", () -> "produced-again",
                    result -> List.of(new OutputRef("audio", "artifact-2", "sha256:" + "2".repeat(64))),
                    () -> new IllegalStateException("mismatch"))))
                    .isInstanceOfSatisfying(MediaDevRequestLedger.LedgerRefusedException.class, refused -> {
                        assertThat(refused.status()).isEqualTo(410);
                        assertThat(refused.code()).isEqualTo("OUTPUT_ERASED");
                    });
        }
        assertThat(Duration.ZERO).isNotNull();
        assertThat(key.requestId()).isEqualTo("req-1");
    }
}
