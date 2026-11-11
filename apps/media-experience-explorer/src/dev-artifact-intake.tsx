import React from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  createMediaOperationClient,
  type CanonicalMediaArtifactObservation,
  type CanonicalMediaClassification,
  type MediaOperationClient,
} from "@audio-video/client/operations";
import {
  MediaDevProjectTimelineClient,
  type DevProjectContext,
  type DevArtifactUploadPolicy,
} from "@audio-video/client/dev-project-timeline";
import {
  ArtifactInspectionScreen,
  ArtifactIntakeScreen,
  type ArtifactUploadCapability,
  type ArtifactIntakeScreenProps,
} from "@audio-video/ui/screens";
import type { MediaTaskScreenProps } from "@audio-video/ui/screens";
import { hashFileSha256 } from "./dev-artifact-hasher.js";

type ArtifactUploadHostState = Parameters<NonNullable<ArtifactIntakeScreenProps["onUploadStateChange"]>>[0];

const CLASSIFICATIONS = new Set<CanonicalMediaClassification>(["INTERNAL", "PUBLIC", "CONFIDENTIAL", "RESTRICTED"]);
const RETENTION_PERIODS = new Set(["P1D", "P7D", "P30D", "P90D", "P365D", "P3650D"]);

type VerifiedArtifactContext = DevProjectContext & {
  readonly capabilities: { readonly artifactUpload: boolean; readonly artifactRead: boolean };
};
const byId = <T extends HTMLElement>(id: string): T => {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing page element: ${id}`);
  return element as T;
};
const origin = window.location.origin;
const tokenInput = byId<HTMLInputElement>("dev-token");
const status = byId<HTMLParagraphElement>("status");
const contextFields = byId<HTMLDListElement>("context-fields");
const connectButton = byId<HTMLFormElement>("connect-form").querySelector<HTMLButtonElement>("button[type=submit]");
const forgetButton = byId<HTMLButtonElement>("forget-token");
const capabilityStatus = byId<HTMLParagraphElement>("capability-status");
const inspectionCapabilityStatus = byId<HTMLParagraphElement>("inspection-capability-status");
const uploadResult = byId<HTMLParagraphElement>("upload-result");
const artifactIdInput = byId<HTMLInputElement>("artifact-id");
const inspectButton = byId<HTMLButtonElement>("inspect-button");
const intakeMount = byId<HTMLDivElement>("intake-mount");
const inspectionMount = byId<HTMLDivElement>("inspection-mount");
const intakeRoot: Root = createRoot(intakeMount);
const inspectionRoot: Root = createRoot(inspectionMount);
const baseScreenProps: Omit<MediaTaskScreenProps, "children"> = {
  data: { currentProjection: { title: "Artifact intake", description: "DEV_ONLY local artifact transfer and metadata observation.", steps: [{ id: "artifact-intake", title: "Artifact intake", description: "Select metadata, upload, and inspect the server receipt.", state: "current" }], currentStepId: "artifact-intake" } },
  actionPort: { invoke: async () => ({ status: "unavailable", reason: "No workflow actions are admitted on this local page." }) },
  context: { locale: "en" },
};
let bearerToken: string | null = null;
let hostClient: MediaDevProjectTimelineClient | null = null;
let operationClient: MediaOperationClient | null = null;
let verifiedContext: VerifiedArtifactContext | null = null;
let verifiedUploadPolicy: DevArtifactUploadPolicy | null = null;
let uploadHostState: ArtifactUploadHostState = "idle";
byId<HTMLSpanElement>("host-origin").textContent = origin;

byId<HTMLFormElement>("connect-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const token = tokenInput.value.trim();
  if (!token) { announce("Paste a raw DEV_ONLY token to connect.", true); tokenInput.focus(); return; }
  bearerToken = token;
  tokenInput.value = "";
  tokenInput.disabled = true;
  if (connectButton) connectButton.disabled = true;
  forgetButton.disabled = false;
  hostClient = new MediaDevProjectTimelineClient({ baseUrl: origin, bearerToken: () => bearerToken ?? "" });
  announce("Reading and verifying DEV_ONLY host context…");
  try {
    const context = await hostClient.getContext() as VerifiedArtifactContext;
    if (context.scope !== "DEV_ONLY" || typeof context.capabilities?.artifactUpload !== "boolean"
      || typeof context.capabilities?.artifactRead !== "boolean") throw new TypeError("Host did not return verified artifact capability booleans.");
    verifiedUploadPolicy = context.capabilities.artifactUpload
      ? await hostClient.getArtifactUploadPolicy().catch(() => null)
      : null;
    verifiedContext = context;
    operationClient = createMediaOperationClient({
      baseUrl: origin,
      tenantId: context.tenantId,
      getAccessToken: () => bearerToken ?? undefined,
      defaultHeaders: { "X-Principal-Id": context.principalId },
    });
    renderContext(context);
    renderScreens();
    announce(`Connected to the local host. Scope: ${context.scope}.`, false);
  } catch (error) {
    verifiedContext = null;
    verifiedUploadPolicy = null;
    operationClient = null;
    renderScreens();
    announce(errorMessage(error), true);
  }
});

forgetButton.addEventListener("click", () => {
  if (!mayDisconnect()) {
    announce("Disconnect is unavailable while an upload is pending or needs reconciliation. Keep this page open with the same file and upload identity until the outcome is resolved.", true);
    return;
  }
  bearerToken = null;
  hostClient = null;
  operationClient = null;
  verifiedContext = null;
  verifiedUploadPolicy = null;
  uploadResult.textContent = "No upload completion has been observed.";
  artifactIdInput.value = "";
  tokenInput.value = "";
  tokenInput.disabled = false;
  if (connectButton) connectButton.disabled = false;
  forgetButton.disabled = true;
  contextFields.replaceChildren();
  contextFields.hidden = true;
  capabilityStatus.textContent = "Connect to read artifact upload capability.";
  inspectionCapabilityStatus.textContent = "Connect to read artifact inspection capability.";
  inspectButton.disabled = true;
  renderScreens();
  announce("Disconnected. The in-memory token and verified artifact capabilities were cleared.");
  tokenInput.focus();
});

for (const id of ["classification", "retention"]) byId<HTMLSelectElement>(id).addEventListener("change", renderScreens);

window.addEventListener("beforeunload", (event) => {
  if (mayDisconnect()) return;
  event.preventDefault();
  event.returnValue = "";
});

byId<HTMLFormElement>("inspection-form").addEventListener("submit", (event) => {
  event.preventDefault();
  renderInspection(artifactIdInput.value.trim());
});
artifactIdInput.addEventListener("input", () => {
  inspectButton.disabled = verifiedContext?.capabilities.artifactRead !== true || artifactIdInput.value.trim().length === 0;
});

function renderScreens(): void {
  const context = verifiedContext;
  const client = operationClient;
  const uploadAllowed = context?.capabilities.artifactUpload === true
    && client !== null && verifiedUploadPolicy !== null;
  const readAllowed = context?.capabilities.artifactRead === true && client !== null;
  capabilityStatus.textContent = !context ? "Connect to read artifact upload capability."
    : uploadAllowed ? "Verified host context admits artifact upload for this DEV_ONLY principal."
      : context.capabilities.artifactUpload
        ? "Artifact upload policy is unavailable from the verified DEV_ONLY host."
        : "Artifact upload is not admitted by the verified host context.";
  inspectionCapabilityStatus.textContent = !context ? "Connect to read artifact inspection capability."
    : readAllowed ? "The DEV_ONLY token carries artifactRead scope; artifact inspection remains NOT_ADMITTED without a reviewed operation binding."
      : "Artifact inspection is not admitted by the verified host context.";
  const classification = byId<HTMLSelectElement>("classification").value as CanonicalMediaClassification;
  const retention = byId<HTMLSelectElement>("retention").value;
  const metadataSelected = CLASSIFICATIONS.has(classification) && RETENTION_PERIODS.has(retention);
  const selectionStatus = byId<HTMLParagraphElement>("metadata-status");
  selectionStatus.textContent = metadataSelected
    ? "Classification and retention are explicitly selected. Upload availability still depends on the verified host capability."
    : "Select both a source classification and a retention period before upload is available.";
  const uploadCapability: ArtifactUploadCapability | undefined = uploadAllowed && metadataSelected ? {
    runtimeAdmission: "ADMITTED",
    classification,
    retention,
    maxChunkBytes: verifiedUploadPolicy!.maxChunkBytes,
    hashFile: hashFileSha256,
    metadata: { classification, retention, scope: "DEV_ONLY" },
    client: client!,
  } : undefined;
  intakeRoot.render(<ArtifactIntakeScreen
    {...baseScreenProps}
    intake={{ view: "import-media", accessState: context ? "resolved" : "unknown", workspaceName: context?.workspaceName, message: "Local DEV_ONLY artifact intake; request metadata does not grant rights or consent." }}
    uploadCapability={uploadCapability}
    onArtifactCompleted={handleArtifactCompleted}
    onUploadStateChange={handleUploadStateChange}
  />);
  inspectButton.disabled = !readAllowed || artifactIdInput.value.trim().length === 0;
  renderInspection(artifactIdInput.value.trim());
}

function handleUploadStateChange(next: ArtifactUploadHostState): void {
  uploadHostState = next;
  const blocked = !mayDisconnect();
  forgetButton.disabled = !bearerToken || blocked;
  const notice = byId<HTMLParagraphElement>("disconnect-notice");
  notice.hidden = !blocked;
  if (blocked) {
    notice.textContent = next === "reconciliation-required"
      ? "The upload outcome needs reconciliation. Keep this page open with the same selected file and upload identity; disconnecting would discard the state needed to inspect or safely resume it."
      : "An upload request is pending. Keep this page open so the selected file, token, and upload identity remain available.";
  }
}

function mayDisconnect(): boolean {
  return uploadHostState === "idle";
}

function renderInspection(artifactId: string): void {
  const readClient = verifiedContext?.capabilities.artifactRead === true && operationClient
    ? operationClient
    : undefined;
  inspectionRoot.render(artifactId ? <ArtifactInspectionScreen
    {...baseScreenProps}
    artifactId={artifactId}
    canonicalArtifactReadClient={readClient}
  /> : null);
}

function handleArtifactCompleted(artifact: CanonicalMediaArtifactObservation): void {
  artifactIdInput.value = artifact.artifactId;
  inspectButton.disabled = verifiedContext?.capabilities.artifactRead !== true;
  renderInspection(artifact.artifactId);
  uploadResult.textContent = `Canonical upload completion observed for artifact ${artifact.artifactId} (${artifact.sizeBytes} bytes, SHA-256 ${artifact.sha256}). Metadata records no rights, consent, or processing authorization.`;
}

function renderContext(context: VerifiedArtifactContext): void {
  const entries: [string, string][] = [
    ["Scope", context.scope], ["Workspace", context.workspaceName], ["Tenant", context.tenantId],
    ["Principal", context.principalId], ["Artifact upload", String(context.capabilities.artifactUpload)],
    ["Artifact read", String(context.capabilities.artifactRead)],
  ];
  contextFields.replaceChildren(...entries.flatMap(([label, value]) => {
    const dt = document.createElement("dt"); dt.textContent = label;
    const dd = document.createElement("dd"); dd.textContent = value;
    return [dt, dd];
  }));
  contextFields.hidden = false;
}

function announce(message: string, error = false): void {
  status.textContent = message;
  status.dataset.state = error ? "error" : "ok";
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message;
  return "The local host did not return a verified context.";
}

renderScreens();
