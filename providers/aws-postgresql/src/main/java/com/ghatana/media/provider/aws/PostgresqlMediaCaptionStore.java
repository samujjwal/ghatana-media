package com.ghatana.media.provider.aws;

import com.ghatana.media.runtime.MediaCaptionContracts;
import com.ghatana.media.runtime.MediaCaptionContracts.CaptionSegment;
import com.ghatana.media.runtime.MediaCaptionContracts.MediaCaptionStore;
import com.ghatana.media.runtime.MediaCaptionContracts.ParentClockLookup;
import com.ghatana.media.runtime.MediaCaptionContracts.ParentVersionKind;
import com.ghatana.media.runtime.MediaCaptionContracts.Registered;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationAuthority;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationError;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationRequest;
import com.ghatana.media.runtime.MediaCaptionContracts.RegistrationResult;
import com.ghatana.media.runtime.MediaCaptionContracts.Rejected;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicBoolean;

/**
 * PostgreSQL append-only caption-version registrations. The store never
 * fabricates authority: admission and parent clock facts come from the injected
 * trusted ports; the store enforces identity, idempotency and durability.
 */
public final class PostgresqlMediaCaptionStore implements MediaCaptionStore {
    private final MediaAwsPostgresqlRuntimeState state = MediaAwsPostgresqlRuntimeState.acquire();
    private final AtomicBoolean closed = new AtomicBoolean();

    @Override
    public RegistrationResult register(String tenantId, String principalId, RegistrationRequest request,
                                       RegistrationAuthority authority, ParentClockLookup parentLookup) {
        Objects.requireNonNull(request, "request");
        Objects.requireNonNull(authority, "authority");
        Objects.requireNonNull(parentLookup, "parentLookup");
        String fingerprint;
        try {
            fingerprint = MediaCaptionContracts.fingerprint(tenantId, principalId, request);
        } catch (MediaCaptionContracts.CaptionRegistrationException invalid) {
            return new Rejected(request.requestId(), null, invalid.error(), false);
        }
        RegistrationAuthority.Decision decision;
        try {
            decision = authority.check(new RegistrationAuthority.AuthorityCheck(tenantId, principalId,
                    request.sourceArtifactId(), request.sourceArtifactVersionId(),
                    request.parentVersionKind(), request.parentVersionId()));
        } catch (RuntimeException failure) {
            decision = RegistrationAuthority.Decision.UNAVAILABLE;
        }
        if (decision == RegistrationAuthority.Decision.DENIED) {
            return new Rejected(request.requestId(), fingerprint, RegistrationError.VERSION_REGISTRATION_NOT_ALLOWED, false);
        }
        if (decision != RegistrationAuthority.Decision.ADMITTED) {
            return new Rejected(request.requestId(), fingerprint, RegistrationError.UNAVAILABLE, true);
        }
        Optional<ParentClockLookup.ParentFacts> parent;
        try {
            parent = parentLookup.resolve(request.parentVersionKind(), request.parentVersionId(),
                    request.sourceArtifactId(), request.sourceArtifactVersionId());
        } catch (RuntimeException failure) {
            return new Rejected(request.requestId(), fingerprint, RegistrationError.UNAVAILABLE, true);
        }
        if (parent.isEmpty()) {
            return new Rejected(request.requestId(), fingerprint, RegistrationError.SOURCE_NOT_READY, true);
        }
        ParentClockLookup.ParentFacts facts = parent.get();
        if (!facts.sourceClockId().equals(request.sourceClockId())
                || facts.ticksPerSecond() != request.ticksPerSecond()
                || facts.sourceDurationTicks() != request.sourceDurationTicks()) {
            return new Rejected(request.requestId(), fingerprint, RegistrationError.CAPTION_ALIGNMENT_REQUIRED, false);
        }
        try {
            return insert(tenantId, principalId, request, fingerprint, System.currentTimeMillis());
        } catch (SQLException failure) {
            return new Rejected(request.requestId(), fingerprint, RegistrationError.UNKNOWN_OUTCOME, true);
        }
    }

