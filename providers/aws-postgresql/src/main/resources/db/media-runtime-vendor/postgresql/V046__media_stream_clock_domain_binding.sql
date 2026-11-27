ALTER TABLE media_stream_sessions
    ADD COLUMN clock_domain_ref VARCHAR(128);

ALTER TABLE media_stream_sessions
    ADD CONSTRAINT media_stream_clock_domain_ref_check CHECK (
        clock_domain_ref IS NULL
        OR clock_domain_ref ~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'
    );

ALTER TABLE media_stream_sessions
    ADD CONSTRAINT media_stream_source_pts_clock_domain_check CHECK (
        clock_domain_ref IS NULL OR source_pts_status IS NULL OR source_pts_status <> 'KNOWN'
        OR source_pts_clock_id = clock_domain_ref
    );
