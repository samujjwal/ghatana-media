package com.ghatana.media.launcher;

import com.ghatana.media.production.review.DevReviewStoreFactory;
import com.ghatana.media.production.review.ManagedReviewStore;
import com.ghatana.media.production.review.ReviewAssignmentStore;
import com.ghatana.media.production.review.ReviewAssignmentStore.*;
import com.ghatana.media.production.review.ReviewContracts.*;
import com.ghatana.media.production.review.VersionedReviewEngine;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectAccessDeniedException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectNotFoundException;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;
import com.ghatana.media.runtime.MediaVerifiedIdentityContracts.AssuranceSource;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.Optional;
import java.util.ServiceLoader;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

/**
 * DEV_ONLY host composition of the existing {@link VersionedReviewEngine} over a durable {@link ManagedReviewStore}.
 *
 * <p>Honesty boundary: the authority here is the DEV_ONLY synthetic owner of the exact subject. It is not an
 * issued human reviewer authority, so a recorded ACCEPT is a DEV_ONLY statement only; the engine's
 * {@code establishesApproval=false} is surfaced unchanged and no delivery or publication is authorized.
 * A case binds one exact immutable subject (a project revision or an artifact version). Currentness is
 * re-derived from the live project head / artifact version on every operation, so any later change of the
 * reviewed subject makes an earlier decision STALE.
 *
 * <p>Review authority is an explicit DEV_ONLY assignment: the owner assigns a different reviewer principal to a case
 * with a scope set (QUALITY, RIGHTS, PROVENANCE, APPROVAL) and an expiry. Only an assigned, unexpired reviewer may
 * record a decision within its scopes; the owner may comment but not decide. The assignment id and version are part of
 * the authority version, so an assignment change between request and write is AUTHORITY_CHANGED. Even then the DEV_ONLY
 * signed identity is not a trusted human identity, so no decision establishes approval.
 */
public final class MediaDevReviewRuntime implements AutoCloseable {
    public static final String ENABLED = "MEDIA_DEV_REVIEW_ENABLED";
    public static final String AUTHORITY_VERSION = "dev-only.synthetic-owner.v1";
    public static final String ASSIGNED_AUTHORITY_PREFIX = "dev-only.assigned-reviewer.v1:";
    /**
     * Authority family for a decision whose assigned reviewer was verified by the configured OIDC identity provider.
     * It records WHO decided (issuer and subject, in the principal id) and that the identity provider vouched for
     * them. It does not make the decision an approval: {@code establishesApproval} stays false.
     */
    public static final String IDP_ASSIGNED_AUTHORITY_PREFIX = "idp-verified.assigned-reviewer.v1:";
    static final String SCOPE_PREFIX = "dev-only:owner:";
    static final java.time.Duration MAX_ASSIGNMENT = java.time.Duration.ofDays(30);
    private static final Duration AUTHORITY_VALIDITY = Duration.ofMinutes(5);

    /** Result of opening a case: the exact reference and whether this call created it. */
    public record OpenedCase(ReviewCaseRef reviewCase, boolean created) { }

    /** Append outcome; replayed is true when an earlier identical request's receipt was returned. */
    public record AppendOutcome(AppendReceipt receipt, boolean replayed) { }

    private final ManagedReviewStore store;
    private final MediaRuntime runtime;
    private final MediaDevProjectTimelineRuntime projects;
    private final Clock clock;
    private final VersionedReviewEngine engine;
    private final ThreadLocal<Boolean> storeReplay = new ThreadLocal<>();
    private final ThreadLocal<ReviewScope> decisionScope = new ThreadLocal<>();
    private final ThreadLocal<AssuranceSource> decisionAssurance = new ThreadLocal<>();
    private final AtomicBoolean closed = new AtomicBoolean();

    MediaDevReviewRuntime(ManagedReviewStore store, MediaRuntime runtime, MediaDevProjectTimelineRuntime projects,
                          Clock clock) {
        this.store = Objects.requireNonNull(store, "store");
        if (!(store instanceof ReviewAssignmentStore)) {
            throw new IllegalArgumentException("DEV_ONLY review store must support reviewer assignments");
        }
        this.runtime = Objects.requireNonNull(runtime, "runtime");
        this.projects = Objects.requireNonNull(projects, "projects");
        this.clock = Objects.requireNonNull(clock, "clock");
        this.engine = new VersionedReviewEngine(new ReplayRecordingStore(store), this::authorize,
                MediaDevReviewRuntime::sanitize, clock);
    }

