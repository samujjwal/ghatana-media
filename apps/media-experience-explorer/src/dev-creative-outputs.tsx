import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { DevCreativeOutputsPanel } from "@audio-video/ui/screens";
import { createDevCreativeOutputsClient } from "./dev-creative-outputs-client";

const origin = window.location.origin;
const byId = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`Missing page element: ${id}`);
  return node as T;
};
const tokenInput = byId<HTMLInputElement>("dev-token");
const connectButton = byId<HTMLFormElement>("connect-form").querySelector<HTMLButtonElement>("button[type=submit]")!;
const disconnectButton = byId<HTMLButtonElement>("disconnect");
const status = byId<HTMLParagraphElement>("connection-status");
const root: Root = createRoot(byId<HTMLDivElement>("creative-root"));
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
  status.textContent = "Validating DEV_ONLY identity…";
  try {
    const response = await fetch(`${origin}/dev/v1/context`, { headers: { Authorization: `Bearer ${bearerToken}` } });
    if (!response.ok) throw new Error(response.status === 401 || response.status === 403 ? "DEV_ONLY identity was denied." : `Host context failed (${response.status}).`);
    const context: unknown = await response.json();
    if (!context || typeof context !== "object" || (context as { scope?: unknown }).scope !== "DEV_ONLY") throw new TypeError("Host returned an invalid DEV_ONLY context.");
    status.textContent = "Connected to local DEV_ONLY host. Each lane is subject to the host's owner and artifact permissions.";
    root.render(<DevCreativeOutputsPanel outputs={createDevCreativeOutputsClient({ origin, bearerToken: () => bearerToken ?? "" })} />);
  } catch (error) {
    forget();
    status.textContent = error instanceof Error ? error.message : "Unable to connect.";
    tokenInput.disabled = false; connectButton.disabled = false; disconnectButton.disabled = true;
  }
});
disconnectButton.addEventListener("click", () => {
  forget();
  tokenInput.disabled = false; connectButton.disabled = false; disconnectButton.disabled = true;
  status.textContent = "Disconnected. In-memory token cleared.";
});
window.addEventListener("beforeunload", forget);
