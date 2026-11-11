import React from "react";
import type { CaptionVersionRegistered, CaptionVersionTransport } from "@audio-video/client/caption-version";
import { MediaTaskScreen, type MediaScreenAction, type MediaTaskScreenProps } from "./MediaTaskScreen";
import type { MediaActionDispatchContext, MediaActionDispatchResult } from "../ports";
import { createMediaActionDispatchGuard } from "./MediaActionDispatchGuard";
import {
  bindCaptionVersionRows,
  captionVersionReadScopeKey,
  hasValidCaptionVersionReadScope,
  type CaptionVersionReadScope,
} from "./captionVersionReadBinding";

export type TranscriptCaptionView = "select-source" | "monitor-transcription" | "review-transcript" | "correct-captions" | "compare-caption-versions";

export interface TranscriptCaptionProjection {
  readonly view: TranscriptCaptionView;
  /** Exact source identifiers for authenticated caption-version reads. */
  readonly sourceArtifactId?: string;
  readonly sourceArtifactVersionId?: string;
  /** Exact typed parent and session-local draft revision required for edit dispatch. */
  readonly parentVersionKind?: "TRANSCRIPT_VERSION" | "CAPTION_VERSION";
  readonly parentVersionId?: string;
  readonly captionDraftRevision?: number;
  readonly sourceArtifactVersion?: string;
  readonly sourceTime?: string;
  readonly language?: string;
  readonly jobId?: string;
  readonly clockId?: string;
  readonly durationTicks?: number;
  readonly ticksPerSecond?: number;
  readonly transcriptVersion?: string;
  readonly captionDraftVersion?: string;
  readonly versionPurpose?: string;
  readonly sourceChoices?: readonly { readonly artifactVersion: string; readonly label: string; readonly availability?: string }[];
  readonly leftCompareVersionId?: string;
  readonly rightCompareVersionId?: string;
  readonly segments?: readonly {
    readonly id: string;
    readonly startTime: string;
    readonly endTime: string;
    readonly startTick?: number | null;
    readonly endTick?: number | null;
    readonly text: string;
    readonly confidence?: string;
    readonly provenance?: string;
  }[];
  readonly versions?: readonly { readonly id: string; readonly label: string; readonly createdAt?: string }[];
  readonly message?: string;
}

export interface TranscriptCaptionScreenProps extends Omit<MediaTaskScreenProps, "children"> {
  readonly transcript: TranscriptCaptionProjection;
  /**
   * Optional host-injected authenticated reader. Presence means the host has
   * admitted this exact read route; Media still derives caller authority from
   * the supplied transport credential.
   */
  readonly canonicalCaptionVersionReader?: CanonicalCaptionVersionReadCapability;
  /** Host projection callbacks retain the draft values until an explicit version save. */
  readonly onCaptionEdit?: (segmentId: string, text: string) => void;
  readonly onCaptionTimingDraftChange?: (segmentId: string, field: "startTick" | "endTick", value: number | null) => void;
  readonly onVersionPurposeChange?: (purpose: string) => void;
  readonly onCompareVersionSelection?: (side: "left" | "right", versionId: string) => void;
}

/**
 * Host identities in this capability are exact scope hints. The canonical
 * HTTP endpoint still derives tenant/principal authority from its credential.
 */
export interface CanonicalCaptionVersionReadCapability {
  readonly runtimeAdmission: "ADMITTED";
  readonly tenantId: string;
  readonly principalId: string;
  readonly sourceArtifactId: string;
  readonly sourceArtifactVersionId: string;
  readonly transport: Pick<CaptionVersionTransport, "versions">;
}

/** Preserve the host's action scope while binding the exact displayed versions to an edit. */
export function transcriptActionContext(
  action: MediaScreenAction | undefined,
  exactSubjectRefs: readonly (string | undefined)[] = [],
): MediaActionDispatchContext {
  return {
    subjectRefs: [...new Set([
      ...(action?.subjectRefs ?? []),
      ...exactSubjectRefs.filter((ref): ref is string => typeof ref === "string" && ref.trim().length > 0),
    ])],
  };
}

