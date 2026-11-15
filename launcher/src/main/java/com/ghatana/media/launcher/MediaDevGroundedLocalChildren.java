package com.ghatana.media.launcher;

import com.ghatana.audio.video.vision.local.LocalVisionEngine;
import com.ghatana.audio.video.vision.local.LocalVisionSidecarClient;
import com.ghatana.media.production.rendering.BoundedProcessRunner;
import com.ghatana.stt.local.LocalSpeechException;
import com.ghatana.stt.local.LocalWhisperCppRunner;
import com.ghatana.stt.local.PcmWav;
import com.ghatana.stt.provider.LocalWhisperCppSttProvider;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Production wiring of the grounded-answer children: real FFmpeg/FFprobe (absolute operator-configured paths, bounded
 * process runner, cleared environment), real whisper.cpp through {@link LocalWhisperCppRunner}, real Florence-2 and
 * Qwen2.5-VL through the loopback vision sidecar.
 *
 * <p>Time binding: ffprobe gives the container {@code start_time} and per-stream {@code start_pts}/{@code time_base}.
 * Whisper segment times count from the first decoded audio sample, which is the audio stream's start, so a segment
 * start is {@code audio.startMicros + segmentMillis * 1000} on the container clock. Frame evidence uses the decoded
 * frame's own PTS (listed by ffprobe, extracted by frame number) converted with the video stream timebase.
 *
 * @doc.type class
 * @doc.purpose real FFmpeg/Whisper/Florence/Qwen children of the DEV grounded-answer lane
 * @doc.layer product
 * @doc.pattern Adapter
 */