    /** Returns null unless the explicit DEV_ONLY review flag is set; requires the DEV_ONLY timeline runtime. */
    public static MediaDevReviewRuntime compose(Map<String, String> environment, MediaRuntime runtime,
                                                MediaDevProjectTimelineRuntime projects) {
        String flag = environment.getOrDefault(ENABLED, "false");
        if (!"true".equalsIgnoreCase(flag) && !"false".equalsIgnoreCase(flag)) {
            throw new IllegalArgumentException(ENABLED + " must be true or false");
        }
        if (!"true".equalsIgnoreCase(flag)) return null;
        if (projects == null) {
            throw new IllegalArgumentException(ENABLED + " requires " + MediaDevProjectTimelineRuntime.ENABLED + "=true");
        }
        List<DevReviewStoreFactory> factories = ServiceLoader.load(DevReviewStoreFactory.class).stream()
                .map(ServiceLoader.Provider::get)
                .filter(factory -> "postgresql-dev-review".equals(factory.factoryId()))
                .toList();
        if (factories.size() != 1) {
            throw new IllegalStateException("exactly one PostgreSQL DEV_ONLY review store factory is required");
        }
        return new MediaDevReviewRuntime(factories.get(0).createDevOnly(Map.copyOf(environment)), runtime, projects,
                Clock.systemUTC());
    }

    /** Opens (or returns the existing) case for the owner's exact subject. Subject must exist and be readable. */
    public OpenedCase open(String tenantId, String principalId, SubjectKind kind, String objectId, String versionId) {
        ensureOpen();
        if (kind != SubjectKind.PROJECT_REVISION && kind != SubjectKind.ARTIFACT_VERSION) {
            throw new IllegalArgumentException("only PROJECT_REVISION and ARTIFACT_VERSION subjects are supported");
        }
        ExactVersionRef subject = new ExactVersionRef(kind, objectId, versionId);
        // Exact-subject existence and owner scope are verified before any case row is written.
        String current = currentMaterial(tenantId, principalId, subject);
        if (kind == SubjectKind.ARTIFACT_VERSION && !current.equals(subject.reference())) {
            throw new SubjectNotFoundException();
        }
        ReviewCaseRef reviewCase = new ReviewCaseRef(tenantId, caseId(tenantId, principalId, subject),
                subject.reference(), subject, scopeRef(tenantId, principalId));
        boolean created = store.findCase(tenantId, reviewCase.reviewCaseId()).isEmpty();
        store.registerCase(reviewCase);
        return new OpenedCase(reviewCase, created);
    }

    /** The exact registered case reference for this owner, or empty (also for another owner's case). */
    public Optional<ReviewCaseRef> find(String tenantId, String principalId, String reviewCaseId) {
        ensureOpen();
        return store.findCase(tenantId, reviewCaseId)
                .filter(found -> found.scopeRef().equals(scopeRef(tenantId, principalId))
                        || assignments(found).stream().anyMatch(a -> a.reviewerPrincipalId().equals(principalId)));
    }

    /** True when this principal is the case owner (the only principal that can assign, revoke or comment as owner). */
    public boolean isOwner(String tenantId, String principalId, ReviewCaseRef reviewCase) {
        return reviewCase.scopeRef().equals(scopeRef(tenantId, principalId));
    }

    public List<ReviewAssignment> assignments(ReviewCaseRef reviewCase) {
        ensureOpen();
        return ((ReviewAssignmentStore) store).assignments(reviewCase);
    }

    /** Owner assigns a different reviewer principal with an explicit scope set and expiry. */
    public AssignmentChange assign(String tenantId, String principalId, ReviewCaseRef reviewCase,
                                   long expectedCaseRevision, String requestId, String reviewerPrincipalId,
                                   Set<ReviewScope> scopes, Instant expiresAt) {
        ensureOpen();
        requireOwner(tenantId, principalId, reviewCase);
        if (reviewerPrincipalId.equals(principalId)) throw new SelfAssignmentException();
        if (scopes.isEmpty()) throw new IllegalArgumentException("scopes must name at least one review scope");
        Instant now = clock.instant();
        if (!expiresAt.isAfter(now) || expiresAt.isAfter(now.plus(MAX_ASSIGNMENT))) {
            throw new IllegalArgumentException("expiresAt must be in the future and within " + MAX_ASSIGNMENT.toDays() + " days");
        }
        new Actor(tenantId, reviewerPrincipalId);
        String fingerprint = sha(String.join("\u0000", "assign", tenantId, principalId, reviewCase.reviewCaseId(),
                reviewerPrincipalId, scopes.stream().map(Enum::name).sorted().toList().toString(),
                expiresAt.toString(), Long.toString(expectedCaseRevision)), 32);
        return ((ReviewAssignmentStore) store).assign(reviewCase, principalId, reviewerPrincipalId, scopes, expiresAt,
                expectedCaseRevision, requestId, fingerprint, () -> java.util.UUID.randomUUID().toString(), now);
    }

