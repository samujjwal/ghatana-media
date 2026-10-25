package com.ghatana.tts.grpc;

import static org.assertj.core.api.Assertions.assertThat;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.regex.Pattern;
import com.ghatana.tts.core.grpc.proto.SynthesisOptions;
import com.ghatana.tts.core.grpc.proto.SynthesizeRequest;
import com.ghatana.tts.core.grpc.proto.SynthesizeResponse;
import com.ghatana.tts.core.grpc.proto.TTSServiceGrpc;
import org.junit.jupiter.api.Test;

/** Locks the TTS-01 source inventory without treating fixtures or configured model metadata as qualification. */
class TtsWave2InventoryTest {
    private static final Pattern RPC = Pattern.compile("\\brpc\\s+(\\w+)\\s*\\(");
    private static final Pattern CAPABILITY = Pattern.compile("(?m)^  - id: (media\\.speech\\.synthesis\\.[\\w.-]+)$");
    private static final Pattern MATRIX_RPC = Pattern.compile("(?m)^\\| (\\w+) \\| ([A-Z_]+) \\|");
    private static final Pattern MATRIX_CAPABILITY = Pattern.compile("(?m)^\\| `(media\\.speech\\.synthesis\\.[\\w.-]+)` \\| ([A-Z_]+) \\|");
    private static final List<String> EXPECTED_RPCS = List.of("Synthesize", "StreamSynthesize", "GetStatus", "GetMetrics",
            "GetVoices", "LoadVoice", "CreateProfile", "GetProfile", "UpdateProfile", "CloneVoice", "SubmitFeedback");
    private static final List<String> EXPECTED_CAPABILITIES = List.of(
            "media.speech.synthesis.text-to-speech", "media.speech.synthesis.streaming", "media.speech.synthesis.multilingual",
            "media.speech.synthesis.cross-lingual", "media.speech.synthesis.expressive", "media.speech.synthesis.control.prosody",
            "media.speech.synthesis.control.rate", "media.speech.synthesis.control.pitch", "media.speech.synthesis.control.emotion-style",
            "media.speech.synthesis.control.pronunciation", "media.speech.synthesis.control.phoneme", "media.speech.synthesis.speaker.condition",
            "media.speech.synthesis.speaker.clone-authorized", "media.speech.synthesis.voice.convert", "media.speech.synthesis.speech-to-speech",
            "media.speech.synthesis.speech.translate", "media.speech.synthesis.dub");

    private record Entry(String disposition, String observation) {}

    private static final Map<String, Entry> RPCS = Map.ofEntries(
            Map.entry("Synthesize", new Entry("EXPLICITLY_NOT_ADMITTED", "The gRPC route rejects before engine lookup because no exact admitted voice-language-rights profile exists; no default substitution is permitted.")),
            Map.entry("StreamSynthesize", new Entry("EXPLICITLY_NOT_ADMITTED", "The gRPC handler rejects before engine lookup because no streaming provider is admitted.")),
            Map.entry("GetStatus", new Entry("EXPLICITLY_NOT_ADMITTED", "Proto requires active_sessions absent from EngineStatus; route refuses before lookup and does not expose provider diagnostics.")),
            Map.entry("GetMetrics", new Entry("EXPLICITLY_NOT_ADMITTED", "Proto requires real_time_factor and active_sessions absent from EngineMetrics; requestCount is not a successful-synthesis count.")),
            Map.entry("GetVoices", new Entry("PROVIDER_DEPENDENT", "Lists engine-reported voices; list membership proves no rights or qualification.")),
            Map.entry("LoadVoice", new Entry("EXPLICITLY_NOT_ADMITTED", "Rejects before engine lookup until an authoritative model, license, owner-rights and consent profile is admitted.")),
            Map.entry("CreateProfile", new Entry("EXPLICITLY_NOT_ADMITTED", "UNIMPLEMENTED pending tenant/principal-scoped store, consent, purpose and retention authority.")),
            Map.entry("GetProfile", new Entry("EXPLICITLY_NOT_ADMITTED", "UNIMPLEMENTED pending authoritative profile ownership.")),
            Map.entry("UpdateProfile", new Entry("EXPLICITLY_NOT_ADMITTED", "UNIMPLEMENTED pending authoritative profile ownership.")),
            Map.entry("CloneVoice", new Entry("EXPLICITLY_NOT_ADMITTED", "UNIMPLEMENTED pending owner consent, biometric purpose and retention.")),
            Map.entry("SubmitFeedback", new Entry("NOT_IMPLEMENTED", "UNIMPLEMENTED; no persistence or learning provider is wired.")));

