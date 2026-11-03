package com.ghatana.audio.video.integration;

import com.ghatana.audio.video.multimodal.grpc.proto.MultimodalServiceProto;
import com.ghatana.audio.video.vision.grpc.proto.VisionServiceProto;
import com.ghatana.stt.core.grpc.proto.SttServiceProto;
import com.ghatana.tts.core.grpc.proto.TtsServiceProto;
import com.google.protobuf.Descriptors;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import tools.jackson.dataformat.yaml.YAMLFactory;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Checks that the source inventory in the gRPC registry consumes the four
 * governed protobuf service descriptors without dropping or inventing methods.
 * This is an inventory parity check; it does not select protocol authority or
 * establish product-phase acceptance.
 */
class MediaGrpcRegistryDescriptorParityTest {

    private static final Path REGISTRY_RELATIVE_PATH = Path.of(
            ".product-experience/pdp-3-product-experience/grpc/service-registry.yaml");
    private static final Path REPOSITORY_ROOT = findRepositoryRoot();
    private static final Path REGISTRY_PATH = REPOSITORY_ROOT.resolve(REGISTRY_RELATIVE_PATH);
    private static final ObjectMapper YAML = new ObjectMapper(new YAMLFactory());
    private static final Map<String, Descriptors.FileDescriptor> GOVERNED_PROTO_FILES = Map.of(
            "modules/speech/stt-service/src/main/proto/stt_service.proto", SttServiceProto.getDescriptor(),
            "modules/speech/tts-service/src/main/proto/tts_service.proto", TtsServiceProto.getDescriptor(),
            "modules/vision/vision-service/src/main/proto/vision_service.proto", VisionServiceProto.getDescriptor(),
            "modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto",
            MultimodalServiceProto.getDescriptor());

    @Test
    void registryRowsMatchGovernedProtoDescriptorsInBothDirections() throws IOException {
        assertThat(Files.exists(REGISTRY_PATH)).as("gRPC service registry exists").isTrue();
        JsonNode registry = YAML.readTree(Files.readString(REGISTRY_PATH));
        JsonNode rows = registry.path("rpcs");

        // The registry is an observation of 44 declared RPCs. A separate CT-01
        // plan row still says 43; that plan denominator is intentionally not
        // normalized or treated as authority by this source-consumption test.
        assertThat(registry.path("observedRpcCount").asInt()).isEqualTo(44);
        assertThat(rows.isArray()).isTrue();
        assertThat(rows.size()).as("number of currently declared registry rows").isEqualTo(44);

        Map<String, Descriptors.MethodDescriptor> descriptorMethods = descriptorMethods();
        Set<String> registryIds = new HashSet<>();

        for (JsonNode row : rows) {
            String id = requiredText(row, "id");
            String source = requiredText(row, "source");
            String serviceName = requiredText(row, "service");
            String methodName = requiredText(row, "method");
            String registryPackage = requiredText(row, "package");
            String requestName = requiredText(row, "request");
            String responseName = requiredText(row, "response");

            assertThat(registryIds.add(id)).as("duplicate registry RPC identity %s", id).isTrue();
            assertThat(GOVERNED_PROTO_FILES).as("registry source is one of the four governed proto files")
                    .containsKey(source);

            Descriptors.FileDescriptor file = GOVERNED_PROTO_FILES.get(source);
            Descriptors.ServiceDescriptor service = file.findServiceByName(serviceName);
            assertThat(service).as("proto service %s in %s", serviceName, source).isNotNull();
            assertThat(registryPackage).as("protobuf package for %s", id).isEqualTo(file.getPackage());

            Descriptors.MethodDescriptor method = service.findMethodByName(methodName);
            assertThat(method).as("proto method %s", id).isNotNull();
            assertThat(id).isEqualTo("media.grpc." + serviceName + "." + methodName);
            assertThat(requestName).as("request type for %s", id).isEqualTo(method.getInputType().getName());
            assertThat(responseName).as("response type for %s", id).isEqualTo(method.getOutputType().getName());
            assertThat(requiredBoolean(row, "clientStreaming", id))
                    .as("client streaming flag for %s", id).isEqualTo(method.isClientStreaming());
            assertThat(requiredBoolean(row, "serverStreaming", id))
                    .as("server streaming flag for %s", id).isEqualTo(method.isServerStreaming());
        }

        assertThat(registryIds).containsExactlyInAnyOrderElementsOf(descriptorMethods.keySet());
    }

    @Test
    void registryProposalBindingsRemainUnboundUntilOwnerReview() throws IOException {
        assertThat(Files.exists(REGISTRY_PATH)).as("gRPC service registry exists").isTrue();
        JsonNode registry = YAML.readTree(Files.readString(REGISTRY_PATH));

        // The proto inventory is useful to consumers, but these proposal rows do
        // not establish selected protocol authority or admitted PDP bindings.
        assertThat(requiredText(registry, "authorityDisposition"))
                .isEqualTo("protobuf-declarations-are-implementation-or-projection-observations; no-canonical-wire-authority-selected");
        assertThat(requiredText(registry, "semanticAuthority"))
                .isEqualTo("PDP-1 operation proposal is intended semantic authority only after phase acceptance");
        assertThat(requiredText(registry, "status"))
                .contains("protocol-authority-unselected", "operation-bindings-proposal-only", "owner-review-pending");

        JsonNode rows = registry.path("rpcs");
        assertThat(rows.isArray()).isTrue();
        for (JsonNode row : rows) {
            assertThat(requiredText(row, "experienceBinding"))
                    .as("binding for %s stays explicitly pending owner review", requiredText(row, "id"))
                    .isEqualTo("pending-owner-review");
        }
    }

    private static Map<String, Descriptors.MethodDescriptor> descriptorMethods() {
        Map<String, Descriptors.MethodDescriptor> methods = new HashMap<>();
        for (Map.Entry<String, Descriptors.FileDescriptor> entry : GOVERNED_PROTO_FILES.entrySet()) {
            Path source = REPOSITORY_ROOT.resolve(entry.getKey());
            assertThat(Files.exists(source)).as("governed proto source %s exists", source).isTrue();
            for (Descriptors.ServiceDescriptor service : entry.getValue().getServices()) {
                for (Descriptors.MethodDescriptor method : service.getMethods()) {
                    String id = "media.grpc." + service.getName() + "." + method.getName();
                    assertThat(methods.put(id, method)).as("duplicate descriptor method %s", id).isNull();
                }
            }
        }
        return methods;
    }

    private static String requiredText(JsonNode node, String field) {
        JsonNode value = node.get(field);
        assertThat(value).as("registry field %s exists", field).isNotNull();
        assertThat(value.isTextual()).as("registry field %s is text", field).isTrue();
        assertThat(value.asText()).as("registry field %s is nonblank", field).isNotBlank();
        return value.asText();
    }

    private static boolean requiredBoolean(JsonNode node, String field, String id) {
        JsonNode value = node.get(field);
        assertThat(value).as("registry field %s exists for %s", field, id).isNotNull();
        assertThat(value.isBoolean()).as("registry field %s is boolean for %s", field, id).isTrue();
        return value.booleanValue();
    }

    private static Path findRepositoryRoot() {
        Path candidate = Path.of("").toAbsolutePath().normalize();
        while (candidate != null) {
            if (Files.isRegularFile(candidate.resolve(REGISTRY_RELATIVE_PATH))) {
                return candidate;
            }
            candidate = candidate.getParent();
        }
        throw new IllegalStateException("could not locate Media repository root from the test working directory");
    }
}
