package com.ghatana.audio.video.multimodal.engine;

import java.util.ArrayList;
import java.util.List;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class ResultCollectionSnapshotTest {
    @Test
    void audioResultSnapshotsSegmentsAndPreservesUnavailableNull() {
        AudioResult.TimedSegment segment = new AudioResult.TimedSegment(0, 10, "hello");
        AudioResult.TimedSegment later = new AudioResult.TimedSegment(10, 20, "world");
        List<AudioResult.TimedSegment> input = new ArrayList<>(List.of(segment));

        AudioResult result = AudioResult.builder().timedSegments(input).build();
        input.clear();
        input.add(later);

        assertThat(result.getTimedSegments()).containsExactly(segment);
        assertThatThrownBy(() -> result.getTimedSegments().add(later))
                .isInstanceOf(UnsupportedOperationException.class);
        assertThat(AudioResult.builder().timedSegments(null).build().getTimedSegments()).isNull();
    }

    @Test
    void visualResultSnapshotsDetectionAndFrameCollectionsAndPreservesNull() {
        DetectionResult detection = detection("person");
        DetectionResult laterDetection = detection("car");
        FrameResult frame = new FrameResult(1, 10L, List.of());
        FrameResult laterFrame = new FrameResult(2, 20L, List.of());
        List<DetectionResult> detections = new ArrayList<>(List.of(detection));
        List<FrameResult> frames = new ArrayList<>(List.of(frame));

        VisualResult result = VisualResult.builder().detections(detections).frameResults(frames).build();
        detections.clear();
        detections.add(laterDetection);
        frames.clear();
        frames.add(laterFrame);

        assertThat(result.getDetections()).containsExactly(detection);
        assertThat(result.getFrameResults()).containsExactly(frame);
        assertThatThrownBy(() -> result.getDetections().add(laterDetection))
                .isInstanceOf(UnsupportedOperationException.class);
        assertThatThrownBy(() -> result.getFrameResults().add(laterFrame))
                .isInstanceOf(UnsupportedOperationException.class);

        VisualResult unavailable = VisualResult.builder().detections(null).frameResults(null).build();
        assertThat(unavailable.getDetections()).isNull();
        assertThat(unavailable.getFrameResults()).isNull();
    }

    @Test
    void videoAudioResultSnapshotsAlignmentsAndPreservesUnavailableNull() {
        TemporalAlignment alignment = new TemporalAlignment(10L, 1, "hello", List.of());
        TemporalAlignment laterAlignment = new TemporalAlignment(20L, 2, "world", List.of());
        List<TemporalAlignment> input = new ArrayList<>(List.of(alignment));

        VideoAudioResult result = VideoAudioResult.builder().temporalAlignments(input).build();
        input.clear();
        input.add(laterAlignment);

        assertThat(result.getTemporalAlignments()).containsExactly(alignment);
        assertThatThrownBy(() -> result.getTemporalAlignments().add(laterAlignment))
                .isInstanceOf(UnsupportedOperationException.class);
        assertThat(VideoAudioResult.builder().build().getTemporalAlignments()).isNull();
        assertThat(VideoAudioResult.builder().temporalAlignments(null).build().getTemporalAlignments()).isNull();
    }

    private static DetectionResult detection(String name) {
        return new DetectionResult(name, 0.9, 0, 0, 10, 10);
    }
}
