import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { CaptionCorrectionEditor, DevReviewSection, type DevCaptionVersion, type DevReviewSubjectChoice } from "@audio-video/ui/screens";
import { createDevCaptionClient } from "./dev-caption-client";
import { createDevProjectOutputsClient } from "./dev-project-outputs-client";

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
const root: Root = createRoot(byId<HTMLDivElement>("caption-root"));
let bearerToken: string | null = null;

/** Editor plus the existing DEV_ONLY review section bound to the exact caption version being edited. */
function CaptionWorkspace(props: { readonly principalId: string }): React.ReactElement {
  const captions = React.useMemo(() => createDevCaptionClient({ origin, bearerToken: () => bearerToken ?? "" }), []);
  const outputs = React.useMemo(() => createDevProjectOutputsClient({ origin, bearerToken: () => bearerToken ?? "", principalId: props.principalId }), [props.principalId]);
  const [caption, setCaption] = React.useState<DevCaptionVersion | null>(null);
  const choices: readonly DevReviewSubjectChoice[] = caption ? [{
    id: "render",
    label: <>Caption version {caption.captionId}</>,
    subject: { kind: "ARTIFACT_VERSION", artifactId: caption.captionId, artifactVersionId: caption.artifactVersionId },
    wantedReference: `artifact_version:${caption.captionId}@${caption.artifactVersionId}`,
  }] : [];
  const newRequestId = React.useCallback(() => `ui-${crypto.randomUUID()}`, []);
  return <>
    <CaptionCorrectionEditor captions={captions} onCaptionChange={setCaption} />
    <section aria-labelledby="caption-review-title" className="caption-review">
      <h2 id="caption-review-title">Review a caption version</h2>
      <p>Owners open a case on the exact version above and assign a different DEV_ONLY principal as reviewer; an assigned reviewer opens the case by id and decides. No decision is an approval.</p>
      <DevReviewSection key={props.principalId} outputs={outputs} locked={false} newRequestId={newRequestId}
        projectId={null} headKey={caption ? `${caption.captionId}@${caption.artifactVersionId}` : null} subjectChoices={choices} />
    </section>
  </>;
}

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
    const context = await response.json() as { scope?: unknown; principalId?: unknown };
    if (!context || typeof context !== "object" || context.scope !== "DEV_ONLY" || typeof context.principalId !== "string") throw new TypeError("Host returned an invalid DEV_ONLY context.");
    status.textContent = "Connected to local DEV_ONLY host. Each lane is subject to the host's owner and artifact permissions.";
    root.render(<CaptionWorkspace principalId={context.principalId} />);
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
