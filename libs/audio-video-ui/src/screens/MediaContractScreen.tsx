import React from "react";
import { MediaTaskScreen, type MediaScreenAction } from "./MediaTaskScreen";
import type { MediaActionPort, MediaContextPort, MediaDataPort, MediaNavigationPort } from "../ports";
import {
  IdentityContextBoundary,
  IntentLauncher,
  ProjectBrowser,
  ProjectContextSummary,
  CreationPlanSummary,
  SourcePicker,
  SourcePlayer,
  TranscriptReview,
  CaptionTrackEditor,
  JobStatusCard,
  ProvenanceSummary,
  ArtifactSourcePicker,
  ArtifactTransferStatus,
  ArtifactIntegritySummary,
  ArtifactBrowser,
  WaveformSpectrogram,
  Storyboard,
  TimelineKeyframeEditor,
  AudioMixer,
  MaskTrackingEditor,
  SceneInspector,
  SimulationInstruments,
  ResultComparison,
  QualityInspector,
  DeliveryProfilePicker,
  RightsRetentionReview,
  ActivityRecoveryFeed,
  CliOutput,
} from "../components/MediaComponentFamilies";
import type { MediaComponentAction } from "../components/MediaComponentFamilies";
import { validateMediaFamilyProjection } from "../components/MediaComponentRuntimeContracts";
import { createMediaActionDispatchGuard } from "./MediaActionDispatchGuard";
import type {
  IdentityContextBoundaryProps,
  IntentLauncherProps,
  ProjectBrowserProps,
  ProjectContextSummaryProps,
  CreationPlanSummaryProps,
  SourcePickerProps,
  SourcePlayerProps,
  TranscriptReviewProps,
  CaptionTrackEditorProps,
  JobStatusCardProps,
  ProvenanceSummaryProps,
  ArtifactSourcePickerProps,
  ArtifactTransferStatusProps,
  ArtifactIntegritySummaryProps,
  ArtifactBrowserProps,
  WaveformSpectrogramProps,
  StoryboardProps,
  TimelineKeyframeEditorProps,
  AudioMixerProps,
  MaskTrackingEditorProps,
  SceneInspectorProps,
  SimulationInstrumentsProps,
  ResultComparisonProps,
  QualityInspectorProps,
  DeliveryProfilePickerProps,
  RightsRetentionReviewProps,
  ActivityRecoveryFeedProps,
  CliOutputProps,
} from "../components/MediaComponentFamilies";
import type { MediaComponentValue } from "../components/MediaComponentFamilies";

