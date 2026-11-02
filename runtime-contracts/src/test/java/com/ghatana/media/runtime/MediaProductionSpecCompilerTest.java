package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaProductionSpecCompiler.CompiledPlan;
import com.ghatana.media.runtime.MediaProductionSpecCompiler.ExecutionMode;
import com.ghatana.media.runtime.MediaProductionSpecCompiler.ProductionSpec;
import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Optional;

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
                "validate-spec", "rights-review", "capture-source-0", "capture-source-1",
                "compose-timeline", "render-profile-0", "publish-review");
        // Manual gates exist for rights and publish — never auto-marked done.
        assertThat(a.nodes()).filteredOn(n -> n.mode() == ExecutionMode.MANUAL_GATE)
                .extracting(n -> n.stepId())
                .containsExactly("rights-review", "publish-review");
        assertThat(a.nodes().stream()
                .filter(n -> n.stepId().equals("compose-timeline"))
                .findFirst().orElseThrow().dependsOn())
                .containsExactly("capture-source-0", "capture-source-1");
        assertThat(a.nodes().stream().filter(n -> n.stepId().startsWith("capture-source-")))
                .allSatisfy(node -> assertThat(node.dependsOn()).containsExactly("rights-review"));
    }

    @Test
    void optionalProjectRevisionMustEqualTheSpecificationRevision() {
        MediaProductionSpecCompiler compiler = new MediaProductionSpecCompiler();
        CompiledPlan canonical = compiler.compile(spec(), "rev-7", null);
        assertThat(canonical.planFingerprint()).isEqualTo(compiler.compile(spec()).planFingerprint());

        assertThatThrownBy(() -> compiler.compile(spec(), "rev-6", null))
                .isInstanceOf(MediaProductionAdmissionBinding.AdmissionException.class)
                .extracting(failure -> ((MediaProductionAdmissionBinding.AdmissionException) failure).failure())
                .isEqualTo(MediaProductionAdmissionBinding.AdmissionFailure.PROJECT_REVISION_STALE);
    }

    @Test
    void exactSchemaAndCompilerContractReferencesAreRetainedAndFingerprintBound() {
        MediaProductionSpecCompiler compiler = new MediaProductionSpecCompiler();
        var inputs = new MediaProductionSpecCompiler.CompilationInputs(
                "production-spec/source-rev-7", "production-spec-schema/rev-1",
                MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION, "production-compiler-contract/v3");
        CompiledPlan first = compiler.compileWithInputs(spec(), inputs);
        CompiledPlan repeat = compiler.compileWithInputs(spec(), new MediaProductionSpecCompiler.CompilationInputs(
                "production-spec/source-rev-7", "production-spec-schema/rev-1",
                MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION, "production-compiler-contract/v3"));
        CompiledPlan changedSchema = compiler.compileWithInputs(spec(), new MediaProductionSpecCompiler.CompilationInputs(
                "production-spec/source-rev-7", "production-spec-schema/rev-2",
                MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION, "production-compiler-contract/v3"));
        CompiledPlan changedCompiler = compiler.compileWithInputs(spec(), new MediaProductionSpecCompiler.CompilationInputs(
                "production-spec/source-rev-7", "production-spec-schema/rev-1",
                MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION, "production-compiler-contract/v4"));
        CompiledPlan changedSpecVersion = compiler.compileWithInputs(spec(), new MediaProductionSpecCompiler.CompilationInputs(
                "production-spec/source-rev-8", "production-spec-schema/rev-1",
                MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION, "production-compiler-contract/v3"));

        assertThat(first.inputProvenance()).isEqualTo(inputs);
        assertThat(repeat.planFingerprint()).isEqualTo(first.planFingerprint());
        assertThat(changedSchema.planFingerprint()).isNotEqualTo(first.planFingerprint());
        assertThat(changedCompiler.planFingerprint()).isNotEqualTo(first.planFingerprint());
        assertThat(changedSpecVersion.planFingerprint()).isNotEqualTo(first.planFingerprint());
        assertThat(changedSchema.invalidatedAgainst(first)).containsExactlyElementsOf(
                first.nodes().stream().map(node -> node.stepId()).toList());
        assertThat(changedCompiler.invalidatedAgainst(first)).containsExactlyElementsOf(
                first.nodes().stream().map(node -> node.stepId()).toList());
        assertThat(changedSpecVersion.invalidatedAgainst(first)).containsExactlyElementsOf(
                first.nodes().stream().map(node -> node.stepId()).toList());
    }

    @Test
    void requiredCompilationInputReferencesRejectMissingOrMalformedValues() {
        assertThatThrownBy(() -> new MediaProductionSpecCompiler.CompilationInputs(null, "schema/rev-1",
                MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION, "compiler/v1"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaProductionSpecCompiler.CompilationInputs("spec/rev-1", "schema/rev-1",
                MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION, "compiler v1"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new MediaProductionSpecCompiler().compileWithInputs(spec(),
                (MediaProductionSpecCompiler.CompilationInputs) null))
                .isInstanceOf(NullPointerException.class);
        var wrongSchemaIdentity = new MediaProductionSpecCompiler.CompilationInputs(
                "spec/rev-1", "schema/rev-2", "media.declarative.value.production-spec.v2", "compiler/v1");
        assertThatThrownBy(() -> new MediaProductionSpecCompiler().compileWithInputs(spec(), wrongSchemaIdentity))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("must match");
    }

    @Test
    void schemaMigrationInputsRemainExplicitlyUnknownWithoutADeclaredTransformation() {
        var compiler = new MediaProductionSpecCompiler();
        var source = new MediaProductionSpecCompiler.CompilationInputs("production-spec/source-rev-7",
                "production-spec-schema/rev-1", MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION,
                "production-compiler-contract/v3");

        var notRequested = compiler.assessSchemaMigration(source,
                new MediaProductionSpecCompiler.SchemaMigrationRequest(Optional.empty(), Optional.empty()));
        var missingTransformation = compiler.assessSchemaMigration(source,
                new MediaProductionSpecCompiler.SchemaMigrationRequest(Optional.of("production-spec-schema/v2"),
                        Optional.empty()));
        var unsupportedTransformation = compiler.assessSchemaMigration(source,
                new MediaProductionSpecCompiler.SchemaMigrationRequest(Optional.of("production-spec-schema/v2"),
                        Optional.of("production-spec-migration/v1")));

        assertThat(notRequested.disposition())
                .isEqualTo(MediaProductionSpecCompiler.SchemaMigrationDisposition.NOT_REQUESTED);
        assertThat(missingTransformation.disposition())
                .isEqualTo(MediaProductionSpecCompiler.SchemaMigrationDisposition.UNKNOWN_INCOMPLETE_INPUTS);
        assertThat(unsupportedTransformation.disposition())
                .isEqualTo(MediaProductionSpecCompiler.SchemaMigrationDisposition.UNKNOWN_UNSUPPORTED_TRANSFORMATION);
        assertThat(unsupportedTransformation.sourceSpecRef()).isEqualTo("production-spec/source-rev-7");
        assertThat(unsupportedTransformation.sourceSchemaRef()).isEqualTo("production-spec-schema/rev-1");
        assertThat(unsupportedTransformation.targetSchemaRef()).contains("production-spec-schema/v2");
        assertThat(unsupportedTransformation.transformationRef()).contains("production-spec-migration/v1");
        assertThatThrownBy(() -> new MediaProductionSpecCompiler.SchemaMigrationRequest(
                Optional.empty(), Optional.of("unversioned transformation")))
                .isInstanceOf(IllegalArgumentException.class);
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
        // Only the changed capture and its compose/render descendants change.
        // The separate rights gate and unchanged source retain their fingerprints.
        List<String> invalidated = after.invalidatedAgainst(before);
        assertThat(invalidated).contains("capture-source-0", "compose-timeline",
                "render-profile-0", "publish-review");
        assertThat(invalidated).doesNotContain("validate-spec", "rights-review", "capture-source-1");
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
    @Test
    void tenantAndProjectAreBoundToPlanAndNodeFingerprints() {
        var compiler = new MediaProductionSpecCompiler();
        var first = compiler.compile(spec());
        var otherTenant = compiler.compile(new ProductionSpec(
                "tenant-2", "project-1", "rev-7", "REAL_CAPTURE", "purpose/v1",
                List.of("scene/1@v3", "scene/2@v1"), "timeline/main@v2",
                "rights/standard@v1", List.of("profile/1080p@v4")));
        var otherProject = compiler.compile(new ProductionSpec(
                "tenant-1", "project-2", "rev-7", "REAL_CAPTURE", "purpose/v1",
                List.of("scene/1@v3", "scene/2@v1"), "timeline/main@v2",
                "rights/standard@v1", List.of("profile/1080p@v4")));
        assertThat(otherTenant.planFingerprint()).isNotEqualTo(first.planFingerprint());
        assertThat(otherProject.planFingerprint()).isNotEqualTo(first.planFingerprint());
        assertThat(otherTenant.invalidatedAgainst(first)).hasSize(first.nodes().size());
        assertThat(otherProject.invalidatedAgainst(first)).hasSize(first.nodes().size());
    }

    @Test
    void malformedOrDuplicateReferencesAndUnknownOriginAreRejected() {
        assertThatThrownBy(() -> new ProductionSpec(
                "t", "p", "r", "REAL_CAPTURE", "purpose", List.of(" scene"), "t", "r", List.of("o")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ProductionSpec(
                "t", "p", "r", "REAL_CAPTURE", "purpose", List.of("scene"), "t", "r", List.of("o", "o")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ProductionSpec(
                "t", "p", "r", "UNKNOWN", "purpose", List.of("scene"), "t", "r", List.of("o")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ProductionSpec(
                "other tenant", "p", "r", "REAL_CAPTURE", "purpose", List.of("scene"), "t", "r", List.of("o")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new ProductionSpec(
                "t", "p", "r", "media.declarative.value.production-spec.v2", "REAL_CAPTURE", "purpose",
                List.of("scene"), "t", "r", List.of("o")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("schemaVersion");
    }

    @Test
    void malformedSurrogatesAreRejectedBeforeFingerprintingButValidSupplementaryRefsRemainSupported() {
        assertThatThrownBy(() -> new ProductionSpec(
                "t", "p", "r", "REAL_CAPTURE", "purpose/\uD800",
                List.of("scene/v1"), "timeline/v1", "rights/v1", List.of("output/v1")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("purposeRef");
        assertThatThrownBy(() -> new ProductionSpec(
                "t", "p", "r", "REAL_CAPTURE", "purpose/v1",
                List.of("scene/\uDC00"), "timeline/v1", "rights/v1", List.of("output/v1")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("sceneRef");

        ProductionSpec validUnicodeRef = new ProductionSpec(
                "t", "p", "r", "REAL_CAPTURE", "purpose/\uD83D\uDE80",
                List.of("scene/v1"), "timeline/v1", "rights/v1", List.of("output/v1"));
        var compiler = new MediaProductionSpecCompiler();
        assertThat(compiler.compile(validUnicodeRef).planFingerprint())
                .isEqualTo(compiler.compile(validUnicodeRef).planFingerprint());
    }

    @Test
    void removedNodesAreIncludedInInvalidation() {
        var compiler = new MediaProductionSpecCompiler();
        var before = compiler.compile(spec());
        var after = compiler.compile(new ProductionSpec(
                "tenant-1", "project-1", "rev-7", "REAL_CAPTURE", "purpose/v1",
                List.of("scene/1@v3"), "timeline/main@v2", "rights/standard@v1",
                List.of("profile/1080p@v4")));
        assertThat(after.invalidatedAgainst(before)).contains("capture-source-1", "compose-timeline");
        assertThat(after.invalidatedAgainst(before)).doesNotContain("capture-source-0", "validate-spec");
    }

}
