-- Exact Event Plane append evidence and the monotonic cursor for each tenant-owned partition.
ALTER TABLE media_processing_lifecycle_outbox
    ADD COLUMN IF NOT EXISTS event_plane_stored_event_id VARCHAR(36);
ALTER TABLE media_processing_lifecycle_outbox
    ADD COLUMN IF NOT EXISTS event_plane_stream_id VARCHAR(255);
ALTER TABLE media_processing_lifecycle_outbox
    ADD COLUMN IF NOT EXISTS event_plane_offset VARCHAR(255);

CREATE TABLE IF NOT EXISTS media_processing_lifecycle_event_plane_cursor (
    tenant_id VARCHAR(255) PRIMARY KEY,
    last_offset VARCHAR(255) NOT NULL,
    last_stream_id VARCHAR(255) NOT NULL,
    last_event_id VARCHAR(255) NOT NULL,
    last_stored_event_id VARCHAR(36) NOT NULL,
    updated_at BIGINT NOT NULL
);