    private static final Map<String, Entry> CAPABILITIES = Map.ofEntries(
            Map.entry("media.speech.synthesis.text-to-speech", new Entry("EXPLICITLY_NOT_ADMITTED", "Synthesize rejects before engine lookup because no exact admitted voice-language-rights profile exists.")),
            Map.entry("media.speech.synthesis.streaming", new Entry("EXPLICITLY_NOT_ADMITTED", "gRPC streaming refuses before engine access; no admitted streaming provider.")),
            Map.entry("media.speech.synthesis.multilingual", new Entry("EXPLICITLY_NOT_ADMITTED", "No exact voice-language-rights profile is admitted for speech; GetVoices is informational only.")),
            Map.entry("media.speech.synthesis.cross-lingual", new Entry("NOT_IMPLEMENTED", "No translation-plus-synthesis operation is wired.")),
            Map.entry("media.speech.synthesis.expressive", new Entry("EXPLICITLY_NOT_ADMITTED", "No qualified expressive effect is established.")),
            Map.entry("media.speech.synthesis.control.prosody", new Entry("EXPLICITLY_NOT_ADMITTED", "SSML/control parsing does not establish audible provider effects.")),
            Map.entry("media.speech.synthesis.control.rate", new Entry("EXPLICITLY_NOT_ADMITTED", "Non-neutral rate effects require a qualified provider.")),
            Map.entry("media.speech.synthesis.control.pitch", new Entry("EXPLICITLY_NOT_ADMITTED", "Non-neutral pitch effects require a qualified provider.")),
            Map.entry("media.speech.synthesis.control.emotion-style", new Entry("EXPLICITLY_NOT_ADMITTED", "No qualified emotion/style effect is established.")),
            Map.entry("media.speech.synthesis.control.pronunciation", new Entry("EXPLICITLY_NOT_ADMITTED", "No qualified pronunciation dictionary effect is established.")),
            Map.entry("media.speech.synthesis.control.phoneme", new Entry("EXPLICITLY_NOT_ADMITTED", "No qualified phoneme effect is established.")),
            Map.entry("media.speech.synthesis.speaker.condition", new Entry("EXPLICITLY_NOT_ADMITTED", "No qualified speaker-conditioning provider or rights decision is wired.")),
            Map.entry("media.speech.synthesis.speaker.clone-authorized", new Entry("EXPLICITLY_NOT_ADMITTED", "Cloning is denied until owner consent, biometric purpose and retention are verified.")),
            Map.entry("media.speech.synthesis.voice.convert", new Entry("NOT_IMPLEMENTED", "No voice-conversion operation is wired.")),
            Map.entry("media.speech.synthesis.speech-to-speech", new Entry("NOT_IMPLEMENTED", "No speech-to-speech operation is wired.")),
            Map.entry("media.speech.synthesis.speech.translate", new Entry("NOT_IMPLEMENTED", "No speech-translation operation is wired.")),
            Map.entry("media.speech.synthesis.dub", new Entry("NOT_IMPLEMENTED", "No dubbing operation is wired.")));

    @Test
    void rpcCensusAndDispositionMatchCurrentProtoAndGrpcHandlers() throws IOException {
        String proto = read("src/main/proto/tts_service.proto");
        List<String> declared = matches(RPC, proto);
        assertThat(declared).containsExactlyElementsOf(EXPECTED_RPCS);
        assertThat(RPCS.keySet()).containsExactlyInAnyOrderElementsOf(EXPECTED_RPCS);

        String grpc = read("src/main/java/com/ghatana/tts/grpc/TtsGrpcService.java");
        assertThat(grpc).contains("throw new TtsSynthesisEngine.SynthesisException(\n                    \"TTS streaming is NOT_ADMITTED");
        assertThat(grpc).contains("profileAccessNotAdmitted(responseObserver)")
                .contains("Voice loading is NOT_ADMITTED")
                .contains("GetStatus is NOT_ADMITTED", "GetMetrics is NOT_ADMITTED")
                .contains("Voice cloning is NOT_ADMITTED")
                .contains("TTS feedback requires");
        assertThat(RPCS).containsKeys(declared.toArray(String[]::new));
        assertThat(RPCS.values()).allSatisfy(entry -> assertThat(entry.observation()).isNotBlank());
        Map<String, String> matrix = matrixEntries(MATRIX_RPC);
        assertThat(matrix.keySet()).containsExactlyInAnyOrderElementsOf(EXPECTED_RPCS);
        RPCS.forEach((name, entry) -> assertThat(matrix.get(name)).as(name).isEqualTo(entry.disposition()));
    }

    @Test
    void generatedDescriptorsPreserveRpcAndCriticalFieldNumbersWithoutProtocolVersionNegotiation() {
        List<String> descriptorMethods = TTSServiceGrpc.getServiceDescriptor().getMethods().stream()
                .map(io.grpc.MethodDescriptor::getBareMethodName)
                .toList();
        assertThat(descriptorMethods).containsExactlyElementsOf(EXPECTED_RPCS);
        assertThat(descriptorMethods).doesNotContain("GetVersion", "NegotiateVersion");

        var synthesizeRequest = SynthesizeRequest.getDescriptor();
        assertFieldNumber(synthesizeRequest, "text", 1);
        assertFieldNumber(synthesizeRequest, "voice_id", 2);
        assertFieldNumber(synthesizeRequest, "profile_id", 3);
        assertFieldNumber(synthesizeRequest, "options", 4);
        assertFieldNumber(synthesizeRequest, "tenant_id", 5);
        assertFieldNumber(synthesizeRequest, "artifact_id", 6);
        assertFieldNumber(synthesizeRequest, "job_id", 7);
        assertFieldNumber(synthesizeRequest, "correlation_id", 8);
        assertFieldNumber(synthesizeRequest, "consent_status", 9);
        assertFieldNumber(synthesizeRequest, "retention_policy", 10);
        assertThat(synthesizeRequest.findFieldByName("protocol_version")).isNull();

        assertFieldNumber(SynthesisOptions.getDescriptor(), "output_format", 6);
        assertFieldNumber(SynthesizeResponse.getDescriptor(), "audio_data", 1);
        assertFieldNumber(SynthesizeResponse.getDescriptor(), "sample_rate", 2);
        assertFieldNumber(SynthesizeResponse.getDescriptor(), "duration_ms", 3);
        assertFieldNumber(SynthesizeResponse.getDescriptor(), "processing_time_ms", 4);
        assertFieldNumber(SynthesizeResponse.getDescriptor(), "voice_used", 5);
    }

