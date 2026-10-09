import React, { useState } from "react";
import { Badge, Button } from "@ghatana/design-system";
import type { MediaActionDispatchResult } from "../ports";
import { MediaComponentValueTypes } from "./MediaComponentValueTypes";

export type MediaComponentValue = MediaComponentValueTypes.JsonValue;

export interface MediaComponentAction {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  readonly disabledReason?: string;
  readonly selectionPayloadAvailable?: boolean;
  /** Host-owned exact request adapter. A selected value is passed only when a source action accepts it. */
  readonly invoke?: (selectedValue?: MediaComponentValue) => Promise<MediaActionDispatchResult>;
}

export interface MediaComponentUiExtras {
  readonly actions?: readonly MediaComponentAction[];
  readonly className?: string;
}

type FamilyDefinitionPropsUnion =
  | IdentityContextBoundaryDefinitionProps | IntentLauncherDefinitionProps | ProjectBrowserDefinitionProps
  | ProjectContextSummaryDefinitionProps | CreationPlanSummaryDefinitionProps | SourcePickerDefinitionProps
  | SourcePlayerDefinitionProps | TranscriptReviewDefinitionProps | CaptionTrackEditorDefinitionProps
  | JobStatusCardDefinitionProps | ProvenanceSummaryDefinitionProps | ArtifactSourcePickerDefinitionProps
  | ArtifactTransferStatusDefinitionProps | ArtifactIntegritySummaryDefinitionProps | ArtifactBrowserDefinitionProps
  | WaveformSpectrogramDefinitionProps | StoryboardDefinitionProps | TimelineKeyframeEditorDefinitionProps
  | AudioMixerDefinitionProps | MaskTrackingEditorDefinitionProps | SceneInspectorDefinitionProps
  | SimulationInstrumentsDefinitionProps | ResultComparisonDefinitionProps | QualityInspectorDefinitionProps
  | DeliveryProfilePickerDefinitionProps | RightsRetentionReviewDefinitionProps | ActivityRecoveryFeedDefinitionProps
  | CliOutputDefinitionProps;

/** Literal unions are sourced from each family contract, not widened to strings. */
type FamilyContractFields = {
  readonly state: FamilyDefinitionPropsUnion["state"];
  readonly variant: FamilyDefinitionPropsUnion["variant"];
  readonly actionIntents: readonly FamilyDefinitionPropsUnion["actionIntents"][number][];
  readonly keyboardBehavior: FamilyDefinitionPropsUnion["keyboardBehavior"];
};

interface FamilyDefinition {
  readonly id: string;
  readonly title: string;
  readonly identityFields: readonly string[];
  readonly collectionFields: readonly string[];
  readonly statusFields: readonly string[];
  readonly fieldDescriptions: Readonly<Record<string, string>>;
  readonly selectionList?: string;
  readonly selectionKey?: "intentRef" | "versionRef";
  readonly selectionActionProp?: "selectionAction" | "chooseIntentAction" | "$singleDeclared";
}

function labelFor(field: string): string {
  return field.replace(/Ref$/u, " reference").replace(/([a-z0-9])([A-Z])/gu, "$1 $2").replace(/^./u, (c) => c.toUpperCase());
}

function recordSelectionField(value: unknown, field: "intentRef" | "versionRef"): MediaComponentValue | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  const candidate = Reflect.get(value, field);
  if (typeof candidate === "string" && candidate.length > 0) return candidate;
  if (candidate !== null && typeof candidate === "object" && !Array.isArray(candidate)) return candidate as MediaComponentValue;
  return undefined;
}

function recordLabel(value: unknown): string | undefined {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined;
  for (const key of ["label", "title", "sourceName"] as const) {
    const candidate = Reflect.get(value, key);
    if (typeof candidate === "string" && candidate.trim().length > 0) return candidate;
  }
  return undefined;
}

function ValueView({ value }: { readonly value: unknown }): React.ReactElement {
  if (value === null || value === undefined) return <span>Not supplied</span>;
  if (typeof value === "string" || typeof value === "number") return <span>{String(value)}</span>;
  if (typeof value === "boolean") return <span>{value ? "Yes" : "No"}</span>;
  if (Array.isArray(value)) {
    if (value.length === 0) return <span>None recorded</span>;
    return <ol>{value.map((item, index) => <li key={index}><ValueView value={item} /></li>)}</ol>;
  }
  if (typeof value === "object") {
    return <dl className="media-family__nested-facts">
      {Object.entries(value).map(([key, child]) => <div key={key}><dt>{labelFor(key)}</dt><dd><ValueView value={child} /></dd></div>)}
    </dl>;
  }
  return <span>Unsupported projected value</span>;
}

function resultMessage(result: MediaActionDispatchResult): string {
  switch (result.status) {
    case "intent-accepted": return "The action intent was accepted. This does not confirm a domain effect.";
    case "local-applied": return "The source-defined local selection or draft change was applied; no remote effect is implied.";
    case "request-started": return `Request started (${result.requestId}). Completion remains unobserved.`;
    case "request-acknowledged": return `Request acknowledged (${result.requestId}). Completion remains unobserved.`;
    case "denied": return `Action denied: ${result.reason}`;
    case "unavailable": return `Action unavailable: ${result.reason}`;
    case "failed": return `Action failed: ${result.reason}`;
  }
}

