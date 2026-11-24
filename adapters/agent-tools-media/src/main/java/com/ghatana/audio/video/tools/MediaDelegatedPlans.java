/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import tools.jackson.databind.JsonNode;

import java.time.Instant;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Maps each Media agent tool's declared intent to the closest launcher operation that exists on this host, and
 * refuses (typed, no dispatch) everything the launcher operation cannot honour truthfully.
 *
 * <table>
 *   <caption>tool to launcher operation</caption>
 *   <tr><td>av.speech-to-text</td><td>POST /dev/v1/speech/transcriptions (local Whisper; PROCESSING rights admission of the exact version)</td></tr>
 *   <tr><td>av.text-to-speech</td><td>POST /dev/v1/speech/syntheses (local Kokoro stock voice, WAV artifact)</td></tr>
 *   <tr><td>av.vision-analysis</td><td>POST /dev/v1/vision/analyses (local Florence-2: detect, ocr, caption)</td></tr>
 *   <tr><td>av.multimodal-inference</td><td>POST /dev/v1/vision/tracks (vision-only observation of a video: sampled-frame detection)</td></tr>
 * </table>
 *
 * @doc.type class
 * @doc.purpose tool-call to launcher-call planning and typed refusal
 * @doc.layer product
 * @doc.pattern Mapper
 */
final class MediaDelegatedPlans {

    /** The call is valid but outside what the delegated launcher operation can do: a typed NOT_ADMITTED refusal. */
    static final class NotAdmittedException extends RuntimeException {
        NotAdmittedException(String code) { super(code, null, false, false); }
    }

    private MediaDelegatedPlans() { }

    /** Plans the call for the envelope's tool, or null for a tool this delegate does not cover. */
    static MediaLauncherDelegate.Call plan(ToolExecutionEnvelope envelope, ToolContract contract) {
        return switch (envelope.toolId()) {
            case SpeechToTextToolHandler.TOOL_ID -> speechToText(envelope, contract);
            case TextToSpeechToolHandler.TOOL_ID -> textToSpeech(envelope, contract);
            case VisionAnalysisToolHandler.TOOL_ID -> vision(envelope, contract);
            case MultimodalInferenceToolHandler.TOOL_ID -> multimodal(envelope, contract);
            default -> null;
        };
    }

    /** Shared handler tail: plan, then execute or return the typed refusal. */
    static io.activej.promise.Promise<ToolExecutionResult> run(MediaLauncherDelegate delegate,
            com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal principal,
            ToolExecutionEnvelope envelope, ToolContract contract, Instant start, String inputInvalidCode,
            Set<String> knownValidationCodes) {
        final MediaLauncherDelegate.Call call;
        try {
            call = plan(envelope, contract);
        } catch (NotAdmittedException refused) {
            return io.activej.promise.Promise.of(MediaLauncherDelegate.notAdmitted(envelope, refused.getMessage(), start));
        } catch (RuntimeException invalid) {
            String message = invalid.getMessage();
            String code = message != null && (knownValidationCodes.contains(message) || message.startsWith("SOURCE_"))
                    ? message : inputInvalidCode;
            return io.activej.promise.Promise.of(MediaLauncherDelegate.invalid(envelope, code, start));
        }
        return delegate.execute(envelope, principal, call, start);
    }

    private static MediaLauncherDelegate.Call speechToText(ToolExecutionEnvelope envelope, ToolContract contract) {
        Map<String, Object> input = AgentToolInput.checked(envelope, contract, SpeechToTextToolHandler.TOOL_ID,
                Set.of("audioSource", "languageCode", "enableDiarization", "model", "sourceArtifactVersion"));
        String source = AgentToolInput.source(input, "audioSource", "audioBytes", 20 * 1024 * 1024, false);
        String language = AgentToolInput.languageTag(input.get("languageCode"), "en-US");
        if (!(input.getOrDefault("enableDiarization", Boolean.FALSE) instanceof Boolean diarization))
            throw new IllegalArgumentException("INVALID_ENABLE_DIARIZATION");
        if (!Set.of("default", "enhanced", "telephony").contains(input.getOrDefault("model", "default")))
            throw new IllegalArgumentException("INVALID_MODEL");
        String artifactId = AgentToolInput.sourceArtifactId(source);
        String version = AgentToolInput.sourceVersion(input);
        if (diarization) throw new NotAdmittedException("STT_DIARIZATION_NOT_ADMITTED");
        if (!"default".equals(input.getOrDefault("model", "default"))) throw new NotAdmittedException("STT_MODEL_TIER_NOT_ADMITTED");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("artifactId", artifactId);
        body.put("artifactVersionId", version);
        body.put("language", language.split("-", 2)[0].toLowerCase(java.util.Locale.ROOT));
        return new MediaLauncherDelegate.Call(MediaLauncherDelegate.Operation.SPEECH_TRANSCRIBE, artifactId, body,
                view -> {
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("transcript", view.path("text").asString(""));
                    out.put("languageDetected", body.get("language"));
                    out.put("cueCount", view.path("cueCount").asInt(0));
                    out.put("sourceArtifactId", artifactId);
                    out.put("sourceArtifactVersion", version);
                    out.put("transcriptArtifactId", view.path("transcript").path("artifact").path("artifactId").asString(""));
                    out.put("transcriptArtifactVersion", view.path("transcript").path("artifact").path("artifactVersionId").asString(""));
                    out.put("captionsArtifactId", view.path("captions").path("artifact").path("artifactId").asString(""));
                    return out;
                });
    }

