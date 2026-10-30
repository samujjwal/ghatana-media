package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaProductionSpecCompiler.CompiledPlan;
import com.ghatana.media.runtime.MediaProductionSpecCompiler.ExecutionMode;
import com.ghatana.media.runtime.MediaProductionSpecCompiler.ProductionSpec;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** H-02: deterministic plan compile, stable fingerprint, partial invalidation. */
class MediaProductionSpecCompilerTest {

    private static ProductionSpec spec() {
        return new ProductionSpec(
                "tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v3", "scene/2@v1"),
                "timeline/main@v2", "rights/standard@v1",
                List.of("profile/1080p@v4"));
    }

    @Test
    void compilesDeterministicDagBoundToOneRevision() {
        MediaProductionSpecCompiler compiler = new MediaProductionSpecCompiler();
        CompiledPlan a = compiler.compile(spec());
        CompiledPlan b = compiler.compile(spec());
        assertThat(a.planFingerprint()).isEqualTo(b.planFingerprint());
        assertThat(a.planFingerprint()).startsWith("sha256:");
        assertThat(a.projectRevision()).isEqualTo("rev-7");
        assertThat(a.nodes().stream().map(n -> n.stepId())).containsExactly(
                "validate-spec", "capture-source-0", "capture-source-1",
                "rights-review", "compose-timeline", "render-profile-0", "publish-review");
        // Manual gates exist for rights and publish — never auto-marked done.
        assertThat(a.nodes()).filteredOn(n -> n.mode() == ExecutionMode.MANUAL_GATE)
                .extracting(n -> n.stepId())
                .containsExactly("rights-review", "publish-review");
        assertThat(a.nodes().stream()
                .filter(n -> n.stepId().equals("compose-timeline"))
                .findFirst().orElseThrow().dependsOn())
                .containsExactly("rights-review");
    }

    @Test
    void sourceChangeInvalidatesOnlyAffectedDescendants() {
        MediaProductionSpecCompiler compiler = new MediaProductionSpecCompiler();
        CompiledPlan before = compiler.compile(spec());
        ProductionSpec changed = new ProductionSpec(
                "tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v4", "scene/2@v1"), // scene/1 revision bump
                "timeline/main@v2", "rights/standard@v1",
                List.of("profile/1080p@v4"));
        CompiledPlan after = compiler.compile(changed);
        assertThat(after.planFingerprint()).isNotEqualTo(before.planFingerprint());
        // capture-source-0 changed; downstream rights-review → publish all re-fingerprinted.
        // capture-source-1's inputs are unchanged — its node fingerprint is preserved.
        List<String> invalidated = after.invalidatedAgainst(before);
        assertThat(invalidated).contains("capture-source-0", "rights-review",
                "compose-timeline", "render-profile-0", "publish-review");
        assertThat(invalidated).doesNotContain("validate-spec", "capture-source-1");
    }

    @Test
    void boundedAndCanonicalInputsOnly() {
        assertThatThrownBy(() -> new ProductionSpec(
                "t", "p", "r", "REAL_CAPTURE", "purpose", List.of(), "t", "r", List.of("o")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ProductionSpec(
                "t", "p", "r", "REAL_CAPTURE", "purpose",
                List.of("s@v1", "s@v1"), "t", "r", List.of("o")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ProductionSpec(
                "t", "p", " padded ", "REAL_CAPTURE", "purpose",
                List.of("s@v1"), "t", "r", List.of("o")))
                .isInstanceOf(IllegalArgumentException.class);
    }
}
