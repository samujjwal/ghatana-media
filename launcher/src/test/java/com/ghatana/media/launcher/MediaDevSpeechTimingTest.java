package com.ghatana.media.launcher;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.stt.local.PcmWav;
import com.ghatana.stt.provider.LocalWhisperCppSttProvider;
import com.ghatana.tts.local.LocalKokoroSynthesizer;
import com.ghatana.tts.local.LocalKokoroTtsProvider;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;

/**
 * Real-model timing of the speech lane (Kokoro through the persistent worker, Whisper per call). It asserts what is
 * functionally guaranteed (valid audio, the worker reports its device, the worker is started once and reused) and
 * prints the measured milliseconds; it asserts no latency threshold because the GPU is shared on this host.
 * Set {@code MEDIA_SPEECH_BENCH_BASELINE=true} to also time the one-process-per-call Kokoro path
 * (about 15-30 s per call on the CPU).
 */
class MediaDevSpeechTimingTest {
    private static final String TEXT = "The quick brown fox jumps over the lazy dog.";

    private static Path root() {
        String configured = System.getenv("MEDIA_LOCAL_MODEL_ROOT");
        return configured != null && !configured.isBlank() ? Path.of(configured)
                : Path.of(System.getProperty("user.home"), ".local", "share", "ghatana-media");
    }

    private static Map<String, String> environment(boolean worker) {
        Path root = root();
        Path script = Path.of("").toAbsolutePath().getParent().resolve("tools/model-runtimes/kokoro_synth.py");
        Map<String, String> env = new HashMap<>(Map.of(
                "MEDIA_LOCAL_MODEL_ROOT", root.toString(),
                "MEDIA_WHISPER_CPP_BIN", root.resolve("runtimes/whisper.cpp-src/build-vulkan/bin/whisper-cli").toString(),
                "MEDIA_KOKORO_PYTHON", root.resolve("runtimes/kokoro-venv/bin/python").toString(),
                "MEDIA_KOKORO_SCRIPT", script.toString(),
                "MEDIA_WHISPER_CPP_THREADS", "8"));
        if (worker) env.put("MEDIA_KOKORO_WORKER", "true");
        return env;
    }

    private static long timed(List<Long> into, java.util.concurrent.Callable<?> call) throws Exception {
        long started = System.nanoTime();
        call.call();
        long millis = Duration.ofNanos(System.nanoTime() - started).toMillis();
        into.add(millis);
        return millis;
    }

    private static LocalKokoroSynthesizer.Synthesis synth(LocalKokoroSynthesizer synthesizer) throws Exception {
        return synthesizer.synthesize(TEXT, "af_heart", 1.0, Duration.ofMinutes(3),
                BoundedProcessRunner.CancellationToken.NEVER);
    }

    @Test
    void measuresKokoroWorkerAndWhisperOnTheRealModels() throws Exception {
        var stt = LocalWhisperCppSttProvider.fromEnvironment(environment(true));
        var tts = LocalKokoroTtsProvider.fromEnvironment(environment(true));
        assumeTrue(stt.ready() && tts.ready(), "local Whisper/Kokoro runtimes with verified manifests are not "
                + "installed on this host (not the case on the development machine)");
        LocalKokoroSynthesizer synthesizer = tts.synthesizer();
        assertThat(synthesizer.usesWorker()).isTrue();

        if ("true".equalsIgnoreCase(System.getenv("MEDIA_SPEECH_BENCH_BASELINE"))) {
            var perCall = LocalKokoroTtsProvider.fromEnvironment(environment(false)).synthesizer();
            assertThat(perCall.usesWorker()).isFalse();
            List<Long> baseline = new ArrayList<>();
            for (int i = 0; i < 3; i++) timed(baseline, () -> synth(perCall));
            System.out.println("TIMING kokoro per-call (cpu, one process per call) ms=" + baseline);
        }

        List<Long> kokoro = new ArrayList<>();
        timed(kokoro, () -> synth(synthesizer));            // cold: includes starting the worker and loading the model
        LocalKokoroSynthesizer.Synthesis first = synth(synthesizer);
        long warm = timed(new ArrayList<>(), () -> synth(synthesizer));
        List<Long> ten = new ArrayList<>();
        for (int i = 0; i < 10; i++) timed(ten, () -> synth(synthesizer));
        assertThat(first.samples()).isGreaterThan(24_000L);
        assertThat(synthesizer.worker().startCount()).isEqualTo(1);
        String health = synthesizer.worker().healthJson();
        assertThat(health).contains("\"verified\":true");
        System.out.println("TIMING kokoro worker cold-start first call ms=" + kokoro.get(0) + " warm call ms=" + warm
                + " 10 sequential total ms=" + ten.stream().mapToLong(Long::longValue).sum() + " each=" + ten);
        System.out.println("TIMING kokoro worker health=" + health);

        byte[] wav16k = PcmWav.toMono16k(first.wav());
        var runner = stt.runner();
        List<Long> whisper = new ArrayList<>();
        for (int i = 0; i < 12; i++) {
            timed(whisper, () -> runner.transcribe(wav16k, "en", Duration.ofMinutes(2),
                    BoundedProcessRunner.CancellationToken.NEVER));
        }
        var transcript = runner.transcribe(wav16k, "en", Duration.ofMinutes(2),
                BoundedProcessRunner.CancellationToken.NEVER);
        assertThat(transcript.text().toLowerCase()).contains("quick brown fox");
        long tenTotal = whisper.subList(2, 12).stream().mapToLong(Long::longValue).sum();
        System.out.println("TIMING whisper per-call (static Vulkan whisper-cli) first call ms=" + whisper.get(0)
                + " warm call ms=" + whisper.get(1) + " 10 sequential total ms=" + tenTotal + " each="
                + whisper.subList(2, 12));
        assertThat(Files.exists(root())).isTrue();
    }
}
