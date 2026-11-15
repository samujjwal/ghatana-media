import React from "react";
import {
  formatDb, formatSigned, formatSsim, frameAt, metricSeries,
  type MetricName, type VideoComparisonDocument, type VideoSubject,
} from "./devVideoComparison";

export interface VideoWipeComparisonProps {
  readonly document: VideoComparisonDocument;
  /** Verified object URLs by subject label. A subject with no URL is listed in the chart but cannot be played. */
  readonly videoUrls: Readonly<Record<string, string>>;
}

const METRICS: readonly { readonly id: MetricName; readonly label: string; readonly unit: string; readonly needsReference: boolean }[] = [
  { id: "psnrY", label: "PSNR (luma)", unit: "dB", needsReference: true },
  { id: "ssimY", label: "SSIM (luma)", unit: "", needsReference: true },
  { id: "noiseSigmaY", label: "Noise sigma estimate", unit: "", needsReference: false },
  { id: "laplacianVarianceY", label: "Laplacian variance (sharpness, noise raises it)", unit: "", needsReference: false },
];
const DASH: readonly string[] = ["", "7 4", "2 3"];
const WIDTH = 640;
const HEIGHT = 220;
const PAD = { left: 52, right: 12, top: 12, bottom: 34 } as const;

function nice(value: number): number { return Math.abs(value) >= 100 ? Math.round(value) : Math.round(value * 100) / 100; }

/**
 * Side-by-side and wipe comparison of two registered video versions with a per-frame metrics chart.
 *
 * Playback of the two videos is kept in lock-step on the shared presentation timeline; stepping and seeking use the
 * exact per-frame presentation times of the measured document. The chart plots exactly the numbers the host
 * measured (frames without a measurement are gaps, never zeros) and a regression is drawn like any other value, plus
 * a marker row for every frame where the candidate is worse than the baseline. All of it is keyboard operable and
 * has a data-table alternative.
 */