    public AssignmentChange revoke(String tenantId, String principalId, ReviewCaseRef reviewCase, String assignmentId,
                                   long expectedCaseRevision, String requestId) {
        ensureOpen();
        requireOwner(tenantId, principalId, reviewCase);
        String fingerprint = sha(String.join("\u0000", "revoke", tenantId, principalId, reviewCase.reviewCaseId(),
                assignmentId, Long.toString(expectedCaseRevision)), 32);
        return ((ReviewAssignmentStore) store).revoke(reviewCase, principalId, assignmentId, expectedCaseRevision,
                requestId, fingerprint, clock.instant());
    }

    private void requireOwner(String tenantId, String principalId, ReviewCaseRef reviewCase) {
        if (!isOwner(tenantId, principalId, reviewCase)) throw new ReviewDeniedException();
    }

    /** The principal is not the owner and holds no active assignment for the attempted action. */
    public static class ReviewAuthorityException extends RuntimeException {
        private final String code;
        ReviewAuthorityException(String code, String message) { super(message); this.code = code; }
        public String code() { return code; }
    }
    public static final class SelfAssignmentException extends RuntimeException {
        SelfAssignmentException() { super("the owner cannot assign themselves as reviewer"); }
    }

    /**
     * Who the actor is for this case and operation. Typed refusal for the review-decision path only: owner or
     * unassigned (REVIEWER_NOT_ASSIGNED), revoked (REVIEWER_NOT_ASSIGNED), expired (REVIEW_ASSIGNMENT_EXPIRED) and
     * wrong scope (REVIEW_SCOPE_NOT_ASSIGNED). Reads and comments need the owner or any active assignment.
     */
    private Resolved resolve(Actor actor, ReviewCaseRef reviewCase, boolean decision, ReviewScope scope) {
        Instant now = clock.instant();
        if (isOwner(actor.tenantId(), actor.principalId(), reviewCase)) {
            if (decision) {
                throw new ReviewAuthorityException("REVIEWER_NOT_ASSIGNED",
                        "The case owner may comment but cannot decide; an assigned reviewer must decide");
            }
            return new Resolved(actor.principalId(), null, AUTHORITY_VERSION);
        }
        List<ReviewAssignment> mine = assignments(reviewCase).stream()
                .filter(a -> a.reviewerPrincipalId().equals(actor.principalId())
                        && a.status() == AssignmentStatus.ACTIVE).toList();
        if (mine.isEmpty()) {
            throw new ReviewAuthorityException("REVIEWER_NOT_ASSIGNED", "Principal holds no active reviewer assignment");
        }
        List<ReviewAssignment> live = mine.stream().filter(a -> a.activeAt(now)).toList();
        if (live.isEmpty()) {
            throw new ReviewAuthorityException("REVIEW_ASSIGNMENT_EXPIRED", "The reviewer assignment has expired");
        }
        ReviewAssignment chosen = live.get(live.size() - 1);
        if (decision) {
            if (scope == null) throw new IllegalArgumentException("scope is required for a review decision");
            chosen = live.stream().filter(a -> a.scopes().contains(scope)).reduce((a, b) -> b).orElseThrow(() ->
                    new ReviewAuthorityException("REVIEW_SCOPE_NOT_ASSIGNED",
                            "The reviewer assignment does not include scope " + scope));
        }
        String prefix = decision && decisionAssurance.get() == AssuranceSource.OIDC_VERIFIED
                ? IDP_ASSIGNED_AUTHORITY_PREFIX : ASSIGNED_AUTHORITY_PREFIX;
        String authority = prefix + chosen.assignmentId() + ":v" + chosen.assignmentVersion()
                + (decision ? ":" + scope.name() : "");
        return new Resolved(chosen.assignedByPrincipalId(), chosen, authority);
    }

    private record Resolved(String ownerPrincipalId, ReviewAssignment assignment, String authorityVersion) { }

