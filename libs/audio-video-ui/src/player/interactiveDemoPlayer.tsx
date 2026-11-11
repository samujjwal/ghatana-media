import type { ReactElement } from "react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  createDemoPlayerState,
  demoSceneMediaKind,
  demoCaptionAt,
  demoSourceTruthLabel,
  reduceDemoPlayerState,
  replayDemoBranchPath,
  type DemoPlayerAction,
  type DemoCue,
  type DemoScene,
  type DemoHostVerificationPort,
  type InteractiveDemoManifest,
} from "./interactiveDemoState";

export * from "./interactiveDemoState";

export interface InteractiveDemoPlayerProps {
  readonly manifest: InteractiveDemoManifest;
  /** Trusted host verifier snapshot; absent or unavailable verification fails closed. */
  readonly verificationPort?: DemoHostVerificationPort;
  readonly label?: string;
}

interface PositionedMedia {
  readonly key: string;
  readonly element: HTMLMediaElement;
}

function formatTranscriptTime(positionMs: number): string {
  const hours = Math.floor(positionMs / 3_600_000);
  const minutes = Math.floor(positionMs / 60_000) % 60;
  const seconds = Math.floor(positionMs / 1_000) % 60;
  const milliseconds = positionMs % 1_000;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}.${String(milliseconds).padStart(3, "0")}`;
}

function durationDateTime(positionMs: number): string {
  const seconds = Math.floor(positionMs / 1_000);
  const millisecondRemainder = positionMs % 1_000;
  const fractionalSeconds = String(millisecondRemainder).padStart(3, "0").replace(/0+$/, "");
  return `PT${seconds}${fractionalSeconds ? `.${fractionalSeconds}` : ""}S`;
}

/**
 * Accessible, source-bound controls for authored demonstrations. This view
 * never executes bundle script or dispatches product mutations.
 */
export function InteractiveDemoPlayer({
  manifest,
  verificationPort,
  label = "Interactive demonstration player",
}: InteractiveDemoPlayerProps): ReactElement {
  // The injected port is a synchronous, read-only attestation snapshot query.
  // Re-read each render so revoked or mismatched host trust cannot retain a
  // prior READY view. The media element is attached only to the current READY view.
  const verifiedState = createDemoPlayerState(manifest, verificationPort);
  const [state, setState] = useState(verifiedState);
  const [positionedMedia, setPositionedMedia] = useState<PositionedMedia>();
  const mediaRef = useRef<HTMLMediaElement>(null);
  const sceneLabelRef = useRef<HTMLParagraphElement>(null);
  const stopAtSceneBoundary = useRef(false);
  const viewState = verifiedState.status === "READY" && state.trustBinding === verifiedState.trustBinding
    ? state
    : verifiedState;
  const previousSceneId = useRef(viewState.activeSceneId);
  const activeScene = manifest.scenes.find((scene) => scene.id === viewState.activeSceneId);
  const transcriptCues = useMemo<readonly DemoCue[]>(() => activeScene
    ? activeScene.captions.cues
      .map((cue, index) => ({ cue, index }))
      .sort((left, right) => left.cue.startMs - right.cue.startMs || left.index - right.index)
      .map(({ cue }) => cue)
    : [], [activeScene]);
  useEffect(() => {
    if (previousSceneId.current !== viewState.activeSceneId) {
      previousSceneId.current = viewState.activeSceneId;
      if (viewState.status === "READY") sceneLabelRef.current?.focus();
    }
  }, [viewState.activeSceneId, viewState.status]);
  const mediaKey = activeScene && viewState.trustBinding
    ? `${viewState.trustBinding}:${activeScene.id}:${activeScene.asset.version}`
    : undefined;
  const mediaReady = Boolean(
    mediaKey && mediaRef.current && positionedMedia?.key === mediaKey && positionedMedia.element === mediaRef.current,
  );
  const isCurrentMedia = (media: HTMLMediaElement) => mediaRef.current === media && media.isConnected;
  const dispatch = (action: DemoPlayerAction) => setState((current) => {
    const basis = verifiedState.status === "READY" && current.trustBinding === verifiedState.trustBinding
      ? current
      : verifiedState;
    return reduceDemoPlayerState(manifest, basis, action, verificationPort);
  });
  const pauseForNavigation = () => {
    const media = mediaRef.current;
    if (media && media.isConnected && !media.paused) {
      stopAtSceneBoundary.current = true;
      try {
        media.pause();
      } catch {
        stopAtSceneBoundary.current = false;
      }
    }
  };
  const failPlayback = () => dispatch({ type: "playback-failed" });
  const playMedia = () => {
    if (viewState.status !== "READY" || !mediaReady || !mediaRef.current) return;
    const media = mediaRef.current;
    if (!media.isConnected) return;
    try {
      void media.play().catch(() => {
        if (isCurrentMedia(media)) failPlayback();
      });
    } catch {
      if (isCurrentMedia(media)) failPlayback();
    }
  };
  const pauseMedia = () => {
    const media = mediaRef.current;
    if (!media || !media.isConnected) return;
    try {
      media.pause();
    } catch {
      if (isCurrentMedia(media)) failPlayback();
    }
  };
  const seekMedia = (positionMs: number) => {
    pauseForNavigation();
    dispatch({ type: "seek", positionMs });
    const media = mediaRef.current;
    if (
      media && activeScene && mediaKey && isCurrentMedia(media) &&
      positionMs >= activeScene.startMs && positionMs <= activeScene.endMs
    ) {
      setPositionedMedia(undefined);
      try {
        media.currentTime = positionMs / 1_000;
        if (!media.seeking && Math.abs(media.currentTime - positionMs / 1_000) < 0.001) {
          setPositionedMedia({ key: mediaKey, element: media });
        }
      } catch {
        if (isCurrentMedia(media)) failPlayback();
      }
    }
  };
  const sourceLabel = viewState.sourceTruth ? demoSourceTruthLabel(viewState.sourceTruth) : "Unverified demonstration";
  const activeMediaKind = activeScene ? demoSceneMediaKind(activeScene) : "video";
  const MediaElement = activeMediaKind === "audio" ? "audio" : "video";

  return (
    <section aria-label={label} className="media-interactive-demo-player" data-demo-status={viewState.status}>
      <p className="media-interactive-demo-player__source" aria-label={`Source: ${sourceLabel}`}>{sourceLabel}</p>
      <div role="group" className="media-interactive-demo-player__scene" aria-label={activeScene?.label ?? "Demonstration scene unavailable"}>
        <p ref={sceneLabelRef} tabIndex={-1}>{activeScene?.label ?? viewState.announcement}</p>
        {activeScene && (
          <p
            lang={activeScene.captions.language}
            aria-label="Captions"
            aria-live="polite"
            aria-atomic="true"
          >
            {demoCaptionAt(activeScene, viewState.positionMs)}
          </p>
        )}
        {activeScene && viewState.status === "READY" && (
          <MediaElement
            key={mediaKey}
            ref={(element) => { mediaRef.current = element; }}
            aria-label={activeMediaKind === "audio" ? `Audio for ${activeScene.label}` : `Media for ${activeScene.label}`}
            className="media-interactive-demo-player__media"
            src={activeScene.asset.url}
            // A manifest permission authorizes reading an asset, not forwarding
            // ambient host credentials to its origin. Anonymous CORS keeps the
            // browser request scoped to the declared public/readable resource.
            crossOrigin="anonymous"
            preload="metadata"
            {...(activeMediaKind === "audio" ? {} : { playsInline: true })}
            onLoadedMetadata={(event) => {
              const media = event.currentTarget;
              if (!isCurrentMedia(media)) return;
              const target = activeScene.startMs / 1_000;
              try {
                media.currentTime = target;
                // Some browsers expose the requested currentTime while the
                // seek is still in flight. Do not enable playback until the
                // native element confirms that it has finished positioning.
                if (!media.seeking && Math.abs(media.currentTime - target) < 0.001 && mediaKey && isCurrentMedia(media)) {
                  setPositionedMedia({ key: mediaKey, element: media });
                }
              } catch {
                if (isCurrentMedia(media)) failPlayback();
              }
            }}
            onSeeked={(event) => {
              const media = event.currentTarget;
              const target = viewState.positionMs / 1_000;
              if (Math.abs(media.currentTime - target) < 0.001 && mediaKey && isCurrentMedia(media)) {
                setPositionedMedia({ key: mediaKey, element: media });
              }
            }}
            onPlay={(event) => {
              const media = event.currentTarget;
              if (!isCurrentMedia(media)) return;
              if (!mediaReady || viewState.status !== "READY") {
                stopAtSceneBoundary.current = true;
                try {
                  media.pause();
                } catch {
                  stopAtSceneBoundary.current = false;
                }
                return;
              }
              stopAtSceneBoundary.current = false;
              dispatch({ type: "play" });
            }}
            onPause={(event) => {
              if (!isCurrentMedia(event.currentTarget)) return;
              if (stopAtSceneBoundary.current || event.currentTarget.ended) {
                stopAtSceneBoundary.current = false;
                return;
              }
              dispatch({ type: "pause" });
            }}
            onTimeUpdate={(event) => {
              const media = event.currentTarget;
              if (!isCurrentMedia(media)) return;
              const positionMs = Math.floor(media.currentTime * 1_000);
              if (positionMs >= activeScene.endMs) {
                stopAtSceneBoundary.current = true;
                dispatch({ type: "ended" });
                try {
                  // timeupdate is throttled by browsers; clamp the native
                  // element so delayed events cannot expose the next scene.
                  media.currentTime = activeScene.endMs / 1_000;
                  media.pause();
                } catch {
                  if (isCurrentMedia(media)) failPlayback();
                }
                return;
              }
              dispatch({ type: "progress", positionMs });
            }}
            onEnded={(event) => {
              const media = event.currentTarget;
              if (!isCurrentMedia(media)) return;
              const positionMs = Math.floor(media.currentTime * 1_000);
              if (positionMs >= activeScene.endMs) dispatch({ type: "ended" });
              else failPlayback();
            }}
            onError={(event) => {
              if (isCurrentMedia(event.currentTarget)) failPlayback();
            }}
          />
        )}
      </div>
      <p role="status" aria-live="polite" aria-atomic="true">{viewState.announcement}</p>
      {activeScene && viewState.status === "READY" && (
        <>
          <div role="group" aria-label="Playback controls">
            <button type="button" onClick={playMedia} aria-label={`Play ${activeScene.label}`} disabled={!mediaReady || viewState.playing || viewState.positionMs >= activeScene.endMs}>Play</button>
            <button type="button" onClick={pauseMedia} aria-label={`Pause ${activeScene.label}`} disabled={!viewState.playing}>Pause</button>
            <button type="button" onClick={() => {
              pauseForNavigation();
              const next = replayDemoBranchPath(manifest, verificationPort, viewState.branches);
              setState(next);
              const media = mediaRef.current;
              if (
                media && activeScene && next.activeSceneId === activeScene.id && isCurrentMedia(media)
              ) {
                try {
                  const target = next.positionMs / 1_000;
                  const alreadyAtConfirmedStart = !media.seeking && Math.abs(media.currentTime - target) < 0.001;
                  if (!alreadyAtConfirmedStart) setPositionedMedia(undefined);
                  if (!alreadyAtConfirmedStart) media.currentTime = target;
                } catch {
                  if (isCurrentMedia(media)) failPlayback();
                }
              }
            }} aria-label="Replay current demonstration path">Replay path</button>
            <button type="button" onClick={() => {
              pauseForNavigation();
              dispatch({ type: "finish" });
            }} aria-label="Exit demonstration">Exit</button>
          </div>
          <label>
            Seek within {activeScene.label}
            <input
              type="range"
              min={activeScene.startMs}
              max={activeScene.endMs}
              step={1}
              value={Math.max(activeScene.startMs, Math.min(activeScene.endMs, viewState.positionMs))}
              aria-label={`Seek within ${activeScene.label}`}
              aria-valuetext={`${Math.round(viewState.positionMs)} milliseconds`}
              onChange={(event) => seekMedia(Number(event.currentTarget.value))}
            />
          </label>
          {activeScene.branches.length > 0 && (
            <div role="group" aria-label={`Choices for ${activeScene.label}`}>
              {activeScene.branches.map((branch) => (
                <button
                  type="button"
                  key={branch.id}
                  aria-label={`${branch.label}; continue to ${manifest.scenes.find((scene) => scene.id === branch.targetSceneId)?.label ?? "unknown scene"}`}
                  onClick={() => {
                    pauseForNavigation();
                    dispatch({ type: "choose-branch", branchId: branch.id });
                    // A same-scene branch keeps the keyed media mounted. Reset
                    // that element as well as reducer state before it can play
                    // the old position under the newly selected branch.
                    if (branch.targetSceneId === activeScene.id) {
                      const media = mediaRef.current;
                      const target = activeScene.startMs / 1_000;
                      if (media && isCurrentMedia(media)) {
                        const alreadyAtConfirmedStart = !media.seeking && Math.abs(media.currentTime - target) < 0.001;
                        if (!alreadyAtConfirmedStart) setPositionedMedia(undefined);
                        try {
                          if (!alreadyAtConfirmedStart) media.currentTime = target;
                        } catch {
                          if (isCurrentMedia(media)) failPlayback();
                        }
                      }
                    }
                  }}
                >
                  {branch.label}
                </button>
              ))}
            </div>
          )}
          <details className="media-interactive-demo-player__transcript">
            <summary>Transcript</summary>
            {transcriptCues.length === 0 ? (
              <p role="note" lang={activeScene.captions.language}>
                No authored transcript is available for this scene.
              </p>
            ) : (
              <ol aria-label={`Transcript for ${activeScene.label}`} lang={activeScene.captions.language}>
                {transcriptCues.map((cue) => (
                  <li key={cue.id}>
                    <button
                      type="button"
                      aria-label={`Seek to ${cue.startMs} milliseconds: ${cue.text}`}
                      onClick={() => seekMedia(cue.startMs)}
                    >
                      <time dateTime={durationDateTime(cue.startMs)} aria-label={`${cue.startMs} milliseconds`}>
                        {formatTranscriptTime(cue.startMs)}
                      </time>
                    </button>{" "}
                    <span>{cue.text}</span>
                  </li>
                ))}
              </ol>
            )}
          </details>
        </>
      )}
    </section>
  );
}
