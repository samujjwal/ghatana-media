import { validateMediaComponentInputSchema } from "./MediaComponentSchemaValidation";

/** Runtime projection guards generated from the exact Media family prop declarations. */
export const MEDIA_COMPONENT_RUNTIME_CONTRACTS = {
  "media.component.identity-context-boundary": {
    requiredProps: ["requestedDestinationRef", "handoffState", "safeReturnIntent", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["requestedDestinationRef", "handoffState", "resolvedWorkspaceRef", "identityRequest", "contextResolution", "safeReturnIntent", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["identity-required", "reauthentication-required", "context-ready", "context-denied", "unavailable"],
    variants: ["identity-required", "reauthentication-required", "context-ready", "context-denied", "unavailable"],
    actionIntents: [],
    keyboardBehavior: "preserve-return-focus-and-destination-across-the-upstream-handoff",
  },
  "media.component.intent-launcher": {
    requiredProps: ["intentOptions", "chooseIntentAction", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["intentOptions", "selectedIntentRef", "availabilityEvidenceRef", "chooseIntentAction", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["available", "unavailable-with-reason", "selected", "loading"],
    variants: ["available", "unavailable-with-reason", "selected", "loading"],
    actionIntents: ["media.action.choose-intent"],
    keyboardBehavior: "each-intent-is-a-named-native-choice-with-visible-focus",
  },
  "media.component.project-browser": {
    requiredProps: ["workspaceRef", "query", "projects", "pageState", "projectActions", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["workspaceRef", "query", "projects", "pageState", "projectActions", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["loading", "populated", "empty", "no-results", "stale", "create-pending", "create-unknown", "access-denied"],
    variants: ["loading", "populated", "empty", "no-results", "stale", "create-pending", "create-unknown", "access-denied"],
    actionIntents: ["media.action.open-project", "media.action.create-project"],
    keyboardBehavior: "labelled-search; arrow-or-tab-navigation-through-project-results; named-row-actions",
  },
  "media.component.project-context-summary": {
    requiredProps: ["workspaceRef", "projectRef", "revisionRef", "accessDisposition", "safeNextActions", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["workspaceRef", "projectRef", "revisionRef", "accessDisposition", "safeNextActions", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["empty-project", "populated-project", "stale-revision", "access-limited", "loading"],
    variants: ["empty-project", "populated-project", "stale-revision", "access-limited", "loading"],
    actionIntents: ["media.action.choose-intent"],
    keyboardBehavior: "project-context-and-next-action-are-navigable-with-visible-focus",
  },
  "media.component.creation-plan-summary": {
    requiredProps: ["planRef", "requestedOutcome", "inputVersionRefs", "capabilityDisposition", "policyAndRightsEffects", "planFinality", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["planRef", "requestedOutcome", "inputVersionRefs", "capabilityDisposition", "policyAndRightsEffects", "estimates", "planFinality", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["ready-for-review", "missing-input", "unavailable-capability", "policy-blocked", "stale-plan"],
    variants: ["ready-for-review", "missing-input", "unavailable-capability", "policy-blocked", "stale-plan"],
    actionIntents: [],
    keyboardBehavior: "information-order-is-stable; all-disclosures-and-next-view-links-are-keyboard-operable",
  },
  "media.component.source-picker": {
    requiredProps: ["workspaceRef", "targetProjectRef", "query", "sourceCandidates", "selectionState", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["workspaceRef", "targetProjectRef", "query", "sourceCandidates", "selectedSourceVersionRef", "selectionState", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["empty", "selected", "unavailable", "denied"],
    variants: ["empty", "selected", "unavailable", "denied"],
    actionIntents: ["media.action.choose-source"],
    keyboardBehavior: "native-selection-controls; complete-row-selection; visible-focus",
  },
  "media.component.source-player": {
    requiredProps: ["sourceVersionRef", "playbackState", "sourceTime", "timebaseRef", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["sourceVersionRef", "playbackState", "sourceTime", "duration", "timebaseRef", "accessiblePreviewRef", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["audio", "video", "loading", "unavailable"],
    variants: ["audio", "video", "loading", "unavailable"],
    actionIntents: ["media.action.play-source", "media.action.seek-source"],
    keyboardBehavior: "keyboard-play-pause-and-seek; no-drag-only-control",
  },
  "media.component.transcript-review": {
    requiredProps: ["sourceVersionRef", "transcriptVersionRef", "languageTag", "segments", "reviewDisposition", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["sourceVersionRef", "transcriptVersionRef", "languageTag", "segments", "selectedSegmentRef", "reviewDisposition", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["ready", "uncertain-language", "timing-review-required", "read-only", "consent-revoked"],
    variants: ["ready", "uncertain-language", "timing-review-required", "read-only", "consent-revoked"],
    actionIntents: ["media.action.review-transcript", "media.action.seek-source"],
    keyboardBehavior: "navigate-by-segment; source-time-is-announced",
  },
  "media.component.caption-track-editor": {
    requiredProps: ["sourceVersionRef", "captionDraftRef", "sourceTimebaseRef", "cues", "validationDisposition", "saveAsNewVersionAction", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["sourceVersionRef", "captionDraftRef", "sourceTimebaseRef", "cues", "validationDisposition", "saveAsNewVersionAction", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["draft", "needs-alignment", "version-conflict", "saved", "read-only"],
    variants: ["draft", "needs-alignment", "version-conflict", "saved", "read-only"],
    actionIntents: ["media.action.correct-caption", "media.action.align-caption-timing", "media.action.resolve-caption-conflict", "media.action.save-caption-version"],
    keyboardBehavior: "select-and-edit-by-row; provide-numeric-time-edit-alternative-to-dragging",
  },
  "media.component.job-status-card": {
    requiredProps: ["jobRef", "attempts", "jobState", "effectFinality", "outputVersionRefs", "allowedRecoveryActions", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["jobRef", "attempts", "jobState", "effectFinality", "progress", "outputVersionRefs", "allowedRecoveryActions", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["queued", "running", "completed", "partially-succeeded", "failed", "retry-pending", "outcome-unknown", "reconciling", "cancelled"],
    variants: ["queued", "running", "completed", "partially-succeeded", "failed", "retry-pending", "outcome-unknown", "reconciling", "cancelled"],
    actionIntents: ["media.action.view-job-status", "media.action.request-cancellation", "media.action.check-job-outcome", "media.action.retry-job"],
    keyboardBehavior: "actions-have-explicit-names-and-reasons",
  },
  "media.component.provenance-summary": {
    requiredProps: ["resultVersionRef", "sourceVersionRefs", "derivationSteps", "timeReferences", "uncertainties", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["resultVersionRef", "sourceVersionRefs", "derivationSteps", "environmentRef", "timeReferences", "uncertainties", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["measured", "recognized", "estimated", "generated", "incomplete"],
    variants: ["measured", "recognized", "estimated", "generated", "incomplete"],
    actionIntents: ["media.action.inspect-provenance"],
    keyboardBehavior: "disclosure-is-operable-with-keyboard",
  },
  "media.component.artifact-source-picker": {
    requiredProps: ["projectRef", "query", "artifactCandidates", "selectionState", "selectionAction", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["projectRef", "query", "artifactCandidates", "selectedVersionRef", "selectionState", "selectionAction", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["empty", "selected", "unsupported-by-admitted-contract", "access-denied"],
    variants: ["empty", "selected", "unsupported-by-admitted-contract", "access-denied"],
    actionIntents: ["media.action.select-artifact-source"],
    keyboardBehavior: "native-file-picker-and-labelled-source-choice; drag-and-drop-is-never-the-only-input",
  },
  "media.component.artifact-transfer-status": {
    requiredProps: ["uploadRef", "receivedByteLength", "chunkReceipts", "transferState", "effectFinality", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["uploadRef", "expectedByteLength", "receivedByteLength", "chunkReceipts", "transferState", "verificationJobRef", "effectFinality", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["ready", "receiving", "interrupted", "outcome-unknown", "verifying", "quarantined", "rejected", "available"],
    variants: ["ready", "receiving", "interrupted", "outcome-unknown", "verifying", "quarantined", "rejected", "available"],
    actionIntents: ["media.action.resume-artifact-upload"],
    keyboardBehavior: "progress-and-recovery-actions-have-explicit-names-and-reasons",
  },
  "media.component.artifact-integrity-summary": {
    requiredProps: ["artifactVersionRef", "byteLength", "mediaType", "digest", "verificationEvidence", "verificationState", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["artifactVersionRef", "byteLength", "mediaType", "digest", "verificationEvidence", "verificationState", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["verifying", "available", "quarantined", "rejected", "metadata-incomplete"],
    variants: ["verifying", "available", "quarantined", "rejected", "metadata-incomplete"],
    actionIntents: ["media.action.inspect-artifact", "media.action.attach-source-asset"],
    keyboardBehavior: "integrity-details-and-project-attachment-are-separately-navigable",
  },
  "media.component.artifact-browser": {
    requiredProps: ["workspaceRef", "query", "artifactVersions", "selectionState", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["workspaceRef", "projectRef", "query", "artifactVersions", "selectionState", "nextPageRef", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["searching", "results-ready", "no-results", "stale-results", "access-denied", "refresh-failed"],
    variants: ["loading", "populated", "empty", "no-results", "stale-index", "access-denied", "metadata-incomplete"],
    actionIntents: ["media.action.search-authorized-artifacts", "media.action.inspect-artifact", "media.action.select-authorized-reference"],
    keyboardBehavior: "label search and filters; preserve focus through result updates; provide named row actions and keyboard selection without drag.",
  },
  "media.component.waveform-spectrogram": {
    requiredProps: ["sourceVersionRef", "sampleRateHz", "channelLayout", "timebaseRef", "windowDefinition", "observations", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["sourceVersionRef", "sampleRateHz", "channelLayout", "timebaseRef", "windowDefinition", "observations", "selectedRange", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["not-loaded", "loading", "ready", "selection-active", "measurement-unavailable", "analysis-failed"],
    variants: ["waveform", "spectrogram", "loading", "no-analysis-data", "analysis-incomplete", "source-unavailable"],
    actionIntents: ["media.action.select-source-time-interval", "media.action.inspect-source-measurements", "media.action.switch-measurement-presentation"],
    keyboardBehavior: "Provide keyboard interval selection and numeric start/end entry; expose playhead and selection; never require drawing gestures.",
  },
  "media.component.storyboard": {
    requiredProps: ["compositionVersionRef", "scenes", "timebaseRef", "transitionSpecs", "validationDisposition", "storyboardActionIntents", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["compositionVersionRef", "scenes", "timebaseRef", "transitionSpecs", "validationDisposition", "storyboardActionIntents", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["no-scenes", "editing", "review-required", "conflict", "saved", "read-only"],
    variants: ["empty", "draft", "ready-for-review", "partial-scenes", "reference-unavailable", "conflict", "read-only"],
    actionIntents: ["media.action.add-storyboard-scene", "media.action.reorder-storyboard-scenes", "media.action.associate-authorized-reference", "media.action.review-scene-timing-and-transitions"],
    keyboardBehavior: "Support add, remove, reorder, and select by keyboard with explicit move controls; maintain focus on the moved scene.",
  },
  "media.component.timeline-keyframe-editor": {
    requiredProps: ["compositionVersionRef", "timebaseRef", "tracks", "keyframes", "editConstraints", "validationDisposition", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["compositionVersionRef", "timebaseRef", "tracks", "keyframes", "selectionRange", "editConstraints", "validationDisposition", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["loading", "ready", "selection-active", "dirty", "saving", "saved", "conflict", "read-only"],
    variants: ["audio-video-timeline", "animation-timeline", "keyframe-curve-editor", "loading", "read-only", "version-conflict"],
    actionIntents: ["media.action.select-track-or-region", "media.action.select-keyframe", "media.action.enter-exact-edit-constraints", "media.action.change-interpolation-curve", "media.action.undo-or-redo-versioned-change", "media.action.save-new-revision"],
    keyboardBehavior: "Provide keyboard selection, trim, reorder, keyframe insertion/removal, and numeric time/value entry; expose visible focus and deterministic shortcuts.",
  },
  "media.component.audio-mixer": {
    requiredProps: ["compositionVersionRef", "tracks", "gainValues", "routing", "measurements", "validationDisposition", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["compositionVersionRef", "tracks", "gainValues", "routing", "measurements", "validationDisposition", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["loading", "ready", "dirty", "clipping-observed", "saving", "saved", "conflict", "read-only"],
    variants: ["empty-session", "active-mix", "read-only", "clipping", "metering-unavailable", "version-conflict"],
    actionIntents: ["media.action.edit-audio-mix-controls", "media.action.inspect-source-measurements", "media.action.review-processing-parameters", "media.action.save-new-revision"],
    keyboardBehavior: "Every fader has numeric entry and increment controls; expose mute/solo, routing, and focus order without relying on pointer gestures.",
  },
  "media.component.mask-tracking-editor": {
    requiredProps: ["sourceVersionRef", "coordinateProfileRef", "masks", "trackingEvidence", "revisionState", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["sourceVersionRef", "coordinateProfileRef", "masks", "trackingEvidence", "propagationRange", "revisionState", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["not-loaded", "ready", "selection-active", "tracking-pending", "tracking-lost", "partial", "dirty", "conflict"],
    variants: ["static-mask", "tracked-mask", "point-track", "loading", "tracking-lost", "partial-track", "read-only"],
    actionIntents: ["media.action.select-region-or-point", "media.action.edit-mask-boundary", "media.action.limit-tracking-propagation-range", "media.action.review-uncertain-tracking"],
    keyboardBehavior: "Offer list-based region selection and numeric frame/range inputs; support keyboard point adjustments and undoable edits.",
  },
  "media.component.scene-inspector": {
    requiredProps: ["sceneVersionRef", "entityRefs", "transforms", "materialRefs", "simulationBindings", "validationDisposition", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["sceneVersionRef", "entityRefs", "transforms", "materialRefs", "simulationBindings", "validationDisposition", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["loading", "ready", "uncertain", "partial", "source-unavailable", "error"],
    variants: ["observed", "inferred", "generated-description", "partial", "unavailable", "read-only"],
    actionIntents: ["media.action.inspect-source-grounded-observation", "media.action.seek-source", "media.action.inspect-quality-evidence"],
    keyboardBehavior: "Navigate observations and source links in order; announce exact timecode; no hover-only evidence.",
  },
  "media.component.simulation-instruments": {
    requiredProps: ["modelVersionRef", "fidelityDefinitionRef", "observations", "runFinality", "qualificationDisposition", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["modelVersionRef", "runRef", "fidelityDefinitionRef", "observations", "runFinality", "qualificationDisposition", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["unconfigured", "ready", "running", "partial", "completed", "outcome-unknown", "unqualified", "failed"],
    variants: ["configured", "running", "partial-output", "completed", "unqualified", "failed", "read-only"],
    actionIntents: ["media.action.set-declared-simulation-input", "media.action.inspect-quality-evidence", "media.action.select-simulation-output-pass", "media.action.inspect-simulation-domain-and-fidelity", "media.action.open-qualification-evidence"],
    keyboardBehavior: "All instruments support labeled numeric input and keyboard stepping; expose run and output controls; do not require direct manipulation.",
  },
  "media.component.result-comparison": {
    requiredProps: ["leftVersionRef", "rightVersionRef", "comparisonBasis", "differences", "comparability", "provenanceRefs", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["leftVersionRef", "rightVersionRef", "comparisonBasis", "alignedRange", "differences", "comparability", "provenanceRefs", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["loading", "aligned", "alignment-pending", "partial", "measurement-unavailable", "error"],
    variants: ["before-after", "multi-candidate", "audio-a-b", "video-synchronized", "image-region", "alignment-unavailable"],
    actionIntents: ["media.action.select-exact-candidates", "media.action.align-source-time-interval", "media.action.inspect-quality-evidence", "media.action.record-candidate-for-review"],
    keyboardBehavior: "Provide candidate selection and synchronized playback controls through keyboard; include a list-based comparison summary.",
  },
  "media.component.quality-inspector": {
    requiredProps: ["targetVersionRef", "dimensionObservations", "uncertainty", "thresholds", "reviewState", "evidenceRefs", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["targetVersionRef", "dimensionObservations", "uncertainty", "thresholds", "reviewState", "evidenceRefs", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["loading", "complete", "partial", "not-assessed", "unavailable", "conflict"],
    variants: ["measured", "partially-measured", "not-assessed", "unavailable", "conflicting-evidence", "recommendation-only"],
    actionIntents: ["media.action.inspect-quality-evidence", "media.action.review-bounded-repair-proposal", "media.action.compare-candidate-on-metric"],
    keyboardBehavior: "Metric rows and evidence disclosures are keyboard-operable; retain focus when filters or dimensions change.",
  },
  "media.component.delivery-profile-picker": {
    requiredProps: ["outputVersionRef", "destinationRef", "profileRef", "compatibilityEvidence", "fallbackPlan", "rightsAndApprovalRefs", "deliveryFinality", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["outputVersionRef", "destinationRef", "profileRef", "compatibilityEvidence", "fallbackPlan", "rightsAndApprovalRefs", "deliveryFinality", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["loading", "choices-ready", "validation-pending", "valid", "invalid", "unavailable"],
    variants: ["available", "incompatible", "requires-validation", "partially-compatible", "deprecated", "unavailable"],
    actionIntents: ["media.action.select-eligible-processing-profile", "media.action.inspect-effective-processing-constraints", "media.action.validate-processing-profile"],
    keyboardBehavior: "Use named single-choice controls and a separately keyboard-operable validation action; preserve selection when details expand.",
  },
  "media.component.rights-retention-review": {
    requiredProps: ["subjectVersionRef", "authorityRef", "rightOrConsent", "scope", "validity", "retentionDisposition", "decisionHistory", "nextActions", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["subjectVersionRef", "authorityRef", "rightOrConsent", "scope", "validity", "retentionDisposition", "decisionHistory", "nextActions", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["loading", "permitted-with-scope", "denied", "unknown", "expired", "revoked", "review-required"],
    variants: ["permitted", "denied", "unknown", "expired", "revoked", "review-required", "evidence-unavailable"],
    actionIntents: ["media.action.inspect-governing-evidence", "media.action.request-authorized-review", "media.action.continue-within-recorded-scope"],
    keyboardBehavior: "Evidence and disposition disclosures are keyboard-operable; keep review action separate from evidence inspection.",
  },
  "media.component.activity-recovery-feed": {
    requiredProps: ["activityRecords", "freshness", "availableEvidence", "safeNextActions", "collectionState", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["activityRecords", "freshness", "availableEvidence", "safeNextActions", "collectionState", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["loading", "current", "stale", "partial", "no-results", "unknown-outcome", "recovery-pending"],
    variants: ["loading", "populated", "empty", "stale", "partial-history", "outcome-unknown", "access-limited"],
    actionIntents: ["media.action.view-job-status", "media.action.request-cancellation", "media.action.check-job-outcome", "media.action.resume-artifact-upload"],
    keyboardBehavior: "Use a semantic ordered activity list with named actions; preserve focus during refresh; never require drag or hover.",
  },
  "media.component.cli-output": {
    requiredProps: ["commandId", "requestRef", "operationState", "effectFinality", "resultRefs", "reasonAndEvidence", "exitDisposition", "state", "variant", "actionIntents", "keyboardBehavior"],
    allowedProps: ["commandId", "requestRef", "operationState", "effectFinality", "resultRefs", "reasonAndEvidence", "exitDisposition", "machineProjection", "state", "variant", "actionIntents", "keyboardBehavior"],
    states: ["completed", "pending", "unknown", "blocked", "failed", "invalid-input", "access-denied"],
    variants: ["success", "partial", "pending", "outcome-unknown", "blocked", "invalid-input", "access-denied"],
    actionIntents: ["media.action.view-job-status", "media.action.request-cancellation", "media.action.check-job-outcome", "media.action.resume-artifact-upload", "media.action.inspect-artifact"],
    keyboardBehavior: "Standard terminal navigation; support --help and structured output without prompts in machine mode; interactive confirmation must be explicit and avoid secret echo.",
  },
} as const;

export interface MediaFamilyProjectionValidation { readonly valid: boolean; readonly errors: readonly string[]; }

/** Enforces required fields and closed interaction enums at the external projection boundary. */
export function validateMediaFamilyProjection(componentId: string, props: unknown): MediaFamilyProjectionValidation {
  if (!Object.hasOwn(MEDIA_COMPONENT_RUNTIME_CONTRACTS, componentId)) return { valid: false, errors: [`Unknown Media component family: ${componentId}`] };
  const contract = Reflect.get(MEDIA_COMPONENT_RUNTIME_CONTRACTS, componentId) as (typeof MEDIA_COMPONENT_RUNTIME_CONTRACTS)[keyof typeof MEDIA_COMPONENT_RUNTIME_CONTRACTS];
  if (props === null || typeof props !== "object" || Array.isArray(props)) return { valid: false, errors: ["Component props must be an object."] };
  const value = props as Record<string, unknown>;
  const errors: string[] = [];
  for (const field of contract.requiredProps) if (!Object.hasOwn(value, field) || value[field] === undefined) errors.push(`Missing required prop: ${field}`);
  const allowedProps = new Set<string>([...contract.allowedProps, "className", "actions"]);
  for (const field of Object.keys(value)) if (!allowedProps.has(field)) errors.push(`Unknown prop: ${field}`);
  if (typeof value.state !== "string" || !(contract.states as readonly string[]).includes(value.state)) errors.push("State is outside the exact family contract.");
  if (typeof value.variant !== "string" || !(contract.variants as readonly string[]).includes(value.variant)) errors.push("Variant is outside the exact family contract.");
  if (!Array.isArray(value.actionIntents) || value.actionIntents.some((intent) => typeof intent !== "string" || !(contract.actionIntents as readonly string[]).includes(intent))) errors.push("Action intents are outside the exact family contract.");
  if (value.keyboardBehavior !== contract.keyboardBehavior) errors.push("Keyboard behavior does not match the family contract.");
  if (value.actions !== undefined && !Array.isArray(value.actions)) errors.push("Rendered action bindings must be an array.");
  const inputProps = Object.fromEntries(Object.entries(value).filter(([field]) => field !== "actions" && field !== "className"));
  const schemaResult = validateMediaComponentInputSchema(componentId, inputProps);
  errors.push(...schemaResult.errors.map((error) => `Input schema: ${error}`));
  return { valid: errors.length === 0, errors };
}