    private RegistrationResult insert(String tenantId, String principalId, RegistrationRequest request,
                                      String fingerprint, long now) throws SQLException {
        for (int attempt = 0; attempt < 3; attempt++) {
            try (Connection connection = state.connection()) {
                connection.setAutoCommit(false);
                try {
                    Optional<RegistrationResult> existing = replay(connection, tenantId, principalId,
                            request.requestId(), fingerprint);
                    if (existing.isPresent()) {
                        connection.rollback();
                        return existing.get();
                    }
                    String captionVersionId = "capv-" + UUID.randomUUID();
                    String receiptId = "capreg-" + UUID.randomUUID();
                    try (PreparedStatement insert = connection.prepareStatement("""
                            INSERT INTO media_caption_registrations
                              (tenant_id,principal_id,request_id,request_fingerprint,caption_version_id,
                               registration_receipt_id,source_artifact_id,source_artifact_version_id,
                               parent_version_kind,parent_version_id,source_clock_id,ticks_per_second,
                               source_duration_ticks,language_disposition,language_tag_present,language_tag,
                               purpose_present,purpose,segments_json,registered_at)
                            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
                            """)) {
                        bind(insert, tenantId, principalId, request, fingerprint, captionVersionId, receiptId, now);
                        insert.executeUpdate();
                    }
                    connection.commit();
                    return new Registered(request.requestId(), fingerprint, captionVersionId, receiptId,
                            request.sourceArtifactId(), request.sourceArtifactVersionId(),
                            request.parentVersionKind(), request.parentVersionId(),
                            request.languageDisposition(), request.sourceClockId(), now);
                } catch (RuntimeException | SQLException failure) {
                    connection.rollback();
                    throw failure;
                }
            } catch (SQLException failure) {
                if (attempt == 2 || !"23505".equals(failure.getSQLState())) throw failure;
                // concurrent insert on the same request key: re-read and reconcile
            }
        }
        return new Rejected(request.requestId(), fingerprint, RegistrationError.UNKNOWN_OUTCOME, true);
    }

    private Optional<RegistrationResult> replay(Connection connection, String tenantId, String principalId,
                                              String requestId, String fingerprint) throws SQLException {
        try (PreparedStatement select = connection.prepareStatement("""
                SELECT request_fingerprint,caption_version_id,registration_receipt_id,
                       source_artifact_id,source_artifact_version_id,parent_version_kind,parent_version_id,
                       language_disposition,source_clock_id,ticks_per_second,source_duration_ticks,
                       language_tag_present,language_tag,purpose_present,purpose,segments_json,registered_at
                FROM media_caption_registrations
                WHERE tenant_id=? AND principal_id=? AND request_id=? FOR UPDATE
                """)) {
            select.setString(1, tenantId);
            select.setString(2, principalId);
            select.setString(3, requestId);
            try (ResultSet row = select.executeQuery()) {
                if (!row.next()) return Optional.empty();
                String storedFingerprint = row.getString(1);
                RegistrationRequest storedRequest;
                try {
                    storedRequest = new RegistrationRequest(requestId, row.getString(4), row.getString(5),
                            ParentVersionKind.valueOf(row.getString(6)), row.getString(7), row.getString(9),
                            row.getLong(10), row.getLong(11),
                            MediaCaptionContracts.LanguageDisposition.valueOf(row.getString(8)),
                            optionalStoredValue(row, 12, 13, "language tag"),
                            MediaCaptionContracts.parseSegmentsJson(row.getString(16)),
                            optionalStoredValue(row, 14, 15, "purpose"));
                    if (!MediaCaptionContracts.fingerprint(tenantId, principalId, storedRequest)
                            .equals(storedFingerprint)) {
                        throw new IllegalStateException("stored caption request differs from its immutable fingerprint");
                    }
                } catch (RuntimeException corruptRecord) {
                    throw new SQLException("caption registration replay integrity check failed", "XX001", corruptRecord);
                }
                if (!storedFingerprint.equals(fingerprint)) {
                    return Optional.of(new Rejected(requestId, fingerprint, RegistrationError.IDEMPOTENCY_CONFLICT, false));
                }
                return Optional.of(new Registered(requestId, fingerprint, row.getString(2), row.getString(3),
                        row.getString(4), row.getString(5),
                        ParentVersionKind.valueOf(row.getString(6)), row.getString(7),
                        com.ghatana.media.runtime.MediaCaptionContracts.LanguageDisposition.valueOf(row.getString(8)),
                        row.getString(9), row.getLong(17)));
            }
        }
    }

    @Override
    public List<Registered> versions(String tenantId, String principalId, String sourceArtifactId,
                                     String sourceArtifactVersionId) {
        try (Connection connection = state.connection();
             PreparedStatement select = connection.prepareStatement("""
                SELECT request_id,request_fingerprint,caption_version_id,registration_receipt_id,
                       parent_version_kind,parent_version_id,language_disposition,source_clock_id,registered_at
                FROM media_caption_registrations
                WHERE tenant_id=? AND principal_id=? AND source_artifact_id=? AND source_artifact_version_id=?
                ORDER BY registered_at, caption_version_id
                """)) {
            select.setString(1, tenantId);
            select.setString(2, principalId);
            select.setString(3, sourceArtifactId);
            select.setString(4, sourceArtifactVersionId);
            List<Registered> out = new ArrayList<>();
            try (ResultSet row = select.executeQuery()) {
                while (row.next()) {
                    out.add(new Registered(row.getString(1), row.getString(2), row.getString(3), row.getString(4),
                            sourceArtifactId, sourceArtifactVersionId,
                            ParentVersionKind.valueOf(row.getString(5)), row.getString(6),
                            com.ghatana.media.runtime.MediaCaptionContracts.LanguageDisposition.valueOf(row.getString(7)),
                            row.getString(8), row.getLong(9)));
                }
            }
            return out;
        } catch (SQLException failure) {
            throw new IllegalStateException("caption versions readback failed", failure);
        }
    }

