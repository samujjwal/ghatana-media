package com.ghatana.audio.video.multimodal;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;
import static org.junit.jupiter.api.Assertions.assertFalse;

import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceProto;
import com.google.protobuf.Descriptors;
import java.util.Map;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashSet;
import java.util.List;
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
    void generatedServiceDescriptorPreservesExactRpcAndWireFieldIdentities() {
        Descriptors.ServiceDescriptor service =
                MultimodalServiceProto.getDescriptor().findServiceByName("MultimodalService");
        Map<String, List<String>> expectedMethods = Map.ofEntries(
                Map.entry("ProcessMultimodal", List.of("MultimodalRequest", "MultimodalResponse")),
                Map.entry("AnalyzeVideoWithAudio", List.of("VideoAudioRequest", "VideoAudioResponse")),
                Map.entry("GenerateDescription", List.of("DescriptionRequest", "DescriptionResponse")),
                Map.entry("AnalyzeCrossModal", List.of("CrossModalRequest", "CrossModalResponse")),
                Map.entry("GetInsights", List.of("InsightsRequest", "InsightsResponse")),
                Map.entry("LoadModel", List.of("LoadModelRequest", "LoadModelResponse")),
                Map.entry("UnloadModel", List.of("UnloadModelRequest", "UnloadModelResponse")),
                Map.entry("ListModels", List.of("ListModelsRequest", "ListModelsResponse")),
                Map.entry("GetStatus", List.of("StatusRequest", "StatusResponse")),
                Map.entry("HealthCheck", List.of("HealthCheckRequest", "HealthCheckResponse")));
        Map<String, List<String>> actualMethods = service.getMethods().stream().collect(
                java.util.stream.Collectors.toMap(Descriptors.MethodDescriptor::getName,
                        method -> List.of(method.getInputType().getName(), method.getOutputType().getName())));
        assertEquals(expectedMethods, actualMethods);

        Descriptors.Descriptor frame = MultimodalServiceProto.getDescriptor()
                .findMessageTypeByName("FrameAnalysis");
        assertField(frame, "timestamp_ms", 1, Descriptors.FieldDescriptor.Type.INT64, true);
        assertField(frame, "timestamp_status", 4, Descriptors.FieldDescriptor.Type.ENUM, false);
        assertField(frame, "source_pts", 5, Descriptors.FieldDescriptor.Type.SINT64, true);
        assertField(frame, "time_base_numerator", 6, Descriptors.FieldDescriptor.Type.INT64, true);
        assertField(frame, "time_base_denominator", 7, Descriptors.FieldDescriptor.Type.INT64, true);
        assertField(frame, "clock_domain", 8, Descriptors.FieldDescriptor.Type.ENUM, false);
        assertField(frame, "timestamp_unknown_reason", 9, Descriptors.FieldDescriptor.Type.STRING, false);

        Descriptors.Descriptor videoResponse = MultimodalServiceProto.getDescriptor()
                .findMessageTypeByName("VideoAudioResponse");
        assertField(videoResponse, "synchronization_status", 5, Descriptors.FieldDescriptor.Type.ENUM, false);
        Descriptors.Descriptor crossModalResponse = MultimodalServiceProto.getDescriptor()
                .findMessageTypeByName("CrossModalResponse");
        assertField(crossModalResponse, "synchronization_status", 5,
                Descriptors.FieldDescriptor.Type.ENUM, false);

        // Additive source/operation selection must retain every pre-existing request field tag.
        Descriptors.Descriptor multimodalRequest = MultimodalServiceProto.getDescriptor()
                .findMessageTypeByName("MultimodalRequest");
        assertField(multimodalRequest, "audio_data", 1, Descriptors.FieldDescriptor.Type.BYTES, false);
        assertField(multimodalRequest, "analysis_types", 5, Descriptors.FieldDescriptor.Type.STRING, false);
        assertField(multimodalRequest, "tenant_id", 6, Descriptors.FieldDescriptor.Type.STRING, false);
        assertField(multimodalRequest, "retention_policy", 11, Descriptors.FieldDescriptor.Type.STRING, false);
        assertField(multimodalRequest, "operation_binding", 12,
                Descriptors.FieldDescriptor.Type.MESSAGE, true);
        Descriptors.Descriptor videoAudioRequest = MultimodalServiceProto.getDescriptor()
                .findMessageTypeByName("VideoAudioRequest");
        assertField(videoAudioRequest, "video_data", 1, Descriptors.FieldDescriptor.Type.BYTES, false);
        assertField(videoAudioRequest, "frame_sample_rate", 4, Descriptors.FieldDescriptor.Type.INT32, false);
        assertField(videoAudioRequest, "operation_binding", 5,
                Descriptors.FieldDescriptor.Type.MESSAGE, true);
        assertField(MultimodalServiceProto.getDescriptor().findMessageTypeByName("DescriptionRequest"),
                "operation_binding", 5, Descriptors.FieldDescriptor.Type.MESSAGE, true);
        assertField(MultimodalServiceProto.getDescriptor().findMessageTypeByName("CrossModalRequest"),
                "operation_binding", 4, Descriptors.FieldDescriptor.Type.MESSAGE, true);
        assertField(MultimodalServiceProto.getDescriptor().findMessageTypeByName("InsightsRequest"),
                "operation_binding", 6, Descriptors.FieldDescriptor.Type.MESSAGE, true);

        Descriptors.Descriptor operationBinding = MultimodalServiceProto.getDescriptor()
                .findMessageTypeByName("CanonicalOperationBinding");
        assertField(operationBinding, "capability_ref", 1, Descriptors.FieldDescriptor.Type.STRING, false);
        assertField(operationBinding, "operation_ref", 2, Descriptors.FieldDescriptor.Type.STRING, false);
        assertField(operationBinding, "operation_version", 3, Descriptors.FieldDescriptor.Type.UINT32, false);
        assertField(operationBinding, "request_id", 4, Descriptors.FieldDescriptor.Type.STRING, false);
        assertField(operationBinding, "source_artifact_id", 5, Descriptors.FieldDescriptor.Type.STRING, false);
        assertField(operationBinding, "source_version_id", 6, Descriptors.FieldDescriptor.Type.STRING, false);
        assertField(operationBinding, "purpose", 7, Descriptors.FieldDescriptor.Type.STRING, false);
        assertField(operationBinding, "correlation_id", 8, Descriptors.FieldDescriptor.Type.STRING, false);
        assertField(operationBinding, "dimensions", 9, Descriptors.FieldDescriptor.Type.STRING, false);

        Descriptors.Descriptor modelInfo = MultimodalServiceProto.getDescriptor()
                .findMessageTypeByName("MultimodalModelInfo");
        assertField(modelInfo, "version", 3, Descriptors.FieldDescriptor.Type.STRING, false);
        assertFalse(MultimodalServiceProto.getDescriptor().getMessageTypes().stream()
                .flatMap(message -> message.getFields().stream())
                .anyMatch(field -> field.getName().equals("contract_version")),
                "The source proto has no top-level contract-version field");
    }

    private static void assertField(Descriptors.Descriptor message, String name, int number,
                                    Descriptors.FieldDescriptor.Type type, boolean presence) {
        Descriptors.FieldDescriptor field = message.findFieldByName(name);
        assertTrue(field != null, message.getName() + "." + name + " exists");
        assertEquals(number, field.getNumber(), message.getName() + "." + name + " field number");
        assertEquals(type, field.getType(), message.getName() + "." + name + " field type");
        assertEquals(presence, field.hasPresence(), message.getName() + "." + name + " presence");
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
