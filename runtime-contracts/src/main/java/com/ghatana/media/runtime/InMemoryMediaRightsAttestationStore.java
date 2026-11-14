package com.ghatana.media.runtime;

import com.ghatana.media.runtime.MediaRightsConsentContracts.Attestation;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationRecord;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationStore;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ConfirmResult;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Confirmation;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RevokeResult;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Revocation;

import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;

/**
 * In-memory {@link AttestationStore} for unit tests only. It is not durable, is never selected by a
 * composition and its records vanish on restart; it exists so rights logic can be tested without PostgreSQL.
 */
public final class InMemoryMediaRightsAttestationStore implements AttestationStore {
    private record Key(String tenantId, String attestationId) { }

    private final Map<Key, Attestation> attestations = new LinkedHashMap<>();
    private final Map<Key, Confirmation> confirmations = new LinkedHashMap<>();
    private final Map<Key, Revocation> revocations = new LinkedHashMap<>();

    @Override public String storeId() { return "in-memory-test-only"; }

    @Override public boolean ready() { return true; }

    @Override public synchronized void append(Attestation attestation) {
        Objects.requireNonNull(attestation, "attestation");
        Key key = new Key(attestation.tenantId(), attestation.attestationId());
        if (attestations.putIfAbsent(key, attestation) != null) {
            throw new IllegalStateException("attestation id already exists");
        }
    }

    @Override public synchronized Optional<AttestationRecord> find(String tenantId, String attestationId) {
        Key key = new Key(tenantId, attestationId);
        Attestation attestation = attestations.get(key);
        return attestation == null ? Optional.empty()
                : Optional.of(new AttestationRecord(attestation, confirmations.get(key), revocations.get(key)));
    }

    @Override public synchronized List<AttestationRecord> listForArtifact(String tenantId, String artifactId) {
        List<AttestationRecord> out = new ArrayList<>();
        for (Map.Entry<Key, Attestation> entry : attestations.entrySet()) {
            Attestation attestation = entry.getValue();
            if (attestation.tenantId().equals(tenantId) && attestation.artifactId().equals(artifactId)) {
                out.add(new AttestationRecord(attestation, confirmations.get(entry.getKey()),
                        revocations.get(entry.getKey())));
            }
        }
        return out;
    }

    @Override public synchronized ConfirmResult confirm(String tenantId, String attestationId, Confirmation confirmation) {
        Key key = new Key(tenantId, attestationId);
        Attestation attestation = attestations.get(key);
        if (attestation == null) return ConfirmResult.NOT_FOUND;
        if (attestation.attestingPrincipalId().equals(confirmation.confirmingPrincipalId())) {
            return ConfirmResult.SELF_CONFIRMATION;
        }
        if (revocations.containsKey(key)) return ConfirmResult.REVOKED;
        if (confirmations.containsKey(key)) return ConfirmResult.ALREADY_CONFIRMED;
        confirmations.put(key, confirmation);
        return ConfirmResult.CONFIRMED;
    }

    @Override public synchronized RevokeResult revoke(String tenantId, String attestationId, Revocation revocation) {
        Key key = new Key(tenantId, attestationId);
        if (!attestations.containsKey(key)) return RevokeResult.NOT_FOUND;
        if (revocations.containsKey(key)) return RevokeResult.ALREADY_REVOKED;
        revocations.put(key, revocation);
        return RevokeResult.REVOKED;
    }
}
