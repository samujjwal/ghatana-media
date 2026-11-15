import { sha256 } from "@noble/hashes/sha2.js";
import { hashFileSha256 } from "./dev-artifact-hasher";

/**
 * DEV_ONLY resumable upload page. The token lives in page memory only. Progress is what the SERVER acknowledged: after
 * any interruption (pause, lost connection, host restart) the page re-reads the upload session and continues from the
 * server's next chunk index, so no acknowledged chunk is sent again and none is skipped. Each chunk carries its own
 * SHA-256 so corruption in transit is refused by the host before anything is appended.
 */
const origin = window.location.origin;
const byId = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element: ${id}`);
  return node as T;
};
const tokenInput = byId<HTMLInputElement>("dev-token");
const connectButton = byId<HTMLFormElement>("connect-form").querySelector<HTMLButtonElement>("button[type=submit]")!;
const disconnectButton = byId<HTMLButtonElement>("disconnect");
const connectionStatus = byId<HTMLParagraphElement>("connection-status");
const fileInput = byId<HTMLInputElement>("file");
const lineageInput = byId<HTMLInputElement>("lineage");
const chunkSelect = byId<HTMLSelectElement>("chunk-size");
const paceInput = byId<HTMLInputElement>("pace");
const startButton = byId<HTMLButtonElement>("start");
const pauseButton = byId<HTMLButtonElement>("pause");
const resumeButton = byId<HTMLButtonElement>("resume");
const progress = byId<HTMLProgressElement>("progress");
const progressText = byId<HTMLParagraphElement>("progress-text");
const uploadError = byId<HTMLParagraphElement>("upload-error");
const versionsBody = byId<HTMLTableSectionElement>("versions-body");
const registerStatus = byId<HTMLParagraphElement>("register-status");
const basisInput = byId<HTMLInputElement>("basis");
const attestButton = byId<HTMLButtonElement>("attest");
const rightsStatus = byId<HTMLParagraphElement>("rights-status");

interface HostContext { tenantId: string; principalId: string; }
interface Session { uploadId: string; status: string; nextChunkIndex: number; bytesReceived: number; }
interface Version {
  versionNumber: number; parentArtifactVersionId: string | null; artifactId: string; artifactVersionId: string; sha256: string;
  sizeBytes: number; probe: { format?: { durationSeconds?: number }; streams?: { codecType: string; codecName: string }[] } | null;
  processingAdmission: { verdict: string; usableForProcessing: boolean; reasons: string[] };
}
class HostError extends Error {
  constructor(readonly code: string, readonly status: number, message: string) { super(message); }
}

let token: string | null = null;
let context: HostContext | null = null;
let maxChunkBytes = 0;
let file: File | null = null;
let fileSha = "";
let session: Session | null = null;
let paused = false;
let running = false;
let latestVersion: Version | null = null;
let lineageId = "";
const delay = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));

async function call(method: string, path: string, body?: unknown, extra: Record<string, string> = {}, raw?: Uint8Array): Promise<unknown> {
  if (!token || !context) throw new HostError("NOT_CONNECTED", 0, "Connect with a DEV_ONLY token first.");
  const headers: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json",
    "X-Tenant-Id": context.tenantId, "X-Principal-Id": context.principalId, ...extra };
  let payload: BodyInit | undefined;
  if (raw) { headers["Content-Type"] = "application/octet-stream"; payload = raw as unknown as BodyInit; }
  else if (body !== undefined) { headers["Content-Type"] = "application/json"; payload = JSON.stringify(body); }
  let response: Response;
  try {
    response = await fetch(`${origin}${path}`, { method, headers, body: payload, credentials: "omit", redirect: "error", cache: "no-store" });
  } catch {
    throw new HostError("HOST_UNREACHABLE", 0, "The local Media host did not answer.");
  }
  let parsed: unknown = null;
  try { parsed = await response.json(); } catch { /* empty or non-JSON body */ }
  if (response.ok) return parsed;
  const error = (parsed as { error?: { code?: string; message?: string } } | null)?.error;
  // A proxy error while the host is down (no typed host error, or the proxy's OUTCOME_UNKNOWN) is a transport loss, not a host verdict.
  const transportCode = error?.code === "OUTCOME_UNKNOWN" || error?.code === undefined;
  if ([500, 502, 503, 504].includes(response.status) && transportCode) throw new HostError("HOST_UNREACHABLE", response.status, "The local Media host is not reachable.");
  throw new HostError(error?.code ?? "HTTP_ERROR", response.status, error?.message ?? `Request failed (${response.status}).`);
}

const hex = (bytes: Uint8Array): string => Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
const mib = (n: number): string => `${(n / 1048576).toFixed(2)} MiB`;
const showError = (message: string): void => { uploadError.textContent = message; };
function setButtons(): void {
  const connected = context !== null;
  startButton.disabled = !connected || running || file === null || session?.status === "OPEN";
  pauseButton.disabled = !running || paused;
  resumeButton.disabled = !(connected && session !== null && !running && session.status === "OPEN");
  attestButton.disabled = !(connected && latestVersion !== null && basisInput.value.trim().length >= 2);
}
function render(text: string): void {
  if (file && session) { progress.max = file.size; progress.value = session.bytesReceived; }
  progressText.textContent = text;
}

function enableForm(on: boolean): void {
  for (const element of [fileInput, lineageInput, chunkSelect, paceInput, basisInput]) element.disabled = !on;
  setButtons();
}

byId<HTMLFormElement>("connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = tokenInput.value.trim();
  if (!raw) return;
  token = raw; tokenInput.value = ""; tokenInput.disabled = true; connectButton.disabled = true; disconnectButton.disabled = false;
  connectionStatus.textContent = "Validating DEV_ONLY identity…";
  try {
    const response = await fetch(`${origin}/dev/v1/context`, { headers: { Authorization: `Bearer ${token}` }, credentials: "omit" });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "DEV_ONLY identity was denied." : `Host context failed (${response.status}).`);
    const ctx = await response.json() as { scope?: string; tenantId?: string; principalId?: string; capabilities?: { artifactUpload?: boolean } };
    if (ctx.scope !== "DEV_ONLY" || !ctx.tenantId || !ctx.principalId) throw new TypeError("Host returned an invalid DEV_ONLY context.");
    if (ctx.capabilities?.artifactUpload !== true) throw new Error("This identity cannot upload artifacts.");
    context = { tenantId: ctx.tenantId, principalId: ctx.principalId };
    const policy = await call("GET", "/dev/v1/artifact-upload-policy") as { maxChunkBytes?: number };
    maxChunkBytes = Number(policy.maxChunkBytes ?? 0);
    for (const option of Array.from(chunkSelect.options)) option.disabled = Number(option.value) > maxChunkBytes;
    connectionStatus.textContent = "Connected to local DEV_ONLY host.";
    enableForm(true);
  } catch (error) {
    forget();
    connectionStatus.textContent = error instanceof Error ? error.message : "Unable to connect.";
  }
});
function forget(): void {
  token = null; context = null; session = null; paused = false; running = false;
  tokenInput.disabled = false; connectButton.disabled = false; disconnectButton.disabled = true;
  enableForm(false);
}
disconnectButton.addEventListener("click", () => { forget(); connectionStatus.textContent = "Disconnected. In-memory token cleared."; });
window.addEventListener("beforeunload", () => { token = null; });
fileInput.addEventListener("change", () => { file = fileInput.files?.[0] ?? null; session = null; fileSha = ""; progress.value = 0; setButtons(); });
basisInput.addEventListener("input", setButtons);

async function readSession(): Promise<Session> {
  return await call("GET", `/api/v1/artifacts/uploads/${session!.uploadId}`) as Session;
}

/** Waits (polling the session read) until the host answers again; returns the server's authoritative state. */
async function reconnect(): Promise<Session> {
  for (let attempt = 0; ; attempt += 1) {
    if (paused) throw new HostError("PAUSED", 0, "Paused.");
    render(`Connection lost. Waiting for the host to resume from its acknowledged offset (attempt ${attempt + 1})…`);
    await delay(Math.min(500 + attempt * 250, 2000));
    try { return await readSession(); } catch (error) {
      if (!(error instanceof HostError) || error.code !== "HOST_UNREACHABLE") throw error;
    }
  }
}

async function transfer(): Promise<void> {
  if (!file || !context || !session) return;
  running = true; paused = false; setButtons(); showError("");
  const chunkBytes = Number(chunkSelect.value);
  const totalChunks = Math.ceil(file.size / chunkBytes);
  try {
    session = await readSession();                // the server, not this page, says where to continue
    while (session.status === "OPEN" && session.nextChunkIndex < totalChunks) {
      if (paused) { render(`Paused at ${mib(session.bytesReceived)} of ${mib(file.size)}. Press Resume to continue from the server offset.`); return; }
      const index = session.nextChunkIndex;
      const slice = new Uint8Array(await file.slice(index * chunkBytes, Math.min(file.size, (index + 1) * chunkBytes)).arrayBuffer());
      try {
        session = await call("PUT", `/api/v1/artifacts/uploads/${session.uploadId}/chunks/${index}`, undefined,
          { "X-Chunk-SHA256": hex(sha256(slice)) }, slice) as Session;
      } catch (error) {
        if (error instanceof HostError && error.code === "HOST_UNREACHABLE") { session = await reconnect(); continue; }
        throw error;
      }
      render(`Chunk ${session.nextChunkIndex} of ${totalChunks} acknowledged: ${mib(session.bytesReceived)} of ${mib(file.size)}.`);
      const pace = Number(paceInput.value);
      if (pace > 0) await delay(pace);
    }
    if (session.status === "OPEN") await finish();
    else if (session.status === "COMPLETED") await finish();
    else showError(`The upload session is ${session.status}; start again to begin a new session.`);
  } catch (error) {
    if (error instanceof HostError && error.code === "PAUSED") { render("Paused."); return; }
    showError(error instanceof HostError ? `${error.code}: ${error.message}` : "The upload stopped unexpectedly.");
  } finally { running = false; setButtons(); }
}

async function finish(): Promise<void> {
  render("All chunks acknowledged. Asking the host to verify the whole file…");
  let artifact: { artifactId: string; sha256: string; sizeBytes: number };
  for (;;) {
    try { artifact = await call("POST", `/api/v1/artifacts/uploads/${session!.uploadId}/complete`) as typeof artifact; break; }
    catch (error) {
      if (error instanceof HostError && error.code === "HOST_UNREACHABLE") { await delay(500); continue; }   // complete is idempotent
      throw error;
    }
  }
  if (artifact.sha256 !== fileSha || artifact.sizeBytes !== file!.size) throw new HostError("VERIFICATION_MISMATCH", 0, "The host reported a different digest or size than this file.");
  session = { ...session!, status: "COMPLETED", bytesReceived: file!.size };
  render(`Verified by the host: ${mib(artifact.sizeBytes)}, SHA-256 ${artifact.sha256.slice(0, 12)}… Registering the version…`);
  try {
    const registered = await call("POST", "/dev/v1/intakes", { lineageId, artifactId: artifact.artifactId, artifactVersionId: `sha256:${artifact.sha256}` }) as Version & { deduplicated: boolean };
    registerStatus.textContent = registered.deduplicated
      ? `This exact content is already version ${registered.versionNumber}; no new version was created.`
      : `Registered as version ${registered.versionNumber}.`;
  } catch (error) {
    registerStatus.textContent = error instanceof HostError ? `Not registered (${error.code}): ${error.message}` : "Not registered.";
  }
  await refreshVersions();
  render("Upload complete.");
}

async function refreshVersions(): Promise<void> {
  const rows: HTMLTableRowElement[] = [];
  const addRow = (cells: string[], span = 0): void => {
    const row = document.createElement("tr");
    for (const text of cells) { const cell = document.createElement("td"); cell.textContent = text; if (span) cell.colSpan = span; row.append(cell); }
    rows.push(row);
  };
  try {
    const view = await call("GET", `/dev/v1/intakes/${encodeURIComponent(lineageId)}`) as { versions: Version[] };
    latestVersion = view.versions[view.versions.length - 1] ?? null;
    for (const version of view.versions) {
      const streams = (version.probe?.streams ?? []).map((s) => `${s.codecType}: ${s.codecName}`).join(", ");
      const duration = version.probe?.format?.durationSeconds;
      const processing = version.processingAdmission.usableForProcessing
        ? "Usable: rights statement present"
        : `Not usable: ${version.processingAdmission.reasons.join(", ") || version.processingAdmission.verdict}`;
      addRow([`v${version.versionNumber}`, version.parentArtifactVersionId ? `${version.parentArtifactVersionId.slice(7, 19)}…` : "none",
        `${version.sha256.slice(0, 16)}…`, mib(version.sizeBytes), duration === undefined ? "n/a" : `${duration.toFixed(2)} s`, streams || "n/a", processing]);
    }
  } catch (error) {
    latestVersion = null;
    addRow([error instanceof HostError && error.status === 404 ? "No version registered yet." : "Versions could not be read."], 7);
  }
  versionsBody.replaceChildren(...rows);   // swap in one step: the table is never observed half-empty
  setButtons();
}

byId<HTMLFormElement>("upload-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!file || !context || running) return;
  lineageId = lineageInput.value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/u.test(lineageId)) { showError("The lineage name is not valid."); lineageInput.focus(); return; }
  showError(""); registerStatus.textContent = ""; running = true; setButtons();
  try {
    render("Hashing the file in this browser before upload…");
    fileSha = await hashFileSha256(file, new AbortController().signal);
    // The idempotency key is derived from the file digest, so after a page reload the SAME file finds its open session.
    const body = { tenantId: context.tenantId, principalId: context.principalId, fileName: file.name.slice(0, 200) || "upload",
      contentType: file.type || "application/octet-stream", expectedSizeBytes: file.size, expectedSha256: fileSha,
      classification: "INTERNAL", retention: "P30D", metadata: { scope: "DEV_ONLY", surface: "resumable-upload-page" } };
    for (;;) {
      try {
        session = await call("POST", "/api/v1/artifacts/uploads", body, { "Idempotency-Key": `resumable-${fileSha.slice(0, 48)}` }) as Session;
        break;
      } catch (error) {
        if (error instanceof HostError && error.code === "HOST_UNREACHABLE") { await delay(500); continue; }
        throw error;
      }
    }
    running = false;
    render(session.nextChunkIndex > 0 ? `Found an open session at ${mib(session.bytesReceived)}; continuing from the server offset.` : "Upload session opened.");
    await transfer();
  } catch (error) {
    showError(error instanceof HostError ? `${error.code}: ${error.message}` : error instanceof Error ? error.message : "Could not start the upload.");
    running = false; setButtons();
  }
});
pauseButton.addEventListener("click", () => { paused = true; pauseButton.disabled = true; render("Pausing after the current chunk…"); });
resumeButton.addEventListener("click", () => { void transfer(); });

byId<HTMLFormElement>("rights-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!latestVersion) return;
  try {
    await call("POST", "/dev/v1/rights/attestations", { artifactId: latestVersion.artifactId, artifactVersionId: latestVersion.artifactVersionId,
      statementKind: "MEDIA_RIGHTS", scopes: ["PROCESSING"], basis: basisInput.value.trim() });
    rightsStatus.textContent = `Statement recorded for version ${latestVersion.versionNumber}. Reading its admission…`;
    await refreshVersions();
    rightsStatus.textContent = `Statement recorded for version ${latestVersion.versionNumber}.`;
  } catch (error) {
    rightsStatus.textContent = error instanceof HostError ? `Not recorded (${error.code}): ${error.message}` : "Not recorded.";
  }
});
setButtons();
