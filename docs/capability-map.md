# Audio-Video Capability Mapping

**REG-P2-005**: Capability-to-module mapping for Audio-Video

This document maps STT/TTS/Vision/Multimodal capabilities to modules, routes/protos, tests, gates,
and the canonical `MEDIA-MODALITY-001` contract requirement.

Audio-Video is the semantic capability owner. Data Cloud may present governed
Media metadata/read-model projections and expose selected audio-video capabilities
through the Action Plane tool catalog. Data Cloud navigation may present the Media
projection surface, but it does not own artifact, upload, job, stream, consent, or
modality lifecycle semantics.

| Capability | Internal tool ID | Contract requirement | Data Cloud surface | User-facing location |
|------------|------------------|---------------------|--------------------|----------------------|
| Speech-to-text | `av.speech-to-text` | `MEDIA-MODALITY-001` | `audioVideo.stt` | Contextual via Media/Voice |
| Text-to-speech | `av.text-to-speech` | `MEDIA-MODALITY-001` | `audioVideo.tts` | Contextual via Media/Voice |
| Vision analysis | `av.vision-analysis` | `MEDIA-MODALITY-001` | `audioVideo.vision` | Contextual via Media Artifacts |
| Multimodal inference | `av.multimodal-inference` | `MEDIA-MODALITY-001` | `audioVideo.multimodal` | Contextual via Media Artifacts |
| Media artifacts | `datacloud.media.*` | `MEDIA-RUNTIME-001` | `media.artifacts` | `/media/artifacts` |

## STT (Speech-to-Text) Capability

### Modules
- `modules/speech/stt-service` - Main STT service
- `modules/infrastructure/persistence` - persisted audio/transcription adapters
- `modules/infrastructure/messaging` - transcription job queue adapters
- `libs/java/common` - STT engine contract and shared model/config types

### Routes/Protos
- gRPC: `stt.v1.TranscribeAudio`
- gRPC: `stt.v1.GetTranscriptionStatus`
- gRPC: `stt.v1.ListTranscriptions`
- REST: `POST /api/v1/stt/transcribe`
- REST: `GET /api/v1/stt/transcriptions/{id}`
- REST: `GET /api/v1/stt/transcriptions`

### Tests
- Unit: `modules/speech/stt-service/src/test/java/com/ghatana/stt/functional/SttFunctionalCompletenessTest.java`
- Integration: `modules/speech/stt-service/src/test/java/com/ghatana/stt/grpc/SttGrpcServiceInProcessIntegrationTest.java`
- E2E: `modules/integration-tests/src/test/java/com/ghatana/audio/video/integration/SttPersistenceE2ETest.java`

### Gates
- `media-privacy` - Validates audio privacy compliance
- `content-safety` - Validates content safety checks
- `artifact-retention` - Validates retention policy compliance
- `stt-model-validation` - Validates STT model availability

### Evidence
- `docs/AUDIO_FORMAT_SPEC.md`
- `docs/MEDIA_PRIVACY_AND_RETENTION_POLICY.md`

## TTS (Text-to-Speech) Capability

### Modules
- `modules/speech/tts-service` - Main TTS service
- `modules/infrastructure/persistence` - synthesized audio persistence adapters
- `modules/infrastructure/security` - provider authentication and authorization interceptors
- `libs/java/common` - TTS engine contract and shared model/config types

### Routes/Protos
- gRPC: `tts.v1.SynthesizeSpeech`
- gRPC: `tts.v1.GetSynthesisStatus`
- gRPC: `tts.v1.ListSyntheses`
- REST: `POST /api/v1/tts/synthesize`
- REST: `GET /api/v1/tts/syntheses/{id}`
- REST: `GET /api/v1/tts/syntheses`

### Tests
- Unit: `modules/speech/tts-service/src/test/java/com/ghatana/tts/functional/TtsFunctionalCompletenessTest.java`
- Integration: `modules/speech/tts-service/src/test/java/com/ghatana/tts/grpc/TtsGrpcServiceInProcessIntegrationTest.java`
- E2E: `modules/integration-tests/src/test/java/com/ghatana/audio/video/integration/TtsAuthenticatedIntegrationTest.java`

### Gates
- `media-privacy` - Validates audio privacy compliance
- `content-safety` - Validates content safety checks
- `artifact-retention` - Validates retention policy compliance
- `tts-model-validation` - Validates TTS model availability

### Evidence
- `docs/AUDIO_FORMAT_SPEC.md`
- `docs/MEDIA_PRIVACY_AND_RETENTION_POLICY.md`

## Vision Capability

