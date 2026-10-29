-- Production ADMITTED is a distinct transcript admission state. It is written only after the
-- canonical store verifies the authorized STT snapshot, the still-live source-rights decision
-- and the matching revocation epoch inside the same transaction; unverified results remain
-- CANDIDATE and are unaffected by this widened constraint.
ALTER TABLE media_transcript_revisions
    DROP CONSTRAINT media_transcript_admission_check;
ALTER TABLE media_transcript_revisions
    ADD CONSTRAINT media_transcript_admission_check
    CHECK (admission_status IN ('CANDIDATE','ADMITTED'));
