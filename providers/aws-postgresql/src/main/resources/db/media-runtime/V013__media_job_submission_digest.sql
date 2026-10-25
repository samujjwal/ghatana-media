ALTER TABLE media_processing_jobs
    ADD COLUMN submission_digest VARCHAR(64) NOT NULL DEFAULT '';

-- Media V008 rows already pin the same normalized-submission digest in request_fingerprint.
-- Carry it forward so replay fencing stays lossless across the reconciled histories.
UPDATE media_processing_jobs
SET submission_digest = request_fingerprint
WHERE submission_digest = ''
  AND request_fingerprint IS NOT NULL
  AND request_fingerprint ~ '^[0-9a-f]{64}$';
