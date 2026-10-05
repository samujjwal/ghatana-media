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
 * @doc.purpose JPA entity for audio file metadata persistence with tenant isolation
 * @doc.layer infrastructure
 * @doc.pattern Entity
 */
@Entity
@Table(name = "audio_files", schema = "audio_video")
@NamedQueries({
    @NamedQuery(
        name = "AudioFile.findByTenantId",
        query = "SELECT af FROM AudioFileEntity af WHERE af.tenantId = :tenantId ORDER BY af.createdAt DESC"
    ),
    @NamedQuery(
        name = "AudioFile.findByIdAndTenantId",
        query = "SELECT af FROM AudioFileEntity af WHERE af.id = :id AND af.tenantId = :tenantId AND af.deleted = false"
    ),
    @NamedQuery(
        name = "AudioFile.findByUserIdAndTenantId",
        query = "SELECT af FROM AudioFileEntity af WHERE af.userId = :userId AND af.tenantId = :tenantId AND af.deleted = false ORDER BY af.createdAt DESC"
    ),
    @NamedQuery(
        name = "AudioFile.findByStatusAndTenantId",
        query = "SELECT af FROM AudioFileEntity af WHERE af.status = :status AND af.tenantId = :tenantId"
    ),
    @NamedQuery(
        name = "AudioFile.countByTenantId",
        query = "SELECT COUNT(af) FROM AudioFileEntity af WHERE af.tenantId = :tenantId AND af.deleted = false"
    )
})
public class AudioFileEntity implements Serializable {

    private static final long serialVersionUID = 1L;

    @Id
    @Column(name = "id", nullable = false, updatable = false)
    private UUID id;

    @Column(name = "tenant_id", nullable = false, length = 64)
    private String tenantId;

    @Column(name = "user_id", nullable = false)
    private UUID userId;

    @Column(name = "file_name", nullable = false, length = 512)
    private String fileName;

    @Column(name = "storage_path", nullable = false, length = 1024)
    private String storagePath;

    @Column(name = "duration_seconds")
    private Integer durationSeconds;

    @Column(name = "sample_rate")
    private Integer sampleRate;

    @Column(name = "channels")
    private Integer channels;

    @Column(name = "format", length = 50)
    private String format;

    @Column(name = "file_size_bytes")
    private Long fileSizeBytes;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(name = "metadata", columnDefinition = "jsonb")
    private AudioMetadata metadata;

    @Enumerated(EnumType.STRING)
    @Column(name = "status", nullable = false, length = 32)
    private ProcessingStatus status = ProcessingStatus.PENDING;

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

    // AV-P1-004: Failure reason for FAILED status
    @Column(name = "failure_reason", length = 1024)
    private String failureReason;

    public enum ProcessingStatus {
        PENDING, PROCESSING, COMPLETED, FAILED, ARCHIVED
    }

    /**
     * Metadata container for flexible audio file attributes
     */
    public static class AudioMetadata implements Serializable {
        private String codec;
        private Integer bitrate;
        private String language;
        private String source;
        private String tags;

        public AudioMetadata() {}

        public String getCodec() { return codec; }
        public void setCodec(String codec) { this.codec = codec; }
        public Integer getBitrate() { return bitrate; }
        public void setBitrate(Integer bitrate) { this.bitrate = bitrate; }
        public String getLanguage() { return language; }
        public void setLanguage(String language) { this.language = language; }
        public String getSource() { return source; }
        public void setSource(String source) { this.source = source; }
        public String getTags() { return tags; }
        public void setTags(String tags) { this.tags = tags; }
    }

    // Constructors
    public AudioFileEntity() {}

    public AudioFileEntity(UUID id, String tenantId, UUID userId, String fileName,
                           String storagePath, String format) {
        this.id = id;
        this.tenantId = tenantId;
        this.userId = userId;
        this.fileName = fileName;
        this.storagePath = storagePath;
        this.format = format;
    }

    // Getters and Setters
    public UUID getId() { return id; }
    public void setId(UUID id) { this.id = id; }
    public String getTenantId() { return tenantId; }
    public void setTenantId(String tenantId) { this.tenantId = tenantId; }
    public UUID getUserId() { return userId; }
    public void setUserId(UUID userId) { this.userId = userId; }
    public String getFileName() { return fileName; }
    public void setFileName(String fileName) { this.fileName = fileName; }
    public String getStoragePath() { return storagePath; }
    public void setStoragePath(String storagePath) { this.storagePath = storagePath; }
    public Integer getDurationSeconds() { return durationSeconds; }
    public void setDurationSeconds(Integer durationSeconds) { this.durationSeconds = durationSeconds; }
    public Integer getSampleRate() { return sampleRate; }
    public void setSampleRate(Integer sampleRate) { this.sampleRate = sampleRate; }
    public Integer getChannels() { return channels; }
    public void setChannels(Integer channels) { this.channels = channels; }
    public String getFormat() { return format; }
    public void setFormat(String format) { this.format = format; }
    public Long getFileSizeBytes() { return fileSizeBytes; }
    public void setFileSizeBytes(Long fileSizeBytes) { this.fileSizeBytes = fileSizeBytes; }
    public AudioMetadata getMetadata() { return metadata; }
    public void setMetadata(AudioMetadata metadata) { this.metadata = metadata; }
    public ProcessingStatus getStatus() { return status; }
    public void setStatus(ProcessingStatus status) { this.status = status; }
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

    // AV-P1-004: Failure reason getter/setter
    public String getFailureReason() { return failureReason; }
    public void setFailureReason(String failureReason) { this.failureReason = failureReason; }
}
