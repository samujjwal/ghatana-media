package com.ghatana.audio.video.multimodal.engine;

import tools.jackson.databind.JsonNode;
import tools.jackson.databind.ObjectMapper;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.junit.jupiter.api.Assertions.assertEquals;
import static org.junit.jupiter.api.Assertions.assertTrue;

@DisplayName("Media runtime value tests")
class MediaContractInteropTest {

    private static final ObjectMapper OBJECT_MAPPER = new ObjectMapper(); 

    @Test
    @DisplayName("runtime settings preserve the active media fixture values")
    void shouldReadRuntimeSettingsFixtureValues() throws IOException {
        JsonNode fixture = readFixture(); 
        JsonNode runtime = fixture.get("runtimeConfig");

        AudioVideoRuntimeSettings settings = new AudioVideoRuntimeSettings( 
                runtime.get("languageTag").asText(),
                runtime.get("sttSampleRate").asInt(),
                runtime.get("sttChannels").asInt(),
                runtime.get("sttBitsPerSample").asInt(),
                runtime.get("defaultImageWidth").asInt(),
                runtime.get("defaultImageHeight").asInt(),
                runtime.get("syncToleranceMs").asInt(),
                runtime.get("syncAudioBufferMs").asInt(),
                runtime.get("syncVideoBufferMs").asInt(),
                runtime.get("defaultVideoSampleFps").asInt(),
                runtime.get("defaultVideoMaxFrames").asInt(),
                runtime.get("sttModelId").asText(),
                runtime.get("visionModelId").asText(),
                runtime.get("ttsVoiceId").asText(),
                runtime.get("metricsEnabled").asBoolean(),
                runtime.get("maxInputStreams").asInt(),
                runtime.get("maxOutputStreams").asInt(),
                runtime.get("deviceAcquireTimeoutMs").asLong(),
                runtime.get("leakDetectionThresholdMs").asLong());

        assertEquals("en-GB", settings.languageTag());
        assertEquals(4200L, settings.deviceAcquireTimeoutMs());
        assertEquals(61_000L, settings.leakDetectionThresholdMs());
    }

    @Test
    @DisplayName("processing error retains the local media error taxonomy")
    void shouldPreserveProcessingErrorValues() throws IOException {
        JsonNode error = readFixture().get("errorCodes").get(0);
        AudioVideoProcessingError processingError = new AudioVideoProcessingError( 
                error.get("code").asText(),
                error.get("category").asText(),
                error.get("retryable").asBoolean(),
                error.get("message").asText());

        assertEquals("media.temporarily_unavailable", processingError.code());
        assertEquals("runtime", processingError.category());
        assertTrue(processingError.retryable());
        assertTrue(processingError.message().startsWith("Temporary backend outage"));
    }

    private static JsonNode readFixture() throws IOException { 
        return OBJECT_MAPPER.readTree(Files.readString(findRepoRoot() 
                .resolve("test-fixtures/media-contract-fixtures.json")));
    }

    private static Path findRepoRoot() { 
        Path current = Path.of("").toAbsolutePath();
        while (current != null) { 
            if (Files.exists(current.resolve("settings.gradle.kts"))
                    && Files.exists(current.resolve("pnpm-workspace.yaml"))
                    && Files.exists(current.resolve("test-fixtures/media-contract-fixtures.json"))) {
                return current;
            }
            current = current.getParent(); 
        }
        throw new IllegalStateException("Unable to locate repository root");
    }
}
