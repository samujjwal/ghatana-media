package com.ghatana.media.launcher;

import com.ghatana.media.launcher.MediaDevProjectRenderRuntime.RenderNotSupportedException;
import com.ghatana.media.production.rendering.MultitrackRenderPlanner.Time;
import java.nio.ByteBuffer;
import java.nio.ByteOrder;
import java.nio.charset.StandardCharsets;
import java.util.List;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaDevProjectAudioMixTest {
    private static final Time ONE_FRAME = new Time(1, 48_000);

    @Test
    void mixesAlignedPcmFrames() {
        byte[] wav = pcmWav(new byte[] {1, 0, 2, 0});

        MediaDevProjectAudioMix.Result result = MediaDevProjectAudioMix.mix(
                List.of(input(wav)), ONE_FRAME);

        assertThat(result.frameCount()).isEqualTo(1);
        assertThat(result.sampleRate()).isEqualTo(48_000);
        assertThat(result.lineage().get("frameCount")).isEqualTo(1);
    }

    @Test
    void rejectsPartialStereoFrameWithoutTrimmingOrMutatingInput() {
        byte[] wav = pcmWav(new byte[] {1, 0, 2, 0, 3});
        byte[] original = wav.clone();

        assertThatThrownBy(() -> MediaDevProjectAudioMix.mix(List.of(input(wav)), ONE_FRAME))
                .isInstanceOfSatisfying(RenderNotSupportedException.class, failure -> {
                    assertThat(failure.code()).isEqualTo("RENDER_UNSUPPORTED_AUDIO_FORMAT");
                    assertThat(failure).hasMessageContaining("complete interleaved frames");
                });

        assertThat(wav).isEqualTo(original);
    }

    private static MediaDevProjectAudioMix.Input input(byte[] wav) {
        return new MediaDevProjectAudioMix.Input(
                "clip-1", "artifact-1", "version-1", "a".repeat(64), wav,
                new Time(0, 1), new Time(0, 1), ONE_FRAME);
    }

    private static byte[] pcmWav(byte[] pcm) {
        ByteBuffer output = ByteBuffer.allocate(44 + pcm.length).order(ByteOrder.LITTLE_ENDIAN);
        output.put("RIFF".getBytes(StandardCharsets.US_ASCII)).putInt(36 + pcm.length);
        output.put("WAVEfmt ".getBytes(StandardCharsets.US_ASCII)).putInt(16);
        output.putShort((short) 1).putShort((short) 2).putInt(48_000);
        output.putInt(192_000).putShort((short) 4).putShort((short) 16);
        output.put("data".getBytes(StandardCharsets.US_ASCII)).putInt(pcm.length).put(pcm);
        return output.array();
    }
}