    @Override
    public Optional<MediaCaptionContracts.CaptionVersionSnapshot> version(String tenantId,
            String principalId, String captionVersionId) {
        try (Connection connection = state.connection();
             PreparedStatement select = connection.prepareStatement("""
                SELECT request_id,request_fingerprint,registration_receipt_id,source_artifact_id,
                       source_artifact_version_id,parent_version_kind,parent_version_id,source_clock_id,
                       ticks_per_second,source_duration_ticks,language_disposition,language_tag_present,
                       language_tag,purpose_present,purpose,segments_json,registered_at
                FROM media_caption_registrations
                WHERE tenant_id=? AND principal_id=? AND caption_version_id=?
                """)) {
            select.setString(1, tenantId);
            select.setString(2, principalId);
            select.setString(3, captionVersionId);
            try (ResultSet row = select.executeQuery()) {
                if (!row.next()) return Optional.empty();
                var snapshot = new MediaCaptionContracts.CaptionVersionSnapshot(
                        row.getString(1), row.getString(2), captionVersionId, row.getString(3),
                        row.getString(4), row.getString(5),
                        ParentVersionKind.valueOf(row.getString(6)), row.getString(7),
                        row.getString(8), row.getLong(9), row.getLong(10),
                        MediaCaptionContracts.LanguageDisposition.valueOf(row.getString(11)),
                        optionalStoredValue(row, 12, 13, "language tag"),
                        MediaCaptionContracts.parseSegmentsJson(row.getString(16)),
                        optionalStoredValue(row, 14, 15, "purpose"),
                        row.getLong(17));
                var request = new RegistrationRequest(snapshot.requestId(), snapshot.sourceArtifactId(),
                        snapshot.sourceArtifactVersionId(), snapshot.parentVersionKind(), snapshot.parentVersionId(),
                        snapshot.sourceClockId(), snapshot.ticksPerSecond(), snapshot.sourceDurationTicks(),
                        snapshot.languageDisposition(), snapshot.languageTag(), snapshot.captionSegments(),
                        snapshot.purpose());
                if (!MediaCaptionContracts.fingerprint(tenantId, principalId, request)
                        .equals(snapshot.requestFingerprint())) {
                    throw new IllegalStateException(
                            "caption version readback differs from its immutable request fingerprint");
                }
                return Optional.of(snapshot);
            }
        } catch (SQLException failure) {
            throw new IllegalStateException("caption version readback failed", failure);
        }
    }

    @Override
    public Optional<ParentClockLookup.ParentFacts> parentClock(String tenantId, String principalId,
            String captionVersionId, String sourceArtifactId, String sourceArtifactVersionId) {
        // Resolve through the immutable snapshot path so a parent cannot qualify by
        // clock columns alone when its stored request body has been altered.
        return version(tenantId, principalId, captionVersionId)
                .filter(snapshot -> snapshot.sourceArtifactId().equals(sourceArtifactId)
                        && snapshot.sourceArtifactVersionId().equals(sourceArtifactVersionId))
                .map(snapshot -> new ParentClockLookup.ParentFacts(
                        snapshot.sourceClockId(), snapshot.ticksPerSecond(), snapshot.sourceDurationTicks()));
    }

    @Override public boolean ready() { return !closed.get() && state.ready(); }

    @Override public boolean productionEligible() { return !closed.get() && state.productionEligible(); }

    private static void bind(PreparedStatement s, String tenantId, String principalId,
                             RegistrationRequest r, String fingerprint, String versionId,
                             String receiptId, long now) throws SQLException {
        s.setString(1, tenantId); s.setString(2, principalId); s.setString(3, r.requestId());
        s.setString(4, fingerprint); s.setString(5, versionId); s.setString(6, receiptId);
        s.setString(7, r.sourceArtifactId()); s.setString(8, r.sourceArtifactVersionId());
        s.setString(9, r.parentVersionKind().name()); s.setString(10, r.parentVersionId());
        s.setString(11, r.sourceClockId()); s.setLong(12, r.ticksPerSecond()); s.setLong(13, r.sourceDurationTicks());
        s.setString(14, r.languageDisposition().name());
        s.setBoolean(15, r.languageTag().isPresent()); s.setString(16, r.languageTag().orElse(null));
        s.setBoolean(17, r.purpose().isPresent()); s.setString(18, r.purpose().orElse(null));
        s.setString(19, MediaCaptionContracts.segmentsJson(r.captionSegments()));
        s.setLong(20, now);
    }

    private static Optional<String> optionalStoredValue(ResultSet row, int presenceColumn, int valueColumn,
                                                        String field) throws SQLException {
        boolean present = row.getBoolean(presenceColumn);
        String value = row.getString(valueColumn);
        if (present != (value != null)) {
            throw new IllegalStateException("caption version readback has inconsistent " + field + " presence");
        }
        return present ? Optional.of(value) : Optional.empty();
    }

    @Override
    public void close() {
        if (closed.compareAndSet(false, true)) state.release();
    }
}
