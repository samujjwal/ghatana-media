ALTER TABLE media_stream_sessions
    ADD COLUMN source_pts_status VARCHAR(8);
ALTER TABLE media_stream_sessions
    ADD COLUMN source_pts_ticks BIGINT;
ALTER TABLE media_stream_sessions
    ADD COLUMN source_pts_timebase_numerator BIGINT;
ALTER TABLE media_stream_sessions
    ADD COLUMN source_pts_timebase_denominator BIGINT;
ALTER TABLE media_stream_sessions
    ADD COLUMN source_pts_clock_id VARCHAR(128);
ALTER TABLE media_stream_sessions
    ADD COLUMN source_pts_unknown_reason VARCHAR(256);

ALTER TABLE media_stream_sessions
    ADD CONSTRAINT media_stream_source_pts_shape_check CHECK (
        (source_pts_status IS NULL
            AND source_pts_ticks IS NULL
            AND source_pts_timebase_numerator IS NULL
            AND source_pts_timebase_denominator IS NULL
            AND source_pts_clock_id IS NULL
            AND source_pts_unknown_reason IS NULL)
        OR (source_pts_status = 'KNOWN'
            AND source_pts_ticks IS NOT NULL
            AND source_pts_timebase_numerator IS NOT NULL AND source_pts_timebase_numerator > 0
            AND source_pts_timebase_denominator IS NOT NULL AND source_pts_timebase_denominator > 0
            AND source_pts_clock_id IS NOT NULL
            AND source_pts_clock_id ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
            AND source_pts_unknown_reason IS NULL)
        OR (source_pts_status = 'UNKNOWN'
            AND source_pts_ticks IS NULL
            AND source_pts_timebase_numerator IS NULL
            AND source_pts_timebase_denominator IS NULL
            AND source_pts_clock_id IS NULL
            AND source_pts_unknown_reason IS NOT NULL
            AND length(source_pts_unknown_reason) BETWEEN 1 AND 256
            AND length(trim(both from source_pts_unknown_reason)) > 0)
    );

ALTER TABLE media_stream_sessions
    ADD CONSTRAINT media_stream_source_pts_video_bound_check CHECK (
        source_pts_status IS NULL OR (stream_kind = 'VIDEO' AND source_version IS NOT NULL AND source_cursor IS NOT NULL)
    );
