package com.ghatana.media.runtime;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.TreeMap;
import java.util.function.Supplier;

/**
 * H-02's separately versioned execution-admission envelope. This is a
 * fail-closed check over facts supplied by the existing runtime authority; it
 * owns no persistence and does not itself admit production execution.
 */
public final class MediaProductionAdmissionBinding {
    /** v3 intentionally supersedes v2 with mandatory exact per-scene source authority bindings. */
    public static final String SCHEMA_VERSION = "media.production.execution-admission.v3";

    private MediaProductionAdmissionBinding() { }

    public enum AdmissionFailure {
        TENANT_MISMATCH, PRINCIPAL_MISMATCH, PURPOSE_MISMATCH, SOURCE_MISMATCH,
        RIGHTS_STALE, RIGHTS_REVOKED, PROVIDER_UNQUALIFIED, ENGINE_MISMATCH,
        QUOTE_STALE, RESERVATION_MISMATCH, BUDGET_EXCEEDED, PROJECT_REVISION_STALE,
        EDIT_LOCK_INVALID, CLOCK_MISMATCH, BINDING_SPEC_MISMATCH,
        MULTI_SOURCE_AUTHORITY_UNMAPPED,
        IDEMPOTENCY_CONFLICT, RECONCILE_EXISTING_ATTEMPT,
        AUTHORITY_STATE_UNAVAILABLE, SOURCE_REVIEW_NOT_ADMITTED
    }

    public static final class AdmissionException extends IllegalStateException {
        private final AdmissionFailure failure;
        public AdmissionException(AdmissionFailure failure) {
            super("Production execution not admitted: " + failure);
            this.failure = Objects.requireNonNull(failure, "failure");
        }
        public AdmissionFailure failure() { return failure; }
    }

    public record Engine(String identityKind, String identity, String buildSha256) {
        public static final String NO_ENGINE = "NO_ENGINE";
        public Engine {
            if (!List.of("ENGINE", "MODEL", "SOLVER", NO_ENGINE).contains(identityKind))
                throw new IllegalArgumentException("identityKind must be ENGINE, MODEL, SOLVER, or NO_ENGINE");
            identity = required(identity, "engine.identity");
            if (NO_ENGINE.equals(identityKind) || NO_ENGINE.equals(identity)) {
                if (!NO_ENGINE.equals(identityKind) || !NO_ENGINE.equals(identity))
                    throw new IllegalArgumentException("NO_ENGINE identity and kind must be explicit together");
                if (!"NO_ENGINE".equals(buildSha256)) throw new IllegalArgumentException("NO_ENGINE requires NO_ENGINE digest");
            } else {
                buildSha256 = digest(buildSha256, "engine.buildSha256");
            }
        }
    }

    public record ProviderQualification(String providerId, String qualificationRef, String rightsRef,
            String qualificationSha256, boolean qualified) {
        public ProviderQualification {
            providerId = required(providerId, "providerId");
            qualificationRef = required(qualificationRef, "qualificationRef");
            rightsRef = required(rightsRef, "providerRightsRef");
            qualificationSha256 = digest(qualificationSha256, "qualificationSha256");
        }
    }

    public record BoundedAmount(long amount, String unit) {
        public BoundedAmount {
            if (amount <= 0) throw new IllegalArgumentException("amount must be positive and bounded");
            unit = required(unit, "unit");
        }
    }

    public record Reservation(String quoteRef, String quoteVersion, String reservationId,
            BoundedAmount worstCaseCost, BoundedAmount reservedCost,
            BoundedAmount worstCaseCompute, BoundedAmount reservedCompute,
            BoundedAmount worstCaseTime, BoundedAmount reservedTime) {
        public Reservation {
            quoteRef = required(quoteRef, "quoteRef");
            quoteVersion = required(quoteVersion, "quoteVersion");
            reservationId = required(reservationId, "reservationId");
            requireCovers(worstCaseCost, reservedCost, "cost");
            requireCovers(worstCaseCompute, reservedCompute, "compute");
            requireCovers(worstCaseTime, reservedTime, "time");
        }
    }