/** J-03 timing edits require a declared source clock and a valid half-open tick range. */
export function hasAdmissibleCaptionTimingRange(
  transcript: Pick<TranscriptCaptionProjection, "clockId" | "ticksPerSecond" | "durationTicks">,
  startTick: number | null | undefined,
  endTick: number | null | undefined,
): boolean {
  return typeof transcript.clockId === "string" && transcript.clockId.trim().length > 0
    && Number.isSafeInteger(transcript.ticksPerSecond) && (transcript.ticksPerSecond ?? 0) > 0
    && Number.isSafeInteger(transcript.durationTicks) && (transcript.durationTicks ?? -1) >= 0
    && Number.isSafeInteger(startTick) && (startTick ?? -1) >= 0
    && Number.isSafeInteger(endTick) && (endTick ?? -1) > (startTick ?? Number.MAX_SAFE_INTEGER)
    && (endTick ?? Number.MAX_SAFE_INTEGER) <= (transcript.durationTicks ?? -1);
}

/** J-03 edits must be bound to one exact source, typed parent, and draft revision. */
export function hasExactCaptionDraftIdentity(
  transcript: Pick<TranscriptCaptionProjection,
    "sourceArtifactId" | "sourceArtifactVersionId" | "parentVersionKind" | "parentVersionId" | "captionDraftVersion" | "captionDraftRevision">,
): boolean {
  return [transcript.sourceArtifactId, transcript.sourceArtifactVersionId, transcript.parentVersionId, transcript.captionDraftVersion]
    .every((value) => typeof value === "string" && value.trim().length > 0)
    && (transcript.parentVersionKind === "TRANSCRIPT_VERSION" || transcript.parentVersionKind === "CAPTION_VERSION")
    && Number.isSafeInteger(transcript.captionDraftRevision)
    && (transcript.captionDraftRevision ?? -1) >= 0;
}

function dispatchMessage(result: MediaActionDispatchResult): string {
  switch (result.status) {
    case "failed":
    case "denied":
    case "unavailable":
      return `${result.status}: ${result.reason}`;
    case "local-applied":
      return "The source-defined draft change was applied locally; no remote effect is implied.";
    case "intent-accepted":
      return "The action intent was accepted; no domain effect is confirmed.";
    case "request-started":
    case "request-acknowledged":
      return `Request acknowledged (${result.requestId}); completion remains unobserved.`;
  }
}

