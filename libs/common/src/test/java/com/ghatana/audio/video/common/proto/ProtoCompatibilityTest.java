package com.ghatana.audio.video.common.proto;

import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * Semantic compatibility checks for the active Media service proto contracts.
 *
 * <p>The retired desktop application is quarantined under {@code archive/} and cannot be an
 * active contract authority. These checks therefore validate the service-owned proto schemas
 * directly instead of coupling production verification to archived Rust copies.
 */
@DisplayName("Proto compatibility")
class ProtoCompatibilityTest {

    @Test
    @DisplayName("active Media service protos expose the required RPC methods")
    void shouldKeepSharedRpcMethodsAligned() throws IOException { 
        ProtoSchema ttsJava = loadSchema("modules/speech/tts-service/src/main/proto/tts_service.proto");
        assertRpcMethods(ttsJava, "TTSService", Set.of("Synthesize", "StreamSynthesize", "GetStatus"));

        ProtoSchema sttJava = loadSchema("modules/speech/stt-service/src/main/proto/stt_service.proto");
        assertRpcMethods(sttJava, "STTService", Set.of("Transcribe", "StreamTranscribe", "GetStatus", "HealthCheck"));

        ProtoSchema visionJava = loadSchema("modules/vision/vision-service/src/main/proto/vision_service.proto");
        assertRpcMethods(visionJava, "VisionService", Set.of("DetectObjects", "AnalyzeImage", "HealthCheck"));

        ProtoSchema multimodalJava = loadSchema("modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto");
        assertRpcMethods(multimodalJava, "MultimodalService", Set.of("ProcessMultimodal", "GenerateDescription", "HealthCheck"));
    }

    @Test
    @DisplayName("TTS proto retains its active request and response message authority")
    void shouldKeepTtsSharedMessagesCompatible() throws IOException { 
        ProtoSchema javaSchema = loadSchema("modules/speech/tts-service/src/main/proto/tts_service.proto");
        assertMessagesDefined(
                javaSchema,
                "SynthesizeRequest",
                "SynthesisOptions",
                "SynthesizeResponse",
                "AudioChunk");
    }

    @Test
    @DisplayName("Vision and Multimodal protos retain their active message authority")
    void shouldKeepVisionAndMultimodalMessagesCompatible() throws IOException {
        ProtoSchema visionJava = loadSchema("modules/vision/vision-service/src/main/proto/vision_service.proto");
        assertMessagesDefined(
                visionJava, "DetectRequest", "DetectResponse", "Detection", "BoundingBox");

        ProtoSchema multimodalJava = loadSchema("modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto");
        assertMessagesDefined(
                multimodalJava,
                "MultimodalRequest",
                "MultimodalResponse",
                "AudioAnalysis",
                "VisualAnalysis",
                "DescriptionRequest",
                "DescriptionResponse");
    }

    @Test
    @DisplayName("Data Cloud media job contracts include required metadata fields")
    void shouldIncludeDataCloudMetadataFields() throws IOException {
        // K2: Ensure STT/TTS/Vision/Multimodal proto types include tenant ID, artifact ID, job ID,
        // correlation ID, and consent/retention metadata for Data Cloud integration

        ProtoSchema sttJava = loadSchema("modules/speech/stt-service/src/main/proto/stt_service.proto");
        assertMessageContainsField(sttJava, "TranscribeRequest", "tenant_id");
        assertMessageContainsField(sttJava, "TranscribeRequest", "artifact_id");
        assertMessageContainsField(sttJava, "TranscribeRequest", "job_id");
        assertMessageContainsField(sttJava, "TranscribeRequest", "correlation_id");
        assertMessageContainsField(sttJava, "TranscribeRequest", "consent_status");
        assertMessageContainsField(sttJava, "TranscribeRequest", "retention_policy");

        ProtoSchema ttsJava = loadSchema("modules/speech/tts-service/src/main/proto/tts_service.proto");
        assertMessageContainsField(ttsJava, "SynthesizeRequest", "tenant_id");
        assertMessageContainsField(ttsJava, "SynthesizeRequest", "artifact_id");
        assertMessageContainsField(ttsJava, "SynthesizeRequest", "job_id");
        assertMessageContainsField(ttsJava, "SynthesizeRequest", "correlation_id");
        assertMessageContainsField(ttsJava, "SynthesizeRequest", "consent_status");
        assertMessageContainsField(ttsJava, "SynthesizeRequest", "retention_policy");

        ProtoSchema visionJava = loadSchema("modules/vision/vision-service/src/main/proto/vision_service.proto");
        assertMessageContainsField(visionJava, "DetectRequest", "tenant_id");
        assertMessageContainsField(visionJava, "DetectRequest", "artifact_id");
        assertMessageContainsField(visionJava, "DetectRequest", "job_id");
        assertMessageContainsField(visionJava, "DetectRequest", "correlation_id");
        assertMessageContainsField(visionJava, "DetectRequest", "consent_status");
        assertMessageContainsField(visionJava, "DetectRequest", "retention_policy");

        ProtoSchema multimodalJava = loadSchema("modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto");
        assertMessageContainsField(multimodalJava, "MultimodalRequest", "tenant_id");
        assertMessageContainsField(multimodalJava, "MultimodalRequest", "artifact_id");
        assertMessageContainsField(multimodalJava, "MultimodalRequest", "job_id");
        assertMessageContainsField(multimodalJava, "MultimodalRequest", "correlation_id");
        assertMessageContainsField(multimodalJava, "MultimodalRequest", "consent_status");
        assertMessageContainsField(multimodalJava, "MultimodalRequest", "retention_policy");
    }