    public record Rational(long numerator, long denominator) {
        public Rational {
            if (numerator <= 0 || denominator <= 0) throw new IllegalArgumentException("clock conversion must be positive rational");
            long gcd = gcd(numerator, denominator);
            numerator /= gcd;
            denominator /= gcd;
        }
    }

    public record ClockConversion(String fromClock, String toClock, Rational ratio) {
        public ClockConversion {
            fromClock = required(fromClock, "fromClock");
            toClock = required(toClock, "toClock");
            ratio = Objects.requireNonNull(ratio, "ratio");
        }
    }

    public record ClockBindings(String storyClock, String mediaClock, String simulationClock,
            String wallClock, List<ClockConversion> conversions) {
        public ClockBindings {
            storyClock = required(storyClock, "storyClock");
            mediaClock = required(mediaClock, "mediaClock");
            simulationClock = required(simulationClock, "simulationClock");
            wallClock = required(wallClock, "wallClock");
            conversions = List.copyOf(Objects.requireNonNull(conversions, "conversions"));
            if (conversions.isEmpty()) throw new IllegalArgumentException("at least one declared rational clock conversion is required");
        }
    }

    public record Authority(String tenantId, String principalId, String purposeRef, String rightsRef,
            String sourceVersionRef, String sourceSha256, String ownerDecisionRef,
            Instant decisionExpiresAt, long revocationEpoch) {
        public Authority {
            tenantId = required(tenantId, "tenantId");
            principalId = required(principalId, "principalId");
            purposeRef = required(purposeRef, "purposeRef");
            rightsRef = required(rightsRef, "rightsRef");
            sourceVersionRef = required(sourceVersionRef, "sourceVersionRef");
            sourceSha256 = digest(sourceSha256, "sourceSha256");
            ownerDecisionRef = required(ownerDecisionRef, "ownerDecisionRef");
            Objects.requireNonNull(decisionExpiresAt, "decisionExpiresAt");
            if (revocationEpoch < 0) throw new IllegalArgumentException("revocationEpoch must be nonnegative");
        }
    }

    /** Exact source authorization attached to one ProductionSpec scene reference. */
    public record SceneSourceAuthority(String sourceVersionRef, String sourceSha256, String rightsRef,
            String ownerDecisionRef, Instant decisionExpiresAt, long revocationEpoch) {
        public SceneSourceAuthority {
            sourceVersionRef = required(sourceVersionRef, "sceneSource.sourceVersionRef");
            sourceSha256 = digest(sourceSha256, "sceneSource.sourceSha256");
            rightsRef = required(rightsRef, "sceneSource.rightsRef");
            ownerDecisionRef = required(ownerDecisionRef, "sceneSource.ownerDecisionRef");
            Objects.requireNonNull(decisionExpiresAt, "sceneSource.decisionExpiresAt");
            if (revocationEpoch < 0) throw new IllegalArgumentException("sceneSource.revocationEpoch must be nonnegative");
        }
    }

    public record RequestIdentity(String requestId, String requestFingerprint) {
        public RequestIdentity {
            requestId = required(requestId, "requestId");
            requestFingerprint = digest(requestFingerprint, "requestFingerprint");
        }
    }

    public record EditLock(String scopeKind, String targetRef, String ownerPrincipalId, String leaseId,
            long epoch, Instant expiresAt) {
        public EditLock {
            if (!"SCENE".equals(scopeKind) && !"OUTPUT".equals(scopeKind))
                throw new IllegalArgumentException("edit-lock scopeKind must be SCENE or OUTPUT");
            targetRef = required(targetRef, "editLock.targetRef");
            ownerPrincipalId = required(ownerPrincipalId, "ownerPrincipalId");
            leaseId = required(leaseId, "leaseId");
            if (epoch < 1) throw new IllegalArgumentException("lock epoch must be positive");
            Objects.requireNonNull(expiresAt, "expiresAt");
        }
    }

