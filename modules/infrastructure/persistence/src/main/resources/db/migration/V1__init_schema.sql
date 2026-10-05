-- Audio-Video Product Schema Initialization
CREATE SCHEMA IF NOT EXISTS audio_video;

-- Audio Files Table
CREATE TABLE IF NOT EXISTS audio_video.audio_files (
    id UUID PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    user_id UUID NOT NULL,
    file_name VARCHAR(512) NOT NULL,
    storage_path VARCHAR(1024) NOT NULL,
    duration_seconds INTEGER,
    sample_rate INTEGER,
    channels INTEGER,
    format VARCHAR(50),
    file_size_bytes BIGINT,
    metadata JSONB,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    version BIGINT DEFAULT 0,
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_audio_files_tenant_id ON audio_video.audio_files(tenant_id);
CREATE INDEX idx_audio_files_user_id ON audio_video.audio_files(user_id);
CREATE INDEX idx_audio_files_status ON audio_video.audio_files(status);
CREATE INDEX idx_audio_files_created_at ON audio_video.audio_files(created_at DESC);

-- Transcriptions Table
CREATE TABLE IF NOT EXISTS audio_video.transcriptions (
    id UUID PRIMARY KEY,
    tenant_id VARCHAR(64) NOT NULL,
    audio_file_id UUID NOT NULL,
    user_id UUID NOT NULL,
    text TEXT NOT NULL,
    language VARCHAR(10),
    confidence REAL,
    status VARCHAR(32) NOT NULL DEFAULT 'PENDING',
    metadata JSONB,
    model_used VARCHAR(128),
    processing_time_ms BIGINT,
    created_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
    version BIGINT DEFAULT 0,
    deleted BOOLEAN NOT NULL DEFAULT FALSE,
    deleted_at TIMESTAMP WITH TIME ZONE
);

CREATE INDEX idx_transcriptions_tenant_id ON audio_video.transcriptions(tenant_id);
CREATE INDEX idx_transcriptions_audio_file_id ON audio_video.transcriptions(audio_file_id);
CREATE INDEX idx_transcriptions_user_id ON audio_video.transcriptions(user_id);
CREATE INDEX idx_transcriptions_created_at ON audio_video.transcriptions(created_at DESC);

-- Full-text search index for transcriptions
CREATE INDEX idx_transcriptions_text_search ON audio_video.transcriptions 
    USING gin(to_tsvector('english', text));

COMMENT ON TABLE audio_video.audio_files IS 'Stores metadata for uploaded audio files';
COMMENT ON TABLE audio_video.transcriptions IS 'Stores speech-to-text transcription results';