### Modules
- `modules/vision/vision-service` - Main Vision service
- `modules/infrastructure/persistence` - media-result persistence adapters
- `modules/infrastructure/security` - media processing security validation
- `libs/java/common` - vision engine contract and shared model/config types

### Routes/Protos
- gRPC: `vision.v1.AnalyzeImage`
- gRPC: `vision.v1.GetAnalysisStatus`
- gRPC: `vision.v1.ListAnalyses`
- REST: `POST /api/v1/vision/analyze`
- REST: `GET /api/v1/vision/analyses/{id}`
- REST: `GET /api/v1/vision/analyses`

### Tests
- Unit: `modules/vision/vision-service/src/test/java/com/ghatana/vision/functional/VisionFunctionalCompletenessTest.java`
- Integration: `modules/vision/vision-service/src/test/java/com/ghatana/audio/video/vision/grpc/VisionGrpcServiceInProcessIntegrationTest.java`
- E2E: `modules/integration-tests/src/test/java/com/ghatana/audio/video/integration/MediaPipelineIntegrationTest.java`

### Gates
- `media-privacy` - Validates image privacy compliance
- `content-safety` - Validates content safety checks
- `artifact-retention` - Validates retention policy compliance
- `vision-model-validation` - Validates Vision model availability

### Evidence
- `docs/MEDIA_PRIVACY_AND_RETENTION_POLICY.md`

## Multimodal Capability

### Modules
- `modules/intelligence/multimodal-service` - Main Multimodal service
- `modules/infrastructure/messaging` - multimodal job queue adapters
- `modules/infrastructure/security` - provider authentication and authorization interceptors
- `libs/java/common` - multimodal/vision shared model/config types

### Routes/Protos
- gRPC: `multimodal.v1.ProcessMultimodal`
- gRPC: `multimodal.v1.GetProcessStatus`
- gRPC: `multimodal.v1.ListProcesses`
- REST: `POST /api/v1/multimodal/process`
- REST: `GET /api/v1/multimodal/processes/{id}`
- REST: `GET /api/v1/multimodal/processes`

### Tests
- Unit: `modules/intelligence/multimodal-service/src/test/java/com/ghatana/multimodal/functional/MultimodalFunctionalCompletenessTest.java`
- Integration: `modules/intelligence/multimodal-service/src/test/java/com/ghatana/audio/video/multimodal/grpc/MultimodalGrpcServiceInProcessIntegrationTest.java`
- E2E: `modules/integration-tests/src/test/java/com/ghatana/audio/video/integration/MultimodalContractTest.java`

### Gates
- `media-privacy` - Validates multimodal privacy compliance
- `content-safety` - Validates content safety checks
- `artifact-retention` - Validates retention policy compliance
- `multimodal-model-validation` - Validates multimodal model availability

### Evidence
- `docs/MEDIA_PRIVACY_AND_RETENTION_POLICY.md`

## Data Cloud Media Artifact Operations

### Modules
- `services/data-cloud/delivery/api` - MediaArtifactController
- `services/data-cloud/planes/data/entity` - MediaArtifactRecord, MediaProcessingJob
- `services/data-cloud/delivery/api` - MediaArtifactRepository, MediaArtifactEventEmitter

### Routes/Protos
- REST: `POST /api/v1/media/artifacts` - Register media artifact
- REST: `GET /api/v1/media/artifacts` - List media artifacts
- REST: `GET /api/v1/media/artifacts/{artifactId}` - Get media artifact
- REST: `DELETE /api/v1/media/artifacts/{artifactId}` - Delete media artifact
- REST: `POST /api/v1/media/artifacts/{artifactId}/transcribe` - Request transcription
- REST: `POST /api/v1/media/artifacts/{artifactId}/analyze` - Request vision analysis

### Tests
- Unit: `services/data-cloud/delivery/api/src/test/**/MediaArtifactControllerTest.java` — IB-097 transcription, IB-098 vision analysis, IB-099 multimodal indexing, consent/retention blocking, tenant isolation, event emission, operation recording
- Unit: `services/data-cloud/delivery/api/src/test/**/MediaArtifactControllerTenantSecurityTest.java` — cross-tenant access denial, role requirements for processing/delete
- Unit: `services/data-cloud/delivery/launcher/src/test/**/MediaArtifactProcessingJobTest.java`
- Unit: `services/data-cloud/delivery/launcher/src/test/**/StorageProfileHandlerTest.java` — storage profile selection
- Parity: `services/data-cloud/delivery/launcher/src/test/**/RouteSurfaceParityTest.java` — media.artifacts surface route parity
- Runtime: `services/data-cloud/delivery/launcher/src/test/**/runtime/RuntimeTruthServiceTest.java` — IB-062/063/065 media probe degradation precedence

