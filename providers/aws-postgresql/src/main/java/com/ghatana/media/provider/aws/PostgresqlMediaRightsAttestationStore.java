package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaRightsConsentContracts.Attestation;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationRecord;
import com.ghatana.media.runtime.MediaRightsConsentContracts.AttestationStore;
import com.ghatana.media.runtime.MediaRightsConsentContracts.ConfirmResult;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Confirmation;
import com.ghatana.media.runtime.MediaRightsConsentContracts.RevokeResult;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Revocation;
import com.ghatana.media.runtime.MediaRightsConsentContracts.Scope;
import com.ghatana.media.runtime.MediaRightsConsentContracts.StatementKind;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.sql.Timestamp;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * Durable append-only rights/consent attestation store over the canonical Media PostgreSQL schema (V036).
 * Confirmation and revocation are serialised per attestation by a row lock; the schema additionally rejects a
 * second confirmation or revocation (primary key) and a self-confirmation (check over a foreign-key-bound copy of
 * the attester). The store has no UPDATE or DELETE statement.
 */
public final class PostgresqlMediaRightsAttestationStore implements AttestationStore {
    private static final String ATTESTATION_COLUMNS = """
            tenant_id,attestation_id,artifact_id,artifact_version,content_sha256,attesting_principal_id,
            attested_at,statement_kind,scopes_csv,basis,supporting_document_artifact_ref,
            requested_confirmer_principal_id,expires_at""";

    private final MediaAwsPostgresqlRuntimeState state;
    private final AtomicBoolean closed = new AtomicBoolean();

    public PostgresqlMediaRightsAttestationStore() { this(MediaAwsPostgresqlRuntimeState.acquire()); }

    PostgresqlMediaRightsAttestationStore(MediaAwsPostgresqlRuntimeState state) {
        this.state = Objects.requireNonNull(state, "state");
    }

    @Override public String storeId() { return "postgresql-media-rights-attestations"; }

    @Override public boolean ready() { return !closed.get() && state.ready(); }

    @Override public void append(Attestation a) {
        ensureOpen();
        try (Connection connection = state.connection();
             PreparedStatement insert = connection.prepareStatement("""
                     INSERT INTO media_rights_attestations (""" + ATTESTATION_COLUMNS + """
                     ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)""")) {
            insert.setString(1, a.tenantId());
            insert.setString(2, a.attestationId());
            insert.setString(3, a.artifactId());
            insert.setString(4, a.artifactVersion());
            insert.setString(5, a.contentSha256());
            insert.setString(6, a.attestingPrincipalId());
            insert.setTimestamp(7, Timestamp.from(a.attestedAt()));
            insert.setString(8, a.statementKind().name());
            insert.setString(9, csv(a.scopes()));
            insert.setString(10, a.basis());
            insert.setString(11, a.supportingDocumentArtifactRef());
            insert.setString(12, a.requestedConfirmerPrincipalId());
            insert.setTimestamp(13, a.expiresAt() == null ? null : Timestamp.from(a.expiresAt()));
            insert.executeUpdate();
        } catch (SQLException failure) {
            if ("23505".equals(failure.getSQLState())) {
                throw new IllegalStateException("attestation id already exists", failure);
            }
            throw persistence("attestation append", failure);
        }
    }

