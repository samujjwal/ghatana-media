package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.stt.provider.LocalWhisperCppSttProvider;
import com.ghatana.tts.local.LocalKokoroTtsProvider;

import java.nio.file.Path;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

/**
 * Host composition of the DEV_ONLY translation and dubbing routes. The translation engine is the local vision engine
 * (Qwen2.5-VL, text-only; models root, sidecar URL and token), synthesis is the verified local Kokoro install, and tempo
 * adjustment needs the absolute {@code MEDIA_DEV_RENDER_FFMPEG}. Anything absent is reported as unavailable by the routes
 * rather than faked; when neither the engine nor the synthesizer is configured there are no routes. The rights resolver
 * defaults to the fail-closed one.
 */
final class MediaDevDubbingComposition {
    private MediaDevDubbingComposition() { }

    static MediaDevDubRoutes compose(MediaRuntime runtime, Map<String, String> environment,
                                     Map<String, String> speechEnvironment, RightsConsentResolver resolver,
                                     MediaDevRequestLedger ledger, MediaDevSpeechRuntime speech) {
        var vision = MediaLocalVisionComposition.engineFrom(environment).orElse(null);
        LocalKokoroTtsProvider tts = LocalKokoroTtsProvider.fromEnvironment(speechEnvironment);
        LocalWhisperCppSttProvider stt = LocalWhisperCppSttProvider.fromEnvironment(speechEnvironment);
        if (vision == null && tts == null) return null;
        MediaDevDubSupport support = new MediaDevDubSupport(runtime,
                MediaDevProjectRenderRuntime.canonicalRegistrar(runtime), resolver);
        MediaDevTranslationRuntime translations = new MediaDevTranslationRuntime(runtime, support,
                vision == null ? null : MediaDevTranslationRuntime.localEngine(vision),
                () -> speechLanguages(stt, tts), ledger);
        String ffmpeg = environment.get(MediaDevProjectRenderRuntime.FFMPEG_ENV);
        MediaDevDubTiming.TempoAdjuster tempo = ffmpeg == null || ffmpeg.isBlank() ? null
                : MediaDevDubbingRuntime.ffmpegTempo(Path.of(ffmpeg));
        MediaDevDubbingRuntime dubbing = new MediaDevDubbingRuntime(runtime, support, translations, speech,
                tts == null ? null : MediaDevDubbingRuntime.localSynthesizer(tts), tempo,
                MediaDevSpeechRuntime.canonicalJobLaneTtsGate(runtime), ledger);
        return new MediaDevDubRoutes(translations, dubbing, runtime);
    }

    /** Languages verified by every installed speech manifest (Whisper and Kokoro); empty when none is usable. */
    static Set<String> speechLanguages(LocalWhisperCppSttProvider stt, LocalKokoroTtsProvider tts) {
        Set<String> languages = null;
        if (stt != null && stt.install() != null && stt.install().usable()) {
            languages = new HashSet<>(stt.install().manifest().verifiedLanguages());
        }
        if (tts != null && tts.install() != null && tts.install().usable()) {
            if (languages == null) languages = new HashSet<>(tts.install().manifest().verifiedLanguages());
            else languages.retainAll(tts.install().manifest().verifiedLanguages());
        }
        return languages == null ? Set.of() : languages;
    }
}
