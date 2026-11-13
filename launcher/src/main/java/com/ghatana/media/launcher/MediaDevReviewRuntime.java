package com.ghatana.media.launcher;

import com.ghatana.media.production.review.DevReviewStoreFactory;
import com.ghatana.media.production.review.ManagedReviewStore;
import com.ghatana.media.production.review.ReviewContracts.*;
import com.ghatana.media.production.review.VersionedReviewEngine;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectAccessDeniedException;
import com.ghatana.media.runtime.MediaProjectTimelineContracts.ProjectNotFoundException;
import com.ghatana.media.runtime.MediaRuntimeContracts.MediaArtifact;

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
 */
public final class MediaDevReviewRuntime implements AutoCloseable {
    public static final String ENABLED = "MEDIA_DEV_REVIEW_ENABLED";
    public static final String AUTHORITY_VERSION = "dev-only.synthetic-owner.v1";
    static final String SCOPE_PREFIX = "dev-only:owner:";
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
    private final AtomicBoolean closed = new AtomicBoolean();

    MediaDevReviewRuntime(ManagedReviewStore store, MediaRuntime runtime, MediaDevProjectTimelineRuntime projects,
                          Clock clock) {
        this.store = Objects.requireNonNull(store, "store");
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
                .filter(found -> found.scopeRef().equals(scopeRef(tenantId, principalId)));
    }

    public ReviewSnapshot inspect(String tenantId, String principalId, ReviewCaseRef reviewCase) {
        ensureOpen();
        return engine.inspect(new Actor(tenantId, principalId), reviewCase);
    }

    public AppendOutcome comment(String tenantId, String principalId, ReviewCaseRef reviewCase,
                                 long expectedCaseRevision, String requestId, Comment comment) {
        requireSanitizable(comment.text(), 10_000);
        return append(tenantId, principalId, reviewCase, expectedCaseRevision, requestId, comment, true);
    }

    public AppendOutcome decide(String tenantId, String principalId, ReviewCaseRef reviewCase,
                                long expectedCaseRevision, String requestId, DecisionRecord decision,
                                boolean confirmed) {
        requireSanitizable(decision.reason(), 4_000);
        return append(tenantId, principalId, reviewCase, expectedCaseRevision, requestId, decision, confirmed);
    }

    private AppendOutcome append(String tenantId, String principalId, ReviewCaseRef reviewCase, long expectedRevision,
                                 String requestId, Payload payload, boolean confirmed) {
        ensureOpen();
        AppendRequest request = new AppendRequest(reviewCase, expectedRevision, AUTHORITY_VERSION, requestId,
                new Confirmation(payload.operationId(), reviewCase.exactTargetRef(), confirmed), payload);
        storeReplay.remove();
        try {
            AppendReceipt receipt = engine.append(new Actor(tenantId, principalId), request);
            // No store append means the engine reconciled a committed stale decision receipt: a replay.
            Boolean fromStore = storeReplay.get();
            return new AppendOutcome(receipt, fromStore == null || fromStore);
        } finally {
            storeReplay.remove();
        }
    }

    private AuthorizationDecision authorize(Actor actor, ReviewCaseRef reviewCase, String operationId, Instant now) {
        if (!reviewCase.scopeRef().equals(scopeRef(actor.tenantId(), actor.principalId()))) {
            throw new ReviewDeniedException();
        }
        String current = currentMaterial(actor.tenantId(), actor.principalId(), reviewCase.reviewSubjectRef());
        return new AuthorizationDecision(AuthorizationStatus.ALLOW, actor.tenantId(), actor.principalId(),
                reviewCase.reviewCaseId(), reviewCase.exactTargetRef(), reviewCase.scopeRef(), AUTHORITY_VERSION,
                now.plus(AUTHORITY_VALIDITY), current, RetentionStatus.ACTIVE);
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
