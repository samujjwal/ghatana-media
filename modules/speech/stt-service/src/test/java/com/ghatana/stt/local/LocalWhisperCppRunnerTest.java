package com.ghatana.stt.local;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class LocalWhisperCppRunnerTest {
    @TempDir Path dir;

    private LocalWhisperCppRunner runner(Path cli) throws Exception {
        Path model = Files.writeString(dir.resolve("m.bin"), "weights");
        return new LocalWhisperCppRunner(new LocalWhisperCppRunner.Config(cli, model, "a".repeat(64), 2,
                Duration.ofSeconds(20)));
    }

    private static final String GOOD = """
            {"transcription":[
              {"offsets":{"from":0,"to":1500},"text":" Hello there."},
              {"offsets":{"from":1500,"to":3000},"text":" General Kenobi."},
              {"offsets":{"from":3000,"to":3200},"text":"   "}]}""";

    @Test
    void parsesSegmentsAndJoinsTrimmedText() throws Exception {
        LocalWhisperCppRunner runner = runner(LocalSpeechTestSupport.fakeCli(dir, GOOD, 0, ""));
        var result = runner.transcribe(LocalSpeechTestSupport.tinyWav16k(), "en", Duration.ofSeconds(10),
                BoundedProcessRunner.CancellationToken.NEVER);
        assertThat(result.text()).isEqualTo("Hello there. General Kenobi.");
        assertThat(result.segments()).extracting(LocalWhisperCppRunner.Segment::startMillis)
                .containsExactly(0L, 1500L);
        assertThat(result.modelSha256()).isEqualTo("a".repeat(64));
    }

    @Test
    void nonZeroExitTimeoutCancellationAndGarbageOutputAreTypedFailures() throws Exception {
        byte[] wav = LocalSpeechTestSupport.tinyWav16k();
        assertThatThrownBy(() -> runner(LocalSpeechTestSupport.fakeCli(dir, GOOD, 3, "")).transcribe(
                wav, "en", Duration.ofSeconds(10), BoundedProcessRunner.CancellationToken.NEVER))
                .isInstanceOfSatisfying(LocalSpeechException.class,
                        e -> assertThat(e.code()).isEqualTo(LocalSpeechException.Code.PROCESS_FAILED));
        assertThatThrownBy(() -> runner(LocalSpeechTestSupport.fakeCli(dir, GOOD, 0, "sleep 30")).transcribe(
                wav, "en", Duration.ofMillis(400), BoundedProcessRunner.CancellationToken.NEVER))
                .isInstanceOfSatisfying(LocalSpeechException.class,
                        e -> assertThat(e.code()).isEqualTo(LocalSpeechException.Code.TIMEOUT));
        assertThatThrownBy(() -> runner(LocalSpeechTestSupport.fakeCli(dir, GOOD, 0, "sleep 30")).transcribe(
                wav, "en", Duration.ofSeconds(10), () -> true))
                .isInstanceOfSatisfying(LocalSpeechException.class,
                        e -> assertThat(e.code()).isEqualTo(LocalSpeechException.Code.CANCELLED));
        assertThatThrownBy(() -> runner(LocalSpeechTestSupport.fakeCli(dir, "not json", 0, "")).transcribe(
                wav, "en", Duration.ofSeconds(10), BoundedProcessRunner.CancellationToken.NEVER))
                .isInstanceOfSatisfying(LocalSpeechException.class,
                        e -> assertThat(e.code()).isEqualTo(LocalSpeechException.Code.OUTPUT_INVALID));
    }

    @Test
    void rejectsNonWavAutoLanguageAndOversizedInputBeforeAnyProcessStarts() throws Exception {
        Path marker = dir.resolve("started");
        LocalWhisperCppRunner runner = runner(
                LocalSpeechTestSupport.fakeCli(dir, GOOD, 0, "touch " + marker));
        byte[] wav = LocalSpeechTestSupport.tinyWav16k();
        for (Runnable attempt : List.<Runnable>of(
                () -> call(runner, "not a wav at all, definitely".repeat(4).getBytes(), "en"),
                () -> call(runner, wav, "auto"),
                () -> call(runner, wav, "en; rm -rf /"),
                () -> call(runner, new byte[LocalWhisperCppRunner.MAX_INPUT_BYTES + 1], "en"))) {
            assertThatThrownBy(attempt::run).hasCauseInstanceOf(LocalSpeechException.class);
        }
        assertThat(marker).doesNotExist();
    }

    private static void call(LocalWhisperCppRunner runner, byte[] audio, String language) {
        try {
            runner.transcribe(audio, language, Duration.ofSeconds(5), BoundedProcessRunner.CancellationToken.NEVER);
        } catch (LocalSpeechException typed) {
            assertThat(typed.code()).isEqualTo(LocalSpeechException.Code.INVALID_INPUT);
            throw new IllegalStateException(typed);
        }
    }

    @Test
    void shellMetacharactersInStagedPathsNeverReachAShell() throws Exception {
        // Arguments are an array, so even a hostile-looking cwd name is passed literally.
        Path odd = Files.createDirectories(dir.resolve("a b;$(touch pwned)"));
        Path cli = LocalSpeechTestSupport.fakeCli(odd, GOOD, 0, "");
        Path model = Files.writeString(odd.resolve("m.bin"), "w");
        var runner = new LocalWhisperCppRunner(new LocalWhisperCppRunner.Config(cli, model, "b".repeat(64), 1,
                Duration.ofSeconds(10)));
        assertThat(runner.transcribe(LocalSpeechTestSupport.tinyWav16k(), "en", Duration.ofSeconds(5),
                BoundedProcessRunner.CancellationToken.NEVER).text()).isEqualTo("Hello there. General Kenobi.");
        assertThat(dir.resolve("pwned")).doesNotExist();
    }
}
