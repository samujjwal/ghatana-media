import React from "react";
import { MediaTaskScreen, type MediaTaskScreenProps } from "./MediaTaskScreen";

export type TranscriptCaptionView = "select-source" | "monitor-transcription" | "review-transcript" | "correct-captions" | "compare-caption-versions";

export interface TranscriptCaptionProjection {
  readonly view: TranscriptCaptionView;
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
  /** Host projection callbacks retain the draft values until an explicit version save. */
  readonly onCaptionEdit?: (segmentId: string, text: string) => void;
  readonly onCaptionTimingDraftChange?: (segmentId: string, field: "startTick" | "endTick", value: number | null) => void;
  readonly onVersionPurposeChange?: (purpose: string) => void;
  readonly onCompareVersionSelection?: (side: "left" | "right", versionId: string) => void;
}

/** Candidate J-03 body for source selection, transcript review, caption correction and version comparison. */
export function TranscriptCaptionScreen({
  transcript, onCaptionEdit, onCaptionTimingDraftChange, onVersionPurposeChange,
  onCompareVersionSelection,
  actions = [], nextSafeActionIds = [], actionPort, ...flow
}: TranscriptCaptionScreenProps): React.ReactElement {
  const heading = {
    "select-source": "Select a source recording",
    "monitor-transcription": "Transcription status",
    "review-transcript": "Review transcript",
    "correct-captions": "Correct captions",
    "compare-caption-versions": "Compare caption versions",
  }[transcript.view];
  const availableActions = new Map(actions.map((action) => [action.id, action]));
  const correctAction = availableActions.get("media.action.correct-caption");
  const canCorrect = correctAction?.enabled === true;
  const alignAction = availableActions.get("media.action.align-caption-timing");
  const saveAction = availableActions.get("media.action.save-caption-version");
  const compareAction = availableActions.get("media.action.compare-caption-versions");
  const payloadActions = new Set(["media.action.correct-caption", "media.action.align-caption-timing", "media.action.save-caption-version", "media.action.compare-caption-versions"]);
  const flowActions = actions.filter((action) => !payloadActions.has(action.id));
  const flowSafeActionIds = nextSafeActionIds.filter((id) => !payloadActions.has(id));

  return <MediaTaskScreen {...flow} actions={flowActions} nextSafeActionIds={flowSafeActionIds} actionPort={actionPort}>
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
            <button type="button" className="media-action-button media-action-button--primary" disabled={!availableActions.get("media.action.choose-source")?.enabled}
              onClick={() => void actionPort.invoke("media.action.choose-source", { artifactVersion: source.artifactVersion })}>Select this source</button>
          </li>)}
        </ul>
      </section> : null}
      {transcript.view === "correct-captions" ? <ol aria-label="Caption segments">
        {transcript.segments?.map((segment) => <li key={segment.id}>
          <p>{segment.startTime}–{segment.endTime} · Segment {segment.id}</p>
          <label htmlFor={`caption-${segment.id}`}>Caption text for segment {segment.id}</label>
          <textarea id={`caption-${segment.id}`} className="media-input" value={segment.text} disabled={!onCaptionEdit || !canCorrect}
            onChange={(event) => onCaptionEdit?.(segment.id, event.currentTarget.value)} rows={2} />
          <button type="button" className="media-action-button media-action-button--primary" disabled={!canCorrect} onClick={() => {
            if (canCorrect) void actionPort.invoke("media.action.correct-caption", { segmentId: segment.id, text: segment.text });
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
            <button type="button" className="media-action-button media-action-button--primary" disabled={!alignAction?.enabled || segment.startTick == null || segment.endTick == null}
              onClick={() => {
                if (segment.startTick != null && segment.endTick != null) {
                  void actionPort.invoke("media.action.align-caption-timing", {
                    segmentId: segment.id, startTick: segment.startTick, endTick: segment.endTick,
                  });
                }
              }}>{alignAction?.label ?? "Apply timing alignment"}</button>
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
      {transcript.view === "compare-caption-versions" && <ul aria-label="Caption versions">
        {transcript.versions?.map((version) => <li key={version.id}><p>{version.label}</p><p><code>{version.id}</code>{version.createdAt ? ` · ${version.createdAt}` : ""}</p></li>)}
      </ul>}
      {transcript.view === "compare-caption-versions" && <fieldset>
        <legend>Choose versions to compare</legend>
        <label htmlFor="caption-version-left">Earlier or source version</label>
        <select id="caption-version-left" className="media-input" value={transcript.leftCompareVersionId ?? ""}
          disabled={!onCompareVersionSelection || !compareAction?.enabled}
          onChange={(event) => onCompareVersionSelection?.("left", event.currentTarget.value)}>
          <option value="">Choose a version</option>
          {transcript.versions?.map((version) => <option key={version.id} value={version.id}>{version.label} — {version.id}</option>)}
        </select>
        <label htmlFor="caption-version-right">Other version</label>
        <select id="caption-version-right" className="media-input" value={transcript.rightCompareVersionId ?? ""}
          disabled={!onCompareVersionSelection || !compareAction?.enabled}
          onChange={(event) => onCompareVersionSelection?.("right", event.currentTarget.value)}>
          <option value="">Choose a version</option>
          {transcript.versions?.map((version) => <option key={version.id} value={version.id}>{version.label} — {version.id}</option>)}
        </select>
        <button type="button" className="media-action-button media-action-button--primary" disabled={!compareAction?.enabled || !transcript.leftCompareVersionId || !transcript.rightCompareVersionId}
          onClick={() => {
            if (transcript.leftCompareVersionId && transcript.rightCompareVersionId) {
              void actionPort.invoke("media.action.compare-caption-versions", {
                leftVersionId: transcript.leftCompareVersionId,
                rightVersionId: transcript.rightCompareVersionId,
              });
            }
          }}>{compareAction?.label ?? "Compare selected versions"}</button>
        {compareAction?.disabledReason && <p>{compareAction.disabledReason}</p>}
      </fieldset>}
      {transcript.view === "correct-captions" && <section aria-labelledby="caption-version-purpose-title">
        <h4 id="caption-version-purpose-title">Save a caption version</h4>
        <label htmlFor="caption-version-purpose">Version purpose (optional)</label>
        <input id="caption-version-purpose" className="media-input" type="text" value={transcript.versionPurpose ?? ""}
          disabled={!onVersionPurposeChange || !saveAction?.enabled}
          onChange={(event) => onVersionPurposeChange?.(event.currentTarget.value)} />
        <button type="button" className="media-action-button media-action-button--primary" disabled={!saveAction?.enabled} onClick={() => {
          const purpose = transcript.versionPurpose?.trim();
          void actionPort.invoke("media.action.save-caption-version", purpose ? { purpose } : {});
        }}>{saveAction?.label ?? "Save caption version"}</button>
        {saveAction?.disabledReason && <p>{saveAction.disabledReason}</p>}
      </section>}
      {transcript.view === "monitor-transcription" && <p role="status">The latest job state and outcome are shown in the operation observation above.</p>}
    </section>
  </MediaTaskScreen>;
}