### Gates
- `media-privacy` - Validates media privacy compliance
- `tenant-isolation` - Validates tenant-scoped access
- `datacloud-access` - Validates Data Cloud access permissions
- `artifact-retention` - Validates retention policy compliance

### Data Cloud Integration Status
Status vocabulary: `implemented` means the named Data Cloud-owned Media Artifacts capability exists with focused code/test evidence. It does not mark the broader Data Cloud runtime service or every external audio-video provider workflow production-complete.

- **metadata registration**: implemented - MediaArtifactController with tenant extraction, MediaArtifactRecord with status/processingState/retentionUntil fields
- **processing request**: implemented - Transcription/analysis routes implemented with nested routing and proper permissions
- **durable job lifecycle**: implemented - MediaProcessingJob entity with comprehensive lifecycle management and tenant isolation
- **result retrieval**: implemented - MediaProcessingResultRecord entity with validation, quality metrics, and data redaction
- **event emission**: implemented - MediaArtifactEventEmitter with typed lifecycle events for media processing
- **privacy/retention enforcement**: implemented - Consent validation, retention policy enforcement, and PII redaction implemented

## Shared Infrastructure

### Modules
- `modules/infrastructure/auth` - Authentication/authorization
- `modules/infrastructure/observability` - Observability (metrics, traces, logs)
- `modules/infrastructure/storage` - Media storage adapters
- `modules/infrastructure/queue` - Event queue adapters

### Routes/Protos
- gRPC: `health.v1.HealthCheck`
- REST: `GET /health`
- REST: `GET /metrics`

### Tests
- Unit: `modules/infrastructure/*/src/test/**/*Test.java`
- Integration: `modules/infrastructure/*/src/test/**/*IT.java`

### Gates
- `media-privacy` - Shared privacy gate
- `content-safety` - Shared safety gate
- `artifact-retention` - Shared retention gate

### Evidence
- `docs/API_DOCUMENTATION.md`
- `docs/CIRCUIT_BREAKER_DIFFERENCES.md`

## Feature Completeness Matrix

| Capability | Modules | Routes | Tests | Gates | Evidence | Status |
|------------|---------|--------|-------|-------|----------|--------|
| STT | ✅ | ✅ | ✅ | ✅ | ✅ | Implemented |
| TTS | ✅ | ✅ | ✅ | ✅ | ✅ | Implemented |
| Vision | ✅ | ✅ | ✅ | ✅ | ✅ | Implemented |
| Multimodal | ✅ | ✅ | ✅ | ✅ | ✅ | Implemented |
| Data Cloud Media Artifacts | ✅ | ✅ | ✅ | ✅ | ✅ | Implemented |
| Auth | ✅ | ✅ | ✅ | ✅ | ✅ | Implemented |
| Observability | ✅ | ✅ | ✅ | ✅ | ✅ | Implemented |
| Storage | ✅ | ✅ | ✅ | ✅ | ✅ | Implemented |
| Queue | ✅ | ✅ | ✅ | ✅ | ✅ | Implemented |

## Notes

- STT, TTS, Vision, and Multimodal capabilities are implemented with full module, route, test, and gate coverage
- Data Cloud Media Artifacts integration is implemented - controller, entities (MediaArtifactRecord, MediaProcessingJob, MediaProcessingResultRecord), event emitter, routes, and privacy/retention enforcement have focused code/test evidence. Broader Data Cloud production-readiness and external provider completeness remain separate.
- Audio-Video provider capabilities (STT, TTS, Vision, Multimodal) are implemented with full module/route/test/gate coverage at the provider level. Data Cloud Media Artifacts uses these providers through the Action Plane tool catalog, but provider E2E completeness is separate from Data Cloud media artifact lifecycle completeness.
- Data Cloud uses the `media.artifacts` surface for user-facing media routes; Audio-Video provider capabilities map to contextual `audioVideo.*` surfaces.
- Privacy/retention enforcement is complete with consent validation, retention policy enforcement, and PII redaction
- Evidence documentation is available for all capabilities
- Shared infrastructure modules support all capabilities
- All gates are enforced in CI/CD pipelines
- Data Cloud media routes are registered in audio-video-capabilities.yaml with proper tenant scope and policies
- STT, TTS, Vision, and Multimodal services have Data Cloud integration through the Action Plane tool catalog, event bridge tests, and security/observability conventions