    private static void assertRpcMethods(
            ProtoSchema javaSchema,
            String serviceName,
            Set<String> requiredMethods
    ) {
        Map<String, RpcSignature> javaMethods = javaSchema.services.get(serviceName); 

        assertThat(javaMethods) 
                .as("Active proto must define service %s", serviceName)
                .isNotNull(); 
        assertThat(javaMethods.keySet()).containsAll(requiredMethods); 
    }

    private static void assertMessagesDefined(ProtoSchema schema, String... messageNames) {
        assertThat(schema.messages.keySet()).contains(messageNames);
    }

    private static void assertMessageContainsField(
            ProtoSchema schema,
            String messageName,
            String fieldName
    ) {
        Map<Integer, String> fields = schema.messages.get(messageName);

        assertThat(fields)
                .as("Proto must define message %s", messageName)
                .isNotNull();

        boolean fieldExists = fields.values().stream()
                .anyMatch(field -> field.toLowerCase().contains(fieldName.toLowerCase()));

        assertThat(fieldExists)
                .as("Message %s must contain field %s", messageName, fieldName)
                .isTrue();
    }

    private static ProtoSchema loadSchema(String targetRelativePath) throws IOException {
        Path repoRoot = findRepoRoot(Path.of("").toAbsolutePath());
        Path schemaPath = repoRoot.resolve(targetRelativePath);
        if (!Files.exists(schemaPath)) {
            throw new IOException("Proto file not found: " + targetRelativePath);
        }

        String content = Files.readString(schemaPath);
        return parseProto(content);
    }

    private static Path findRepoRoot(Path start) { 
        Path current = start;
        while (current != null) { 
            if (Files.exists(current.resolve("settings.gradle.kts"))) {
                return current;
            }
            current = current.getParent(); 
        }
        throw new IllegalStateException("Unable to locate repository root");
    }

    private static ProtoSchema parseProto(String content) { 
        Map<String, Map<String, RpcSignature>> services = new LinkedHashMap<>(); 
        Map<String, Map<Integer, String>> messages = new LinkedHashMap<>(); 

        Pattern servicePattern = Pattern.compile("service\\s+(\\w+)\\s*\\{(.*?)\\}", Pattern.DOTALL); 
        Matcher serviceMatcher = servicePattern.matcher(content); 
        while (serviceMatcher.find()) { 
            String serviceName = serviceMatcher.group(1); 
            String body = serviceMatcher.group(2); 
            services.put(serviceName, parseRpcMethods(body)); 
        }

        Pattern messagePattern = Pattern.compile("message\\s+(\\w+)\\s*\\{(.*?)\\}", Pattern.DOTALL); 
        Matcher messageMatcher = messagePattern.matcher(content); 
        while (messageMatcher.find()) { 
            String messageName = messageMatcher.group(1); 
            String body = messageMatcher.group(2); 
            messages.put(messageName, parseMessageFields(body)); 
        }

        return new ProtoSchema(services, messages); 
    }

    private static Map<String, RpcSignature> parseRpcMethods(String serviceBody) { 
        Map<String, RpcSignature> methods = new LinkedHashMap<>(); 
        Pattern rpcPattern = Pattern.compile( 
                "rpc\\s+(\\w+)\\s*\\(\\s*(?:stream\\s+)?([\\w.]+)\\s*\\)\\s*returns\\s*\\(\\s*(?:stream\\s+)?([\\w.]+)\\s*\\)", 
                Pattern.MULTILINE
        );
        Matcher rpcMatcher = rpcPattern.matcher(serviceBody); 
        while (rpcMatcher.find()) { 
            String name = rpcMatcher.group(1); 
            String request = rpcMatcher.group(2); 
            String response = rpcMatcher.group(3); 
            methods.put(name, new RpcSignature(request, response)); 
        }
        return methods;
    }

    private static Map<Integer, String> parseMessageFields(String messageBody) { 
        Map<Integer, String> fields = new LinkedHashMap<>(); 
        Pattern fieldPattern = Pattern.compile( 
                "^\\s*(repeated\\s+)?(map<[^>]+>|[\\w.]+)\\s+(\\w+)\\s*=\\s*(\\d+)\\s*;", 
                Pattern.MULTILINE
        );
        Matcher fieldMatcher = fieldPattern.matcher(messageBody); 
        while (fieldMatcher.find()) { 
            boolean repeated = fieldMatcher.group(1) != null; 
            String type = fieldMatcher.group(2); 
            String name = fieldMatcher.group(3); 
            int index = Integer.parseInt(fieldMatcher.group(4)); 
            String signature = (repeated ? "repeated " : "") + type + " " + name; 
            fields.put(index, signature); 
        }
        return fields;
    }

    private record RpcSignature(String requestType, String responseType) { 
    }

    private record ProtoSchema( 
            Map<String, Map<String, RpcSignature>> services,
            Map<String, Map<Integer, String>> messages
    ) {
    }
}
