ALTER TABLE media_stream_sessions
    ADD COLUMN IF NOT EXISTS in_flight_sequence BIGINT;
ALTER TABLE media_stream_sessions
    ADD COLUMN IF NOT EXISTS in_flight_attempt_id VARCHAR(128) NOT NULL DEFAULT '';

ALTER TABLE media_stream_sessions
    ADD CONSTRAINT media_stream_in_flight_pair_check
        CHECK ((in_flight_sequence IS NULL) = (in_flight_attempt_id = ''));
ALTER TABLE media_stream_sessions
    ADD CONSTRAINT media_stream_in_flight_sequence_check
        CHECK (in_flight_sequence IS NULL OR
               (last_sequence < 9223372036854775807 AND in_flight_sequence = last_sequence + 1));
ALTER TABLE media_stream_sessions
    ADD CONSTRAINT media_stream_in_flight_attempt_check
        CHECK (in_flight_attempt_id = '' OR length(in_flight_attempt_id) <= 128);
