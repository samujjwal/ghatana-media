package com.ghatana.audio.video.multimodal.datacloud;

import org.junit.jupiter.api.Test;

import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.Arrays;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * DC-06: the adapter boundary never accidentally becomes a capability or a
 * Media job-finality owner. Every operation type reports unavailable and no
 * public API mutates Media job state — publication flows only through the
 * admitted outbox seam.
 */
class DataCloudBoundaryGuardTest {

    @Test
    void adapterReportsUnavailableForEveryOperationType() {
        DataCloudMultimodalAdapter adapter = new DataCloudMultimodalAdapter(null);
        for (String operationType : new String[]{
                "TRANSCRIBE", "VISION_ANALYSIS", "MULTIMODAL_INDEX",
                "multimodal", "index", "ANYTHING"}) {
            assertThat(adapter.isAvailable(operationType))
                    .as(operationType).isFalse();
        }
        assertThat(adapter.getSupportedLanguages()).isEmpty();
        assertThat(adapter.getSupportedAnalysisTypes()).isEmpty();
        assertThat(adapter.getSupportedIndexTypes()).isEmpty();
    }

    @Test
    void coordinatorExposesNoJobStateMutationSurface() {
        // Data Cloud publication is observation-only; Media owns job finality.
        // Guard: no public method on the coordinator takes a job id or writes
        // job state — a regression here would make Data Cloud a second
        // authority over Media outcomes.
        for (Method method : MediaObservationPublicationCoordinator.class.getDeclaredMethods()) {
            if (!Modifier.isPublic(method.getModifiers())) {
                continue;
            }
            assertThat(method.getName()).doesNotContainIgnoringCase("job");
            assertThat(Arrays.stream(method.getParameterTypes()).map(Class::getSimpleName))
                    .noneMatch(name -> name.toLowerCase(java.util.Locale.ROOT).contains("job"));
        }
    }
}
