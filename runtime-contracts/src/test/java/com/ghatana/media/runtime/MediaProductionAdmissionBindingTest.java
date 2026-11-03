package com.ghatana.media.runtime;

import tools.jackson.databind.ObjectMapper;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.AdmissionFailure;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.AdmissionException;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.Binding;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.BoundedAmount;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.ClockBindings;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.ClockConversion;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.CurrentState;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.Engine;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.ProviderQualification;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.RequestIdentity;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.Rational;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.Reservation;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.Authority;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.EditLock;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.ProjectEditLockCas;
import com.ghatana.media.runtime.MediaProductionAdmissionBinding.SceneSourceAuthority;
import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaProductionAdmissionBindingTest {
    private static final Instant NOW = Instant.parse("2030-01-01T00:00:00Z");
    private static final String SHA = "sha256:" + "a".repeat(64);
    private static final ObjectMapper JSON = new ObjectMapper();

    private static Binding binding(String engineDigest) {
        return new Binding(MediaProductionAdmissionBinding.SCHEMA_VERSION, "project-1", "rev-7",
                new RequestIdentity("request-1", SHA), Map.of(
                "validate-spec", noEngine(), "rights-review", noEngine(), "capture-source-0", noEngine(),
                "compose-timeline", noEngine(), "render-profile-0", new Engine("ENGINE", "renderer-v3", engineDigest),
                "publish-review", noEngine()),
                new ProviderQualification("local-renderer", "qualification/v2", "rights/render/v1", SHA, true),
                new Reservation("quote/q1", "tariff/v5", "reservation-r1",
                        new BoundedAmount(10, "usd-micros"), new BoundedAmount(12, "usd-micros"),
                        new BoundedAmount(100, "cpu-ms"), new BoundedAmount(120, "cpu-ms"),
                        new BoundedAmount(500, "wall-ms"), new BoundedAmount(600, "wall-ms")),
                new Authority("identity-context/v3", SHA, 12, "tenant-1", "principal-1", "delegation/v2", "workspace/v1",
                        "purpose/v1", "rights/v1", "source/v4", SHA,
                        "decision/rights-4", NOW.plusSeconds(600), 3),
                Map.of(
                        "capture-source-0", new EditLock("SCENE", "scene/1@v1", "principal-1", "lease-scene", 9,
                                NOW.plusSeconds(300)),
                        "render-profile-0", new EditLock("OUTPUT", "profile/v1", "principal-1", "lease-output", 10,
                                NOW.plusSeconds(300))),
                new ClockBindings("story/v1", "media/v1", "simulation/v1", "wall/v1",
                        List.of(new ClockConversion("story/v1", "media/v1", new Rational(25, 1)))),
                Map.of("scene/1@v1", new SceneSourceAuthority("source/v4", SHA, "rights/v1",
                        "decision/rights-4", NOW.plusSeconds(600), 3)));
    }

    private static Engine noEngine() { return new Engine("NO_ENGINE", "NO_ENGINE", "NO_ENGINE"); }

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
    void resolvedRuntimeCandidateRetainsBindingAndStillFailsClosedAtAdmission() throws Exception {
        Binding binding = binding(SHA);
        var spec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7",
                "REAL_CAPTURE", "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/v1",
                List.of("profile/v1"));
        var inputs = new MediaProductionSpecCompiler.CompilationInputs("production-spec/rev-7",
                "production-spec-schema/rev-1", MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION,
                "production-compiler-contract/v3");
        Map<String, byte[]> contents = Map.of(
                inputs.productionSpecRef(), JSON.writeValueAsBytes(spec),
                inputs.productionSpecSchemaRef(), MediaProductionAdmissionBindingTest.class
                        .getResourceAsStream("/contracts/media-production-spec-v1.schema.json").readAllBytes(),
                inputs.compilerContractRef(), "opaque compiler contract".getBytes(StandardCharsets.UTF_8));

        var plan = new MediaProductionSpecCompiler().compileWithResolvedContentFingerprints(
                spec, inputs, "rev-7", binding, ref -> resolved(ref, contents.get(ref)));

        assertThat(plan.projectRevision()).isEqualTo("rev-7");
        assertThat(plan.inputProvenance()).isEqualTo(inputs);
        assertThat(plan.admissionBindingFingerprint()).isEqualTo(binding.stableContextFingerprint());
        assertThat(MediaProductionSpecCompiler.isCompilerIssued(plan)).isTrue();
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.requireAdmitted(
                binding, "render-profile-0", state(binding, "render-profile-0")))
                .isInstanceOf(AdmissionException.class)
                .extracting(failure -> ((AdmissionException) failure).failure())
                .isEqualTo(AdmissionFailure.SOURCE_REVIEW_NOT_ADMITTED);
    }

    @Test
    void deterministicCompilerOnlyCandidateRemainsEffectFreeWithoutAdmissionBindings() {
        var spec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7",
                "REAL_CAPTURE", "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/v1",
                List.of("profile/v1"));
        var compiler = new MediaProductionSpecCompiler();
        var candidate = compiler.compile(spec);

        assertThat(candidate.planFingerprint()).isEqualTo(compiler.compile(spec).planFingerprint());
        assertThat(candidate.admissionBindingFingerprint()).isNull();
        assertThat(candidate.nodes()).filteredOn(node -> node.mode() == MediaProductionSpecCompiler.ExecutionMode.AUTOMATIC)
                .extracting(MediaProductionSpecCompiler.PlanNode::stepId)
                .containsExactly("validate-spec", "capture-source-0", "compose-timeline", "render-profile-0");

        Binding otherwiseCompleteBinding = binding(SHA);
        AtomicInteger effects = new AtomicInteger();
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(otherwiseCompleteBinding, candidate,
                "capture-source-0", "scene/1@v1", () -> state(otherwiseCompleteBinding,
                        "capture-source-0", "scene/1@v1"), effects::incrementAndGet))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.BINDING_SPEC_MISMATCH);
        assertThat(effects).hasValue(0);
    }

    @Test
    void resolvedCompilerRejectsBindingMismatchBeforeCallingContentResolver() {
        Binding binding = binding(SHA);
        var mismatchedSpec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "other-project", "rev-7",
                "REAL_CAPTURE", "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/v1",
                List.of("profile/v1"));
        var inputs = new MediaProductionSpecCompiler.CompilationInputs("production-spec/rev-7",
                "production-spec-schema/rev-1", MediaProductionSpecCompiler.PRODUCTION_SPEC_SCHEMA_VERSION,
                "production-compiler-contract/v3");
        AtomicInteger resolverCalls = new AtomicInteger();

        assertThatThrownBy(() -> new MediaProductionSpecCompiler().compileWithResolvedContentFingerprints(
                mismatchedSpec, inputs, null, binding, ref -> {
                    resolverCalls.incrementAndGet();
                    throw new AssertionError("resolver must not be called for a mismatched binding");
                }))
                .isInstanceOf(AdmissionException.class)
                .extracting(failure -> ((AdmissionException) failure).failure())
                .isEqualTo(AdmissionFailure.BINDING_SPEC_MISMATCH);
        assertThat(resolverCalls).hasValue(0);
    }

    private static CurrentState state(Binding b, String stepId) {
        return state(b, stepId, "scene/1@v1");
    }

    private static CurrentState state(Binding b, String stepId, String sceneRef) {
        Engine engine = b.engineForStep(stepId);
        EditLock lock = b.editLocksByStep().getOrDefault(stepId,
                new EditLock("SCENE", "unmapped-target", "principal-1", "unmapped-lease", 1,
                        NOW.plusSeconds(300)));
        SceneSourceAuthority source = b.sourceBindingsByScene().get(sceneRef);
        String sourceVersion = source == null ? b.authority().sourceVersionRef() : source.sourceVersionRef();
        String sourceSha = source == null ? b.authority().sourceSha256() : source.sourceSha256();
        String rightsRef = source == null ? b.authority().rightsRef() : source.rightsRef();
        String decisionRef = source == null ? b.authority().ownerDecisionRef() : source.ownerDecisionRef();
        Instant decisionExpiry = source == null ? b.authority().decisionExpiresAt() : source.decisionExpiresAt();
        long revocationEpoch = source == null ? b.authority().revocationEpoch() : source.revocationEpoch();
        return new CurrentState(b.authority().identityContextRef(), b.authority().identityContextSha256(),
                b.authority().identityEpoch(), b.authority().tenantId(), b.authority().principalId(),
                b.authority().delegationRef(), b.authority().workspaceRef(), b.authority().purposeRef(),
                sourceVersion, sourceSha, b.projectId(),
                b.expectedProjectRevision(), rightsRef, decisionRef, decisionExpiry,
                revocationEpoch, engine.identityKind(), engine.identity(), engine.buildSha256(),
                b.provider().providerId(), b.provider().qualificationRef(), b.provider().qualificationSha256(),
                b.provider().rightsRef(), true, b.reservation().quoteRef(), b.reservation().quoteVersion(),
                b.reservation().reservationId(), new BoundedAmount(12, "usd-micros"),
                new BoundedAmount(120, "cpu-ms"), new BoundedAmount(600, "wall-ms"),
                lock.scopeKind(), lock.targetRef(), lock.ownerPrincipalId(), lock.leaseId(),
                lock.epoch(), lock.expiresAt(),
                null, null, b.clocks(), NOW, b.authority().ownerDecisionRef(),
                b.authority().decisionExpiresAt(), b.authority().revocationEpoch(), b.authority().rightsRef());
    }

    private static Binding withSceneSources(Binding base, Map<String, SceneSourceAuthority> sources) {
        Map<String, Engine> engines = new java.util.TreeMap<>(base.enginesByStep());
        Map<String, EditLock> locks = new java.util.TreeMap<>(base.editLocksByStep());
        for (int i = 0; i < sources.size(); i++) {
            String stepId = "capture-source-" + i;
            engines.put(stepId, noEngine());
            String sceneRef = sources.keySet().stream().sorted().toList().get(i);
            locks.put(stepId, new EditLock("SCENE", sceneRef, "principal-1", "lease-scene-" + i, 9 + i,
                    NOW.plusSeconds(300)));
        }
        return new Binding(base.schemaVersion(), base.projectId(), base.expectedProjectRevision(), base.requestIdentity(),
                engines, base.provider(), base.reservation(), base.authority(), locks, base.clocks(), sources);
    }

    @Test
    void envelopeOpaqueIdsMatchThePdp1IdentifierShape() {
        assertThat(binding(SHA).projectId()).isEqualTo("project-1");
        String maximumId = "A" + "_".repeat(127);
        assertThat(new RequestIdentity(maximumId, SHA).requestId()).isEqualTo(maximumId);
        assertThat(new RequestIdentity("A_:-.9", SHA).requestId()).isEqualTo("A_:-.9");
        assertThatThrownBy(() -> new RequestIdentity("A" + "_".repeat(128), SHA))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("opaque identifier");
        assertThatThrownBy(() -> new RequestIdentity("_starts-with-punctuation", SHA))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new RequestIdentity("request id", SHA))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("opaque identifier");
        assertThatThrownBy(() -> new ProviderQualification("provider/id", "qualification/v1",
                "rights/v1", SHA, true))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Reservation("quote/v1", "tariff/v1", "reservation id",
                new BoundedAmount(1, "usd-micros"), new BoundedAmount(1, "usd-micros"),
                new BoundedAmount(1, "cpu-ms"), new BoundedAmount(1, "cpu-ms"),
                new BoundedAmount(1, "wall-ms"), new BoundedAmount(1, "wall-ms")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Authority("identity-context/v3", SHA, 12, "tenant/one", "principal-1",
                "delegation/v2", "workspace/v1", "purpose/v1", "rights/v1",
                "source/v1", SHA, "decision/v1", NOW.plusSeconds(60), 0))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new EditLock("SCENE", "scene/v1", "principal-1", "lease id", 1,
                NOW.plusSeconds(60)))
                .isInstanceOf(IllegalArgumentException.class);

        Binding valid = binding(SHA);
        assertThatThrownBy(() -> new Binding(valid.schemaVersion(), "project id", valid.expectedProjectRevision(),
                valid.requestIdentity(), valid.enginesByStep(), valid.provider(), valid.reservation(),
                valid.authority(), valid.editLocksByStep(), valid.clocks(), valid.sourceBindingsByScene()))
                .isInstanceOf(IllegalArgumentException.class);
        Map<String, Engine> invalidStep = Map.of("capture source 0", noEngine());
        assertThatThrownBy(() -> new Binding(valid.schemaVersion(), valid.projectId(), valid.expectedProjectRevision(),
                valid.requestIdentity(), invalidStep, valid.provider(), valid.reservation(), valid.authority(),
                valid.editLocksByStep(), valid.clocks(), valid.sourceBindingsByScene()))
                .isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void identicalBindingsProduceStableCompileAndEngineDigestInvalidatesDependents() {
        var compiler = new MediaProductionSpecCompiler();
        var spec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/v1", List.of("profile/v1"));
        Binding b1 = binding(SHA);
        Binding b2 = binding(SHA);
        var first = compiler.compile(spec, b1);
        var repeat = compiler.compile(spec, b2);
        assertThat(compiler.compile(spec).planFingerprint()).isEqualTo(compiler.compile(spec, null).planFingerprint());
        assertThat(first.planFingerprint()).isEqualTo(repeat.planFingerprint());
        assertThat(first.nodes()).extracting(n -> n.nodeFingerprint())
                .containsExactlyElementsOf(repeat.nodes().stream().map(n -> n.nodeFingerprint()).toList());

        var changedEngine = compiler.compile(spec, binding("sha256:" + "b".repeat(64)));
        assertThat(changedEngine.invalidatedAgainst(first))
                .containsExactly("render-profile-0", "publish-review");
        Authority changedIdentity = new Authority("identity-context/v4", SHA, 13, "tenant-1", "principal-1",
                "delegation/v2", "workspace/v1", "purpose/v1", "rights/v1", "source/v4", SHA,
                "decision/rights-4", NOW.plusSeconds(600), 3);
        Binding identityChanged = new Binding(b1.schemaVersion(), b1.projectId(), b1.expectedProjectRevision(),
                b1.requestIdentity(), b1.enginesByStep(), b1.provider(), b1.reservation(), changedIdentity,
                b1.editLocksByStep(), b1.clocks(), b1.sourceBindingsByScene());
        assertThat(identityChanged.stableContextFingerprint()).isNotEqualTo(b1.stableContextFingerprint());
        var wrongRights = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/other@v1", List.of("profile/v1"));
        assertThatThrownBy(() -> compiler.compile(wrongRights, b1))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.BINDING_SPEC_MISMATCH);
        Binding incompleteEngineMap = new Binding(b1.schemaVersion(), b1.projectId(), b1.expectedProjectRevision(),
                b1.requestIdentity(), Map.of("validate-spec", noEngine()), b1.provider(), b1.reservation(),
                b1.authority(), b1.editLocksByStep(), b1.clocks(), b1.sourceBindingsByScene());
        assertThatThrownBy(() -> compiler.compile(spec, incompleteEngineMap))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.ENGINE_MISMATCH);
    }

    @Test
    void boundMultiScenePlanRequiresExactSourceMappingsAndRechecksEachSceneAuthority() {
        var compiler = new MediaProductionSpecCompiler();
        var multiScene = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7",
                "REAL_CAPTURE", "purpose/v1", List.of("scene/1@v1", "scene/2@v3"), "timeline/v1",
                "rights/v1", List.of("profile/v1"));
        Binding base = binding(SHA);
        Binding binding = withSceneSources(base, Map.of(
                "scene/1@v1", new SceneSourceAuthority("source/v4", SHA, "rights/v1", "decision/rights-4", NOW.plusSeconds(600), 3),
                "scene/2@v3", new SceneSourceAuthority("source/v8", "sha256:" + "b".repeat(64), "rights/v2", "decision/rights-8", NOW.plusSeconds(900), 4)));
        AtomicInteger effects = new AtomicInteger();
        var compiled = compiler.compile(multiScene, binding);
        Binding changedSecond = withSceneSources(base, Map.of(
                "scene/1@v1", binding.sourceBindingsByScene().get("scene/1@v1"),
                "scene/2@v3", new SceneSourceAuthority("source/v9", "sha256:" + "c".repeat(64), "rights/v2", "decision/rights-9", NOW.plusSeconds(900), 4)));
        assertThat(changedSecond.stableContextFingerprint()).isNotEqualTo(binding.stableContextFingerprint());
        assertThat(compiler.compile(multiScene, changedSecond).invalidatedAgainst(compiled))
                .contains("capture-source-1", "compose-timeline", "render-profile-0", "publish-review")
                .doesNotContain("capture-source-0");

        Binding missing = withSceneSources(base, Map.of("scene/1@v1", binding.sourceBindingsByScene().get("scene/1@v1")));
        Binding extra = withSceneSources(base, Map.of(
                "scene/1@v1", binding.sourceBindingsByScene().get("scene/1@v1"),
                "scene/2@v3", binding.sourceBindingsByScene().get("scene/2@v3"),
                "scene/unreferenced@v1", binding.sourceBindingsByScene().get("scene/2@v3")));
        for (Binding invalid : List.of(missing, extra)) {
            assertThatThrownBy(() -> compiler.compile(multiScene, invalid))
                    .isInstanceOf(AdmissionException.class)
                    .extracting(error -> ((AdmissionException) error).failure())
                    .isEqualTo(AdmissionFailure.MULTI_SOURCE_AUTHORITY_UNMAPPED);
        }

        CurrentState second = state(binding, "capture-source-1", "scene/2@v3");
        MediaProductionAdmissionBinding.requireCurrent(binding, compiled, "capture-source-1", "scene/2@v3", second);
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(binding, compiled, "capture-source-1", "scene/2@v3",
                () -> second, effects::incrementAndGet))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.SOURCE_REVIEW_NOT_ADMITTED);
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(binding, compiled, "capture-source-1", "scene/2@v3",
                () -> copyWithSourceSha(second, SHA), effects::incrementAndGet))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.SOURCE_MISMATCH);
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.requireCurrent(binding, compiled, "capture-source-1", "scene/1@v1", second))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.BINDING_SPEC_MISMATCH);
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.requireCurrent(binding, compiled, "capture-source-1", "scene/2@v3",
                copy(second, second.tenantId(), second.principalId(), second.projectRevision(), NOW.minusSeconds(1),
                        second.reservationId(), second.lockOwnerPrincipalId(), second.lockEpoch(), second.clocks())))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.RIGHTS_STALE);
        CurrentState revoked = replace(second, second.tenantId(), second.principalId(), second.purposeRef(),
                second.sourceVersionRef(), 5, second.engineBuildSha256(), second.qualified(), second.quoteVersion(),
                second.remainingCost(), second.lockOwnerPrincipalId(), second.lockEpoch(), second.lockExpiresAt(), second.clocks());
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.requireCurrent(binding, compiled, "capture-source-1", "scene/2@v3", revoked))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.RIGHTS_REVOKED);
        assertThat(effects).hasValue(0);

        assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(binding, compiled,
                "capture-source-0", "scene/2@v3", () -> second, effects::incrementAndGet))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.BINDING_SPEC_MISMATCH);
        CurrentState mismatchedLock = copyWithLockTarget(state(binding, "capture-source-0", "scene/1@v1"),
                "SCENE", "scene/2@v3");
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(binding, compiled,
                "capture-source-0", "scene/1@v1", () -> mismatchedLock, effects::incrementAndGet))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.EDIT_LOCK_INVALID);
        assertThat(effects).hasValue(0);

        var singleScene = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7",
                "REAL_CAPTURE", "purpose/v1", List.of("scene/1@v1"), "timeline/v1",
                "rights/v1", List.of("profile/v1"));
        assertThat(compiler.compile(singleScene, base).nodes())
                .extracting(node -> node.stepId())
                .contains("capture-source-0");
    }

    @Test
    void captureRequiresCurrentGlobalDecisionAndRevocationEpochIndependentlyOfSceneDecision() {
        Binding base = binding(SHA);
        Binding b = withSceneSources(base, Map.of("scene/1@v1", new SceneSourceAuthority(
                "source/v4", SHA, "rights/v1", "decision/scene-1", NOW.plusSeconds(300), 8)));
        var spec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7",
                "REAL_CAPTURE", "purpose/v1", List.of("scene/1@v1"), "timeline/v1",
                "rights/v1", List.of("profile/v1"));
        var plan = new MediaProductionSpecCompiler().compile(spec, b);
        CurrentState current = state(b, "capture-source-0", "scene/1@v1");

        MediaProductionAdmissionBinding.requireCurrent(b, plan, "capture-source-0", "scene/1@v1", current);
        assertCaptureFailureWithoutEffect(b, plan, withoutGlobalAuthority(current),
                AdmissionFailure.AUTHORITY_STATE_UNAVAILABLE);
        assertCaptureFailureWithoutEffect(b, plan, copyGlobalRights(current, "rights/revoked-global"),
                AdmissionFailure.RIGHTS_STALE);

        assertCaptureFailureWithoutEffect(b, plan, copyGlobalAuthority(current,
                "decision/revoked-global", NOW.plusSeconds(600), 3), AdmissionFailure.RIGHTS_STALE);
        assertCaptureFailureWithoutEffect(b, plan, copyGlobalAuthority(current,
                "decision/rights-4", NOW.minusSeconds(1), 3), AdmissionFailure.RIGHTS_STALE);
        assertCaptureFailureWithoutEffect(b, plan, copyGlobalAuthority(current,
                "decision/rights-4", NOW.plusSeconds(600), 4), AdmissionFailure.RIGHTS_REVOKED);
    }

    private static void assertCaptureFailureWithoutEffect(Binding b,
            MediaProductionSpecCompiler.CompiledPlan plan, CurrentState state, AdmissionFailure failure) {
        AtomicInteger effects = new AtomicInteger();
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(b, plan,
                "capture-source-0", "scene/1@v1", () -> state, effects::incrementAndGet))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(failure);
        assertThat(effects).hasValue(0);
    }

    private static CurrentState copyGlobalAuthority(CurrentState s, String decisionRef,
            Instant expiresAt, long revocationEpoch) {
        return new CurrentState(s.identityContextRef(), s.identityContextSha256(), s.identityEpoch(),
                s.tenantId(), s.principalId(), s.delegationRef(), s.workspaceRef(), s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(),
                s.revocationEpoch(), s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(),
                s.qualificationRef(), s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(),
                s.quoteVersion(), s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(),
                s.lockScopeKind(), s.lockTargetRef(), s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(),
                s.lockExpiresAt(), s.canonicalRequestId(), s.canonicalRequestFingerprint(), s.clocks(), s.observedAt(),
                decisionRef, expiresAt, revocationEpoch, s.globalRightsRef());
    }

    private static CurrentState copyGlobalRights(CurrentState s, String rightsRef) {
        return new CurrentState(s.identityContextRef(), s.identityContextSha256(), s.identityEpoch(),
                s.tenantId(), s.principalId(), s.delegationRef(), s.workspaceRef(), s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(),
                s.revocationEpoch(), s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(),
                s.qualificationRef(), s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(),
                s.quoteVersion(), s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(),
                s.lockScopeKind(), s.lockTargetRef(), s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(),
                s.lockExpiresAt(), s.canonicalRequestId(), s.canonicalRequestFingerprint(), s.clocks(), s.observedAt(),
                s.globalOwnerDecisionRef(), s.globalDecisionExpiresAt(), s.globalRevocationEpoch(), rightsRef);
    }

    private static CurrentState withoutGlobalAuthority(CurrentState s) {
        return new CurrentState(s.identityContextRef(), s.identityContextSha256(), s.identityEpoch(),
                s.tenantId(), s.principalId(), s.delegationRef(), s.workspaceRef(), s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(),
                s.revocationEpoch(), s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(),
                s.qualificationRef(), s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(),
                s.quoteVersion(), s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(),
                s.lockScopeKind(), s.lockTargetRef(), s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(),
                s.lockExpiresAt(), s.canonicalRequestId(), s.canonicalRequestFingerprint(), s.clocks(), s.observedAt(),
                null, null, -1, null);
    }

    @Test
    void currentEnvelopePassesButRuntimeEffectRemainsClosedUntilIndependentSourceReview() {
        Binding binding = binding(SHA);
        MediaProductionAdmissionBinding.requireCurrent(binding, "render-profile-0", state(binding, "render-profile-0"));
        AtomicInteger effects = new AtomicInteger();
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(binding, "render-profile-0",
                () -> state(binding, "render-profile-0"), effects::incrementAndGet))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.SOURCE_REVIEW_NOT_ADMITTED);
        assertThat(effects).hasValue(0);
    }

    @Test
    void incompleteAuthorityReadbackUsesTypedUnavailableFailureBeforeEffect() {
        Binding b = binding(SHA);
        CurrentState good = state(b, "render-profile-0");
        assertFailure(b, copy(good, good.tenantId(), good.principalId(), null, good.rightsExpiresAt(),
                good.reservationId(), good.lockOwnerPrincipalId(), good.lockEpoch(), good.clocks()),
                AdmissionFailure.AUTHORITY_STATE_UNAVAILABLE);
        assertFailure(b, replace(good, good.tenantId(), good.principalId(), good.purposeRef(),
                good.sourceVersionRef(), good.revocationEpoch(), good.engineBuildSha256(), good.qualified(),
                good.quoteVersion(), null, good.lockOwnerPrincipalId(), good.lockEpoch(), good.lockExpiresAt(),
                good.clocks()), AdmissionFailure.AUTHORITY_STATE_UNAVAILABLE);
        assertFailure(b, copyWithLockExpiry(good, null), AdmissionFailure.AUTHORITY_STATE_UNAVAILABLE);
        AtomicInteger effects = new AtomicInteger();
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(b, "render-profile-0", () -> {
            throw new IllegalStateException("authority store unavailable");
        }, effects::incrementAndGet))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.AUTHORITY_STATE_UNAVAILABLE);
        assertThat(effects).hasValue(0);
    }

    @Test
    void dispatchRetryAndRestartEachRecheckCurrentAuthorityBeforeAnyEffect() {
        Binding b = binding(SHA);
        CurrentState stale = copy(state(b, "render-profile-0"), "tenant-else", "principal-1", "rev-7", NOW.plusSeconds(600),
                "reservation-r1", "principal-1", 9, b.clocks());
        AtomicInteger reads = new AtomicInteger();
        AtomicInteger effects = new AtomicInteger();
        for (String attempt : List.of("dispatch", "retry", "restart")) {
            assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(b, "render-profile-0", () -> {
                reads.incrementAndGet();
                return stale;
            }, effects::incrementAndGet))
                    .as(attempt + " must be denied before provider I/O")
                    .isInstanceOf(AdmissionException.class)
                    .extracting(error -> ((AdmissionException) error).failure())
                    .isEqualTo(AdmissionFailure.TENANT_MISMATCH);
        }
        assertThat(reads).hasValue(3);
        assertThat(effects).hasValue(0);
    }

    @Test
    void duplicateRequestKeyWithDifferentFingerprintIsDeniedAndSameFingerprintRequiresReconciliation() {
        Binding b = binding(SHA);
        CurrentState good = state(b, "render-profile-0");
        CurrentState conflicting = copyAttempt(good, "request-1", "sha256:" + "b".repeat(64));
        AtomicInteger effects = new AtomicInteger();
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(b, "render-profile-0",
                () -> conflicting, effects::incrementAndGet))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.IDEMPOTENCY_CONFLICT);
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(b, "render-profile-0",
                () -> copyAttempt(good, "request-1", SHA), effects::incrementAndGet))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.RECONCILE_EXISTING_ATTEMPT);
        assertThat(effects).hasValue(0);
    }

    @Test
    void tenantProjectRightsQuoteLockAndClockDriftAreTypedPreEffectFailures() {
        Binding b = binding(SHA);
        CurrentState good = state(b, "render-profile-0");
        assertFailure(b, copy(good, "tenant-2", good.principalId(), good.projectRevision(), good.rightsExpiresAt(),
                good.reservationId(), good.lockOwnerPrincipalId(), good.lockEpoch(), good.clocks()), AdmissionFailure.TENANT_MISMATCH);
        assertFailure(b, copy(good, good.tenantId(), good.principalId(), "rev-8", good.rightsExpiresAt(),
                good.reservationId(), good.lockOwnerPrincipalId(), good.lockEpoch(), good.clocks()), AdmissionFailure.PROJECT_REVISION_STALE);
        assertFailure(b, copy(good, good.tenantId(), good.principalId(), good.projectRevision(), NOW.minusSeconds(1),
                good.reservationId(), good.lockOwnerPrincipalId(), good.lockEpoch(), good.clocks()), AdmissionFailure.RIGHTS_STALE);
        assertFailure(b, copyWithRights(good, "rights/other@v1"), AdmissionFailure.RIGHTS_STALE);
        assertFailure(b, copyWithIdentity(good, "identity-context/other", SHA, 12,
                good.delegationRef(), good.workspaceRef()), AdmissionFailure.IDENTITY_CONTEXT_MISMATCH);
        assertFailure(b, copyWithIdentity(good, good.identityContextRef(), "sha256:" + "b".repeat(64), 12,
                good.delegationRef(), good.workspaceRef()), AdmissionFailure.IDENTITY_CONTEXT_MISMATCH);
        assertFailure(b, copyWithIdentity(good, good.identityContextRef(), good.identityContextSha256(), 13,
                good.delegationRef(), good.workspaceRef()), AdmissionFailure.IDENTITY_EPOCH_MISMATCH);
        assertFailure(b, copyWithIdentity(good, good.identityContextRef(), good.identityContextSha256(), 12,
                "delegation/other", good.workspaceRef()), AdmissionFailure.DELEGATION_MISMATCH);
        assertFailure(b, copyWithIdentity(good, good.identityContextRef(), good.identityContextSha256(), 12,
                good.delegationRef(), "workspace/other"), AdmissionFailure.WORKSPACE_MISMATCH);
        assertFailure(b, replace(good, "tenant-1", "principal-2", "purpose/v1", "source/v4", 3,
                SHA, true, "tariff/v5", good.remainingCost(), "principal-1", 9, good.lockExpiresAt(), good.clocks()), AdmissionFailure.PRINCIPAL_MISMATCH);
        assertFailure(b, replace(good, "tenant-1", "principal-1", "purpose/other", "source/v4", 3,
                SHA, true, "tariff/v5", good.remainingCost(), "principal-1", 9, good.lockExpiresAt(), good.clocks()), AdmissionFailure.PURPOSE_MISMATCH);
        assertFailure(b, replace(good, "tenant-1", "principal-1", "purpose/v1", "source/v5", 3,
                SHA, true, "tariff/v5", good.remainingCost(), "principal-1", 9, good.lockExpiresAt(), good.clocks()), AdmissionFailure.SOURCE_MISMATCH);
        assertFailure(b, copyWithSourceSha(good, "sha256:" + "b".repeat(64)), AdmissionFailure.SOURCE_MISMATCH);
        assertFailure(b, replace(good, "tenant-1", "principal-1", "purpose/v1", "source/v4", 4,
                SHA, true, "tariff/v5", good.remainingCost(), "principal-1", 9, good.lockExpiresAt(), good.clocks()), AdmissionFailure.RIGHTS_REVOKED);
        assertFailure(b, replace(good, "tenant-1", "principal-1", "purpose/v1", "source/v4", 3,
                "sha256:" + "b".repeat(64), true, "tariff/v5", good.remainingCost(), "principal-1", 9,
                good.lockExpiresAt(), good.clocks()), AdmissionFailure.ENGINE_MISMATCH);
        assertFailure(b, replace(good, "tenant-1", "principal-1", "purpose/v1", "source/v4", 3,
                SHA, false, "tariff/v5", good.remainingCost(), "principal-1", 9, good.lockExpiresAt(), good.clocks()), AdmissionFailure.PROVIDER_UNQUALIFIED);
        assertFailure(b, replace(good, "tenant-1", "principal-1", "purpose/v1", "source/v4", 3,
                SHA, true, "tariff/v5", new BoundedAmount(9, "usd-micros"), "principal-1", 9,
                good.lockExpiresAt(), good.clocks()), AdmissionFailure.BUDGET_EXCEEDED);
        assertFailure(b, replace(good, "tenant-1", "principal-1", "purpose/v1", "source/v4", 3,
                SHA, true, "tariff/old", good.remainingCost(), "principal-1", 9, good.lockExpiresAt(), good.clocks()), AdmissionFailure.QUOTE_STALE);
        assertFailure(b, copyWithLockExpiry(good, NOW.minusSeconds(1)), AdmissionFailure.EDIT_LOCK_INVALID);
        CurrentState noEngineState = state(b, "capture-source-0", "scene/1@v1");
        var captureSpec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7",
                "REAL_CAPTURE", "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/v1", List.of("profile/v1"));
        var capturePlan = new MediaProductionSpecCompiler().compile(captureSpec, b);
        MediaProductionAdmissionBinding.requireCurrent(b, capturePlan, "capture-source-0", "scene/1@v1", noEngineState);
        CurrentState engineOnEngineFreeNode = copyWithEngine(noEngineState, "ENGINE", "renderer-v3", SHA);
        AtomicInteger effects = new AtomicInteger();
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(b, capturePlan, "capture-source-0", "scene/1@v1",
                () -> engineOnEngineFreeNode, effects::incrementAndGet))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.ENGINE_MISMATCH);
        assertThat(effects).hasValue(0);
        assertFailure(b, copy(good, good.tenantId(), good.principalId(), good.projectRevision(), good.rightsExpiresAt(),
                "reservation/other", good.lockOwnerPrincipalId(), good.lockEpoch(), good.clocks()), AdmissionFailure.RESERVATION_MISMATCH);
        assertFailure(b, copy(good, good.tenantId(), good.principalId(), good.projectRevision(), good.rightsExpiresAt(),
                good.reservationId(), "principal-2", good.lockEpoch(), good.clocks()), AdmissionFailure.EDIT_LOCK_INVALID);
        assertFailure(b, copy(good, good.tenantId(), good.principalId(), good.projectRevision(), good.rightsExpiresAt(),
                good.reservationId(), good.lockOwnerPrincipalId(), good.lockEpoch() + 1, good.clocks()), AdmissionFailure.EDIT_LOCK_INVALID);
        assertFailure(b, copy(good, good.tenantId(), good.principalId(), good.projectRevision(), good.rightsExpiresAt(),
                good.reservationId(), good.lockOwnerPrincipalId(), good.lockEpoch(),
                new ClockBindings("story/v2", "media/v1", "simulation/v1", "wall/v1",
                        List.of(new ClockConversion("story/v2", "media/v1", new Rational(25, 1))))), AdmissionFailure.CLOCK_MISMATCH);
    }

    @Test
    void missingDigestAndUnderReservationAreRejectedAtConstruction() {
        assertThatThrownBy(() -> new Engine("SOLVER", "solver-v1", "unknown"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Engine("ENGINE", "renderer-v1", "SHA256:" + "a".repeat(64)))
                .isInstanceOf(IllegalArgumentException.class);
        assertThat(noEngine()).isEqualTo(new Engine("NO_ENGINE", "NO_ENGINE", "NO_ENGINE"));
        assertThatThrownBy(() -> new Engine("NO_ENGINE", "NO_ENGINE", SHA))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Engine("ENGINE", "NO_ENGINE", "NO_ENGINE"))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Reservation("quote/v1", "tariff/v1", "reservation-v1",
                new BoundedAmount(11, "usd-micros"), new BoundedAmount(10, "usd-micros"),
                new BoundedAmount(1, "cpu-ms"), new BoundedAmount(1, "cpu-ms"),
                new BoundedAmount(1, "wall-ms"), new BoundedAmount(1, "wall-ms")))
                .isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new Reservation("quote/v1", "tariff/v1", "reservation-v1",
                new BoundedAmount(10, "usd-micros"), new BoundedAmount(10, "usd-cents"),
                new BoundedAmount(1, "cpu-ms"), new BoundedAmount(1, "cpu-ms"),
                new BoundedAmount(1, "wall-ms"), new BoundedAmount(1, "wall-ms")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessageContaining("same unit");
    }

    @Test
    void sceneAndOutputLocksMustMatchTheirExactCompiledTargetsBeforeEffect() {
        Binding b = binding(SHA);
        CurrentState renderState = state(b, "render-profile-0");
        CurrentState wrongScope = copyWithLockTarget(renderState, "SCENE", "scene/1@v1");
        assertFailure(b, wrongScope, AdmissionFailure.EDIT_LOCK_INVALID);

        CurrentState wrongOutput = copyWithLockTarget(renderState, "OUTPUT", "profile/other@v1");
        assertFailure(b, wrongOutput, AdmissionFailure.EDIT_LOCK_INVALID);

        AtomicInteger unmappedEffect = new AtomicInteger();
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(b, "compose-timeline",
                () -> state(b, "compose-timeline"), unmappedEffect::incrementAndGet))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.EDIT_LOCK_INVALID);
        assertThat(unmappedEffect).hasValue(0);

        var compiler = new MediaProductionSpecCompiler();
        var spec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v1", "scene/2@v1"), "timeline/v1", "rights/v1",
                List.of("profile/v1"));
        Map<String, Engine> engines = new java.util.TreeMap<>(b.enginesByStep());
        engines.put("capture-source-1", noEngine());
        Binding onlyFirstScene = new Binding(b.schemaVersion(), b.projectId(), b.expectedProjectRevision(),
                b.requestIdentity(), engines, b.provider(), b.reservation(), b.authority(),
                b.editLocksByStep(), b.clocks(), b.sourceBindingsByScene());
        assertThatThrownBy(() -> compiler.compile(spec, onlyFirstScene))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.MULTI_SOURCE_AUTHORITY_UNMAPPED);
    }

    @Test
    void identityTupleMismatchIsRejectedBeforeEditLockCas() {
        Binding b = binding(SHA);
        var spec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/v1", List.of("profile/v1"));
        var plan = new MediaProductionSpecCompiler().compile(spec, b);
        CurrentState good = state(b, "render-profile-0");
        List<Map.Entry<CurrentState, AdmissionFailure>> mismatches = List.of(
                Map.entry(copy(good, "tenant-other", good.principalId(), good.projectRevision(), good.rightsExpiresAt(),
                        good.reservationId(), good.lockOwnerPrincipalId(), good.lockEpoch(), good.clocks()), AdmissionFailure.TENANT_MISMATCH),
                Map.entry(copy(good, good.tenantId(), "principal-other", good.projectRevision(), good.rightsExpiresAt(),
                        good.reservationId(), good.lockOwnerPrincipalId(), good.lockEpoch(), good.clocks()), AdmissionFailure.PRINCIPAL_MISMATCH),
                Map.entry(copyWithIdentity(good, good.identityContextRef(), good.identityContextSha256(), 12,
                        "delegation/other", good.workspaceRef()), AdmissionFailure.DELEGATION_MISMATCH),
                Map.entry(copyWithIdentity(good, good.identityContextRef(), good.identityContextSha256(), 12,
                        good.delegationRef(), "workspace/other"), AdmissionFailure.WORKSPACE_MISMATCH),
                Map.entry(copyWithIdentity(good, good.identityContextRef(), good.identityContextSha256(), 13,
                        good.delegationRef(), good.workspaceRef()), AdmissionFailure.IDENTITY_EPOCH_MISMATCH),
                Map.entry(copyWithIdentity(good, good.identityContextRef(), "sha256:" + "b".repeat(64), 12,
                        good.delegationRef(), good.workspaceRef()), AdmissionFailure.IDENTITY_CONTEXT_MISMATCH));
        AtomicInteger casCalls = new AtomicInteger();

        for (Map.Entry<CurrentState, AdmissionFailure> mismatch : mismatches) {
            Map<String, CurrentState> current = Map.of("capture-source-0", state(b, "capture-source-0"),
                    "render-profile-0", mismatch.getKey());
            assertThatThrownBy(() -> MediaProductionAdmissionBinding.acquireEditLocks(b, plan, current,
                    (project, revision, locks, identityFence) -> {
                        casCalls.incrementAndGet();
                        return true;
                    }, NOW))
                    .isInstanceOf(AdmissionException.class)
                    .extracting(error -> ((AdmissionException) error).failure())
                    .isEqualTo(mismatch.getValue());
        }
        assertThat(casCalls).hasValue(0);
    }

    @Test
    void staleFutureAndMixedObservationTimesAreRejectedBeforeEditLockCas() {
        Binding b = binding(SHA);
        var spec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/v1", List.of("profile/v1"));
        var plan = new MediaProductionSpecCompiler().compile(spec, b);
        CurrentState capture = state(b, "capture-source-0");
        CurrentState render = state(b, "render-profile-0");
        List<Map<String, CurrentState>> snapshots = List.of(
                Map.of("capture-source-0", copyWithObservedAt(capture, NOW.minusSeconds(1)),
                        "render-profile-0", copyWithObservedAt(render, NOW.minusSeconds(1))),
                Map.of("capture-source-0", copyWithObservedAt(capture, NOW.plusSeconds(1)),
                        "render-profile-0", copyWithObservedAt(render, NOW.plusSeconds(1))),
                Map.of("capture-source-0", capture,
                        "render-profile-0", copyWithObservedAt(render, NOW.plusSeconds(1))));
        AtomicInteger casCalls = new AtomicInteger();
        ProjectEditLockCas cas = (project, revision, locks, identityFence) -> {
            casCalls.incrementAndGet();
            return true;
        };

        for (Map<String, CurrentState> snapshot : snapshots) {
            assertThatThrownBy(() -> MediaProductionAdmissionBinding.acquireEditLocks(b, plan, snapshot, cas, NOW))
                    .isInstanceOf(AdmissionException.class)
                    .extracting(error -> ((AdmissionException) error).failure())
                    .isEqualTo(AdmissionFailure.IDENTITY_OBSERVATION_TIME_MISMATCH);
        }
        assertThat(casCalls).hasValue(0);
    }

    @Test
    void callerClaimedMatchingTimesNeverReachEditLockCasWithoutTrustedAdapter() {
        Binding b = binding(SHA);
        var spec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/v1", List.of("profile/v1"));
        var plan = new MediaProductionSpecCompiler().compile(spec, b);
        AtomicInteger casCalls = new AtomicInteger();
        ProjectEditLockCas cas = (project, revision, locks, identityFence) -> {
            casCalls.incrementAndGet();
            return true;
        };

        for (int attempt = 0; attempt < 2; attempt++) {
            Map<String, CurrentState> observations = Map.of(
                    "capture-source-0", state(b, "capture-source-0"),
                    "render-profile-0", state(b, "render-profile-0"));
            assertThatThrownBy(() -> MediaProductionAdmissionBinding.acquireEditLocks(b, plan, observations, cas, NOW))
                    .isInstanceOf(AdmissionException.class)
                    .extracting(error -> ((AdmissionException) error).failure())
                    .isEqualTo(AdmissionFailure.AUTHORITY_STATE_UNAVAILABLE);
        }
        assertThat(casCalls).hasValue(0);
    }

    @Test
    void matchingStaleAndFutureSnapshotTimesFailClosedBeforeEditLockCas() {
        Binding b = binding(SHA);
        var spec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/v1", List.of("profile/v1"));
        var plan = new MediaProductionSpecCompiler().compile(spec, b);
        CurrentState capture = state(b, "capture-source-0");
        CurrentState render = state(b, "render-profile-0");
        List<Instant> claimedTimes = List.of(NOW.minusSeconds(3600), NOW.plusSeconds(1), NOW);
        AtomicInteger casCalls = new AtomicInteger();
        ProjectEditLockCas cas = (project, revision, locks, identityFence) -> {
            casCalls.incrementAndGet();
            return true;
        };

        for (Instant claimedAt : claimedTimes) {
            Map<String, CurrentState> sameClaimedTime = Map.of(
                    "capture-source-0", copyWithObservedAt(capture, claimedAt),
                    "render-profile-0", copyWithObservedAt(render, claimedAt));
            assertThatThrownBy(() -> MediaProductionAdmissionBinding.acquireEditLocks(
                    b, plan, sameClaimedTime, cas, claimedAt))
                    .isInstanceOf(AdmissionException.class)
                    .extracting(error -> ((AdmissionException) error).failure())
                    .isEqualTo(AdmissionFailure.AUTHORITY_STATE_UNAVAILABLE);
        }
        assertThat(casCalls).hasValue(0);
    }

    @Test
    void editLockCasRejectsStalePlanAndForeignLockOwnerBeforeCallingAuthority() {
        Binding b = binding(SHA);
        var compiler = new MediaProductionSpecCompiler();
        var spec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/v1", List.of("profile/v1"));
        var plan = compiler.compile(spec, b);
        AtomicInteger casCalls = new AtomicInteger();
        ProjectEditLockCas cas = (project, revision, locks, identityFence) -> {
            casCalls.incrementAndGet();
            return true;
        };
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.acquireEditLocks(b, plan, cas, NOW))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.AUTHORITY_STATE_UNAVAILABLE);
        assertThat(casCalls).hasValue(0);

        var staleSpec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-8", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/v1", List.of("profile/v1"));
        var stalePlan = compiler.compile(staleSpec);
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.acquireEditLocks(b, stalePlan, cas))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.PROJECT_REVISION_STALE);
        assertThat(casCalls).hasValue(0);

        var unboundPlan = compiler.compile(spec);
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.acquireEditLocks(b, unboundPlan, cas))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.BINDING_SPEC_MISMATCH);
        assertThat(casCalls).hasValue(0);

        var reconstructedPlan = new MediaProductionSpecCompiler.CompiledPlan(plan.schemaVersion(), plan.projectRevision(),
                plan.originClass(), plan.nodes(), plan.planFingerprint(), plan.inputProvenance(),
                plan.admissionBindingFingerprint());
        assertThat(reconstructedPlan).isEqualTo(plan);
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.acquireEditLocks(b, reconstructedPlan, cas))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.PLAN_PROVENANCE_INVALID);
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.requireCurrent(b, reconstructedPlan,
                "capture-source-0", "scene/1@v1", state(b, "capture-source-0", "scene/1@v1")))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.PLAN_PROVENANCE_INVALID);
        assertThat(casCalls).hasValue(0);

        Map<String, EditLock> foreignLocks = new java.util.TreeMap<>(b.editLocksByStep());
        EditLock sceneLock = foreignLocks.get("capture-source-0");
        foreignLocks.put("capture-source-0", new EditLock(sceneLock.scopeKind(), sceneLock.targetRef(),
                "foreign-principal", sceneLock.leaseId(), sceneLock.epoch(), sceneLock.expiresAt()));
        Binding foreignOwner = new Binding(b.schemaVersion(), b.projectId(), b.expectedProjectRevision(),
                b.requestIdentity(), b.enginesByStep(), b.provider(), b.reservation(), b.authority(),
                foreignLocks, b.clocks(), b.sourceBindingsByScene());
        var foreignPlan = compiler.compile(spec, foreignOwner);
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.acquireEditLocks(foreignOwner, foreignPlan, cas))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.EDIT_LOCK_INVALID);
        assertThat(casCalls).hasValue(0);
    }

    @Test
    void editLockCasRejectsExpiredManualEditLocksBeforeCallingAuthority() {
        Binding base = binding(SHA);
        Map<String, EditLock> expiredLocks = new java.util.TreeMap<>(base.editLocksByStep());
        expiredLocks.replaceAll((step, lock) -> new EditLock(lock.scopeKind(), lock.targetRef(),
                lock.ownerPrincipalId(), lock.leaseId(), lock.epoch(), NOW));
        Binding expired = new Binding(base.schemaVersion(), base.projectId(), base.expectedProjectRevision(),
                base.requestIdentity(), base.enginesByStep(), base.provider(), base.reservation(), base.authority(),
                expiredLocks, base.clocks(), base.sourceBindingsByScene());
        var spec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/v1", List.of("profile/v1"));
        var plan = new MediaProductionSpecCompiler().compile(spec, expired);
        AtomicInteger casCalls = new AtomicInteger();

        assertThatThrownBy(() -> MediaProductionAdmissionBinding.acquireEditLocks(expired, plan,
                (project, revision, locks, identityFence) -> {
                    casCalls.incrementAndGet();
                    return true;
                }, NOW))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.EDIT_LOCK_INVALID);
        assertThat(casCalls).hasValue(0);
    }

    private static void assertFailure(Binding b, CurrentState current, AdmissionFailure failure) {
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.requireCurrent(b, "render-profile-0", current))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(failure);
        AtomicInteger effects = new AtomicInteger();
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(
                b, "render-profile-0", () -> current, effects::incrementAndGet))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(failure);
        assertThat(effects).hasValue(0);
    }

    private static CurrentState copy(CurrentState s, String tenant, String principal, String revision,
            Instant rightsExpiry, String reservation, String lockOwner, long lockEpoch, ClockBindings clocks) {
        return new CurrentState(s.identityContextRef(), s.identityContextSha256(), s.identityEpoch(),
                tenant, principal, s.delegationRef(), s.workspaceRef(), s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), revision, s.rightsRef(), s.ownerDecisionRef(), rightsExpiry, s.revocationEpoch(),
                s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(),
                s.quoteVersion(), reservation, s.remainingCost(), s.remainingCompute(), s.remainingTime(),
                s.lockScopeKind(), s.lockTargetRef(), lockOwner, s.lockLeaseId(), lockEpoch, s.lockExpiresAt(), s.canonicalRequestId(),
                s.canonicalRequestFingerprint(), clocks, s.observedAt(), s.globalOwnerDecisionRef(), s.globalDecisionExpiresAt(), s.globalRevocationEpoch(), s.globalRightsRef());
    }

    private static CurrentState copyWithRights(CurrentState s, String rightsRef) {
        return new CurrentState(s.identityContextRef(), s.identityContextSha256(), s.identityEpoch(),
                s.tenantId(), s.principalId(), s.delegationRef(), s.workspaceRef(), s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), s.projectRevision(), rightsRef, s.ownerDecisionRef(), s.rightsExpiresAt(), s.revocationEpoch(),
                s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(), s.quoteVersion(),
                s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(), s.lockScopeKind(), s.lockTargetRef(),
                s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(), s.lockExpiresAt(), s.canonicalRequestId(),
                s.canonicalRequestFingerprint(), s.clocks(), s.observedAt(), s.globalOwnerDecisionRef(), s.globalDecisionExpiresAt(), s.globalRevocationEpoch(), s.globalRightsRef());
    }

    private static CurrentState copyAttempt(CurrentState s, String requestId, String fingerprint) {
        return new CurrentState(s.identityContextRef(), s.identityContextSha256(), s.identityEpoch(),
                s.tenantId(), s.principalId(), s.delegationRef(), s.workspaceRef(), s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(), s.revocationEpoch(),
                s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(), s.quoteVersion(),
                s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(), s.lockScopeKind(), s.lockTargetRef(),
                s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(), s.lockExpiresAt(), requestId, fingerprint,
                s.clocks(), s.observedAt(), s.globalOwnerDecisionRef(), s.globalDecisionExpiresAt(), s.globalRevocationEpoch(), s.globalRightsRef());
    }

    private static CurrentState copyWithSourceSha(CurrentState s, String sourceSha) {
        return new CurrentState(s.identityContextRef(), s.identityContextSha256(), s.identityEpoch(),
                s.tenantId(), s.principalId(), s.delegationRef(), s.workspaceRef(), s.purposeRef(), s.sourceVersionRef(), sourceSha,
                s.projectId(), s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(), s.revocationEpoch(),
                s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(), s.quoteVersion(),
                s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(), s.lockScopeKind(), s.lockTargetRef(),
                s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(), s.lockExpiresAt(), s.canonicalRequestId(),
                s.canonicalRequestFingerprint(), s.clocks(), s.observedAt(), s.globalOwnerDecisionRef(), s.globalDecisionExpiresAt(), s.globalRevocationEpoch(), s.globalRightsRef());
    }

    private static CurrentState copyWithLockExpiry(CurrentState s, Instant expiry) {
        return new CurrentState(s.identityContextRef(), s.identityContextSha256(), s.identityEpoch(),
                s.tenantId(), s.principalId(), s.delegationRef(), s.workspaceRef(), s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(), s.revocationEpoch(),
                s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(), s.quoteVersion(),
                s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(), s.lockScopeKind(), s.lockTargetRef(),
                s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(), expiry, s.canonicalRequestId(),
                s.canonicalRequestFingerprint(), s.clocks(), s.observedAt(), s.globalOwnerDecisionRef(), s.globalDecisionExpiresAt(), s.globalRevocationEpoch(), s.globalRightsRef());
    }

    private static CurrentState copyWithLockTarget(CurrentState s, String scopeKind, String targetRef) {
        return new CurrentState(s.identityContextRef(), s.identityContextSha256(), s.identityEpoch(),
                s.tenantId(), s.principalId(), s.delegationRef(), s.workspaceRef(), s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(), s.revocationEpoch(),
                s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(), s.quoteVersion(),
                s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(), scopeKind, targetRef,
                s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(), s.lockExpiresAt(), s.canonicalRequestId(),
                s.canonicalRequestFingerprint(), s.clocks(), s.observedAt(), s.globalOwnerDecisionRef(), s.globalDecisionExpiresAt(), s.globalRevocationEpoch(), s.globalRightsRef());
    }

    private static CurrentState copyWithEngine(CurrentState s, String kind, String identity, String digest) {
        return new CurrentState(s.identityContextRef(), s.identityContextSha256(), s.identityEpoch(),
                s.tenantId(), s.principalId(), s.delegationRef(), s.workspaceRef(), s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(), s.revocationEpoch(),
                kind, identity, digest, s.providerId(), s.qualificationRef(), s.qualificationSha256(), s.providerRightsRef(),
                s.qualified(), s.quoteRef(), s.quoteVersion(), s.reservationId(), s.remainingCost(), s.remainingCompute(),
                s.remainingTime(), s.lockScopeKind(), s.lockTargetRef(), s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(),
                s.lockExpiresAt(), s.canonicalRequestId(), s.canonicalRequestFingerprint(), s.clocks(), s.observedAt(), s.globalOwnerDecisionRef(), s.globalDecisionExpiresAt(), s.globalRevocationEpoch(), s.globalRightsRef());
    }

    private static CurrentState copyWithIdentity(CurrentState s, String contextRef, String contextSha,
            long identityEpoch, String delegationRef, String workspaceRef) {
        return new CurrentState(contextRef, contextSha, identityEpoch, s.tenantId(), s.principalId(),
                delegationRef, workspaceRef, s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(), s.projectId(),
                s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(), s.revocationEpoch(),
                s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(), s.quoteVersion(),
                s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(), s.lockScopeKind(),
                s.lockTargetRef(), s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(), s.lockExpiresAt(),
                s.canonicalRequestId(), s.canonicalRequestFingerprint(), s.clocks(), s.observedAt(),
                s.globalOwnerDecisionRef(), s.globalDecisionExpiresAt(), s.globalRevocationEpoch(), s.globalRightsRef());
    }

    private static CurrentState copyWithObservedAt(CurrentState s, Instant observedAt) {
        return new CurrentState(s.identityContextRef(), s.identityContextSha256(), s.identityEpoch(),
                s.tenantId(), s.principalId(), s.delegationRef(), s.workspaceRef(), s.purposeRef(),
                s.sourceVersionRef(), s.sourceSha256(), s.projectId(), s.projectRevision(), s.rightsRef(),
                s.ownerDecisionRef(), s.rightsExpiresAt(), s.revocationEpoch(), s.engineIdentityKind(),
                s.engineIdentity(), s.engineBuildSha256(), s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(), s.quoteVersion(),
                s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(), s.lockScopeKind(),
                s.lockTargetRef(), s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(), s.lockExpiresAt(),
                s.canonicalRequestId(), s.canonicalRequestFingerprint(), s.clocks(), observedAt,
                s.globalOwnerDecisionRef(), s.globalDecisionExpiresAt(), s.globalRevocationEpoch(), s.globalRightsRef());
    }

    private static CurrentState replace(CurrentState s, String tenant, String principal, String purpose,
            String sourceVersion, long revocationEpoch, String engineDigest, boolean qualified,
            String quoteVersion, BoundedAmount remainingCost, String lockOwner, long lockEpoch,
            Instant lockExpiry, ClockBindings clocks) {
        return new CurrentState(s.identityContextRef(), s.identityContextSha256(), s.identityEpoch(),
                tenant, principal, s.delegationRef(), s.workspaceRef(), purpose, sourceVersion, s.sourceSha256(), s.projectId(),
                s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(), revocationEpoch,
                s.engineIdentityKind(), s.engineIdentity(), engineDigest, s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), qualified, s.quoteRef(), quoteVersion,
                s.reservationId(), remainingCost, s.remainingCompute(), s.remainingTime(), s.lockScopeKind(), s.lockTargetRef(),
                lockOwner, s.lockLeaseId(), lockEpoch, lockExpiry, s.canonicalRequestId(),
                s.canonicalRequestFingerprint(), clocks, s.observedAt(), s.globalOwnerDecisionRef(), s.globalDecisionExpiresAt(), s.globalRevocationEpoch(), s.globalRightsRef());
    }
}