    private static void assertFieldNumber(
            com.google.protobuf.Descriptors.Descriptor message, String field, int expectedNumber) {
        var descriptor = message.findFieldByName(field);
        assertThat(descriptor).as("%s.%s", message.getName(), field).isNotNull();
        assertThat(descriptor.getNumber()).as("%s.%s field number", message.getName(), field)
                .isEqualTo(expectedNumber);
    }

    @Test
    void sourceCapabilityCensusAndProviderCodecBoundariesAreExplicit() throws IOException {
        String source = Files.readString(repositoryRoot().resolve(".product-experience/pdp-0-product-truth/capabilities.yaml"));
        List<String> sourceIds = matches(CAPABILITY, source).stream()
                .filter(id -> id.startsWith("media.speech.synthesis.")).toList();
        assertThat(sourceIds).containsExactlyElementsOf(EXPECTED_CAPABILITIES);
        assertThat(CAPABILITIES.keySet()).containsExactlyInAnyOrderElementsOf(EXPECTED_CAPABILITIES);
        assertThat(CAPABILITIES.values()).allSatisfy(entry -> assertThat(entry.observation()).isNotBlank());
        Map<String, String> matrix = matrixEntries(MATRIX_CAPABILITY);
        assertThat(matrix.keySet()).containsExactlyInAnyOrderElementsOf(EXPECTED_CAPABILITIES);
        CAPABILITIES.forEach((id, entry) -> assertThat(matrix.get(id)).as(id).isEqualTo(entry.disposition()));

        String hostedApi = Files.readString(repositoryRoot().resolve("libs/java/common/src/main/java/com/ghatana/media/tts/api/TtsEngine.java"));
        String standalone = read("src/main/java/com/ghatana/tts/engine/TtsSynthesisEngine.java");
        String grpc = read("src/main/java/com/ghatana/tts/grpc/TtsGrpcService.java");
        String production = read("src/main/java/com/ghatana/tts/grpc/ProductionTtsGrpcService.java");
        assertThat(hostedApi).contains("AudioData synthesize(String text, SynthesisOptions options)")
                .contains("void synthesizeStreaming(").contains("List<VoiceInfo> getAvailableVoices()");
        assertThat(standalone).contains("FailureReason.NOT_ADMITTED");
        assertThat(grpc).contains("AUDIO_FORMAT_PCM_F32LE", "AUDIO_FORMAT_WAV", "AUDIO_FORMAT_MP3")
                .contains("PCM F32LE output is NOT_ADMITTED", "WAV output is NOT_ADMITTED", "MP3 output is NOT_ADMITTED");
        assertThat(production).contains("TTS_PROVIDER_MODE", "LOCAL_ONNX", "TTS_MODEL_SHA256")
                .contains("license, voice rights, hardware and quality are not source-admitted");
        assertThat(read("README.md")).contains("PROVIDER_DEPENDENT", "NOT_ADMITTED", "PCM_S16LE", "MP3");
    }

    private String read(String relative) throws IOException {
        return Files.readString(repositoryRoot().resolve("modules/speech/tts-service").resolve(relative));
    }

    private static Path repositoryRoot() {
        Path current = Path.of("").toAbsolutePath();
        while (current != null && !Files.isDirectory(current.resolve(".product-experience"))) current = current.getParent();
        if (current == null) throw new IllegalStateException("Repository root not found from test working directory");
        return current;
    }

    private Map<String, String> matrixEntries(Pattern rowPattern) throws IOException {
        var matcher = rowPattern.matcher(Files.readString(repositoryRoot()
                .resolve("modules/speech/tts-service/WAVE2-RPC-CAPABILITY-MATRIX.md")));
        Map<String, String> entries = new java.util.LinkedHashMap<>();
        while (matcher.find()) {
            assertThat(entries.put(matcher.group(1), matcher.group(2)))
                    .as("duplicate matrix row %s", matcher.group(1)).isNull();
        }
        return entries;
    }

    private static List<String> matches(Pattern pattern, String text) {
        var matcher = pattern.matcher(text);
        var result = new java.util.ArrayList<String>();
        while (matcher.find()) result.add(matcher.group(1));
        return result;
    }
}
