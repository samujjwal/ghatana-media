package com.ghatana.media.launcher;

import com.ghatana.agent.framework.tools.ToolActionClass;
import com.ghatana.agent.framework.tools.ToolContract;
import com.ghatana.agent.framework.tools.ToolExecutionEnvelope;
import com.ghatana.agent.framework.tools.ToolExecutionResult;
import com.ghatana.agent.framework.tools.ToolExecutionStatus;
import com.ghatana.agent.framework.tools.ToolTransport;
import com.ghatana.audio.video.tools.AudioVideoToolHandlerFactory;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.ClaimResult;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.InvocationLedger;
import com.ghatana.audio.video.tools.MediaToolExecutionBinder.LogicalAction;
import com.ghatana.audio.video.tools.MediaToolJobBridge;
import com.ghatana.audio.video.tools.RuntimeMediaJobSubmissionPort;
import com.ghatana.audio.video.vision.local.LocalModelAdmission;
import com.ghatana.audio.video.vision.local.LocalOpenModelVisionProvider;
import com.ghatana.audio.video.vision.local.LocalVisionEngine;
import com.ghatana.audio.video.vision.local.LocalVisionRightsAuthority;
import com.ghatana.audio.video.vision.local.LocalVisionSidecarProcess;
import com.ghatana.media.runtime.MediaRuntimeContracts.JobStatus;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaProcessingProvider;
import com.ghatana.media.runtime.MediaRuntimeContracts.UploadRequest;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts;
import com.ghatana.media.runtime.MediaSourceAuthorizationContracts.AuthenticatedPrincipal;
import com.ghatana.tools.testing.EventloopTestBase;
import org.junit.jupiter.api.AfterAll;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;

import javax.imageio.ImageIO;
import java.awt.Color;
import java.awt.Font;
import java.awt.Graphics2D;
import java.awt.image.BufferedImage;
import java.io.ByteArrayOutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Arrays;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.junit.jupiter.api.Assumptions.assumeTrue;

/**
 * The agent vision tool produces a real outcome: tool call -> MediaToolJobBridge -> canonical VISION job (with the
 * runtime's source-authorization authority, here a clearly named FIXTURE authority) -> the local Florence-2
 * provider -> COMPLETED job whose result is bound to the exact source version. Runs the real model on this machine;
 * skipped with an explicit reason only when the runtime or model is absent.
 */
final class MediaToolLocalVisionJourneyTest extends EventloopTestBase {
    private static final String TENANT = "tenant-vision";
    private static final String AGENT = "agent-vision";

    private static LocalVisionSidecarProcess sidecar;
    private static LocalVisionEngine engine;
    private static String skipReason;