function FamilySurface<Props extends FamilyContractFields>({ definition, ...props }: { readonly definition: FamilyDefinition } & Props & MediaComponentUiExtras): React.ReactElement {
  const { state, variant, actionIntents, keyboardBehavior, actions = [], className, ...rawValues } = props;
  const values: Readonly<Record<string, unknown>> = Object.fromEntries(Object.entries(rawValues));
  const keys = Object.keys(values).filter((key) => values[key] !== undefined);
  const identity = definition.identityFields.filter((field) => keys.includes(field));
  const status = definition.statusFields.filter((field) => keys.includes(field));
  const collections = definition.collectionFields.filter((field) => keys.includes(field));
  const remaining = keys.filter((field) => !identity.includes(field) && !status.includes(field) && !collections.includes(field));
  const declaredActionIds = new Set<string>(actionIntents);
  const matchingActions = actions.filter((action) => declaredActionIds.has(action.id));
  const invalidActions = actions.filter((action) => !declaredActionIds.has(action.id));
  const [selectedValue, setSelectedValue] = useState<MediaComponentValue | undefined>();
  const [pendingAction, setPendingAction] = useState<string | undefined>();
  const [actionObservation, setActionObservation] = useState<{ readonly id: string; readonly message: string; readonly tone: "info" | "danger" } | undefined>();
  const selectedActionValue = definition.selectionActionProp ? values[definition.selectionActionProp] : undefined;
  const selectedActionId = definition.selectionActionProp === "$singleDeclared"
    ? (matchingActions.length === 1 ? matchingActions[0]?.id : undefined)
    : selectedActionValue;
  const selectionAction = typeof selectedActionId === "string" ? matchingActions.find((action) => action.id === selectedActionId) : undefined;
  const facts = (fields: readonly string[]) => fields.map((field) => <div key={field}>
    <dt>{labelFor(field)}</dt><dd><ValueView value={values[field]} />
      {definition.fieldDescriptions[field] && <small>{definition.fieldDescriptions[field]}</small>}
    </dd>
  </div>);
  const invokeAction = async (action: MediaComponentAction, value?: MediaComponentValue): Promise<void> => {
    if (!action.enabled || !action.invoke || pendingAction) return;
    setPendingAction(action.id);
    setActionObservation({ id: action.id, message: "Requesting action; completion remains unknown until a fresh owner projection arrives.", tone: "info" });
    try {
      const result = await action.invoke(value);
      setActionObservation({ id: action.id, message: resultMessage(result), tone: result.status === "failed" || result.status === "denied" || result.status === "unavailable" ? "danger" : "info" });
    } catch (error) {
      setActionObservation({ id: action.id, message: `Action request could not be confirmed: ${error instanceof Error ? error.message : "unknown request failure"}. Reconcile before retrying.`, tone: "danger" });
    } finally {
      setPendingAction(undefined);
    }
  };
  const renderCollection = (field: string): React.ReactNode => {
    const entries = values[field];
    if (!Array.isArray(entries)) return <ValueView value={entries} />;
    if (entries.length === 0) return <p>No records are available in this projection.</p>;
    const ordered = definition.id === "media.component.timeline-keyframe-editor" || definition.id === "media.component.storyboard" || definition.id === "media.component.transcript-review" || definition.id === "media.component.caption-track-editor" || definition.id === "media.component.activity-recovery-feed";
    return <ol className={ordered ? "media-family__records media-family__records--ordered" : "media-family__records"} aria-label={labelFor(field)}>
      {entries.map((entry, index) => {
        const keyValue = definition.selectionKey ? recordSelectionField(entry, definition.selectionKey) : undefined;
        const selectable = field === definition.selectionList && keyValue !== undefined;
        const selected = selectedValue !== undefined && keyValue === selectedValue;
        const titleValue = recordLabel(entry) ?? keyValue;
        return <li key={index}>
          {selectable && <Button type="button" variant="outline" aria-pressed={selected} disabled={!selectionAction?.enabled || !selectionAction?.invoke || !selectionAction.selectionPayloadAvailable || Boolean(pendingAction)} onClick={() => setSelectedValue(keyValue)}>
            {selected ? "Selected for this review" : `Select ${typeof titleValue === "string" ? titleValue : `record ${index + 1}`}`}
          </Button>}
          <div><ValueView value={entry} /></div>
        </li>;
      })}
    </ol>;
  };

  const renderReadOnlyFields = (title: string, fields: readonly string[]) => {
    const present = fields.filter((field) => keys.includes(field));
    if (present.length === 0) return null;
    return <section className="media-family__anatomy" aria-label={title}>
      <h5>{title}</h5>
      {present.filter((field) => collections.includes(field)).map((field) => <div key={field} className="media-family__anatomy-list"><h6>{labelFor(field)}</h6>{renderCollection(field)}</div>)}
      {present.filter((field) => !collections.includes(field)).length > 0 && <dl>{facts(present.filter((field) => !collections.includes(field)))}</dl>}
    </section>;
  };
  const specializedAnatomy = (() => {
    switch (definition.id) {
      case "media.component.identity-context-boundary": return renderReadOnlyFields("Requested destination and handoff", ["requestedDestinationRef", "handoffState", "resolvedWorkspaceRef", "safeReturnIntent", "contextResolution"]);
      case "media.component.intent-launcher": return renderReadOnlyFields("Available intents", ["intentOptions", "selectedIntentRef", "availabilityEvidenceRef", "chooseIntentAction"]);
      case "media.component.project-browser": return renderReadOnlyFields("Scoped project search", ["workspaceRef", "query", "projects", "selectionState", "nextPageRef"]);
      case "media.component.project-context-summary": return renderReadOnlyFields("Tenant-scoped project context", ["workspaceRef", "projectRef", "revisionRef", "accessDisposition", "safeNextActions"]);
      case "media.component.creation-plan-summary": return renderReadOnlyFields("Plan inputs, constraints, and finality", ["planRef", "requestedOutcome", "inputVersionRefs", "capabilityDisposition", "policyAndRightsEffects", "estimates", "planFinality"]);
      case "media.component.source-picker": return renderReadOnlyFields("Source search and exact version choice", ["workspaceRef", "targetProjectRef", "query", "sourceCandidates", "selectionState", "selectedSourceVersionRef"]);
      case "media.component.artifact-source-picker": return renderReadOnlyFields("Project artifacts and source version choice", ["projectRef", "query", "artifactCandidates", "selectionState", "selectedVersionRef", "selectionAction"]);
      case "media.component.source-player": return renderReadOnlyFields("Exact source playback and clock", ["sourceVersionRef", "playbackState", "sourceTime", "duration", "timebaseRef", "accessiblePreviewRef"]);
      case "media.component.transcript-review": return renderReadOnlyFields("Transcript segments on the source clock", ["sourceVersionRef", "transcriptVersionRef", "languageTag", "segments", "selectedSegmentRef", "reviewDisposition"]);
      case "media.component.caption-track-editor": return renderReadOnlyFields("Caption draft cues and validation", ["sourceVersionRef", "captionDraftRef", "sourceTimebaseRef", "cues", "validationDisposition", "saveAsNewVersionAction"]);
      case "media.component.job-status-card": return renderReadOnlyFields("Job attempts, outputs, and effect finality", ["jobRef", "jobState", "effectFinality", "progress", "attempts", "outputVersionRefs", "allowedRecoveryActions"]);
      case "media.component.provenance-summary": return renderReadOnlyFields("Version lineage and epistemic limits", ["resultVersionRef", "sourceVersionRefs", "derivationSteps", "environmentRef", "timeReferences", "uncertainties"]);
      case "media.component.artifact-transfer-status": return renderReadOnlyFields("Upload receipt and verification state", ["uploadRef", "expectedByteLength", "receivedByteLength", "chunkReceipts", "transferState", "verificationJobRef", "effectFinality"]);
      case "media.component.artifact-integrity-summary": return renderReadOnlyFields("Immutable version integrity", ["artifactVersionRef", "byteLength", "mediaType", "digest", "verificationState", "verificationEvidence"]);
      case "media.component.artifact-browser": return renderReadOnlyFields("Authorized artifact versions", ["workspaceRef", "projectRef", "query", "artifactVersions", "selectionState", "nextPageRef"]);
      case "media.component.waveform-spectrogram": return renderReadOnlyFields("Signal measurements and source interval", ["sourceVersionRef", "sampleRateHz", "channelLayout", "timebaseRef", "windowDefinition", "observations", "selectedRange"]);
      case "media.component.storyboard": return renderReadOnlyFields("Ordered scenes and transitions", ["compositionVersionRef", "timebaseRef", "scenes", "transitionSpecs", "validationDisposition", "storyboardActionIntents"]);
      case "media.component.timeline-keyframe-editor": return renderReadOnlyFields("Versioned tracks, keyframes, and edit constraints", ["compositionVersionRef", "timebaseRef", "tracks", "keyframes", "selectionRange", "editConstraints", "validationDisposition"]);
      case "media.component.audio-mixer": return renderReadOnlyFields("Source-bound tracks, gain, routing, and measurements", ["compositionVersionRef", "tracks", "gainValues", "routing", "measurements", "validationDisposition"]);
      case "media.component.mask-tracking-editor": return renderReadOnlyFields("Versioned masks and bounded tracking evidence", ["sourceVersionRef", "coordinateProfileRef", "masks", "trackingEvidence", "propagationRange", "revisionState"]);
      case "media.component.scene-inspector": return renderReadOnlyFields("Scene entities, coordinate profiles, and bindings", ["sceneVersionRef", "entityRefs", "transforms", "materialRefs", "simulationBindings", "validationDisposition"]);
      case "media.component.simulation-instruments": return renderReadOnlyFields("Model run, fidelity, and observations", ["modelVersionRef", "runRef", "fidelityDefinitionRef", "observations", "runFinality", "qualificationDisposition"]);
      case "media.component.result-comparison": return renderReadOnlyFields("Exact candidate versions and comparison basis", ["leftVersionRef", "rightVersionRef", "comparisonBasis", "alignedRange", "comparability", "differences", "provenanceRefs"]);
      case "media.component.quality-inspector": return renderReadOnlyFields("Metric observations, uncertainty, and review state", ["targetVersionRef", "dimensionObservations", "uncertainty", "thresholds", "reviewState", "evidenceRefs"]);
      case "media.component.delivery-profile-picker": return renderReadOnlyFields("Exact output, destination, and compatibility", ["outputVersionRef", "destinationRef", "profileRef", "compatibilityEvidence", "fallbackPlan", "rightsAndApprovalRefs", "deliveryFinality"]);
      case "media.component.rights-retention-review": return renderReadOnlyFields("Scoped rights, consent, and retention", ["subjectVersionRef", "authorityRef", "rightOrConsent", "scope", "validity", "retentionDisposition", "decisionHistory", "nextActions"]);
      case "media.component.activity-recovery-feed": return renderReadOnlyFields("Ordered activity and safe recovery evidence", ["activityRecords", "freshness", "collectionState", "availableEvidence", "safeNextActions"]);
      case "media.component.cli-output": return renderReadOnlyFields("Command outcome and machine-readable evidence", ["commandId", "requestRef", "operationState", "effectFinality", "exitDisposition", "resultRefs", "reasonAndEvidence", "machineProjection"]);
      default: return null;
    }
  })();

  return <section className={["media-family", className].filter(Boolean).join(" ")} aria-label={definition.title} data-component-id={definition.id}>
    <header className="media-family__header">
      <h4>{definition.title}</h4>
      <div className="media-family__disposition"><Badge variant="outline" tone="neutral">{state}</Badge><Badge variant="soft" tone="info">{variant}</Badge></div>
    </header>
    {specializedAnatomy ?? <>
      {identity.length > 0 && <section aria-label="Version and scope identities"><h5>Version and scope</h5><dl>{facts(identity)}</dl></section>}
      {status.length > 0 && <section aria-label="Observed state and evidence"><h5>Observed state and evidence</h5><dl>{facts(status)}</dl></section>}
      {collections.map((field) => <section key={field} aria-label={labelFor(field)}><h5>{labelFor(field)}</h5>{renderCollection(field)}</section>)}
      {remaining.length > 0 && <section aria-label="Definition details"><h5>Definition details</h5><dl>{facts(remaining)}</dl></section>}
    </>}
    {definition.selectionList && selectedValue !== undefined && selectionAction && <div className="media-family__actions">
      <Button type="button" variant="solid" disabled={!selectionAction.enabled || !selectionAction.invoke || !selectionAction.selectionPayloadAvailable || Boolean(pendingAction)} onClick={() => void invokeAction(selectionAction, selectedValue)}>
        {pendingAction === selectionAction.id ? "Requesting…" : selectionAction.label}
      </Button>
      {selectionAction.disabledReason && <p>{selectionAction.disabledReason}</p>}
    </div>}
    {matchingActions.filter((action) => action.id !== selectionAction?.id).length > 0 && <div className="media-family__actions" aria-label="Available component actions">
      {matchingActions.filter((action) => action.id !== selectionAction?.id).map((action) => <span key={action.id}>
        <Button type="button" variant="outline" disabled={!action.enabled || !action.invoke || Boolean(pendingAction)} aria-describedby={action.disabledReason ? `${definition.id}-action-${action.id}-reason` : undefined} onClick={() => void invokeAction(action)}>
          {pendingAction === action.id ? "Requesting…" : action.label}
        </Button>
        {action.disabledReason && <span id={`${definition.id}-action-${action.id}-reason`} className="media-family__reason">{action.disabledReason}</span>}
      </span>)}
    </div>}
    {invalidActions.length > 0 && <p role="status">An action not declared by this component was withheld.</p>}
    {actionObservation && <p role="status" aria-live="polite" data-tone={actionObservation.tone}>{actionObservation.message}</p>}
    <details className="media-family__keyboard-contract"><summary>Keyboard behavior contract</summary><ValueView value={keyboardBehavior} /></details>
  </section>;
}

