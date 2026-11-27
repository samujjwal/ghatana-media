ALTER TABLE media_stream_sessions
    ADD COLUMN IF NOT EXISTS source_version VARCHAR(384);
ALTER TABLE media_stream_sessions
    ADD COLUMN IF NOT EXISTS source_cursor BIGINT;

ALTER TABLE media_stream_sessions
    ADD CONSTRAINT media_stream_source_checkpoint_pair_check
        CHECK ((source_version IS NULL) = (source_cursor IS NULL));
ALTER TABLE media_stream_sessions
    ADD CONSTRAINT media_stream_source_cursor_check
        CHECK (source_cursor IS NULL OR source_cursor >= 0 AND source_cursor < 9223372036854775807);
