ALTER TABLE media_processing_jobs
    ADD COLUMN IF NOT EXISTS mm_operation_snapshot TEXT;

-- Existing rows intentionally remain NULL: only multimodal parent jobs carry a durable
-- operation snapshot, and no such job predates this column.