export const MEDIA_SCREEN_COMPONENTS = {
  'media.view.select-source': { componentRefs: ['media.component.project-context-summary', 'media.component.artifact-source-picker', 'media.component.artifact-integrity-summary', 'media.component.rights-retention-review'], actions: ['media.action.choose-source', 'media.action.inspect-source'] },
  'media.view.monitor-transcription': { componentRefs: ['media.component.job-status-card', 'media.component.activity-recovery-feed'], actions: ['media.action.request-transcription', 'media.action.view-job-status', 'media.action.request-cancellation', 'media.action.check-job-outcome'] },
  'media.view.review-transcript': { componentRefs: ['media.component.source-player', 'media.component.transcript-review', 'media.component.provenance-summary'], actions: ['media.action.review-transcript', 'media.action.play-source', 'media.action.seek-source'] },
  'media.view.correct-captions': { componentRefs: ['media.component.source-player', 'media.component.caption-track-editor', 'media.component.transcript-review'], actions: ['media.action.correct-caption', 'media.action.align-caption-timing', 'media.action.resolve-caption-conflict', 'media.action.save-caption-version'] },
  'media.view.compare-caption-versions': { componentRefs: ['media.component.source-player', 'media.component.result-comparison', 'media.component.provenance-summary'], actions: ['media.action.inspect-provenance', 'media.action.compare-caption-versions'] },
  'media.view.check-job-outcome': { componentRefs: ['media.component.job-status-card', 'media.component.activity-recovery-feed'], actions: ['media.action.view-job-status', 'media.action.check-job-outcome'] },
  'media.view.adjust-color': { componentRefs: ['media.component.timeline-keyframe-editor', 'media.component.result-comparison', 'media.component.quality-inspector', 'media.component.scene-inspector'], actions: ['media.action.select-shot-or-region', 'media.action.inspect-input-output-color-interpretation', 'media.action.edit-admitted-adjustment', 'media.action.compare-media-versions', 'media.action.save-new-revision'] },
  'media.view.animate-media': { componentRefs: ['media.component.timeline-keyframe-editor', 'media.component.simulation-instruments', 'media.component.scene-inspector', 'media.component.result-comparison'], actions: ['media.action.select-keyframe', 'media.action.edit-keyframe', 'media.action.change-interpolation-curve', 'media.action.inspect-driver-or-constraint', 'media.action.preview-motion', 'media.action.save-versioned-edit'] },
  'media.view.arrange-scenes': { componentRefs: ['media.component.storyboard', 'media.component.artifact-browser', 'media.component.provenance-summary'], actions: ['media.action.add-storyboard-scene', 'media.action.remove-storyboard-scene', 'media.action.reorder-storyboard-scenes', 'media.action.associate-authorized-reference', 'media.action.edit-scene-timing-or-transition', 'media.action.save-storyboard-revision'] },
  'media.view.authenticate-and-select-context': { componentRefs: ['media.component.identity-context-boundary'], actions: ['media.action.start-upstream-identity-handoff', 'media.action.select-identity-confirmed-workspace', 'media.action.return-to-requested-destination-after-identity-confirmation'] },
  'media.view.browse-media': { componentRefs: ['media.component.project-context-summary', 'media.component.artifact-integrity-summary', 'media.component.artifact-source-picker'], actions: ['media.action.inspect-artifact', 'media.action.begin-artifact-upload'] },
  'media.view.check-processing-options': { componentRefs: ['media.component.intent-launcher', 'media.component.creation-plan-summary', 'media.component.quality-inspector'], actions: ['media.action.search-by-user-outcome', 'media.action.inspect-operation-contract', 'media.action.open-qualification-evidence'] },
  'media.view.check-processing-readiness': { componentRefs: ['media.component.activity-recovery-feed', 'media.component.job-status-card', 'media.component.provenance-summary'], actions: ['media.action.inspect-operation-readiness', 'media.action.refresh-operation-readiness', 'media.action.open-authorized-recovery-instruction'] },
  'media.view.choose-eligible-processing-option': { componentRefs: ['media.component.delivery-profile-picker', 'media.component.creation-plan-summary', 'media.component.quality-inspector'], actions: ['media.action.search-named-profiles', 'media.action.inspect-effective-processing-constraints', 'media.action.validate-processing-profile', 'media.action.select-eligible-processing-profile'] },
  'media.view.compare-results': { componentRefs: ['media.component.result-comparison', 'media.component.quality-inspector', 'media.component.provenance-summary'], actions: ['media.action.compare-caption-versions', 'media.action.inspect-provenance', 'media.action.select-exact-candidates', 'media.action.choose-alignment-basis', 'media.action.inspect-quality-evidence', 'media.action.record-candidate-for-review'] },
  'media.view.compose-media': { componentRefs: ['media.component.timeline-keyframe-editor', 'media.component.audio-mixer', 'media.component.storyboard', 'media.component.delivery-profile-picker', 'media.component.rights-retention-review'], actions: ['media.action.reorder-track', 'media.action.trim-track', 'media.action.edit-transition-or-caption-alignment', 'media.action.inspect-artifact', 'media.action.validate-composition'] },
  'media.view.compose-scene': { componentRefs: ['media.component.scene-inspector', 'media.component.storyboard', 'media.component.simulation-instruments', 'media.component.artifact-browser'], actions: ['media.action.add-scene-entity', 'media.action.select-scene-entity', 'media.action.inspect-scene-binding', 'media.action.update-scene-binding', 'media.action.validate-scene-references', 'media.action.preview-current-revision'] },
  'media.view.create-audio': { componentRefs: ['media.component.artifact-browser', 'media.component.waveform-spectrogram', 'media.component.audio-mixer', 'media.component.creation-plan-summary', 'media.component.result-comparison'], actions: ['media.action.choose-admitted-audio-operation', 'media.action.inspect-source-measurements', 'media.action.edit-audio-mix-controls', 'media.action.submit-validated-request', 'media.action.compare-media-versions'] },
  'media.view.create-image': { componentRefs: ['media.component.creation-plan-summary', 'media.component.artifact-browser', 'media.component.result-comparison', 'media.component.rights-retention-review'], actions: ['media.action.edit-requested-outcome-and-admitted-controls', 'media.action.select-authorized-reference', 'media.action.submit-validated-request', 'media.action.inspect-generated-candidates'] },
  'media.view.create-media': { componentRefs: ['media.component.project-context-summary', 'media.component.intent-launcher', 'media.component.creation-plan-summary'], actions: ['media.action.choose-intent'] },
  'media.view.create-video': { componentRefs: ['media.component.creation-plan-summary', 'media.component.storyboard', 'media.component.timeline-keyframe-editor', 'media.component.job-status-card', 'media.component.result-comparison'], actions: ['media.action.view-job-status', 'media.action.check-job-outcome', 'media.action.request-cancellation', 'media.action.edit-video-temporal-plan', 'media.action.submit-validated-request', 'media.action.compare-media-versions'] },
  'media.view.deliver-output': { componentRefs: ['media.component.delivery-profile-picker', 'media.component.rights-retention-review', 'media.component.artifact-integrity-summary', 'media.component.provenance-summary'], actions: ['media.action.choose-named-destination', 'media.action.review-rights-approval-and-format-effects', 'media.action.deliver-exact-version', 'media.action.reconcile-delivery-acknowledgment'] },
  'media.view.edit-captions': { componentRefs: ['media.component.source-player', 'media.component.caption-track-editor', 'media.component.transcript-review', 'media.component.provenance-summary'], actions: ['media.action.correct-caption', 'media.action.align-caption-timing', 'media.action.save-caption-version', 'media.action.resolve-caption-conflict', 'media.action.compare-caption-versions'] },
  'media.view.edit-media-region': { componentRefs: ['media.component.mask-tracking-editor', 'media.component.scene-inspector', 'media.component.result-comparison', 'media.component.provenance-summary'], actions: ['media.action.select-region-or-point', 'media.action.edit-mask-boundary', 'media.action.limit-tracking-propagation-range', 'media.action.review-uncertain-tracking', 'media.action.save-new-revision'] },
  'media.view.edit-media': { componentRefs: ['media.component.timeline-keyframe-editor', 'media.component.mask-tracking-editor', 'media.component.creation-plan-summary', 'media.component.result-comparison'], actions: ['media.action.select-track-or-region', 'media.action.enter-exact-edit-constraints', 'media.action.apply-admitted-edit', 'media.action.undo-or-redo-versioned-change', 'media.action.save-new-revision'] },
  'media.view.explore-simulation': { componentRefs: ['media.component.simulation-instruments', 'media.component.scene-inspector', 'media.component.creation-plan-summary', 'media.component.quality-inspector'], actions: ['media.action.set-simulation-initial-condition', 'media.action.inspect-simulation-domain-and-fidelity', 'media.action.validate-simulation-plan', 'media.action.submit-simulation', 'media.action.inspect-simulation-result'] },
  'media.view.find-projects': { componentRefs: ['media.component.project-browser'], actions: ['media.action.open-project', 'media.action.create-project'] },
  'media.view.find-task-guidance': { componentRefs: ['media.component.intent-launcher', 'media.component.provenance-summary', 'media.component.rights-retention-review'], actions: ['media.action.search-product-guidance', 'media.action.open-related-view', 'media.action.prepare-redacted-diagnostics', 'media.action.share-diagnostics-after-explicit-choice'] },
  'media.view.import-media': { componentRefs: ['media.component.artifact-source-picker', 'media.component.artifact-transfer-status'], actions: ['media.action.begin-artifact-upload', 'media.action.resume-artifact-upload', 'media.action.inspect-artifact'] },
  'media.view.improve-media': { componentRefs: ['media.component.quality-inspector', 'media.component.creation-plan-summary', 'media.component.result-comparison', 'media.component.provenance-summary'], actions: ['media.action.inspect-quality-evidence', 'media.action.choose-media-improvement-intent', 'media.action.review-repair-bounds', 'media.action.update-repair-bounds', 'media.action.submit-admitted-plan'] },
  'media.view.inspect-media': { componentRefs: ['media.component.artifact-integrity-summary', 'media.component.provenance-summary'], actions: ['media.action.inspect-artifact', 'media.action.attach-source-asset'] },
  'media.view.inspect-output': { componentRefs: ['media.component.source-player', 'media.component.artifact-integrity-summary', 'media.component.provenance-summary', 'media.component.quality-inspector'], actions: ['media.action.inspect-artifact', 'media.action.inspect-provenance', 'media.action.inspect-output-preview-and-version', 'media.action.inspect-quality-evidence', 'media.action.open-admitted-delivery-action'] },
  'media.view.inspect-provenance': { componentRefs: ['media.component.provenance-summary', 'media.component.artifact-integrity-summary', 'media.component.scene-inspector'], actions: ['media.action.inspect-provenance', 'media.action.export-authorized-provenance'] },
  'media.view.job-status': { componentRefs: ['media.component.job-status-card', 'media.component.activity-recovery-feed'], actions: ['media.action.view-job-status', 'media.action.request-cancellation', 'media.action.check-job-outcome', 'media.action.retry-job'] },
  'media.view.prepare-render': { componentRefs: ['media.component.creation-plan-summary', 'media.component.delivery-profile-picker', 'media.component.rights-retention-review', 'media.component.job-status-card'], actions: ['media.action.validate-exact-snapshot', 'media.action.select-eligible-processing-profile', 'media.action.review-estimates-and-rights-effects', 'media.action.submit-render'] },
  'media.view.resume-work': { componentRefs: ['media.component.project-context-summary', 'media.component.intent-launcher'], actions: ['media.action.choose-intent'] },
  'media.view.review-activity': { componentRefs: ['media.component.job-status-card'], actions: ['media.action.view-job-status', 'media.action.check-job-outcome'] },
  'media.view.review-creation-plan': { componentRefs: ['media.component.creation-plan-summary', 'media.component.delivery-profile-picker', 'media.component.rights-retention-review'], actions: ['media.action.edit-unresolved-plan-decision', 'media.action.request-plan-validation', 'media.action.submit-admitted-plan'] },
  'media.view.review-dubbing': { componentRefs: ['media.component.source-player', 'media.component.caption-track-editor', 'media.component.rights-retention-review', 'media.component.result-comparison', 'media.component.provenance-summary'], actions: ['media.action.review-translated-segment', 'media.action.inspect-voice-authorization', 'media.action.revise-dubbing-segment', 'media.action.save-dubbing-version'] },
  'media.view.review-exact-version': { componentRefs: ['media.component.artifact-integrity-summary', 'media.component.provenance-summary', 'media.component.quality-inspector', 'media.component.rights-retention-review'], actions: ['media.action.inspect-version-and-review-scope', 'media.action.record-review-comment', 'media.action.record-version-review-decision', 'media.action.record-review-follow-up'] },
  'media.view.review-outputs': { componentRefs: ['media.component.job-status-card', 'media.component.artifact-browser', 'media.component.artifact-integrity-summary', 'media.component.quality-inspector', 'media.component.provenance-summary'], actions: ['media.action.view-job-status', 'media.action.inspect-artifact', 'media.action.inspect-provenance', 'media.action.review-output-evidence', 'media.action.open-approval-view', 'media.action.check-job-outcome'] },
  'media.view.review-quality': { componentRefs: ['media.component.quality-inspector', 'media.component.result-comparison', 'media.component.provenance-summary'], actions: ['media.action.inspect-provenance', 'media.action.inspect-quality-evidence', 'media.action.compare-candidate-on-metric', 'media.action.review-bounded-repair-proposal'] },
  'media.view.review-rights-and-consent': { componentRefs: ['media.component.rights-retention-review', 'media.component.provenance-summary', 'media.component.artifact-integrity-summary'], actions: ['media.action.inspect-governing-evidence', 'media.action.request-rights-review', 'media.action.record-authorized-attestation', 'media.action.apply-authorized-rights-restriction', 'media.action.revoke-authorized-consent'] },
  'media.view.review-workspace-settings': { componentRefs: ['media.component.identity-context-boundary', 'media.component.project-context-summary', 'media.component.creation-plan-summary'], actions: ['media.action.inspect-setting-owner', 'media.action.change-permitted-preference', 'media.action.save-setting-preference', 'media.action.restore-prior-setting-preference'] },
  'media.view.use-authorized-voice': { componentRefs: ['media.component.rights-retention-review', 'media.component.provenance-summary', 'media.component.creation-plan-summary'], actions: ['media.action.inspect-consent-and-permitted-use', 'media.action.request-authorized-review', 'media.action.continue-within-recorded-scope', 'media.action.stop-authorized-voice-use'] },
  'media.view.work-in-project': { componentRefs: ['media.component.project-context-summary', 'media.component.intent-launcher'], actions: ['media.action.choose-intent'] },
  'media.view.work-with-speech': { componentRefs: ['media.component.source-picker', 'media.component.source-player', 'media.component.transcript-review', 'media.component.job-status-card', 'media.component.rights-retention-review'], actions: ['media.action.choose-source', 'media.action.request-transcription', 'media.action.view-job-status', 'media.action.review-transcript', 'media.action.choose-intent', 'media.action.request-admitted-speech-operation', 'media.action.review-recognized-or-synthesized-content'] },
} as const;

