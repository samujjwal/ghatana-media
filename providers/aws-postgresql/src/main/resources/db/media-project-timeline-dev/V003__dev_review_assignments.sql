-- DEV_ONLY reviewer assignments for the isolated project timeline schema (isolated location; the canonical
-- media-runtime location never runs this). Rows are immutable versions: version 1 is the assignment, version 2 its
-- revocation. Assignment writes take the same media_review_cases row lock and record-revision CAS as review appends.
-- An assignment never establishes owner approval or a trusted human identity.
CREATE TABLE media_review_assignment_versions (
    tenant_id VARCHAR(255) NOT NULL,
    review_case_id VARCHAR(256) NOT NULL,
    assignment_id VARCHAR(256) NOT NULL,
    assignment_version BIGINT NOT NULL,
    reviewer_principal_id VARCHAR(255) NOT NULL,
    assigned_by_principal_id VARCHAR(255) NOT NULL,
    scopes VARCHAR(128) NOT NULL,
    expires_at TIMESTAMP WITH TIME ZONE NOT NULL,
    status VARCHAR(16) NOT NULL,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL,
    changed_at TIMESTAMP WITH TIME ZONE NOT NULL,
    request_id VARCHAR(256) NOT NULL,
    PRIMARY KEY (tenant_id, review_case_id, assignment_id, assignment_version),
    FOREIGN KEY (tenant_id, review_case_id) REFERENCES media_review_cases (tenant_id, review_case_id),
    CONSTRAINT media_review_assignment_version_check CHECK (assignment_version >= 1),
    CONSTRAINT media_review_assignment_status_check CHECK (
        (assignment_version = 1 AND status = 'ACTIVE') OR (assignment_version = 2 AND status = 'REVOKED')),
    CONSTRAINT media_review_assignment_distinct_check CHECK (reviewer_principal_id <> assigned_by_principal_id)
);

CREATE INDEX media_review_assignment_reviewer_idx
    ON media_review_assignment_versions (tenant_id, review_case_id, reviewer_principal_id);

CREATE TABLE media_review_assignment_requests (
    tenant_id VARCHAR(255) NOT NULL,
    principal_id VARCHAR(255) NOT NULL,
    request_id VARCHAR(256) NOT NULL,
    operation VARCHAR(16) NOT NULL,
    request_fingerprint CHAR(64) NOT NULL,
    review_case_id VARCHAR(256) NOT NULL,
    assignment_id VARCHAR(256) NOT NULL,
    PRIMARY KEY (tenant_id, principal_id, request_id),
    CONSTRAINT media_review_assignment_request_op_check CHECK (operation IN ('ASSIGN', 'REVOKE')),
    CONSTRAINT media_review_assignment_request_fp_check CHECK (CHAR_LENGTH(request_fingerprint) = 64)
);

COMMENT ON TABLE media_review_assignment_versions IS
    'DEV_ONLY immutable reviewer-assignment versions; not a trusted human identity or membership contract.';