    /** Authority version string is "dev-only.assigned-reviewer.v1:{assignmentId}:v{n}[:SCOPE]" for assigned reviewers. */
    public static boolean isAssignedAuthority(String authorityVersion) {
        return authorityVersion != null && (authorityVersion.startsWith(ASSIGNED_AUTHORITY_PREFIX)
                || authorityVersion.startsWith(IDP_ASSIGNED_AUTHORITY_PREFIX));
    }

    /** True when the decision was recorded for a reviewer verified by the OIDC identity provider. */
    public static boolean isIdpVerifiedAuthority(String authorityVersion) {
        return authorityVersion != null && authorityVersion.startsWith(IDP_ASSIGNED_AUTHORITY_PREFIX);
    }

    public ReviewSnapshot inspect(String tenantId, String principalId, ReviewCaseRef reviewCase) {
        ensureOpen();
        Actor actor = new Actor(tenantId, principalId);
        resolve(actor, reviewCase, false, null);
        return engine.inspect(actor, reviewCase);
    }

    public AppendOutcome comment(String tenantId, String principalId, ReviewCaseRef reviewCase,
                                 long expectedCaseRevision, String requestId, Comment comment) {
        requireSanitizable(comment.text(), 10_000);
        return append(tenantId, principalId, reviewCase, expectedCaseRevision, requestId, comment, true);
    }

    public AppendOutcome decide(String tenantId, String principalId, ReviewCaseRef reviewCase,
                                long expectedCaseRevision, String requestId, DecisionRecord decision,
                                ReviewScope scope, boolean confirmed) {
        return decide(tenantId, principalId, reviewCase, expectedCaseRevision, requestId, decision, scope, confirmed,
                AssuranceSource.DEV_ISSUED);
    }

    /**
     * Records a decision for an assigned reviewer. {@code assurance} states how the deciding identity was
     * established at the request boundary: {@link AssuranceSource#OIDC_VERIFIED} records an identity-provider-backed
     * human decision; every other value records the DEV_ONLY statement exactly as before.
     */
    public AppendOutcome decide(String tenantId, String principalId, ReviewCaseRef reviewCase,
                                long expectedCaseRevision, String requestId, DecisionRecord decision,
                                ReviewScope scope, boolean confirmed, AssuranceSource assurance) {
        requireSanitizable(decision.reason(), 4_000);
        if (scope == null) throw new IllegalArgumentException("scope is required for a review decision");
        decisionScope.set(scope);
        decisionAssurance.set(Objects.requireNonNull(assurance, "assurance"));
        try {
            return append(tenantId, principalId, reviewCase, expectedCaseRevision, requestId, decision, confirmed);
        } finally {
            decisionScope.remove();
            decisionAssurance.remove();
        }
    }

    private AppendOutcome append(String tenantId, String principalId, ReviewCaseRef reviewCase, long expectedRevision,
                                 String requestId, Payload payload, boolean confirmed) {
        ensureOpen();
        Actor actor = new Actor(tenantId, principalId);
        Resolved resolved = resolve(actor, reviewCase, payload instanceof DecisionRecord, decisionScope.get());
        AppendRequest request = new AppendRequest(reviewCase, expectedRevision, resolved.authorityVersion(), requestId,
                new Confirmation(payload.operationId(), reviewCase.exactTargetRef(), confirmed), payload);
        storeReplay.remove();
        try {
            AppendReceipt receipt = engine.append(actor, request);
            // No store append means the engine reconciled a committed stale decision receipt: a replay.
            Boolean fromStore = storeReplay.get();
            return new AppendOutcome(receipt, fromStore == null || fromStore);
        } finally {
            storeReplay.remove();
        }
    }

    private AuthorizationDecision authorize(Actor actor, ReviewCaseRef reviewCase, String operationId, Instant now) {
        boolean decision = "media.operation.action.record-version-review-decision".equals(operationId);
        Resolved resolved;
        try {
            resolved = resolve(actor, reviewCase, decision, decisionScope.get());
        } catch (ReviewAuthorityException refused) {
            // Re-checked at the write boundary: a revocation, expiry or scope loss after the request was prepared.
            throw new ReviewDeniedException();
        }
        if (!reviewCase.scopeRef().equals(scopeRef(actor.tenantId(), resolved.ownerPrincipalId()))) {
            throw new ReviewDeniedException();
        }
        String current = currentMaterial(actor.tenantId(), resolved.ownerPrincipalId(), reviewCase.reviewSubjectRef());
        Instant validUntil = now.plus(AUTHORITY_VALIDITY);
        if (resolved.assignment() != null && resolved.assignment().expiresAt().isBefore(validUntil)) {
            validUntil = resolved.assignment().expiresAt();
        }
        return new AuthorizationDecision(AuthorizationStatus.ALLOW, actor.tenantId(), actor.principalId(),
                reviewCase.reviewCaseId(), reviewCase.exactTargetRef(), reviewCase.scopeRef(),
                resolved.authorityVersion(), validUntil, current, RetentionStatus.ACTIVE);
    }

