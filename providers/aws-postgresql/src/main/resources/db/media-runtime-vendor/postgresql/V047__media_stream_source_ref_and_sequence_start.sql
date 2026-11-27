ALTER TABLE media_stream_sessions
    ADD COLUMN source_ref VARCHAR(384);

ALTER TABLE media_stream_sessions
    ADD COLUMN sequence_start BIGINT NOT NULL DEFAULT 0;

ALTER TABLE media_stream_sessions
    ADD CONSTRAINT media_stream_source_ref_length_check CHECK (
        source_ref IS NULL OR char_length(source_ref) BETWEEN 1 AND 384
    );

ALTER TABLE media_stream_sessions
    ADD CONSTRAINT media_stream_source_sequence_start_check CHECK (
        sequence_start BETWEEN 0 AND 9007199254740991
        AND (source_ref IS NOT NULL OR sequence_start = 0)
        AND last_sequence >= sequence_start - 1
    );
