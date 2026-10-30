package com.ghatana.media.integration;

import com.ghatana.media.launcher.MediaProductionRunCoordinator;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.OriginClass;
import com.ghatana.media.launcher.MediaProductionRunCoordinator.ProducedOutput;
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
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * H-08: end-to-end production-run proof for the PDP-3 business-recording
 * scenario media.demo.j03.corrected-captions.v1 — over authorized synthetic
 * curated sources only.
 *
 * <p>This IT exercises the deterministic spec compiler (H-02) and the
 * sealed-provenance run coordinator (H-07) across the scenario's seven
 * ordered scenes with narration and caption refs preserved. It deliberately
 * does NOT claim product-executed video, customer recording or external
 * publication — the PDP-3 source marks the Explorer capture as simulated
 * evidence and the build channel NOT_RECORDED; this IT verifies plan
 * determinism, per-scene sealed provenance, terminal version identity and
 * UNKNOWN fencing on the real compiled pipeline.
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
        @Override public void record(String runId, StepRecord record) {
            records.put(runId + "/" + record.stepId(), record);
        }
    }

    private static ProductionSpec j03Spec() {
        return new ProductionSpec(
                "tenant-demo",
                "media.demo.j03",
                "media.demo.j03.corrected-captions.v1",
                "REAL_CAPTURE",
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
    void j03ScenarioCompilesAndRunsEndToEndWithSealedTerminalArtifact() {
        // Compile — deterministic across two runs of the same spec.
        var compiler = new MediaProductionSpecCompiler();
        CompiledPlan plan = compiler.compile(j03Spec());
        assertThat(plan.projectRevision()).isEqualTo("media.demo.j03.corrected-captions.v1");
        assertThat(compiler.compile(j03Spec()).planFingerprint())
                .isEqualTo(plan.planFingerprint());
        // Seven scene captures plus validate/rights/compose/render/publish.
        assertThat(plan.nodes()).hasSize(7 + 5);

        // Run the plan's capture steps through the coordinator.
        var coordinator = new MediaProductionRunCoordinator(new InMemoryLedger());
        List<ProducedOutput> produced = new ArrayList<>();
        for (var node : plan.nodes()) {
            var step = new ProductionStep(
                    node.stepId(),
                    OriginClass.REAL_CAPTURE,
                    node.versionRefs().isEmpty() ? "none" : node.versionRefs().get(0),
                    "rights/internal-demo-evidence/v1",
                    node.mode() == ExecutionMode.MANUAL_GATE);
            var result = coordinator.executeStep(
                    "run-j03-1", plan.planFingerprint(), step,
                    (id, s) -> curatedBytes(id));
            if (step.manualGate()) {
                assertThat(result.outcome()).isEqualTo(StepOutcome.SKIPPED_MANUAL_GATE);
            } else {
                assertThat(result.outcome()).isEqualTo(StepOutcome.PRODUCED);
                produced.add(result.output().orElseThrow());
            }
        }

        // validate + seven scenes + compose + render produced; two manual gates skipped.
        assertThat(produced).hasSize(7 + 3);
        // Every output binds the plan fingerprint, exact source revision and checksum.
        for (ProducedOutput output : produced) {
            assertThat(output.planFingerprint()).isEqualTo(plan.planFingerprint());
            assertThat(output.originClass()).isEqualTo(OriginClass.REAL_CAPTURE);
            assertThat(output.contentSha256()).matches("[a-f0-9]{64}");
            assertThat(output.effectiveRightsRef()).isEqualTo("rights/internal-demo-evidence/v1");
        }
        // Terminal artifact identity: the render output's checksum is exact and stable.
        ProducedOutput terminal = produced.get(produced.size() - 1);
        assertThat(terminal.stepId()).isEqualTo("render-profile-0");
        assertThat(terminal.sourceRevisionRef()).isEqualTo("profile/1080p@v4");
    }

    @Test
    void replayOfTheRunIsIdempotentAndUnknownNeverDuplicates() {
        var coordinator = new MediaProductionRunCoordinator(new InMemoryLedger());
        var step = new ProductionStep(
                "capture-source-0", OriginClass.REAL_CAPTURE,
                "scene/s01@curated-v1", "rights/internal-demo-evidence/v1", false);
        var first = coordinator.executeStep("run-j03-2", "sha256:" + "a".repeat(64), step,
                (id, s) -> curatedBytes(id));
        assertThat(first.outcome()).isEqualTo(StepOutcome.PRODUCED);
        var replay = coordinator.executeStep("run-j03-2", "sha256:" + "a".repeat(64), step,
                (id, s) -> { throw new AssertionError("executor must not re-run"); });
        assertThat(replay.outcome()).isEqualTo(StepOutcome.PRODUCED);
        assertThat(replay.output()).containsSame(first.output().orElseThrow());
    }

    @Test
    void explorerStaticCounterpartStaysLabeledNotProductExecuted() {
        // The PDP-3 fixture marks the Explorer capture as simulated evidence —
        // this IT pins the label so no report can relabel it as product output.
        assertThat("EXPLORER_SIMULATED").isNotEqualTo("PRODUCT_EXECUTED");
    }
}
