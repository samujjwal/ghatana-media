package com.ghatana.media.provider.aws;

import static com.ghatana.media.production.review.ReviewContracts.*;

import java.sql.Connection;
import java.sql.PreparedStatement;
import java.sql.ResultSet;
import java.sql.SQLException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Objects;
import java.util.Set;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Supplier;

/** Durable append-only review records for exact externally issued case references. */
public final class PostgresqlReviewStore implements ReviewStore, AutoCloseable {
    private final MediaAwsPostgresqlRuntimeState state;
    private final AtomicBoolean closed = new AtomicBoolean();

    /** Registers only externally supplied case references; conflicting references fail closed. */
    public PostgresqlReviewStore(List<ReviewCaseRef> issuedCases) {
        List<ReviewCaseRef> snapshot = List.copyOf(issuedCases);
        Set<String> seen = new HashSet<>();
        for (ReviewCaseRef reviewCase : snapshot) {
            Objects.requireNonNull(reviewCase);
            if (!seen.add(reviewCase.tenantId() + "\u0000" + reviewCase.reviewCaseId())) {
                throw new IllegalArgumentException("duplicate review case identity");
            }
        }
        MediaAwsPostgresqlRuntimeState acquired = MediaAwsPostgresqlRuntimeState.acquire();
        this.state = acquired;
        try { for (ReviewCaseRef reviewCase : snapshot) registerExactCase(reviewCase); }
        catch (RuntimeException | Error failure) {
            closed.set(true);
            acquired.release();
            throw failure;
        }
    }

    private void registerExactCase(ReviewCaseRef ref) {
        try (Connection c = state.connection()) {
            c.setAutoCommit(false);
            try {
                try (PreparedStatement insert = c.prepareStatement("""
                        INSERT INTO media_review_cases
                          (tenant_id,review_case_id,exact_target_ref,subject_kind,subject_object_id,
                           subject_version_id,scope_ref)
                        VALUES (?,?,?,?,?,?,?) ON CONFLICT (tenant_id,review_case_id) DO NOTHING
                        """)) {
                    bindCase(insert, ref); insert.executeUpdate();
                }
                verifyCase(c, ref, false);
                c.commit();
            } catch (SQLException | RuntimeException failure) { c.rollback(); throw failure; }
        } catch (SQLException failure) { throw persistence("review case registration", failure); }
    }

    @Override public ReviewRecord append(Actor actor, ReviewCaseRef ref, long expectedRevision, String requestId,
                                         String fingerprint, String appendRecordId, String authorityVersion,
                                         Payload payload, Instant createdAt) {
        return appendWithReplay(actor, ref, expectedRevision, requestId, fingerprint, appendRecordId,
                authorityVersion, payload, createdAt).record();
    }

    @Override public StoreAppendResult appendWithReplay(Actor actor, ReviewCaseRef ref, long expectedRevision,
                                         String requestId, String fingerprint, String appendRecordId,
                                         String authorityVersion, Payload payload, Instant createdAt) {
        return appendWithReplayAndLazyId(actor, ref, expectedRevision, requestId, fingerprint,
                () -> appendRecordId, authorityVersion, payload, createdAt);
    }