function defineFamily<Props extends FamilyContractFields>(definition: FamilyDefinition): React.FC<Props & MediaComponentUiExtras> {
  const Family: React.FC<Props & MediaComponentUiExtras> = (props) => <FamilySurface {...props} definition={definition} />;
  Family.displayName = definition.id.split(".").at(-1)?.replace(/-([a-z])/gu, (_, c: string) => c.toUpperCase()) ?? definition.id;
  return Family;
}

export interface IdentityContextBoundaryDefinitionProps {
  readonly requestedDestinationRef: MediaComponentValueTypes.MediaViewRef;
  readonly handoffState: 'identity-required' | 'reauthentication-required' | 'context-ready' | 'context-denied' | 'unavailable';
  readonly resolvedWorkspaceRef?: MediaComponentValueTypes.TenantScopedWorkspaceRef;
  readonly identityRequest?: MediaComponentValueTypes.OptionalIdentityHandoffRequest;
  readonly contextResolution?: MediaComponentValueTypes.OptionalIdentityHandoffEvaluation;
  readonly safeReturnIntent: 'media.action.return-to-requested-destination-after-identity-confirmation';
  readonly state: 'identity-required' | 'reauthentication-required' | 'context-ready' | 'context-denied' | 'unavailable';
  readonly variant: 'identity-required' | 'reauthentication-required' | 'context-ready' | 'context-denied' | 'unavailable';
  readonly actionIntents: readonly [];
  readonly keyboardBehavior: 'preserve-return-focus-and-destination-across-the-upstream-handoff';
}
export type IdentityContextBoundaryProps = IdentityContextBoundaryDefinitionProps & MediaComponentUiExtras;
export const IdentityContextBoundary: React.FC<IdentityContextBoundaryProps> = defineFamily<IdentityContextBoundaryDefinitionProps>({
  id: 'media.component.identity-context-boundary', title: 'Identity Context Boundary',
  identityFields: ['requestedDestinationRef', 'resolvedWorkspaceRef'] as const, collectionFields: [] as const, statusFields: ['handoffState'] as const,
  fieldDescriptions: {'handoffState': 'Closed enum source values for Enum<identity-required|reauthentication-required|context-ready|context-denied|unavailable>.', 'safeReturnIntent': 'Exact source-bound action intent identity.'},
});

export interface IntentLauncherDefinitionProps {
  readonly intentOptions: readonly (MediaComponentValueTypes.IntentOption)[];
  readonly selectedIntentRef?: MediaComponentValueTypes.CanonicalIntentRef;
  readonly availabilityEvidenceRef?: MediaComponentValueTypes.EvidenceRef;
  readonly chooseIntentAction: 'media.action.choose-intent';
  readonly state: 'available' | 'unavailable-with-reason' | 'selected' | 'loading';
  readonly variant: 'available' | 'unavailable-with-reason' | 'selected' | 'loading';
  readonly actionIntents: readonly ('media.action.choose-intent')[];
  readonly keyboardBehavior: 'each-intent-is-a-named-native-choice-with-visible-focus';
}
export type IntentLauncherProps = IntentLauncherDefinitionProps & MediaComponentUiExtras;
export const IntentLauncher: React.FC<IntentLauncherProps> = defineFamily<IntentLauncherDefinitionProps>({
  id: 'media.component.intent-launcher', title: 'Intent Launcher',
  identityFields: ['selectedIntentRef', 'availabilityEvidenceRef'] as const, collectionFields: ['intentOptions'] as const, statusFields: ['availabilityEvidenceRef'] as const,
  fieldDescriptions: {'intentOptions': 'Typed array of IntentOption values.', 'chooseIntentAction': 'Exact source-bound action intent identity.'},
  selectionList: 'intentOptions', selectionKey: 'intentRef', selectionActionProp: 'chooseIntentAction',
});

export interface ProjectBrowserDefinitionProps {
  readonly workspaceRef: MediaComponentValueTypes.TenantScopedWorkspaceRef;
  readonly query: MediaComponentValueTypes.ProjectSearchQuery;
  readonly projects: readonly (MediaComponentValueTypes.ProjectSummary)[];
  readonly pageState: MediaComponentValueTypes.PageState;
  readonly projectActions: readonly (MediaComponentValueTypes.ActionIntentRef)[];
  readonly state: 'loading' | 'populated' | 'empty' | 'no-results' | 'stale' | 'create-pending' | 'create-unknown' | 'access-denied';
  readonly variant: 'loading' | 'populated' | 'empty' | 'no-results' | 'stale' | 'create-pending' | 'create-unknown' | 'access-denied';
  readonly actionIntents: readonly ('media.action.open-project' | 'media.action.create-project')[];
  readonly keyboardBehavior: 'labelled-search; arrow-or-tab-navigation-through-project-results; named-row-actions';
}
export type ProjectBrowserProps = ProjectBrowserDefinitionProps & MediaComponentUiExtras;
export const ProjectBrowser: React.FC<ProjectBrowserProps> = defineFamily<ProjectBrowserDefinitionProps>({
  id: 'media.component.project-browser', title: 'Project Browser',
  identityFields: ['workspaceRef'] as const, collectionFields: ['projects', 'projectActions'] as const, statusFields: ['pageState'] as const,
  fieldDescriptions: {'projects': 'Typed array of ProjectSummary values.', 'projectActions': 'Typed array of ActionIntentRef values.'},
});

export interface ProjectContextSummaryDefinitionProps {
  readonly workspaceRef: MediaComponentValueTypes.TenantScopedWorkspaceRef;
  readonly projectRef: MediaComponentValueTypes.OpaqueProjectRef;
  readonly revisionRef: MediaComponentValueTypes.ImmutableProjectRevisionRef;
  readonly accessDisposition: MediaComponentValueTypes.AccessDisposition;
  readonly safeNextActions: readonly (MediaComponentValueTypes.ActionIntentRef)[];
  readonly state: 'empty-project' | 'populated-project' | 'stale-revision' | 'access-limited' | 'loading';
  readonly variant: 'empty-project' | 'populated-project' | 'stale-revision' | 'access-limited' | 'loading';
  readonly actionIntents: readonly ('media.action.choose-intent')[];
  readonly keyboardBehavior: 'project-context-and-next-action-are-navigable-with-visible-focus';
}
export type ProjectContextSummaryProps = ProjectContextSummaryDefinitionProps & MediaComponentUiExtras;
export const ProjectContextSummary: React.FC<ProjectContextSummaryProps> = defineFamily<ProjectContextSummaryDefinitionProps>({
  id: 'media.component.project-context-summary', title: 'Project Context Summary',
  identityFields: ['workspaceRef', 'projectRef', 'revisionRef'] as const, collectionFields: ['safeNextActions'] as const, statusFields: ['accessDisposition'] as const,
  fieldDescriptions: {'safeNextActions': 'Typed array of ActionIntentRef values.'},
});

export interface CreationPlanSummaryDefinitionProps {
  readonly planRef: MediaComponentValueTypes.ProposedPlanRef;
  readonly requestedOutcome: MediaComponentValueTypes.CanonicalIntentRef;
  readonly inputVersionRefs: readonly (MediaComponentValueTypes.ExactArtifactVersionRef)[];
  readonly capabilityDisposition: readonly (MediaComponentValueTypes.CapabilityProfileDisposition)[];
  readonly policyAndRightsEffects: readonly (MediaComponentValueTypes.ScopedPolicyDecision)[];
  readonly estimates?: readonly (MediaComponentValueTypes.EstimateWithMethodAndUncertainty)[];
  readonly planFinality: MediaComponentValueTypes.ProposalFinality;
  readonly state: 'ready-for-review' | 'missing-input' | 'unavailable-capability' | 'policy-blocked' | 'stale-plan';
  readonly variant: 'ready-for-review' | 'missing-input' | 'unavailable-capability' | 'policy-blocked' | 'stale-plan';
  readonly actionIntents: readonly [];
  readonly keyboardBehavior: 'information-order-is-stable; all-disclosures-and-next-view-links-are-keyboard-operable';
}
export type CreationPlanSummaryProps = CreationPlanSummaryDefinitionProps & MediaComponentUiExtras;
export const CreationPlanSummary: React.FC<CreationPlanSummaryProps> = defineFamily<CreationPlanSummaryDefinitionProps>({
  id: 'media.component.creation-plan-summary', title: 'Creation Plan Summary',
  identityFields: ['planRef'] as const, collectionFields: ['inputVersionRefs', 'capabilityDisposition', 'policyAndRightsEffects', 'estimates'] as const, statusFields: ['capabilityDisposition', 'planFinality'] as const,
  fieldDescriptions: {'inputVersionRefs': 'Typed array of ExactArtifactVersionRef values.', 'capabilityDisposition': 'Typed array of CapabilityProfileDisposition values.', 'policyAndRightsEffects': 'Typed array of ScopedPolicyDecision values.', 'estimates': 'Typed array of EstimateWithMethodAndUncertainty values.'},
});

