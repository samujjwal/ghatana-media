package com.ghatana.media.runtime;

import tools.jackson.databind.ObjectMapper;

import com.ghatana.media.runtime.MediaProductionSpecCompiler.CompiledPlan;
import com.ghatana.media.runtime.MediaProductionSpecCompiler.ExecutionMode;
import com.ghatana.media.runtime.MediaProductionSpecCompiler.ProductionSpec;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** H-02: deterministic plan compile, stable fingerprint, partial invalidation. */
class MediaProductionSpecCompilerTest {
    private static final ObjectMapper JSON = new ObjectMapper();
    private static final String PRODUCTION_SPEC_SCHEMA_JSON = """
            {
              "$schema":"https://json-schema.org/draft/2020-12/schema",
              "$defs":{
                "versionRef":{"type":"string","format":"opaque-versioned-reference",
                  "minLength":1,"maxLength":384,"pattern":"\\\\S"},
                "nonEmptyVersionRefList":{"type":"array","minItems":1,"uniqueItems":true,
                  "items":{"$ref":"#/$defs/versionRef"}}
              },
              "type":"object",
              "additionalProperties":false,
              "required":["tenantId","projectId","revisionId","schemaVersion","originClass","purposeRef",
                "sceneRefs","timelineRef","rightsRef","outputProfileRefs"],
              "properties":{
                "tenantId":{"type":"string","format":"opaque-id","minLength":1,"maxLength":128,
                  "pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$"},
                "projectId":{"type":"string","format":"opaque-id","minLength":1,"maxLength":128,
                  "pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$"},
                "revisionId":{"type":"string","format":"opaque-id","minLength":1,"maxLength":128,
                  "pattern":"^[A-Za-z0-9][A-Za-z0-9._:-]*$"},
                "schemaVersion":{"const":"media.declarative.value.production-spec.v1"},
                "originClass":{"enum":["REAL_CAPTURE","DECLARATIVE_ANIMATION","MODEL_SIMULATION",
                  "GENERATIVE_MEDIA","PDP_SYNTHETIC_FIXTURE"]},
                "purposeRef":{"$ref":"#/$defs/versionRef"},
                "sceneRefs":{"$ref":"#/$defs/nonEmptyVersionRefList"},
                "timelineRef":{"$ref":"#/$defs/versionRef"},
                "rightsRef":{"$ref":"#/$defs/versionRef"},
                "outputProfileRefs":{"$ref":"#/$defs/nonEmptyVersionRefList"}
              }
            }
            """;

