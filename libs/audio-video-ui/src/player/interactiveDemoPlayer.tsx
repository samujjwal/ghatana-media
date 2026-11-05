import type { ReactElement } from "react";
import { useState } from "react";
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
  // prior READY view. No resource requests or verification effects run here.
  const verifiedState = createDemoPlayerState(manifest, verificationPort);
  const [state, setState] = useState(verifiedState);
  const viewState = verifiedState.status === "READY" && state.trustBinding === verifiedState.trustBinding
    ? state
    : verifiedState;
  const activeScene = manifest.scenes.find((scene) => scene.id === viewState.activeSceneId);
  const dispatch = (action: DemoPlayerAction) => setState((current) => {
    const basis = verifiedState.status === "READY" && current.trustBinding === verifiedState.trustBinding
      ? current
      : verifiedState;
    return reduceDemoPlayerState(manifest, basis, action, verificationPort);
  });
  const sourceLabel = viewState.sourceTruth ? demoSourceTruthLabel(viewState.sourceTruth) : "Unverified demonstration";

  return (
    <section aria-label={label} className="media-interactive-demo-player" data-demo-status={viewState.status}>
      <p className="media-interactive-demo-player__source" aria-label={`Source: ${sourceLabel}`}>{sourceLabel}</p>
      <div role="group" className="media-interactive-demo-player__scene" aria-label={activeScene?.label ?? "Demonstration scene unavailable"}>
        <p>{activeScene?.label ?? viewState.announcement}</p>
        {activeScene && <p lang={activeScene.captions.language}>{demoCaptionAt(activeScene, viewState.positionMs)}</p>}
      </div>
      <p role="status" aria-live="polite" aria-atomic="true">{viewState.announcement}</p>
      {activeScene && viewState.status === "READY" && (
        <>
          <div role="group" aria-label="Playback controls">
            <button type="button" onClick={() => dispatch({ type: "play" })} aria-label={`Play ${activeScene.label}`} disabled={viewState.playing}>Play</button>
            <button type="button" onClick={() => dispatch({ type: "pause" })} aria-label={`Pause ${activeScene.label}`} disabled={!viewState.playing}>Pause</button>
            <button type="button" onClick={() => setState(replayDemoBranchPath(manifest, verificationPort, viewState.branches))} aria-label="Replay current demonstration path">Replay path</button>
            <button type="button" onClick={() => dispatch({ type: "finish" })} aria-label="Exit demonstration">Exit</button>
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
              onChange={(event) => dispatch({ type: "seek", positionMs: Number(event.currentTarget.value) })}
            />
          </label>
          {activeScene.branches.length > 0 && (
            <div role="group" aria-label={`Choices for ${activeScene.label}`}>
              {activeScene.branches.map((branch) => (
                <button
                  type="button"
                  key={branch.id}
                  aria-label={`${branch.label}; continue to ${manifest.scenes.find((scene) => scene.id === branch.targetSceneId)?.label ?? "unknown scene"}`}
                  onClick={() => dispatch({ type: "choose-branch", branchId: branch.id })}
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