export type MediaContractScreenId = keyof typeof MEDIA_SCREEN_COMPONENTS;
export type MediaContractComponentId = 'media.component.identity-context-boundary' | 'media.component.intent-launcher' | 'media.component.project-browser' | 'media.component.project-context-summary' | 'media.component.creation-plan-summary' | 'media.component.source-picker' | 'media.component.source-player' | 'media.component.transcript-review' | 'media.component.caption-track-editor' | 'media.component.job-status-card' | 'media.component.provenance-summary' | 'media.component.artifact-source-picker' | 'media.component.artifact-transfer-status' | 'media.component.artifact-integrity-summary' | 'media.component.artifact-browser' | 'media.component.waveform-spectrogram' | 'media.component.storyboard' | 'media.component.timeline-keyframe-editor' | 'media.component.audio-mixer' | 'media.component.mask-tracking-editor' | 'media.component.scene-inspector' | 'media.component.simulation-instruments' | 'media.component.result-comparison' | 'media.component.quality-inspector' | 'media.component.delivery-profile-picker' | 'media.component.rights-retention-review' | 'media.component.activity-recovery-feed' | 'media.component.cli-output';
export type MediaContractComponentInstance =
  | { readonly componentId: 'media.component.identity-context-boundary'; readonly props: IdentityContextBoundaryProps }
  | { readonly componentId: 'media.component.intent-launcher'; readonly props: IntentLauncherProps }
  | { readonly componentId: 'media.component.project-browser'; readonly props: ProjectBrowserProps }
  | { readonly componentId: 'media.component.project-context-summary'; readonly props: ProjectContextSummaryProps }
  | { readonly componentId: 'media.component.creation-plan-summary'; readonly props: CreationPlanSummaryProps }
  | { readonly componentId: 'media.component.source-picker'; readonly props: SourcePickerProps }
  | { readonly componentId: 'media.component.source-player'; readonly props: SourcePlayerProps }
  | { readonly componentId: 'media.component.transcript-review'; readonly props: TranscriptReviewProps }
  | { readonly componentId: 'media.component.caption-track-editor'; readonly props: CaptionTrackEditorProps }
  | { readonly componentId: 'media.component.job-status-card'; readonly props: JobStatusCardProps }
  | { readonly componentId: 'media.component.provenance-summary'; readonly props: ProvenanceSummaryProps }
  | { readonly componentId: 'media.component.artifact-source-picker'; readonly props: ArtifactSourcePickerProps }
  | { readonly componentId: 'media.component.artifact-transfer-status'; readonly props: ArtifactTransferStatusProps }
  | { readonly componentId: 'media.component.artifact-integrity-summary'; readonly props: ArtifactIntegritySummaryProps }
  | { readonly componentId: 'media.component.artifact-browser'; readonly props: ArtifactBrowserProps }
  | { readonly componentId: 'media.component.waveform-spectrogram'; readonly props: WaveformSpectrogramProps }
  | { readonly componentId: 'media.component.storyboard'; readonly props: StoryboardProps }
  | { readonly componentId: 'media.component.timeline-keyframe-editor'; readonly props: TimelineKeyframeEditorProps }
  | { readonly componentId: 'media.component.audio-mixer'; readonly props: AudioMixerProps }
  | { readonly componentId: 'media.component.mask-tracking-editor'; readonly props: MaskTrackingEditorProps }
  | { readonly componentId: 'media.component.scene-inspector'; readonly props: SceneInspectorProps }
  | { readonly componentId: 'media.component.simulation-instruments'; readonly props: SimulationInstrumentsProps }
  | { readonly componentId: 'media.component.result-comparison'; readonly props: ResultComparisonProps }
  | { readonly componentId: 'media.component.quality-inspector'; readonly props: QualityInspectorProps }
  | { readonly componentId: 'media.component.delivery-profile-picker'; readonly props: DeliveryProfilePickerProps }
  | { readonly componentId: 'media.component.rights-retention-review'; readonly props: RightsRetentionReviewProps }
  | { readonly componentId: 'media.component.activity-recovery-feed'; readonly props: ActivityRecoveryFeedProps }
  | { readonly componentId: 'media.component.cli-output'; readonly props: CliOutputProps }