    /** Adapter to the canonical project revision CAS/operation journal. No state is stored here. */
    @FunctionalInterface
    public interface ProjectEditLockCas {
        /** Claims every declared effect lock atomically against one project revision. */
        boolean compareAndSet(String projectId, String expectedProjectRevision, Map<String, EditLock> locksByStep);
    }

    /** Atomic scoped lock claim delegated to the existing project/job authority. */
    public static boolean acquireEditLocks(Binding binding, MediaProductionSpecCompiler.CompiledPlan plan,
            ProjectEditLockCas authority) {
        Objects.requireNonNull(binding, "binding");
        Objects.requireNonNull(plan, "plan");
        if (!binding.expectedProjectRevision().equals(plan.projectRevision())) {
            fail(AdmissionFailure.PROJECT_REVISION_STALE);
        }
        if (plan.admissionBindingFingerprint() == null
                || !binding.stableContextFingerprint().equals(plan.admissionBindingFingerprint())) {
            fail(AdmissionFailure.BINDING_SPEC_MISMATCH);
        }
        Map<String, String> requiredScopes = new TreeMap<>();
        for (MediaProductionSpecCompiler.PlanNode node : plan.nodes()) {
            if ("capture".equals(node.kind())) requiredScopes.put(node.stepId(), "SCENE");
            if ("render".equals(node.kind())) requiredScopes.put(node.stepId(), "OUTPUT");
        }
        if (!requiredScopes.keySet().equals(binding.editLocksByStep().keySet())) {
            fail(AdmissionFailure.EDIT_LOCK_INVALID);
        }
        for (Map.Entry<String, String> expected : requiredScopes.entrySet()) {
            MediaProductionSpecCompiler.PlanNode node = plan.nodes().stream()
                    .filter(candidate -> candidate.stepId().equals(expected.getKey())).findFirst().orElseThrow();
            EditLock lock = binding.editLocksByStep().get(expected.getKey());
            if (!expected.getValue().equals(lock.scopeKind()) || node.versionRefs().size() != 1
                    || !node.versionRefs().getFirst().equals(lock.targetRef())
                    || !binding.authority().principalId().equals(lock.ownerPrincipalId())) {
                fail(AdmissionFailure.EDIT_LOCK_INVALID);
            }
        }
        return Objects.requireNonNull(authority, "authority").compareAndSet(
                binding.projectId(), binding.expectedProjectRevision(), binding.editLocksByStep());
    }

