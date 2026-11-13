package com.ghatana.media.production.review;

import static com.ghatana.media.production.review.ReviewContracts.*;

import java.util.Optional;

/**
 * A {@link ReviewStore} that a host can open cases in at runtime. Case registration is idempotent for the
 * exact same reference and fails closed ({@link ReviewCaseMismatchException}) when an identity is reused for
 * a different subject or scope. The store never mints review authority; the host supplies the reference.
 */
public interface ManagedReviewStore extends ReviewStore, AutoCloseable {
    /** Registers an exact host-issued case; repeating the identical reference is a no-op. */
    void registerCase(ReviewCaseRef reviewCase);

    /** Reads back the exact registered reference, or empty when no such case exists for the tenant. */
    Optional<ReviewCaseRef> findCase(String tenantId, String reviewCaseId);

    @Override void close();
}