export interface SourcePickerDefinitionProps {
  readonly workspaceRef: MediaComponentValueTypes.TenantScopedWorkspaceRef;
  readonly targetProjectRef: MediaComponentValueTypes.OpaqueProjectRef;
  readonly query: MediaComponentValueTypes.ArtifactSearchQuery;
  readonly sourceCandidates: readonly (MediaComponentValueTypes.SourceVersionCandidate)[];
  readonly selectedSourceVersionRef?: MediaComponentValueTypes.ExactArtifactVersionRef;
  readonly selectionState: 'empty' | 'loading' | 'available' | 'unavailable' | 'access-denied' | 'stale';
  readonly state: 'empty' | 'selected' | 'unavailable' | 'denied';
  readonly variant: 'empty' | 'selected' | 'unavailable' | 'denied';
  readonly actionIntents: readonly ('media.action.choose-source')[];
  readonly keyboardBehavior: 'native-selection-controls; complete-row-selection; visible-focus';
}
export type SourcePickerProps = SourcePickerDefinitionProps & MediaComponentUiExtras;
export const SourcePicker: React.FC<SourcePickerProps> = defineFamily<SourcePickerDefinitionProps>({
  id: 'media.component.source-picker', title: 'Source Picker',
  identityFields: ['workspaceRef', 'targetProjectRef', 'selectedSourceVersionRef'] as const, collectionFields: ['sourceCandidates'] as const, statusFields: ['selectionState'] as const,
  fieldDescriptions: {'sourceCandidates': 'Typed array of SourceVersionCandidate values.', 'selectionState': 'Closed enum source values for Enum<empty|loading|available|unavailable|access-denied|stale>.'},
  selectionList: 'sourceCandidates', selectionKey: 'versionRef', selectionActionProp: '$singleDeclared',
});

export interface SourcePlayerDefinitionProps {
  readonly sourceVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
  readonly playbackState: 'loading' | 'ready' | 'playing' | 'paused' | 'seeking' | 'unavailable' | 'failed';
  readonly sourceTime: MediaComponentValueTypes.RationalSourceTime;
  readonly duration?: MediaComponentValueTypes.OptionalRationalDuration;
  readonly timebaseRef: MediaComponentValueTypes.SourceTimebaseRef;
  readonly accessiblePreviewRef?: MediaComponentValueTypes.AuthorizedPreviewRef;
  readonly state: 'audio' | 'video' | 'loading' | 'unavailable';
  readonly variant: 'audio' | 'video' | 'loading' | 'unavailable';
  readonly actionIntents: readonly ('media.action.play-source' | 'media.action.seek-source')[];
  readonly keyboardBehavior: 'keyboard-play-pause-and-seek; no-drag-only-control';
}
export type SourcePlayerProps = SourcePlayerDefinitionProps & MediaComponentUiExtras;
export const SourcePlayer: React.FC<SourcePlayerProps> = defineFamily<SourcePlayerDefinitionProps>({
  id: 'media.component.source-player', title: 'Source Player',
  identityFields: ['sourceVersionRef', 'timebaseRef', 'accessiblePreviewRef'] as const, collectionFields: [] as const, statusFields: ['playbackState', 'accessiblePreviewRef'] as const,
  fieldDescriptions: {'playbackState': 'Closed enum source values for Enum<loading|ready|playing|paused|seeking|unavailable|failed>.'},
});

export interface TranscriptReviewDefinitionProps {
  readonly sourceVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
  readonly transcriptVersionRef: MediaComponentValueTypes.ExactTranscriptVersionRef;
  readonly languageTag: MediaComponentValueTypes.BCP47LanguageTag;
  readonly segments: readonly (MediaComponentValueTypes.TranscriptSegment)[];
  readonly selectedSegmentRef?: MediaComponentValueTypes.TranscriptSegmentRef;
  readonly reviewDisposition: 'unreviewed' | 'corrected' | 'uncertain' | 'accepted' | 'rejected';
  readonly state: 'ready' | 'uncertain-language' | 'timing-review-required' | 'read-only' | 'consent-revoked';
  readonly variant: 'ready' | 'uncertain-language' | 'timing-review-required' | 'read-only' | 'consent-revoked';
  readonly actionIntents: readonly ('media.action.review-transcript' | 'media.action.seek-source')[];
  readonly keyboardBehavior: 'navigate-by-segment; source-time-is-announced';
}
export type TranscriptReviewProps = TranscriptReviewDefinitionProps & MediaComponentUiExtras;
export const TranscriptReview: React.FC<TranscriptReviewProps> = defineFamily<TranscriptReviewDefinitionProps>({
  id: 'media.component.transcript-review', title: 'Transcript Review',
  identityFields: ['sourceVersionRef', 'transcriptVersionRef', 'selectedSegmentRef'] as const, collectionFields: ['segments'] as const, statusFields: ['reviewDisposition'] as const,
  fieldDescriptions: {'segments': 'Typed array of TranscriptSegment values.', 'reviewDisposition': 'Closed enum source values for Enum<unreviewed|corrected|uncertain|accepted|rejected>.'},
});

export interface CaptionTrackEditorDefinitionProps {
  readonly sourceVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
  readonly captionDraftRef: MediaComponentValueTypes.CaptionDraftRef;
  readonly sourceTimebaseRef: MediaComponentValueTypes.SourceTimebaseRef;
  readonly cues: readonly (MediaComponentValueTypes.CaptionCueDraft)[];
  readonly validationDisposition: 'valid' | 'invalid' | 'conflict' | 'unknown';
  readonly saveAsNewVersionAction: 'media.action.save-caption-version';
  readonly state: 'draft' | 'needs-alignment' | 'version-conflict' | 'saved' | 'read-only';
  readonly variant: 'draft' | 'needs-alignment' | 'version-conflict' | 'saved' | 'read-only';
  readonly actionIntents: readonly ('media.action.correct-caption' | 'media.action.align-caption-timing' | 'media.action.resolve-caption-conflict' | 'media.action.save-caption-version')[];
  readonly keyboardBehavior: 'select-and-edit-by-row; provide-numeric-time-edit-alternative-to-dragging';
}
export type CaptionTrackEditorProps = CaptionTrackEditorDefinitionProps & MediaComponentUiExtras;
export const CaptionTrackEditor: React.FC<CaptionTrackEditorProps> = defineFamily<CaptionTrackEditorDefinitionProps>({
  id: 'media.component.caption-track-editor', title: 'Caption Track Editor',
  identityFields: ['sourceVersionRef', 'captionDraftRef', 'sourceTimebaseRef'] as const, collectionFields: ['cues'] as const, statusFields: ['validationDisposition'] as const,
  fieldDescriptions: {'cues': 'Typed array of CaptionCueDraft values.', 'validationDisposition': 'Closed enum source values for Enum<valid|invalid|conflict|unknown>.', 'saveAsNewVersionAction': 'Exact source-bound action intent identity.'},
});

export interface JobStatusCardDefinitionProps {
  readonly jobRef: MediaComponentValueTypes.OpaqueJobRef;
  readonly attempts: readonly (MediaComponentValueTypes.JobAttemptSummary)[];
  readonly jobState: MediaComponentValueTypes.MediaJobState;
  readonly effectFinality: MediaComponentValueTypes.EffectFinality;
  readonly progress?: MediaComponentValueTypes.OptionalMeasuredProgress;
  readonly outputVersionRefs: readonly (MediaComponentValueTypes.ExactArtifactVersionRef)[];
  readonly allowedRecoveryActions: readonly (MediaComponentValueTypes.ActionIntentRef)[];
  readonly state: 'queued' | 'running' | 'completed' | 'partially-succeeded' | 'failed' | 'retry-pending' | 'outcome-unknown' | 'reconciling' | 'cancelled';
  readonly variant: 'queued' | 'running' | 'completed' | 'partially-succeeded' | 'failed' | 'retry-pending' | 'outcome-unknown' | 'reconciling' | 'cancelled';
  readonly actionIntents: readonly ('media.action.view-job-status' | 'media.action.request-cancellation' | 'media.action.check-job-outcome' | 'media.action.retry-job')[];
  readonly keyboardBehavior: 'actions-have-explicit-names-and-reasons';
}
export type JobStatusCardProps = JobStatusCardDefinitionProps & MediaComponentUiExtras;
export const JobStatusCard: React.FC<JobStatusCardProps> = defineFamily<JobStatusCardDefinitionProps>({
  id: 'media.component.job-status-card', title: 'Job Status Card',
  identityFields: ['jobRef'] as const, collectionFields: ['attempts', 'outputVersionRefs', 'allowedRecoveryActions'] as const, statusFields: ['jobState', 'effectFinality', 'progress'] as const,
  fieldDescriptions: {'attempts': 'Typed array of JobAttemptSummary values.', 'outputVersionRefs': 'Typed array of ExactArtifactVersionRef values.', 'allowedRecoveryActions': 'Typed array of ActionIntentRef values.'},
});