    public record Binding(String schemaVersion, String projectId, String expectedProjectRevision,
            RequestIdentity requestIdentity, Map<String, Engine> enginesByStep,
            ProviderQualification provider, Reservation reservation,
            Authority authority, Map<String, EditLock> editLocksByStep, ClockBindings clocks,
            Map<String, SceneSourceAuthority> sourceBindingsByScene) {
        public Binding {
            if (!SCHEMA_VERSION.equals(schemaVersion)) throw new IllegalArgumentException("unsupported admission binding version");
            projectId = required(projectId, "projectId");
            expectedProjectRevision = required(expectedProjectRevision, "expectedProjectRevision");
            Objects.requireNonNull(requestIdentity, "requestIdentity");
            Objects.requireNonNull(enginesByStep, "enginesByStep");
            Map<String, Engine> sortedEngines = new TreeMap<>();
            enginesByStep.forEach((stepId, engine) -> sortedEngines.put(
                    required(stepId, "engine stepId"), Objects.requireNonNull(engine, "engine")));
            if (sortedEngines.isEmpty()) throw new IllegalArgumentException("enginesByStep is required");
            enginesByStep = Map.copyOf(sortedEngines);
            Objects.requireNonNull(provider, "provider");
            Objects.requireNonNull(reservation, "reservation");
            Objects.requireNonNull(authority, "authority");
            Objects.requireNonNull(editLocksByStep, "editLocksByStep");
            Map<String, EditLock> sortedLocks = new TreeMap<>();
            editLocksByStep.forEach((stepId, lock) -> sortedLocks.put(
                    required(stepId, "editLock stepId"), Objects.requireNonNull(lock, "editLock")));
            editLocksByStep = Map.copyOf(sortedLocks);
            Objects.requireNonNull(clocks, "clocks");
            Objects.requireNonNull(sourceBindingsByScene, "sourceBindingsByScene");
            Map<String, SceneSourceAuthority> sortedSources = new TreeMap<>();
            sourceBindingsByScene.forEach((sceneRef, source) -> sortedSources.put(
                    required(sceneRef, "sourceBindingsByScene sceneRef"), Objects.requireNonNull(source, "sceneSourceAuthority")));
            sourceBindingsByScene = Map.copyOf(sortedSources);
        }

        /** Stable shared authority identity; excludes per-node engine digests. */
        public String stableContextFingerprint() {
            return stableContextFingerprint(true);
        }

        /** Plan-wide context used before source-specific bindings are added to their capture nodes. */
        String planContextFingerprint() {
            return stableContextFingerprint(false);
        }

        private String stableContextFingerprint(boolean includeSceneSources) {
            return sha256(join(schemaVersion, projectId, expectedProjectRevision,
                    requestIdentity.requestId(), requestIdentity.requestFingerprint(),
                    provider.providerId(), provider.qualificationRef(),
                    provider.qualificationSha256(), provider.rightsRef(), Boolean.toString(provider.qualified()),
                    reservation.quoteRef(), reservation.quoteVersion(), reservation.reservationId(),
                    amount(reservation.worstCaseCost()), amount(reservation.reservedCost()),
                    amount(reservation.worstCaseCompute()), amount(reservation.reservedCompute()),
                    amount(reservation.worstCaseTime()), amount(reservation.reservedTime()),
                    authority.tenantId(), authority.principalId(), authority.purposeRef(),
                    authority.rightsRef(), authority.sourceVersionRef(), authority.sourceSha256(), authority.ownerDecisionRef(),
                    authority.decisionExpiresAt().toString(), Long.toString(authority.revocationEpoch()),
                    includeSceneSources ? new TreeMap<>(sourceBindingsByScene).entrySet().stream().map(entry -> join(entry.getKey(),
                            entry.getValue().sourceVersionRef(), entry.getValue().sourceSha256(), entry.getValue().rightsRef(),
                            entry.getValue().ownerDecisionRef(), entry.getValue().decisionExpiresAt().toString(),
                            Long.toString(entry.getValue().revocationEpoch()))).toList().toString() : "scene-sources-attached-to-capture-nodes",
                    new TreeMap<>(editLocksByStep).entrySet().stream().map(entry -> join(entry.getKey(),
                            entry.getValue().scopeKind(), entry.getValue().targetRef(),
                            entry.getValue().ownerPrincipalId(), entry.getValue().leaseId(),
                            Long.toString(entry.getValue().epoch()), entry.getValue().expiresAt().toString()))
                            .toList().toString(),
                    clocks.storyClock(), clocks.mediaClock(), clocks.simulationClock(), clocks.wallClock(),
                    clocks.conversions().stream().map(c -> join(c.fromClock(), c.toClock(),
                            Long.toString(c.ratio().numerator()), Long.toString(c.ratio().denominator()))).toList().toString()));
        }

        public String engineFingerprint(String stepId) {
            Engine engine = engineForStep(stepId);
            return sha256(join(engine.identityKind(), engine.identity(), engine.buildSha256()));
        }

        /** Complete canonical envelope identity. */
        public String fingerprint() {
            String engineBindings = new TreeMap<>(enginesByStep).entrySet().stream()
                    .map(entry -> join(entry.getKey(), entry.getValue().identityKind(),
                            entry.getValue().identity(), entry.getValue().buildSha256())).toList().toString();
            return sha256(join(stableContextFingerprint(), engineBindings));
        }

        public Engine engineForStep(String stepId) {
            Engine engine = enginesByStep.get(stepId);
            if (engine == null) fail(AdmissionFailure.ENGINE_MISMATCH);
            return engine;
        }
    }