final class MediaDevGroundedLocalChildren implements MediaDevGroundedAnswerRuntime.Children,
        MediaDevGroundedAnswerRuntime.Probe {
    static final int FRAME_SAMPLES = 3;
    static final int MAX_FRAME_INDEX_BYTES = 4 * 1024 * 1024;
    private static final Duration FFMPEG_TIMEOUT = Duration.ofSeconds(120);
    private static final int MAX_PER_FRAME = 12;

    private final Path ffmpeg;
    private final Path ffprobe;
    private final LocalWhisperCppSttProvider stt;
    private final LocalVisionEngine vision;

    MediaDevGroundedLocalChildren(Path ffmpeg, Path ffprobe, LocalWhisperCppSttProvider stt, LocalVisionEngine vision) {
        if (!ffmpeg.isAbsolute() || !ffprobe.isAbsolute()) {
            throw new IllegalArgumentException("ffmpeg and ffprobe paths must be absolute");
        }
        this.ffmpeg = ffmpeg;
        this.ffprobe = ffprobe;
        this.stt = stt;
        this.vision = vision;
    }

    /** Null unless FFmpeg, FFprobe and the vision engine are all configured: nothing is resolved through PATH. */
    static MediaDevGroundedLocalChildren from(Map<String, String> environment, LocalVisionEngine vision,
                                              LocalWhisperCppSttProvider stt) {
        String ffmpeg = environment.get(MediaDevProjectRenderRuntime.FFMPEG_ENV);
        String ffprobe = environment.get(MediaDevProjectRenderRuntime.FFPROBE_ENV);
        if (vision == null || ffmpeg == null || ffmpeg.isBlank() || ffprobe == null || ffprobe.isBlank()) return null;
        return new MediaDevGroundedLocalChildren(Path.of(ffmpeg), Path.of(ffprobe), stt, vision);
    }

    // ---- probe ----

    @Override
    public MediaDevGroundedClock probe(MediaDevGroundedAnswerRuntime.Source source) throws IOException {
        BoundedProcessRunner.Result result = BoundedProcessRunner.run(List.of(ffprobe.toString(), "-v", "error",
                "-of", "json", "-show_entries",
                "format=start_time,duration:stream=index,codec_type,start_time,start_pts,time_base,width,height,sample_rate",
                source.file().toString()), source.file().getParent(), Map.of(), FFMPEG_TIMEOUT, 256 * 1024, 8192,
                BoundedProcessRunner.CancellationToken.NEVER, source.file(), Long.MAX_VALUE);
        if (!result.succeeded()) {
            throw new MediaDevGroundedClock.ClockBindingException("SOURCE_CLOCK_UNDETERMINED",
                    "ffprobe could not read the source");
        }
        return MediaDevGroundedClock.parse(result.stdout(), source.artifact().sha256());
    }

    // ---- speech child ----

    @Override
    public MediaDevGroundedAnswerRuntime.ChildResult speech(MediaDevGroundedAnswerRuntime.Source source,
                                                           MediaDevGroundedClock clock,
                                                           MediaDevGroundedClock.Pin pin, String language) {
        LocalWhisperCppRunner runner = stt == null ? null : stt.runner();
        if (runner == null) {
            return MediaDevGroundedAnswerRuntime.ChildResult.failed("STT",
                    MediaDevGroundedAnswerRuntime.ChildStatus.UNAVAILABLE, "SPEECH_RUNTIME_UNAVAILABLE");
        }
        if (!clock.audio().present()) {
            return new MediaDevGroundedAnswerRuntime.ChildResult("STT",
                    MediaDevGroundedAnswerRuntime.ChildStatus.COMPLETED, pin, List.of(), Map.of(),
                    "NO_AUDIO_STREAM", 0, null);
        }
        if (!stt.install().manifest().verifiedLanguages().contains(language)) {
            return MediaDevGroundedAnswerRuntime.ChildResult.failed("STT",
                    MediaDevGroundedAnswerRuntime.ChildStatus.UNAVAILABLE, "LANGUAGE_UNSUPPORTED");
        }
        try {
            Path wav = source.file().resolveSibling("audio.wav");
            BoundedProcessRunner.Result extracted = BoundedProcessRunner.run(List.of(ffmpeg.toString(), "-nostdin",
                    "-v", "error", "-i", source.file().toString(), "-map", "0:a:0", "-vn", "-ac", "1", "-ar", "16000",
                    "-c:a", "pcm_s16le", "-f", "wav", "-y", wav.toString()), source.file().getParent(), Map.of(),
                    FFMPEG_TIMEOUT, 1024, 8192, BoundedProcessRunner.CancellationToken.NEVER, wav,
                    64L * 1024 * 1024);
            if (!extracted.succeeded() || !Files.isRegularFile(wav)) {
                return MediaDevGroundedAnswerRuntime.ChildResult.failed("STT",
                        MediaDevGroundedAnswerRuntime.ChildStatus.FAILED, "AUDIO_EXTRACTION_FAILED");
            }
            byte[] mono16k = PcmWav.toMono16k(Files.readAllBytes(wav));
            LocalWhisperCppRunner.Transcription transcription = runner.transcribe(mono16k, language,
                    Duration.ofMinutes(5), BoundedProcessRunner.CancellationToken.NEVER);
            if (!stt.install().stillCurrent()) {
                return MediaDevGroundedAnswerRuntime.ChildResult.failed("STT",
                        MediaDevGroundedAnswerRuntime.ChildStatus.UNAVAILABLE, "SPEECH_RUNTIME_CHANGED");
            }
            long audioStart = clock.audio().startMicros();
            List<MediaDevGroundedEvidence.Item> items = new ArrayList<>();
            int n = 0;
            for (LocalWhisperCppRunner.Segment segment : transcription.segments()) {
                String text = segment.text() == null ? "" : segment.text().strip();
                if (text.isEmpty()) continue;
                items.add(new MediaDevGroundedEvidence.Item("T" + n++, MediaDevGroundedEvidence.Kind.TRANSCRIPT_SEGMENT,
                        audioStart + segment.startMillis() * 1000L, audioStart + segment.endMillis() * 1000L, null,
                        null, text, "whisper.cpp/" + LocalWhisperCppSttProvider.MODEL_KEY));
            }
            Map<String, Object> model = new LinkedHashMap<>();
            model.put("id", LocalWhisperCppSttProvider.MODEL_KEY);
            model.put("engine", "whisper.cpp/" + stt.providerVersion());
            model.put("modelSha256", transcription.modelSha256());
            model.put("language", language);
            return new MediaDevGroundedAnswerRuntime.ChildResult("STT",
                    MediaDevGroundedAnswerRuntime.ChildStatus.COMPLETED, pin, items, model,
                    items.isEmpty() ? "NO_SPEECH_DETECTED" : "", 0, null);
        } catch (LocalSpeechException failure) {
            // A recognizer that could not start is UNAVAILABLE (nothing ran), one that ended abnormally may have run
            // (UNKNOWN) and a deadline miss is TIMED_OUT; only a definite input/limit refusal is a plain failure.
            MediaDevGroundedAnswerRuntime.ChildStatus status = switch (failure.code()) {
                case RUNTIME_UNAVAILABLE -> MediaDevGroundedAnswerRuntime.ChildStatus.UNAVAILABLE;
                case PROCESS_FAILED, OUTPUT_INVALID -> MediaDevGroundedAnswerRuntime.ChildStatus.OUTCOME_UNKNOWN;
                case TIMEOUT -> MediaDevGroundedAnswerRuntime.ChildStatus.TIMED_OUT;
                default -> MediaDevGroundedAnswerRuntime.ChildStatus.FAILED;
            };
            return MediaDevGroundedAnswerRuntime.ChildResult.failed("STT", status, "STT_" + failure.code().name());
        } catch (IOException failure) {
            return MediaDevGroundedAnswerRuntime.ChildResult.failed("STT",
                    MediaDevGroundedAnswerRuntime.ChildStatus.FAILED, "AUDIO_EXTRACTION_FAILED");
        }
    }

    // ---- vision child ----

    @Override
    public MediaDevGroundedAnswerRuntime.ChildResult vision(MediaDevGroundedAnswerRuntime.Source source,
                                                           MediaDevGroundedClock clock,
                                                           MediaDevGroundedClock.Pin pin) {
        try {
            long[] ptsList = framePts(source, clock);
            if (ptsList.length == 0) {
                return MediaDevGroundedAnswerRuntime.ChildResult.failed("VISION",
                        MediaDevGroundedAnswerRuntime.ChildStatus.FAILED, "NO_DECODABLE_VIDEO_FRAMES");
            }
            int samples = Math.min(FRAME_SAMPLES, ptsList.length);
            List<Integer> chosen = new ArrayList<>();
            for (int i = 0; i < samples; i++) {
                int index = samples == 1 ? 0 : (int) Math.round(i * (ptsList.length - 1) / (double) (samples - 1));
                if (!chosen.contains(index)) chosen.add(index);
            }
            List<MediaDevGroundedEvidence.Item> items = new ArrayList<>();
            Map<String, Object> model = null;
            byte[] firstFrame = null;
            int dropped = 0;
            for (int f = 0; f < chosen.size(); f++) {
                int frameNumber = chosen.get(f);
                byte[] png = extractFrame(source, frameNumber);
                if (firstFrame == null) firstFrame = png;
                Map<String, Object> inference = vision.analyze(png, MediaDevProjectRenderRuntime.sha256Hex(png),
                        Set.of("caption", "detect", "ocr"));
                if (model == null) {
                    @SuppressWarnings("unchecked") Map<String, Object> m = (Map<String, Object>) inference.get("model");
                    model = m;
                }
                @SuppressWarnings("unchecked") Map<String, Object> input = (Map<String, Object>) inference.get("input");
                int width = ((Number) input.get("width")).intValue();
                int height = ((Number) input.get("height")).intValue();
                long ptsTicks = ptsList[frameNumber];
                long micros = MediaDevGroundedClock.ticksToMicros(ptsTicks, clock.video().timebaseNum(),
                        clock.video().timebaseDen());
                MediaDevGroundedEvidence.Frame frame = new MediaDevGroundedEvidence.Frame(ptsTicks,
                        clock.video().timebase(), width, height, frameNumber);
                @SuppressWarnings("unchecked") Map<String, Object> results = (Map<String, Object>) inference.get("results");
                String origin = "florence-2-large (local, not Document Intelligence)";
                String caption = String.valueOf(results.getOrDefault("caption", "")).strip();
                if (!caption.isEmpty()) {
                    items.add(new MediaDevGroundedEvidence.Item("F" + f, MediaDevGroundedEvidence.Kind.FRAME, micros,
                            micros, frame, null, caption, origin));
                }
                int o = 0;
                if (results.get("objects") instanceof List<?> objects) {
                    for (Object raw : objects) {
                        if (o >= MAX_PER_FRAME) break;
                        Map<?, ?> object = (Map<?, ?>) raw;
                        Map<?, ?> box = (Map<?, ?>) object.get("boundingBox");
                        String label = String.valueOf(object.get("label")).strip();
                        if (label.isEmpty() || box == null) continue;
                        items.add(new MediaDevGroundedEvidence.Item("F" + f + ".O" + o++,
                                MediaDevGroundedEvidence.Kind.FRAME_OBJECT, micros, micros, frame,
                                new MediaDevGroundedEvidence.Box(num(box.get("x")), num(box.get("y")),
                                        num(box.get("width")), num(box.get("height"))), label, origin));
                    }
                }
                int s = 0;
                if (results.get("sceneText") instanceof Map<?, ?> sceneText
                        && sceneText.get("regions") instanceof List<?> regions) {
                    for (Object raw : regions) {
                        if (s >= MAX_PER_FRAME) break;
                        Map<?, ?> region = (Map<?, ?>) raw;
                        String text = String.valueOf(region.get("text")).strip();
                        List<?> quad = (List<?>) region.get("quad");
                        if (text.isEmpty() || quad == null || quad.size() < 8) continue;
                        double minX = Double.MAX_VALUE, minY = Double.MAX_VALUE, maxX = -Double.MAX_VALUE,
                                maxY = -Double.MAX_VALUE;
                        for (int i = 0; i + 1 < quad.size(); i += 2) {
                            minX = Math.min(minX, num(quad.get(i)));
                            maxX = Math.max(maxX, num(quad.get(i)));
                            minY = Math.min(minY, num(quad.get(i + 1)));
                            maxY = Math.max(maxY, num(quad.get(i + 1)));
                        }
                        items.add(new MediaDevGroundedEvidence.Item("F" + f + ".S" + s++,
                                MediaDevGroundedEvidence.Kind.FRAME_TEXT, micros, micros, frame,
                                new MediaDevGroundedEvidence.Box(minX, minY, maxX - minX, maxY - minY), text, origin));
                    }
                }
            }
            return new MediaDevGroundedAnswerRuntime.ChildResult("VISION",
                    MediaDevGroundedAnswerRuntime.ChildStatus.COMPLETED, pin, items, model, "", dropped, firstFrame);
        } catch (LocalVisionEngine.NotAdmittedException refusal) {
            return MediaDevGroundedAnswerRuntime.ChildResult.failed("VISION",
                    MediaDevGroundedAnswerRuntime.ChildStatus.UNAVAILABLE, "LOCAL_MODEL_NOT_ADMITTED:" + refusal.code());
        } catch (LocalVisionSidecarClient.SidecarUnavailableException unavailable) {
            return switch (unavailable.reach()) {
                // The connection was never established: nothing ran.
                case NOT_REACHED -> MediaDevGroundedAnswerRuntime.ChildResult.failed("VISION",
                        MediaDevGroundedAnswerRuntime.ChildStatus.UNAVAILABLE, "LOCAL_VISION_SIDECAR_UNREACHABLE");
                case TIMED_OUT -> MediaDevGroundedAnswerRuntime.ChildResult.failed("VISION",
                        MediaDevGroundedAnswerRuntime.ChildStatus.TIMED_OUT, "LOCAL_VISION_TIMEOUT");
                // The sidecar was lost mid-inference: whether the model finished is unknown.
                case CONNECTION_LOST -> MediaDevGroundedAnswerRuntime.ChildResult.failed("VISION",
                        MediaDevGroundedAnswerRuntime.ChildStatus.OUTCOME_UNKNOWN, "LOCAL_VISION_SIDECAR_UNAVAILABLE");
            };
        } catch (LocalVisionSidecarClient.SidecarRejectedException rejected) {
            return MediaDevGroundedAnswerRuntime.ChildResult.failed("VISION",
                    MediaDevVisionRuntime.providerFailure(rejected)
                            ? MediaDevGroundedAnswerRuntime.ChildStatus.UNAVAILABLE
                            : MediaDevGroundedAnswerRuntime.ChildStatus.FAILED,
                    "LOCAL_VISION_REJECTED:" + rejected.code());
        } catch (IOException | RuntimeException failure) {
            if (failure instanceof MediaDevGroundedClock.ClockBindingException refused) throw refused;
            return MediaDevGroundedAnswerRuntime.ChildResult.failed("VISION",
                    MediaDevGroundedAnswerRuntime.ChildStatus.FAILED, "FRAME_PROCESSING_FAILED");
        }
    }

    private static double num(Object value) {
        return value instanceof Number number ? number.doubleValue() : Double.NaN;
    }

    /** Decoded frame PTS values (video stream ticks) in presentation order. */
    private long[] framePts(MediaDevGroundedAnswerRuntime.Source source, MediaDevGroundedClock clock)
            throws IOException {
        BoundedProcessRunner.Result result = BoundedProcessRunner.run(List.of(ffprobe.toString(), "-v", "error",
                "-select_streams", "v:0", "-show_entries", "frame=pts", "-of", "csv=p=0", source.file().toString()),
                source.file().getParent(), Map.of(), FFMPEG_TIMEOUT, MAX_FRAME_INDEX_BYTES, 8192,
                BoundedProcessRunner.CancellationToken.NEVER, source.file(), Long.MAX_VALUE);
        if (!result.succeeded()) throw new IOException("frame index unavailable");
        List<Long> pts = new ArrayList<>();
        for (String line : new String(result.stdout(), StandardCharsets.US_ASCII).split("\\R")) {
            String trimmed = line.strip().replace(",", "");
            if (trimmed.isEmpty() || trimmed.equals("N/A")) continue;
            pts.add(Long.parseLong(trimmed));
        }
        long[] sorted = pts.stream().mapToLong(Long::longValue).toArray();
        Arrays.sort(sorted);
        return sorted;
    }

    private byte[] extractFrame(MediaDevGroundedAnswerRuntime.Source source, int frameNumber) throws IOException {
        Path out = source.file().resolveSibling("frame-" + frameNumber + ".png");
        BoundedProcessRunner.Result result = BoundedProcessRunner.run(List.of(ffmpeg.toString(), "-nostdin", "-v",
                "error", "-i", source.file().toString(), "-map", "0:v:0", "-vf", "select=gte(n\\," + frameNumber + ")",
                "-frames:v", "1", "-fps_mode", "passthrough", "-f", "image2", "-c:v", "png", "-y", out.toString()),
                source.file().getParent(), Map.of(), FFMPEG_TIMEOUT, 1024, 8192,
                BoundedProcessRunner.CancellationToken.NEVER, out, 64L * 1024 * 1024);
        if (!result.succeeded() || !Files.isRegularFile(out) || Files.size(out) == 0) {
            throw new IOException("frame extraction did not produce a frame");
        }
        return Files.readAllBytes(out);
    }

    // ---- answer ----

    @Override
    public MediaDevGroundedAnswerRuntime.Answered answer(byte[] framePng, String prompt) {
        try {
            Map<String, Object> inference = vision.ask(framePng, MediaDevProjectRenderRuntime.sha256Hex(framePng),
                    prompt);
            @SuppressWarnings("unchecked") Map<String, Object> model = (Map<String, Object>) inference.get("model");
            return new MediaDevGroundedAnswerRuntime.Answered(String.valueOf(inference.get("answer")), model);
        } catch (LocalVisionEngine.NotAdmittedException refusal) {
            throw new MediaDevGroundedAnswerRuntime.GroundedRefusedException(503, "LOCAL_MODEL_NOT_ADMITTED",
                    "the answering model is not digest-qualified; nothing was dispatched",
                    Map.of("modelId", refusal.modelId(), "reason", refusal.code()));
        } catch (LocalVisionSidecarClient.SidecarUnavailableException unavailable) {
            switch (unavailable.reach()) {
                case NOT_REACHED -> throw new MediaDevGroundedAnswerRuntime.GroundedRefusedException(503,
                        "GROUNDED_UNAVAILABLE", "the answering model's sidecar could not be reached; nothing ran, "
                        + "nothing was registered and the same requestId may be retried");
                case TIMED_OUT -> throw new MediaDevGroundedAnswerRuntime.GroundedRefusedException(504,
                        "GROUNDED_TIMEOUT", "the answering model exceeded its time budget and was abandoned; nothing "
                        + "was registered and the same requestId may be retried");
                default -> throw new MediaDevGroundedAnswerRuntime.GroundedRefusedException(503, "GROUNDED_OUTCOME_UNKNOWN",
                        "the vision sidecar was lost while answering; the outcome is unknown, nothing was registered "
                                + "and the same requestId may be retried");
            }
        } catch (LocalVisionSidecarClient.SidecarRejectedException rejected) {
            if (MediaDevVisionRuntime.providerFailure(rejected)) {
                throw new MediaDevGroundedAnswerRuntime.GroundedRefusedException(503, "GROUNDED_UNAVAILABLE",
                        "the answering model failed to serve the request (" + rejected.code() + "); no answer was "
                                + "produced and nothing was registered");
            }
            throw new MediaDevGroundedAnswerRuntime.GroundedRefusedException(502, "GROUNDED_ANSWER_FAILED",
                    "the answering model rejected the request (" + rejected.code() + ")");
        }
    }

    @Override
    public Map<String, Object> status() {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("florence", vision.florenceAdmission().state().name());
        out.put("qwen", vision.qwenAdmission().state().name());
        out.put("sidecarHealthy", vision.sidecarHealthy());
        out.put("speechToText", stt != null && stt.runner() != null ? "AVAILABLE" : "UNAVAILABLE");
        return out;
    }
}
