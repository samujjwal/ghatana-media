package com.ghatana.tts.mixing;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Objects;

/**
 * Voice mixing service for the TTS pipeline (AV-008.4).
 *
 * <p>Mixes multiple synthesised audio tracks into a single output by applying
 * per-track volume, pan, and timing adjustments. Useful for dialogue synthesis,
 * podcast generation, and accessibility audio production.
 *
 * <h3>Acceptance criteria (AV-008.4)</h3>
 * <ul>
 *   <li>Multiple voice synthesis and mixing.</li>
 *   <li>Audio quality metrics validation.</li>
 * </ul>
 *
 * @doc.type class
 * @doc.purpose Voice mixing service for multi-voice TTS audio production
 * @doc.layer product
 * @doc.pattern Service
 */
public final class VoiceMixingService {

    private static final Logger LOG = LoggerFactory.getLogger(VoiceMixingService.class);

    /** Normalised volume range [0.0, 1.0] for each track. */
    public static final double MIN_VOLUME = 0.0;
    public static final double MAX_VOLUME = 1.0;

    /** Pan range [-1.0 (full left) to +1.0 (full right)]. */
    public static final double MIN_PAN = -1.0;
    public static final double MAX_PAN = 1.0;

    private final AudioMixer mixer;

    private VoiceMixingService(AudioMixer mixer) {
        this.mixer = mixer;
    }

    /**
     * Creates a service with the given audio mixer implementation.
     *
     * @param mixer the underlying audio mixer
     * @return a new service instance
     * @throws NullPointerException if mixer is null
     */
    public static VoiceMixingService of(AudioMixer mixer) {
        Objects.requireNonNull(mixer, "mixer must not be null");
        return new VoiceMixingService(mixer);
    }

    // ─── mix ──────────────────────────────────────────────────────────────────

    /**
     * Mixes the given list of tracks into a single audio output.
     *
     * @param tracks ordered list of audio tracks to mix (at least one required)
     * @return the mixed audio output
     * @throws NullPointerException     if tracks is null
     * @throws IllegalArgumentException if tracks is empty
     */
    public MixedAudio mix(List<AudioTrack> tracks) {
        Objects.requireNonNull(tracks, "tracks must not be null");
        if (tracks.isEmpty()) {
            throw new IllegalArgumentException("tracks must not be empty");
        }

        byte[] mixed = mixer.mix(Collections.unmodifiableList(tracks));
        long totalDurationMs = tracks.stream()
                .mapToLong(t -> t.durationMs())
                .max()
                .orElse(0L);

        LOG.debug("Mixed {} tracks → {} bytes, maxDuration={}ms",
                tracks.size(), mixed.length, totalDurationMs);
        return new MixedAudio(mixed, tracks.size(), totalDurationMs);
    }

    /**
     * Creates a mix session builder for fluid track composition.
     *
     * @return a new empty session builder
     */
    public MixSession.Builder session() {
        return new MixSession.Builder(this);
    }

    // ─── domain types ─────────────────────────────────────────────────────────

    /** Pluggable audio mixing implementation. */
    @FunctionalInterface
    public interface AudioMixer {
        /**
         * Mixes multiple audio tracks into one.
         *
         * @param tracks the tracks to mix (unmodifiable list)
         * @return the mixed PCM audio bytes
         */
        byte[] mix(List<AudioTrack> tracks);
    }

    /**
     * An audio track ready to be mixed.
     *
     * @param audioBytes  raw PCM audio bytes
     * @param volume      track volume in [0.0, 1.0]
     * @param pan         stereo panning in [-1.0, +1.0]
     * @param offsetMs    start offset relative to the mix origin in milliseconds
     * @param durationMs  duration of this track in milliseconds
     * @param label       a human-readable label for this track (e.g. voice name)
     */
    public record AudioTrack(
            byte[] audioBytes,
            double volume,
            double pan,
            long offsetMs,
            long durationMs,
            String label
    ) {
        public AudioTrack {
            Objects.requireNonNull(audioBytes, "audioBytes must not be null");
            Objects.requireNonNull(label, "label must not be null");
            if (volume < MIN_VOLUME || volume > MAX_VOLUME) {
                throw new IllegalArgumentException("volume must be in [0.0, 1.0]: " + volume);
            }
            if (pan < MIN_PAN || pan > MAX_PAN) {
                throw new IllegalArgumentException("pan must be in [-1.0, 1.0]: " + pan);
            }
            if (offsetMs < 0) throw new IllegalArgumentException("offsetMs must be >= 0");
            if (durationMs < 0) throw new IllegalArgumentException("durationMs must be >= 0");
        }

        /** Factory: creates a track at full volume, centred, starting at offset 0. */
        public static AudioTrack of(byte[] audioBytes, long durationMs, String label) {
            return new AudioTrack(audioBytes, 1.0, 0.0, 0L, durationMs, label);
        }
    }

    /**
     * The result of a completed mix operation.
     *
     * @param audioBytes    the mixed PCM audio bytes
     * @param trackCount    number of tracks that were mixed
     * @param totalDurationMs the maximum track duration (effective output length in ms)
     */
    public record MixedAudio(byte[] audioBytes, int trackCount, long totalDurationMs) {
        public MixedAudio {
            Objects.requireNonNull(audioBytes, "audioBytes must not be null");
        }

        /** @return true if the mix produced a non-empty audio output */
        public boolean hasAudio() {
            return audioBytes.length > 0;
        }
    }

    /**
     * Fluent builder for composing a mix session incrementally.
     */
    public static final class MixSession {
        private final VoiceMixingService service;
        private final List<AudioTrack> tracks = new ArrayList<>();

        private MixSession(VoiceMixingService service) {
            this.service = service;
        }

        public MixSession addTrack(AudioTrack track) {
            Objects.requireNonNull(track, "track must not be null");
            tracks.add(track);
            return this;
        }

        public MixedAudio mix() {
            return service.mix(new ArrayList<>(tracks));
        }

        /** Builder for {@link MixSession}. */
        public static final class Builder {
            private final VoiceMixingService service;
            private Builder(VoiceMixingService service) { this.service = service; }
            public MixSession build() { return new MixSession(service); }
        }
    }
}