    private static ProductionSpec spec() {
        return new ProductionSpec(
                "tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v3", "scene/2@v1"),
                "timeline/main@v2", "rights/standard@v1",
                List.of("profile/1080p@v4"));
    }

    @Test
    void onlyCompilerIssuedPlanIdentityCanReachAdmissionGuards() {
        assertThat(CompiledPlan.class.isRecord()).isTrue();
        MediaProductionSpecCompiler compiler = new MediaProductionSpecCompiler();
        CompiledPlan compiled = compiler.compile(spec());
        assertThat(MediaProductionSpecCompiler.isCompilerIssued(compiled)).isTrue();

        CompiledPlan reconstructed = new CompiledPlan(compiled.schemaVersion(), compiled.projectRevision(),
                compiled.originClass(), compiled.nodes(), compiled.planFingerprint(), compiled.inputProvenance(),
                compiled.admissionBindingFingerprint());
        assertThat(reconstructed).isEqualTo(compiled);
        assertThat(MediaProductionSpecCompiler.isCompilerIssued(reconstructed)).isFalse();

        CompiledPlan legacyConstructed = new CompiledPlan(compiled.schemaVersion(), compiled.projectRevision(),
                compiled.originClass(), compiled.nodes(), compiled.planFingerprint());
        assertThat(MediaProductionSpecCompiler.isCompilerIssued(legacyConstructed)).isFalse();
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
    void resolvedProductionSpecIsSchemaValidatedMatchedAndFingerprintBound() throws Exception {
        var inputs = new MediaProductionSpecCompiler.CompilationInputs(
                "production-spec/source-rev-7", "production-spec-schema/rev-1",
                MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION, "production-compiler-contract/v3");
        Map<String, byte[]> contents = Map.of(
                inputs.productionSpecRef(), JSON.writeValueAsBytes(spec()),
                inputs.productionSpecSchemaRef(), PRODUCTION_SPEC_SCHEMA_JSON.getBytes(StandardCharsets.UTF_8),
                inputs.compilerContractRef(), "compiler bytes".getBytes(StandardCharsets.UTF_8));
        var compiler = new MediaProductionSpecCompiler();
        AtomicInteger firstResolverCalls = new AtomicInteger();
        var first = compiler.compileWithResolvedContentFingerprints(spec(), inputs,
                ref -> {
                    firstResolverCalls.incrementAndGet();
                    return resolved(ref, contents.get(ref));
                });
        assertThat(firstResolverCalls).hasValue(3);
        var repeat = compiler.compileWithResolvedContentFingerprints(spec(), inputs,
                ref -> resolved(ref, contents.get(ref)));
        assertThat(repeat.planFingerprint()).isEqualTo(first.planFingerprint());

        Map<String, byte[]> changed = Map.of(
                inputs.productionSpecRef(), contents.get(inputs.productionSpecRef()),
                inputs.productionSpecSchemaRef(), PRODUCTION_SPEC_SCHEMA_JSON
                        .replace("\"$schema\"", "\"title\":\"approved-schema-revision\",\"$schema\"")
                        .getBytes(StandardCharsets.UTF_8),
                inputs.compilerContractRef(), contents.get(inputs.compilerContractRef()));
        var changedSchemaContent = compiler.compileWithResolvedContentFingerprints(spec(), inputs,
                ref -> resolved(ref, changed.get(ref)));
        assertThat(changedSchemaContent.planFingerprint()).isNotEqualTo(first.planFingerprint());
        assertThat(changedSchemaContent.invalidatedAgainst(first)).containsExactlyElementsOf(
                first.nodes().stream().map(node -> node.stepId()).toList());

        assertThatThrownBy(() -> compiler.compileWithResolvedContentFingerprints(spec(), inputs,
                ref -> resolved("alias/for/" + ref, contents.get(ref))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("different version reference");
        assertThatThrownBy(() -> compiler.compileWithResolvedContentFingerprints(spec(), inputs,
                ref -> new MediaVersionedContractContent.ResolvedContent(ref, contents.get(ref),
                        "sha256:" + "0".repeat(64))))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("digest does not match");
    }

    @Test
    void resolvedProductionSpecMustMatchTypedInputAndRejectMalformedOrDuplicateJson() throws Exception {
        var inputs = new MediaProductionSpecCompiler.CompilationInputs(
                "production-spec/source-rev-7", "production-spec-schema/rev-1",
                MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION, "production-compiler-contract/v3");
        byte[] schema = PRODUCTION_SPEC_SCHEMA_JSON.getBytes(StandardCharsets.UTF_8);
        byte[] compiler = "opaque compiler contract".getBytes(StandardCharsets.UTF_8);

        byte[] differentProject = JSON.writeValueAsBytes(new ProductionSpec(
                "tenant-1", "other-project", "rev-7", "REAL_CAPTURE", "purpose/v1",
                List.of("scene/1@v3", "scene/2@v1"), "timeline/main@v2", "rights/standard@v1",
                List.of("profile/1080p@v4")));
        assertThatThrownBy(() -> new MediaProductionSpecCompiler().compileWithResolvedContentFingerprints(
                spec(), inputs, ref -> resolved(ref, ref.equals(inputs.productionSpecRef())
                        ? differentProject
                        : ref.equals(inputs.productionSpecSchemaRef()) ? schema : compiler)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("does not match the supplied typed specification");

        byte[] unknownProperty = (new String(JSON.writeValueAsBytes(spec()), StandardCharsets.UTF_8)
                .replace("{", "{\"unexpected\":true,"))
                .getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> new MediaProductionSpecCompiler().compileWithResolvedContentFingerprints(
                spec(), inputs, ref -> resolved(ref, ref.equals(inputs.productionSpecRef())
                        ? unknownProperty
                        : ref.equals(inputs.productionSpecSchemaRef()) ? schema : compiler)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("resolved production-spec content is invalid");

        byte[] duplicateProperty = "{\"tenantId\":\"tenant-1\",\"tenantId\":\"tenant-1\"}"
                .getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> new MediaProductionSpecCompiler().compileWithResolvedContentFingerprints(
                spec(), inputs, ref -> resolved(ref, ref.equals(inputs.productionSpecRef())
                        ? duplicateProperty
                        : ref.equals(inputs.productionSpecSchemaRef()) ? schema : compiler)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("resolved production-spec content is invalid");

        byte[] malformedJson = "{".getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> new MediaProductionSpecCompiler().compileWithResolvedContentFingerprints(
                spec(), inputs, ref -> resolved(ref, ref.equals(inputs.productionSpecRef())
                        ? malformedJson
                        : ref.equals(inputs.productionSpecSchemaRef()) ? schema : compiler)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("resolved production-spec content is invalid");

        byte[] trailingDocument = (new String(JSON.writeValueAsBytes(spec()), StandardCharsets.UTF_8) + " {}")
                .getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> new MediaProductionSpecCompiler().compileWithResolvedContentFingerprints(
                spec(), inputs, ref -> resolved(ref, ref.equals(inputs.productionSpecRef())
                        ? trailingDocument
                        : ref.equals(inputs.productionSpecSchemaRef()) ? schema : compiler)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("resolved production-spec content is invalid");

        byte[] malformedSchema = "not-json-schema".getBytes(StandardCharsets.UTF_8);
        assertThatThrownBy(() -> new MediaProductionSpecCompiler().compileWithResolvedContentFingerprints(
                spec(), inputs, ref -> resolved(ref, ref.equals(inputs.productionSpecRef())
                        ? JSON.writeValueAsBytes(spec())
                        : ref.equals(inputs.productionSpecSchemaRef()) ? malformedSchema : compiler)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("resolved production-spec content is invalid");
    }

    @Test
    void schemaMismatchIsRejectedBeforeResolvingContent() {
        var inputs = new MediaProductionSpecCompiler.CompilationInputs(
                "production-spec/source-rev-7", "production-spec-schema/rev-1",
                "media.declarative.value.production-spec.v2", "production-compiler-contract/v3");
        AtomicInteger calls = new AtomicInteger();

        assertThatThrownBy(() -> new MediaProductionSpecCompiler().compileWithResolvedContentFingerprints(
                spec(), inputs, ref -> {
                    calls.incrementAndGet();
                    return resolved(ref, new byte[0]);
                }))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("must match");
        assertThat(calls).hasValue(0);

        assertThatThrownBy(() -> new MediaProductionSpecCompiler().compileWithResolvedContentFingerprints(
                spec(), new MediaProductionSpecCompiler.CompilationInputs(
                        "production-spec/source-rev-7", "production-spec-schema/rev-1",
                        MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION, "production-compiler-contract/v3"),
                "rev-6", null, ref -> {
                    calls.incrementAndGet();
                    return resolved(ref, new byte[0]);
                }))
                .isInstanceOf(MediaProductionAdmissionBinding.AdmissionException.class)
                .extracting(failure -> ((MediaProductionAdmissionBinding.AdmissionException) failure).failure())
                .isEqualTo(MediaProductionAdmissionBinding.AdmissionFailure.PROJECT_REVISION_STALE);
        assertThat(calls).hasValue(0);
    }

    private static MediaVersionedContractContent.ResolvedContent resolved(String ref, byte[] content) {
        try {
            String digest = "sha256:" + HexFormat.of().formatHex(
                    MessageDigest.getInstance("SHA-256").digest(content));
            return new MediaVersionedContractContent.ResolvedContent(ref, content, digest);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void opaqueContentResponseIsDefensiveAndBoundedBeforeItIsCopied() throws Exception {
        byte[] supplied = "not necessarily a serialized production spec".getBytes(StandardCharsets.UTF_8);
        String digest = "sha256:" + HexFormat.of().formatHex(
                MessageDigest.getInstance("SHA-256").digest(supplied));
        var response = new MediaVersionedContractContent.ResolvedContent("contract/rev-1", supplied, digest);
        java.util.Arrays.fill(supplied, (byte) 0);
        byte[] exposed = response.content();
        java.util.Arrays.fill(exposed, (byte) 0);

        var checked = MediaVersionedContractContent.resolveDigestChecked("contract/rev-1", ignored -> response);
        assertThat(checked.sha256()).isEqualTo(digest);
        assertThat(checked.byteLength()).isEqualTo("not necessarily a serialized production spec".length());

        byte[] maximum = new byte[MediaVersionedContractContent.MAX_CONTENT_BYTES];
        var atLimit = resolved("contract/at-limit", maximum);
        assertThat(MediaVersionedContractContent.resolveDigestChecked("contract/at-limit", ignored -> atLimit)
                .byteLength()).isEqualTo(MediaVersionedContractContent.MAX_CONTENT_BYTES);
        assertThatThrownBy(() -> new MediaVersionedContractContent.ResolvedContent("contract/oversized",
                new byte[MediaVersionedContractContent.MAX_CONTENT_BYTES + 1], "sha256:" + "0".repeat(64)))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("operational byte limit");
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
