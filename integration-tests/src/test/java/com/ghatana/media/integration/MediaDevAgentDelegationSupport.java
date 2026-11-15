package com.ghatana.media.integration;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.audio.video.tools.AudioVideoToolHandlerFactory;
import com.ghatana.audio.video.tools.FileInvocationLedger;
import com.ghatana.audio.video.tools.MediaLauncherDelegate;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder;
import com.ghatana.audio.video.tools.MediaDelegationGrantStore;

import javax.crypto.spec.SecretKeySpec;
import java.net.URI;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

/**
 * Shared composition of the J-25 agent-tool host (grant store, durable invocation ledger, delegate, binder, factory)
 * used by both the real-launcher IT and its killable child process, so the parent and the child build byte-identical
 * envelopes and the same replay identity.
 */
final class MediaDevAgentDelegationSupport {
    static final String STT = "av.speech-to-text";
    static final String TTS = "av.text-to-speech";
    static final String VISION = "av.vision-analysis";
    static final String MULTIMODAL = "av.multimodal-inference";
    static final String TTS_TEXT = "The quick brown fox jumps over the lazy dog.";

    private MediaDevAgentDelegationSupport() { }

    /** TEST-ONLY key fixture; a real host injects a protected key. */
    static FileInvocationLedger ledger(Path directory) {
        return new FileInvocationLedger(directory, new SecretKeySpec(new byte[32], "AES"), Duration.ofDays(1),
                Clock.systemUTC());
    }

    static MediaLauncherDelegate delegate(URI base, MediaDelegationGrantStore grants,
            MediaLauncherDelegate.CredentialSource credentials) {
        return new MediaLauncherDelegate(base, grants, credentials, Clock.systemUTC(), Duration.ofMinutes(10));
    }

    static MediaToolExecutionBinder binder(MediaToolExecutionBinder.InvocationLedger ledger,
            MediaLauncherDelegate delegate) {
        return new MediaToolExecutionBinder(ledger, (tenant, invocation) -> Optional.empty(),
                delegate.replayAuthorizer(), delegate.reconciler());
    }

    static AudioVideoToolHandlerFactory factory(MediaToolExecutionBinder binder, MediaLauncherDelegate delegate) {
        return new AudioVideoToolHandlerFactory(binder, delegate);
    }

    /** Deterministic envelope: the same arguments always produce the same request identity. */
    static ToolExecutionEnvelope envelope(String toolId, String invocationId, String tenant, String agent,
            String artifactId, String version) {
        Map<String, Object> input = switch (toolId) {
            case STT -> Map.of("audioSource", Map.of("mediaArtifactId", artifactId), "languageCode", "en-US",
                    "sourceArtifactVersion", version);
            case TTS -> Map.of("text", TTS_TEXT, "voiceId", "af_heart", "audioEncoding", "WAV",
                    "storeAsArtifact", true, "speakingRate", 1.0);
            case VISION -> Map.of("mediaSource", Map.of("mediaArtifactId", artifactId),
                    "analysisTypes", List.of("OBJECT_DETECTION"), "sourceArtifactVersion", version);
            case MULTIMODAL -> Map.of("mediaArtifactId", artifactId, "inferenceMode", "SUMMARY",
                    "enableTranscription", false, "enableVisionAnalysis", true, "sourceArtifactVersion", version);
            default -> throw new IllegalArgumentException(toolId);
        };
        return new ToolExecutionEnvelope(invocationId, toolId, "1.0.0", agent, null, tenant,
                ToolActionClass.CALL_EXTERNAL, "1.0", input, Instant.parse("2026-11-15T00:00:00Z"));
    }

    /** Lenient schemas: the tool handlers and the launcher perform the real validation. */
    static ToolContract contract(ToolExecutionEnvelope envelope) {
        return new ToolContract(envelope.toolId(), envelope.toolVersion(), "J-25", "J-25 delegation IT",
                envelope.actionClass(), false, true, Map.of(), Map.of(), Set.of(), ToolTransport.IN_PROCESS, null,
                Map.of());
    }
}
