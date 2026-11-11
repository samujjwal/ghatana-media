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
disconnectButton.addEventListener("click", () => {
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
  render();
});
window.addEventListener("beforeunload", () => { token = null; client = null; connectedTenant = null; });
