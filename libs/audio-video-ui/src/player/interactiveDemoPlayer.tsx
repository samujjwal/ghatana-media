import type { ReactElement } from "react";
import { useEffect, useRef, useState } from "react";
import {
  createDemoPlayerState,
  demoCaptionAt,
  demoSourceTruthLabel,
  reduceDemoPlayerState,
  replayDemoBranchPath,
  type DemoPlayerAction,
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
  readonly element: HTMLVideoElement;
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
  const mediaRef = useRef<HTMLVideoElement>(null);
  const sceneLabelRef = useRef<HTMLParagraphElement>(null);
  const stopAtSceneBoundary = useRef(false);
  const viewState = verifiedState.status === "READY" && state.trustBinding === verifiedState.trustBinding
    ? state
    : verifiedState;
  const previousSceneId = useRef(viewState.activeSceneId);
  const activeScene = manifest.scenes.find((scene) => scene.id === viewState.activeSceneId);
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
  const isCurrentVideo = (video: HTMLVideoElement) => mediaRef.current === video && video.isConnected;
  const dispatch = (action: DemoPlayerAction) => setState((current) => {
    const basis = verifiedState.status === "READY" && current.trustBinding === verifiedState.trustBinding
      ? current
      : verifiedState;
    return reduceDemoPlayerState(manifest, basis, action, verificationPort);
  });
  const pauseForNavigation = () => {
    const video = mediaRef.current;
    if (video && video.isConnected && !video.paused) {
      stopAtSceneBoundary.current = true;
      try {
        video.pause();
      } catch {
        stopAtSceneBoundary.current = false;
      }
    }
  };
  const failPlayback = () => dispatch({ type: "playback-failed" });
  const playMedia = () => {
    if (viewState.status !== "READY" || !mediaReady || !mediaRef.current) return;
    const video = mediaRef.current;
    if (!video.isConnected) return;
    try {
      void video.play().catch(() => {
        if (isCurrentVideo(video)) failPlayback();
      });
    } catch {
      if (isCurrentVideo(video)) failPlayback();
    }
  };
  const pauseMedia = () => {
    const video = mediaRef.current;
    if (!video || !video.isConnected) return;
    try {
      video.pause();
    } catch {
      if (isCurrentVideo(video)) failPlayback();
    }
  };
  const seekMedia = (positionMs: number) => {
    pauseForNavigation();
    dispatch({ type: "seek", positionMs });
    const video = mediaRef.current;
    if (
      video && activeScene && mediaKey && isCurrentVideo(video) &&
      positionMs >= activeScene.startMs && positionMs <= activeScene.endMs
    ) {
      try {
        video.currentTime = positionMs / 1_000;
      } catch {
        if (isCurrentVideo(video)) failPlayback();
      }
    }
  };
  const sourceLabel = viewState.sourceTruth ? demoSourceTruthLabel(viewState.sourceTruth) : "Unverified demonstration";

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
          <video
            key={mediaKey}
            ref={mediaRef}
            aria-label={`Media for ${activeScene.label}`}
            className="media-interactive-demo-player__media"
            src={activeScene.asset.url}
            preload="metadata"
            playsInline
            onLoadedMetadata={(event) => {
              const video = event.currentTarget;
              if (!isCurrentVideo(video)) return;
              const target = activeScene.startMs / 1_000;
              try {
                video.currentTime = target;
                // Some browsers expose the requested currentTime while the
                // seek is still in flight. Do not enable playback until the
                // native element confirms that it has finished positioning.
                if (!video.seeking && Math.abs(video.currentTime - target) < 0.001 && mediaKey && isCurrentVideo(video)) {
                  setPositionedMedia({ key: mediaKey, element: video });
                }
              } catch {
                if (isCurrentVideo(video)) failPlayback();
              }
            }}
            onSeeked={(event) => {
              const video = event.currentTarget;
              const target = activeScene.startMs / 1_000;
              if (Math.abs(video.currentTime - target) < 0.001 && mediaKey && isCurrentVideo(video)) {
                setPositionedMedia({ key: mediaKey, element: video });
              }
            }}
            onPlay={(event) => {
              const video = event.currentTarget;
              if (!isCurrentVideo(video)) return;
              if (!mediaReady || viewState.status !== "READY") {
                stopAtSceneBoundary.current = true;
                try {
                  video.pause();
                } catch {
                  stopAtSceneBoundary.current = false;
                }
                return;
              }
              stopAtSceneBoundary.current = false;
              dispatch({ type: "play" });
            }}
            onPause={(event) => {
              if (!isCurrentVideo(event.currentTarget)) return;
              if (stopAtSceneBoundary.current || event.currentTarget.ended) {
                stopAtSceneBoundary.current = false;
                return;
              }
              dispatch({ type: "pause" });
            }}
            onTimeUpdate={(event) => {
              const video = event.currentTarget;
              if (!isCurrentVideo(video)) return;
              const positionMs = Math.floor(video.currentTime * 1_000);
              if (positionMs >= activeScene.endMs) {
                stopAtSceneBoundary.current = true;
                dispatch({ type: "ended" });
                try {
                  // timeupdate is throttled by browsers; clamp the native
                  // element so delayed events cannot expose the next scene.
                  video.currentTime = activeScene.endMs / 1_000;
                  video.pause();
                } catch {
                  if (isCurrentVideo(video)) failPlayback();
                }
                return;
              }
              dispatch({ type: "progress", positionMs });
            }}
            onEnded={(event) => {
              const video = event.currentTarget;
              if (!isCurrentVideo(video)) return;
              const positionMs = Math.floor(video.currentTime * 1_000);
              if (positionMs >= activeScene.endMs) dispatch({ type: "ended" });
              else failPlayback();
            }}
            onError={(event) => {
              if (isCurrentVideo(event.currentTarget)) failPlayback();
            }}
          />
        )}
      </div>
      <p role="status" aria-live="polite" aria-atomic="true">{viewState.announcement}</p>
      {activeScene && viewState.status === "READY" && (
        <>
          <div role="group" aria-label="Playback controls">
            <button type="button" onClick={playMedia} aria-label={`Play ${activeScene.label}`} disabled={!mediaReady || viewState.playing}>Play</button>
            <button type="button" onClick={pauseMedia} aria-label={`Pause ${activeScene.label}`} disabled={!viewState.playing}>Pause</button>
            <button type="button" onClick={() => {
              pauseForNavigation();
              const next = replayDemoBranchPath(manifest, verificationPort, viewState.branches);
              setState(next);
              const video = mediaRef.current;
              if (
                video && activeScene && next.activeSceneId === activeScene.id && isCurrentVideo(video)
              ) {
                try {
                  video.currentTime = next.positionMs / 1_000;
                } catch {
                  if (isCurrentVideo(video)) failPlayback();
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
                    // A same-scene branch keeps the keyed video mounted. Reset
                    // that element as well as reducer state before it can play
                    // the old position under the newly selected branch.
                    if (branch.targetSceneId === activeScene.id) {
                      const video = mediaRef.current;
                      const target = activeScene.startMs / 1_000;
                      if (video && isCurrentVideo(video)) {
                        const alreadyAtConfirmedStart = !video.seeking && Math.abs(video.currentTime - target) < 0.001;
                        if (!alreadyAtConfirmedStart) setPositionedMedia(undefined);
                        try {
                          if (!alreadyAtConfirmedStart) video.currentTime = target;
                        } catch {
                          if (isCurrentVideo(video)) failPlayback();
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
        </>
      )}
    </section>
  );
}