;

export interface MediaContractScreenProps {
  readonly screenId: MediaContractScreenId;
  readonly instances: readonly MediaContractComponentInstance[];
  /** Host-projected action states are intersected with the exact screen action allowlist. */
  readonly actions: readonly MediaScreenAction[];
  readonly data: MediaDataPort;
  readonly actionPort: MediaActionPort;
  readonly navigationPort?: MediaNavigationPort;
  readonly context: MediaContextPort;
}

function familyActions(
  intents: readonly string[],
  projected: readonly MediaScreenAction[],
  actionPort: MediaActionPort,
) {
  return projected.filter((action) => intents.includes(action.id)).map((action) => {
    const selectionAdapter = action.payloadForSelection;
    const payload = action.payload;
    return {
      id: action.id,
      label: action.label,
      enabled: action.enabled,
      disabledReason: action.disabledReason,
      selectionPayloadAvailable: selectionAdapter !== undefined,
      invoke: async (selectedValue?: import("../components/MediaComponentFamilies").MediaComponentValue) => {
        const dispatchContext = { subjectRefs: action.subjectRefs ?? [] };
        if (selectedValue !== undefined) {
          if (!selectionAdapter) return { status: "unavailable" as const, reason: "No exact selection-to-request adapter is defined." };
          return actionPort.invoke(action.id, selectionAdapter(selectedValue), dispatchContext);
        }
        return actionPort.invoke(action.id, payload, dispatchContext);
      },
    };
  });
}