export interface ProvenanceSummaryDefinitionProps {
  readonly resultVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
  readonly sourceVersionRefs: readonly (MediaComponentValueTypes.ExactArtifactVersionRef)[];
  readonly derivationSteps: readonly (MediaComponentValueTypes.OperationExecutionRef)[];
  readonly environmentRef?: MediaComponentValueTypes.OptionalQualifiedProfileRef;
  readonly timeReferences: readonly (MediaComponentValueTypes.SourceTimestampWithClock)[];
  readonly uncertainties: readonly (MediaComponentValueTypes.ProvenanceUnknown)[];
  readonly state: 'measured' | 'recognized' | 'estimated' | 'generated' | 'incomplete';
  readonly variant: 'measured' | 'recognized' | 'estimated' | 'generated' | 'incomplete';
  readonly actionIntents: readonly ('media.action.inspect-provenance')[];
  readonly keyboardBehavior: 'disclosure-is-operable-with-keyboard';
}
export type ProvenanceSummaryProps = ProvenanceSummaryDefinitionProps & MediaComponentUiExtras;
export const ProvenanceSummary: React.FC<ProvenanceSummaryProps> = defineFamily<ProvenanceSummaryDefinitionProps>({
  id: 'media.component.provenance-summary', title: 'Provenance Summary',
  identityFields: ['resultVersionRef', 'environmentRef'] as const, collectionFields: ['sourceVersionRefs', 'derivationSteps', 'timeReferences', 'uncertainties'] as const, statusFields: ['uncertainties'] as const,
  fieldDescriptions: {'sourceVersionRefs': 'Typed array of ExactArtifactVersionRef values.', 'derivationSteps': 'Typed array of OperationExecutionRef values.', 'timeReferences': 'Typed array of SourceTimestampWithClock values.', 'uncertainties': 'Typed array of ProvenanceUnknown values.'},
});

export interface ArtifactSourcePickerDefinitionProps {
  readonly projectRef: MediaComponentValueTypes.OpaqueProjectRef;
  readonly query: MediaComponentValueTypes.ArtifactSearchQuery;
  readonly artifactCandidates: readonly (MediaComponentValueTypes.ArtifactVersionCandidate)[];
  readonly selectedVersionRef?: MediaComponentValueTypes.ExactArtifactVersionRef;
  readonly selectionState: 'loading' | 'available' | 'empty' | 'unavailable' | 'access-denied' | 'stale';
  readonly selectionAction: MediaComponentValueTypes.ActionIntentRef;
  readonly state: 'empty' | 'selected' | 'unsupported-by-admitted-contract' | 'access-denied';
  readonly variant: 'empty' | 'selected' | 'unsupported-by-admitted-contract' | 'access-denied';
  readonly actionIntents: readonly ('media.action.select-artifact-source')[];
  readonly keyboardBehavior: 'native-file-picker-and-labelled-source-choice; drag-and-drop-is-never-the-only-input';
}
export type ArtifactSourcePickerProps = ArtifactSourcePickerDefinitionProps & MediaComponentUiExtras;
export const ArtifactSourcePicker: React.FC<ArtifactSourcePickerProps> = defineFamily<ArtifactSourcePickerDefinitionProps>({
  id: 'media.component.artifact-source-picker', title: 'Artifact Source Picker',
  identityFields: ['projectRef', 'selectedVersionRef'] as const, collectionFields: ['artifactCandidates'] as const, statusFields: ['selectionState', 'selectionAction'] as const,
  fieldDescriptions: {'artifactCandidates': 'Typed array of ArtifactVersionCandidate values.', 'selectionState': 'Closed enum source values for Enum<loading|available|empty|unavailable|access-denied|stale>.'},
  selectionList: 'artifactCandidates', selectionKey: 'versionRef', selectionActionProp: 'selectionAction',
});

export interface ArtifactTransferStatusDefinitionProps {
  readonly uploadRef: MediaComponentValueTypes.OpaqueUploadRef;
  readonly expectedByteLength?: MediaComponentValueTypes.OptionalNonnegativeInteger;
  readonly receivedByteLength: MediaComponentValueTypes.MeasuredNonnegativeInteger;
  readonly chunkReceipts: readonly (MediaComponentValueTypes.ChunkReceipt)[];
  readonly transferState: MediaComponentValueTypes.UploadTransferState;
  readonly verificationJobRef?: MediaComponentValueTypes.OptionalOpaqueJobRef;
  readonly effectFinality: MediaComponentValueTypes.EffectFinality;
  readonly state: 'ready' | 'receiving' | 'interrupted' | 'outcome-unknown' | 'verifying' | 'quarantined' | 'rejected' | 'available';
  readonly variant: 'ready' | 'receiving' | 'interrupted' | 'outcome-unknown' | 'verifying' | 'quarantined' | 'rejected' | 'available';
  readonly actionIntents: readonly ('media.action.resume-artifact-upload')[];
  readonly keyboardBehavior: 'progress-and-recovery-actions-have-explicit-names-and-reasons';
}
export type ArtifactTransferStatusProps = ArtifactTransferStatusDefinitionProps & MediaComponentUiExtras;
export const ArtifactTransferStatus: React.FC<ArtifactTransferStatusProps> = defineFamily<ArtifactTransferStatusDefinitionProps>({
  id: 'media.component.artifact-transfer-status', title: 'Artifact Transfer Status',
  identityFields: ['uploadRef', 'verificationJobRef'] as const, collectionFields: ['chunkReceipts'] as const, statusFields: ['transferState', 'verificationJobRef', 'effectFinality'] as const,
  fieldDescriptions: {'chunkReceipts': 'Typed array of ChunkReceipt values.'},
});

export interface ArtifactIntegritySummaryDefinitionProps {
  readonly artifactVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
  readonly byteLength: MediaComponentValueTypes.NonnegativeInteger;
  readonly mediaType: MediaComponentValueTypes.IanaMediaType;
  readonly digest: MediaComponentValueTypes.DigestWithAlgorithm;
  readonly verificationEvidence: readonly (MediaComponentValueTypes.IntegrityEvidenceRef)[];
  readonly verificationState: 'not-run' | 'pending' | 'verified' | 'rejected' | 'unknown';
  readonly state: 'verifying' | 'available' | 'quarantined' | 'rejected' | 'metadata-incomplete';
  readonly variant: 'verifying' | 'available' | 'quarantined' | 'rejected' | 'metadata-incomplete';
  readonly actionIntents: readonly ('media.action.inspect-artifact' | 'media.action.attach-source-asset')[];
  readonly keyboardBehavior: 'integrity-details-and-project-attachment-are-separately-navigable';
}
export type ArtifactIntegritySummaryProps = ArtifactIntegritySummaryDefinitionProps & MediaComponentUiExtras;
export const ArtifactIntegritySummary: React.FC<ArtifactIntegritySummaryProps> = defineFamily<ArtifactIntegritySummaryDefinitionProps>({
  id: 'media.component.artifact-integrity-summary', title: 'Artifact Integrity Summary',
  identityFields: ['artifactVersionRef'] as const, collectionFields: ['verificationEvidence'] as const, statusFields: ['verificationEvidence', 'verificationState'] as const,
  fieldDescriptions: {'verificationEvidence': 'Typed array of IntegrityEvidenceRef values.', 'verificationState': 'Closed enum source values for Enum<not-run|pending|verified|rejected|unknown>.'},
});

export interface ArtifactBrowserDefinitionProps {
  readonly workspaceRef: MediaComponentValueTypes.TenantScopedWorkspaceRef;
  readonly projectRef?: MediaComponentValueTypes.OptionalOpaqueProjectRef;
  readonly query: MediaComponentValueTypes.ArtifactSearchQuery;
  readonly artifactVersions: readonly (MediaComponentValueTypes.ArtifactVersionSummary)[];
  readonly selectionState: 'loading' | 'populated' | 'empty' | 'no-results' | 'partial' | 'stale' | 'access-denied';
  readonly nextPageRef?: MediaComponentValueTypes.OptionalOpaqueCursor;
  readonly state: 'searching' | 'results-ready' | 'no-results' | 'stale-results' | 'access-denied' | 'refresh-failed';
  readonly variant: 'loading' | 'populated' | 'empty' | 'no-results' | 'stale-index' | 'access-denied' | 'metadata-incomplete';
  readonly actionIntents: readonly ('media.action.search-authorized-artifacts' | 'media.action.inspect-artifact' | 'media.action.select-authorized-reference')[];
  readonly keyboardBehavior: 'label search and filters; preserve focus through result updates; provide named row actions and keyboard selection without drag.';
}
export type ArtifactBrowserProps = ArtifactBrowserDefinitionProps & MediaComponentUiExtras;
export const ArtifactBrowser: React.FC<ArtifactBrowserProps> = defineFamily<ArtifactBrowserDefinitionProps>({
  id: 'media.component.artifact-browser', title: 'Artifact Browser',
  identityFields: ['workspaceRef', 'projectRef', 'nextPageRef'] as const, collectionFields: ['artifactVersions'] as const, statusFields: ['selectionState'] as const,
  fieldDescriptions: {'artifactVersions': 'Typed array of ArtifactVersionSummary values.', 'selectionState': 'Closed enum source values for Enum<loading|populated|empty|no-results|partial|stale|access-denied>.'},
});

