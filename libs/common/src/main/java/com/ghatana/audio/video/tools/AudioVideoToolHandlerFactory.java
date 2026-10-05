/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.toolruntime.ToolHandler;

import java.util.Map;

/**
 * Factory that produces all Audio-Video {@link ToolHandler} instances keyed by
 * their canonical {@code toolId} as declared in the capability YAML descriptors.
 *
 * <p>Each handler is stateless and can be shared across threads. The factory
 * creates fresh instances on each call to {@link #create(String)} to support
 * dependency injection frameworks that prefer per-request handler lifecycle.
 *
 * <p>Usage:
 * <pre>{@code
 * AudioVideoToolHandlerFactory factory = new AudioVideoToolHandlerFactory();
 * ToolHandler sttHandler = factory.create("av.speech-to-text");
 * }</pre>
 *
 * @doc.type class
 * @doc.purpose Factory for Audio-Video ToolHandler instances
 * @doc.layer product
 * @doc.pattern Factory Method
 */
public final class AudioVideoToolHandlerFactory {

    /** Canonical tool IDs exposed by the Audio-Video capability registry. */
    public static final String TOOL_ID_STT = SpeechToTextToolHandler.TOOL_ID;
    public static final String TOOL_ID_TTS = TextToSpeechToolHandler.TOOL_ID;
    public static final String TOOL_ID_VISION = VisionAnalysisToolHandler.TOOL_ID;
    public static final String TOOL_ID_MULTIMODAL = MultimodalInferenceToolHandler.TOOL_ID;

    private static final Map<String, Class<? extends ToolHandler>> HANDLER_REGISTRY = Map.of(
            TOOL_ID_STT,       SpeechToTextToolHandler.class,
            TOOL_ID_TTS,       TextToSpeechToolHandler.class,
            TOOL_ID_VISION,    VisionAnalysisToolHandler.class,
            TOOL_ID_MULTIMODAL, MultimodalInferenceToolHandler.class
    );

    /**
     * Creates a new {@link ToolHandler} for the given {@code toolId}.
     *
     * @param toolId the canonical tool identifier (e.g. {@code "av.speech-to-text"})
     * @return a new handler instance
     * @throws IllegalArgumentException if the toolId is not recognized
     */
    public ToolHandler create(String toolId) {
        return switch (toolId) {
            case TOOL_ID_STT       -> new SpeechToTextToolHandler();
            case TOOL_ID_TTS       -> new TextToSpeechToolHandler();
            case TOOL_ID_VISION    -> new VisionAnalysisToolHandler();
            case TOOL_ID_MULTIMODAL -> new MultimodalInferenceToolHandler();
            default -> throw new IllegalArgumentException(
                    "Unknown Audio-Video tool ID: '" + toolId + "'. Known IDs: " + HANDLER_REGISTRY.keySet());
        };
    }

    /**
     * Returns all canonical tool IDs registered by this factory.
     *
     * @return immutable set of tool IDs
     */
    public java.util.Set<String> toolIds() {
        return HANDLER_REGISTRY.keySet();
    }
}