    private static MediaLauncherDelegate.Call textToSpeech(ToolExecutionEnvelope envelope, ToolContract contract) {
        Map<String, Object> input = AgentToolInput.checked(envelope, contract, TextToSpeechToolHandler.TOOL_ID,
                Set.of("text", "voiceId", "speakingRate", "pitch", "audioEncoding", "storeAsArtifact",
                        "sourceArtifactId", "sourceArtifactVersion"));
        String text = AgentToolInput.requiredString(input, "text", 10_000);
        String voice = input.containsKey("voiceId") ? AgentToolInput.requiredString(input, "voiceId", 128) : "en-US-default";
        double rate = AgentToolInput.boundedRate(input.getOrDefault("speakingRate", 1.0));
        String encoding = input.containsKey("audioEncoding")
                ? AgentToolInput.requiredString(input, "audioEncoding", 16) : "MP3";
        if (!Set.of("MP3", "WAV", "OGG_OPUS", "LINEAR16").contains(encoding)) throw new IllegalArgumentException("INVALID_AUDIO_ENCODING");
        Object pitch = input.getOrDefault("pitch", 0.0);
        if (!(pitch instanceof Number pitchNumber) || !Double.isFinite(pitchNumber.doubleValue())
                || pitchNumber.doubleValue() < -20.0 || pitchNumber.doubleValue() > 20.0)
            throw new IllegalArgumentException("INVALID_PITCH");
        if (!(input.getOrDefault("storeAsArtifact", Boolean.FALSE) instanceof Boolean store))
            throw new IllegalArgumentException("INVALID_STORE_AS_ARTIFACT");
        // The launcher synthesizes a stock-voice WAV artifact: refuse what it cannot honour truthfully.
        if (!"WAV".equals(encoding)) throw new IllegalArgumentException("TTS_AUDIO_ENCODING_NOT_SUPPORTED");
        if (!store) throw new NotAdmittedException("TTS_STORE_AS_ARTIFACT_REQUIRED");
        if (pitchNumber.doubleValue() != 0.0) throw new NotAdmittedException("TTS_PITCH_NOT_ADMITTED");
        if (input.containsKey("sourceArtifactId") || input.containsKey("sourceArtifactVersion"))
            throw new NotAdmittedException("TTS_SOURCE_ARTIFACT_NOT_ADMITTED");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("text", text);
        if (!"en-US-default".equals(voice)) body.put("voice", voice);
        body.put("speakingRate", rate);
        return new MediaLauncherDelegate.Call(MediaLauncherDelegate.Operation.SPEECH_SYNTHESIZE, null, body,
                view -> {
                    Map<String, Object> out = new LinkedHashMap<>();
                    out.put("mediaArtifactId", view.path("artifact").path("artifactId").asString(""));
                    out.put("mediaArtifactVersion", view.path("artifact").path("artifactVersionId").asString(""));
                    out.put("audioEncoding", "WAV");
                    out.put("sizeBytes", view.path("artifact").path("sizeBytes").asLong(0));
                    out.put("sha256", view.path("artifact").path("sha256").asString(""));
                    return out;
                });
    }

