package com.ghatana.tts.mixing;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Nested;
import org.junit.jupiter.api.Test;

import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatIllegalArgumentException;
import static org.assertj.core.api.Assertions.assertThatNullPointerException;

/**
 * Unit tests for {@link VoiceMixingService} — AV-008.4.
 *
 * @doc.type class
 * @doc.purpose Unit tests for the voice mixing service
 * @doc.layer product
 * @doc.pattern Test
 */
@DisplayName("VoiceMixingService")
class VoiceMixingServiceTest {

    /** Stub mixer: concatenates all track bytes. */
    private static final VoiceMixingService.AudioMixer STUB_MIXER = tracks -> {
        int total = tracks.stream().mapToInt(t -> t.audioBytes().length).sum(); 
        byte[] out = new byte[total];
        int pos = 0;
        for (VoiceMixingService.AudioTrack t : tracks) { 
            System.arraycopy(t.audioBytes(), 0, out, pos, t.audioBytes().length); 
            pos += t.audioBytes().length; 
        }
        return out;
    };

    private VoiceMixingService buildService() { 
        return VoiceMixingService.of(STUB_MIXER); 
    }

    // ─── of() ───────────────────────────────────────────────────────────────── 

    @Test
    @DisplayName("of(null) throws NullPointerException")
    void of_null_throwsNPE() { 
        assertThatNullPointerException() 
                .isThrownBy(() -> VoiceMixingService.of(null)); 
    }

    // ─── mix() ──────────────────────────────────────────────────────────────── 

    @Nested
    @DisplayName("mix()")
    class Mix {

        @Test
        @DisplayName("single track produces output bytes matching track bytes")
        void mix_singleTrack_correctOutput() { 
            VoiceMixingService service = buildService(); 
            var track = VoiceMixingService.AudioTrack.of(new byte[]{1, 2, 3}, 500L, "alice"); 
            VoiceMixingService.MixedAudio result = service.mix(List.of(track)); 

            assertThat(result.audioBytes()).containsExactly(1, 2, 3); 
            assertThat(result.trackCount()).isEqualTo(1); 
            assertThat(result.totalDurationMs()).isEqualTo(500L); 
        }

        @Test
        @DisplayName("multiple tracks produce concatenated bytes (stub behaviour)")
        void mix_multipleTracks_concatenated() { 
            VoiceMixingService service = buildService(); 
            var track1 = VoiceMixingService.AudioTrack.of(new byte[]{1, 2}, 300L, "alice"); 
            var track2 = VoiceMixingService.AudioTrack.of(new byte[]{3, 4}, 500L, "bob"); 

            VoiceMixingService.MixedAudio result = service.mix(List.of(track1, track2)); 

            assertThat(result.audioBytes()).containsExactly(1, 2, 3, 4); 
            assertThat(result.trackCount()).isEqualTo(2); 
            assertThat(result.totalDurationMs()).isEqualTo(500L); // max of 300 and 500 
        }

        @Test
        @DisplayName("null tracks throws NullPointerException")
        void mix_null_throwsNPE() { 
            VoiceMixingService service = buildService(); 
            assertThatNullPointerException().isThrownBy(() -> service.mix(null)); 
        }

        @Test
        @DisplayName("empty tracks throws IllegalArgumentException")
        void mix_empty_throwsIAE() { 
            VoiceMixingService service = buildService(); 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> service.mix(Collections.emptyList())); 
        }

        @Test
        @DisplayName("hasAudio is true when output is non-empty")
        void mix_hasAudio_true() { 
            VoiceMixingService service = buildService(); 
            var track = VoiceMixingService.AudioTrack.of(new byte[]{1}, 100L, "v"); 
            assertThat(service.mix(List.of(track)).hasAudio()).isTrue(); 
        }
    }

    // ─── session ──────────────────────────────────────────────────────────────

    @Nested
    @DisplayName("session()")
    class Session {

        @Test
        @DisplayName("session mixes all added tracks correctly")
        void session_mixesAllTracks() { 
            VoiceMixingService service = buildService(); 
            var track1 = VoiceMixingService.AudioTrack.of(new byte[]{10, 20}, 200L, "a"); 
            var track2 = VoiceMixingService.AudioTrack.of(new byte[]{30}, 100L, "b"); 

            VoiceMixingService.MixedAudio result = service.session().build() 
                    .addTrack(track1) 
                    .addTrack(track2) 
                    .mix(); 

            assertThat(result.trackCount()).isEqualTo(2); 
        }

        @Test
        @DisplayName("adding null track to session throws NullPointerException")
        void session_addNullTrack_throwsNPE() { 
            VoiceMixingService service = buildService(); 
            assertThatNullPointerException() 
                    .isThrownBy(() -> service.session().build().addTrack(null)); 
        }
    }

    // ─── AudioTrack validation ────────────────────────────────────────────────

    @Nested
    @DisplayName("AudioTrack")
    class AudioTrackTests {

        @Test
        @DisplayName("volume > 1.0 throws IllegalArgumentException")
        void audioTrack_invalidVolume_throwsIAE() { 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> new VoiceMixingService.AudioTrack( 
                            new byte[]{1}, 1.5, 0.0, 0L, 100L, "track"));
        }

        @Test
        @DisplayName("pan < -1.0 throws IllegalArgumentException")
        void audioTrack_invalidPan_throwsIAE() { 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> new VoiceMixingService.AudioTrack( 
                            new byte[]{1}, 1.0, -1.5, 0L, 100L, "track"));
        }

        @Test
        @DisplayName("negative offsetMs throws IllegalArgumentException")
        void audioTrack_negativeOffset_throwsIAE() { 
            assertThatIllegalArgumentException() 
                    .isThrownBy(() -> new VoiceMixingService.AudioTrack( 
                            new byte[]{1}, 1.0, 0.0, -1L, 100L, "track"));
        }

        @Test
        @DisplayName("AudioTrack.of: creates track at full volume, centred, zero offset")
        void audioTrack_of_defaults() { 
            var track = VoiceMixingService.AudioTrack.of(new byte[]{1}, 500L, "voice"); 
            assertThat(track.volume()).isEqualTo(1.0); 
            assertThat(track.pan()).isEqualTo(0.0); 
            assertThat(track.offsetMs()).isEqualTo(0L); 
        }

        @Test
        @DisplayName("null audioBytes throws NullPointerException")
        void audioTrack_nullBytes_throwsNPE() { 
            assertThatNullPointerException() 
                    .isThrownBy(() -> VoiceMixingService.AudioTrack.of(null, 100L, "x")); 
        }
    }
}