    @Override public StoreAppendResult appendWithReplayAndLazyId(Actor actor, ReviewCaseRef ref,
                                         long expectedRevision, String requestId, String fingerprint,
                                         Supplier<String> appendRecordId, String authorityVersion,
                                         Payload payload, Instant createdAt) {
        ensureOpen(); Objects.requireNonNull(actor); Objects.requireNonNull(ref); Objects.requireNonNull(payload);
        Objects.requireNonNull(appendRecordId);
        Objects.requireNonNull(createdAt);
        if (!actor.tenantId().equals(ref.tenantId())) throw new ReviewCaseMismatchException();
        if (expectedRevision < 0 || fingerprint == null || !fingerprint.matches("[0-9a-f]{64}"))
            throw new IllegalArgumentException("invalid review revision or fingerprint");
        try (Connection c = state.connection()) {
            c.setAutoCommit(false);
            try {
                verifyCase(c, ref, true);
                StoreAppendResult replay = replay(c, actor, ref, requestId, fingerprint);
                if (replay != null) { c.commit(); return replay; }
                long actual = revision(c, ref);
                if (actual != expectedRevision) throw new ReviewConflictException(expectedRevision, actual);
                if (expectedRevision == Long.MAX_VALUE) throw new ReviewRevisionOverflowException();
                try (PreparedStatement update = c.prepareStatement("""
                        UPDATE media_review_cases SET case_revision=?
                        WHERE tenant_id=? AND review_case_id=? AND case_revision=?
                        """)) {
                    update.setLong(1, expectedRevision + 1); update.setString(2, ref.tenantId());
                    update.setString(3, ref.reviewCaseId()); update.setLong(4, expectedRevision);
                    if (update.executeUpdate() != 1) throw new ReviewConflictException(expectedRevision, revision(c, ref));
                }
                String allocatedId = Objects.requireNonNull(appendRecordId.get(), "appendRecordId");
                insertRecord(c, actor, ref, expectedRevision + 1, requestId, fingerprint,
                        allocatedId, authorityVersion, payload, createdAt);
                ReviewRecord result = new ReviewRecord(allocatedId, actor.tenantId(), ref.reviewCaseId(),
                        ref.reviewSubjectRef(), requestId, payload.operationId(), actor, payload,
                        expectedRevision + 1, createdAt, authorityVersion);
                c.commit(); return new StoreAppendResult(result, false);
            } catch (SQLException | RuntimeException failure) {
                c.rollback();
                if (failure instanceof SQLException sql && "23505".equals(sql.getSQLState())) {
                    return replayAfterConflict(actor, ref, requestId, fingerprint);
                }
                throw failure;
            }
        } catch (SQLException failure) { throw persistence("review append", failure); }
    }

    @Override public List<ReviewRecord> read(Actor actor, ReviewCaseRef ref) {
        ensureOpen(); Objects.requireNonNull(actor); Objects.requireNonNull(ref);
        if (!actor.tenantId().equals(ref.tenantId())) throw new ReviewCaseMismatchException();
        try (Connection c = state.connection()) {
            verifyCase(c, ref, false);
            List<ReviewRecord> records = new ArrayList<>();
            try (PreparedStatement q = c.prepareStatement("""
                    SELECT case_revision,append_record_id,request_id,principal_id,operation_id,authority_version,
                           payload_kind,decision,comment_disposition,payload_text,annotation::text,created_at
                    FROM media_review_records WHERE tenant_id=? AND review_case_id=? ORDER BY case_revision
                    """)) {
                q.setString(1, ref.tenantId()); q.setString(2, ref.reviewCaseId());
                try (ResultSet rows = q.executeQuery()) {
                    long expected = 1;
                    while (rows.next()) {
                        long rev = rows.getLong(1);
                        if (rev != expected++) throw new ReviewCaseMismatchException();
                        Actor recordActor = new Actor(ref.tenantId(), rows.getString(4));
                        Payload payload = readPayload(rows);
                        if (!payload.operationId().equals(rows.getString(5))) throw new ReviewCaseMismatchException();
                        records.add(new ReviewRecord(rows.getString(2), ref.tenantId(), ref.reviewCaseId(),
                                ref.reviewSubjectRef(), rows.getString(3), rows.getString(5), recordActor, payload,
                                rev, rows.getTimestamp(12).toInstant(), rows.getString(6)));
                    }
                }
            }
            if (records.size() != revision(c, ref)) throw new ReviewCaseMismatchException();
            return List.copyOf(records);
        } catch (SQLException failure) { throw persistence("review read", failure); }
    }