    @BeforeAll
    static void start() throws Exception {
        Path home = Path.of(System.getProperty("user.home"));
        Path models = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_MODELS_ROOT",
                home.resolve(".local/share/ghatana-media/models").toString()));
        Path python = Path.of(System.getenv().getOrDefault("MEDIA_LOCAL_VISION_PYTHON",
                home.resolve(".local/share/ghatana-media/runtimes/vision-venv/bin/python").toString()));
        Path script = null;
        for (Path dir = Path.of("").toAbsolutePath(); dir != null && script == null; dir = dir.getParent()) {
            Path candidate = dir.resolve("tools/model-runtimes/vision/vision_sidecar.py");
            if (Files.isRegularFile(candidate)) script = candidate;
        }
        if (script == null) skipReason = "vision_sidecar.py not found";
        else if (!Files.isExecutable(python)) skipReason = "sidecar python runtime absent: " + python;
        else if (!Files.isRegularFile(models.resolve("florence-2-large/ghatana-model-manifest.json"))) {
            skipReason = "Florence-2 manifest absent under " + models;
        }
        if (skipReason != null) return;
        sidecar = LocalVisionSidecarProcess.start(python, script, models, Duration.ofSeconds(90));
        engine = new LocalVisionEngine(sidecar.client(Duration.ofMinutes(8)),
                new LocalModelAdmission(models.resolve("florence-2-large"), LocalVisionEngine.FLORENCE_MODEL_ID,
                        "VISION", "MIT"),
                new LocalModelAdmission(models.resolve("qwen2.5-vl-7b-instruct"), LocalVisionEngine.QWEN_MODEL_ID,
                        "MULTIMODAL_QA", "Apache-2.0"),
                LocalVisionRightsAuthority.unavailable());
    }

    @AfterAll
    static void stop() {
        if (sidecar != null) sidecar.close();
    }

    @Test
    void visionToolCallRunsFlorenceThroughACanonicalJobBoundToTheExactVersion() throws Exception {
        assumeTrue(skipReason == null, () -> "SKIPPED: " + skipReason);
        Path root = Files.createTempDirectory("media-tool-vision-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        MediaRuntime runtime = runtime(root, jobStore, List.of(new LocalOpenModelVisionProvider(engine, null)),
                fixtureAuthority());
        try {
            byte[] png = image();
            MediaArtifact source = upload(runtime, png);
            var bridge = new MediaToolJobBridge(new RuntimeMediaJobSubmissionPort(runtime), "dev");
            var ledger = new Ledger();
            var binder = new MediaToolExecutionBinder(ledger, bridge.readback(),
                    (p, id) -> p.tenantId().equals(id.tenantId()) && p.principalId().equals(id.callerAgentId()));
            var factory = new AudioVideoToolHandlerFactory(binder, bridge);
            var envelope = ToolExecutionEnvelope.of("av.vision-analysis", "1.0.0", AGENT, null, TENANT,
                    ToolActionClass.CALL_EXTERNAL, "1.0", Map.of(
                            "mediaSource", Map.of("mediaArtifactId", source.artifactId()),
                            "analysisTypes", List.of("OCR", "SCENE_CLASSIFICATION", "OBJECT_DETECTION"),
                            "sourceArtifactVersion", source.version().value()));
            var contract = new ToolContract(envelope.toolId(), envelope.toolVersion(), "test", "test",
                    envelope.actionClass(), false, true, Map.of(), Map.of(), Set.of(), ToolTransport.IN_PROCESS, null,
                    Map.of());
            ToolExecutionResult result = runPromise(() -> factory.createAuthenticated("av.vision-analysis")
                    .handle(envelope, contract, new AuthenticatedPrincipal(TENANT, AGENT, Instant.now())));
            // The job runs asynchronously: the tool truthfully reports the accepted job, never invented content.
            assertThat(result.status()).isIn(ToolExecutionStatus.OUTCOME_UNKNOWN, ToolExecutionStatus.SUCCESS);

            String requestId = MediaToolJobBridge.requestIdFor(envelope.invocationId());
            var job = awaitTerminal(jobStore, requestId);
            System.out.println("AGENT-TOOL-VISION-JOB status=" + job.status() + " provider=" + job.providerId()
                    + " result=" + job.result());
            assertThat(job.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(job.providerId()).isEqualTo(LocalOpenModelVisionProvider.PROVIDER_ID);
            assertThat(job.expectedArtifactVersion()).isEqualTo(source.version().value());
            assertThat(job.result()).containsEntry("sourceArtifactSha256", source.sha256());
            @SuppressWarnings("unchecked") var analysis = (Map<String, Object>) job.result().get("analysis");
            @SuppressWarnings("unchecked") var results = (Map<String, Object>) analysis.get("results");
            @SuppressWarnings("unchecked") var sceneText = (Map<String, Object>) results.get("sceneText");
            assertThat(((String) sceneText.get("fullText")).toUpperCase()).contains("GHATANA");
            assertThat(results).containsKeys("caption", "objects");
        } finally {
            runtime.close();
        }
    }

    @Test
    void multimodalToolVisionOnlyObservationRunsAsAParentWithACanonicalVisionChild() throws Exception {
        assumeTrue(skipReason == null, () -> "SKIPPED: " + skipReason);
        Path root = Files.createTempDirectory("media-tool-mm-");
        var jobStore = new LocalMediaRuntimeSupport.JobStore();
        MediaRuntime runtime = runtime(root, jobStore, List.of(new LocalOpenModelVisionProvider(engine, null),
                new com.ghatana.audio.video.multimodal.engine.DelegatingMultimodalProvider()), fixtureAuthority());
        try {
            MediaArtifact source = upload(runtime, image());
            var bridge = new MediaToolJobBridge(new RuntimeMediaJobSubmissionPort(runtime), "dev");
            var binder = new MediaToolExecutionBinder(new Ledger(), bridge.readback(),
                    (p, id) -> p.tenantId().equals(id.tenantId()) && p.principalId().equals(id.callerAgentId()));
            var factory = new AudioVideoToolHandlerFactory(binder, bridge);
            var envelope = ToolExecutionEnvelope.of("av.multimodal-inference", "1.0.0", AGENT, null, TENANT,
                    ToolActionClass.CALL_EXTERNAL, "1.0", Map.of("mediaArtifactId", source.artifactId(),
                            "enableTranscription", false, "enableVisionAnalysis", true,
                            "sourceArtifactVersion", source.version().value()));
            var contract = new ToolContract(envelope.toolId(), envelope.toolVersion(), "test", "test",
                    envelope.actionClass(), false, true, Map.of(), Map.of(), Set.of(), ToolTransport.IN_PROCESS, null,
                    Map.of());
            ToolExecutionResult result = runPromise(() -> factory.createAuthenticated("av.multimodal-inference")
                    .handle(envelope, contract, new AuthenticatedPrincipal(TENANT, AGENT, Instant.now())));
            assertThat(result.status()).as(String.valueOf(result.failure()))
                    .isIn(ToolExecutionStatus.OUTCOME_UNKNOWN, ToolExecutionStatus.SUCCESS);
            String requestId = MediaToolJobBridge.requestIdFor(envelope.invocationId());
            var parent = awaitTerminal(jobStore, requestId);
            System.out.println("AGENT-TOOL-MULTIMODAL-JOB status=" + parent.status() + " result=" + parent.result());
            assertThat(parent.status()).isEqualTo(JobStatus.COMPLETED);
            var child = jobStore.findByRequest(TENANT, requestId + ":vision").orElseThrow();
            assertThat(child.jobType()).isEqualTo(com.ghatana.media.runtime.MediaRuntimeContracts.JobType.VISION);
            assertThat(child.status()).isEqualTo(JobStatus.COMPLETED);
            assertThat(child.providerId()).isEqualTo(LocalOpenModelVisionProvider.PROVIDER_ID);
            assertThat(child.expectedArtifactVersion()).isEqualTo(source.version().value());
            assertThat(child.result().toString().toUpperCase()).contains("GHATANA");
        } finally {
            runtime.close();
        }
    }

    @Test
    void withoutTheLocalProviderTheSameToolCallIsTypedNotAdmittedAndNothingRuns() throws Exception {
        Path root = Files.createTempDirectory("media-tool-vision-none-");
        MediaRuntime runtime = runtime(root, new LocalMediaRuntimeSupport.JobStore(), List.of(), fixtureAuthority());
        try {
            MediaArtifact source = upload(runtime, image());
            var bridge = new MediaToolJobBridge(new RuntimeMediaJobSubmissionPort(runtime), "dev");
            var binder = new MediaToolExecutionBinder(new Ledger(), bridge.readback(),
                    (p, id) -> p.tenantId().equals(id.tenantId()) && p.principalId().equals(id.callerAgentId()));
            var factory = new AudioVideoToolHandlerFactory(binder, bridge);
            var envelope = ToolExecutionEnvelope.of("av.vision-analysis", "1.0.0", AGENT, null, TENANT,
                    ToolActionClass.CALL_EXTERNAL, "1.0", Map.of(
                            "mediaSource", Map.of("mediaArtifactId", source.artifactId()),
                            "analysisTypes", List.of("OCR"), "sourceArtifactVersion", source.version().value()));
            var contract = new ToolContract(envelope.toolId(), envelope.toolVersion(), "test", "test",
                    envelope.actionClass(), false, true, Map.of(), Map.of(), Set.of(), ToolTransport.IN_PROCESS, null,
                    Map.of());
            ToolExecutionResult result = runPromise(() -> factory.createAuthenticated("av.vision-analysis")
                    .handle(envelope, contract, new AuthenticatedPrincipal(TENANT, AGENT, Instant.now())));
            assertThat(result.status()).isEqualTo(ToolExecutionStatus.FAILED);
            assertThat(result.failure().code()).isEqualTo("MEDIA_NOT_ADMITTED");
        } finally {
            runtime.close();
        }
    }

    // ---- helpers ----

    private static com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingJob awaitTerminal(
            LocalMediaRuntimeSupport.JobStore store, String requestId) throws InterruptedException {
        for (int i = 0; i < 4000; i++) {
            var job = store.findByRequest(TENANT, requestId);
            if (job.isPresent() && Set.of(JobStatus.COMPLETED, JobStatus.FAILED, JobStatus.CANCELLED,
                    JobStatus.OUTCOME_UNKNOWN).contains(job.orElseThrow().status())) {
                return job.orElseThrow();
            }
            Thread.sleep(50);
        }
        throw new AssertionError("job did not reach a terminal state");
    }

    private static byte[] image() throws Exception {
        BufferedImage image = new BufferedImage(640, 480, BufferedImage.TYPE_INT_RGB);
        Graphics2D g = image.createGraphics();
        try {
            g.setColor(Color.WHITE);
            g.fillRect(0, 0, 640, 480);
            g.setColor(new Color(220, 30, 30));
            g.fillRect(40, 160, 240, 240);
            g.setColor(new Color(30, 60, 220));
            g.fillOval(340, 180, 240, 240);
            g.setColor(Color.BLACK);
            g.setFont(new Font(Font.SANS_SERIF, Font.BOLD, 56));
            g.drawString("HELLO GHATANA", 60, 95);
        } finally {
            g.dispose();
        }
        ByteArrayOutputStream out = new ByteArrayOutputStream();
        ImageIO.write(image, "png", out);
        return out.toByteArray();
    }

    private static MediaArtifact upload(MediaRuntime runtime, byte[] bytes) throws Exception {
        String digest = HexFormat.of().formatHex(java.security.MessageDigest.getInstance("SHA-256").digest(bytes));
        var session = runtime.beginUpload(new UploadRequest(TENANT, AGENT, "scene.png", "image/png", bytes.length,
                digest, "INTERNAL", Duration.ofMinutes(30), Map.of()), "key-scene-" + digest);
        int chunk = runtime.config().maximumChunkBytes();
        for (int offset = 0, index = 0; offset < bytes.length; offset += chunk, index++) {
            runtime.appendChunk(TENANT, AGENT, session.uploadId(), index,
                    Arrays.copyOfRange(bytes, offset, Math.min(bytes.length, offset + chunk)));
        }
        return runtime.completeUpload(TENANT, AGENT, session.uploadId());
    }

    private static MediaRuntime runtime(Path root, LocalMediaRuntimeSupport.JobStore jobStore,
                                        List<MediaProcessingProvider> providers,
                                        MediaSourceAuthorizationContracts.Authority authority) {
        // A TRANSCODE-only provider keeps the runtime composable when no vision provider is configured.
        List<MediaProcessingProvider> all = new java.util.ArrayList<>(providers);
        all.add(new TranscodeOnlyProvider());
        return new MediaRuntime(
                new MediaRuntimeConfig(true, "local", 8093, 1_048_576, 262_144, 1_048_576,
                        Duration.ofMinutes(5), 8, "", "", false, false, root),
                new LocalMediaRuntimeSupport.FileArtifactStore(root), jobStore,
                new LocalMediaRuntimeSupport.StreamStore(), null,
                MediaSemanticRedactionRuntime.disabled(Duration.ofSeconds(10)), MediaLifecyclePublisher.disabled(),
                all, List.of(new LocalMediaRuntimeSupport.DiagnosticStreamingProvider()),
                List.of(), authority, noTranscripts(), Clock.systemUTC());
    }

    private static com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore noTranscripts() {
        return new com.ghatana.media.runtime.MediaTranscriptContracts.MediaTranscriptStore() {
            @Override public com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision append(
                    com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptDraft draft) {
                throw new UnsupportedOperationException("vision journey writes no transcripts");
            }
            @Override public List<com.ghatana.media.runtime.MediaTranscriptContracts.TranscriptRevision> revisions(
                    String tenantId, String transcriptId) { return List.of(); }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public void close() { }
        };
    }

    /** FIXTURE_ONLY source-rights authority: allows the exact owner's source; never production eligible. */
    private static MediaSourceAuthorizationContracts.Authority fixtureAuthority() {
        return new MediaSourceAuthorizationContracts.Authority() {
            @Override public String authorityId() { return "fixture-only-vision-authority"; }
            @Override public boolean ready() { return true; }
            @Override public boolean productionEligible() { return false; }
            @Override public MediaSourceAuthorizationContracts.Decision resolve(
                    MediaSourceAuthorizationContracts.Request request, AuthenticatedPrincipal authenticated) {
                if (!authenticated.tenantId().equals(request.tenantId())
                        || !authenticated.principalId().equals(request.principalId())) {
                    return new MediaSourceAuthorizationContracts.Decision(
                            MediaSourceAuthorizationContracts.Status.DENIED, null);
                }
                Instant now = Instant.now();
                var evidence = new MediaSourceAuthorizationContracts.Evidence(
                        authorityId(), "decision-" + request.artifactId(), request.tenantId(), request.principalId(),
                        "fixture-owner", request.artifactId(), request.sourceVersion(), request.sourceSha256(),
                        request.operation(), request.purpose(), request.providerId(), request.providerVersion(),
                        request.processingBoundary(), request.processingRegion(), request.providerRetention(),
                        Set.of(request.operation().toLowerCase(java.util.Locale.ROOT)),
                        Set.of(request.processingRegion()), Set.of(request.providerRetention()),
                        "rights-1", "policy-1", "policy-v1",
                        MediaSourceAuthorizationContracts.SourceKind.ORIGINAL_NONHUMAN,
                        MediaSourceAuthorizationContracts.HumanConsentDisposition.NOT_APPLICABLE_HUMAN_CONSENT,
                        "", "fixture-clock", 0, now.minusSeconds(1), now.plusSeconds(600));
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.ALLOWED, evidence);
            }
            @Override public MediaSourceAuthorizationContracts.Decision revalidate(
                    MediaSourceAuthorizationContracts.Request request,
                    MediaSourceAuthorizationContracts.Evidence expectedEvidence, AuthenticatedPrincipal authenticated) {
                return new MediaSourceAuthorizationContracts.Decision(
                        MediaSourceAuthorizationContracts.Status.ALLOWED, expectedEvidence);
            }
        };
    }

    private static final class TranscodeOnlyProvider implements MediaProcessingProvider {
        @Override public String providerId() { return "fixture-only-transcode"; }
        @Override public Set<com.ghatana.media.runtime.MediaRuntimeContracts.JobType> capabilities() {
            return Set.of(com.ghatana.media.runtime.MediaRuntimeContracts.JobType.TRANSCODE);
        }
        @Override public boolean ready() { return true; }
        @Override public boolean productionEligible() { return false; }
        @Override public int priority() { return 0; }
        @Override public com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary processingBoundary() {
            return com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingBoundary.LOCAL;
        }
        @Override public java.util.concurrent.CompletableFuture<Map<String, Object>> process(
                com.ghatana.media.runtime.MediaRuntimeContracts.ProcessingContext context) {
            return java.util.concurrent.CompletableFuture.failedFuture(new AssertionError("must not run"));
        }
    }

    private static final class Ledger implements InvocationLedger {
        private final Map<String, LogicalAction> actions = new HashMap<>();
        @Override public synchronized Optional<LogicalAction> find(String id) { return Optional.ofNullable(actions.get(id)); }
        @Override public synchronized void record(LogicalAction action) { actions.put(action.invocationId(), action); }
        @Override public synchronized ClaimResult claim(LogicalAction fence) {
            return actions.putIfAbsent(fence.invocationId(), fence) == null ? ClaimResult.CLAIMED : ClaimResult.ALREADY_CLAIMED;
        }
        @Override public synchronized boolean complete(LogicalAction terminal) {
            actions.put(terminal.invocationId(), terminal);
            return true;
        }
    }
}