    private static MediaLauncherDelegate.Call vision(ToolExecutionEnvelope envelope, ToolContract contract) {
        Map<String, Object> input = AgentToolInput.checked(envelope, contract, VisionAnalysisToolHandler.TOOL_ID,
                Set.of("mediaSource", "analysisTypes", "maxResults", "confidenceThreshold", "customModelId",
                        "sourceArtifactVersion"));
        Object rawSource = input.get("mediaSource");
        if (rawSource instanceof Map<?, ?> source && source.containsKey("imageBytes"))
            throw new IllegalArgumentException("INLINE_IMAGE_NOT_ADMITTED");
        String artifactId = AgentToolInput.sourceArtifactId(
                AgentToolInput.source(input, "mediaSource", "imageBytes", 20 * 1024 * 1024, true));
        Object rawTypes = input.getOrDefault("analysisTypes", List.of("OBJECT_DETECTION"));
        if (!(rawTypes instanceof List<?> types) || types.isEmpty() || types.size() > 8
                || types.stream().anyMatch(type -> !(type instanceof String s) || !Set.of("OBJECT_DETECTION",
                        "SCENE_CLASSIFICATION", "OCR", "FACE_DETECTION", "LABEL_DETECTION", "CUSTOM_MODEL").contains(s)))
            throw new IllegalArgumentException("INVALID_ANALYSIS_TYPES");
        int maxResults = AgentToolInput.boundedInt(input.getOrDefault("maxResults", 10));
        Object confidence = input.getOrDefault("confidenceThreshold", 0.5);
        if (!(confidence instanceof Number n) || !Double.isFinite(n.doubleValue()) || n.doubleValue() < 0 || n.doubleValue() > 1)
            throw new IllegalArgumentException("INVALID_CONFIDENCE_THRESHOLD");
        String version = AgentToolInput.sourceVersion(input);
        Set<String> tasks = new LinkedHashSet<>();
        for (Object type : types) {
            switch ((String) type) {
                case "OBJECT_DETECTION" -> tasks.add("detect");
                // MDI-001 makes Document Intelligence the only OCR executor/gateway.
                // Keep the agent tool fail-closed until it delegates through the DI public client.
                case "OCR" -> throw new NotAdmittedException("VISION_ANALYSIS_TYPE_NOT_ADMITTED");
                case "SCENE_CLASSIFICATION", "LABEL_DETECTION" -> tasks.add("caption");
                default -> throw new NotAdmittedException("VISION_ANALYSIS_TYPE_NOT_ADMITTED");
            }
        }
        if (input.containsKey("customModelId")) throw new NotAdmittedException("VISION_ANALYSIS_TYPE_NOT_ADMITTED");
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("artifactId", artifactId);
        body.put("artifactVersionId", version);
        body.put("tasks", new ArrayList<>(tasks));
        return new MediaLauncherDelegate.Call(MediaLauncherDelegate.Operation.VISION_ANALYZE, artifactId, body,
                view -> visionOutput(view, artifactId, version, "analysis"));
    }

    private static MediaLauncherDelegate.Call multimodal(ToolExecutionEnvelope envelope, ToolContract contract) {
        Map<String, Object> input = AgentToolInput.checked(envelope, contract, MultimodalInferenceToolHandler.TOOL_ID,
                Set.of("mediaArtifactId", "inferenceMode", "samplingRateMs", "enableTranscription",
                        "enableVisionAnalysis", "languageCode", "sourceArtifactVersion"));
        String artifactId = AgentToolInput.requiredString(input, "mediaArtifactId", 512);
        Object mode = input.getOrDefault("inferenceMode", "SUMMARY");
        if (!(mode instanceof String inferenceMode) || !Set.of("SUMMARY", "SEGMENT", "FRAME_BY_FRAME", "FULL").contains(inferenceMode))
            throw new IllegalArgumentException("INVALID_INFERENCE_MODE");
        Object sampling = input.getOrDefault("samplingRateMs", 1000);
        if (!(sampling instanceof Number rate) || rate.intValue() != rate.doubleValue() || rate.intValue() < 100 || rate.intValue() > 60_000)
            throw new IllegalArgumentException("INVALID_SAMPLING_RATE");
        AgentToolInput.languageTag(input.get("languageCode"), "en-US");
        boolean transcription = flag(input, "enableTranscription", true);
        boolean vision = flag(input, "enableVisionAnalysis", true);
        if (!transcription && !vision) throw new IllegalArgumentException("NO_MODALITY_SELECTED");
        String version = AgentToolInput.sourceVersion(input);
        // Cross-modal fusion (transcript + frames) has no CPU launcher operation: only the vision-only observation of
        // a video is delegated; a transcription child stays NOT_ADMITTED.
        if (transcription) throw new NotAdmittedException("MULTIMODAL_TRANSCRIPTION_NOT_ADMITTED");
        int maxFrames = "FRAME_BY_FRAME".equals(inferenceMode) || "FULL".equals(inferenceMode) ? 4 : 2;
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("artifactId", artifactId);
        body.put("artifactVersionId", version);
        body.put("maxFrames", maxFrames);
        return new MediaLauncherDelegate.Call(MediaLauncherDelegate.Operation.VISION_TRACK, artifactId, body,
                view -> {
                    Map<String, Object> out = visionOutput(view, artifactId, version, "observation");
                    out.put("maxFrames", maxFrames);
                    out.put("samplingRateMsHonored", false);
                    return out;
                });
    }

    private static Map<String, Object> visionOutput(JsonNode view, String artifactId, String version, String role) {
        Map<String, Object> out = new LinkedHashMap<>();
        out.put("resultArtifactId", view.path("artifact").path("artifactId").asString(""));
        out.put("resultArtifactVersion", view.path("artifact").path("artifactVersionId").asString(""));
        out.put("resultSha256", view.path("artifact").path("sha256").asString(""));
        out.put("resultRole", role);
        out.put("sourceArtifactId", artifactId);
        out.put("sourceArtifactVersion", version);
        return out;
    }

    private static boolean flag(Map<String, Object> input, String key, boolean fallback) {
        Object value = input.get(key);
        if (value == null) return fallback;
        if (!(value instanceof Boolean bool)) throw new IllegalArgumentException("INVALID_" + key.toUpperCase());
        return bool;
    }
}
