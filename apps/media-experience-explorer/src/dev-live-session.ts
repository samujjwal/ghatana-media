/**
 * DEV_ONLY live capture page (J-29). A synthetic WebAudio oscillator (no microphone) is captured by an AudioWorklet,
 * cut into 960-sample (20 ms at 48 kHz) PCM16 frames, and streamed to /dev/v1/live-sessions with a sequence number, an
 * exact PTS in samples and a CRC-32 per frame. The page keeps every frame until the host acknowledges it, resumes from the
 * host's acknowledged prefix after a network error, and treats a typed terminal answer (revoked, expired, aborted,
 * unknown) as the end of the session: it stops capturing and never reports a stored result it did not receive. After the
 * host has stored the stream the page reads the stored WAV back and compares it byte for byte with what it sent.
 */
const origin = window.location.origin;
const RATE = 48_000;
const FRAME_SAMPLES = 960;
const FRAME_BYTES = FRAME_SAMPLES * 2;
const MAX_BATCH_FRAMES = 40;
const SEND_INTERVAL_MS = 200;

const byId = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element: ${id}`);
  return node as T;
};
const field = (selector: string): HTMLElement => {
  const node = document.querySelector<HTMLElement>(selector);
  if (!node) throw new Error(`Missing page element: ${selector}`);
  return node;
};

let bearerToken: string | null = null;
const connectForm = byId<HTMLFormElement>("connect-form");
const tokenInput = byId<HTMLInputElement>("dev-token");
const disconnectButton = byId<HTMLButtonElement>("disconnect");
const connectionStatus = byId<HTMLParagraphElement>("connection-status");
const panel = byId<HTMLElement>("live-panel");
const liveForm = byId<HTMLFormElement>("live-form");
const startButton = byId<HTMLButtonElement>("live-start");
const stopButton = byId<HTMLButtonElement>("live-stop");
const abortButton = byId<HTMLButtonElement>("live-abort");
const statusLine = byId<HTMLParagraphElement>("live-status");
const failureBox = byId<HTMLDivElement>("live-failure");
const resultBox = byId<HTMLElement>("live-result");

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n += 1) {
    let c = n;
    for (let k = 0; k < 8; k += 1) c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();
const crc32 = (bytes: Uint8Array): number => {
  let c = 0xffffffff;
  for (let i = 0; i < bytes.length; i += 1) c = crcTable[(c ^ bytes[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
const hex = (buffer: ArrayBuffer): string => [...new Uint8Array(buffer)].map((b) => b.toString(16).padStart(2, "0")).join("");
const sleep = (ms: number): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, ms));

interface HostError { readonly status: number; readonly code: string; readonly message: string; }
class HostFailure extends Error {
  constructor(readonly info: HostError) { super(info.message); }
}

async function call(method: "GET" | "POST", path: string, body?: BodyInit, contentType?: string, extra?: Record<string, string>): Promise<{ status: number; json: any }> {
  if (!bearerToken) throw new HostFailure({ status: 0, code: "NOT_CONNECTED", message: "Connect a DEV_ONLY token first." });
  const headers: Record<string, string> = { Authorization: `Bearer ${bearerToken}`, Accept: "application/json", ...extra };
  if (contentType) headers["Content-Type"] = contentType;
  const response = await fetch(`${origin}${path}`, { method, headers, body, credentials: "omit", redirect: "error", cache: "no-store" });
  let json: any = null;
  try { json = await response.json(); } catch { /* typed below */ }
  if (!response.ok) {
    throw new HostFailure({ status: response.status, code: json?.error?.code ?? "HTTP_ERROR", message: json?.error?.message ?? `The host answered ${response.status}.` });
  }
  return { status: response.status, json };
}

interface Live {
  sessionId: string;
  frames: Uint8Array[];
  pending: Int16Array;
  pendingFill: number;
  acked: number;
  buffered: number;
  duplicates: number;
  networkErrors: number;
  leaseMillis: number;
  state: string;
  context: AudioContext | null;
  oscillator: OscillatorNode | null;
  timer: number | null;
  sending: boolean;
  ended: boolean;
  closing: boolean;
}
let live: Live | null = null;

const text = (selector: string, value: string): void => { field(selector).textContent = value; };
const render = (): void => {
  if (!live) return;
  text("[data-session-id]", live.sessionId);
  text("[data-state]", live.state);
  text("[data-captured]", String(live.frames.length));
  text("[data-acked]", String(live.acked));
  text("[data-buffered]", String(live.buffered));
  text("[data-duplicates]", String(live.duplicates));
  text("[data-network-errors]", String(live.networkErrors));
  text("[data-lease]", String(live.leaseMillis));
};

const showFailure = (code: string, message: string): void => {
  failureBox.hidden = false;
  failureBox.setAttribute("data-failure-code", code);
  failureBox.textContent = `${code}: ${message}`;
};

const applySession = (session: any): void => {
  if (!live || !session) return;
  live.state = String(session.state);
  live.acked = Number(session.ackedThroughSequence);
  live.buffered = Number(session.bufferedFrames);
  live.duplicates = Number(session.duplicateFrames);
  live.leaseMillis = Number(session.leaseMillisRemaining);
  render();
};

const terminal = async (error: HostFailure): Promise<void> => {
  if (!live) return;
  // A typed terminal outcome: stop capturing, say exactly what the host said, never claim a result.
  live.ended = true;
  live.state = /^SESSION_/u.test(error.info.code) ? error.info.code.replace("SESSION_", "") : error.info.code;
  stopCapture();
  render();
  showFailure(error.info.code, error.info.message);
  statusLine.textContent = `The host ended this session (${error.info.code}). Nothing was stored.`;
  startButton.disabled = false; stopButton.disabled = true; abortButton.disabled = true;
};

const stopCapture = (): void => {
  if (!live) return;
  if (live.timer !== null) { window.clearInterval(live.timer); live.timer = null; }
  try { live.oscillator?.stop(); } catch { /* already stopped */ }
  void live.context?.close().catch(() => undefined);
  live.oscillator = null; live.context = null;
};

const record = (sequence: number, payload: Uint8Array): Uint8Array => {
  const out = new Uint8Array(24 + payload.length);
  const view = new DataView(out.buffer);
  view.setBigUint64(0, BigInt(sequence));
  view.setBigUint64(8, BigInt(sequence) * BigInt(FRAME_SAMPLES));
  view.setUint32(16, payload.length);
  view.setUint32(20, crc32(payload));
  out.set(payload, 24);
  return out;
};

async function pump(): Promise<void> {
  const current = live;
  if (!current || current.sending || current.ended) return;
  current.sending = true;
  try {
    const from = current.acked + 1;
    const to = Math.min(current.frames.length, from + MAX_BATCH_FRAMES);
    if (to > from) {
      const parts: Uint8Array[] = [];
      for (let seq = from; seq < to; seq += 1) parts.push(record(seq, current.frames[seq]!));
      const body = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let offset = 0;
      for (const part of parts) { body.set(part, offset); offset += part.length; }
      const { json } = await call("POST", `/dev/v1/live-sessions/${encodeURIComponent(current.sessionId)}/frames`, body, "application/octet-stream");
      applySession(json.session);
    } else {
      const { json } = await call("GET", `/dev/v1/live-sessions/${encodeURIComponent(current.sessionId)}`);
      applySession(json);
    }
    statusLine.textContent = `Streaming: ${current.frames.length} frames captured, ${current.acked + 1} acknowledged.`;
  } catch (error) {
    if (error instanceof HostFailure && error.info.status === 0) { /* not connected */ }
    else if (error instanceof HostFailure && (error.info.status === 429 || error.info.status === 503)) {
      statusLine.textContent = `The host asked this page to slow down (${error.info.code}); retrying from the acknowledged frame.`;
    } else if (error instanceof HostFailure) {
      await terminal(error);
    } else {
      // The request did not complete (offline, reset): ask the host what it holds, then resume from there.
      current.networkErrors += 1;
      statusLine.textContent = "The network dropped; resuming from the host's acknowledged frame.";
      try {
        const { json } = await call("GET", `/dev/v1/live-sessions/${encodeURIComponent(current.sessionId)}`);
        applySession(json);
      } catch (again) {
        if (again instanceof HostFailure && again.info.status !== 0) await terminal(again);
      }
    }
    render();
  } finally {
    current.sending = false;
  }
}

async function startCapture(): Promise<void> {
  failureBox.hidden = true; failureBox.textContent = ""; failureBox.removeAttribute("data-failure-code");
  resultBox.hidden = true;
  const consentId = byId<HTMLInputElement>("live-consent-id").value.trim();
  const consentVersion = byId<HTMLInputElement>("live-consent-version").value.trim();
  if (!consentId || !consentVersion) {
    showFailure("LIVE_REQUEST_INVALID", "A consent subject artifact id and version are required. Nothing was started.");
    byId<HTMLInputElement>(consentId ? "live-consent-version" : "live-consent-id").focus();
    return;
  }
  const frequency = Number(byId<HTMLInputElement>("live-frequency").value);
  const lease = Number(byId<HTMLInputElement>("live-lease").value);
  startButton.disabled = true;
  statusLine.textContent = "Opening the session…";
  let created: any;
  try {
    ({ json: created } = await call("POST", "/dev/v1/live-sessions", JSON.stringify({
      requestId: `explorer-live-${crypto.randomUUID()}`,
      consent: { artifactId: consentId, artifactVersionId: consentVersion, scope: byId<HTMLSelectElement>("live-scope").value },
      format: { sampleRate: RATE, channels: 1, samplesPerFrame: FRAME_SAMPLES },
      startPtsSamples: 0, reorderWindowFrames: 16, leaseSeconds: lease,
    }), "application/json"));
  } catch (error) {
    startButton.disabled = false;
    if (error instanceof HostFailure) { showFailure(error.info.code, error.info.message); statusLine.textContent = "The host did not open a session."; }
    else showFailure("TRANSPORT_ERROR", "The local Media host did not answer.");
    failureBox.focus();
    return;
  }
  live = { sessionId: created.sessionId, frames: [], pending: new Int16Array(FRAME_SAMPLES), pendingFill: 0, acked: -1, buffered: 0, duplicates: 0,
    networkErrors: 0, leaseMillis: 0, state: created.state, context: null, oscillator: null, timer: null, sending: false, ended: false, closing: false };
  applySession(created);
  const current = live;
  const context = new AudioContext({ sampleRate: RATE, latencyHint: "interactive" });
  await context.resume();
  await context.audioWorklet.addModule(new URL("./dev-live-capture-worklet.js", import.meta.url).href);
  const oscillator = context.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.value = frequency;
  const gain = context.createGain();
  gain.gain.value = 0.5;
  const capture = new AudioWorkletNode(context, "live-capture", { numberOfInputs: 1, numberOfOutputs: 1 });
  const mute = context.createGain();
  mute.gain.value = 0;
  oscillator.connect(gain).connect(capture).connect(mute).connect(context.destination);
  capture.port.onmessage = (event: MessageEvent<Float32Array>): void => {
    if (current.ended || current.closing) return;
    for (const sample of event.data) {
      current.pending[current.pendingFill] = Math.max(-32768, Math.min(32767, Math.round(sample * 32767)));
      current.pendingFill += 1;
      if (current.pendingFill === FRAME_SAMPLES) {
        current.frames.push(new Uint8Array(current.pending.slice().buffer));
        current.pendingFill = 0;
      }
    }
  };
  current.context = context; current.oscillator = oscillator;
  oscillator.start();
  current.timer = window.setInterval(() => { void pump(); }, SEND_INTERVAL_MS);
  stopButton.disabled = false; abortButton.disabled = false;
  statusLine.textContent = "Capturing a synthetic tone and streaming.";
}

async function stopAndStore(): Promise<void> {
  const current = live;
  if (!current || current.ended) return;
  stopButton.disabled = true; abortButton.disabled = true;
  current.closing = true;
  stopCapture();
  statusLine.textContent = "Sending the remaining frames…";
  const last = current.frames.length - 1;
  const deadline = Date.now() + 60_000;
  while (!current.ended && current.acked < last && Date.now() < deadline) { await pump(); await sleep(50); }
  if (current.ended) return;
  if (current.acked < last) { showFailure("STREAM_INCOMPLETE", "The host did not acknowledge every frame in time. Nothing was stored."); return; }
  statusLine.textContent = "Ending the stream…";
  try {
    const { json } = await call("POST", `/dev/v1/live-sessions/${encodeURIComponent(current.sessionId)}/eos`, JSON.stringify({ finalSequence: last }), "application/json");
    current.ended = true;
    current.state = json.state;
    applySession(json);
    const sent = new Uint8Array(current.frames.length * FRAME_BYTES);
    current.frames.forEach((frame, index) => sent.set(frame, index * FRAME_BYTES));
    const sentSha = hex(await crypto.subtle.digest("SHA-256", sent));
    text("[data-wav-id]", json.outputs.wav.artifactId);
    text("[data-index-id]", json.outputs.ptsIndex.artifactId);
    text("[data-stored-frames]", String(json.outputs.frameCount));
    text("[data-host-sha]", json.outputs.pcmSha256);
    text("[data-sent-sha256]", sentSha);
    // Read the stored WAV back by its exact version and compare it with what was sent, byte for byte.
    const content = await fetch(`${origin}/dev/v1/artifacts/${encodeURIComponent(json.outputs.wav.artifactId)}/content`, {
      headers: { Authorization: `Bearer ${bearerToken}`, "If-Match": json.outputs.wav.artifactVersionId }, credentials: "omit", cache: "no-store" });
    const wav = new Uint8Array(await content.arrayBuffer());
    const stored = wav.subarray(44, 44 + sent.length);
    const same = content.ok && stored.length === sent.length && stored.every((value, index) => value === sent[index]);
    text("[data-verified]", same ? `yes (${sent.length / 2} samples)` : "NO");
    resultBox.hidden = false;
    byId<HTMLElement>("live-result-heading").focus();
    statusLine.textContent = same ? "Stored. The stored audio equals what this page sent." : "Stored, but the read-back did not match what was sent.";
    startButton.disabled = false;
  } catch (error) {
    if (error instanceof HostFailure && error.info.status !== 429 && error.info.status !== 503) await terminal(error);
    else { showFailure("OUTCOME_UNKNOWN", "The end-of-stream outcome is unknown; reload the session before retrying."); startButton.disabled = false; }
  }
}

async function abort(): Promise<void> {
  const current = live;
  if (!current || current.ended) return;
  stopCapture();
  current.ended = true;
  try {
    const { json } = await call("POST", `/dev/v1/live-sessions/${encodeURIComponent(current.sessionId)}/abort`);
    current.state = json.state;
    render();
    statusLine.textContent = "Aborted. The received audio was discarded and nothing was stored.";
  } catch (error) {
    if (error instanceof HostFailure) showFailure(error.info.code, error.info.message);
  }
  startButton.disabled = false; stopButton.disabled = true; abortButton.disabled = true;
}

connectForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = tokenInput.value.trim();
  if (!raw) return;
  bearerToken = raw;
  tokenInput.value = ""; tokenInput.disabled = true; disconnectButton.disabled = false;
  connectionStatus.textContent = "Validating DEV_ONLY identity…";
  try {
    const { json } = await call("GET", "/dev/v1/live-sessions/status");
    if (json?.scope !== "DEV_ONLY") throw new TypeError("Host returned an invalid DEV_ONLY status.");
    connectionStatus.textContent = `Connected to local DEV_ONLY host. Frames of ${json.limits.samplesPerFrame[0]}..${json.limits.samplesPerFrame[1]} samples, lease up to ${json.limits.leaseSeconds[1]} s.`;
    panel.hidden = false;
  } catch (error) {
    bearerToken = null;
    tokenInput.disabled = false; disconnectButton.disabled = true;
    connectionStatus.textContent = error instanceof HostFailure && (error.info.status === 401 || error.info.status === 403) ? "DEV_ONLY identity was denied." : "Unable to connect.";
  }
});
disconnectButton.addEventListener("click", () => {
  stopCapture(); bearerToken = null; panel.hidden = true;
  tokenInput.disabled = false; disconnectButton.disabled = true;
  connectionStatus.textContent = "Disconnected. In-memory token cleared.";
});
liveForm.addEventListener("submit", (event) => { event.preventDefault(); void startCapture(); });
stopButton.addEventListener("click", () => { void stopAndStore(); });
abortButton.addEventListener("click", () => { void abort(); });
window.addEventListener("beforeunload", () => { stopCapture(); bearerToken = null; });