export function VideoWipeComparison({ document: comparison, videoUrls }: VideoWipeComparisonProps): React.ReactElement {
  const subjects = comparison.subjects;
  const [candidateIndex, setCandidateIndex] = React.useState(subjects.length > 1 ? 1 : 0);
  const [mode, setMode] = React.useState<"wipe" | "side-by-side">("wipe");
  const [wipe, setWipe] = React.useState(50);
  const [metric, setMetric] = React.useState<MetricName>(comparison.reference ? "psnrY" : "noiseSigmaY");
  const [frame, setFrame] = React.useState(0);
  const [playing, setPlaying] = React.useState(false);
  const baseline = subjects[0]!;
  const candidate = subjects[candidateIndex]!;
  const baselineVideo = React.useRef<HTMLVideoElement | null>(null);
  const candidateVideo = React.useRef<HTMLVideoElement | null>(null);
  const frames = baseline.frames;
  const lastFrame = frames.length - 1;

  const seconds = (index: number): number => frames[Math.max(0, Math.min(lastFrame, index))]!.ptsMicros / 1_000_000;

  const seekTo = React.useCallback((index: number): void => {
    const clamped = Math.max(0, Math.min(lastFrame, index));
    // Land in the middle of the frame interval so the presented frame is unambiguously this one.
    const next = frames[clamped + 1];
    const start = frames[clamped]!.ptsMicros;
    const target = (start + (next ? Math.min(2_000, (next.ptsMicros - start) / 2) : 0)) / 1_000_000;
    for (const video of [baselineVideo.current, candidateVideo.current]) {
      if (video) { video.pause(); video.currentTime = target; }
    }
    setPlaying(false);
    setFrame(clamped);
  }, [frames, lastFrame]);

  const frameFromTime = React.useCallback((time: number): number => {
    const found = frameAt(baseline, Math.round(time * 1_000_000));
    return found.frameIndex;
  }, [baseline]);

  React.useEffect(() => {
    const master = baselineVideo.current;
    const follower = candidateVideo.current;
    if (!master) return undefined;
    const onTime = (): void => {
      if (follower && Math.abs(follower.currentTime - master.currentTime) > 0.06) follower.currentTime = master.currentTime;
    };
    const onPause = (): void => { follower?.pause(); setPlaying(false); setFrame(frameFromTime(master.currentTime)); };
    const onPlay = (): void => { void follower?.play().catch(() => undefined); setPlaying(true); };
    const onSeeked = (): void => { if (master.paused) setFrame(frameFromTime(master.currentTime)); };
    master.addEventListener("timeupdate", onTime);
    master.addEventListener("pause", onPause);
    master.addEventListener("ended", onPause);
    master.addEventListener("play", onPlay);
    master.addEventListener("seeked", onSeeked);
    return () => {
      master.removeEventListener("timeupdate", onTime);
      master.removeEventListener("pause", onPause);
      master.removeEventListener("ended", onPause);
      master.removeEventListener("play", onPlay);
      master.removeEventListener("seeked", onSeeked);
    };
  }, [frameFromTime, candidateIndex, videoUrls]);

  const togglePlay = (): void => {
    const master = baselineVideo.current;
    if (!master) return;
    if (master.paused) { void master.play().catch(() => undefined); } else { master.pause(); }
  };

  const here = frames[frame]!;
  const mine = (subject: VideoSubject): VideoSubject["frames"][number] | undefined =>
    subject.frames.find((candidateFrame) => candidateFrame.ptsMicros === here.ptsMicros) ?? frameAt(subject, here.ptsMicros);
  const baseNow = mine(baseline)!;
  const candNow = mine(candidate)!;
  const describeFrame = (label: string, f: NonNullable<ReturnType<typeof mine>>): string =>
    `${label}: ${comparison.reference && f.aligned ? `PSNR ${formatDb(f.psnrY)}, SSIM ${formatSsim(f.ssimY)}, ` : ""}noise sigma ${f.noiseSigmaY.toFixed(2)}`;

  // ---- chart geometry ----
  const spec = METRICS.find((entry) => entry.id === metric)!;
  const plotted = subjects.map((subject) => metricSeries(subject, metric));
  const all = plotted.flat();
  const minX = frames[0]!.ptsMicros;
  const maxX = Math.max(frames[lastFrame]!.ptsMicros, minX + 1);
  let minY = all.length ? Math.min(...all.map((p) => p.value)) : 0;
  let maxY = all.length ? Math.max(...all.map((p) => p.value)) : 1;
  if (maxY - minY < 1e-9) { minY -= 0.5; maxY += 0.5; }
  const padY = (maxY - minY) * 0.08;
  minY -= padY; maxY += padY;
  const x = (micros: number): number => PAD.left + ((micros - minX) / (maxX - minX)) * (WIDTH - PAD.left - PAD.right);
  const y = (value: number): number => PAD.top + (1 - (value - minY) / (maxY - minY)) * (HEIGHT - PAD.top - PAD.bottom);
  const path = (series: readonly { readonly ptsMicros: number; readonly value: number }[]): string =>
    series.map((p, i) => `${i === 0 ? "M" : "L"}${x(p.ptsMicros).toFixed(1)} ${y(p.value).toFixed(1)}`).join(" ");
  const ticks = [0, 1, 2, 3, 4].map((i) => minY + ((maxY - minY) * i) / 4);

  // Frames where the candidate is worse than the baseline on the chosen reference metric.
  const worse: number[] = [];
  if (spec.needsReference && candidateIndex !== 0) {
    const baseByPts = new Map(baseline.frames.map((f) => [f.ptsMicros, f] as const));
    candidate.frames.forEach((f, index) => {
      const b = baseByPts.get(f.ptsMicros);
      const a = f[metric as "psnrY" | "ssimY"];
      const c = b?.[metric as "psnrY" | "ssimY"];
      if (a !== null && a !== undefined && c !== null && c !== undefined && a < c) worse.push(index);
    });
  }
  const delta = comparison.comparisons.find((entry) => entry.subject === candidate.label && entry.baseline === baseline.label);

  const chartLabel = `${spec.label} per frame for ${subjects.map((s) => s.label).join(", ")}. ${
    subjects.map((s, i) => { const v = plotted[i]!; return v.length ? `${s.label} ranges ${nice(Math.min(...v.map((p) => p.value)))} to ${nice(Math.max(...v.map((p) => p.value)))}` : `${s.label} has no values`; }).join("; ")}.`;
  const baseUrl = videoUrls[baseline.label];
  const candUrl = videoUrls[candidate.label];

  return <section className="vwc" aria-label="Video comparison" data-frame={frame} data-mode={mode}>
    <div className="vwc-controls">
      {subjects.length > 2 && <label>Compare against
        <select value={candidateIndex} onChange={(event) => setCandidateIndex(Number(event.currentTarget.value))}>
          {subjects.slice(1).map((s, i) => <option key={s.label} value={i + 1}>{s.label}</option>)}
        </select></label>}
      <fieldset className="vwc-mode"><legend>View</legend>
        <label><input type="radio" name="vwc-mode" checked={mode === "wipe"} onChange={() => setMode("wipe")} /> Wipe</label>
        <label><input type="radio" name="vwc-mode" checked={mode === "side-by-side"} onChange={() => setMode("side-by-side")} /> Side by side</label>
      </fieldset>
    </div>
    {baseUrl && candUrl ? <div className={mode === "wipe" ? "vwc-stage vwc-wipe" : "vwc-stage vwc-side"} data-testid="vwc-stage">
      <figure className="vwc-pane vwc-base">
        <video ref={baselineVideo} src={baseUrl} muted playsInline preload="auto" aria-label={`${baseline.label} video (baseline)`} />
        <figcaption>{baseline.label} (baseline)</figcaption>
      </figure>
      <figure className="vwc-pane vwc-cand" style={mode === "wipe" ? { clipPath: `inset(0 ${100 - wipe}% 0 0)` } : undefined}>
        <video ref={candidateVideo} src={candUrl} muted playsInline preload="auto" aria-label={`${candidate.label} video (candidate)`} />
        <figcaption>{candidate.label}</figcaption>
      </figure>
      {mode === "wipe" && <div className="vwc-divider" aria-hidden="true" style={{ left: `${wipe}%` }} />}
    </div> : <p role="alert">The verified video bytes for these subjects are not available, so only the measured numbers are shown.</p>}
    {mode === "wipe" && baseUrl && candUrl && <div className="vwc-row">
      <label htmlFor="vwc-wipe">{`Wipe position: ${wipe}% shows ${candidate.label}, the rest shows ${baseline.label}`}</label>
      <input id="vwc-wipe" type="range" min={0} max={100} step={1} value={wipe} aria-valuetext={`${wipe}% ${candidate.label}, ${100 - wipe}% ${baseline.label}`} onChange={(event) => setWipe(Number(event.currentTarget.value))} />
    </div>}
    <div className="vwc-row vwc-transport">
      <button type="button" disabled={!baseUrl} onClick={() => seekTo(frame - 1)} aria-label="Previous frame">◀ Frame</button>
      <button type="button" disabled={!baseUrl} onClick={togglePlay} aria-pressed={playing}>{playing ? "Pause" : "Play"}</button>
      <button type="button" disabled={!baseUrl} onClick={() => seekTo(frame + 1)} aria-label="Next frame">Frame ▶</button>
      <label htmlFor="vwc-frame">Frame</label>
      <input id="vwc-frame" type="range" min={0} max={lastFrame} step={1} value={frame} aria-valuetext={`Frame ${frame + 1} of ${frames.length} at ${seconds(frame).toFixed(3)} seconds`} onChange={(event) => seekTo(Number(event.currentTarget.value))} />
    </div>
    <p id="vwc-frame-status" role="status" aria-live="polite" aria-atomic="true" data-frame-index={frame}>
      {`Frame ${frame + 1} of ${frames.length} at ${seconds(frame).toFixed(3)} s. ${describeFrame(baseline.label, baseNow)}. ${candidateIndex === 0 ? "" : describeFrame(candidate.label, candNow) + "."}`}
    </p>
    <fieldset className="vwc-metric"><legend>Chart metric</legend>
      {METRICS.filter((entry) => !entry.needsReference || comparison.reference).map((entry) =>
        <label key={entry.id}><input type="radio" name="vwc-metric" checked={metric === entry.id} onChange={() => setMetric(entry.id)} /> {entry.label}</label>)}
    </fieldset>
    <svg className="vwc-chart" viewBox={`0 0 ${WIDTH} ${HEIGHT}`} role="img" aria-label={chartLabel} data-metric={metric}
      onClick={(event) => {
        const rect = event.currentTarget.getBoundingClientRect();
        if (rect.width <= 0) return;
        const px = ((event.clientX - rect.left) / rect.width) * WIDTH;
        const micros = minX + ((px - PAD.left) / (WIDTH - PAD.left - PAD.right)) * (maxX - minX);
        seekTo(frameAt(baseline, micros).frameIndex);
      }}>
      {ticks.map((tick) => <g key={tick}><line className="vwc-grid" x1={PAD.left} x2={WIDTH - PAD.right} y1={y(tick)} y2={y(tick)} /><text className="vwc-tick" x={PAD.left - 6} y={y(tick) + 4} textAnchor="end">{nice(tick)}</text></g>)}
      <text className="vwc-axis" x={(PAD.left + WIDTH - PAD.right) / 2} y={HEIGHT - 4} textAnchor="middle">presentation time (s)</text>
      <text className="vwc-tick" x={PAD.left} y={HEIGHT - 18}>{(minX / 1_000_000).toFixed(2)}</text>
      <text className="vwc-tick" x={WIDTH - PAD.right} y={HEIGHT - 18} textAnchor="end">{(maxX / 1_000_000).toFixed(2)}</text>
      {plotted.map((series, i) => <path key={subjects[i]!.label} className={`vwc-line vwc-s${i}`} d={path(series)} fill="none" strokeDasharray={DASH[i]} data-subject={subjects[i]!.label} />)}
      {worse.map((index) => <rect key={index} className="vwc-worse" x={x(candidate.frames[index]!.ptsMicros) - 1.5} y={HEIGHT - PAD.bottom + 2} width={3} height={6} data-frame={index} />)}
      <line className="vwc-playhead" x1={x(here.ptsMicros)} x2={x(here.ptsMicros)} y1={PAD.top} y2={HEIGHT - PAD.bottom} />
    </svg>
    <ul className="vwc-legend" aria-label="Chart legend">
      {subjects.map((s, i) => <li key={s.label}><svg width="34" height="10" aria-hidden="true"><line x1="0" x2="34" y1="5" y2="5" className={`vwc-line vwc-s${i}`} strokeDasharray={DASH[i]} /></svg> {s.label}</li>)}
      {worse.length > 0 && <li><svg width="10" height="10" aria-hidden="true"><rect className="vwc-worse" width="10" height="10" /></svg> {`${candidate.label} is worse than ${baseline.label} on this metric at ${worse.length} frame${worse.length === 1 ? "" : "s"}`}</li>}
    </ul>
    {delta && <p id="vwc-verdict" data-verdict={delta.verdict}>
      {`${candidate.label} vs ${baseline.label}: ${delta.verdict}. ${delta.meanPsnrYDeltaDb !== null ? `Mean PSNR ${formatSigned(delta.meanPsnrYDeltaDb, 2, " dB")}, mean SSIM ${formatSigned(delta.meanSsimYDelta, 4, "")} over ${delta.comparedFrames} frames (PSNR better in ${delta.framesPsnrImproved}, worse in ${delta.framesPsnrRegressed}). ` : "No reference was supplied, so no PSNR or SSIM is reported. "}Noise sigma ${formatSigned(delta.meanNoiseSigmaYDelta, 2, "")}, Laplacian variance ${formatSigned(delta.meanLaplacianVarianceYDelta, 1, "")}.`}
    </p>}
    <details className="vwc-table"><summary>Per-frame data table</summary>
      <table><caption>{`${spec.label} per frame`}</caption>
        <thead><tr><th scope="col">Frame</th><th scope="col">Time (s)</th>{subjects.map((s) => <th key={s.label} scope="col">{s.label}</th>)}</tr></thead>
        <tbody>{frames.map((f, index) => <tr key={f.ptsMicros} aria-current={index === frame ? "true" : undefined}>
          <th scope="row">{index + 1}</th><td>{(f.ptsMicros / 1_000_000).toFixed(3)}</td>
          {subjects.map((s) => { const m = s.frames.find((c) => c.ptsMicros === f.ptsMicros); const v = m ? m[metric] : null; return <td key={s.label}>{v === null || v === undefined ? "n/a" : v}</td>; })}
        </tr>)}</tbody></table>
    </details>
  </section>;
}