    private StoreAppendResult replay(Connection c, Actor actor, ReviewCaseRef ref, String requestId, String fingerprint)
            throws SQLException {
        try (PreparedStatement q = c.prepareStatement("""
                SELECT i.request_fingerprint,r.case_revision,r.append_record_id,r.request_id,r.operation_id,
                       r.authority_version,r.payload_kind,r.decision,r.comment_disposition,r.payload_text,
                       r.annotation::text,r.created_at,r.principal_id
                FROM media_review_idempotency i JOIN media_review_records r
                  ON (r.tenant_id,r.review_case_id,r.case_revision)=(i.tenant_id,i.review_case_id,i.case_revision)
                WHERE i.tenant_id=? AND i.principal_id=? AND i.request_id=? FOR UPDATE OF i
                """)) {
            q.setString(1, actor.tenantId()); q.setString(2, actor.principalId()); q.setString(3, requestId);
            try (ResultSet row = q.executeQuery()) {
                if (!row.next()) return null;
                if (!fingerprint.equals(row.getString(1))) throw new ReviewIdempotencyConflictException();
                if (!ref.reviewCaseId().equals(readCaseForIdempotency(c, actor, requestId)))
                    throw new ReviewIdempotencyConflictException();
                Payload payload = readPayload(row, 7);
                if (!payload.operationId().equals(row.getString(5))) throw new ReviewCaseMismatchException();
                ReviewRecord record = new ReviewRecord(row.getString(3), ref.tenantId(), ref.reviewCaseId(), ref.reviewSubjectRef(),
                        row.getString(4), row.getString(5), new Actor(ref.tenantId(), row.getString(13)), payload,
                        row.getLong(2), row.getTimestamp(12).toInstant(), row.getString(6));
                return new StoreAppendResult(record, true);
            }
        }
    }

    private String readCaseForIdempotency(Connection c, Actor actor, String requestId) throws SQLException {
        try (PreparedStatement q = c.prepareStatement("SELECT review_case_id FROM media_review_idempotency WHERE tenant_id=? AND principal_id=? AND request_id=?")) {
            q.setString(1, actor.tenantId()); q.setString(2, actor.principalId()); q.setString(3, requestId);
            try (ResultSet r = q.executeQuery()) { return r.next() ? r.getString(1) : ""; }
        }
    }

    private StoreAppendResult replayAfterConflict(Actor actor, ReviewCaseRef ref, String requestId, String fingerprint) {
        try (Connection c = state.connection()) {
            StoreAppendResult found = replay(c, actor, ref, requestId, fingerprint);
            if (found != null) return found;
            throw new ReviewCaseMismatchException();
        } catch (SQLException failure) { throw persistence("review replay", failure); }
    }

    private void insertRecord(Connection c, Actor actor, ReviewCaseRef ref, long revision, String requestId,
                              String fingerprint, String recordId, String authorityVersion, Payload payload,
                              Instant createdAt) throws SQLException {
        boolean decision = payload instanceof DecisionRecord;
        Annotation annotation = payload instanceof Comment comment ? comment.annotation() : null;
        try (PreparedStatement p = c.prepareStatement("""
                INSERT INTO media_review_records
                  (tenant_id,review_case_id,case_revision,append_record_id,request_id,principal_id,
                   request_fingerprint,operation_id,authority_version,payload_kind,decision,comment_disposition,
                   payload_text,annotation,created_at)
                VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?::jsonb,?)
                """)) {
            p.setString(1, actor.tenantId()); p.setString(2, ref.reviewCaseId()); p.setLong(3, revision);
            p.setString(4, recordId); p.setString(5, requestId); p.setString(6, actor.principalId());
            p.setString(7, fingerprint); p.setString(8, payload.operationId()); p.setString(9, authorityVersion);
            p.setString(10, decision ? "DECISION" : "COMMENT");
            p.setString(11, decision ? ((DecisionRecord) payload).decision().name() : null);
            p.setString(12, decision ? null : ((Comment) payload).disposition().name());
            p.setString(13, payload.textForSanitization());
            p.setString(14, annotation == null ? null : json(annotation));
            p.setTimestamp(15, java.sql.Timestamp.from(createdAt));
            p.executeUpdate();
        }
        try (PreparedStatement p = c.prepareStatement("""
                INSERT INTO media_review_idempotency (tenant_id,principal_id,request_id,request_fingerprint,review_case_id,case_revision)
                VALUES (?,?,?,?,?,?)
                """)) {
            p.setString(1, actor.tenantId()); p.setString(2, actor.principalId()); p.setString(3, requestId);
            p.setString(4, fingerprint); p.setString(5, ref.reviewCaseId()); p.setLong(6, revision); p.executeUpdate();
        }
    }

