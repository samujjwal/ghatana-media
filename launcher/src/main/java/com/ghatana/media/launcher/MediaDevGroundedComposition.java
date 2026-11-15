package com.ghatana.media.launcher;

import com.ghatana.media.runtime.MediaRightsConsentContracts.RightsConsentResolver;
import com.ghatana.stt.provider.LocalWhisperCppSttProvider;

import java.util.Map;

/**
 * Host composition of the DEV_ONLY grounded-answer lane. Requires the local vision engine (models root, sidecar URL
 * and token) and absolute FFmpeg/FFprobe paths ({@code MEDIA_DEV_RENDER_FFMPEG}/{@code MEDIA_DEV_RENDER_FFPROBE});
 * the speech child is composed from the verified whisper.cpp install when present and is otherwise reported as an
 * UNAVAILABLE child. Anything else absent yields no routes. The rights resolver defaults to the fail-closed one.
 */
final class MediaDevGroundedComposition {
    private MediaDevGroundedComposition() { }

    static MediaDevGroundedAnswerRuntime compose(MediaRuntime runtime, Map<String, String> environment,
                                                 Map<String, String> speechEnvironment,
                                                 RightsConsentResolver resolver) {
        return compose(runtime, environment, speechEnvironment, resolver, MediaDevRequestLedger.inMemory());
    }

    static MediaDevGroundedAnswerRuntime compose(MediaRuntime runtime, Map<String, String> environment,
                                                 Map<String, String> speechEnvironment,
                                                 RightsConsentResolver resolver, MediaDevRequestLedger ledger) {
        var engine = MediaLocalVisionComposition.engineFrom(environment).orElse(null);
        if (engine == null) return null;
        LocalWhisperCppSttProvider stt = LocalWhisperCppSttProvider.fromEnvironment(speechEnvironment);
        MediaDevGroundedLocalChildren children = MediaDevGroundedLocalChildren.from(environment, engine, stt);
        if (children == null) return null;
        return new MediaDevGroundedAnswerRuntime(runtime, children, children, resolver, ledger);
    }
}
