package com.ghatana.media.launcher;

import com.ghatana.audiovideo.observability.MediaWorkflowMetrics.OutageLane;
import com.ghatana.audiovideo.observability.MediaWorkflowMetrics.OutageOutcome;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Optional;

/**
 * Classification of the DEV lanes' provider-outage responses (J-27). The lanes already answer a provider that is down
 * or degraded with a typed refusal and register nothing; this class gives those refusals one shared vocabulary:
 *
 * <ul>
 *   <li>{@code UNAVAILABLE}: nothing ran (process absent, port closed, binary missing, no runtime);</li>
 *   <li>{@code UNKNOWN}: the provider may have run (crash, non-zero exit, OOM kill, no reply); the same requestId is
 *       safe to retry because registration is idempotent;</li>
 *   <li>{@code TIMEOUT}: the deadline was exceeded and the work was cancelled; nothing is registered late.</li>
 * </ul>
 *
 * <p><b>No-fallback policy.</b> Media never substitutes a different model, voice, engine or lane for the one a request
 * names: a failing provider yields exactly one of the outcomes above, never a success produced by another model, and
 * never a silent downgrade. {@link #FALLBACK_POLICY} is reported by the catalog and every classified refusal.</p>
 */
final class MediaDevOutage {
    static final String FALLBACK_POLICY = "NONE: Media never substitutes a different model, voice or engine for a failed provider";

    record Classified(OutageLane lane, OutageOutcome outcome) { }

    private MediaDevOutage() { }

    /** Which lane and outcome an error code denotes, or empty when the code is not a provider outage. */
    static Optional<Classified> classify(String code) {
        return classify(null, code);
    }

    /**
     * As {@link #classify(String)}; the speech codes are shared by recognition and synthesis, so the request path
     * ({@code /dev/v1/speech/syntheses} or {@code /dev/v1/speech/transcriptions}) names the lane.
     */
    static Optional<Classified> classify(String path, String code) {
        if (code == null) return Optional.empty();
        OutageLane speech = path != null && path.startsWith("/dev/v1/speech/syntheses")
                ? OutageLane.SPEECH_SYNTHESIZE : OutageLane.SPEECH_TRANSCRIBE;
        return switch (code) {
            case "SPEECH_RUNTIME_UNAVAILABLE" -> of(speech, OutageOutcome.UNAVAILABLE);
            case "SPEECH_OUTCOME_UNKNOWN" -> of(speech, OutageOutcome.UNKNOWN);
            case "SPEECH_TIMEOUT" -> of(speech, OutageOutcome.TIMEOUT);
            case "LOCAL_VISION_UNAVAILABLE" -> of(OutageLane.VISION, OutageOutcome.UNAVAILABLE);
            case "VISION_OUTCOME_UNKNOWN" -> of(OutageLane.VISION, OutageOutcome.UNKNOWN);
            case "VISION_TIMEOUT" -> of(OutageLane.VISION, OutageOutcome.TIMEOUT);
            case "GROUNDED_OUTCOME_UNKNOWN" -> of(OutageLane.GROUNDED, OutageOutcome.UNKNOWN);
            case "GROUNDED_UNAVAILABLE" -> of(OutageLane.GROUNDED, OutageOutcome.UNAVAILABLE);
            case "GROUNDED_TIMEOUT" -> of(OutageLane.GROUNDED, OutageOutcome.TIMEOUT);
            case "RENDER_CODEC_UNAVAILABLE" -> of(OutageLane.RENDER, OutageOutcome.UNAVAILABLE);
            case "RENDER_OUTCOME_UNKNOWN" -> of(OutageLane.RENDER, OutageOutcome.UNKNOWN);
            case "RENDER_TIMEOUT" -> of(OutageLane.RENDER, OutageOutcome.TIMEOUT);
            default -> Optional.empty();
        };
    }

    private static Optional<Classified> of(OutageLane lane, OutageOutcome outcome) {
        return Optional.of(new Classified(lane, outcome));
    }

    /** The error details with the shared {@code outcome} and {@code fallback} members added to a classified refusal. */
    static Map<String, Object> enrich(Classified classified, Map<String, ?> details) {
        Map<String, Object> enriched = new LinkedHashMap<>();
        if (details != null) enriched.putAll(details);
        enriched.put("outcome", classified.outcome().name());
        enriched.put("fallback", "NONE");
        return enriched;
    }
}
