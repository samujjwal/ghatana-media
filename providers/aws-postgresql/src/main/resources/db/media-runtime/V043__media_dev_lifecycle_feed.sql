-- DEV_ONLY consumer-facing channel for the public Media lifecycle ABI (media.lifecycle-event.v1).
--
-- The transactional outbox relay (media_lifecycle_outbox, written in the same transaction as the job transition)
-- publishes into this table. A committed row here is the "consumer channel confirmed" fact on which the relay marks
-- the outbox row published; it is never job finality (the job store readback is the only authority).
--
-- Delivery is at-least-once: when the relay crashes after this insert but before it marks the outbox row, the row is
-- relayed again and appended again with the next delivery_no, so consumers must dedupe by event_ref. feed_seq is a
-- strictly increasing identity and is the consumer cursor: no per-consumer state is stored, so any number of
-- consumers each see every entry once per their own cursor.
CREATE TABLE media_dev_lifecycle_feed (
    feed_seq BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    tenant_id VARCHAR(255) NOT NULL,
    outbox_event_id VARCHAR(64) NOT NULL,
    delivery_no INTEGER NOT NULL CHECK (delivery_no >= 1),
    event_ref VARCHAR(67) NOT NULL,
    event_type VARCHAR(64) NOT NULL,
    aggregate_type VARCHAR(32) NOT NULL,
    aggregate_ref VARCHAR(67) NOT NULL,
    aggregate_id VARCHAR(512) NOT NULL,
    aggregate_version BIGINT NOT NULL CHECK (aggregate_version >= 1),
    public_json TEXT NOT NULL,
    appended_at BIGINT NOT NULL,
    CONSTRAINT uk_media_dev_lifecycle_feed_delivery UNIQUE (tenant_id, outbox_event_id, delivery_no)
);

CREATE INDEX idx_media_dev_lifecycle_feed_tenant ON media_dev_lifecycle_feed (tenant_id, feed_seq);
CREATE INDEX idx_media_dev_lifecycle_feed_aggregate ON media_dev_lifecycle_feed (tenant_id, aggregate_type, aggregate_ref);