    /** A point-in-time read from MediaRuntime's existing project/job/authority state. */
    public record CurrentState(String tenantId, String principalId, String purposeRef,
            String sourceVersionRef, String sourceSha256, String projectId, String projectRevision,
            String rightsRef, String ownerDecisionRef, Instant rightsExpiresAt, long revocationEpoch,
            String engineIdentityKind, String engineIdentity, String engineBuildSha256, String providerId, String qualificationRef,
            String qualificationSha256, String providerRightsRef, boolean qualified,
            String quoteRef, String quoteVersion, String reservationId,
            BoundedAmount remainingCost, BoundedAmount remainingCompute, BoundedAmount remainingTime,
            String lockScopeKind, String lockTargetRef, String lockOwnerPrincipalId, String lockLeaseId, long lockEpoch,
            Instant lockExpiresAt, String canonicalRequestId, String canonicalRequestFingerprint,
            ClockBindings clocks, Instant observedAt) { }

    public static void requireCurrent(Binding b, String stepId, CurrentState s) {
        requireCurrentInternal(b, stepId, null, s, false);
    }

    /** Scene strings alone are insufficient to authorize a capture node. */
    public static void requireCurrent(Binding b, String stepId, String sceneRef, CurrentState s) {
        requireCurrentInternal(b, stepId, sceneRef, s, false);
    }

    /**
     * Rechecks a scene source only after matching the guarded step to its compiled
     * plan node. The supplied plan is a local candidate, not an attested artifact;
     * runtime admission remains disabled until the authority-backed path exists.
     */
    public static void requireCurrent(Binding b, MediaProductionSpecCompiler.CompiledPlan plan,
            String stepId, String sceneRef, CurrentState s) {
        requirePlanSceneBinding(b, plan, stepId, sceneRef);
        requireCurrentInternal(b, stepId, sceneRef, s, true);
    }