    /** Verifies owner scope and existence of the exact subject; returns the live current-version reference. */
    private String currentMaterial(String tenantId, String principalId, ExactVersionRef subject) {
        try {
            if (subject.kind() == SubjectKind.PROJECT_REVISION) {
                projects.revision(tenantId, principalId, subject.objectId(), subject.versionId());
                String head = projects.currentRevision(tenantId, principalId, subject.objectId()).revisionId();
                return new ExactVersionRef(SubjectKind.PROJECT_REVISION, subject.objectId(), head).reference();
            }
            MediaArtifact artifact = runtime.artifact(tenantId, principalId, subject.objectId())
                    .orElseThrow(SubjectNotFoundException::new);
            return new ExactVersionRef(SubjectKind.ARTIFACT_VERSION, artifact.artifactId(),
                    artifact.version().value()).reference();
        } catch (ProjectNotFoundException | ProjectAccessDeniedException hidden) {
            throw new SubjectNotFoundException();
        }
    }

    /** The exact subject version is not available to this DEV_ONLY owner. */
    public static final class SubjectNotFoundException extends RuntimeException {
        SubjectNotFoundException() { super("the exact review subject is not available to this DEV_ONLY owner"); }
    }

    static String sanitize(String value) {
        StringBuilder out = new StringBuilder(value.length());
        for (int index = 0; index < value.length(); index++) {
            char ch = value.charAt(index);
            if (ch == '\n' || ch == '\t' || ch >= 0x20 && ch != 0x7f) out.append(ch);
        }
        return out.toString().replaceAll("[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\\.[A-Za-z]{2,}", "[redacted-email]");
    }

    private static void requireSanitizable(String value, int max) {
        String safe = sanitize(value);
        if (safe.isBlank() || safe.length() > max) {
            throw new IllegalArgumentException("review text must contain 1-" + max + " characters after redaction");
        }
    }

    static String scopeRef(String tenantId, String principalId) {
        return SCOPE_PREFIX + sha(tenantId + "\u0000" + principalId, 16);
    }

    static String caseId(String tenantId, String principalId, ExactVersionRef subject) {
        return "devreview." + sha(tenantId + "\u0000" + principalId + "\u0000" + subject.reference(), 16);
    }

    private static String sha(String value, int bytes) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256")
                    .digest(value.getBytes(StandardCharsets.UTF_8)), 0, bytes);
        } catch (NoSuchAlgorithmException impossible) {
            throw new IllegalStateException("SHA-256 is unavailable", impossible);
        }
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("DEV_ONLY review runtime is closed");
    }

    @Override public void close() { if (closed.compareAndSet(false, true)) store.close(); }

    /** Observes whether the durable store returned an earlier identical request instead of appending. */
    private final class ReplayRecordingStore implements ReviewStore {
        private final ReviewStore delegate;
        ReplayRecordingStore(ReviewStore delegate) { this.delegate = delegate; }

        @Override public ReviewRecord append(Actor actor, ReviewCaseRef reviewCase, long expectedCaseRevision,
                                             String requestId, String fingerprint, String appendRecordId,
                                             String authorityVersion, Payload payload, Instant createdAt) {
            return delegate.append(actor, reviewCase, expectedCaseRevision, requestId, fingerprint,
                    appendRecordId, authorityVersion, payload, createdAt);
        }

        @Override public StoreAppendResult appendWithReplayAndLazyId(Actor actor, ReviewCaseRef reviewCase,
                long expectedCaseRevision, String requestId, String fingerprint, Supplier<String> appendRecordId,
                String authorityVersion, Payload payload, Instant createdAt) {
            StoreAppendResult result = delegate.appendWithReplayAndLazyId(actor, reviewCase, expectedCaseRevision,
                    requestId, fingerprint, appendRecordId, authorityVersion, payload, createdAt);
            if (result != null) storeReplay.set(result.idempotentReplay());
            return result;
        }

        @Override public List<ReviewRecord> read(Actor actor, ReviewCaseRef reviewCase) {
            return delegate.read(actor, reviewCase);
        }
    }
}
