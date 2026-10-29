ALTER TABLE media_transcript_revisions
    ADD COLUMN IF NOT EXISTS timing_availability TEXT NOT NULL DEFAULT 'NOT_SUPPLIED',
    ADD COLUMN IF NOT EXISTS segments_json TEXT NOT NULL DEFAULT '[]';

-- Existing rows intentionally retain the NOT_SUPPLIED default and an empty segment
-- list: no stored revision predating this column carried per-segment timing, and
-- explicit absence is the honest aggregate rather than an inferred claim.