    private static void requireCurrentInternal(Binding b, String stepId, String sceneRef, CurrentState s,
            boolean planSceneValidated) {
        if (b == null || !hasCompleteAuthorityState(s)) fail(AdmissionFailure.AUTHORITY_STATE_UNAVAILABLE);
        Instant now = s.observedAt();
        Authority a = b.authority();
        if (!a.tenantId().equals(s.tenantId())) fail(AdmissionFailure.TENANT_MISMATCH);
        if (!a.principalId().equals(s.principalId())) fail(AdmissionFailure.PRINCIPAL_MISMATCH);
        if (!a.purposeRef().equals(s.purposeRef())) fail(AdmissionFailure.PURPOSE_MISMATCH);
        SceneSourceAuthority sceneAuthority = null;
        if (stepId.startsWith("capture-source-")) {
            if (!planSceneValidated || sceneRef == null) fail(AdmissionFailure.BINDING_SPEC_MISMATCH);
            sceneAuthority = b.sourceBindingsByScene().get(sceneRef);
            if (sceneAuthority == null) fail(AdmissionFailure.MULTI_SOURCE_AUTHORITY_UNMAPPED);
        }
        String expectedSourceVersion = sceneAuthority == null ? a.sourceVersionRef() : sceneAuthority.sourceVersionRef();
        String expectedSourceSha = sceneAuthority == null ? a.sourceSha256() : sceneAuthority.sourceSha256();
        String expectedRightsRef = sceneAuthority == null ? a.rightsRef() : sceneAuthority.rightsRef();
        String expectedDecisionRef = sceneAuthority == null ? a.ownerDecisionRef() : sceneAuthority.ownerDecisionRef();
        Instant expectedDecisionExpiry = sceneAuthority == null ? a.decisionExpiresAt() : sceneAuthority.decisionExpiresAt();
        long expectedRevocationEpoch = sceneAuthority == null ? a.revocationEpoch() : sceneAuthority.revocationEpoch();
        if (!expectedSourceVersion.equals(s.sourceVersionRef()) || !expectedSourceSha.equals(s.sourceSha256()))
            fail(AdmissionFailure.SOURCE_MISMATCH);
        if (!expectedRightsRef.equals(s.rightsRef())) fail(AdmissionFailure.RIGHTS_STALE);
        if (sceneAuthority != null && (!expectedDecisionRef.equals(s.ownerDecisionRef())
                || !expectedDecisionExpiry.equals(s.rightsExpiresAt()) || !expectedDecisionExpiry.isAfter(now))) {
            fail(AdmissionFailure.RIGHTS_STALE);
        }
        // Resolve idempotency only after checking tenant/principal/purpose/source scope.
        if ((s.canonicalRequestId() == null) != (s.canonicalRequestFingerprint() == null))
            fail(AdmissionFailure.AUTHORITY_STATE_UNAVAILABLE);
        if (s.canonicalRequestId() != null) {
            if (!b.requestIdentity().requestId().equals(s.canonicalRequestId()))
                fail(AdmissionFailure.AUTHORITY_STATE_UNAVAILABLE);
            if (!b.requestIdentity().requestFingerprint().equals(s.canonicalRequestFingerprint()))
                fail(AdmissionFailure.IDEMPOTENCY_CONFLICT);
            fail(AdmissionFailure.RECONCILE_EXISTING_ATTEMPT);
        }
        if (sceneAuthority == null && (!expectedDecisionRef.equals(s.ownerDecisionRef())
                || !expectedDecisionExpiry.equals(s.rightsExpiresAt()) || !expectedDecisionExpiry.isAfter(now)))
            fail(AdmissionFailure.RIGHTS_STALE);
        if (s.revocationEpoch() != expectedRevocationEpoch) fail(AdmissionFailure.RIGHTS_REVOKED);
        ProviderQualification p = b.provider();
        Engine engine = b.engineForStep(stepId);
        if (!engine.identityKind().equals(s.engineIdentityKind()) || !engine.identity().equals(s.engineIdentity())
                || !engine.buildSha256().equals(s.engineBuildSha256())) fail(AdmissionFailure.ENGINE_MISMATCH);
        if (!p.qualified() || !s.qualified() || !p.providerId().equals(s.providerId())
                || !p.qualificationRef().equals(s.qualificationRef())
                || !p.qualificationSha256().equals(s.qualificationSha256())
                || !p.rightsRef().equals(s.providerRightsRef())) fail(AdmissionFailure.PROVIDER_UNQUALIFIED);
        if (!b.reservation().quoteRef().equals(s.quoteRef()) || !b.reservation().quoteVersion().equals(s.quoteVersion()))
            fail(AdmissionFailure.QUOTE_STALE);
        if (!b.reservation().reservationId().equals(s.reservationId())) fail(AdmissionFailure.RESERVATION_MISMATCH);
        if (!covers(s.remainingCost(), b.reservation().worstCaseCost())
                || !covers(s.remainingCompute(), b.reservation().worstCaseCompute())
                || !covers(s.remainingTime(), b.reservation().worstCaseTime())) fail(AdmissionFailure.BUDGET_EXCEEDED);
        if (!b.projectId().equals(s.projectId()) || !b.expectedProjectRevision().equals(s.projectRevision()))
            fail(AdmissionFailure.PROJECT_REVISION_STALE);
        EditLock l = b.editLocksByStep().get(stepId);
        if (l == null || !l.scopeKind().equals(s.lockScopeKind()) || !l.targetRef().equals(s.lockTargetRef())
                || !l.ownerPrincipalId().equals(s.lockOwnerPrincipalId())
                || !a.principalId().equals(s.lockOwnerPrincipalId()) || !l.leaseId().equals(s.lockLeaseId())
                || l.epoch() != s.lockEpoch() || !l.expiresAt().equals(s.lockExpiresAt())
                || !l.expiresAt().isAfter(now)) fail(AdmissionFailure.EDIT_LOCK_INVALID);
        if (sceneAuthority != null && (!"SCENE".equals(l.scopeKind()) || !sceneRef.equals(l.targetRef())))
            fail(AdmissionFailure.EDIT_LOCK_INVALID);
        if (!b.clocks().equals(s.clocks())) fail(AdmissionFailure.CLOCK_MISMATCH);
    }

