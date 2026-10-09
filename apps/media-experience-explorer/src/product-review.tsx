import React, { useEffect, useMemo, useState } from "react";
import {
  MediaProductRenderer,
  type MediaScreenAction,
} from "@audio-video/ui";
import type { MediaActionDispatchResult } from "@audio-video/ui/ports";
import type { MediaTaskCurrentProjection, MediaTaskOperationObservation } from "@audio-video/ui/components";
import { projectExperience } from "@ghatana/media-experience-simulation";
import type { MediaAction, MediaExperienceState, TransitionResult } from "@ghatana/media-experience-simulation";

const MEDIA_RENDERER_PUBLIC_EXPORT = "@audio-video/ui#MediaProductRenderer" as const;
type MediaRendererBinding = {
  readonly identity: typeof MEDIA_RENDERER_PUBLIC_EXPORT;
  readonly ports: {
    readonly input: { readonly variant: string; readonly scenarioId: string };
    readonly state: { readonly sequence: number };
    readonly action: { readonly actionIds: readonly string[] };
  };
};

export type ReviewView = "setup" | "projects" | "project" | "source" | "transcript" | "captions" | "versions" | "browse" | "import" | "artifact" | "review-activity" | "job-status";

const labels: Record<string, string> = {
  "media.action.create-project": "Create project",
  "media.action.inspect-project-creation": "Check project creation",
  "media.action.inspect-artifact": "Inspect artifact",
  "media.action.resume-artifact-upload": "Resume upload",
  "media.action.view-job-status": "View job status",
  "media.action.check-job-outcome": "Check job outcome",
  "media.action.request-cancellation": "Request cancellation",
  "media.action.inspect-source": "Inspect source",
  "media.action.choose-source": "Choose source",
  "media.action.seek-source": "Seek source",
  "media.action.request-transcription": "Request transcription",
  "media.action.review-transcript": "Review transcript",
  "media.action.inspect-provenance": "Inspect provenance",
  "media.action.correct-caption": "Update caption",
  "media.action.align-caption-timing": "Update timing",
  "media.action.save-caption-version": "Save caption version",
  "media.action.compare-caption-versions": "Compare versions",
  "media.action.resolve-caption-conflict": "Resolve caption conflict",
};

function steps(title: string, currentStepId: string): MediaTaskCurrentProjection {
  return { title, description: "Current synthetic scenario projection", steps: [{ id: currentStepId, title, description: "Fixture state", state: "current" }], currentStepId };
}

function operation(state: MediaExperienceState): MediaTaskOperationObservation | undefined {
  if (state.workflow !== "artifact-verification" && state.workflow !== "transcription") return undefined;
  const stateMap = { QUEUED: "QUEUED", RUNNING: "RUNNING", RETRY_PENDING: "RETRY_PENDING", OUTCOME_UNKNOWN: "OUTCOME_UNKNOWN", RECONCILING: "RECONCILING", COMPLETED: "COMPLETED", FAILED: "FAILED", PARTIALLY_SUCCEEDED: "PARTIALLY_SUCCEEDED", CANCELLED: "CANCELLED" } as const;
  if (state.workflow === "artifact-verification") {
    const observedState = state.artifactVerification.status;
    return { state: stateMap[observedState], progress: observedState === "OUTCOME_UNKNOWN" ? { kind: "unknown" } : state.artifactVerification.progressPercent === null ? { kind: "none" } : { kind: "determinate", value: state.artifactVerification.progressPercent }, finality: state.artifactVerification.finality };
  }
  if (state.job.state === "NOT_SUBMITTED") return undefined;
  return { state: stateMap[state.job.state], progress: state.job.state === "OUTCOME_UNKNOWN" ? { kind: "unknown" } : { kind: "none" }, finality: state.job.finality };
}

