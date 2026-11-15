import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MediaCanonicalClient } from "@audio-video/client/canonical-operations";
import { JobRecoveryScreen } from "@audio-video/ui/screens";
import type { MediaTaskScreenProps } from "@audio-video/ui/screens";

const origin = window.location.origin;
const byId = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element: ${id}`);
  return node as T;
};
const tokenInput = byId<HTMLInputElement>("dev-token");
const jobInput = byId<HTMLInputElement>("job-id");
const connectButton = byId<HTMLFormElement>("connect-form").querySelector<HTMLButtonElement>("button[type=submit]")!;
const disconnectButton = byId<HTMLButtonElement>("disconnect");
const showButton = byId<HTMLButtonElement>("show-job");
const status = byId<HTMLParagraphElement>("connection-status");
const root: Root = createRoot(byId<HTMLDivElement>("screen"));
const flow: Omit<MediaTaskScreenProps, "children"> = {
  data: { currentProjection: { title: "Job recovery", description: "Owner scoped canonical job status observation.", steps: [{ id: "job-recovery", title: "Read job", description: "Refresh the canonical status for this job identity.", state: "current" }], currentStepId: "job-recovery" } },
  actionPort: { invoke: async () => ({ status: "unavailable", reason: "This page exposes no job mutation action." }) },
  context: { locale: "en" },
};
let token: string | null = null;
let client: MediaCanonicalClient | null = null;
let connectedTenant: string | null = null;
let renderedJobId: string | null = null;
const render = (): void => {
  if (!client || !renderedJobId) { root.render(null); return; }
  root.render(<JobRecoveryScreen {...flow} job={{ jobId: renderedJobId }} canonicalJobReadClient={client} />);
};
byId<HTMLFormElement>("connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const raw = tokenInput.value.trim();
  if (!raw) return;
  token = raw;
  tokenInput.value = "";
  tokenInput.disabled = true;
  connectButton.disabled = true;
  disconnectButton.disabled = false;
  status.textContent = "Validating DEV_ONLY identity…";
  try {
    const response = await fetch(`${origin}/dev/v1/context`, { headers: { Authorization: `Bearer ${token}` } });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "DEV_ONLY identity was denied." : `Host context failed (${response.status}).`);
    const context: unknown = await response.json();
    if (!context || typeof context !== "object" || (context as {scope?: unknown}).scope !== "DEV_ONLY"
      || typeof (context as {tenantId?: unknown}).tenantId !== "string"
      || typeof (context as {principalId?: unknown}).principalId !== "string") throw new TypeError("Host returned an invalid DEV_ONLY context.");
    connectedTenant = (context as {tenantId: string}).tenantId;
    client = new MediaCanonicalClient({ baseUrl: origin, tenantId: connectedTenant,
      getAccessToken: () => token ?? undefined,
      defaultHeaders: { "X-Principal-Id": (context as {principalId: string}).principalId } });
    status.textContent = "Connected to local DEV_ONLY host. Job reads are subject to the canonical owner permission.";
    showButton.disabled = jobInput.value.trim().length === 0;
    render();
  } catch (error) {
    token = null; client = null; connectedTenant = null; renderedJobId = null;
    status.textContent = error instanceof Error ? error.message : "Unable to connect.";
    tokenInput.disabled = false; connectButton.disabled = false; disconnectButton.disabled = true;
    render();
  }
});
const watchToggle = byId<HTMLButtonElement>("watch-toggle");
const watchStatus = byId<HTMLParagraphElement>("watch-status");
const watchDetail = byId<HTMLElement>("watch-detail");
const observations = byId<HTMLOListElement>("observations");
const WATCH_INTERVAL_MS = 1000;
let watchTimer: number | null = null;
let watchAbort: AbortController | null = null;
let lastObserved: string | null = null;
let lastStatus: { status: string; version: number } | null = null;
let hostDown = false;
const setWatchStatus = (state: string, text: string): void => { watchStatus.dataset.state = state; watchStatus.textContent = text; };
const addObservation = (text: string): void => {
  const item = document.createElement("li");
  item.textContent = text;
  observations.append(item);
};
const showDetail = (job: { status: string; version: number; failureCode: string | null; providerId: string | null; result: Readonly<Record<string, unknown>> }): void => {
  const rows: [string, string][] = [["Status", `${job.status} (version ${job.version})`]];
  if (job.providerId) rows.push(["Provider", job.providerId]);
  if (job.failureCode) rows.push(["Failure code", job.failureCode]);
  for (const key of ["providerOutcome", "reconciliation", "outputSha256", "outputContentType"]) {
    const value = job.result[key];
    if (typeof value === "string" && value.length <= 200) rows.push([key, value]);
  }
  watchDetail.replaceChildren(...rows.flatMap(([term, value]) => {
    const dt = document.createElement("dt"); dt.textContent = term;
    const dd = document.createElement("dd"); dd.textContent = value;
    return [dt, dd];
  }));
  watchDetail.hidden = false;
};
const stopWatching = (): void => {
  if (watchTimer !== null) window.clearTimeout(watchTimer);
  watchTimer = null;
  watchAbort?.abort();
  watchAbort = null;
  watchToggle.textContent = "Start watching";
  setWatchStatus("idle", "Not watching.");
};
const pollOnce = async (): Promise<void> => {
  const current = client;
  const jobId = renderedJobId;
  if (!current || !jobId) { stopWatching(); return; }
  const controller = new AbortController();
  watchAbort = controller;
  try {
    const job = await current.getJob(jobId, controller.signal);
    if (controller.signal.aborted) return;
    const key = `${job.status}@${job.version}`;
    if (hostDown) { addObservation("Local host reachable again."); hostDown = false; }
    if (key !== lastObserved) {
      lastObserved = key;
      lastStatus = { status: job.status, version: job.version };
      addObservation(`${job.status} (version ${job.version})${job.failureCode ? ` ${job.failureCode}` : ""}`);
    }
    showDetail(job);
    const terminal = job.status === "COMPLETED" || job.status === "FAILED" || job.status === "CANCELLED" || job.status === "OUTCOME_UNKNOWN";
    setWatchStatus(terminal ? "final" : "live", terminal
      ? `Final state observed: ${job.status} (version ${job.version}).`
      : `Job is ${job.status} (version ${job.version}).`);
    if (terminal) { watchTimer = null; watchToggle.textContent = "Start watching"; return; }
  } catch (error) {
    if (controller.signal.aborted) return;
    const statusCode = error && typeof error === "object" && "statusCode" in error ? (error as { statusCode?: unknown }).statusCode : undefined;
    if (statusCode === 401 || statusCode === 403) { setWatchStatus("denied", "Job read was denied. Watching stopped."); stopWatching(); setWatchStatus("denied", "Job read was denied. Watching stopped."); return; }
    if (statusCode === 404) { setWatchStatus("unknown", "Canonical job status is unknown. Watching stopped."); stopWatching(); setWatchStatus("unknown", "Canonical job status is unknown. Watching stopped."); return; }
    if (!hostDown) { hostDown = true; addObservation("Local host unreachable or restarting."); }
    setWatchStatus("host-unavailable", `Local host is unavailable. Last observed state: ${lastStatus ? `${lastStatus.status} (version ${lastStatus.version})` : "none"}. Still watching.`);
  }
  if (watchAbort === controller) watchTimer = window.setTimeout(() => { void pollOnce(); }, WATCH_INTERVAL_MS);
};
watchToggle.addEventListener("click", () => {
  if (watchTimer !== null || watchAbort) { stopWatching(); return; }
  if (!client || !renderedJobId) return;
  watchToggle.textContent = "Stop watching";
  setWatchStatus("live", "Reading job state…");
  void pollOnce();
});
disconnectButton.addEventListener("click", () => {
  stopWatching(); watchToggle.disabled = true; watchDetail.replaceChildren(); watchDetail.hidden = true; observations.replaceChildren(); lastObserved = null; lastStatus = null; hostDown = false;
  token = null; client = null; connectedTenant = null; renderedJobId = null;
  jobInput.value = ""; tokenInput.disabled = false; connectButton.disabled = false;
  disconnectButton.disabled = true; showButton.disabled = true;
  status.textContent = "Disconnected. In-memory token cleared."; render();
});
jobInput.addEventListener("input", () => { showButton.disabled = !client || !jobInput.value.trim(); });
byId<HTMLFormElement>("job-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!client) return;
  const jobId = jobInput.value.trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u.test(jobId)) { status.textContent = "Enter a valid job ID."; return; }
  renderedJobId = jobId;
  stopWatching(); observations.replaceChildren(); watchDetail.replaceChildren(); watchDetail.hidden = true; lastObserved = null; lastStatus = null; hostDown = false;
  watchToggle.disabled = false;
  render();
});
window.addEventListener("beforeunload", () => { token = null; client = null; connectedTenant = null; });
