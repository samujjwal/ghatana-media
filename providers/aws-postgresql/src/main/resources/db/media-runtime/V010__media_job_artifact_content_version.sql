ALTER TABLE media_processing_jobs
    ADD COLUMN expected_artifact_version VARCHAR(71);

UPDATE media_processing_jobs job
SET expected_artifact_version = (
    SELECT 'sha256:' || artifact.sha256
    FROM media_artifacts artifact
    WHERE artifact.tenant_id = job.tenant_id
      AND artifact.artifact_id = job.artifact_id
)
WHERE EXISTS (
    SELECT 1
    FROM media_artifacts artifact
    WHERE artifact.tenant_id = job.tenant_id
      AND artifact.artifact_id = job.artifact_id
);