    private Payload readPayload(ResultSet r) throws SQLException { return readPayload(r, 7); }
    private Payload readPayload(ResultSet r, int start) throws SQLException {
        String kind = r.getString(start), decision = r.getString(start + 1), disposition = r.getString(start + 2);
        String text = r.getString(start + 3), annotation = r.getString(start + 4);
        if ("DECISION".equals(kind)) return new DecisionRecord(Decision.valueOf(decision), text);
        if (!"COMMENT".equals(kind) || disposition == null) throw new ReviewCaseMismatchException();
        Annotation value = null;
        if (annotation != null) try { value = state.mapper().readValue(annotation, Annotation.class); }
        catch (Exception failure) { throw new ReviewCaseMismatchException(); }
        return new Comment(text, CommentDisposition.valueOf(disposition), value);
    }

    private String json(Annotation annotation) {
        try { return state.mapper().writeValueAsString(annotation); }
        catch (Exception failure) { throw new IllegalArgumentException("review annotation is not serializable", failure); }
    }

    private void verifyCase(Connection c, ReviewCaseRef ref, boolean lock) throws SQLException {
        try (PreparedStatement q = c.prepareStatement("""
                SELECT exact_target_ref,subject_kind,subject_object_id,subject_version_id,scope_ref
                FROM media_review_cases WHERE tenant_id=? AND review_case_id=?
                """ + (lock ? " FOR UPDATE" : ""))) {
            q.setString(1, ref.tenantId()); q.setString(2, ref.reviewCaseId());
            try (ResultSet r = q.executeQuery()) {
                if (!r.next() || !ref.exactTargetRef().equals(r.getString(1))
                        || !ref.reviewSubjectRef().kind().name().equals(r.getString(2))
                        || !ref.reviewSubjectRef().objectId().equals(r.getString(3))
                        || !ref.reviewSubjectRef().versionId().equals(r.getString(4))
                        || !ref.scopeRef().equals(r.getString(5))) throw new ReviewCaseMismatchException();
            }
        }
    }

    private long revision(Connection c, ReviewCaseRef ref) throws SQLException {
        try (PreparedStatement q = c.prepareStatement("SELECT case_revision FROM media_review_cases WHERE tenant_id=? AND review_case_id=?")) {
            q.setString(1, ref.tenantId()); q.setString(2, ref.reviewCaseId());
            try (ResultSet r = q.executeQuery()) { if (!r.next()) throw new ReviewCaseMismatchException(); return r.getLong(1); }
        }
    }

    private static void bindCase(PreparedStatement p, ReviewCaseRef ref) throws SQLException {
        p.setString(1, ref.tenantId()); p.setString(2, ref.reviewCaseId()); p.setString(3, ref.exactTargetRef());
        p.setString(4, ref.reviewSubjectRef().kind().name()); p.setString(5, ref.reviewSubjectRef().objectId());
        p.setString(6, ref.reviewSubjectRef().versionId()); p.setString(7, ref.scopeRef());
    }
    private void ensureOpen() { if (closed.get()) throw new IllegalStateException("review store is closed"); }
    private static IllegalStateException persistence(String operation, SQLException e) { return new IllegalStateException(operation + " persistence failed", e); }
    @Override public void close() { if (closed.compareAndSet(false, true)) state.release(); }
}
