-- Exact immutable transcript-version readback: caption-version parents resolve the
-- persisted revision bound to a transcript_version_ref, never a latest-revision guess.
CREATE INDEX IF NOT EXISTS media_transcript_attempt_version_ref_idx
    ON media_transcript_attempt_bindings (tenant_id, transcript_version_ref);
