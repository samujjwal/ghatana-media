package com.ghatana.tts.emotion;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * Unit tests for {@link EmotionControlService} (AV-008.2). 
 */
@DisplayName("EmotionControlService — AV-008.2")
class EmotionControlServiceTest {

    private final EmotionControlService service = EmotionControlService.INSTANCE;

    @ParameterizedTest(name = "prosodyFor({0}) returns non-null") 
    @EnumSource(EmotionControlService.EmotionType.class) 
    void prosodyForAllEmotionsNonNull(EmotionControlService.EmotionType emotion) { 
        assertThat(service.prosodyFor(emotion)).isNotNull(); 
    }

    @Test
    @DisplayName("NEUTRAL produces identity prosody (rate=1.0, pitch=0.0)")
    void neutralIsIdentity() { 
        EmotionControlService.ProsodyParameters p = service.prosodyFor(EmotionControlService.EmotionType.NEUTRAL); 
        assertThat(p.speakingRateMul()).isEqualTo(1.0f); 
        assertThat(p.pitchShiftSt()).isEqualTo(0.0f); 
        assertThat(p.hasSsml()).isFalse(); 
    }

    @Test
    @DisplayName("HAPPY produces faster speech and higher pitch")
    void happyProsody() { 
        EmotionControlService.ProsodyParameters p = service.prosodyFor(EmotionControlService.EmotionType.HAPPY); 
        assertThat(p.speakingRateMul()).isGreaterThan(1.0f); 
        assertThat(p.pitchShiftSt()).isGreaterThan(0.0f); 
        assertThat(p.hasSsml()).isTrue(); 
    }

    @Test
    @DisplayName("SAD produces slower speech and lower pitch")
    void sadProsody() { 
        EmotionControlService.ProsodyParameters p = service.prosodyFor(EmotionControlService.EmotionType.SAD); 
        assertThat(p.speakingRateMul()).isLessThan(1.0f); 
        assertThat(p.pitchShiftSt()).isLessThan(0.0f); 
        assertThat(p.hasSsml()).isTrue(); 
    }

    @Test
    @DisplayName("EXCITED produces the fastest speech rate")
    void excitedFastest() { 
        float excitedRate = service.prosodyFor(EmotionControlService.EmotionType.EXCITED).speakingRateMul(); 
        float happyRate   = service.prosodyFor(EmotionControlService.EmotionType.HAPPY).speakingRateMul(); 
        assertThat(excitedRate).isGreaterThan(happyRate); 
    }

    @Test
    @DisplayName("applyEmotionSsml wraps text with SSML tags for HAPPY")
    void applyEmotionSsmlWrapsText() { 
        String result = service.applyEmotionSsml("Hello world", EmotionControlService.EmotionType.HAPPY); 
        assertThat(result).contains("Hello world");
        assertThat(result).contains("<prosody");
        assertThat(result).contains("</prosody>");
    }

    @Test
    @DisplayName("applyEmotionSsml returns plain text for NEUTRAL")
    void applyEmotionSsmlNeutralNoTags() { 
        String result = service.applyEmotionSsml("Hello", EmotionControlService.EmotionType.NEUTRAL); 
        assertThat(result).isEqualTo("Hello");
    }

    @Test
    @DisplayName("applyEmotionSsml throws for blank text")
    void applyEmotionSsmlThrowsBlankText() { 
        assertThatThrownBy(() -> service.applyEmotionSsml("  ", EmotionControlService.EmotionType.HAPPY)) 
                .isInstanceOf(IllegalArgumentException.class); 
    }

    @Test
    @DisplayName("prosodyFor throws NullPointerException for null emotion")
    void prosodyForNullThrows() { 
        assertThatThrownBy(() -> service.prosodyFor(null)) 
                .isInstanceOf(NullPointerException.class); 
    }

    @Test
    @DisplayName("parseEmotion handles case-insensitive input")
    void parseEmotionCaseInsensitive() { 
        assertThat(EmotionControlService.parseEmotion("happy")).isEqualTo(EmotionControlService.EmotionType.HAPPY);
        assertThat(EmotionControlService.parseEmotion("EXCITED")).isEqualTo(EmotionControlService.EmotionType.EXCITED);
        assertThat(EmotionControlService.parseEmotion("Sad")).isEqualTo(EmotionControlService.EmotionType.SAD);
    }

    @Test
    @DisplayName("parseEmotion throws for unknown emotion")
    void parseEmotionThrowsForUnknown() { 
        assertThatThrownBy(() -> EmotionControlService.parseEmotion("ANGRY"))
                .isInstanceOf(IllegalArgumentException.class) 
                .hasMessageContaining("Unknown emotion");
    }

    @Test
    @DisplayName("EmotionType.isValid returns true for valid emotions")
    void isValidReturnsTrue() { 
        assertThat(EmotionControlService.EmotionType.isValid("happy")).isTrue();
        assertThat(EmotionControlService.EmotionType.isValid("NEUTRAL")).isTrue();
    }

    @Test
    @DisplayName("EmotionType.isValid returns false for invalid emotions")
    void isValidReturnsFalse() { 
        assertThat(EmotionControlService.EmotionType.isValid("angry")).isFalse();
        assertThat(EmotionControlService.EmotionType.isValid(null)).isFalse(); 
    }
}