function renderFamilyInstance(
  instance: MediaContractComponentInstance,
  projected: readonly MediaScreenAction[],
  actionPort: MediaActionPort,
  key: string,
): React.ReactElement {
  switch (instance.componentId) {
    case "media.component.identity-context-boundary": return <IdentityContextBoundary key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.intent-launcher": return <IntentLauncher key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.project-browser": return <ProjectBrowser key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.project-context-summary": return <ProjectContextSummary key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.creation-plan-summary": return <CreationPlanSummary key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.source-picker": return <SourcePicker key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.source-player": return <SourcePlayer key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.transcript-review": return <TranscriptReview key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.caption-track-editor": return <CaptionTrackEditor key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.job-status-card": return <JobStatusCard key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.provenance-summary": return <ProvenanceSummary key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.artifact-source-picker": return <ArtifactSourcePicker key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.artifact-transfer-status": return <ArtifactTransferStatus key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.artifact-integrity-summary": return <ArtifactIntegritySummary key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.artifact-browser": return <ArtifactBrowser key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.waveform-spectrogram": return <WaveformSpectrogram key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.storyboard": return <Storyboard key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.timeline-keyframe-editor": return <TimelineKeyframeEditor key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.audio-mixer": return <AudioMixer key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.mask-tracking-editor": return <MaskTrackingEditor key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.scene-inspector": return <SceneInspector key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.simulation-instruments": return <SimulationInstruments key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.result-comparison": return <ResultComparison key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.quality-inspector": return <QualityInspector key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.delivery-profile-picker": return <DeliveryProfilePicker key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.rights-retention-review": return <RightsRetentionReview key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.activity-recovery-feed": return <ActivityRecoveryFeed key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    case "media.component.cli-output": return <CliOutput key={key} {...instance.props} actions={familyActions(instance.props.actionIntents, projected, actionPort)} />;
    default: return assertNever(instance);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported Media component instance: ${JSON.stringify(value)}`);
}

/** Screen composition driven by exact current screen-contract component/action IDs. */
export function MediaContractScreen({ screenId, instances, actions, data, actionPort, navigationPort, context }: MediaContractScreenProps): React.ReactElement {
  const [, refreshDispatchState] = React.useState(0);
  const dispatchGuard = React.useMemo(() => createMediaActionDispatchGuard(actionPort, () => refreshDispatchState((version) => version + 1)), [actionPort]);
  const guardedActionPort = dispatchGuard.actionPort;
  const contract = MEDIA_SCREEN_COMPONENTS[screenId];
  React.useEffect(() => {
    dispatchGuard.observeReconciliations(data.actionReconciliations ?? []);
  }, [dispatchGuard, data.actionReconciliations]);
  const refs = contract.componentRefs;
  const ids = instances.map((instance) => instance.componentId);
  const projectionErrors = instances.flatMap((instance) => {
    const result = validateMediaFamilyProjection(instance.componentId, instance.props);
    return result.valid ? [] : result.errors.map((error) => `${instance.componentId}: ${error}`);
  });
  const compositionMatches = projectionErrors.length === 0 && refs.length === ids.length && refs.every((ref, index) => ref === ids[index]);
  const allowedActions = new Set<string>(contract.actions);
  const invalidActions = actions.filter((action) => !allowedActions.has(action.id));
  const projectedActions = actions.filter((action) => allowedActions.has(action.id)).map((action) => dispatchGuard.isInFlight(action.id)
    ? { ...action, enabled: false, disabledReason: "This action is already being requested; wait for a current owner projection before retrying." }
    : action);
  const familyActionIds = new Set<string>();
  for (const instance of instances) for (const intent of instance.props.actionIntents) familyActionIds.add(intent);
  const flowActions = projectedActions.filter((action) => !familyActionIds.has(action.id));
  const screenTitle = screenId.replace(/^media\.view\./u, "").split("-").map((part) => part[0]?.toUpperCase() + part.slice(1)).join(" ");

  if (!compositionMatches) {
    return <MediaTaskScreen data={data} actionPort={guardedActionPort} navigationPort={navigationPort} context={context}>
      <section className="media-screen-body" aria-labelledby="media-contract-screen-error">
        <h3 id="media-contract-screen-error">{screenTitle}</h3>
        <p role="alert">The screen component projection does not match its source contract. No component actions are available.</p>
        {projectionErrors.length > 0 && <ul aria-label="Invalid component projection">{projectionErrors.map((error) => <li key={error}>{error}</li>)}</ul>}
      </section>
    </MediaTaskScreen>;
  }

  return <MediaTaskScreen data={data} actions={flowActions} actionPort={guardedActionPort} navigationPort={navigationPort} context={context}>
    <section className="media-screen-body" aria-labelledby={`${screenId}-title`} data-screen-id={screenId}>
      <header><h3 id={`${screenId}-title`}>{screenTitle}</h3></header>
      {invalidActions.length > 0 && <p role="status">Some projected actions are not defined for this screen and were withheld.</p>}
      {instances.map((instance, index) => renderFamilyInstance(instance, projectedActions, guardedActionPort, `${instance.componentId}-${index}`))}
    </section>
  </MediaTaskScreen>;
}
