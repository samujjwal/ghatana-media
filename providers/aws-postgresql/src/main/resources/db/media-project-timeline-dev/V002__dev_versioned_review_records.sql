-- DEV_ONLY review tables for the isolated project timeline schema. Same DDL as canonical V033, which
-- targets the canonical media-runtime schema; the dev lane never runs that location.
CREATE TABLE media_review_cases (
    tenant_id VARCHAR(255) NOT NULL,
    review_case_id VARCHAR(256) NOT NULL,
    exact_target_ref VARCHAR(1024) NOT NULL,
    subject_kind VARCHAR(64) NOT NULL,
    subject_object_id VARCHAR(256) NOT NULL,
    subject_version_id VARCHAR(256) NOT NULL,
    scope_ref TEXT NOT NULL,
    case_revision BIGINT NOT NULL DEFAULT 0,
    PRIMARY KEY (tenant_id, review_case_id),
    CONSTRAINT media_review_case_revision_check CHECK (case_revision >= 0)
);

CREATE TABLE media_review_records (
    tenant_id VARCHAR(255) NOT NULL,
    review_case_id VARCHAR(256) NOT NULL,
    case_revision BIGINT NOT NULL,
    append_record_id VARCHAR(256) NOT NULL,
    request_id VARCHAR(256) NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    operation_id VARCHAR(256) NOT NULL,
    authority_version VARCHAR(256) NOT NULL,
    payload_kind VARCHAR(16) NOT NULL,
    decision VARCHAR(32),
    comment_disposition VARCHAR(32),
    payload_text TEXT NOT NULL,
    annotation JSONB,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    PRIMARY KEY (tenant_id, review_case_id, case_revision),
    UNIQUE (tenant_id, review_case_id, append_record_id),
    CONSTRAINT media_review_record_revision_check CHECK (case_revision > 0),
    CONSTRAINT media_review_record_fingerprint_check CHECK (CHAR_LENGTH(request_fingerprint) = 64),
    CONSTRAINT media_review_record_payload_check CHECK (
        (payload_kind = 'DECISION' AND decision IS NOT NULL AND comment_disposition IS NULL AND annotation IS NULL)
        OR (payload_kind = 'COMMENT' AND decision IS NULL AND comment_disposition IS NOT NULL)
    ),
    FOREIGN KEY (tenant_id, review_case_id) REFERENCES media_review_cases (tenant_id, review_case_id)
);

CREATE TABLE media_review_idempotency (
    tenant_id VARCHAR(255) NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    request_id VARCHAR(256) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    review_case_id VARCHAR(256) NOT NULL,
    case_revision BIGINT NOT NULL,
    PRIMARY KEY (tenant_id, principal_id, request_id),
    FOREIGN KEY (tenant_id, review_case_id, case_revision)
        REFERENCES media_review_records (tenant_id, review_case_id, case_revision),
    CONSTRAINT media_review_idempotency_fingerprint_check CHECK (CHAR_LENGTH(request_fingerprint) = 64)
);

COMMENT ON TABLE media_review_cases IS
    'Exact owner-issued review case references supplied to Media; this table does not mint review authority.';
COMMENT ON TABLE media_review_records IS
    'Append-only exact-version review statements. ACCEPT is not HUMAN_REVIEW_APPROVAL.';
