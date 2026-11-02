package com.ghatana.media.runtime;

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
import org.junit.jupiter.api.Test;

import java.time.Instant;
import java.util.List;
import java.util.Map;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.concurrent.atomic.AtomicReference;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.Executors;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaProductionAdmissionBindingTest {
    private static final Instant NOW = Instant.parse("2030-01-01T00:00:00Z");
    private static final String SHA = "sha256:" + "a".repeat(64);

    private static Binding binding(String engineDigest) {
        return new Binding(MediaProductionAdmissionBinding.SCHEMA_VERSION, "project-1", "rev-7",
                new RequestIdentity("request-1", SHA), Map.of(
                "validate-spec", noEngine(), "rights-review", noEngine(), "capture-source-0", noEngine(),
                "compose-timeline", noEngine(), "render-profile-0", new Engine("ENGINE", "renderer-v3", engineDigest),
                "publish-review", noEngine()),
                new ProviderQualification("local-renderer", "qualification/v2", "rights/render/v1", SHA, true),
                new Reservation("quote/q1", "tariff/v5", "reservation/r1",
                        new BoundedAmount(10, "usd-micros"), new BoundedAmount(12, "usd-micros"),
                        new BoundedAmount(100, "cpu-ms"), new BoundedAmount(120, "cpu-ms"),
                        new BoundedAmount(500, "wall-ms"), new BoundedAmount(600, "wall-ms")),
                new Authority("tenant-1", "principal-1", "purpose/v1", "rights/v1", "source/v4", SHA,
                        "decision/rights-4", NOW.plusSeconds(600), 3),
                Map.of(
                        "capture-source-0", new EditLock("SCENE", "scene/1@v1", "principal-1", "lease/scene", 9,
                                NOW.plusSeconds(300)),
                        "render-profile-0", new EditLock("OUTPUT", "profile/v1", "principal-1", "lease/output", 10,
                                NOW.plusSeconds(300))),
                new ClockBindings("story/v1", "media/v1", "simulation/v1", "wall/v1",
                        List.of(new ClockConversion("story/v1", "media/v1", new Rational(25, 1)))));
    }

    private static Engine noEngine() { return new Engine("NO_ENGINE", "NO_ENGINE", "NO_ENGINE"); }

    private static CurrentState state(Binding b, String stepId) {
        Engine engine = b.engineForStep(stepId);
        EditLock lock = b.editLocksByStep().getOrDefault(stepId,
                new EditLock("SCENE", "unmapped-target", "principal-1", "unmapped-lease", 1,
                        NOW.plusSeconds(300)));
        return new CurrentState(b.authority().tenantId(), b.authority().principalId(), b.authority().purposeRef(),
                b.authority().sourceVersionRef(), b.authority().sourceSha256(), b.projectId(),
                b.expectedProjectRevision(), b.authority().rightsRef(), b.authority().ownerDecisionRef(), b.authority().decisionExpiresAt(),
                b.authority().revocationEpoch(), engine.identityKind(), engine.identity(), engine.buildSha256(),
                b.provider().providerId(), b.provider().qualificationRef(), b.provider().qualificationSha256(),
                b.provider().rightsRef(), true, b.reservation().quoteRef(), b.reservation().quoteVersion(),
                b.reservation().reservationId(), new BoundedAmount(12, "usd-micros"),
                new BoundedAmount(120, "cpu-ms"), new BoundedAmount(600, "wall-ms"),
                lock.scopeKind(), lock.targetRef(), lock.ownerPrincipalId(), lock.leaseId(),
                lock.epoch(), lock.expiresAt(),
                null, null, b.clocks(), NOW);
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
        var wrongRights = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/other@v1", List.of("profile/v1"));
        assertThatThrownBy(() -> compiler.compile(wrongRights, b1))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.BINDING_SPEC_MISMATCH);
        Binding incompleteEngineMap = new Binding(b1.schemaVersion(), b1.projectId(), b1.expectedProjectRevision(),
                b1.requestIdentity(), Map.of("validate-spec", noEngine()), b1.provider(), b1.reservation(),
                b1.authority(), b1.editLocksByStep(), b1.clocks());
        assertThatThrownBy(() -> compiler.compile(spec, incompleteEngineMap))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.ENGINE_MISMATCH);
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
                "reservation/r1", "principal-1", 9, b.clocks());
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
        CurrentState noEngineState = state(b, "capture-source-0");
        MediaProductionAdmissionBinding.requireCurrent(b, "capture-source-0", noEngineState);
        CurrentState engineOnEngineFreeNode = copyWithEngine(noEngineState, "ENGINE", "renderer-v3", SHA);
        AtomicInteger effects = new AtomicInteger();
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.beforeEffect(b, "capture-source-0",
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
        assertThatThrownBy(() -> new Reservation("quote/v1", "tariff/v1", "reservation/v1",
                new BoundedAmount(11, "usd-micros"), new BoundedAmount(10, "usd-micros"),
                new BoundedAmount(1, "cpu-ms"), new BoundedAmount(1, "cpu-ms"),
                new BoundedAmount(1, "wall-ms"), new BoundedAmount(1, "wall-ms")))
                .isInstanceOf(IllegalArgumentException.class);
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
                b.editLocksByStep(), b.clocks());
        assertThatThrownBy(() -> compiler.compile(spec, onlyFirstScene))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.EDIT_LOCK_INVALID);
    }

    @Test
    void concurrentSameRevisionScopedLockCasHasOneWinner() throws Exception {
        Binding b = binding(SHA);
        var spec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/v1", List.of("profile/v1"));
        var plan = new MediaProductionSpecCompiler().compile(spec, b);
        AtomicReference<Map<String, EditLock>> current = new AtomicReference<>();
        ProjectEditLockCas cas = (project, revision, claim) -> project.equals("project-1")
                && revision.equals("rev-7") && current.compareAndSet(null, claim);
        CountDownLatch start = new CountDownLatch(1);
        var pool = Executors.newFixedThreadPool(2);
        try {
            var a = pool.submit(() -> { start.await(); return MediaProductionAdmissionBinding.acquireEditLocks(b, plan, cas); });
            var c = pool.submit(() -> { start.await(); return MediaProductionAdmissionBinding.acquireEditLocks(b, plan, cas); });
            start.countDown();
            assertThat(List.of(a.get(2, TimeUnit.SECONDS), c.get(2, TimeUnit.SECONDS)))
                    .containsExactlyInAnyOrder(true, false);
            assertThat(current.get()).isEqualTo(b.editLocksByStep());
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void editLockCasRejectsStalePlanAndForeignLockOwnerBeforeCallingAuthority() {
        Binding b = binding(SHA);
        var compiler = new MediaProductionSpecCompiler();
        var spec = new MediaProductionSpecCompiler.ProductionSpec("tenant-1", "project-1", "rev-7", "REAL_CAPTURE",
                "purpose/v1", List.of("scene/1@v1"), "timeline/v1", "rights/v1", List.of("profile/v1"));
        var plan = compiler.compile(spec, b);
        AtomicInteger casCalls = new AtomicInteger();
        ProjectEditLockCas cas = (project, revision, locks) -> {
            casCalls.incrementAndGet();
            return true;
        };

        var stalePlan = new MediaProductionSpecCompiler.CompiledPlan(plan.schemaVersion(), "rev-8",
                plan.originClass(), plan.nodes(), plan.planFingerprint(), plan.inputProvenance(),
                plan.admissionBindingFingerprint());
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.acquireEditLocks(b, stalePlan, cas))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.PROJECT_REVISION_STALE);
        assertThat(casCalls).hasValue(0);

        var unboundPlan = new MediaProductionSpecCompiler.CompiledPlan(plan.schemaVersion(), plan.projectRevision(),
                plan.originClass(), plan.nodes(), plan.planFingerprint(), plan.inputProvenance());
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.acquireEditLocks(b, unboundPlan, cas))
                .isInstanceOf(AdmissionException.class)
                .extracting(error -> ((AdmissionException) error).failure())
                .isEqualTo(AdmissionFailure.BINDING_SPEC_MISMATCH);
        assertThat(casCalls).hasValue(0);

        Map<String, EditLock> foreignLocks = new java.util.TreeMap<>(b.editLocksByStep());
        EditLock sceneLock = foreignLocks.get("capture-source-0");
        foreignLocks.put("capture-source-0", new EditLock(sceneLock.scopeKind(), sceneLock.targetRef(),
                "foreign-principal", sceneLock.leaseId(), sceneLock.epoch(), sceneLock.expiresAt()));
        Binding foreignOwner = new Binding(b.schemaVersion(), b.projectId(), b.expectedProjectRevision(),
                b.requestIdentity(), b.enginesByStep(), b.provider(), b.reservation(), b.authority(),
                foreignLocks, b.clocks());
        var foreignPlan = compiler.compile(spec, foreignOwner);
        assertThatThrownBy(() -> MediaProductionAdmissionBinding.acquireEditLocks(foreignOwner, foreignPlan, cas))
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
        return new CurrentState(tenant, principal, s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), revision, s.rightsRef(), s.ownerDecisionRef(), rightsExpiry, s.revocationEpoch(),
                s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(),
                s.quoteVersion(), reservation, s.remainingCost(), s.remainingCompute(), s.remainingTime(),
                s.lockScopeKind(), s.lockTargetRef(), lockOwner, s.lockLeaseId(), lockEpoch, s.lockExpiresAt(), s.canonicalRequestId(),
                s.canonicalRequestFingerprint(), clocks, s.observedAt());
    }

    private static CurrentState copyWithRights(CurrentState s, String rightsRef) {
        return new CurrentState(s.tenantId(), s.principalId(), s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), s.projectRevision(), rightsRef, s.ownerDecisionRef(), s.rightsExpiresAt(), s.revocationEpoch(),
                s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(), s.quoteVersion(),
                s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(), s.lockScopeKind(), s.lockTargetRef(),
                s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(), s.lockExpiresAt(), s.canonicalRequestId(),
                s.canonicalRequestFingerprint(), s.clocks(), s.observedAt());
    }

    private static CurrentState copyAttempt(CurrentState s, String requestId, String fingerprint) {
        return new CurrentState(s.tenantId(), s.principalId(), s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(), s.revocationEpoch(),
                s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(), s.quoteVersion(),
                s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(), s.lockScopeKind(), s.lockTargetRef(),
                s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(), s.lockExpiresAt(), requestId, fingerprint,
                s.clocks(), s.observedAt());
    }

    private static CurrentState copyWithSourceSha(CurrentState s, String sourceSha) {
        return new CurrentState(s.tenantId(), s.principalId(), s.purposeRef(), s.sourceVersionRef(), sourceSha,
                s.projectId(), s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(), s.revocationEpoch(),
                s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(), s.quoteVersion(),
                s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(), s.lockScopeKind(), s.lockTargetRef(),
                s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(), s.lockExpiresAt(), s.canonicalRequestId(),
                s.canonicalRequestFingerprint(), s.clocks(), s.observedAt());
    }

    private static CurrentState copyWithLockExpiry(CurrentState s, Instant expiry) {
        return new CurrentState(s.tenantId(), s.principalId(), s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(), s.revocationEpoch(),
                s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(), s.quoteVersion(),
                s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(), s.lockScopeKind(), s.lockTargetRef(),
                s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(), expiry, s.canonicalRequestId(),
                s.canonicalRequestFingerprint(), s.clocks(), s.observedAt());
    }

    private static CurrentState copyWithLockTarget(CurrentState s, String scopeKind, String targetRef) {
        return new CurrentState(s.tenantId(), s.principalId(), s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(), s.revocationEpoch(),
                s.engineIdentityKind(), s.engineIdentity(), s.engineBuildSha256(), s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), s.qualified(), s.quoteRef(), s.quoteVersion(),
                s.reservationId(), s.remainingCost(), s.remainingCompute(), s.remainingTime(), scopeKind, targetRef,
                s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(), s.lockExpiresAt(), s.canonicalRequestId(),
                s.canonicalRequestFingerprint(), s.clocks(), s.observedAt());
    }

    private static CurrentState copyWithEngine(CurrentState s, String kind, String identity, String digest) {
        return new CurrentState(s.tenantId(), s.principalId(), s.purposeRef(), s.sourceVersionRef(), s.sourceSha256(),
                s.projectId(), s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(), s.revocationEpoch(),
                kind, identity, digest, s.providerId(), s.qualificationRef(), s.qualificationSha256(), s.providerRightsRef(),
                s.qualified(), s.quoteRef(), s.quoteVersion(), s.reservationId(), s.remainingCost(), s.remainingCompute(),
                s.remainingTime(), s.lockScopeKind(), s.lockTargetRef(), s.lockOwnerPrincipalId(), s.lockLeaseId(), s.lockEpoch(),
                s.lockExpiresAt(), s.canonicalRequestId(), s.canonicalRequestFingerprint(), s.clocks(), s.observedAt());
    }

    private static CurrentState replace(CurrentState s, String tenant, String principal, String purpose,
            String sourceVersion, long revocationEpoch, String engineDigest, boolean qualified,
            String quoteVersion, BoundedAmount remainingCost, String lockOwner, long lockEpoch,
            Instant lockExpiry, ClockBindings clocks) {
        return new CurrentState(tenant, principal, purpose, sourceVersion, s.sourceSha256(), s.projectId(),
                s.projectRevision(), s.rightsRef(), s.ownerDecisionRef(), s.rightsExpiresAt(), revocationEpoch,
                s.engineIdentityKind(), s.engineIdentity(), engineDigest, s.providerId(), s.qualificationRef(),
                s.qualificationSha256(), s.providerRightsRef(), qualified, s.quoteRef(), quoteVersion,
                s.reservationId(), remainingCost, s.remainingCompute(), s.remainingTime(), s.lockScopeKind(), s.lockTargetRef(),
                lockOwner, s.lockLeaseId(), lockEpoch, lockExpiry, s.canonicalRequestId(),
                s.canonicalRequestFingerprint(), clocks, s.observedAt());
    }
}
