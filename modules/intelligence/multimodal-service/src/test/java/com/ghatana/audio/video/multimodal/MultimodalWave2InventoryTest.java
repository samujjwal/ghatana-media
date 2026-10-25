package com.ghatana.audio.video.multimodal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import org.junit.jupiter.api.Test;

/** Source-bound census for MM-01. This checks identities, not implementation readiness. */
class MultimodalWave2InventoryTest {
    private static final Path ROOT = repositoryRoot();
    private static final Path PROTO = ROOT.resolve(
            "modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto");
    private static final Path PLAN = ROOT.resolve("docs/implementation/MEDIA-BACKEND-MODALITY-WAVE2-EXECUTION.md");
    private static final Path MATRIX = ROOT.resolve(
            "modules/intelligence/multimodal-service/WAVE2-RPC-CAPABILITY-MATRIX.md");

    @Test
    void rpcNamesAndWireBindingsMatchThePackageMatrix() throws IOException {
        String proto = Files.readString(PROTO);
        String matrix = Files.readString(MATRIX);
        Set<String> methods = matches(proto, "(?m)^\\s*rpc\\s+(\\w+)\\(\\w+\\)\\s+returns\\s+\\(\\w+\\)");
        assertEquals(10, methods.size());
        assertEquals(Set.of("ProcessMultimodal", "AnalyzeVideoWithAudio", "GenerateDescription",
                "AnalyzeCrossModal", "GetInsights", "LoadModel", "UnloadModel", "ListModels",
                "GetStatus", "HealthCheck"), methods);
        for (String method : methods) assertTrue(matrix.contains("`" + method + "`"), method);
        assertTrue(proto.contains("rpc ProcessMultimodal(MultimodalRequest) returns (MultimodalResponse)"));
        assertTrue(proto.contains("rpc AnalyzeVideoWithAudio(VideoAudioRequest) returns (VideoAudioResponse)"));
        assertTrue(proto.contains("rpc GenerateDescription(DescriptionRequest) returns (DescriptionResponse)"));
        assertTrue(proto.contains("rpc AnalyzeCrossModal(CrossModalRequest) returns (CrossModalResponse)"));
        assertTrue(proto.contains("rpc GetInsights(InsightsRequest) returns (InsightsResponse)"));
        assertTrue(proto.contains("optional double alignment_score = 1;"));
        assertTrue(proto.contains("SynchronizationStatus synchronization_status = 5;"));
        assertTrue(proto.contains("map<string, double> confidence_scores = 5;"));
    }

    @Test
    void directAndDelegatedIntentMembershipMatchesRegisteredProjection() throws IOException {
        String matrix = Files.readString(MATRIX);
        String plan = Files.readString(PLAN);
        Set<String> direct = matches(section(matrix, "## Direct Media capability intents", "## Delegated memberships"),
                "`(media\\.multimodal\\.[a-z0-9.-]+)`");
        assertEquals(7, direct.size());

        Set<String> planDelegated = matches(plan,
                "(?m)^\\| MM \\| `(media\\.(?:speech|vision)\\.[^`]+)` \\| MM-05 ");
        Set<String> stt = prefixed(planDelegated, "media.speech.");
        Set<String> vision = prefixed(planDelegated, "media.vision.");
        assertEquals(16, stt.size());
        // The selected MM surface delegates 20 Vision intents; 2 more intents exist on Vision overall.
        assertEquals(20, vision.size());
        assertEquals(43, planDelegated.size() + direct.size());
        assertTrue(matrix.contains("20 of the\n22 Vision intents"));
        assertTrue(matrix.contains("scene-text region tracking and\nscene-text observation"));
        for (String intent : planDelegated) assertTrue(matrix.contains("`" + intent + "`"), intent);
        for (String intent : direct) assertTrue(plan.contains("`" + intent + "`"), intent);
    }

    private static String section(String source, String start, String end) {
        int from = source.indexOf(start);
        int to = source.indexOf(end, from + start.length());
        if (from < 0 || to < 0) throw new AssertionError("Missing inventory section: " + start);
        return source.substring(from, to);
    }

    private static Set<String> matches(String source, String regex) {
        Matcher matcher = Pattern.compile(regex).matcher(source);
        Set<String> result = new LinkedHashSet<>();
        while (matcher.find()) result.add(matcher.group(1));
        return result;
    }

    private static Path repositoryRoot() {
        Path current = Path.of("").toAbsolutePath();
        while (current != null && !Files.isDirectory(current.resolve(".product-experience"))) {
            current = current.getParent();
        }
        if (current == null) throw new IllegalStateException("Cannot locate Media repository root");
        return current;
    }

    private static Set<String> prefixed(Set<String> values, String prefix) {
        Set<String> result = new LinkedHashSet<>();
        for (String value : values) if (value.startsWith(prefix)) result.add(value);
        return result;
    }
}
