/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import com.ghatana.toolruntime.ToolHandler;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import io.activej.promise.Promise;

import java.util.Map;
import java.util.Objects;

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

    /** Host entry point that carries the authenticated principal per invocation. */
    @FunctionalInterface
    public interface AuthenticatedToolHandler {
        Promise<ToolExecutionResult> handle(
                ToolExecutionEnvelope envelope, ToolContract contract, AuthenticatedPrincipal authenticated);
    }

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

    /** Optional execution fence supplied by the owning Tools/Action Plane integration. */
    private final MediaToolExecutionBinder executionBinder;
    /** Optional canonical Media job bridge; absent means every tool stays typed NOT_ADMITTED. */
    private final MediaToolJobBridge jobBridge;

    /**
     * Creates local fail-closed handlers without an Action Plane ledger. This
     * compatibility path is useful for handler validation and source-free
     * consumers; it does not provide invocation replay or effect authority.
     */
    public AudioVideoToolHandlerFactory() {
        this.executionBinder = null;
        this.jobBridge = null;
    }

    /**
     * Creates handlers that pass each envelope through the supplied durable
     * invocation binder before invoking the adapter. The binder's ledger is
     * expected to be the owner-provided Action Plane implementation; this
     * constructor does not authenticate the envelope or create that ledger.
     */
    public AudioVideoToolHandlerFactory(MediaToolExecutionBinder executionBinder) {
        this.executionBinder = Objects.requireNonNull(executionBinder, "executionBinder");
        this.jobBridge = null;
    }

    /**
     * Creates handlers that, after the binder's durable claim, submit each tool call as exactly
     * one canonical Media job through the bridge. Provider admission stays the runtime's decision.
     */
    public AudioVideoToolHandlerFactory(MediaToolExecutionBinder executionBinder, MediaToolJobBridge jobBridge) {
        this.executionBinder = Objects.requireNonNull(executionBinder, "executionBinder");
        this.jobBridge = Objects.requireNonNull(jobBridge, "jobBridge");
    }

    /**
     * Creates a new {@link ToolHandler} for the given {@code toolId}.
     *
     * @param toolId the canonical tool identifier (e.g. {@code "av.speech-to-text"})
     * @return a new handler instance
     * @throws IllegalArgumentException if the toolId is not recognized
     */
    public ToolHandler create(String toolId) {
        ToolHandler handler = createDelegate(toolId, null);
        if (executionBinder == null) return handler;
        return (envelope, contract) -> executionBinder.execute(handler, envelope, contract);
    }

    /**
     * Creates a host-facing handler whose authenticated principal is supplied for each call.
     * This avoids caching credentials in a reusable ToolHandler and lets the binder validate
     * the principal-to-actor mapping before claim or dispatch. A binder must be configured;
     * this method never falls back to a direct modality handler.
     */
    public AuthenticatedToolHandler createAuthenticated(String toolId) {
        if (executionBinder == null) {
            throw new IllegalStateException("authenticated Media tool execution requires an invocation binder");
        }
        createDelegate(toolId, null); // reject unknown tool ids eagerly
        return (envelope, contract, authenticated) -> executionBinder.execute(
                createDelegate(toolId, authenticated), envelope, contract, authenticated);
    }

    private ToolHandler createDelegate(String toolId, AuthenticatedPrincipal principal) {
        if (jobBridge != null && HANDLER_REGISTRY.containsKey(toolId)) {
            return switch (toolId) {
                case TOOL_ID_STT       -> new SpeechToTextToolHandler(jobBridge, principal);
                case TOOL_ID_TTS       -> new TextToSpeechToolHandler(jobBridge, principal);
                case TOOL_ID_VISION    -> new VisionAnalysisToolHandler(jobBridge, principal);
                default                -> new MultimodalInferenceToolHandler(jobBridge, principal);
            };
        }
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
