package com.ghatana.tts.grpc;

import com.ghatana.media.common.AudioFormat;
import com.ghatana.media.tts.api.Emotion;
import com.ghatana.media.tts.api.SynthesisOptions;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.ssml.SsmlProcessor;
import java.util.IllformedLocaleException;
import java.util.Locale;

/** Validates wire prosody units and admits only neutral controls until effects are qualified. */
final class SynthesisControlPolicy {
    private SynthesisControlPolicy() {}

    static SynthesisOptions resolve(SynthesizeRequest request, AudioFormat outputFormat) {
        var wire = request.getOptions();
        double speed = finite(wire.getSpeed(), "speed");
        double pitchSemitones = finite(wire.getPitch(), "pitch");
        double energy = finite(wire.getEnergy(), "energy");
        if (speed == 0.0) speed = 1.0; // proto3 default means unspecified; no explicit-presence bit exists.
        if (energy == 0.0) energy = 1.0; // proto3 default means unspecified; zero-energy cannot be expressed.
        if (speed < 0.5 || speed > 2.0) throw new IllegalArgumentException("speed must be in [0.5, 2.0]");
        if (pitchSemitones < -12.0 || pitchSemitones > 12.0) {
            throw new IllegalArgumentException("pitch must be in [-12, 12] semitones");
        }
        if (energy < 0.0 || energy > 2.0) throw new IllegalArgumentException("energy must be in [0.0, 2.0]");

        String emotionName = wire.getEmotion().isBlank() ? "NEUTRAL" : wire.getEmotion().trim();
        Emotion emotion;
        try {
            emotion = Emotion.valueOf(emotionName.toUpperCase(Locale.ROOT));
        } catch (IllegalArgumentException exception) {
            throw new IllegalArgumentException("Unsupported emotion value", exception);
        }
        if (speed != 1.0) throw unsupported("speed");
        if (pitchSemitones != 0.0) throw unsupported("pitch");
        if (energy != 1.0) throw unsupported("energy");
        if (emotion != Emotion.NEUTRAL) throw unsupported("emotion");

        // Only the neutral pitch is currently admitted; non-neutral values returned above.
        double pitchRatio = 1.0;
        String languageTag = wire.getLanguage();
        Locale language = languageTag.isBlank() ? null : parseLanguageTag(languageTag);

        return SynthesisOptions.builder()
                .voiceId(request.getVoiceId().isBlank() ? null : request.getVoiceId())
                .speed(speed)
                .pitch(pitchRatio)
                .volume(energy)
                .language(language)
                .outputFormat(outputFormat)
                .build();
    }

    static void rejectUnqualifiedSsml(String text) {
        if (text.stripLeading().startsWith("<")) {
            SsmlProcessor.create().parse(text);
            throw unsupported("ssml");
        }
    }

    /** Typed capability denial; remains an UnsupportedOperationException for existing gRPC mapping. */
    static class NotAdmittedException extends UnsupportedOperationException {
        NotAdmittedException(String reason) {
            super("NOT_ADMITTED: " + reason);
        }
    }

    private static UnsupportedControlException unsupported(String control) {
        return new UnsupportedControlException(control,
                "provider has no qualified observable effect or mapping for " + control);
    }

    /** Identifies a valid, bounded control for which no admitted provider effect exists. */
    static final class UnsupportedControlException extends NotAdmittedException {
        private final String control;

        UnsupportedControlException(String control, String reason) {
            super(reason);
            this.control = control;
        }

        String control() { return control; }
    }

    private static double finite(double value, String name) {
        if (!Double.isFinite(value)) throw new IllegalArgumentException(name + " must be finite");
        return value;
    }

    private static Locale parseLanguageTag(String languageTag) {
        try {
            Locale locale = new Locale.Builder().setLanguageTag(languageTag).build();
            if (locale.getLanguage().isBlank()) {
                throw new IllegalArgumentException("language must be a BCP-47 language tag");
            }
            return locale;
        } catch (IllformedLocaleException malformed) {
            throw new IllegalArgumentException("language must be a well-formed BCP-47 language tag", malformed);
        }
    }
}
