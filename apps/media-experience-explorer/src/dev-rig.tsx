import React, { useEffect, useRef, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import { sha256Hex } from "@audio-video/ui/screens";
import { createDevRigClient, DevRigHostError, type DevRigPort } from "./dev-rig-client";

const origin = window.location.origin;
const MAX_CONTENT_BYTES = 8 * 1024 * 1024;

const SAMPLE_SPEC = {
  width: 320, height: 240, background: "#101828", fps: { numerator: 24, denominator: 1 }, frameCount: 48,
  coordinateFrame: { handedness: "RIGHT_HANDED", upAxis: "Y", unit: "METRE" },
  camera: { position: [0, 0.7, 3.6], lookAt: [0, 0.5, 0], verticalFovDegrees: 40, near: 0.1, far: 30 },
  bones: [
    { id: "shoulder", parent: null, restPosition: [-0.7, 0.3, 0], tip: [0.6, 0, 0], radius: 0.05, color: "#4080FF", maxDeviationDegrees: 120,
      keyframes: [{ frame: 0, rotation: { axis: [0, 0, 1], degrees: 0 } }, { frame: 24, rotation: { axis: [0, 0, 1], degrees: 55 } }, { frame: 47, rotation: { axis: [0, 0, 1], degrees: -15 } }] },
    { id: "elbow", parent: "shoulder", restPosition: [0.6, 0, 0], tip: [0.5, 0, 0], radius: 0.04, color: "#40FF80", maxDeviationDegrees: 140,
      keyframes: [{ frame: 0, rotation: { axis: [0, 0, 1], degrees: 0 } }, { frame: 24, rotation: { axis: [0, 0, 1], degrees: 80 } }, { frame: 47, rotation: { axis: [0, 0, 1], degrees: 15 } }] },
    { id: "wrist", parent: "elbow", restPosition: [0.5, 0, 0], tip: [0.25, 0, 0], radius: 0.03, color: "#FFC040", maxDeviationDegrees: 90,
      keyframes: [{ frame: 0, rotation: { axis: [0, 1, 0], degrees: 0 } }, { frame: 47, rotation: { axis: [0, 1, 0], degrees: 60 } }] },
  ],
  endEffector: { bone: "wrist", offset: [0.25, 0, 0], markerRadius: 0.07, color: "#FF00FF" },
  floor: { y: -0.5, halfExtent: 3, tiles: 6, colorA: "#808080", colorB: "#404040" },
};

type Json = Record<string, any>;
interface Failure { readonly code: string; readonly status: number; readonly message: string; readonly details: Json }
interface Loaded { readonly video: string | null; readonly glb: string | null }

const fmt = (value: unknown, digits = 3): string => typeof value === "number" && Number.isFinite(value) ? value.toFixed(digits) : "n/a";

async function requestIdFor(text: string): Promise<string> {
  const digest = await sha256Hex(new TextEncoder().encode(text));
  return `rig-${digest.slice(0, 24)}`;
}

function RigPanel({ port }: { readonly port: DevRigPort }): React.ReactElement {
  const [status, setStatus] = useState<Json | null>(null);
  const [specText, setSpecText] = useState<string>(() => JSON.stringify(SAMPLE_SPEC, null, 2));
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [result, setResult] = useState<Json | null>(null);
  const [frame, setFrame] = useState(0);
  const [loaded, setLoaded] = useState<Loaded>({ video: null, glb: null });
  const [playback, setPlayback] = useState<string>("");
  const [glbInfo, setGlbInfo] = useState<string>("");
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const specRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => { port.getStatus().then((response) => setStatus(response.body as Json)).catch((error: unknown) => {
    setFailure({ code: error instanceof DevRigHostError ? error.code : "STATUS_FAILED", status: 0, message: "The host status could not be read.", details: {} });
  }); }, [port]);
  useEffect(() => { if (result) titleRef.current?.focus(); }, [result]);
  useEffect(() => () => { if (loaded.video) URL.revokeObjectURL(loaded.video); }, [loaded.video]);

  const render = async (): Promise<void> => {
    setFailure(null); setParseError(null);
    let spec: unknown;
    try { spec = JSON.parse(specText); } catch { setParseError("The spec is not valid JSON. Nothing was sent."); specRef.current?.focus(); return; }
    setBusy(true);
    try {
      const requestId = await requestIdFor(JSON.stringify(spec));
      const response = await port.render({ requestId, spec, encoder: { crf: 14 } });
      if (loaded.video) URL.revokeObjectURL(loaded.video);
      setLoaded({ video: null, glb: null }); setPlayback(""); setGlbInfo(""); setFrame(0);
      setResult(response.body as Json);
    } catch (error) {
      setResult(null);
      if (error instanceof DevRigHostError) {
        setFailure({ code: error.code, status: error.status, message: error.message, details: (error.details ?? {}) as Json });
        if (error.details && typeof error.details.path === "string") specRef.current?.focus();
      } else setFailure({ code: "UNEXPECTED", status: 0, message: "Unexpected failure; nothing is shown.", details: {} });
    } finally { setBusy(false); }
  };

  const loadVideo = async (): Promise<void> => {
    const registered = result?.video as Json;
    setPlayback("Reading the exact registered version…");
    try {
      const content = await port.readArtifactContent({ artifactId: registered.artifactId, artifactVersionId: registered.artifactVersionId, maxBytes: MAX_CONTENT_BYTES });
      const digest = await sha256Hex(content.bytes);
      if (digest !== registered.sha256) { setPlayback("The bytes do not match the registered SHA-256. Nothing is shown."); return; }
      const url = URL.createObjectURL(new Blob([content.bytes as BlobPart], { type: "video/mp4" }));
      setLoaded((previous) => ({ ...previous, video: url }));
      setPlayback(`Bytes verified against the registered version (sha256 ${digest}).`);
    } catch { setPlayback("The video could not be read. Nothing is shown."); }
  };

  const verifyGlb = async (): Promise<void> => {
    const registered = result?.glb as Json;
    setGlbInfo("Reading the exact registered version…");
    try {
      const content = await port.readArtifactContent({ artifactId: registered.artifactId, artifactVersionId: registered.artifactVersionId, maxBytes: MAX_CONTENT_BYTES });
      const digest = await sha256Hex(content.bytes);
      if (digest !== registered.sha256) { setGlbInfo("The bytes do not match the registered SHA-256. Nothing is shown."); return; }
      const view = new DataView(content.bytes.buffer, content.bytes.byteOffset, content.bytes.byteLength);
      const jsonLength = view.getUint32(12, true);
      const json = JSON.parse(new TextDecoder().decode(content.bytes.subarray(20, 20 + jsonLength))) as Json;
      const names = (json.nodes as Json[]).map((node) => node.name).join(", ");
      const channels = (json.animations?.[0]?.channels ?? []).length;
      setGlbInfo(`GLB ${view.getUint32(4, true)}.0 verified (sha256 ${digest}): ${(json.nodes as Json[]).length} nodes (${names}), ${channels} animation channels, ${json.extras?.mediaSpatial?.handedness} ${(json.extras?.mediaSpatial?.axisDirections ?? []).join("/")}.`);
    } catch { setGlbInfo("The GLB could not be read or parsed. Nothing is shown."); }
  };

  const manifest = result?.manifest as Json | undefined;
  const frames = (manifest?.frames ?? []) as Json[];
  const fps = manifest ? manifest.profile.fpsNumerator / manifest.profile.fpsDenominator : 24;
  const select = (index: number): void => {
    setFrame(index);
    const element = videoRef.current;
    if (element) { element.pause(); element.currentTime = (index + 0.5) / fps; }
  };
  const current = frames[frame];
  const limits = status?.limits as Json | undefined;

  return (
    <section className="rig" aria-labelledby="rig-title">
      <h2 id="rig-title">3D rig</h2>
      <p data-status-line aria-live="polite">{limits ? `Up to ${limits.maxWidth} by ${limits.maxHeight} pixels, ${limits.maxFrames} frames, ${limits.maxBones} bones; right-handed, Y-up, metres; the camera looks along -Z.` : "Reading the host limits…"}</p>
      <div className="animation-field">
        <label htmlFor="rig-spec">Rig render spec (JSON, media.dev.rig-render-spec.v1)</label>
        <textarea id="rig-spec" ref={specRef} className="rig-spec" spellCheck={false} value={specText} onChange={(event) => setSpecText(event.target.value)} aria-describedby="rig-spec-help" />
        <small id="rig-spec-help" className="animation-count">Rotations are axis-angle deltas from each bone's rest orientation; a joint limit is the allowed angular deviation from rest. Floor texture assets are exact artifact versions and need a processing rights statement.</small>
      </div>
      {parseError ? <p role="alert" className="animation-failure" data-parse-error>{parseError}</p> : null}
      <button type="button" onClick={() => { void render(); }} disabled={busy}>{busy ? "Rendering…" : "Render"}</button>
      <div aria-live="polite">
        {failure ? (
          <div role="alert" className="animation-failure" data-failure-code={failure.code} data-failure-path={typeof failure.details.path === "string" ? failure.details.path : undefined}>
            <h3 tabIndex={-1}>Not rendered: {failure.code}</h3>
            <p>{failure.message}{typeof failure.details.path === "string" ? ` Path ${failure.details.path}.` : ""}{typeof failure.details.requested === "number" ? ` Ceiling ${String(failure.details.ceiling)}, requested ${failure.details.requested}.` : ""}{typeof failure.details.verdict === "string" ? ` Rights verdict ${failure.details.verdict}.` : ""}{failure.status === 0 ? " The outcome is unknown; pressing Render again reuses the same request identifier." : ""}</p>
            <p>Nothing was rendered or registered.</p>
          </div>
        ) : null}
      </div>
      {result && manifest ? (
        <div className="rig-result" data-render-result role="region" aria-labelledby="rig-result-title">
          <h3 id="rig-result-title" ref={titleRef} tabIndex={-1}>Rendered rig</h3>
          <p data-render-summary>{`${frames.length} frames of ${manifest.profile.width} by ${manifest.profile.height} at ${manifest.profile.fpsNumerator}/${manifest.profile.fpsDenominator}`}{result.replayed ? " Replayed: the same request identifier returned the stored result." : ""}</p>
          <p data-verification>{`Verified before registration: ${manifest.verification.codec} ${manifest.verification.pixelFormat}, every frame time exact: ${manifest.verification.ptsExact ? "yes" : "no"}; decoded PSNR min ${fmt(manifest.quality.minPsnrDb, 2)} dB, mean ${fmt(manifest.quality.meanPsnrDb, 2)} dB.`}</p>
          <p>Frame set SHA-256: <code data-frame-set-sha256>{manifest.frameSetSha256}</code></p>
          <p>Coordinate frame: <span data-coordinate-frame>{`${manifest.coordinateFrame.handedness} ${manifest.coordinateFrame.axisDirections.join("/")} (Y up), metres`}</span></p>
          <div>
            <button type="button" onClick={() => { void loadVideo(); }}>Load the video (verify its SHA-256)</button>
            <p data-playback-status role="status">{playback}</p>
            {loaded.video ? <video ref={videoRef} src={loaded.video} controls muted data-verified-preview="rig-video" aria-label="Rendered 3D rig animation" /> : null}
          </div>
          <div className="animation-field">
            <label htmlFor="rig-frame">Frame {frame} of {frames.length - 1}</label>
            <input id="rig-frame" type="range" min={0} max={frames.length - 1} step={1} value={frame} onChange={(event) => select(Number(event.target.value))} />
          </div>
          <div className="animation-scroll" tabIndex={0} role="region" aria-label="Joint angles for the selected frame">
            <table className="rig-joints" data-joint-table>
              <caption>Joint angles at frame {frame} (degrees of deviation from rest, with each limit)</caption>
              <thead><tr><th scope="col">Bone</th><th scope="col">Angle</th><th scope="col">Limit</th><th scope="col">World position x, y, z (m)</th></tr></thead>
              <tbody>
                {(manifest.spec.bones as Json[]).map((bone) => (
                  <tr key={bone.id} data-bone={bone.id}>
                    <th scope="row">{bone.id}</th>
                    <td className="num" data-joint-angle={bone.id}>{fmt(current?.jointAnglesDegrees?.[bone.id], 2)}</td>
                    <td className="num">{fmt(bone.maxDeviationDegrees, 0)}</td>
                    <td className="num">{(current?.bones?.[bone.id]?.position ?? []).map((v: number) => fmt(v, 4)).join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <p data-end-effector>{`End effector (${current?.endEffector?.bone}) at ${(current?.endEffector?.world ?? []).map((v: number) => fmt(v, 4)).join(", ")} m, pixel ${fmt(current?.endEffector?.pixel?.x, 2)}, ${fmt(current?.endEffector?.pixel?.y, 2)}, depth ${fmt(current?.endEffector?.pixel?.depth, 3)} m; frame PSNR ${fmt(current?.psnrDb, 2)} dB.`}</p>
          <div>
            <button type="button" onClick={() => { void verifyGlb(); }}>Verify the GLB export</button>
            <p data-glb-status role="status">{glbInfo}</p>
          </div>
          <p>Artifacts: video <code>{result.video.artifactId}</code>, GLB <code data-glb-id>{result.glb.artifactId}</code>, manifest <code>{result.manifestArtifact.artifactId}</code>.</p>
          <p>{result.note}</p>
        </div>
      ) : null}
    </section>
  );
}

const byId = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element: ${id}`);
  return node as T;
};
const tokenInput = byId<HTMLInputElement>("dev-token");
const connectButton = byId<HTMLFormElement>("connect-form").querySelector<HTMLButtonElement>("button[type=submit]")!;
const disconnectButton = byId<HTMLButtonElement>("disconnect");
const connection = byId<HTMLParagraphElement>("connection-status");
const root: Root = createRoot(byId<HTMLDivElement>("rig-root"));
let bearerToken: string | null = null;

const forget = (): void => { bearerToken = null; root.render(null); };
byId<HTMLFormElement>("connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = tokenInput.value.trim();
  if (!raw) return;
  bearerToken = raw;
  tokenInput.value = "";
  tokenInput.disabled = true;
  connectButton.disabled = true;
  disconnectButton.disabled = false;
  connection.textContent = "Validating DEV_ONLY identity…";
  try {
    const response = await fetch(`${origin}/dev/v1/context`, { headers: { Authorization: `Bearer ${bearerToken}` } });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "DEV_ONLY identity was denied." : `Host context failed (${response.status}).`);
    const context: unknown = await response.json();
    if (!context || typeof context !== "object" || (context as { scope?: unknown }).scope !== "DEV_ONLY") throw new TypeError("Host returned an invalid DEV_ONLY context.");
    connection.textContent = "Connected to local DEV_ONLY host. Each lane is subject to the host's owner and artifact permissions.";
    root.render(<RigPanel port={createDevRigClient({ origin, bearerToken: () => bearerToken ?? "" })} />);
  } catch (error) {
    forget();
    connection.textContent = error instanceof Error ? error.message : "Unable to connect.";
    tokenInput.disabled = false; connectButton.disabled = false; disconnectButton.disabled = true;
  }
});
disconnectButton.addEventListener("click", () => {
  forget();
  tokenInput.disabled = false; connectButton.disabled = false; disconnectButton.disabled = true;
  connection.textContent = "Disconnected. In-memory token cleared.";
});
window.addEventListener("beforeunload", forget);