export interface WaveformSpectrogramDefinitionProps {
  readonly sourceVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
  readonly sampleRateHz: MediaComponentValueTypes.PositiveRationalRate;
  readonly channelLayout: MediaComponentValueTypes.ExplicitChannelLayout;
  readonly timebaseRef: MediaComponentValueTypes.SourceSampleTimebaseRef;
  readonly windowDefinition: MediaComponentValueTypes.SpectralWindowDefinition;
  readonly observations: readonly (MediaComponentValueTypes.ScopedSignalObservation)[];
  readonly selectedRange?: MediaComponentValueTypes.OptionalHalfOpenRationalInterval;
  readonly state: 'not-loaded' | 'loading' | 'ready' | 'selection-active' | 'measurement-unavailable' | 'analysis-failed';
  readonly variant: 'waveform' | 'spectrogram' | 'loading' | 'no-analysis-data' | 'analysis-incomplete' | 'source-unavailable';
  readonly actionIntents: readonly ('media.action.select-source-time-interval' | 'media.action.inspect-source-measurements' | 'media.action.switch-measurement-presentation')[];
  readonly keyboardBehavior: 'Provide keyboard interval selection and numeric start/end entry; expose playhead and selection; never require drawing gestures.';
}
export type WaveformSpectrogramProps = WaveformSpectrogramDefinitionProps & MediaComponentUiExtras;
export const WaveformSpectrogram: React.FC<WaveformSpectrogramProps> = defineFamily<WaveformSpectrogramDefinitionProps>({
  id: 'media.component.waveform-spectrogram', title: 'Waveform Spectrogram',
  identityFields: ['sourceVersionRef', 'timebaseRef'] as const, collectionFields: ['observations'] as const, statusFields: [] as const,
  fieldDescriptions: {'observations': 'Typed array of ScopedSignalObservation values.'},
});

export interface StoryboardDefinitionProps {
  readonly compositionVersionRef: MediaComponentValueTypes.ExactCompositionVersionRef;
  readonly scenes: readonly (MediaComponentValueTypes.OrderedScene)[];
  readonly timebaseRef: MediaComponentValueTypes.CompositionTimebaseRef;
  readonly transitionSpecs: readonly (MediaComponentValueTypes.VersionedTransitionSpec)[];
  readonly validationDisposition: 'valid' | 'invalid' | 'needs-review' | 'unknown';
  readonly storyboardActionIntents: readonly (MediaComponentValueTypes.ActionIntentRef)[];
  readonly state: 'no-scenes' | 'editing' | 'review-required' | 'conflict' | 'saved' | 'read-only';
  readonly variant: 'empty' | 'draft' | 'ready-for-review' | 'partial-scenes' | 'reference-unavailable' | 'conflict' | 'read-only';
  readonly actionIntents: readonly ('media.action.add-storyboard-scene' | 'media.action.reorder-storyboard-scenes' | 'media.action.associate-authorized-reference' | 'media.action.review-scene-timing-and-transitions')[];
  readonly keyboardBehavior: 'Support add, remove, reorder, and select by keyboard with explicit move controls; maintain focus on the moved scene.';
}
export type StoryboardProps = StoryboardDefinitionProps & MediaComponentUiExtras;
export const Storyboard: React.FC<StoryboardProps> = defineFamily<StoryboardDefinitionProps>({
  id: 'media.component.storyboard', title: 'Storyboard',
  identityFields: ['compositionVersionRef', 'timebaseRef'] as const, collectionFields: ['scenes', 'transitionSpecs'] as const, statusFields: ['validationDisposition'] as const,
  fieldDescriptions: {'scenes': 'Typed array of OrderedScene values.', 'transitionSpecs': 'Typed array of VersionedTransitionSpec values.', 'validationDisposition': 'Closed enum source values for Enum<valid|invalid|needs-review|unknown>.', 'storyboardActionIntents': 'Typed array of ActionIntentRef values.'},
});

export interface TimelineKeyframeEditorDefinitionProps {
  readonly compositionVersionRef: MediaComponentValueTypes.ExactCompositionVersionRef;
  readonly timebaseRef: MediaComponentValueTypes.RationalTimelineTimebaseRef;
  readonly tracks: readonly (MediaComponentValueTypes.VersionedTrack)[];
  readonly keyframes: readonly (MediaComponentValueTypes.Keyframe)[];
  readonly selectionRange?: MediaComponentValueTypes.OptionalHalfOpenRationalInterval;
  readonly editConstraints: readonly (MediaComponentValueTypes.EditConstraint)[];
  readonly validationDisposition: 'valid' | 'invalid' | 'conflict' | 'unknown';
  readonly state: 'loading' | 'ready' | 'selection-active' | 'dirty' | 'saving' | 'saved' | 'conflict' | 'read-only';
  readonly variant: 'audio-video-timeline' | 'animation-timeline' | 'keyframe-curve-editor' | 'loading' | 'read-only' | 'version-conflict';
  readonly actionIntents: readonly ('media.action.select-track-or-region' | 'media.action.select-keyframe' | 'media.action.enter-exact-edit-constraints' | 'media.action.change-interpolation-curve' | 'media.action.undo-or-redo-versioned-change' | 'media.action.save-new-revision')[];
  readonly keyboardBehavior: 'Provide keyboard selection, trim, reorder, keyframe insertion/removal, and numeric time/value entry; expose visible focus and deterministic shortcuts.';
}
export type TimelineKeyframeEditorProps = TimelineKeyframeEditorDefinitionProps & MediaComponentUiExtras;
export const TimelineKeyframeEditor: React.FC<TimelineKeyframeEditorProps> = defineFamily<TimelineKeyframeEditorDefinitionProps>({
  id: 'media.component.timeline-keyframe-editor', title: 'Timeline Keyframe Editor',
  identityFields: ['compositionVersionRef', 'timebaseRef'] as const, collectionFields: ['tracks', 'keyframes', 'editConstraints'] as const, statusFields: ['selectionRange', 'validationDisposition'] as const,
  fieldDescriptions: {'tracks': 'Typed array of VersionedTrack values.', 'keyframes': 'Typed array of Keyframe values.', 'editConstraints': 'Typed array of EditConstraint values.', 'validationDisposition': 'Closed enum source values for Enum<valid|invalid|conflict|unknown>.'},
});

export interface AudioMixerDefinitionProps {
  readonly compositionVersionRef: MediaComponentValueTypes.ExactCompositionVersionRef;
  readonly tracks: readonly (MediaComponentValueTypes.AudioTrackBinding)[];
  readonly gainValues: readonly (MediaComponentValueTypes.UnitBearingAudioGain)[];
  readonly routing: readonly (MediaComponentValueTypes.ChannelRoutingBinding)[];
  readonly measurements: readonly (MediaComponentValueTypes.AudioMeasurement)[];
  readonly validationDisposition: 'valid' | 'clipping' | 'invalid' | 'unknown';
  readonly state: 'loading' | 'ready' | 'dirty' | 'clipping-observed' | 'saving' | 'saved' | 'conflict' | 'read-only';
  readonly variant: 'empty-session' | 'active-mix' | 'read-only' | 'clipping' | 'metering-unavailable' | 'version-conflict';
  readonly actionIntents: readonly ('media.action.edit-audio-mix-controls' | 'media.action.inspect-source-measurements' | 'media.action.review-processing-parameters' | 'media.action.save-new-revision')[];
  readonly keyboardBehavior: 'Every fader has numeric entry and increment controls; expose mute/solo, routing, and focus order without relying on pointer gestures.';
}
export type AudioMixerProps = AudioMixerDefinitionProps & MediaComponentUiExtras;
export const AudioMixer: React.FC<AudioMixerProps> = defineFamily<AudioMixerDefinitionProps>({
  id: 'media.component.audio-mixer', title: 'Audio Mixer',
  identityFields: ['compositionVersionRef'] as const, collectionFields: ['tracks', 'gainValues', 'routing', 'measurements'] as const, statusFields: ['validationDisposition'] as const,
  fieldDescriptions: {'tracks': 'Typed array of AudioTrackBinding values.', 'gainValues': 'Typed array of UnitBearingAudioGain values.', 'routing': 'Typed array of ChannelRoutingBinding values.', 'measurements': 'Typed array of AudioMeasurement values.', 'validationDisposition': 'Closed enum source values for Enum<valid|clipping|invalid|unknown>.'},
});

