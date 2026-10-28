package com.ghatana.media.runtime;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.SttSubmissionSnapshot;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import java.util.Map;
import org.junit.jupiter.api.Test;

class SttSubmissionSnapshotTest {
    @Test
    void preservesOptionalPresenceAndExactGlossaryReference() {
        assertThat(snapshot(Map.of()).customGlossaryRef()).isNull();
        assertThat(snapshot(Map.of()).fillerRetakeCandidates()).isNull();
        assertThat(snapshot(Map.of("fillerRetakeCandidates", false)).fillerRetakeCandidates()).isFalse();
        assertThat(snapshot(Map.of("fillerRetakeCandidates", true)).fillerRetakeCandidates()).isTrue();
        assertThat(snapshot(Map.of("customGlossaryRef", "glossary:en-US:v7")).customGlossaryRef())
                .isEqualTo("glossary:en-US:v7");
        assertThat(snapshot(Map.of())).isNotEqualTo(snapshot(Map.of("fillerRetakeCandidates", false)));
        assertThat(snapshot(Map.of("fillerRetakeCandidates", false)))
                .isNotEqualTo(snapshot(Map.of("fillerRetakeCandidates", true)));
    }

    @Test
    void rejectsWrongTypesNullAndOversizedGlossary() {
        assertThatThrownBy(() -> snapshot(Map.of("fillerRetakeCandidates", "false")))
                .isInstanceOf(IllegalArgumentException.class);
        var withNull = new java.util.HashMap<String, Object>();
        withNull.put("customGlossaryRef", null);
        assertThatThrownBy(() -> snapshot(withNull)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> snapshot(Map.of("customGlossaryRef", "x".repeat(385))))
                .isInstanceOf(IllegalArgumentException.class);
    }

    private static SttSubmissionSnapshot snapshot(Map<String, Object> parameters) {
        ProcessingJobRequest request = new ProcessingJobRequest("r", "t", "p", "c", "a", "sha256:" + "0".repeat(64),
                JobType.SPEECH_TO_TEXT, "", parameters, null);
        return SttSubmissionSnapshot.from(request);
    }
}