/** Candidate J-03 body for source selection, transcript review, caption correction and version comparison. */
export function TranscriptCaptionScreen({
  transcript, onCaptionEdit, onCaptionTimingDraftChange, onVersionPurposeChange,
  onCompareVersionSelection, canonicalCaptionVersionReader,
  actions = [], nextSafeActionIds = [], actionPort, ...flow
}: TranscriptCaptionScreenProps): React.ReactElement {
  const [payloadActionStatus, setPayloadActionStatus] = React.useState<string | undefined>();
  const [pendingPayloadAction, setPendingPayloadAction] = React.useState<string | undefined>();
  const readerScope: CaptionVersionReadScope | undefined = canonicalCaptionVersionReader
    ? {
      tenantId: canonicalCaptionVersionReader.tenantId,
      principalId: canonicalCaptionVersionReader.principalId,
      sourceArtifactId: canonicalCaptionVersionReader.sourceArtifactId,
      sourceArtifactVersionId: canonicalCaptionVersionReader.sourceArtifactVersionId,
    }
    : undefined;
  const readerScopeKey = readerScope ? captionVersionReadScopeKey(readerScope) : undefined;
  const readerScopeMatchesProjection = Boolean(readerScope
    && transcript.sourceArtifactId === readerScope.sourceArtifactId
    && transcript.sourceArtifactVersionId === readerScope.sourceArtifactVersionId);
  const readerScopeIsValid = Boolean(readerScope && readerScopeMatchesProjection && hasValidCaptionVersionReadScope(readerScope));
  type CanonicalVersionReadState =
    | { readonly state: "LOADING" }
    | { readonly state: "DENIED" }
    | { readonly state: "UNKNOWN" }
    | { readonly state: "OBSERVED"; readonly rows: readonly CaptionVersionRegistered[] };
  const [versionReadRecord, setVersionReadRecord] = React.useState<{
    readonly scopeKey: string;
    readonly value: CanonicalVersionReadState;
  } | undefined>();
  const [versionReadRefresh, setVersionReadRefresh] = React.useState(0);
  const canonicalVersionRead = readerScopeKey && versionReadRecord?.scopeKey === readerScopeKey
    ? versionReadRecord.value
    : undefined;
  React.useEffect(() => {
    if (transcript.view !== "compare-caption-versions" || !readerScope || !readerScopeKey || !readerScopeIsValid
      || canonicalCaptionVersionReader?.runtimeAdmission !== "ADMITTED") return;
    let active = true;
    const controller = new AbortController();
    setVersionReadRecord({ scopeKey: readerScopeKey, value: { state: "LOADING" } });
    void canonicalCaptionVersionReader.transport.versions(
      readerScope.tenantId,
      readerScope.principalId,
      readerScope.sourceArtifactId,
      readerScope.sourceArtifactVersionId,
      controller.signal,
    ).then((result) => {
      if (!active) return;
      const rows = bindCaptionVersionRows(result, readerScope);
      setVersionReadRecord({ scopeKey: readerScopeKey, value: rows === undefined
        ? { state: "UNKNOWN" }
        : { state: "OBSERVED", rows } });
    }).catch((error: unknown) => {
      if (!active) return;
      const statusCode = error && typeof error === "object"
        ? "status" in error
          ? (error as { readonly status?: unknown }).status
          : "statusCode" in error
            ? (error as { readonly statusCode?: unknown }).statusCode
            : undefined
        : undefined;
      setVersionReadRecord({ scopeKey: readerScopeKey, value: statusCode === 401 || statusCode === 403
        ? { state: "DENIED" }
        : { state: "UNKNOWN" } });
    });
    return () => {
      active = false;
      controller.abort();
    };
  }, [
    transcript.view,
    readerScopeKey,
    canonicalCaptionVersionReader?.runtimeAdmission,
    canonicalCaptionVersionReader?.transport,
    readerScope?.tenantId,
    readerScope?.principalId,
    readerScope?.sourceArtifactId,
    readerScope?.sourceArtifactVersionId,
    readerScopeIsValid,
    versionReadRefresh,
  ]);
  const [, refreshDispatchState] = React.useState(0);
  const actionPortRef = React.useRef(actionPort);
  actionPortRef.current = actionPort;
  const dispatchGuardRef = React.useRef<ReturnType<typeof createMediaActionDispatchGuard> | undefined>(undefined);
  if (!dispatchGuardRef.current) {
    dispatchGuardRef.current = createMediaActionDispatchGuard({
      invoke: (actionId, payload, context) => actionPortRef.current.invoke(actionId, payload, context),
    }, () => refreshDispatchState((version) => version + 1));
  }
  const dispatchGuard = dispatchGuardRef.current;
  React.useEffect(() => {
    dispatchGuard.observeReconciliations(flow.data.actionReconciliations ?? []);
  }, [dispatchGuard, flow.data.actionReconciliations]);
  const guardedActionPort = dispatchGuard.actionPort;
  const heading = {
    "select-source": "Select a source recording",
    "monitor-transcription": "Transcription status",
    "review-transcript": "Review transcript",
    "correct-captions": "Correct captions",
    "compare-caption-versions": "Compare caption versions",
  }[transcript.view];
  const exactDraftIdentityAvailable = hasExactCaptionDraftIdentity(transcript);
  const exactDraftActionIds = new Set([
    "media.action.correct-caption", "media.action.align-caption-timing", "media.action.save-caption-version",
  ]);
  const availableActions = new Map(actions.map((action) => [action.id, dispatchGuard.isInFlight(action.id)
    ? { ...action, enabled: false, disabledReason: "This action awaits exact owner reconciliation before retry." }
    : exactDraftActionIds.has(action.id) && !exactDraftIdentityAvailable
      ? { ...action, enabled: false, disabledReason: "Exact source, typed parent, and caption draft revision are required before editing or saving." }
      : action]));
  const correctAction = availableActions.get("media.action.correct-caption");
  const canCorrect = correctAction?.enabled === true;
  const alignAction = availableActions.get("media.action.align-caption-timing");
  const saveAction = availableActions.get("media.action.save-caption-version");
  const compareAction = availableActions.get("media.action.compare-caption-versions");
  const canonicalVersionsAvailable = canonicalCaptionVersionReader !== undefined;
  const canonicalVersionReadDisposition = canonicalVersionsAvailable
    ? readerScopeIsValid
      ? canonicalVersionRead?.state ?? "UNKNOWN"
      : "UNKNOWN"
    : undefined;
  const displayedVersions = canonicalVersionsAvailable
    ? readerScopeIsValid && canonicalVersionRead?.state === "OBSERVED"
      ? canonicalVersionRead.rows.map((version) => ({
        id: version.captionVersionId,
        label: version.captionVersionId,
        createdAt: String(version.registeredAt),
      }))
      : []
    : transcript.versions ?? [];
  const availableCaptionVersionIds = new Set(displayedVersions.map((version) => version.id));
  const leftCompareVersionId = transcript.leftCompareVersionId;
  const rightCompareVersionId = transcript.rightCompareVersionId;
  const comparePairIsDistinct = Boolean(leftCompareVersionId && rightCompareVersionId
    && leftCompareVersionId !== rightCompareVersionId);
  const comparePairIsAvailable = Boolean(leftCompareVersionId && rightCompareVersionId
    && availableCaptionVersionIds.has(leftCompareVersionId)
    && availableCaptionVersionIds.has(rightCompareVersionId));
  const canCompareSelectedPair = comparePairIsDistinct && comparePairIsAvailable;
  const comparePairMessage = !leftCompareVersionId || !rightCompareVersionId
    ? undefined
    : !comparePairIsDistinct
      ? "Choose two distinct caption versions to compare."
      : !comparePairIsAvailable
        ? "Both selected caption versions must be available in this source projection."
        : undefined;
  const payloadActions = new Set(["media.action.correct-caption", "media.action.align-caption-timing", "media.action.save-caption-version", "media.action.compare-caption-versions"]);
  const flowActions = actions.filter((action) => !payloadActions.has(action.id));
  const flowSafeActionIds = nextSafeActionIds.filter((id) => !payloadActions.has(id));
  const transcriptSubjectRefs = [
    transcript.sourceArtifactId && `source-artifact:${transcript.sourceArtifactId}`,
    transcript.sourceArtifactVersionId && `source-version:${transcript.sourceArtifactVersionId}`,
    transcript.parentVersionKind && transcript.parentVersionId
      && `parent:${transcript.parentVersionKind}:${transcript.parentVersionId}`,
    transcript.captionDraftVersion && `caption-draft:${transcript.captionDraftVersion}`,
    Number.isSafeInteger(transcript.captionDraftRevision)
      ? `caption-draft-revision:${transcript.captionDraftRevision}`
      : undefined,
  ];
  const invokePayloadAction = (
    actionId: string,
    payload: Readonly<Record<string, string | number | boolean | null>>,
    exactSubjectRefs: readonly (string | undefined)[] = transcriptSubjectRefs,
  ): void => {
    const action = availableActions.get(actionId);
    if (!action?.enabled || pendingPayloadAction !== undefined) return;
    setPendingPayloadAction(actionId);
    setPayloadActionStatus("Request submitted; completion remains unknown until a fresh owner projection arrives.");
    void (async () => {
      try {
        const result = await guardedActionPort.invoke(
          actionId,
          payload,
          transcriptActionContext(action, exactSubjectRefs),
        );
        setPayloadActionStatus(dispatchMessage(result));
      } catch {
        setPayloadActionStatus("Request outcome is unknown. Reconcile this same source and version before retrying.");
      } finally {
        setPendingPayloadAction(undefined);
      }
    })();
  };

  return <MediaTaskScreen {...flow} actions={flowActions} nextSafeActionIds={flowSafeActionIds} actionPort={guardedActionPort}>
    <section className="media-screen-body" aria-labelledby="transcript-caption-title">
      <header>
        <h3 id="transcript-caption-title">{heading}</h3>
        {transcript.message && <p>{transcript.message}</p>}
      </header>
      <dl>
        {transcript.sourceArtifactVersion && <div><dt>Source artifact version</dt><dd><code>{transcript.sourceArtifactVersion}</code></dd></div>}
        {transcript.sourceTime && <div><dt>Source time</dt><dd>{transcript.sourceTime}</dd></div>}
        {transcript.language && <div><dt>Language</dt><dd>{transcript.language}</dd></div>}
        {transcript.jobId && <div><dt>Transcription job</dt><dd><code>{transcript.jobId}</code></dd></div>}
        {transcript.clockId && <div><dt>Source media clock</dt><dd><code>{transcript.clockId}</code></dd></div>}
        {transcript.ticksPerSecond !== undefined && <div><dt>Ticks per second</dt><dd>{transcript.ticksPerSecond}</dd></div>}
        {transcript.transcriptVersion && <div><dt>Transcript version</dt><dd><code>{transcript.transcriptVersion}</code></dd></div>}
        {transcript.captionDraftVersion && <div><dt>Caption draft</dt><dd><code>{transcript.captionDraftVersion}</code></dd></div>}
      </dl>
      {transcript.view === "select-source" && transcript.sourceChoices?.length ? <section aria-labelledby="transcript-source-choices-title">
        <h4 id="transcript-source-choices-title">Available source versions</h4>
        <ul aria-label="Available source recordings">
          {transcript.sourceChoices.map((source) => <li key={source.artifactVersion}>
            <p>{source.label}</p>
            <p><code>{source.artifactVersion}</code>{source.availability ? ` · ${source.availability}` : ""}</p>
            <button type="button" className="media-action-button media-action-button--primary" disabled={!availableActions.get("media.action.choose-source")?.enabled || pendingPayloadAction !== undefined}
              onClick={() => invokePayloadAction("media.action.choose-source", { artifactVersion: source.artifactVersion }, [source.artifactVersion])}>Select this source</button>
          </li>)}
        </ul>
      </section> : null}
      {transcript.view === "correct-captions" ? <ol aria-label="Caption segments">
        {transcript.segments?.map((segment) => <li key={segment.id}>
          <p>{segment.startTime}–{segment.endTime} · Segment {segment.id}</p>
          <label htmlFor={`caption-${segment.id}`}>Caption text for segment {segment.id}</label>
          <textarea id={`caption-${segment.id}`} className="media-input" value={segment.text} disabled={!onCaptionEdit || !canCorrect}
            onChange={(event) => onCaptionEdit?.(segment.id, event.currentTarget.value)} rows={2} />
          <button type="button" className="media-action-button media-action-button--primary" disabled={!onCaptionEdit || !canCorrect || pendingPayloadAction !== undefined} onClick={() => {
            if (onCaptionEdit) {
              invokePayloadAction("media.action.correct-caption", { segmentId: segment.id, text: segment.text });
            }
          }}>Apply caption correction</button>
          {correctAction?.disabledReason && <p>{correctAction.disabledReason}</p>}
          <p>{[segment.confidence, segment.provenance].filter(Boolean).join(" · ")}</p>
          <fieldset disabled={!onCaptionTimingDraftChange || !alignAction?.enabled}>
            <legend>Timing in source clock ticks ({transcript.clockId ?? "clock not identified"})</legend>
            <label htmlFor={`caption-start-${segment.id}`}>Start tick</label>
            <input id={`caption-start-${segment.id}`} className="media-input" type="number" min={0} max={transcript.durationTicks} step={1}
              value={segment.startTick ?? ""} onChange={(event) => onCaptionTimingDraftChange?.(segment.id, "startTick", event.currentTarget.value === "" ? null : Number(event.currentTarget.value))} />
            <label htmlFor={`caption-end-${segment.id}`}>End tick</label>
            <input id={`caption-end-${segment.id}`} className="media-input" type="number" min={0} max={transcript.durationTicks} step={1}
              value={segment.endTick ?? ""} onChange={(event) => onCaptionTimingDraftChange?.(segment.id, "endTick", event.currentTarget.value === "" ? null : Number(event.currentTarget.value))} />
            <button type="button" className="media-action-button media-action-button--primary" disabled={!alignAction?.enabled || !hasAdmissibleCaptionTimingRange(transcript, segment.startTick, segment.endTick) || pendingPayloadAction !== undefined}
              onClick={() => {
                if (typeof segment.startTick === "number" && typeof segment.endTick === "number"
                  && hasAdmissibleCaptionTimingRange(transcript, segment.startTick, segment.endTick)) {
                  invokePayloadAction("media.action.align-caption-timing", {
                    segmentId: segment.id, startTick: segment.startTick, endTick: segment.endTick,
                  });
                }
              }}>{alignAction?.label ?? "Apply timing alignment"}</button>
            {alignAction?.enabled && !hasAdmissibleCaptionTimingRange(transcript, segment.startTick, segment.endTick)
              && <p role="status">Timing alignment needs a source clock, tick rate, duration, and valid in-range start and end ticks.</p>}
            {alignAction?.disabledReason && <p>{alignAction.disabledReason}</p>}
          </fieldset>
        </li>)}
      </ol> : transcript.segments?.length ? <ol aria-label="Transcript segments">
        {transcript.segments.map((segment) => <li key={segment.id}>
          <p>{segment.startTime}–{segment.endTime} · Segment {segment.id}</p>
          <p>{segment.text}</p>
          <p>{[segment.confidence, segment.provenance].filter(Boolean).join(" · ")}</p>
        </li>)}
      </ol> : null}
      {transcript.view === "compare-caption-versions" && <p role="status" aria-live="polite" data-state={canonicalVersionReadDisposition?.toLowerCase() ?? "host-projected"}>
        {!canonicalVersionsAvailable
          ? "No canonical caption-version reader was supplied. Listed choices are host-projected and have not been refreshed here."
          : !readerScope
            ? "Canonical caption-version list is unknown because exact source artifact identity is unavailable."
            : !readerScopeIsValid
              ? "Canonical caption-version list is unknown because reader scope does not match the displayed source identity."
            : canonicalVersionRead?.state === "LOADING"
              ? "Loading caption versions for this exact source artifact version…"
              : canonicalVersionRead?.state === "DENIED"
                ? "Canonical caption-version read was denied. No version choices are disclosed."
                : canonicalVersionRead?.state === "UNKNOWN"
                  ? "Canonical caption-version list is unknown. Reconcile this source version before comparing."
                  : canonicalVersionRead?.state === "OBSERVED"
                    ? canonicalVersionRead.rows.length === 0
                      ? "No canonical caption versions are registered for this source version."
                      : `${canonicalVersionRead.rows.length} canonical caption version(s) observed for this source version.`
                    : "Canonical caption-version list is not yet observed."}
      </p>}
      {transcript.view === "compare-caption-versions" && canonicalVersionsAvailable && <button
        type="button"
        className="media-action-button"
        disabled={!readerScopeIsValid || canonicalVersionRead?.state === "LOADING"}
        onClick={() => setVersionReadRefresh((revision) => revision + 1)}
      >Refresh canonical versions</button>}
      {transcript.view === "compare-caption-versions" && <ul aria-label="Caption versions">
        {displayedVersions.map((version) => <li key={version.id}><p>{version.label}</p><p><code>{version.id}</code>{version.createdAt ? ` · ${version.createdAt}` : ""}</p></li>)}
      </ul>}
      {transcript.view === "compare-caption-versions" && <fieldset>
        <legend>Choose versions to compare</legend>
        <label htmlFor="caption-version-left">Earlier or source version</label>
        <select id="caption-version-left" className="media-input" value={transcript.leftCompareVersionId ?? ""}
          disabled={!onCompareVersionSelection || !compareAction?.enabled}
          onChange={(event) => onCompareVersionSelection?.("left", event.currentTarget.value)}>
          <option value="">Choose a version</option>
          {displayedVersions.map((version) => <option key={version.id} value={version.id}>{version.label} — {version.id}</option>)}
        </select>
        <label htmlFor="caption-version-right">Other version</label>
        <select id="caption-version-right" className="media-input" value={transcript.rightCompareVersionId ?? ""}
          disabled={!onCompareVersionSelection || !compareAction?.enabled}
          onChange={(event) => onCompareVersionSelection?.("right", event.currentTarget.value)}>
          <option value="">Choose a version</option>
          {displayedVersions.map((version) => <option key={version.id} value={version.id}>{version.label} — {version.id}</option>)}
        </select>
        <button type="button" className="media-action-button media-action-button--primary" disabled={!compareAction?.enabled || !canCompareSelectedPair || pendingPayloadAction !== undefined}
          onClick={() => {
            if (canCompareSelectedPair && leftCompareVersionId && rightCompareVersionId) {
              invokePayloadAction("media.action.compare-caption-versions", {
                leftVersionId: leftCompareVersionId,
                rightVersionId: rightCompareVersionId,
              }, [...transcriptSubjectRefs, transcript.leftCompareVersionId, transcript.rightCompareVersionId]);
            }
          }}>{compareAction?.label ?? "Compare selected versions"}</button>
        {comparePairMessage && <p role="status">{comparePairMessage}</p>}
        {compareAction?.disabledReason && <p>{compareAction.disabledReason}</p>}
      </fieldset>}
      {transcript.view === "correct-captions" && <section aria-labelledby="caption-version-purpose-title">
        <h4 id="caption-version-purpose-title">Save a caption version</h4>
        <label htmlFor="caption-version-purpose">Version purpose (optional)</label>
        <input id="caption-version-purpose" className="media-input" type="text" value={transcript.versionPurpose ?? ""}
          disabled={!onVersionPurposeChange || !saveAction?.enabled}
          onChange={(event) => onVersionPurposeChange?.(event.currentTarget.value)} />
        <button type="button" className="media-action-button media-action-button--primary" disabled={!saveAction?.enabled || pendingPayloadAction !== undefined} onClick={() => {
          const purpose = transcript.versionPurpose?.trim();
          invokePayloadAction("media.action.save-caption-version", purpose ? { purpose } : {});
        }}>{saveAction?.label ?? "Save caption version"}</button>
        {saveAction?.disabledReason && <p>{saveAction.disabledReason}</p>}
      </section>}
      {transcript.view === "monitor-transcription" && <p role="status">The latest job state and outcome are shown in the operation observation above.</p>}
      {payloadActionStatus && <p role="status" aria-live="polite">{payloadActionStatus}</p>}
    </section>
  </MediaTaskScreen>;
}