export interface MaskTrackingEditorDefinitionProps {
  readonly sourceVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
  readonly coordinateProfileRef: MediaComponentValueTypes.ImageCoordinateProfileRef;
  readonly masks: readonly (MediaComponentValueTypes.VersionedMask)[];
  readonly trackingEvidence: readonly (MediaComponentValueTypes.TrackingObservation)[];
  readonly propagationRange?: MediaComponentValueTypes.OptionalHalfOpenFrameInterval;
  readonly revisionState: 'draft' | 'valid' | 'invalid' | 'needs-review' | 'unknown';
  readonly state: 'not-loaded' | 'ready' | 'selection-active' | 'tracking-pending' | 'tracking-lost' | 'partial' | 'dirty' | 'conflict';
  readonly variant: 'static-mask' | 'tracked-mask' | 'point-track' | 'loading' | 'tracking-lost' | 'partial-track' | 'read-only';
  readonly actionIntents: readonly ('media.action.select-region-or-point' | 'media.action.edit-mask-boundary' | 'media.action.limit-tracking-propagation-range' | 'media.action.review-uncertain-tracking')[];
  readonly keyboardBehavior: 'Offer list-based region selection and numeric frame/range inputs; support keyboard point adjustments and undoable edits.';
}
export type MaskTrackingEditorProps = MaskTrackingEditorDefinitionProps & MediaComponentUiExtras;
export const MaskTrackingEditor: React.FC<MaskTrackingEditorProps> = defineFamily<MaskTrackingEditorDefinitionProps>({
  id: 'media.component.mask-tracking-editor', title: 'Mask Tracking Editor',
  identityFields: ['sourceVersionRef', 'coordinateProfileRef'] as const, collectionFields: ['masks', 'trackingEvidence'] as const, statusFields: ['revisionState'] as const,
  fieldDescriptions: {'masks': 'Typed array of VersionedMask values.', 'trackingEvidence': 'Typed array of TrackingObservation values.', 'revisionState': 'Closed enum source values for Enum<draft|valid|invalid|needs-review|unknown>.'},
});

export interface SceneInspectorDefinitionProps {
  readonly sceneVersionRef: MediaComponentValueTypes.ExactSceneVersionRef;
  readonly entityRefs: readonly (MediaComponentValueTypes.OpaqueSceneEntityRef)[];
  readonly transforms: readonly (MediaComponentValueTypes.TransformWithCoordinateProfile)[];
  readonly materialRefs: readonly (MediaComponentValueTypes.VersionedMaterialRef)[];
  readonly simulationBindings: readonly (MediaComponentValueTypes.QualifiedModelBinding)[];
  readonly validationDisposition: 'valid' | 'invalid' | 'unresolved' | 'unknown';
  readonly state: 'loading' | 'ready' | 'uncertain' | 'partial' | 'source-unavailable' | 'error';
  readonly variant: 'observed' | 'inferred' | 'generated-description' | 'partial' | 'unavailable' | 'read-only';
  readonly actionIntents: readonly ('media.action.inspect-source-grounded-observation' | 'media.action.seek-source' | 'media.action.inspect-quality-evidence')[];
  readonly keyboardBehavior: 'Navigate observations and source links in order; announce exact timecode; no hover-only evidence.';
}
export type SceneInspectorProps = SceneInspectorDefinitionProps & MediaComponentUiExtras;
export const SceneInspector: React.FC<SceneInspectorProps> = defineFamily<SceneInspectorDefinitionProps>({
  id: 'media.component.scene-inspector', title: 'Scene Inspector',
  identityFields: ['sceneVersionRef'] as const, collectionFields: ['entityRefs', 'transforms', 'materialRefs', 'simulationBindings'] as const, statusFields: ['validationDisposition'] as const,
  fieldDescriptions: {'entityRefs': 'Typed array of OpaqueSceneEntityRef values.', 'transforms': 'Typed array of TransformWithCoordinateProfile values.', 'materialRefs': 'Typed array of VersionedMaterialRef values.', 'simulationBindings': 'Typed array of QualifiedModelBinding values.', 'validationDisposition': 'Closed enum source values for Enum<valid|invalid|unresolved|unknown>.'},
});

export interface SimulationInstrumentsDefinitionProps {
  readonly modelVersionRef: MediaComponentValueTypes.ExactModelVersionRef;
  readonly runRef?: MediaComponentValueTypes.OptionalSimulationRunRef;
  readonly fidelityDefinitionRef: MediaComponentValueTypes.FidelityDefinitionRef;
  readonly observations: readonly (MediaComponentValueTypes.SimulationObservation)[];
  readonly runFinality: MediaComponentValueTypes.EffectFinality;
  readonly qualificationDisposition: MediaComponentValueTypes.QualificationDisposition;
  readonly state: 'unconfigured' | 'ready' | 'running' | 'partial' | 'completed' | 'outcome-unknown' | 'unqualified' | 'failed';
  readonly variant: 'configured' | 'running' | 'partial-output' | 'completed' | 'unqualified' | 'failed' | 'read-only';
  readonly actionIntents: readonly ('media.action.set-declared-simulation-input' | 'media.action.inspect-quality-evidence' | 'media.action.select-simulation-output-pass' | 'media.action.inspect-simulation-domain-and-fidelity' | 'media.action.open-qualification-evidence')[];
  readonly keyboardBehavior: 'All instruments support labeled numeric input and keyboard stepping; expose run and output controls; do not require direct manipulation.';
}
export type SimulationInstrumentsProps = SimulationInstrumentsDefinitionProps & MediaComponentUiExtras;
export const SimulationInstruments: React.FC<SimulationInstrumentsProps> = defineFamily<SimulationInstrumentsDefinitionProps>({
  id: 'media.component.simulation-instruments', title: 'Simulation Instruments',
  identityFields: ['modelVersionRef', 'runRef', 'fidelityDefinitionRef'] as const, collectionFields: ['observations'] as const, statusFields: ['runFinality', 'qualificationDisposition'] as const,
  fieldDescriptions: {'observations': 'Typed array of SimulationObservation values.'},
});

export interface ResultComparisonDefinitionProps {
  readonly leftVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
  readonly rightVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
  readonly comparisonBasis: MediaComponentValueTypes.ComparisonBasis;
  readonly alignedRange?: MediaComponentValueTypes.OptionalHalfOpenRationalInterval;
  readonly differences: readonly (MediaComponentValueTypes.ScopedDifference)[];
  readonly comparability: 'comparable' | 'incomparable' | 'partial' | 'unknown';
  readonly provenanceRefs: readonly (MediaComponentValueTypes.ProvenanceRef)[];
  readonly state: 'loading' | 'aligned' | 'alignment-pending' | 'partial' | 'measurement-unavailable' | 'error';
  readonly variant: 'before-after' | 'multi-candidate' | 'audio-a-b' | 'video-synchronized' | 'image-region' | 'alignment-unavailable';
  readonly actionIntents: readonly ('media.action.select-exact-candidates' | 'media.action.align-source-time-interval' | 'media.action.inspect-quality-evidence' | 'media.action.record-candidate-for-review')[];
  readonly keyboardBehavior: 'Provide candidate selection and synchronized playback controls through keyboard; include a list-based comparison summary.';
}
export type ResultComparisonProps = ResultComparisonDefinitionProps & MediaComponentUiExtras;
export const ResultComparison: React.FC<ResultComparisonProps> = defineFamily<ResultComparisonDefinitionProps>({
  id: 'media.component.result-comparison', title: 'Result Comparison',
  identityFields: ['leftVersionRef', 'rightVersionRef'] as const, collectionFields: ['differences', 'provenanceRefs'] as const, statusFields: ['comparability'] as const,
  fieldDescriptions: {'differences': 'Typed array of ScopedDifference values.', 'comparability': 'Closed enum source values for Enum<comparable|incomparable|partial|unknown>.', 'provenanceRefs': 'Typed array of ProvenanceRef values.'},
});

export interface QualityInspectorDefinitionProps {
  readonly targetVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
  readonly dimensionObservations: readonly (MediaComponentValueTypes.QualityObservation)[];
  readonly uncertainty: readonly (MediaComponentValueTypes.UncertaintyInterval)[];
  readonly thresholds: readonly (MediaComponentValueTypes.ScopedAcceptanceThreshold)[];
  readonly reviewState: 'not-evaluated' | 'pending-review' | 'accepted' | 'rejected' | 'inferred';
  readonly evidenceRefs: readonly (MediaComponentValueTypes.EvidenceRef)[];
  readonly state: 'loading' | 'complete' | 'partial' | 'not-assessed' | 'unavailable' | 'conflict';
  readonly variant: 'measured' | 'partially-measured' | 'not-assessed' | 'unavailable' | 'conflicting-evidence' | 'recommendation-only';
  readonly actionIntents: readonly ('media.action.inspect-quality-evidence' | 'media.action.review-bounded-repair-proposal' | 'media.action.compare-candidate-on-metric')[];
  readonly keyboardBehavior: 'Metric rows and evidence disclosures are keyboard-operable; retain focus when filters or dimensions change.';
}
export type QualityInspectorProps = QualityInspectorDefinitionProps & MediaComponentUiExtras;
export const QualityInspector: React.FC<QualityInspectorProps> = defineFamily<QualityInspectorDefinitionProps>({
  id: 'media.component.quality-inspector', title: 'Quality Inspector',
  identityFields: ['targetVersionRef'] as const, collectionFields: ['dimensionObservations', 'uncertainty', 'thresholds', 'evidenceRefs'] as const, statusFields: ['uncertainty', 'reviewState'] as const,
  fieldDescriptions: {'dimensionObservations': 'Typed array of QualityObservation values.', 'uncertainty': 'Typed array of UncertaintyInterval values.', 'thresholds': 'Typed array of ScopedAcceptanceThreshold values.', 'reviewState': 'Closed enum source values for Enum<not-evaluated|pending-review|accepted|rejected|inferred>.', 'evidenceRefs': 'Typed array of EvidenceRef values.'},
});

