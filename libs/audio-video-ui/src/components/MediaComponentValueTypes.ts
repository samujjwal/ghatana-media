/** Exact TypeScript shapes for the closed Media component-value-types.yaml definitions. */
export namespace MediaComponentValueTypes {
  export interface JsonObject { readonly [key: string]: JsonValue; }
  export type JsonValue = string | number | boolean | null | readonly JsonValue[] | JsonObject;
  export type MediaViewRef = 'media.view.adjust-color' | 'media.view.animate-media' | 'media.view.arrange-scenes' | 'media.view.authenticate-and-select-context' | 'media.view.browse-media' | 'media.view.check-job-outcome' | 'media.view.check-processing-options' | 'media.view.check-processing-readiness' | 'media.view.choose-eligible-processing-option' | 'media.view.compare-caption-versions' | 'media.view.compare-results' | 'media.view.compose-media' | 'media.view.compose-scene' | 'media.view.correct-captions' | 'media.view.create-audio' | 'media.view.create-image' | 'media.view.create-media' | 'media.view.create-video' | 'media.view.deliver-output' | 'media.view.edit-captions' | 'media.view.edit-media' | 'media.view.edit-media-region' | 'media.view.explore-simulation' | 'media.view.find-projects' | 'media.view.find-task-guidance' | 'media.view.import-media' | 'media.view.improve-media' | 'media.view.inspect-media' | 'media.view.inspect-output' | 'media.view.inspect-provenance' | 'media.view.job-status' | 'media.view.monitor-transcription' | 'media.view.prepare-render' | 'media.view.resume-work' | 'media.view.review-activity' | 'media.view.review-creation-plan' | 'media.view.review-dubbing' | 'media.view.review-exact-version' | 'media.view.review-outputs' | 'media.view.review-quality' | 'media.view.review-rights-and-consent' | 'media.view.review-transcript' | 'media.view.review-workspace-settings' | 'media.view.select-source' | 'media.view.use-authorized-voice' | 'media.view.work-in-project' | 'media.view.work-with-speech';
  export type RegisteredMediaReturnRouteRef = 'media.view.adjust-color' | 'media.view.animate-media' | 'media.view.arrange-scenes' | 'media.view.authenticate-and-select-context' | 'media.view.browse-media' | 'media.view.check-processing-options' | 'media.view.check-processing-readiness' | 'media.view.choose-eligible-processing-option' | 'media.view.compare-results' | 'media.view.compose-media' | 'media.view.compose-scene' | 'media.view.create-audio' | 'media.view.create-image' | 'media.view.create-media' | 'media.view.create-video' | 'media.view.deliver-output' | 'media.view.edit-captions' | 'media.view.edit-media' | 'media.view.edit-media-region' | 'media.view.explore-simulation' | 'media.view.find-projects' | 'media.view.find-task-guidance' | 'media.view.import-media' | 'media.view.improve-media' | 'media.view.inspect-media' | 'media.view.inspect-output' | 'media.view.inspect-provenance' | 'media.view.job-status' | 'media.view.prepare-render' | 'media.view.resume-work' | 'media.view.review-activity' | 'media.view.review-creation-plan' | 'media.view.review-dubbing' | 'media.view.review-exact-version' | 'media.view.review-outputs' | 'media.view.review-quality' | 'media.view.review-rights-and-consent' | 'media.view.review-workspace-settings' | 'media.view.use-authorized-voice' | 'media.view.work-in-project' | 'media.view.work-with-speech';
  export type MediaActionIntentRef = 'media.action.add-scene-entity' | 'media.action.add-storyboard-scene' | 'media.action.align-caption-timing' | 'media.action.align-source-time-interval' | 'media.action.apply-admitted-edit' | 'media.action.apply-authorized-rights-restriction' | 'media.action.associate-authorized-reference' | 'media.action.attach-source-asset' | 'media.action.begin-artifact-upload' | 'media.action.change-interpolation-curve' | 'media.action.change-permitted-preference' | 'media.action.check-job-outcome' | 'media.action.choose-admitted-audio-operation' | 'media.action.choose-alignment-basis' | 'media.action.choose-intent' | 'media.action.choose-media-improvement-intent' | 'media.action.choose-named-destination' | 'media.action.choose-source' | 'media.action.compare-candidate-on-metric' | 'media.action.compare-caption-versions' | 'media.action.compare-media-versions' | 'media.action.continue-within-recorded-scope' | 'media.action.correct-caption' | 'media.action.create-project' | 'media.action.deliver-exact-version' | 'media.action.edit-admitted-adjustment' | 'media.action.edit-audio-mix-controls' | 'media.action.edit-keyframe' | 'media.action.edit-mask-boundary' | 'media.action.edit-requested-outcome-and-admitted-controls' | 'media.action.edit-scene-timing-or-transition' | 'media.action.edit-transition-or-caption-alignment' | 'media.action.edit-unresolved-plan-decision' | 'media.action.edit-video-temporal-plan' | 'media.action.enter-exact-edit-constraints' | 'media.action.export-authorized-provenance' | 'media.action.inspect-artifact' | 'media.action.inspect-consent-and-permitted-use' | 'media.action.inspect-driver-or-constraint' | 'media.action.inspect-effective-processing-constraints' | 'media.action.inspect-generated-candidates' | 'media.action.inspect-governing-evidence' | 'media.action.inspect-input-output-color-interpretation' | 'media.action.inspect-operation-contract' | 'media.action.inspect-operation-readiness' | 'media.action.inspect-output-preview-and-version' | 'media.action.inspect-project-creation' | 'media.action.inspect-provenance' | 'media.action.inspect-quality-evidence' | 'media.action.inspect-scene-binding' | 'media.action.inspect-setting-owner' | 'media.action.inspect-simulation-domain-and-fidelity' | 'media.action.inspect-simulation-result' | 'media.action.inspect-source' | 'media.action.inspect-source-grounded-observation' | 'media.action.inspect-source-measurements' | 'media.action.inspect-version-and-review-scope' | 'media.action.inspect-voice-authorization' | 'media.action.limit-tracking-propagation-range' | 'media.action.open-admitted-delivery-action' | 'media.action.open-approval-view' | 'media.action.open-authorized-recovery-instruction' | 'media.action.open-project' | 'media.action.open-qualification-evidence' | 'media.action.open-related-view' | 'media.action.play-source' | 'media.action.prepare-redacted-diagnostics' | 'media.action.preview-current-revision' | 'media.action.preview-motion' | 'media.action.reconcile-delivery-acknowledgment' | 'media.action.record-authorized-attestation' | 'media.action.record-candidate-for-review' | 'media.action.record-review-comment' | 'media.action.record-review-follow-up' | 'media.action.record-version-review-decision' | 'media.action.refresh-operation-readiness' | 'media.action.remove-storyboard-scene' | 'media.action.reorder-storyboard-scenes' | 'media.action.reorder-track' | 'media.action.request-admitted-speech-operation' | 'media.action.request-authorized-review' | 'media.action.request-cancellation' | 'media.action.request-live-session-reconnect' | 'media.action.request-plan-validation' | 'media.action.request-rights-review' | 'media.action.request-transcription' | 'media.action.resolve-caption-conflict' | 'media.action.restore-prior-setting-preference' | 'media.action.resume-artifact-upload' | 'media.action.retry-job' | 'media.action.return-to-requested-destination-after-identity-confirmation' | 'media.action.review-bounded-repair-proposal' | 'media.action.review-estimates-and-rights-effects' | 'media.action.review-output-evidence' | 'media.action.review-processing-parameters' | 'media.action.review-recognized-or-synthesized-content' | 'media.action.review-repair-bounds' | 'media.action.review-rights-approval-and-format-effects' | 'media.action.review-scene-timing-and-transitions' | 'media.action.review-transcript' | 'media.action.review-translated-segment' | 'media.action.review-uncertain-tracking' | 'media.action.revise-dubbing-segment' | 'media.action.revoke-authorized-consent' | 'media.action.save-caption-version' | 'media.action.save-dubbing-version' | 'media.action.save-new-revision' | 'media.action.save-setting-preference' | 'media.action.save-storyboard-revision' | 'media.action.save-versioned-edit' | 'media.action.search-authorized-artifacts' | 'media.action.search-by-user-outcome' | 'media.action.search-named-profiles' | 'media.action.search-product-guidance' | 'media.action.seek-source' | 'media.action.select-artifact-source' | 'media.action.select-authorized-reference' | 'media.action.select-eligible-processing-profile' | 'media.action.select-exact-candidates' | 'media.action.select-identity-confirmed-workspace' | 'media.action.select-keyframe' | 'media.action.select-region-or-point' | 'media.action.select-scene-entity' | 'media.action.select-shot-or-region' | 'media.action.select-simulation-output-pass' | 'media.action.select-source-time-interval' | 'media.action.select-track-or-region' | 'media.action.set-declared-simulation-input' | 'media.action.set-simulation-initial-condition' | 'media.action.share-diagnostics-after-explicit-choice' | 'media.action.start-upstream-identity-handoff' | 'media.action.stop-authorized-voice-use' | 'media.action.submit-admitted-plan' | 'media.action.submit-render' | 'media.action.submit-simulation' | 'media.action.submit-validated-request' | 'media.action.switch-measurement-presentation' | 'media.action.trim-track' | 'media.action.undo-or-redo-versioned-change' | 'media.action.update-repair-bounds' | 'media.action.update-scene-binding' | 'media.action.validate-composition' | 'media.action.validate-exact-snapshot' | 'media.action.validate-processing-profile' | 'media.action.validate-scene-references' | 'media.action.validate-simulation-plan' | 'media.action.view-job-status';
  export type ActionIntentRef = 'media.action.add-scene-entity' | 'media.action.add-storyboard-scene' | 'media.action.align-caption-timing' | 'media.action.align-source-time-interval' | 'media.action.apply-admitted-edit' | 'media.action.apply-authorized-rights-restriction' | 'media.action.associate-authorized-reference' | 'media.action.attach-source-asset' | 'media.action.begin-artifact-upload' | 'media.action.change-interpolation-curve' | 'media.action.change-permitted-preference' | 'media.action.check-job-outcome' | 'media.action.choose-admitted-audio-operation' | 'media.action.choose-alignment-basis' | 'media.action.choose-intent' | 'media.action.choose-media-improvement-intent' | 'media.action.choose-named-destination' | 'media.action.choose-source' | 'media.action.compare-candidate-on-metric' | 'media.action.compare-caption-versions' | 'media.action.compare-media-versions' | 'media.action.continue-within-recorded-scope' | 'media.action.correct-caption' | 'media.action.create-project' | 'media.action.deliver-exact-version' | 'media.action.edit-admitted-adjustment' | 'media.action.edit-audio-mix-controls' | 'media.action.edit-keyframe' | 'media.action.edit-mask-boundary' | 'media.action.edit-requested-outcome-and-admitted-controls' | 'media.action.edit-scene-timing-or-transition' | 'media.action.edit-transition-or-caption-alignment' | 'media.action.edit-unresolved-plan-decision' | 'media.action.edit-video-temporal-plan' | 'media.action.enter-exact-edit-constraints' | 'media.action.export-authorized-provenance' | 'media.action.inspect-artifact' | 'media.action.inspect-consent-and-permitted-use' | 'media.action.inspect-driver-or-constraint' | 'media.action.inspect-effective-processing-constraints' | 'media.action.inspect-generated-candidates' | 'media.action.inspect-governing-evidence' | 'media.action.inspect-input-output-color-interpretation' | 'media.action.inspect-operation-contract' | 'media.action.inspect-operation-readiness' | 'media.action.inspect-output-preview-and-version' | 'media.action.inspect-project-creation' | 'media.action.inspect-provenance' | 'media.action.inspect-quality-evidence' | 'media.action.inspect-scene-binding' | 'media.action.inspect-setting-owner' | 'media.action.inspect-simulation-domain-and-fidelity' | 'media.action.inspect-simulation-result' | 'media.action.inspect-source' | 'media.action.inspect-source-grounded-observation' | 'media.action.inspect-source-measurements' | 'media.action.inspect-version-and-review-scope' | 'media.action.inspect-voice-authorization' | 'media.action.limit-tracking-propagation-range' | 'media.action.open-admitted-delivery-action' | 'media.action.open-approval-view' | 'media.action.open-authorized-recovery-instruction' | 'media.action.open-project' | 'media.action.open-qualification-evidence' | 'media.action.open-related-view' | 'media.action.play-source' | 'media.action.prepare-redacted-diagnostics' | 'media.action.preview-current-revision' | 'media.action.preview-motion' | 'media.action.reconcile-delivery-acknowledgment' | 'media.action.record-authorized-attestation' | 'media.action.record-candidate-for-review' | 'media.action.record-review-comment' | 'media.action.record-review-follow-up' | 'media.action.record-version-review-decision' | 'media.action.refresh-operation-readiness' | 'media.action.remove-storyboard-scene' | 'media.action.reorder-storyboard-scenes' | 'media.action.reorder-track' | 'media.action.request-admitted-speech-operation' | 'media.action.request-authorized-review' | 'media.action.request-cancellation' | 'media.action.request-live-session-reconnect' | 'media.action.request-plan-validation' | 'media.action.request-rights-review' | 'media.action.request-transcription' | 'media.action.resolve-caption-conflict' | 'media.action.restore-prior-setting-preference' | 'media.action.resume-artifact-upload' | 'media.action.retry-job' | 'media.action.return-to-requested-destination-after-identity-confirmation' | 'media.action.review-bounded-repair-proposal' | 'media.action.review-estimates-and-rights-effects' | 'media.action.review-output-evidence' | 'media.action.review-processing-parameters' | 'media.action.review-recognized-or-synthesized-content' | 'media.action.review-repair-bounds' | 'media.action.review-rights-approval-and-format-effects' | 'media.action.review-scene-timing-and-transitions' | 'media.action.review-transcript' | 'media.action.review-translated-segment' | 'media.action.review-uncertain-tracking' | 'media.action.revise-dubbing-segment' | 'media.action.revoke-authorized-consent' | 'media.action.save-caption-version' | 'media.action.save-dubbing-version' | 'media.action.save-new-revision' | 'media.action.save-setting-preference' | 'media.action.save-storyboard-revision' | 'media.action.save-versioned-edit' | 'media.action.search-authorized-artifacts' | 'media.action.search-by-user-outcome' | 'media.action.search-named-profiles' | 'media.action.search-product-guidance' | 'media.action.seek-source' | 'media.action.select-artifact-source' | 'media.action.select-authorized-reference' | 'media.action.select-eligible-processing-profile' | 'media.action.select-exact-candidates' | 'media.action.select-identity-confirmed-workspace' | 'media.action.select-keyframe' | 'media.action.select-region-or-point' | 'media.action.select-scene-entity' | 'media.action.select-shot-or-region' | 'media.action.select-simulation-output-pass' | 'media.action.select-source-time-interval' | 'media.action.select-track-or-region' | 'media.action.set-declared-simulation-input' | 'media.action.set-simulation-initial-condition' | 'media.action.share-diagnostics-after-explicit-choice' | 'media.action.start-upstream-identity-handoff' | 'media.action.stop-authorized-voice-use' | 'media.action.submit-admitted-plan' | 'media.action.submit-render' | 'media.action.submit-simulation' | 'media.action.submit-validated-request' | 'media.action.switch-measurement-presentation' | 'media.action.trim-track' | 'media.action.undo-or-redo-versioned-change' | 'media.action.update-repair-bounds' | 'media.action.update-scene-binding' | 'media.action.validate-composition' | 'media.action.validate-exact-snapshot' | 'media.action.validate-processing-profile' | 'media.action.validate-scene-references' | 'media.action.validate-simulation-plan' | 'media.action.view-job-status';
  export type CanonicalIntentRef = 'media.intent.animate' | 'media.intent.check-processing-options' | 'media.intent.check-processing-readiness' | 'media.intent.choose-eligible-processing-option' | 'media.intent.create' | 'media.intent.deliver' | 'media.intent.edit' | 'media.intent.find-task-guidance' | 'media.intent.improve' | 'media.intent.inspect-provenance' | 'media.intent.manage-artifact-lifecycle' | 'media.intent.recover-live-session' | 'media.intent.resolve-job' | 'media.intent.restore-project' | 'media.intent.review-exact-version' | 'media.intent.review-rights-and-consent' | 'media.intent.review-workspace-settings' | 'media.intent.simulate' | 'media.intent.understand';
  export type TenantScopedWorkspaceRef = Readonly<{
    readonly tenantId: string;
    readonly workspaceId: string;
  }>;
  export type ExactArtifactVersionRef = Readonly<{
    readonly tenantId: string;
    readonly artifactId: string;
    readonly versionId: string;
  }>;
  export type ImmutableProjectRevisionRef = Readonly<{
    readonly tenantId: string;
    readonly projectId: string;
    readonly revisionId: string;
  }>;
  export type ExactCompositionVersionRef = Readonly<{
    readonly tenantId: string;
    readonly compositionId: string;
    readonly versionId: string;
  }>;
  export type ExactTranscriptVersionRef = Readonly<{
    readonly tenantId: string;
    readonly transcriptId: string;
    readonly versionId: string;
  }>;
  export type ExactModelVersionRef = Readonly<{
    readonly modelId: string;
    readonly versionId: string;
    readonly digest: string;
  }>;
  export type ExactSceneVersionRef = Readonly<{
    readonly tenantId: string;
    readonly sceneId: string;
    readonly versionId: string;
  }>;
  export type ExactSubjectVersionRef = Readonly<{
    readonly tenantId: string;
    readonly subjectId: string;
    readonly versionId: string;
  }>;
  export type OpaqueProjectRef = Readonly<{
    readonly tenantId: string;
    readonly projectId: string;
  }>;
  export type ProjectSearchQuery = Readonly<{
    readonly text: string;
    readonly sort: 'recent' | 'name';
    readonly limit: number;
  }>;
  export type ArtifactSearchQuery = Readonly<{
    readonly text: string;
    readonly mediaTypes: readonly (string)[];
    readonly limit: number;
  }>;
  export type PageState = Readonly<{
    readonly status: 'loading' | 'populated' | 'empty' | 'partial' | 'stale' | 'offline' | 'access-denied';
    readonly nextPageRef: (string) | (null);
  }>;
  export type RationalSourceTime = Readonly<{
    readonly clockKind: 'media' | 'simulation' | 'story';
    readonly clockId: string;
    readonly streamId: string;
    readonly ticks: string;
    readonly secondsPerTick: Readonly<{
    readonly numerator: string;
    readonly denominator: string;
  }>;
  }>;
  export type RationalTimelineTimebaseRef = Readonly<{
    readonly clockKind: 'media' | 'simulation' | 'story';
    readonly clockId: string;
    readonly streamId: string;
    readonly secondsPerTick: Readonly<{
    readonly numerator: string;
    readonly denominator: string;
  }>;
    readonly originTicks: string;
    readonly discontinuityPolicy: 'explicit-segments' | 'continuous-only' | 'unknown';
  }>;
  export type SourceTimebaseRef = Readonly<{
    readonly clockKind: 'media' | 'simulation' | 'story';
    readonly clockId: string;
    readonly streamId: string;
    readonly secondsPerTick: Readonly<{
    readonly numerator: string;
    readonly denominator: string;
  }>;
    readonly originTicks: string;
    readonly discontinuityPolicy: 'explicit-segments' | 'continuous-only' | 'unknown';
  }>;
  export type SourceSampleTimebaseRef = Readonly<{
    readonly clockKind: 'media';
    readonly clockId: string;
    readonly streamId: string;
    readonly sampleRateHz: number;
    readonly sampleCount: string;
    readonly channelLayoutRef: string;
    readonly originSample: string;
    readonly primingSamples: string;
    readonly paddingSamples: string;
  }>;
  export type CompositionTimebaseRef = Readonly<{
    readonly clockKind: 'media' | 'simulation' | 'story';
    readonly clockId: string;
    readonly streamId: string;
    readonly secondsPerTick: Readonly<{
    readonly numerator: string;
    readonly denominator: string;
  }>;
    readonly originTicks: string;
    readonly unit: 'frame' | 'sample' | 'second' | 'tick';
  }>;
  export type OptionalHalfOpenRationalInterval = (MediaComponentValueTypes.HalfOpenRationalInterval) | (null);
  export type OptionalHalfOpenFrameInterval = (Readonly<{
    readonly startFrame: number;
    readonly endFrame: number;
    readonly sourceVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
  }>) | (null);
  export type PositiveRationalRate = Readonly<{
    readonly numerator: number;
    readonly denominator: number;
  }>;
  export type DigestWithAlgorithm = Readonly<{
    readonly algorithm: 'sha-256' | 'sha-512' | 'blake3';
    readonly value: string;
  }>;
  export type ExplicitChannelLayout = Readonly<{
    readonly layoutId: string;
    readonly channels: readonly (string)[];
  }>;
  export type ConsentValidity = 'active' | 'revoked' | 'expired' | 'unknown' | 'not-established';
  export type IdentityHandoffRequest = Readonly<{
    readonly action: 'INITIATE_IDENTITY_HANDOFF' | 'SELECT_CONFIRMED_WORKSPACE';
    readonly mediaRequest: Readonly<{
    readonly registeredReturnRouteId: MediaComponentValueTypes.RegisteredMediaReturnRouteRef;
    readonly correlationId: string;
    readonly requestedWorkspaceId?: (string) | (null);
  }>;
    readonly hostContext: Readonly<{
    readonly interactionNonce: string;
    readonly identityStatus: 'ANONYMOUS' | 'AUTHENTICATED' | 'UNKNOWN';
    readonly principalContextRef: (string) | (null);
    readonly tenantContextRef: (string) | (null);
    readonly adapterVerificationStatus: 'HOST_ADAPTER_READY' | 'MISSING' | 'INVALID';
  }>;
  }>;
  export type IdentityHandoffResult = Readonly<{
    readonly externalOwner: string;
    readonly externalContractRef: string;
    readonly externalRevision: string;
    readonly externalFingerprint: string;
    readonly interactionNonce: string;
    readonly outcome: 'AUTHORIZED' | 'DENIED' | 'UNAVAILABLE' | 'UNKNOWN' | 'EXPIRED_OR_REVOKED';
    readonly principalContextRef: (string) | (null);
    readonly tenantContextRef: (string) | (null);
    readonly requestedWorkspaceId: (string) | (null);
    readonly membershipDisposition: 'CURRENT_MEMBER' | 'NOT_MEMBER' | 'UNKNOWN';
    readonly workspaceSelectionEvidenceRef: (string) | (null);
    readonly observedAt: string;
    readonly validUntil: string;
    readonly registeredReturnRouteId: MediaComponentValueTypes.RegisteredMediaReturnRouteRef;
    readonly hostAdapterVerificationStatus: 'HOST_VERIFIED' | 'MISSING' | 'INVALID';
  }>;
  export type IdentityOwnerPin = Readonly<{
    readonly externalOwner: string;
    readonly externalContractRef: string;
    readonly externalRevision: string;
    readonly externalFingerprint: string;
  }>;
  export type IdentityHandoffEvaluation = Readonly<{
    readonly request: MediaComponentValueTypes.IdentityHandoffRequest;
    readonly result: MediaComponentValueTypes.IdentityHandoffResult;
    readonly expectedOwnerPin: MediaComponentValueTypes.IdentityOwnerPin;
    readonly evaluatedAt: string;
    readonly evaluatorDisposition: 'HOST_ADAPTER_EVIDENCE_ACCEPTABLE_FOR_CONTEXT' | 'DENIED' | 'UNAVAILABLE' | 'REAUTHENTICATION_REQUIRED' | 'HOLD_UNKNOWN' | 'REQUEST_REJECTED';
  }>;
  export type RightsConsentScope = Readonly<{
    readonly tenantId: string;
    readonly subjectVersionRef: MediaComponentValueTypes.ExactSubjectVersionRef;
    readonly purpose: string;
    readonly territory: string;
  }>;
  export type RightsConsentType = 'copyright' | 'performer' | 'voice' | 'likeness' | 'personal-data' | 'retention' | 'distribution' | 'unknown';
  export type RetentionDecision = 'retain' | 'eligible-for-erasure' | 'erasure-pending' | 'erased' | 'denied' | 'unknown';
  export type EffectFinality = 'not-started' | 'pending' | 'succeeded' | 'partially-succeeded' | 'failed' | 'cancelled' | 'outcome-unknown';
  export type ProposalFinality = 'proposal-only' | 'unknown';
  export type MediaJobState = 'queued' | 'running' | 'completed' | 'partially-succeeded' | 'failed' | 'retry-pending' | 'outcome-unknown' | 'reconciling' | 'cancelled';
  export type CanonicalOperationState = 'pending' | 'succeeded' | 'partially-succeeded' | 'failed' | 'cancelled' | 'outcome-unknown' | 'blocked';
  export type AccessDisposition = 'authorized' | 'denied' | 'unknown' | 'unavailable' | 'limited';
  export type QualificationDisposition = 'qualified' | 'unqualified' | 'not-evaluated' | 'pending-review' | 'unknown';
  export type ObservationFreshness = 'current' | 'stale' | 'partial' | 'unknown';
  export type UploadTransferState = 'ready' | 'receiving' | 'interrupted' | 'outcome-unknown' | 'verifying' | 'available' | 'quarantined' | 'rejected';
  export type TypedExitDisposition = 'success' | 'partial' | 'pending' | 'outcome-unknown' | 'blocked' | 'failed' | 'invalid-input' | 'access-denied';
  export type IanaMediaType = string;
  export type BCP47LanguageTag = string;
  export type NonnegativeInteger = number;
  export type MeasuredNonnegativeInteger = number;
  export type CanonicalCommandId = string;
  export type OpaqueJobRef = string;
  export type OpaqueRequestRef = string;
  export type OpaqueUploadRef = string;
  export type CaptionDraftRef = string;
  export type TranscriptSegmentRef = string;
  export type FidelityDefinitionRef = string;
  export type ImageCoordinateProfileRef = string;
  export type VersionedDeliveryProfileRef = string;
  export type CurrentAuthorityRef = string;
  export type EvidenceRef = string;
  export type CompatibilityEvidence = Readonly<{
    readonly profileRef: MediaComponentValueTypes.VersionedDeliveryProfileRef;
    readonly status: 'compatible' | 'incompatible' | 'partial' | 'unknown';
    readonly evidenceRefs: readonly (MediaComponentValueTypes.EvidenceRef)[];
  }>;
  export type ExplicitFallbackPlan = Readonly<{
    readonly steps: readonly (string)[];
    readonly authorizationRequired: boolean;
    readonly selectedStep: (string) | (null);
  }>;
  export type AuthorizedDestinationRef = Readonly<{
    readonly destinationId: string;
    readonly scopeRef: string;
    readonly acknowledgementRequired: boolean;
  }>;
  export type AuthorizedPreviewRef = Readonly<{
    readonly versionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
    readonly authorizationRef: string;
    readonly expiresAt: string;
  }>;
  export type OptionalQualifiedProfileRef = (string) | (null);
  export type OptionalIdentityHandoffRequest = (MediaComponentValueTypes.IdentityHandoffRequest) | (null);
  export type OptionalIdentityHandoffEvaluation = (MediaComponentValueTypes.IdentityHandoffEvaluation) | (null);
  export type OptionalOpaqueCursor = (string) | (null);
  export type OptionalOpaqueJobRef = (string) | (null);
  export type OptionalOpaqueProjectRef = (MediaComponentValueTypes.OpaqueProjectRef) | (null);
  export type OptionalNonnegativeInteger = (number) | (null);
  export type OptionalRationalDuration = (MediaComponentValueTypes.RationalSourceTime) | (null);
  export type OptionalMeasuredProgress = (Readonly<{
    readonly numerator: number;
    readonly denominator: number;
    readonly unit: string;
    readonly observedAt: string;
  }>) | (null);
  export type OptionalSimulationRunRef = (string) | (null);
  export type OptionalTypedMachineResult = (Readonly<{
    readonly schemaId: string;
    readonly value: Readonly<Record<string, never>> | readonly (unknown)[] | string | number | boolean | null;
  }>) | (null);
  export type EstimateWithMethodAndUncertainty = Readonly<{
    readonly value: number;
    readonly unit: string;
    readonly methodRef: string;
    readonly uncertainty: Readonly<{
    readonly lower: number;
    readonly upper: number;
    readonly confidence: number;
    readonly basis: string;
  }>;
  }>;
  export type CaptionCueDraft = Readonly<{
    readonly cueId: string;
    readonly text: string;
    readonly start: MediaComponentValueTypes.RationalSourceTime;
    readonly end: MediaComponentValueTypes.RationalSourceTime;
    readonly speakerRef: (string) | (null);
  }>;
  export type TranscriptSegment = Readonly<{
    readonly segmentId: string;
    readonly text: string;
    readonly start: MediaComponentValueTypes.RationalSourceTime;
    readonly end: MediaComponentValueTypes.RationalSourceTime;
    readonly confidence: (number) | (null);
  }>;
  export type JobAttemptSummary = Readonly<{
    readonly attemptId: string;
    readonly state: MediaComponentValueTypes.MediaJobState;
    readonly finality: MediaComponentValueTypes.EffectFinality;
    readonly startedAt: string;
    readonly endedAt: (string) | (null);
    readonly reasonRef: (string) | (null);
  }>;
  export type ProvenanceUnknown = Readonly<{
    readonly field: string;
    readonly status: 'unknown' | 'not-recorded' | 'redacted' | 'unavailable';
    readonly reasonRef: string;
  }>;
  export type QualityObservation = Readonly<{
    readonly dimension: string;
    readonly value: number;
    readonly unit: string;
    readonly methodRef: string;
    readonly epistemicStatus: 'measured' | 'estimated' | 'inferred' | 'unknown';
    readonly uncertainty: MediaComponentValueTypes.EstimateWithMethodAndUncertainty;
  }>;
  export type UncertaintyInterval = Readonly<{
    readonly lower: number;
    readonly upper: number;
    readonly confidence: number;
    readonly basis: string;
  }>;
  export type ScopedAcceptanceThreshold = Readonly<{
    readonly dimension: string;
    readonly operator: 'min' | 'max' | 'range';
    readonly value: number;
    readonly unit: string;
    readonly scopeRef: string;
    readonly reviewRequired: boolean;
  }>;
  export type ReasonEvidence = Readonly<{
    readonly reasonRef: string;
    readonly evidenceRefs: readonly (MediaComponentValueTypes.EvidenceRef)[];
    readonly message: string;
  }>;
  export type ChunkReceipt = Readonly<{
    readonly chunkIndex: number;
    readonly byteStart: number;
    readonly byteLength: number;
    readonly digest: MediaComponentValueTypes.DigestWithAlgorithm;
    readonly receiptRef: string;
  }>;
  export type ArtifactVersionSummary = Readonly<{
    readonly versionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
    readonly mediaType: MediaComponentValueTypes.IanaMediaType;
    readonly createdAt: string;
    readonly access: MediaComponentValueTypes.AccessDisposition;
  }>;
  export type IntentOption = Readonly<{
    readonly intentRef: MediaComponentValueTypes.CanonicalIntentRef;
    readonly label: string;
    readonly availability: 'available' | 'unavailable';
    readonly reasonRef: (string) | (null);
  }>;
  export type EditConstraint = Readonly<{
    readonly field: string;
    readonly unit: string;
    readonly minimum: (number) | (null);
    readonly maximum: (number) | (null);
    readonly rule: 'must-preserve' | 'bounded' | 'aligned' | 'owner-review-required';
  }>;
  export type JobActivityRecord = Readonly<{
    readonly activityId: string;
    readonly jobRef: string;
    readonly observedAt: string;
    readonly state: MediaComponentValueTypes.MediaJobState;
    readonly finality: MediaComponentValueTypes.EffectFinality;
    readonly evidenceRefs: readonly (MediaComponentValueTypes.EvidenceRef)[];
  }>;
  export type ExactResultReference = Readonly<{
    readonly resultKind: 'artifact-version' | 'project-revision' | 'transcript-version' | 'caption-version' | 'delivery-record' | 'provenance-record';
    readonly identity: string;
    readonly versionRef: (MediaComponentValueTypes.ExactArtifactVersionRef) | (MediaComponentValueTypes.ExactCompositionVersionRef) | (MediaComponentValueTypes.ExactTranscriptVersionRef) | (null);
  }>;
  export type SpectralWindowDefinition = Readonly<{
    readonly windowKind: 'hann' | 'hamming' | 'blackman' | 'rectangular' | 'other-explicit';
    readonly windowSizeSamples: number;
    readonly hopSizeSamples: number;
    readonly spectrumScale: 'linear-amplitude' | 'power' | 'decibel' | 'other-explicit';
    readonly sampleRateHz: MediaComponentValueTypes.PositiveRationalRate;
  }>;
  export type HalfOpenRationalInterval = Readonly<{
    readonly start: MediaComponentValueTypes.RationalSourceTime;
    readonly end: MediaComponentValueTypes.RationalSourceTime;
  }>;
  export type ProjectSummary = Readonly<{
    readonly projectRef: MediaComponentValueTypes.OpaqueProjectRef;
    readonly title: string;
    readonly revisionRef: (MediaComponentValueTypes.ImmutableProjectRevisionRef) | (null);
    readonly access: MediaComponentValueTypes.AccessDisposition;
    readonly updatedAt: string;
  }>;
  export type SourceVersionCandidate = Readonly<{
    readonly versionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
    readonly mediaType: MediaComponentValueTypes.IanaMediaType;
    readonly access: MediaComponentValueTypes.AccessDisposition;
    readonly rightsDisposition: 'permitted-with-scope' | 'denied' | 'unknown' | 'review-required';
    readonly sourceName: string;
  }>;
  export type ArtifactVersionCandidate = Readonly<{
    readonly versionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
    readonly mediaType: MediaComponentValueTypes.IanaMediaType;
    readonly access: MediaComponentValueTypes.AccessDisposition;
    readonly rightsDisposition: 'permitted-with-scope' | 'denied' | 'unknown' | 'review-required';
    readonly integrityDisposition: 'verified' | 'pending' | 'rejected' | 'unknown';
  }>;
  export type AudioTrackBinding = Readonly<{
    readonly trackId: string;
    readonly sourceVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
    readonly channelLayout: MediaComponentValueTypes.ExplicitChannelLayout;
    readonly interval: MediaComponentValueTypes.HalfOpenRationalInterval;
    readonly gain: MediaComponentValueTypes.UnitBearingAudioGain;
  }>;
  export type UnitBearingAudioGain = Readonly<{
    readonly value: number;
    readonly unit: 'linear-amplitude' | 'decibel' | 'loudness-normalized';
    readonly scale: 'linear' | 'logarithmic';
  }>;
  export type AudioMeasurement = Readonly<{
    readonly dimension: string;
    readonly value: number;
    readonly unit: string;
    readonly methodRef: string;
    readonly epistemicStatus: 'measured' | 'estimated' | 'unknown';
    readonly uncertainty: MediaComponentValueTypes.UncertaintyInterval;
  }>;
  export type ChannelRoutingBinding = Readonly<{
    readonly sourceChannel: string;
    readonly destinationChannel: string;
    readonly mapping: 'identity' | 'explicit-remap' | 'downmix-rule';
    readonly decisionRef: string;
  }>;
  export type OrderedScene = Readonly<{
    readonly sceneRef: MediaComponentValueTypes.ExactSceneVersionRef;
    readonly order: number;
    readonly sourceVersionRefs: readonly (MediaComponentValueTypes.ExactArtifactVersionRef)[];
    readonly interval: MediaComponentValueTypes.HalfOpenRationalInterval;
    readonly continuity: 'validated' | 'needs-review' | 'unknown';
  }>;
  export type VersionedTransitionSpec = Readonly<{
    readonly transitionId: string;
    readonly versionId: string;
    readonly fromSceneRef: MediaComponentValueTypes.ExactSceneVersionRef;
    readonly toSceneRef: MediaComponentValueTypes.ExactSceneVersionRef;
    readonly duration: MediaComponentValueTypes.RationalSourceTime;
    readonly kind: 'cut' | 'dissolve' | 'wipe' | 'other-explicit';
  }>;
  export type VersionedTrack = Readonly<{
    readonly trackId: string;
    readonly versionRef: MediaComponentValueTypes.ExactCompositionVersionRef;
    readonly order: number;
    readonly trackKind: 'video' | 'audio' | 'caption' | 'animation' | 'control' | 'other-explicit';
    readonly sourceVersionRefs: readonly (MediaComponentValueTypes.ExactArtifactVersionRef)[];
  }>;
  export type Keyframe = Readonly<{
    readonly keyframeId: string;
    readonly time: MediaComponentValueTypes.RationalSourceTime;
    readonly propertyRef: string;
    readonly value: number | string | boolean | Readonly<Record<string, never>> | readonly (unknown)[];
    readonly unit: string;
    readonly interpolation: 'step' | 'linear' | 'bezier' | 'other-explicit';
  }>;
  export type VersionedMask = Readonly<{
    readonly maskId: string;
    readonly versionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
    readonly coordinateProfileRef: string;
    readonly geometry: readonly (readonly (unknown)[])[];
    readonly validation: 'valid' | 'needs-review' | 'unknown';
    readonly parentMaskRef: (string) | (null);
  }>;
  export type TrackingObservation = Readonly<{
    readonly frameTime: MediaComponentValueTypes.RationalSourceTime;
    readonly status: 'tracked' | 'lost' | 'partial' | 'unknown';
    readonly confidence: number;
    readonly evidenceRef: MediaComponentValueTypes.EvidenceRef;
  }>;
  export type SimulationObservation = Readonly<{
    readonly modelVersionRef: MediaComponentValueTypes.ExactModelVersionRef;
    readonly runRef: (string) | (null);
    readonly observedAt: MediaComponentValueTypes.RationalSourceTime;
    readonly quantityRef: string;
    readonly value: number;
    readonly unit: string;
    readonly epistemicStatus: 'measured' | 'simulated' | 'estimated' | 'inferred' | 'unknown';
  }>;
  export type QualifiedModelBinding = Readonly<{
    readonly modelVersionRef: MediaComponentValueTypes.ExactModelVersionRef;
    readonly profileRef: string;
    readonly qualification: MediaComponentValueTypes.QualificationDisposition;
    readonly evidenceRefs: readonly (MediaComponentValueTypes.EvidenceRef)[];
  }>;
  export type ComparisonBasis = Readonly<{
    readonly dimensions: readonly ('version' | 'timebase' | 'coordinate-profile' | 'measurement-method' | 'delivery-profile')[];
    readonly alignmentRef: string;
    readonly methodRef: string;
  }>;
  export type ScopedDifference = Readonly<{
    readonly dimensionRef: string;
    readonly leftValue: number | string | boolean;
    readonly rightValue: number | string | boolean;
    readonly unit: string;
    readonly epistemicStatus: 'measured' | 'estimated' | 'inferred' | 'unknown';
    readonly uncertainty: (MediaComponentValueTypes.UncertaintyInterval) | (null);
  }>;
  export type CapabilityProfileDisposition = Readonly<{
    readonly capabilityRef: string;
    readonly profileRef: string;
    readonly availability: 'available' | 'unavailable' | 'blocked' | 'unknown';
    readonly qualification: MediaComponentValueTypes.QualificationDisposition;
    readonly reasonRef: string;
  }>;
  export type ScopedPolicyDecision = Readonly<{
    readonly decisionRef: string;
    readonly scope: MediaComponentValueTypes.RightsConsentScope;
    readonly outcome: 'allow' | 'deny' | 'unknown' | 'require-review';
    readonly authorityRef: string;
    readonly validity: MediaComponentValueTypes.ConsentValidity;
  }>;
  export type TransformWithCoordinateProfile = Readonly<{
    readonly transformId: string;
    readonly coordinateProfileRef: string;
    readonly matrix: readonly (number)[];
    readonly unit: string;
    readonly sourceVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
  }>;
  export type SourceTimestampWithClock = Readonly<{
    readonly time: MediaComponentValueTypes.RationalSourceTime;
    readonly clockAuthorityRef: string;
    readonly sourceVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
    readonly timestampKind: 'capture' | 'decode' | 'presentation' | 'observation' | 'unknown';
  }>;
  export type ScopedSignalObservation = Readonly<{
    readonly interval: MediaComponentValueTypes.HalfOpenRationalInterval;
    readonly channelRef: string;
    readonly value: number;
    readonly unit: string;
    readonly methodRef: string;
    readonly epistemicStatus: 'measured' | 'estimated' | 'unknown';
  }>;
  export type ProposedPlanRef = string;
  export type OperationExecutionRef = string;
  export type IntegrityEvidenceRef = string;
  export type OpaqueSceneEntityRef = string;
  export type VersionedMaterialRef = string;
  export type ProvenanceRef = string;
  export type ScopedDecisionRef = string;
  export type VersionedDecisionRef = string;
  export type OutcomeEvidenceRef = string;
}
