/*
 * Copyright (c) 2026 Ghatana Inc.
 * All rights reserved.
 */
package com.ghatana.audio.video.tools;

import java.time.Instant;
import java.util.Objects;
import java.util.Set;

/**
 * Explicit, scoped, revocable delegation of ONE user's authority to ONE calling agent for ONE Media tool.
 *
 * <p>A grant never carries a credential and never widens what the user may do: the delegate still calls the launcher
 * with the user's own credential, so the launcher's permission, tenant-isolation and rights/consent gates apply
 * exactly as they would to the user. The grant only narrows (tenant, user, agent, tool, named operations, named source
 * artifacts, a time window) and can be revoked at any time; every use re-reads it.
 *
 * @param grantId           opaque grant identity (audit and revocation handle)
 * @param tenantId          tenant the grant is valid in
 * @param principalId       the delegating user (the principal the launcher sees)
 * @param agentId           the calling agent the user delegated to (the envelope's callerAgentId)
 * @param toolId            the single Media tool this grant covers
 * @param operations        launcher operations this grant covers (see {@link MediaLauncherDelegate.Operation})
 * @param sourceArtifactIds exact source artifact ids the agent may name as an input; empty means the operation takes
 *                          no source input (for example synthesis from text)
 * @param issuedAt          issue time
 * @param expiresAt         end of validity
 * @param revokedAt         revocation time, or {@code null} while the grant is live
 *
 * @doc.type record
 * @doc.purpose scoped revocable user-to-agent delegation for Media tools
 * @doc.layer product
 * @doc.pattern Value Object
 */
public record MediaDelegationGrant(
        String grantId,
        String tenantId,
        String principalId,
        String agentId,
        String toolId,
        Set<String> operations,
        Set<String> sourceArtifactIds,
        Instant issuedAt,
        Instant expiresAt,
        Instant revokedAt) {

    public MediaDelegationGrant {
        grantId = required(grantId, "grantId");
        tenantId = required(tenantId, "tenantId");
        principalId = required(principalId, "principalId");
        agentId = required(agentId, "agentId");
        toolId = required(toolId, "toolId");
        operations = Set.copyOf(Objects.requireNonNull(operations, "operations"));
        if (operations.isEmpty()) throw new IllegalArgumentException("a grant must name at least one operation");
        sourceArtifactIds = Set.copyOf(Objects.requireNonNull(sourceArtifactIds, "sourceArtifactIds"));
        Objects.requireNonNull(issuedAt, "issuedAt");
        Objects.requireNonNull(expiresAt, "expiresAt");
        if (!expiresAt.isAfter(issuedAt)) throw new IllegalArgumentException("expiresAt must be after issuedAt");
    }

    public MediaDelegationGrant revoked(Instant at) {
        return new MediaDelegationGrant(grantId, tenantId, principalId, agentId, toolId, operations,
                sourceArtifactIds, issuedAt, expiresAt, Objects.requireNonNull(at, "at"));
    }

    public boolean isRevoked() { return revokedAt != null; }

    private static String required(String value, String name) {
        if (value == null || value.isBlank()) throw new IllegalArgumentException(name + " must not be blank");
        return value;
    }
}
