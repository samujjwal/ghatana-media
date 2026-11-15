/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import java.util.Optional;

/**
 * Durable store of {@link MediaDelegationGrant}s. Reads are never cached by the delegate: revocation takes effect on
 * the next use. Implementations must be tenant-scoped on lookup.
 *
 * @doc.type interface
 * @doc.purpose delegation grant persistence port
 * @doc.layer product
 * @doc.pattern Port
 */
public interface MediaDelegationGrantStore {

    /** Stores a new grant; an existing grant id is never overwritten. */
    void issue(MediaDelegationGrant grant);

    /** Exact lookup by id (empty when unknown). */
    Optional<MediaDelegationGrant> find(String grantId);

    /**
     * The grant for exactly this tenant, user, agent and tool: the most recently issued one (live or revoked), so a
     * revoked grant is reported as revoked rather than as absent. Empty when no grant was ever issued.
     */
    Optional<MediaDelegationGrant> findFor(String tenantId, String principalId, String agentId, String toolId);

    /** Revokes the grant durably; false when the grant is unknown or already revoked. */
    boolean revoke(String grantId, java.time.Instant at);
}
