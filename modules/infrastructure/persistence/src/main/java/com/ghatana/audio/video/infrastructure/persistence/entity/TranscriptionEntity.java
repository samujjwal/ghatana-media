package com.ghatana.audio.video.infrastructure.persistence.entity;

import jakarta.persistence.*;
import org.hibernate.annotations.CreationTimestamp;
import org.hibernate.annotations.UpdateTimestamp;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.io.Serializable;
import java.time.Instant;
import java.util.UUID;

/**
 * @doc.type class
 * @doc.purpose JPA entity for transcription persistence
 * @doc.layer infrastructure
 * @doc.pattern Entity
 */
@Entity
@Table(name = "transcriptions", schema = "audio_video")
@NamedQueries({
    @NamedQuery(
        name = "Transcription.findByTenantId",
        query = "SELECT t FROM TranscriptionEntity t WHERE t.tenantId = :tenantId ORDER BY t.createdAt DESC"
    ),
    @NamedQuery(
        name = "Transcription.findByIdAndTenantId",
        query = "SELECT t FROM TranscriptionEntity t WHERE t.id = :id AND t.tenantId = :tenantId"
    ),
    @NamedQuery(
        name = "Transcription.findByAudioFileId",
        query = "SELECT t FROM TranscriptionEntity t WHERE t.audioFileId = :audioFileId"
    ),
    @NamedQuery(
        name = "Transcription.findByAudioFileIdAndTenantId",
        query = "SELECT t FROM TranscriptionEntity t WHERE t.audioFileId = :audioFileId AND t.tenantId = :tenantId"
    ),
    @NamedQuery(
        name = "Transcription.findByUserIdAndTenantId",
        query = "SELECT t FROM TranscriptionEntity t WHERE t.userId = :userId AND t.tenantId = :tenantId ORDER BY t.createdAt DESC"
    ),
    @NamedQuery(
        name = "Transcription.countByTenantId",
        query = "SELECT COUNT(t) FROM TranscriptionEntity t WHERE t.tenantId = :tenantId"
    )
})
public class TranscriptionEntity implements Serializable {

    private static final long serialVersionUID = 1L;

    @Id
    @Column(name = "id", nullable = false, updatable = false)
    private UUID id;

    @Column(name = "tenant_id", nullable = false, length = 64)
    private String tenantId;

    @Column(name = "audio_file_id", nullable = false)
    private UUID audioFileId;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "text", nullable = false, columnDefinition = "TEXT")
    private String text;

    @Column(name = "language", length = 10)
    private String language;

    @Column(name = "confidence")
    private Float confidence;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 32)
    private TranscriptionStatus status = TranscriptionStatus.PENDING;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "metadata", columnDefinition = "jsonb")
    private TranscriptionMetadata metadata;

    @Column(name = "model_used", length = 128)
    private String modelUsed;

    @Column(name = "processing_time_ms")
    private Long processingTimeMs;

    @CreationTimestamp
    @Column(name = "created_at", nullable = false, updatable = false)
    private Instant createdAt;

    @UpdateTimestamp
    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    @Version
    @Column(name = "version")
    private Long version;

    @Column(name = "deleted", nullable = false)
    private boolean deleted = false;

    @Column(name = "deleted_at")
    private Instant deletedAt;

    public enum TranscriptionStatus {
        PENDING, PROCESSING, COMPLETED, FAILED, CORRECTED
    }

    /**
     * Metadata container for transcription attributes.
     *
     * <p>Serialized as JSONB. Fields added here do not require schema migrations
     * (existing rows retain their stored JSON; new fields default to null on read).
     */
    public static class TranscriptionMetadata implements Serializable {
        private Boolean enablePunctuation;
        private Boolean enableSpeakerDiarization;
        private Integer speakerCount;
        private String engineVersion;

        /** Correlation/request ID that originated this transcription job. */
        private String requestId;

        /** SHA-256 hex digest of the raw audio bytes used for this transcription. */
        private String inputHashSha256;

        public TranscriptionMetadata() {}

        public Boolean getEnablePunctuation() { return enablePunctuation; }
        public void setEnablePunctuation(Boolean enablePunctuation) { this.enablePunctuation = enablePunctuation; }
        public Boolean getEnableSpeakerDiarization() { return enableSpeakerDiarization; }
        public void setEnableSpeakerDiarization(Boolean enableSpeakerDiarization) { this.enableSpeakerDiarization = enableSpeakerDiarization; }
        public Integer getSpeakerCount() { return speakerCount; }
        public void setSpeakerCount(Integer speakerCount) { this.speakerCount = speakerCount; }
        public String getEngineVersion() { return engineVersion; }
        public void setEngineVersion(String engineVersion) { this.engineVersion = engineVersion; }
        public String getRequestId() { return requestId; }
        public void setRequestId(String requestId) { this.requestId = requestId; }
        public String getInputHashSha256() { return inputHashSha256; }
        public void setInputHashSha256(String inputHashSha256) { this.inputHashSha256 = inputHashSha256; }
    }

    // Constructors
    public TranscriptionEntity() {}

    public TranscriptionEntity(UUID id, String tenantId, UUID audioFileId, UUID userId,
                               String text, String language) {
        this.id = id;
        this.tenantId = tenantId;
        this.audioFileId = audioFileId;
        this.userId = userId;
        this.text = text;
        this.language = language;
    }

    // Getters and Setters
    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }
    public UUID getAudioFileId() { return audioFileId; }
    public void setAudioFileId(UUID audioFileId) { this.audioFileId = audioFileId; }
    public UUID getUserId() { return userId; }
    public void setUserId(UUID userId) { this.userId = userId; }
    public String getText() { return text; }
    public void setText(String text) { this.text = text; }
    public String getLanguage() { return language; }
    public void setLanguage(String language) { this.language = language; }
    public Float getConfidence() { return confidence; }
    public void setConfidence(Float confidence) { this.confidence = confidence; }
    public TranscriptionStatus getStatus() { return status; }
    public void setStatus(TranscriptionStatus status) { this.status = status; }
    public TranscriptionMetadata getMetadata() { return metadata; }
    public void setMetadata(TranscriptionMetadata metadata) { this.metadata = metadata; }
    public String getModelUsed() { return modelUsed; }
    public void setModelUsed(String modelUsed) { this.modelUsed = modelUsed; }
    public Long getProcessingTimeMs() { return processingTimeMs; }
    public void setProcessingTimeMs(Long processingTimeMs) { this.processingTimeMs = processingTimeMs; }
    public Instant getCreatedAt() { return createdAt; }
    public void setCreatedAt(Instant createdAt) { this.createdAt = createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
    public void setUpdatedAt(Instant updatedAt) { this.updatedAt = updatedAt; }
    public Long getVersion() { return version; }
    public void setVersion(Long version) { this.version = version; }

    public boolean isDeleted() { return deleted; }
    public void setDeleted(boolean deleted) { this.deleted = deleted; }

    public Instant getDeletedAt() { return deletedAt; }
    public void setDeletedAt(Instant deletedAt) { this.deletedAt = deletedAt; }
}