    private static void requirePlanSceneBinding(Binding binding, MediaProductionSpecCompiler.CompiledPlan plan,
            String stepId, String sceneRef) {
        if (binding == null || plan == null || sceneRef == null
                || !binding.stableContextFingerprint().equals(plan.admissionBindingFingerprint()))
            fail(AdmissionFailure.BINDING_SPEC_MISMATCH);
        List<MediaProductionSpecCompiler.PlanNode> captures = plan.nodes().stream()
                .filter(node -> "capture".equals(node.kind())).toList();
        MediaProductionSpecCompiler.PlanNode node = plan.nodes().stream()
                .filter(candidate -> stepId.equals(candidate.stepId())).findFirst().orElse(null);
        if (node == null || !"capture".equals(node.kind()) || node.versionRefs().size() != 1
                || !sceneRef.equals(node.versionRefs().getFirst())) fail(AdmissionFailure.BINDING_SPEC_MISMATCH);
        int index;
        try {
            index = Integer.parseInt(stepId.substring("capture-source-".length()));
        } catch (RuntimeException malformedStep) {
            fail(AdmissionFailure.BINDING_SPEC_MISMATCH);
            return;
        }
        if (index < 0 || index >= captures.size() || !captures.get(index).stepId().equals(stepId)
                || !captures.get(index).versionRefs().equals(List.of(sceneRef)))
            fail(AdmissionFailure.BINDING_SPEC_MISMATCH);
    }

    private static boolean hasCompleteAuthorityState(CurrentState s) {
        return s != null
                && present(s.tenantId()) && present(s.principalId()) && present(s.purposeRef())
                && present(s.sourceVersionRef()) && present(s.sourceSha256())
                && present(s.projectId()) && present(s.projectRevision())
                && present(s.rightsRef()) && present(s.ownerDecisionRef()) && s.rightsExpiresAt() != null
                && s.revocationEpoch() >= 0
                && present(s.engineIdentityKind()) && present(s.engineIdentity()) && present(s.engineBuildSha256())
                && present(s.providerId()) && present(s.qualificationRef()) && present(s.qualificationSha256())
                && present(s.providerRightsRef())
                && present(s.quoteRef()) && present(s.quoteVersion()) && present(s.reservationId())
                && s.remainingCost() != null && s.remainingCompute() != null && s.remainingTime() != null
                && present(s.lockScopeKind()) && present(s.lockTargetRef())
                && present(s.lockOwnerPrincipalId()) && present(s.lockLeaseId())
                && s.lockEpoch() > 0 && s.lockExpiresAt() != null
                && s.clocks() != null && s.observedAt() != null;
    }

    private static boolean present(String value) { return value != null && !value.isBlank(); }

    /**
     * Source-review admission remains hard-disabled in this implementation
     * cut. The caller cannot turn it on with an input field or fixture.
     */
    public static void requireAdmitted(Binding b, String stepId, CurrentState s) {
        requireCurrent(b, stepId, s);
        fail(AdmissionFailure.SOURCE_REVIEW_NOT_ADMITTED);
    }