export function ProductReview({ state, view, onAction }: { state: MediaExperienceState; view: ReviewView; onAction: (action: MediaAction) => TransitionResult }): React.ReactElement {
  const [captionDrafts, setCaptionDrafts] = useState<Record<string, string>>({});
  const [timingDrafts, setTimingDrafts] = useState<Record<string, { start: string; end: string }>>({});
  const [purpose, setPurpose] = useState("");
  const [compareSelection, setCompareSelection] = useState<{ left: string; right: string }>({ left: "", right: "" });
  const [projectNameDraft, setProjectNameDraft] = useState("");
  const projection = useMemo(() => steps(
    state.workflow === "first-use" ? "First-use project" : state.workflow === "artifact-intake" ? "Artifact intake" : state.workflow === "artifact-verification" ? "Artifact verification" : "Transcription and captions",
    state.workflow,
  ), [state.workflow]);
  const safeIds = projectExperience(state).safeActionIds;
  const toolsHosted = typeof document !== "undefined" && document.querySelector("#tools-product-renderer-mount") !== null;
  const [toolsBinding, setToolsBinding] = useState<MediaRendererBinding | null>(null);
  useEffect(() => {
    if (!toolsHosted) return undefined;
    const receiveBinding = (event: Event) => {
      const detail = (event as CustomEvent<MediaRendererBinding>).detail;
      if (detail?.identity === MEDIA_RENDERER_PUBLIC_EXPORT) setToolsBinding(detail);
    };
    document.addEventListener("media-tools-renderer-binding", receiveBinding);
    return () => document.removeEventListener("media-tools-renderer-binding", receiveBinding);
  }, [toolsHosted]);
  const expectedVariant = state.workflow === "first-use" ? "first-use-project"
    : state.workflow === "artifact-intake" ? "artifact-intake"
      : state.workflow === "artifact-verification" ? "job-recovery" : "transcript-caption";
  const bindingMatchesFixture = Boolean(toolsBinding && toolsBinding.identity === MEDIA_RENDERER_PUBLIC_EXPORT &&
    toolsBinding.ports.input.scenarioId === state.scenarioId && toolsBinding.ports.input.variant === expectedVariant &&
    toolsBinding.ports.state.sequence === state.sequence && toolsBinding.ports.action.actionIds.join("\u0000") === safeIds.join("\u0000"));
  const errorOutcomes = ["intent-accepted", "unavailable", "denied"] as const;
  const actionIds = useMemo(() => {
    const candidates = [
      "media.action.create-project", "media.action.inspect-project-creation", "media.action.inspect-artifact", "media.action.resume-artifact-upload",
      "media.action.view-job-status", "media.action.check-job-outcome", "media.action.request-cancellation", "media.action.inspect-source",
      "media.action.choose-source", "media.action.seek-source", "media.action.request-transcription", "media.action.review-transcript",
      "media.action.inspect-provenance", "media.action.correct-caption", "media.action.align-caption-timing", "media.action.save-caption-version",
      "media.action.compare-caption-versions", "media.action.resolve-caption-conflict",
    ];
    const visible = candidates.filter((id) => {
      if (state.workflow === "first-use") return id.includes("project-");
      if (state.workflow === "artifact-intake") return id.includes("artifact") || id.includes("upload");
      if (state.workflow === "artifact-verification") return id.includes("job-");
      return true;
    });
    return visible.map((id): MediaScreenAction => ({ id, label: labels[id] ?? id, enabled: safeIds.includes(id) }));
  }, [state, safeIds]);
  const dispatch = (id: string, payload: Readonly<Record<string, string | number | boolean | null>> = {}): MediaActionDispatchResult => {
    let lastResult: TransitionResult | undefined;
    const emit = (action: MediaAction) => { lastResult = onAction(action); };
    if (id === "media.action.create-project") emit({ type: id });
    else if (id === "media.action.inspect-project-creation") emit({ type: id });
    else if (id === "media.action.inspect-artifact") emit({ type: id });
    else if (id === "media.action.resume-artifact-upload") emit({ type: id });
    else if (id === "media.action.view-job-status") emit({ type: id });
    else if (id === "media.action.check-job-outcome") emit({ type: id });
    else if (id === "media.action.request-cancellation") emit({ type: id });
    else if (id === "media.action.inspect-source") emit({ type: id });
    else if (id === "media.action.choose-source") emit({ type: id });
    else if (id === "media.action.seek-source") emit({ type: id, timeTick: state.workflow === "transcription" ? state.playbackPositionTick : 0 });
    else if (id === "media.action.request-transcription") emit({ type: id, languageTag: state.workflow === "transcription" ? state.transcript.languageTag ?? "und" : "und" });
    else if (id === "media.action.review-transcript") emit({ type: id });
    else if (id === "media.action.inspect-provenance") emit({ type: id });
    else if (id === "media.action.save-caption-version") {
      if (state.workflow === "transcription") {
        for (const segment of state.captionDraft.segments) {
          const editedText = captionDrafts[segment.segmentId];
          if (editedText !== undefined && editedText !== segment.text) emit({ type: "media.action.correct-caption", segmentId: segment.segmentId, text: editedText });
          const timing = timingDrafts[segment.segmentId];
          const startTick = timing?.start !== undefined && timing.start !== "" ? Number(timing.start) : segment.startTick;
          const endTick = timing?.end !== undefined && timing.end !== "" ? Number(timing.end) : segment.endTick;
          if (startTick !== segment.startTick || endTick !== segment.endTick) {
            if (startTick !== null && startTick !== undefined && endTick !== null && endTick !== undefined) {
              emit({ type: "media.action.align-caption-timing", segmentId: segment.segmentId, startTick, endTick });
            }
          }
        }
      }
      const savePurpose = typeof payload.purpose === "string" && payload.purpose.trim() ? payload.purpose.trim() : purpose.trim();
      emit({ type: id, ...(savePurpose ? { purpose: savePurpose } : {}) });
    }
    else if (id === "media.action.correct-caption" && typeof payload.segmentId === "string" && typeof payload.text === "string") emit({ type: id, segmentId: payload.segmentId, text: payload.text });
    else if (id === "media.action.align-caption-timing" && typeof payload.segmentId === "string" && typeof payload.startTick === "number" && typeof payload.endTick === "number") emit({ type: id, segmentId: payload.segmentId, startTick: payload.startTick, endTick: payload.endTick });
    else if (id === "media.action.compare-caption-versions" && state.workflow === "transcription" && typeof payload.leftVersionId === "string" && typeof payload.rightVersionId === "string") emit({ type: id, leftVersionId: payload.leftVersionId, rightVersionId: payload.rightVersionId });
    else if (id === "media.action.resolve-caption-conflict") emit({ type: id, resolution: "keep-local" });
    if (!lastResult) return { status: "unavailable", reason: `No deterministic fixture handler for ${id}.` };
    return lastResult.applied ? { status: "intent-accepted" } : { status: "denied", reason: lastResult.reasonCode ?? lastResult.message };
  };
  const common = {
    data: { currentProjection: projection, operationObservation: operation(state) },
    actions: actionIds,
    nextSafeActionIds: safeIds,
    actionPort: { invoke: async (id: string, payload?: Readonly<Record<string, string | number | boolean | null>>) => dispatch(id, payload) },
    context: { locale: "en-US" },
  };
  const stateText = state.workflow === "first-use" ? `${state.firstUse.identityResolved ? "Identity resolved in fixture" : "Identity not established"}; workspace access ${state.firstUse.workspaceAccess}; project creation ${state.firstUse.creationStatus}.`
    : state.workflow === "artifact-intake" ? `Synthetic upload ${state.artifactIntake.uploadId}; state ${state.artifactIntake.status}; integrity ${state.artifactIntake.integrity}.`
    : state.workflow === "artifact-verification" ? `Synthetic verification job ${state.artifactVerification.jobId}; state ${state.artifactVerification.status}; finality ${state.artifactVerification.finality}.`
    : `Synthetic transcription scenario ${state.scenarioId}; job ${state.job.jobId ?? "not submitted"}; state ${state.job.state}; finality ${state.job.finality}.`;
  const notice = <aside className="candidate-review-notice" role="note"><strong>CANDIDATE · NOT ADMITTED</strong><p>Shared presentation mounted in the Explorer review host. This synthetic fixture is not a production service or admitted Web screen.</p><p>{stateText}</p></aside>;
  const job = state.workflow === "artifact-verification" ? { jobId: state.artifactVerification.jobId, observedAt: `fixture sequence ${state.sequence}`, finality: state.artifactVerification.finality, message: stateText }
    : state.workflow === "transcription" ? { jobId: state.job.jobId ?? "fixture-job-not-submitted", sourceArtifactVersion: state.source.artifactVersion, observedAt: `fixture sequence ${state.sequence}`, connectionObservation: "unavailable" as const, finality: state.job.finality, message: stateText }
      : undefined;
  let screen: React.ReactNode;
  if (state.workflow === "first-use") {
    const projectView = view === "setup" ? "authenticate-and-select-context" : view === "project" ? "work-in-project" : "find-projects";
    screen = <>
      <MediaProductRenderer kind="first-use-project" {...common} project={{ view: projectView, workspaceName: state.firstUse.workspaceId ?? undefined, projectName: state.firstUse.projectId ?? undefined, projectNameDraft, accessState: state.firstUse.workspaceAccess === "ALLOWED" ? "resolved" : state.firstUse.workspaceAccess === "DENIED" ? "denied" : "unknown", message: `${stateText} Project name is a local draft; this fixture action has no project-name field.`, returnDestination: state.firstUse.returnDestination }} onProjectNameDraftChange={setProjectNameDraft} />
      {projectView === "work-in-project" && <p className="candidate-project-version" data-project-version={state.firstUse.projectVersion ?? "unknown"}>
        Project version: <strong>{state.firstUse.projectVersion ?? "Not established"}</strong>
      </p>}
    </>;
  } else if (state.workflow === "artifact-intake") {
    const intakeView = view === "import" ? "import-media" : view === "browse" ? "browse-media" : "inspect-media";
    screen = <MediaProductRenderer kind="artifact-intake" {...common} intake={{ view: intakeView, sourceName: state.artifactIntake.sourceName, uploadId: state.artifactIntake.uploadId, integrity: state.artifactIntake.integrity, verificationState: state.artifactIntake.status, message: stateText, artifacts: state.artifactIntake.artifactVersion ? [{ id: state.artifactIntake.uploadId, name: state.artifactIntake.sourceName, version: state.artifactIntake.artifactVersion, integrity: state.artifactIntake.integrity }] : [] }} />;
  } else if (state.workflow === "artifact-verification") {
    screen = <MediaProductRenderer kind="job-recovery" {...common} job={job!} />;
  } else if (view === "job-status" || state.job.state === "OUTCOME_UNKNOWN" || state.job.state === "RECONCILING") {
    screen = <MediaProductRenderer kind="job-recovery" {...common} job={job!} />;
  } else {
    const transcriptView = view === "source" ? "select-source" : view === "versions" ? "compare-caption-versions" : view === "captions" ? "correct-captions" : state.job.state === "NOT_SUBMITTED" ? "select-source" : "review-transcript";
    const segments = state.captionDraft.segments.map((segment) => ({
      id: segment.segmentId,
      startTime: (timingDrafts[segment.segmentId]?.start ?? (segment.startTick === null ? "" : String(segment.startTick))) === "" ? "Unknown tick" : `${timingDrafts[segment.segmentId]?.start ?? segment.startTick} ticks on ${state.source.clockId}`,
      endTime: (timingDrafts[segment.segmentId]?.end ?? (segment.endTick === null ? "" : String(segment.endTick))) === "" ? "Unknown tick" : `${timingDrafts[segment.segmentId]?.end ?? segment.endTick} ticks on ${state.source.clockId}`,
      startTick: timingDrafts[segment.segmentId]?.start === undefined ? segment.startTick : timingDrafts[segment.segmentId]?.start === "" ? null : Number(timingDrafts[segment.segmentId]?.start),
      endTick: timingDrafts[segment.segmentId]?.end === undefined ? segment.endTick : timingDrafts[segment.segmentId]?.end === "" ? null : Number(timingDrafts[segment.segmentId]?.end),
      text: captionDrafts[segment.segmentId] ?? segment.text,
      provenance: segment.origin,
    }));
    screen = <MediaProductRenderer kind="transcript-caption" {...common} transcript={{ view: transcriptView, sourceArtifactVersion: state.source.artifactVersion, sourceTime: `${state.playbackPositionTick} ticks on ${state.source.clockId}`, clockId: state.source.clockId, ticksPerSecond: state.source.ticksPerSecond, durationTicks: state.source.durationTicks, language: state.transcript.languageTag ?? undefined, jobId: state.job.jobId ?? undefined, transcriptVersion: state.transcript.versionId ?? undefined, captionDraftVersion: state.captionDraft.versionId ?? undefined, versionPurpose: purpose, leftCompareVersionId: compareSelection.left, rightCompareVersionId: compareSelection.right, sourceChoices: [{ artifactVersion: state.source.artifactVersion, label: state.source.displayName, availability: state.source.lifecycle }], segments: segments, versions: state.captionHistory.map((v) => ({ id: v.versionId, label: v.purpose ?? v.versionId })), message: stateText }}
      onCaptionEdit={(segmentId, text) => setCaptionDrafts((previous) => ({ ...previous, [segmentId]: text }))}
      onCaptionTimingDraftChange={(segmentId, field, value) => setTimingDrafts((previous) => ({ ...previous, [segmentId]: { ...previous[segmentId], [field === "startTick" ? "start" : "end"]: value === null ? "" : String(value) } }))}
      onVersionPurposeChange={setPurpose}
      onCompareVersionSelection={(side, versionId) => setCompareSelection((previous) => ({ ...previous, [side]: versionId }))} />;
  }
  return <div className="candidate-presentation-shell"
    data-renderer-export={MEDIA_RENDERER_PUBLIC_EXPORT}
    data-renderer-binding-status={toolsHosted ? bindingMatchesFixture ? "consumed" : toolsBinding ? "fixture-mismatch" : "pending" : "product-review"}
    data-fixture-id={state.scenarioId}
    data-renderer-variant={expectedVariant}
    data-state-ref={state.scenarioId}
    data-action-port="MediaActionPort"
    data-action-ids={JSON.stringify(safeIds)}
    data-error-port="MediaActionDispatchResult"
    data-error-outcomes={JSON.stringify(errorOutcomes)}>{notice}{screen}</div>;
}
