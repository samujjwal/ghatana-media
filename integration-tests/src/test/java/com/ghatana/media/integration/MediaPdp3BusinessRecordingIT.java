package com.ghatana.media.integration;

import com.ghatana.media.launcher.MediaProductionRunCoordinator;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.ClaimResult;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.OriginClass;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.ProductionStep;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.StepOutcome;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.StepRecord;
import com.ghatana.media.runtime.MediaProductionSpecCompiler;
import com.ghatana.media.runtime.MediaProductionSpecCompiler.CompiledPlan;
import com.ghatana.media.runtime.MediaProductionSpecCompiler.ExecutionMode;
import com.ghatana.media.runtime.MediaProductionSpecCompiler.ProductionSpec;
import org.junit.jupiter.api.Tag;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * H-08 synthetic planning and coordinator fixtures for the PDP-3 J03 scenario.
 * The fixture ledger and bytes do not establish product capture, durable
 * execution, rights approval, or a terminal artifact. The coordinator does
 * not enforce DAG dependencies; a skipped manual gate cannot release capture.
 */
@Tag("integration")
class MediaPdp3BusinessRecordingIT {

    /** The scenario's declared ordered scene ids (s01..s07). */
    private static final List<String> J03_SCENES =
            List.of("s01", "s02", "s03", "s04", "s05", "s06", "s07");

    private static final class InMemoryLedger
            implements MediaProductionRunCoordinator.StepLedger {
        private final Map<String, StepRecord> records = new HashMap<>();
        @Override public Optional<StepRecord> find(String runId, String stepId) {
            return Optional.ofNullable(records.get(runId + "/" + stepId));
        }
        @Override public synchronized void record(String runId, StepRecord record) {
            records.put(runId + "/" + record.stepId(), record);
        }
        @Override public synchronized ClaimResult claim(String runId, StepRecord fence) {
            String key = runId + "/" + fence.stepId();
            if (records.containsKey(key)) return ClaimResult.ALREADY_CLAIMED;
            records.put(key, fence);
            return ClaimResult.CLAIMED;
        }
    }

    private static ProductionSpec j03Spec() {
        return new ProductionSpec(
                "tenant-demo",
                "media.demo.j03",
                "media.demo.j03.corrected-captions.v1",
                "PDP_SYNTHETIC_FIXTURE",
                "purpose/demo-recording/v1",
                J03_SCENES.stream().map(s -> "scene/" + s + "@curated-v1").toList(),
                "timeline/j03@v1",
                "rights/internal-demo-evidence/v1",
                List.of("profile/1080p@v4"));
    }

    /** Deterministic synthetic frame bytes — curated fixture data, not real capture. */
    private static byte[] curatedBytes(String stepId) {
        return ("curated-synthetic:" + stepId).getBytes(StandardCharsets.UTF_8);
    }

    @Test
    void j03PlanRequiresRightsReviewBeforeCaptureAndGateSkipIsNotApproval() {
        var compiler = new MediaProductionSpecCompiler();
        CompiledPlan plan = compiler.compile(j03Spec());
        assertThat(plan.projectRevision()).isEqualTo("media.demo.j03.corrected-captions.v1");
        assertThat(plan.originClass()).isEqualTo("PDP_SYNTHETIC_FIXTURE");
        assertThat(compiler.compile(j03Spec()).planFingerprint()).isEqualTo(plan.planFingerprint());
        assertThat(plan.nodes()).hasSize(7 + 5);
        var rightsGate = plan.nodes().stream().filter(n -> n.stepId().equals("rights-review"))
                .findFirst().orElseThrow();
        assertThat(rightsGate.mode()).isEqualTo(ExecutionMode.MANUAL_GATE);
        assertThat(plan.nodes().stream().filter(n -> n.stepId().startsWith("capture-source-")))
                .hasSize(7)
                .allSatisfy(node -> assertThat(node.dependsOn()).containsExactly("rights-review"));

        var coordinator = new MediaProductionRunCoordinator(new InMemoryLedger());
        var gate = new ProductionStep("rights-review", OriginClass.REAL_CAPTURE,
                "rights/internal-demo-evidence/v1", "rights/internal-demo-evidence/v1", true);
        var result = coordinator.executeStep("run-j03-1", plan.planFingerprint(), gate,
                (id, step) -> { throw new AssertionError("manual gate must not execute"); });
        assertThat(result.outcome()).isEqualTo(StepOutcome.SKIPPED_MANUAL_GATE);
        assertThat(result.output()).isEmpty();
        // The standalone step coordinator has no dependency executor. Do not
        // submit capture children or infer a terminal artifact from this skip.
    }

    @Test
    void curatedFixtureCannotBeProducedAsRealCaptureWithoutDurableHostClaim() {
        var ledger = new MediaProductionRunCoordinator.StepLedger() {
            @Override public Optional<StepRecord> find(String runId, String stepId) {
                return Optional.empty();
            }
            @Override public void record(String runId, StepRecord record) {
                throw new AssertionError("an unclaimed fixture must not be recorded as product output");
            }
            // Use the source contract's default NOT_ADMITTED claim: no canonical durable host is bound.
        };
        var coordinator = new MediaProductionRunCoordinator(ledger);
        var step = new ProductionStep(
                "capture-source-0", OriginClass.REAL_CAPTURE,
                "scene/s01@curated-v1", "rights/internal-demo-evidence/v1", false);
        var effectAttempted = new java.util.concurrent.atomic.AtomicBoolean();
        var result = coordinator.executeStep("run-j03-fixture", "sha256:" + "a".repeat(64), step,
                (id, requested) -> {
                    effectAttempted.set(true);
                    return curatedBytes(id);
                });
        assertThat(result.outcome()).isEqualTo(StepOutcome.NOT_ADMITTED);
        assertThat(result.output()).isEmpty();
        assertThat(effectAttempted).isFalse();
    }

    @Test
    void explorerStaticCounterpartStaysLabeledNotProductExecuted() throws Exception {
        String standard = Files.readString(Path.of("..", ".product-experience", "pdp-3-product-experience",
                "demo-recording-standard.yaml"));
        assertThat(standard)
                .contains("scenarioId: media.demo.j03.corrected-captions.v1")
                .contains("orderedSceneIds: [s01, s02, s03, s04, s05, s06, s07]")
                .contains("truthLabel: EXPLORER_SIMULATED")
                .contains("status: NOT_RECORDED")
                .contains("persistentSimulationDisclosure: EVIDENCE-ONLY OVERLAY | SIMULATED FIXTURE | NO LIVE PRODUCT OPERATIONS");
    }
}
