package com.ghatana.tts.grpc;

import com.ghatana.media.common.AudioFormat;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.SynthesisOptions;
import java.util.Locale;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class SynthesisControlPolicyTest {

    @Test
    void protoDefaultsResolveToNeutralControlsWithoutClaimingProviderEffects() {
        var resolved = SynthesisControlPolicy.resolve(
                SynthesizeRequest.newBuilder().setText("hello").build(), AudioFormat.PCM);

        assertThat(resolved.speed()).isEqualTo(1.0);
        assertThat(resolved.pitch()).isEqualTo(1.0);
        assertThat(resolved.volume()).isEqualTo(1.0);
        assertThat(resolved.voiceId()).isNull();
        assertThat(resolved.language()).isNull();
        assertThat(resolved.outputFormat()).isEqualTo(AudioFormat.PCM);
    }

    @Test
    void explicitProtoZeroDefaultsRemainNeutral() {
        var request = SynthesizeRequest.newBuilder().setText("hello")
                .setOptions(SynthesisOptions.newBuilder().setSpeed(0).setEnergy(0).build())
                .build();

        var resolved = SynthesisControlPolicy.resolve(request, AudioFormat.PCM);

        assertThat(resolved.speed()).isEqualTo(1.0);
        assertThat(resolved.pitch()).isEqualTo(1.0);
        assertThat(resolved.volume()).isEqualTo(1.0);
    }

    @Test
    void acceptsWellFormedBcp47LanguageAndKeepsOmittedLanguageUnspecified() {
        var request = SynthesizeRequest.newBuilder().setText("hello")
                .setOptions(SynthesisOptions.newBuilder().setLanguage("en-US").build()).build();

        assertThat(SynthesisControlPolicy.resolve(request, AudioFormat.PCM).language())
                .isEqualTo(Locale.forLanguageTag("en-US"));
        assertThat(SynthesisControlPolicy.resolve(
                SynthesizeRequest.newBuilder().setText("hello").build(), AudioFormat.PCM).language())
                .isNull();
    }

    @Test
    void rejectsMalformedOrLanguageLessBcp47TagsInsteadOfNormalizingThem() {
        for (String languageTag : new String[] {"en_US", "en-", "x-private"}) {
            var request = SynthesizeRequest.newBuilder().setText("hello")
                    .setOptions(SynthesisOptions.newBuilder().setLanguage(languageTag).build()).build();
            assertThatThrownBy(() -> SynthesisControlPolicy.resolve(request, AudioFormat.PCM))
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessageContaining("BCP-47");
        }
    }

    @Test
    void mapsSupportedNeutralControlsToRuntimeUnits() {
        var request = SynthesizeRequest.newBuilder().setText("hello")
                .setOptions(SynthesisOptions.newBuilder()
                        .setSpeed(1.0f).setPitch(0.0f).setEnergy(1.0f).setEmotion("NEUTRAL").build())
                .build();

        var resolved = SynthesisControlPolicy.resolve(request, AudioFormat.PCM);

        assertThat(resolved.speed()).isEqualTo(1.0); // multiplier
        assertThat(resolved.pitch()).isEqualTo(1.0); // neutral pitch ratio
        assertThat(resolved.volume()).isEqualTo(1.0); // linear gain
        assertThat(resolved.outputFormat()).isEqualTo(AudioFormat.PCM);
    }

    @Test
    void rejectsNonFiniteAndOutOfRangeWireControlsAsInvalid() {
        for (SynthesisOptions options : new SynthesisOptions[] {
                SynthesisOptions.newBuilder().setSpeed(Float.NaN).build(),
                SynthesisOptions.newBuilder().setSpeed(Float.POSITIVE_INFINITY).build(),
                SynthesisOptions.newBuilder().setSpeed(0.49f).build(),
                SynthesisOptions.newBuilder().setSpeed(2.01f).build(),
                SynthesisOptions.newBuilder().setPitch(Float.NEGATIVE_INFINITY).build(),
                SynthesisOptions.newBuilder().setPitch(-12.01f).build(),
                SynthesisOptions.newBuilder().setPitch(12.01f).build(),
                SynthesisOptions.newBuilder().setEnergy(Float.NaN).build(),
                SynthesisOptions.newBuilder().setEnergy(-0.01f).build(),
                SynthesisOptions.newBuilder().setEnergy(2.01f).build()
        }) {
            var request = SynthesizeRequest.newBuilder().setText("hello").setOptions(options).build();
            assertThatThrownBy(() -> SynthesisControlPolicy.resolve(request, AudioFormat.PCM))
                    .isInstanceOf(IllegalArgumentException.class)
                    .isNotInstanceOf(SynthesisControlPolicy.NotAdmittedException.class);
        }
    }

    @Test
    void finiteInRangeNonNeutralControlsAreTypedNotAdmitted() {
        for (SynthesisOptions options : new SynthesisOptions[] {
                SynthesisOptions.newBuilder().setSpeed(0.5f).build(),
                SynthesisOptions.newBuilder().setSpeed(2.0f).build(),
                SynthesisOptions.newBuilder().setPitch(-12.0f).build(),
                SynthesisOptions.newBuilder().setPitch(12.0f).build(),
                SynthesisOptions.newBuilder().setEnergy(2.0f).build(),
                SynthesisOptions.newBuilder().setEmotion("happy").build()
        }) {
            var request = SynthesizeRequest.newBuilder().setText("hello").setOptions(options).build();
            assertThatThrownBy(() -> SynthesisControlPolicy.resolve(request, AudioFormat.PCM))
                    .isInstanceOf(SynthesisControlPolicy.NotAdmittedException.class)
                    .hasMessageStartingWith("NOT_ADMITTED:");
        }
    }

    @Test
    void unsupportedBoundedControlReportsWhichEffectCannotBeApplied() {
        var request = SynthesizeRequest.newBuilder().setText("hello")
                .setOptions(SynthesisOptions.newBuilder().setSpeed(0.5f).build()).build();

        assertThatThrownBy(() -> SynthesisControlPolicy.resolve(request, AudioFormat.PCM))
                .isInstanceOfSatisfying(SynthesisControlPolicy.UnsupportedControlException.class, error ->
                        assertThat(error.control()).isEqualTo("speed"))
                .hasMessageStartingWith("NOT_ADMITTED:");
    }

    @Test
    void invalidEmotionAndSsmlControlsFailWithoutAnAdmittedMapping() {
        var invalidEmotion = SynthesizeRequest.newBuilder().setText("hello")
                .setOptions(SynthesisOptions.newBuilder().setEmotion("mystery").build()).build();
        assertThatThrownBy(() -> SynthesisControlPolicy.resolve(invalidEmotion, AudioFormat.PCM))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unsupported emotion");

        assertThatThrownBy(() -> SynthesisControlPolicy.rejectUnqualifiedSsml(
                "<speak><prosody rate=\"120%\">hello</prosody></speak>"))
                .isInstanceOf(SynthesisControlPolicy.NotAdmittedException.class)
                .hasMessageStartingWith("NOT_ADMITTED:");
    }

    @Test
    void validProsodyAndPronunciationAreParsedButNeverReportedAsApplied() {
        for (String ssml : new String[] {
                "<speak><prosody rate=\"120%\" pitch=\"2st\" volume=\"3dB\">hello</prosody></speak>",
                "<speak><phoneme alphabet=\"ipa\" ph=\"həˈloʊ\">hello</phoneme></speak>"
        }) {
            assertThatThrownBy(() -> SynthesisControlPolicy.rejectUnqualifiedSsml(ssml))
                    .isInstanceOf(SynthesisControlPolicy.UnsupportedControlException.class)
                    .satisfies(error -> assertThat(
                            ((SynthesisControlPolicy.UnsupportedControlException) error).control())
                            .isEqualTo("ssml"))
                    .hasMessageContaining("no qualified observable effect or mapping");
        }
    }

    @Test
    void malformedOrUnboundedSsmlControlsAreInvalidRatherThanCapabilityDenials() {
        for (String ssml : new String[] {
                "<speak><prosody rate=\"201%\">hello</prosody></speak>",
                "<speak><prosody pitch=\"2\">hello</prosody></speak>",
                "<speak><prosody volume=\"7dB\">hello</prosody></speak>"
        }) {
            assertThatThrownBy(() -> SynthesisControlPolicy.rejectUnqualifiedSsml(ssml))
                    .isInstanceOf(IllegalArgumentException.class)
                    .isNotInstanceOf(SynthesisControlPolicy.NotAdmittedException.class);
        }
    }
}
