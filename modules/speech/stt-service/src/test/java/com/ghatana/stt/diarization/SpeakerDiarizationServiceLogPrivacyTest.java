package com.ghatana.stt.diarization;

import com.ghatana.stt.testutil.LogCapture;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

class SpeakerDiarizationServiceLogPrivacyTest {
    @Test
    void diarizationLogsOnlyAggregateCountsNotSpeakerLabelsWindowsOrTranscript() {
        String transcriptMarker = "diarization-transcript-private-marker";
        long startMarker = 123_456L;
        long endMarker = 789_012L;
        SpeakerDiarizationService service = SpeakerDiarizationService.builder()
                .embeddingExtractor(audio -> new float[] {1.0f, 0.0f})
                .admission(() -> true) // fixture gate; this test does not prove trusted admission
                .build();

        try (LogCapture logs = LogCapture.capture(SpeakerDiarizationService.class)) {
            var turns = service.diarize(List.of(new SpeakerDiarizationService.AudioSegment(
                    new byte[] {1, 2}, startMarker, endMarker, transcriptMarker)));

            assertThat(turns).hasSize(1);
            assertThat(turns.get(0).speakerId()).isEqualTo("SPEAKER_0");
            assertThat(logs.output()).contains("Diarization complete");
            assertThat(logs.output()).doesNotContain(
                    transcriptMarker, "SPEAKER_0", Long.toString(startMarker), Long.toString(endMarker));
        }
    }
}
