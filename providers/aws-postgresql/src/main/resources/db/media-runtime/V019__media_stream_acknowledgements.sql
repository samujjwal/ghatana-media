ALTER TABLE media_stream_sessions
    ADD COLUMN IF NOT EXISTS sequence_token_hash VARCHAR(64) NOT NULL DEFAULT '';
ALTER TABLE media_stream_sessions
    ADD COLUMN IF NOT EXISTS acknowledgement_revision BIGINT NOT NULL DEFAULT 0;
ALTER TABLE media_stream_sessions
    ADD COLUMN IF NOT EXISTS finality VARCHAR(32) NOT NULL DEFAULT 'NONE';

ALTER TABLE media_stream_sessions
    ADD CONSTRAINT media_stream_ack_revision_check CHECK (acknowledgement_revision >= 0);
ALTER TABLE media_stream_sessions
    ADD CONSTRAINT media_stream_finality_check CHECK (finality IN ('NONE','FINAL_ACKNOWLEDGED','UNKNOWN'));