    public static void requireAdmitted(Binding b, String stepId, String sceneRef, CurrentState s) {
        requireCurrent(b, stepId, sceneRef, s);
        fail(AdmissionFailure.SOURCE_REVIEW_NOT_ADMITTED);
    }

    public static void requireAdmitted(Binding b, MediaProductionSpecCompiler.CompiledPlan plan,
            String stepId, String sceneRef, CurrentState s) {
        requireCurrent(b, plan, stepId, sceneRef, s);
        fail(AdmissionFailure.SOURCE_REVIEW_NOT_ADMITTED);
    }

    /** Re-read authority state immediately before every initial, retry, or restart effect. */
    public static void beforeEffect(Binding binding, String stepId, Supplier<CurrentState> currentState, Runnable effect) {
        beforeEffect(binding, stepId, null, currentState, effect);
    }

    /** Re-read global and per-scene authority immediately before each capture effect. */
    public static void beforeEffect(Binding binding, String stepId, String sceneRef,
            Supplier<CurrentState> currentState, Runnable effect) {
        if (stepId != null && stepId.startsWith("capture-source-")) fail(AdmissionFailure.BINDING_SPEC_MISMATCH);
        beforeEffectInternal(binding, stepId, currentState, effect,
                observed -> requireAdmitted(binding, stepId, sceneRef, observed));
    }

    /** Re-read the plan-indexed scene authority immediately before each capture effect. */
    public static void beforeEffect(Binding binding, MediaProductionSpecCompiler.CompiledPlan plan,
            String stepId, String sceneRef, Supplier<CurrentState> currentState, Runnable effect) {
        beforeEffectInternal(binding, stepId, currentState, effect,
                observed -> requireAdmitted(binding, plan, stepId, sceneRef, observed));
    }

    private static void beforeEffectInternal(Binding binding, String stepId, Supplier<CurrentState> currentState,
            Runnable effect, java.util.function.Consumer<CurrentState> admissionCheck) {
        if (currentState == null) fail(AdmissionFailure.AUTHORITY_STATE_UNAVAILABLE);
        CurrentState observed;
        try {
            observed = currentState.get();
        } catch (RuntimeException unavailable) {
            fail(AdmissionFailure.AUTHORITY_STATE_UNAVAILABLE);
            return;
        }
        admissionCheck.accept(observed);
        Objects.requireNonNull(effect, "effect").run();
    }

    private static String amount(BoundedAmount a) { return a.amount() + " " + a.unit(); }
    private static boolean covers(BoundedAmount available, BoundedAmount required) {
        return available != null && available.unit().equals(required.unit()) && available.amount() >= required.amount();
    }
    private static void requireCovers(BoundedAmount max, BoundedAmount reserved, String name) {
        Objects.requireNonNull(max, name + " maximum");
        Objects.requireNonNull(reserved, name + " reservation");
        if (!max.unit().equals(reserved.unit()) || reserved.amount() < max.amount())
            throw new IllegalArgumentException(name + " reservation must cover worst-case amount in same unit");
    }
    private static void fail(AdmissionFailure failure) { throw new AdmissionException(failure); }
    private static String required(String value, String name) {
        if (value == null || value.isBlank() || value.length() > 384) throw new IllegalArgumentException(name + " is required and bounded");
        return value;
    }
    private static String digest(String value, String name) {
        if (value == null || !value.matches("sha256:[0-9a-f]{64}")) throw new IllegalArgumentException(name + " must be canonical immutable SHA256");
        return value;
    }
    private static String join(String... fields) {
        StringBuilder out = new StringBuilder();
        for (String field : fields) out.append(field.length()).append(':').append(field);
        return out.toString();
    }
    private static String sha256(String value) {
        try { return "sha256:" + HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value.getBytes(StandardCharsets.UTF_8))); }
        catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
    }
    private static long gcd(long a, long b) { while (b != 0) { long t = a % b; a = b; b = t; } return a; }
}
