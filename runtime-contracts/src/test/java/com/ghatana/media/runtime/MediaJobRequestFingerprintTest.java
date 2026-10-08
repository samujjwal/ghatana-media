package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRuntimeContracts.JobType;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaGovernanceContext;
import com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJobRequest;
import com.ghatana.media.runtime.MediaJobRequestFingerprint.ProviderDescriptor;
import org.junit.jupiter.api.Test;

import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.ArrayList;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaJobRequestFingerprintTest {
    @Test
    void digestIgnoresObjectInsertionOrderButPreservesArrayOrder() {
        Map<String, Object> leftNested = new LinkedHashMap<>();
        leftNested.put("alpha", 1);
        leftNested.put("beta", List.of("first", "second"));
        Map<String, Object> rightNested = new LinkedHashMap<>();
        rightNested.put("beta", List.of("first", "second"));
        rightNested.put("alpha", 1);
        var first = request(Map.of("nested", leftNested), Set.of("west", "east"));
        var reordered = request(Map.of("nested", rightNested), Set.of("east", "west"));

        assertThat(fingerprint(first)).isEqualTo(fingerprint(reordered));
        assertThat(fingerprint(first)).isNotEqualTo(fingerprint(request(
                Map.of("nested", Map.of("alpha", 1, "beta", List.of("second", "first"))),
                Set.of("east", "west"))));
    }

    @Test
    @SuppressWarnings("unchecked")
    void requestParametersAreDeepSnapshotsAndAccessorsDoNotExposeMutableInternals() {
        Map<String, Object> nested = new LinkedHashMap<>();
        nested.put("label", "original");
        List<Object> rows = new ArrayList<>();
        rows.add(nested);
        int[] samples = {1, 2, 3};
        Map<String, Object> input = new LinkedHashMap<>();
        input.put("rows", rows);
        input.put("samples", samples);
        ProcessingJobRequest request = request(input, Set.of());
        String expected = fingerprint(request);

        nested.put("label", "mutated");
        rows.add(Map.of("label", "late"));
        samples[0] = 99;
        input.put("added", true);

        assertThat(fingerprint(request)).isEqualTo(expected);
        assertThatThrownBy(() -> ((List<Object>) request.parameters().get("rows")).add("late"))
                .isInstanceOf(UnsupportedOperationException.class);
        assertThatThrownBy(() -> ((Map<String, Object>) ((List<?>) request.parameters().get("rows")).get(0))
                .put("label", "mutated-through-getter"))
                .isInstanceOf(UnsupportedOperationException.class);
        int[] exposedSamples = (int[]) request.parameters().get("samples");
        exposedSamples[0] = 777;
        assertThat((int[]) request.parameters().get("samples")).containsExactly(1, 2, 3);
        assertThat(((Map<?, ?>) ((List<?>) request.parameters().get("rows")).get(0)).get("label"))
                .isEqualTo("original");
    }

    @Test
    void requestParametersRejectNonJsonContainers() {
        assertThatThrownBy(() -> request(Map.of("unordered", Set.of("a", "b")), Set.of()))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("Unsupported Media request parameter value type");
    }

    @Test
    void digestBindsProviderSelectionAndCompleteGovernanceAndRejectsUnsupportedNumbers() {
        var request = request(Map.of("quality", "high"), Set.of("west"));
        String baseline = MediaJobRequestFingerprint.compute(request, List.of(provider("provider-a", "1", "model-1")));

        assertThat(MediaJobRequestFingerprint.compute(request, List.of(provider("provider-b", "1", "model-1"))))
                .isNotEqualTo(baseline);
        assertThat(MediaJobRequestFingerprint.compute(request,
                List.of(provider("a@b", "c", "d/e"))))
                .isNotEqualTo(MediaJobRequestFingerprint.compute(request,
                        List.of(provider("a", "b@c", "d/e"))));
        var otherGovernance = new ProcessingJobRequest(
                request.requestId(), request.tenantId(), request.principalId(), request.correlationId(),
                request.artifactId(), request.jobType(), request.providerHint(), request.parameters(),
                new MediaGovernanceContext("consent-2", "editing", null, "eu", Set.of("west"),
                        false, "service-default", false, false, "", null, null));
        assertThat(fingerprint(otherGovernance)).isNotEqualTo(fingerprint(request));

        assertThatThrownBy(() -> fingerprint(request(Map.of("bad", Double.NaN), Set.of())))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("non-finite");
        assertThat(fingerprint(request(Map.of("bad", "\uD800"), Set.of())))
                .isNotEqualTo(fingerprint(request(Map.of("bad", "\uD801"), Set.of())));
    }

    private static String fingerprint(ProcessingJobRequest request) {
        return MediaJobRequestFingerprint.compute(request, List.of(provider("provider-a", "1", "model-1")));
    }

    private static ProviderDescriptor provider(String id, String version, String model) {
        return new ProviderDescriptor(id, version, model);
    }

    private static ProcessingJobRequest request(Map<String, Object> parameters, Set<String> regions) {
        return new ProcessingJobRequest(
                "request-1", "tenant-1", "principal-1", "correlation-1", "artifact-1",
                JobType.VISION, "provider-a", parameters,
                new MediaGovernanceContext("consent-1", "analysis", null, "eu", regions,
                        true, "30-days", false, false, "", null, null));
    }
}