export interface DeliveryProfilePickerDefinitionProps {
  readonly outputVersionRef: MediaComponentValueTypes.ExactArtifactVersionRef;
  readonly destinationRef: MediaComponentValueTypes.AuthorizedDestinationRef;
  readonly profileRef: MediaComponentValueTypes.VersionedDeliveryProfileRef;
  readonly compatibilityEvidence: MediaComponentValueTypes.CompatibilityEvidence;
  readonly fallbackPlan: MediaComponentValueTypes.ExplicitFallbackPlan;
  readonly rightsAndApprovalRefs: readonly (MediaComponentValueTypes.ScopedDecisionRef)[];
  readonly deliveryFinality: MediaComponentValueTypes.EffectFinality;
  readonly state: 'loading' | 'choices-ready' | 'validation-pending' | 'valid' | 'invalid' | 'unavailable';
  readonly variant: 'available' | 'incompatible' | 'requires-validation' | 'partially-compatible' | 'deprecated' | 'unavailable';
  readonly actionIntents: readonly ('media.action.select-eligible-processing-profile' | 'media.action.inspect-effective-processing-constraints' | 'media.action.validate-processing-profile')[];
  readonly keyboardBehavior: 'Use named single-choice controls and a separately keyboard-operable validation action; preserve selection when details expand.';
}
export type DeliveryProfilePickerProps = DeliveryProfilePickerDefinitionProps & MediaComponentUiExtras;
export const DeliveryProfilePicker: React.FC<DeliveryProfilePickerProps> = defineFamily<DeliveryProfilePickerDefinitionProps>({
  id: 'media.component.delivery-profile-picker', title: 'Delivery Profile Picker',
  identityFields: ['outputVersionRef', 'destinationRef', 'profileRef'] as const, collectionFields: ['rightsAndApprovalRefs'] as const, statusFields: ['compatibilityEvidence', 'deliveryFinality'] as const,
  fieldDescriptions: {'rightsAndApprovalRefs': 'Typed array of ScopedDecisionRef values.'},
});

export interface RightsRetentionReviewDefinitionProps {
  readonly subjectVersionRef: MediaComponentValueTypes.ExactSubjectVersionRef;
  readonly authorityRef: MediaComponentValueTypes.CurrentAuthorityRef;
  readonly rightOrConsent: MediaComponentValueTypes.RightsConsentType;
  readonly scope: MediaComponentValueTypes.RightsConsentScope;
  readonly validity: MediaComponentValueTypes.ConsentValidity;
  readonly retentionDisposition: MediaComponentValueTypes.RetentionDecision;
  readonly decisionHistory: readonly (MediaComponentValueTypes.VersionedDecisionRef)[];
  readonly nextActions: readonly (MediaComponentValueTypes.ActionIntentRef)[];
  readonly state: 'loading' | 'permitted-with-scope' | 'denied' | 'unknown' | 'expired' | 'revoked' | 'review-required';
  readonly variant: 'permitted' | 'denied' | 'unknown' | 'expired' | 'revoked' | 'review-required' | 'evidence-unavailable';
  readonly actionIntents: readonly ('media.action.inspect-governing-evidence' | 'media.action.request-authorized-review' | 'media.action.continue-within-recorded-scope')[];
  readonly keyboardBehavior: 'Evidence and disposition disclosures are keyboard-operable; keep review action separate from evidence inspection.';
}
export type RightsRetentionReviewProps = RightsRetentionReviewDefinitionProps & MediaComponentUiExtras;
export const RightsRetentionReview: React.FC<RightsRetentionReviewProps> = defineFamily<RightsRetentionReviewDefinitionProps>({
  id: 'media.component.rights-retention-review', title: 'Rights Retention Review',
  identityFields: ['subjectVersionRef', 'authorityRef'] as const, collectionFields: ['decisionHistory', 'nextActions'] as const, statusFields: ['rightOrConsent', 'validity', 'retentionDisposition'] as const,
  fieldDescriptions: {'decisionHistory': 'Typed array of VersionedDecisionRef values.', 'nextActions': 'Typed array of ActionIntentRef values.'},
});

export interface ActivityRecoveryFeedDefinitionProps {
  readonly activityRecords: readonly (MediaComponentValueTypes.JobActivityRecord)[];
  readonly freshness: MediaComponentValueTypes.ObservationFreshness;
  readonly availableEvidence: readonly (MediaComponentValueTypes.OutcomeEvidenceRef)[];
  readonly safeNextActions: readonly (MediaComponentValueTypes.ActionIntentRef)[];
  readonly collectionState: 'loading' | 'populated' | 'empty' | 'partial' | 'stale' | 'offline' | 'access-denied';
  readonly state: 'loading' | 'current' | 'stale' | 'partial' | 'no-results' | 'unknown-outcome' | 'recovery-pending';
  readonly variant: 'loading' | 'populated' | 'empty' | 'stale' | 'partial-history' | 'outcome-unknown' | 'access-limited';
  readonly actionIntents: readonly ('media.action.view-job-status' | 'media.action.request-cancellation' | 'media.action.check-job-outcome' | 'media.action.resume-artifact-upload')[];
  readonly keyboardBehavior: 'Use a semantic ordered activity list with named actions; preserve focus during refresh; never require drag or hover.';
}
export type ActivityRecoveryFeedProps = ActivityRecoveryFeedDefinitionProps & MediaComponentUiExtras;
export const ActivityRecoveryFeed: React.FC<ActivityRecoveryFeedProps> = defineFamily<ActivityRecoveryFeedDefinitionProps>({
  id: 'media.component.activity-recovery-feed', title: 'Activity Recovery Feed',
  identityFields: [] as const, collectionFields: ['activityRecords', 'availableEvidence', 'safeNextActions'] as const, statusFields: ['freshness', 'collectionState'] as const,
  fieldDescriptions: {'activityRecords': 'Typed array of JobActivityRecord values.', 'availableEvidence': 'Typed array of OutcomeEvidenceRef values.', 'safeNextActions': 'Typed array of ActionIntentRef values.', 'collectionState': 'Closed enum source values for Enum<loading|populated|empty|partial|stale|offline|access-denied>.'},
});

export interface CliOutputDefinitionProps {
  readonly commandId: MediaComponentValueTypes.CanonicalCommandId;
  readonly requestRef: MediaComponentValueTypes.OpaqueRequestRef;
  readonly operationState: MediaComponentValueTypes.CanonicalOperationState;
  readonly effectFinality: MediaComponentValueTypes.EffectFinality;
  readonly resultRefs: readonly (MediaComponentValueTypes.ExactResultReference)[];
  readonly reasonAndEvidence: readonly (MediaComponentValueTypes.ReasonEvidence)[];
  readonly exitDisposition: MediaComponentValueTypes.TypedExitDisposition;
  readonly machineProjection?: MediaComponentValueTypes.OptionalTypedMachineResult;
  readonly state: 'completed' | 'pending' | 'unknown' | 'blocked' | 'failed' | 'invalid-input' | 'access-denied';
  readonly variant: 'success' | 'partial' | 'pending' | 'outcome-unknown' | 'blocked' | 'invalid-input' | 'access-denied';
  readonly actionIntents: readonly ('media.action.view-job-status' | 'media.action.request-cancellation' | 'media.action.check-job-outcome' | 'media.action.resume-artifact-upload' | 'media.action.inspect-artifact')[];
  readonly keyboardBehavior: 'Standard terminal navigation; support --help and structured output without prompts in machine mode; interactive confirmation must be explicit and avoid secret echo.';
}
export type CliOutputProps = CliOutputDefinitionProps & MediaComponentUiExtras;
export const CliOutput: React.FC<CliOutputProps> = defineFamily<CliOutputDefinitionProps>({
  id: 'media.component.cli-output', title: 'Cli Output',
  identityFields: ['commandId', 'requestRef'] as const, collectionFields: ['resultRefs', 'reasonAndEvidence'] as const, statusFields: ['operationState', 'effectFinality', 'exitDisposition'] as const,
  fieldDescriptions: {'resultRefs': 'Typed array of ExactResultReference values.', 'reasonAndEvidence': 'Typed array of ReasonEvidence values.'},
});