    @Override public Optional<AttestationRecord> find(String tenantId, String attestationId) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            return find(connection, tenantId, attestationId);
        } catch (SQLException failure) {
            throw persistence("attestation read", failure);
        }
    }

    private static Optional<AttestationRecord> find(Connection connection, String tenantId, String attestationId)
            throws SQLException {
        try (PreparedStatement select = connection.prepareStatement(
                "SELECT " + ATTESTATION_COLUMNS + " FROM media_rights_attestations WHERE tenant_id=? AND attestation_id=?")) {
            select.setString(1, tenantId);
            select.setString(2, attestationId);
            try (ResultSet row = select.executeQuery()) {
                if (!row.next()) return Optional.empty();
                Attestation attestation = attestation(row);
                Map<String, Object> events = events(connection, tenantId, attestationId);
                return Optional.of(new AttestationRecord(attestation,
                        (Confirmation) events.get("CONFIRMED"), (Revocation) events.get("REVOKED")));
            }
        }
    }

    @Override public List<AttestationRecord> listForArtifact(String tenantId, String artifactId) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            List<Attestation> attestations = new ArrayList<>();
            try (PreparedStatement select = connection.prepareStatement("SELECT " + ATTESTATION_COLUMNS
                    + " FROM media_rights_attestations WHERE tenant_id=? AND artifact_id=? ORDER BY attested_at, attestation_id")) {
                select.setString(1, tenantId);
                select.setString(2, artifactId);
                try (ResultSet rows = select.executeQuery()) {
                    while (rows.next()) attestations.add(attestation(rows));
                }
            }
            Map<String, Map<String, Object>> byId = new HashMap<>();
            try (PreparedStatement select = connection.prepareStatement("""
                    SELECT e.attestation_id,e.event_kind,e.principal_id,e.occurred_at,e.detail
                      FROM media_rights_attestation_events e
                      JOIN media_rights_attestations a
                        ON a.tenant_id=e.tenant_id AND a.attestation_id=e.attestation_id
                     WHERE a.tenant_id=? AND a.artifact_id=?""")) {
                select.setString(1, tenantId);
                select.setString(2, artifactId);
                try (ResultSet rows = select.executeQuery()) {
                    while (rows.next()) {
                        byId.computeIfAbsent(rows.getString(1), ignored -> new HashMap<>())
                                .put(rows.getString(2), event(rows.getString(2), rows.getString(3),
                                        rows.getTimestamp(4), rows.getString(5)));
                    }
                }
            }
            List<AttestationRecord> out = new ArrayList<>();
            for (Attestation attestation : attestations) {
                Map<String, Object> events = byId.getOrDefault(attestation.attestationId(), Map.of());
                out.add(new AttestationRecord(attestation, (Confirmation) events.get("CONFIRMED"),
                        (Revocation) events.get("REVOKED")));
            }
            return out;
        } catch (SQLException failure) {
            throw persistence("attestation list", failure);
        }
    }

    @Override public ConfirmResult confirm(String tenantId, String attestationId, Confirmation confirmation) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                String attester = lock(connection, tenantId, attestationId);
                if (attester == null) { connection.rollback(); return ConfirmResult.NOT_FOUND; }
                if (attester.equals(confirmation.confirmingPrincipalId())) {
                    connection.rollback();
                    return ConfirmResult.SELF_CONFIRMATION;
                }
                Map<String, Object> events = events(connection, tenantId, attestationId);
                if (events.containsKey("REVOKED")) { connection.rollback(); return ConfirmResult.REVOKED; }
                if (events.containsKey("CONFIRMED")) { connection.rollback(); return ConfirmResult.ALREADY_CONFIRMED; }
                insertEvent(connection, tenantId, attestationId, "CONFIRMED", attester, confirmation.confirmingPrincipalId(),
                        confirmation.confirmedAt(), confirmation.note());
                connection.commit();
                return ConfirmResult.CONFIRMED;
            } catch (SQLException | RuntimeException failure) {
                rollbackQuietly(connection);
                throw failure;
            }
        } catch (SQLException failure) {
            throw persistence("attestation confirm", failure);
        }
    }

    @Override public RevokeResult revoke(String tenantId, String attestationId, Revocation revocation) {
        ensureOpen();
        try (Connection connection = state.connection()) {
            connection.setAutoCommit(false);
            try {
                String attester = lock(connection, tenantId, attestationId);
                if (attester == null) {
                    connection.rollback();
                    return RevokeResult.NOT_FOUND;
                }
                if (events(connection, tenantId, attestationId).containsKey("REVOKED")) {
                    connection.rollback();
                    return RevokeResult.ALREADY_REVOKED;
                }
                insertEvent(connection, tenantId, attestationId, "REVOKED", attester, revocation.revokedByPrincipalId(),
                        revocation.revokedAt(), revocation.reason());
                connection.commit();
                return RevokeResult.REVOKED;
            } catch (SQLException | RuntimeException failure) {
                rollbackQuietly(connection);
                throw failure;
            }
        } catch (SQLException failure) {
            throw persistence("attestation revoke", failure);
        }
    }

    /** Row lock only (no UPDATE), so the append-only triggers do not fire; serialises confirm/revoke races. */
    private static String lock(Connection connection, String tenantId, String attestationId) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT attesting_principal_id FROM media_rights_attestations
                 WHERE tenant_id=? AND attestation_id=? FOR UPDATE""")) {
            select.setString(1, tenantId);
            select.setString(2, attestationId);
            try (ResultSet row = select.executeQuery()) { return row.next() ? row.getString(1) : null; }
        }
    }

    private static void insertEvent(Connection connection, String tenantId, String attestationId, String kind,
                                    String attester, String principalId, java.time.Instant at, String detail)
            throws SQLException {
        try (PreparedStatement insert = connection.prepareStatement("""
                INSERT INTO media_rights_attestation_events
                  (tenant_id,attestation_id,event_kind,principal_id,attesting_principal_id,occurred_at,detail)
                VALUES (?,?,?,?,?,?,?)""")) {
            insert.setString(1, tenantId);
            insert.setString(2, attestationId);
            insert.setString(3, kind);
            insert.setString(4, principalId);
            insert.setString(5, attester);
            insert.setTimestamp(6, Timestamp.from(at));
            insert.setString(7, detail == null ? "" : detail);
            insert.executeUpdate();
        }
    }

    private static Map<String, Object> events(Connection connection, String tenantId, String attestationId)
            throws SQLException {
        Map<String, Object> out = new HashMap<>();
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT event_kind,principal_id,occurred_at,detail FROM media_rights_attestation_events
                 WHERE tenant_id=? AND attestation_id=?""")) {
            select.setString(1, tenantId);
            select.setString(2, attestationId);
            try (ResultSet rows = select.executeQuery()) {
                while (rows.next()) {
                    out.put(rows.getString(1), event(rows.getString(1), rows.getString(2), rows.getTimestamp(3),
                            rows.getString(4)));
                }
            }
        }
        return out;
    }

    private static Object event(String kind, String principal, Timestamp at, String detail) {
        return "CONFIRMED".equals(kind)
                ? new Confirmation(principal, at.toInstant(), detail)
                : new Revocation(principal, at.toInstant(), detail);
    }

    private static Attestation attestation(ResultSet row) throws SQLException {
        Set<Scope> scopes = EnumSet.noneOf(Scope.class);
        for (String scope : row.getString(9).split(",")) scopes.add(Scope.valueOf(scope));
        Timestamp expires = row.getTimestamp(13);
        return new Attestation(row.getString(1), row.getString(2), row.getString(3), row.getString(4),
                row.getString(5), row.getString(6), row.getTimestamp(7).toInstant(),
                StatementKind.valueOf(row.getString(8)), scopes, row.getString(10), row.getString(11),
                row.getString(12), expires == null ? null : expires.toInstant());
    }

    private static String csv(Set<Scope> scopes) {
        List<String> names = new ArrayList<>();
        for (Scope scope : Scope.values()) if (scopes.contains(scope)) names.add(scope.name());
        return String.join(",", names);
    }

    private static void rollbackQuietly(Connection connection) {
        try { connection.rollback(); } catch (SQLException ignored) { }
    }

    private static IllegalStateException persistence(String operation, SQLException failure) {
        return new IllegalStateException("rights/consent " + operation + " failed", failure);
    }

    private void ensureOpen() {
        if (closed.get()) throw new IllegalStateException("rights/consent attestation store is closed");
    }

    @Override public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }
}
