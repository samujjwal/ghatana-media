import {
  applySimulationEvent,
  createFixtureState,
  formatMediaCliError,
  formatMediaCliHumanResult,
  isSimulationEvent,
  mediaExperienceScenarioIds,
  parseMediaCommand,
  projectExperience,
  requestedMediaCliFormat,
  reduceMediaExperience,
} from "@ghatana/media-experience-simulation";
import type { MediaAction, MediaExperienceState, ScenarioId, SimulationEvent, TransitionResult } from "@ghatana/media-experience-simulation";
import { createElement } from "react";
import { createRoot as createReactRoot, type Root as ReactRoot } from "react-dom/client";
import { ProductReview, type ReviewView } from "./product-review.js";
import "@audio-video/ui/styles.css";
import { specificationArtifacts, traceMetadataForArtifact, type ExperiencePhase, type SpecificationArtifact } from "./specification.js";
import { exerciseMediaToolsConsumer } from "./tools-consumer.js";

type ExplorerMode = "product" | "explore" | "specification" | "verify" | "overview" | "truth" | "domain" | "design-system" | "experience" | "interfaces" | "journeys" | "states-data" | "traceability" | "dependencies" | "tools-review";
type ExplorerChannel = "web" | "cli";
type ProductView = ReviewView;

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Explorer application root is missing.");

const phaseSummary: Readonly<Record<ExperiencePhase, { readonly label: string; readonly title: string; readonly summary: string }>> = {
  "PDP-0": { label: "PDP-0", title: "Product Truth", summary: "Intent, capabilities, authority, and lifecycle meaning" },
  "PDP-1": { label: "PDP-1", title: "Domain & Data", summary: "Objects, states, operations, events, evidence, and provenance" },
  "PDP-2": { label: "PDP-2", title: "Design & Interfaces", summary: "Reusable visual language and protocol/interface conventions" },
  "PDP-3": { label: "PDP-3", title: "Product Experience", summary: "Complete surfaces, screens, journeys, and recovery" },
  EXPLORER: { label: "Explorer", title: "Experience Explorer", summary: "Projection, simulation, inspection, and verification" },
  CROSS_PHASE: { label: "Cross-phase", title: "Authority and acceptance", summary: "Shared ownership, decisions, gaps, and traceability across PDPs" },
  IMPLEMENTATION: { label: "Implementation", title: "Implementation", summary: "Runtime and package projections" },
  EVIDENCE: { label: "Evidence", title: "Evidence", summary: "Verification artifacts and provenance" },
  REFERENCE: { label: "Reference", title: "Reference", summary: "Non-authoritative planning and historical material" },
  OBSOLETE: { label: "Obsolete", title: "Obsolete", summary: "Retained only for migration history" },
};

function reviewStatusForArtifact(artifact: SpecificationArtifact): string {
  if (artifact.path.endsWith("/PRODUCT-TRUTH.md")) return "Boundary slice accepted · full phase pending";
  switch (artifact.phase) {
    case "PDP-0": return "Proposal · independent Product Truth review pending";
    case "PDP-1": return "Proposal · domain/data semantic review pending";
    case "PDP-2": {
      if (artifact.path.includes("/journey-contracts/")) {
        return artifact.path.endsWith("/transcribe-and-correct-captions.yaml")
          ? "Selected lane proposal · PDP-3 acceptance pending"
          : "Journey proposal · action/state/channel bindings and owner review pending";
      }
      if (artifact.path.includes("/screen-contracts/")) {
        return "View proposal · action/state bindings and owner review pending";
      }
      if (artifact.path.includes("/lanes/")) return "Selected lane · PDP-3 acceptance pending";
      if (artifact.path.endsWith("/journey-registry.yaml")) return "Coverage registry · PDP-3 acceptance pending";
      return "PDP-2 proposal · design/interface review pending";
    }
    case "PDP-3": return "PDP-3 proposal · experience acceptance pending";
    case "EXPLORER": return "Local Tools consumer verified · owner and full-host review pending";
    case "CROSS_PHASE": return "Governance record · current owner and acceptance status";
    default: return "Reference/projection record · owner status applies";
  }
}

const supportedModes: readonly { readonly id: ExplorerMode; readonly label: string; readonly shortcut: string }[] = [
  { id: "overview", label: "Overview", shortcut: "0" },
  { id: "product", label: "Product", shortcut: "1" },
  { id: "explore", label: "Explore", shortcut: "2" },
  { id: "specification", label: "Specification", shortcut: "3" },
  { id: "verify", label: "Verify", shortcut: "4" },
  { id: "truth", label: "Truth", shortcut: "5" },
  { id: "domain", label: "Domain", shortcut: "6" },
  { id: "design-system", label: "Design System", shortcut: "7" },
  { id: "experience", label: "Experience", shortcut: "8" },
  { id: "interfaces", label: "Interfaces", shortcut: "9" },
  { id: "journeys", label: "Journeys", shortcut: "a" },
  { id: "states-data", label: "States/Data", shortcut: "b" },
  { id: "traceability", label: "Traceability", shortcut: "c" },
  { id: "dependencies", label: "Dependencies", shortcut: "d" },
  { id: "tools-review", label: "Tools Review", shortcut: "e" },
];
// Artifact verification specializes the shared job-status view, so it is not a separate Product screen route.
const screenContractArtifacts = specificationArtifacts.filter((artifact) =>
  artifact.path.includes("/screen-contracts/") && !artifact.path.endsWith("/artifact-verification-job-family.yaml"));
const actionRegistryArtifact = specificationArtifacts.find((artifact) =>
  artifact.path.endsWith("/pdp-3-product-experience/action-registry.yaml"));
const sourceManifestArtifact = specificationArtifacts.find((artifact) => artifact.path === ".product-experience/source-manifest.yaml");
function productContractPathFromLocation(): string | undefined {
  const match = location.hash.match(/^#product\/view\/(.+)$/u);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!); } catch { return undefined; }
}
function productContractFromLocation(): SpecificationArtifact | undefined {
  const path = productContractPathFromLocation();
  return path ? screenContractArtifacts.find((artifact) => artifact.path === path) : undefined;
}
function legacyRouteArtifactFromLocation(): SpecificationArtifact | undefined {
  const path = productContractPathFromLocation();
  return path ? specificationArtifacts.find((artifact) => artifact.path === path) : undefined;
}
const modeFromLocation = (): ExplorerMode | undefined => {
  if (location.hash === "#product") return "product";
  if (location.hash.startsWith("#product/view/")) return "specification";
  return supportedModes.find(({ id }) => location.hash === `#${id}`)?.id;
};

const phaseIds: readonly ExperiencePhase[] = ["PDP-0", "PDP-1", "PDP-2", "PDP-3", "EXPLORER", "CROSS_PHASE"];
const compactPhaseSelector = window.matchMedia("(max-width: 760px)");
function phaseTabId(phase: ExperiencePhase): string {
  return `phase-tab-${phase.toLocaleLowerCase().replace(/[^a-z0-9]+/gu, "-")}`;
}
function phaseSelectorOrientation(): "horizontal" | "vertical" {
  return compactPhaseSelector.matches ? "horizontal" : "vertical";
}
const productViewTitles: Readonly<Record<ProductView, string>> = {
  setup: "Set up access",
  projects: "Find projects",
  project: "Work in a project",
  source: "Select a source",
  transcript: "Review a transcript",
  captions: "Correct captions",
  versions: "Compare caption versions",
  browse: "Browse media",
  import: "Import media",
  artifact: "Inspect media",
  "review-activity": "Review activity",
  "job-status": "View job status",
};
function activeProductViewTitle(): string {
  return state.workflow === "transcription" && productView === "transcript" && state.job.state === "OUTCOME_UNKNOWN"
    ? "Check job outcome"
    : productViewTitles[productView];
}
const formatTimestamp = (tick: number): string => {
  const seconds = Math.floor(tick / 1000);
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}.${String(Math.floor((tick % 1000) / 100))}`;
};
const escapeHtml = (value: unknown): string => String(value)
  .replaceAll("&", "&amp;")
  .replaceAll("<", "&lt;")
  .replaceAll(">", "&gt;")
  .replaceAll('"', "&quot;")
  .replaceAll("'", "&#39;");
const sentenceCase = (value: string): string => value.length ? `${value[0]!.toLocaleUpperCase()}${value.slice(1)}` : value;
const readableLabel = (value: string): string => value === "RECONCILING"
  ? "Checking outcome"
  : sentenceCase(value.replace(/[._-]+/gu, " ").toLocaleLowerCase());
const channelDisplayNames: Readonly<Record<string, string>> = Object.freeze({
  "media.channel.web": "Web application",
  "media.channel.api": "Protocol-neutral API",
  "media.channel.embedded": "Embedded Media experience",
  "media.channel.cli": "Command-line batch interface",
});
const channelDisplayName = (channelRef: string): string => channelDisplayNames[channelRef]
  ?? readableLabel(channelRef.split(".").at(-1) ?? channelRef);
function readableProposalPurpose(purpose: string | undefined, fallback: string): string {
  if (!purpose) return fallback;
  return /^[a-z0-9]+(?:-[a-z0-9]+)+$/iu.test(purpose)
    ? sentenceCase(purpose.replaceAll("-", " "))
    : purpose;
}

let mode: ExplorerMode = modeFromLocation() ?? "explore";
let channel: ExplorerChannel = "web";
let state: MediaExperienceState = createFixtureState("media.scenario.transcript-ready");
let productView: ProductView = "transcript";
let selectedProductContract = productContractFromLocation() ?? null;
let selectedPhase: ExperiencePhase = selectedProductContract?.phase ?? legacyRouteArtifactFromLocation()?.phase ?? "PDP-0";
let selectedArtifact = selectedProductContract ?? legacyRouteArtifactFromLocation() ?? specificationArtifacts[0]!;
let presentationRoot: ReactRoot | null = null;
let toolsPresentationRoot: ReactRoot | null = null;
let artifactFilter = "";
let selectedSegmentId = state.captionDraft.segments[0]?.segmentId ?? null;
let viewportWidth = 1536;
let highContrast = false;
let reducedMotion = false;
let cliHistory: { command: string; output: string; exitCode: number }[] = [];
let lastResult: TransitionResult | null = null;
let versionPurpose = "";
let detailsVisible = true;
let transientAnnouncement = "";
type ToolsConsumerResult = Awaited<ReturnType<typeof exerciseMediaToolsConsumer>>;
let toolsConsumerResult: ToolsConsumerResult | null = null;
let toolsConsumerError: string | null = null;
let toolsConsumerRun = 0;
const specificationContents = new Map<string, string>();
const specificationErrors = new Map<string, string>();
const specificationLoads = new Set<string>();
const focusPreservingDataAttributes = [
  "data-action", "data-align", "data-artifact", "data-clear-cli", "data-cli-help", "data-event",
  "data-mode", "data-open-product-screen", "data-phase", "data-reset", "data-resolve-conflict",
  "data-seek-to", "data-setting", "data-toggle-details", "data-workflow-view",
] as const;

type FocusAddress =
  | { readonly kind: "id"; readonly value: string }
  | { readonly kind: "attribute"; readonly name: string; readonly value: string; readonly occurrence: number };

function focusAddressFor(element: HTMLElement | null): FocusAddress | null {
  if (!element || !root?.contains(element)) return null;
  if (element.id) return { kind: "id", value: element.id };
  for (const name of focusPreservingDataAttributes) {
    const value = element.getAttribute(name);
    if (value === null) continue;
    const matches = Array.from(root.querySelectorAll<HTMLElement>(`[${name}]`))
      .filter((candidate) => candidate.getAttribute(name) === value);
    const occurrence = matches.indexOf(element);
    if (occurrence >= 0) return { kind: "attribute", name, value, occurrence };
  }
  return null;
}

function restoreFocus(address: FocusAddress | null): void {
  if (!address || !root) return;
  const target = address.kind === "id"
    ? root.querySelector<HTMLElement>(`#${CSS.escape(address.value)}`)
    : Array.from(root.querySelectorAll<HTMLElement>(`[${address.name}]`))
      .filter((candidate) => candidate.getAttribute(address.name) === address.value)[address.occurrence];
  if (target && !(target instanceof HTMLButtonElement && target.disabled)) target.focus({ preventScroll: true });
}

function ensureSpecificationContentLoaded(artifact: SpecificationArtifact): void {
  if (specificationContents.has(artifact.path) || specificationLoads.has(artifact.path) || specificationErrors.has(artifact.path)) return;
  specificationLoads.add(artifact.path);
  const relativePath = artifact.path.replace(".product-experience/", "");
  const sourceUrl = new URL(`specification/${encodeURI(relativePath)}`, document.baseURI);
  void fetch(sourceUrl).then(async (response) => {
    if (!response.ok) throw new Error(`Could not load source file (HTTP ${response.status}).`);
    specificationContents.set(artifact.path, await response.text());
  }).catch((error: unknown) => {
    specificationErrors.set(artifact.path, error instanceof Error ? error.message : String(error));
  }).finally(() => {
    specificationLoads.delete(artifact.path);
    render();
  });
}

function latestProjection() {
  return projectExperience(state);
}

function currentSource() {
  if (state.workflow !== "transcription") throw new Error("This view does not have a transcription source.");
  return state.source;
}

function applyAction(action: MediaAction): TransitionResult {
  const result = reduceMediaExperience(state, action);
  state = result.state;
  if (result.applied && state.workflow === "first-use" && action.type === "media.action.create-project") productView = "project";
  if (!selectedSegmentId && state.captionDraft.segments[0]) selectedSegmentId = state.captionDraft.segments[0].segmentId;
  transientAnnouncement = result.message;
  render();
  return result;
}

function applyEvent(event: SimulationEvent): TransitionResult {
  const result = applySimulationEvent(state, event);
  state = result.state;
  transientAnnouncement = result.message;
  render();
  return result;
}

function modeNavigation(): string {
  return `<nav class="mode-tabs" role="tablist" aria-label="Experience Explorer mode">${supportedModes.map(({ id, label, shortcut }) => `
    <button id="mode-${id}" class="mode-tab ${mode === id ? "is-selected" : ""}" type="button" role="tab" aria-controls="explorer-panel" aria-selected="${mode === id}" tabindex="${mode === id ? 0 : -1}" data-mode="${id}">
      <span>${label}</span><kbd>${shortcut}</kbd>
    </button>`).join("")}</nav>`;
}

function explorerHeader(): string {
  return `<header class="explorer-header">
    <a class="brand" href="#explore" aria-label="Experience Explorer home" data-mode="explore">
      <span class="brand-mark" aria-hidden="true">m</span>
      <span class="brand-copy"><strong>Experience Explorer</strong><small>Ghatana · Product Development</small></span>
    </a>
    ${modeNavigation()}
    <div class="header-utilities">
      <span class="simulation-badge"><span class="status-dot" aria-hidden="true"></span> Synthetic fixture</span>
      <button class="icon-button header-help" type="button" aria-label="Open experience notes" data-mode="specification">?</button>
      <span class="avatar" aria-label="Creator">AM</span>
    </div>
  </header>`;
}

function statusTone(value: string): string {
  if (["COMPLETED", "CREATED", "AVAILABLE", "ACTIVE", "CONFIRMED", "SUCCEEDED"].includes(value)) return "positive";
  if (["OUTCOME_UNKNOWN", "IDENTITY_REQUIRED", "REQUIRES_REVIEW", "REVOKED", "QUARANTINED", "PARTIALLY_SUCCEEDED"].includes(value)) return "caution";
  if (["FAILED", "CANCELLED", "DENIED", "ACCESS_DENIED", "REJECTED", "ACCESS_REVOKED"].includes(value)) return "negative";
  if (["QUEUED", "RUNNING", "RECONCILING", "PENDING"].includes(value)) return "progress";
  return "neutral";
}

function statusPill(value: string, prefix = ""): string {
  const label = readableLabel(value);
  return `<span class="status-pill tone-${statusTone(value)}"><span class="pill-dot" aria-hidden="true"></span>${escapeHtml(prefix)}${escapeHtml(label)}</span>`;
}

function productSurface(): string {
  const views: readonly ProductView[] = state.workflow === "first-use"
    ? ["setup", "projects", "project"]
    : state.workflow === "artifact-intake"
      ? ["browse", "import", "artifact"]
      : state.workflow === "artifact-verification"
        ? ["review-activity", "job-status"]
        : ["source", "transcript", "captions", "versions", "job-status"];
  return `<div class="product-app candidate-review-app ${highContrast ? "contrast-on" : ""} ${reducedMotion ? "motion-reduced" : ""}" data-viewport="${viewportWidth}">
    <header class="product-topbar"><div class="product-brand"><span class="product-mark" aria-hidden="true">M</span><span>Media presentation review</span><span class="brand-divider"></span><span class="product-breadcrumb">${escapeHtml(state.scenarioId)}</span></div><span class="product-contract-status">CANDIDATE · NOT ADMITTED</span></header>
    <div class="candidate-review-toolbar"><strong>Explorer review adapter</strong><span>Simulation fixture only · no production service</span></div>
    <nav class="candidate-review-nav" aria-label="Candidate screen view">${views.map((view) => `<button type="button" class="button button-small ${productView === view ? "button-primary" : "button-outline"}" data-workflow-view="${view}" aria-current="${productView === view ? "page" : "false"}">${escapeHtml(productViewTitles[view])}</button>`).join("")}</nav>
    <main class="candidate-review-main" id="main-content" tabindex="-1"><div id="shared-presentation-mount"></div></main>
  </div>`;
}

function exploreSurface(): string {
  const cliUnavailable = state.workflow === "first-use";
  const cliUnavailableReason = cliUnavailable
    ? "The J-01 first-use proposal declares a Web channel only."
    : "Registered commands dispatch through the same fixture state and reducer; available actions depend on this workflow.";
  const scenarioOptions = mediaExperienceScenarioIds.map((id) => {
    const key = id.replace("media.scenario.", "");
    return `<option value="${escapeHtml(id)}" ${state.scenarioId === id ? "selected" : ""}>${escapeHtml(readableLabel(key.replaceAll("-", " ")))}</option>`;
  }).join("");
  return `<main class="explore-workspace" id="main-content">
    <aside class="control-panel" aria-label="Explore context">
      <div class="control-panel-head"><div class="eyebrow">EXPLORER WORKSPACE</div><h1>Explore</h1><p>Change the fixture context and see the same state projection update.</p></div>
      <div class="control-group"><label for="scenario-picker">Scenario</label><select id="scenario-picker">${scenarioOptions}</select><small>Scenarios use synthetic workflow metadata; no media file bytes are included.</small></div>
      <div class="control-group"><label for="channel-picker">Application channel</label><select id="channel-picker"><option value="web" ${channel === "web" ? "selected" : ""}>Web review</option><option value="cli" ${channel === "cli" ? "selected" : ""} ${cliUnavailable ? "disabled" : ""}>${cliUnavailable ? "Command line (not specified)" : "Command line"}</option></select><small>${cliUnavailableReason}</small></div>
      <div class="control-group"><label for="viewport-picker">Preview width</label><select id="viewport-picker">${[320, 390, 768, 1024, 1280, 1536].map((width) => `<option value="${width}" ${viewportWidth === width ? "selected" : ""}>${width}px</option>`).join("")}</select><small>Common responsive review widths</small></div>
      <div class="control-group"><span class="control-label">Accessibility preferences</span><label class="toggle-row"><span><strong>High contrast</strong><small>Increase edge and focus contrast</small></span><input type="checkbox" data-setting="contrast" ${highContrast ? "checked" : ""} /><span class="toggle" aria-hidden="true"></span></label><label class="toggle-row"><span><strong>Reduced motion</strong><small>Remove non-essential transitions</small></span><input type="checkbox" data-setting="motion" ${reducedMotion ? "checked" : ""} /><span class="toggle" aria-hidden="true"></span></label></div>
      <div class="control-group context-card"><div class="context-card-heading"><span class="context-glyph" aria-hidden="true">↗</span><div><strong>Inspection context</strong><small>${state.workflow === "first-use" ? "First use and project creation" : state.workflow === "artifact-intake" ? "Artifact intake" : state.workflow === "artifact-verification" ? "Artifact verification job" : "Transcription and captions"}</small></div></div><div class="context-detail"><span>Actor</span><strong>Creator</strong></div><div class="context-detail"><span>Locale</span><strong>English (US)</strong></div><div class="context-detail"><span>Connectivity</span><strong>Synthetic fixture</strong></div></div>
      <button type="button" class="button button-outline full-width reset-button" data-reset>Reset scenario</button>
    </aside>
    <section class="explore-preview ${channel === "cli" && viewportWidth <= 390 ? "is-narrow-cli-preview" : ""}"><div class="preview-toolbar"><div><span class="preview-live-dot"></span><strong>${channel === "web" ? "Web product projection" : "CLI projection"}</strong><small>${viewportWidth}px wide</small></div><button class="button button-small button-quiet" data-mode="product" type="button">Open product view <span aria-hidden="true">↗</span></button></div>
      ${channel === "web" ? `<div class="candidate-preview-placeholder"><strong>Shared candidate presentation</strong><p>Open Product mode to review this unadmitted screen composition with the selected fixture.</p></div>` : terminalProjection()}
    </section>
    <aside class="context-inspector"><div class="inspector-title"><div><div class="eyebrow">LIVE PROJECTION</div><h2>Current state</h2></div><span class="projection-live-label">CURRENT</span></div>
      ${statePreview()}
      <div class="inspector-actions"><h3>Available actions</h3>${latestProjection().safeActionIds.length ? latestProjection().safeActionIds.map((action) => `<div class="available-action"><span class="action-available-dot"></span><code>${escapeHtml(action.replace("media.action.", ""))}</code></div>`).join("") : `<div class="no-actions">No action is currently available.</div>`}</div>
      ${fixtureControls()}
      <details class="event-log"><summary>Simulation event log <span>${state.eventLog.length}</span></summary><ol>${state.eventLog.slice(-8).map((event) => `<li><code>${escapeHtml(event)}</code></li>`).join("")}</ol></details>
    </aside>
  </main>`;
}

function statePreview(): string {
  if (state.workflow === "first-use") {
    const firstUse = state.firstUse;
    const status = !firstUse.identityResolved ? "IDENTITY_REQUIRED"
      : firstUse.workspaceAccess === "DENIED" ? "ACCESS_DENIED" : firstUse.creationStatus;
    return `<div class="state-preview-card"><div class="state-preview-heading"><span>First-use state</span>${statusPill(status)}</div><div class="state-preview-value">${escapeHtml(readableLabel(status))}</div><div class="state-preview-meta">${escapeHtml(firstUse.identityResolved && firstUse.workspaceAccess === "ALLOWED" ? firstUse.workspaceId ?? "Workspace available" : "Protected project data hidden")}</div><div class="state-preview-divider"></div><div class="state-preview-row"><span>Identity</span><strong>${firstUse.identityResolved ? "Resolved in fixture" : "Not established"}</strong></div><div class="state-preview-row"><span>Workspace access</span><strong>${escapeHtml(readableLabel(firstUse.workspaceAccess))}</strong></div><div class="state-preview-row"><span>Project</span><strong>${escapeHtml(firstUse.projectId ?? "Not available")}</strong></div><div class="state-preview-row"><span>Project version</span><strong>${escapeHtml(firstUse.projectVersion ?? "Not available")}</strong></div></div>`;
  }
  if (state.artifactIntake) {
    const intake = state.artifactIntake;
    return `<div class="state-preview-card"><div class="state-preview-heading"><span>Artifact transfer</span>${statusPill(intake.status)}</div><div class="state-preview-value">${escapeHtml(readableLabel(intake.status))}</div><div class="state-preview-meta">${escapeHtml(intake.uploadId)}</div><div class="state-preview-divider"></div><div class="state-preview-row"><span>Integrity</span><strong>${escapeHtml(readableLabel(intake.integrity))}</strong></div><div class="state-preview-row"><span>Fixture parts</span><strong>${intake.acknowledgedPartCount} / ${intake.expectedPartCount ?? "?"}</strong></div><div class="state-preview-row"><span>Artifact version</span><strong>${escapeHtml(intake.artifactVersion ?? "Not available")}</strong></div></div>`;
  }
  if (state.workflow === "artifact-verification") {
    const verification = state.artifactVerification;
    return `<div class="state-preview-card"><div class="state-preview-heading"><span>Artifact verification job</span>${statusPill(verification.status)}</div><div class="state-preview-value">${escapeHtml(readableLabel(verification.status))}</div><div class="state-preview-meta">${escapeHtml(verification.jobId)}</div><div class="state-preview-divider"></div><div class="state-preview-row"><span>Related upload</span><strong>${escapeHtml(verification.uploadId)}</strong></div><div class="state-preview-row"><span>Stage</span><strong>${escapeHtml(readableLabel(verification.stage))}</strong></div><div class="state-preview-row"><span>Finality</span><strong>${escapeHtml(readableLabel(verification.finality))}</strong></div></div>`;
  }
  return `<div class="state-preview-card"><div class="state-preview-heading"><span>Transcription job</span>${statusPill(state.job.state)}</div><div class="state-preview-value">${escapeHtml(readableLabel(state.job.state))}</div><div class="state-preview-meta">${escapeHtml(state.job.jobId ?? "No job reference")}</div><div class="state-preview-divider"></div><div class="state-preview-row"><span>Finality</span><strong>${escapeHtml(readableLabel(state.job.finality))}</strong></div><div class="state-preview-row"><span>Consent</span><strong>${escapeHtml(readableLabel(state.consentState))}</strong></div><div class="state-preview-row"><span>Transcript</span><strong>${escapeHtml(state.transcript.versionId ? "Available" : "Not available")}</strong></div><div class="state-preview-row"><span>Caption version</span><strong>${state.registeredCaptionVersions.length}</strong></div></div>`;
}

function fixtureControls(): string {
  if (state.workflow === "first-use") {
    return `<section class="fixture-controls"><div class="fixture-controls-heading"><h3>Scenario fixture</h3><span>Synthetic only</span></div><p>Choose a named first-use outcome to inspect identity, access, and project-creation behavior. This panel does not contact identity or project services.</p></section>`;
  }
  if (state.workflow === "artifact-intake") {
    return `<section class="fixture-controls"><div class="fixture-controls-heading"><h3>Scenario fixture</h3><span>Metadata only</span></div><p>Choose another named scenario to inspect a different recorded transfer and integrity outcome. This panel does not upload or manufacture file bytes.</p></section>`;
  }
  if (state.workflow === "artifact-verification") {
    return `<section class="fixture-controls"><div class="fixture-controls-heading"><h3>Scenario fixture</h3><span>Synthetic only</span></div><p>Choose a recorded verification-job state. No artifact service, file bytes, or verification worker is connected.</p></section>`;
  }
  const control = (event: string, label: string, disabled = false) => `<button class="fixture-event-button" type="button" data-event="${event}" ${disabled ? "disabled" : ""}><span class="event-play" aria-hidden="true">▶</span>${label}</button>`;
  const outcomeCheckField = state.job.state === "RECONCILING"
    ? `<label class="checked-job-outcome" for="checked-job-outcome">Recorded job outcome<select id="checked-job-outcome"><option value="COMPLETED">Completed</option><option value="FAILED">Failed</option><option value="CANCELLED">Cancelled</option><option value="UNKNOWN">Still unknown</option></select></label>${control("job.outcome-check-completed", "Record checked outcome")}`
    : "";
  return `<section class="fixture-controls"><div class="fixture-controls-heading"><h3>Advance fixture</h3><span>Explorer only</span></div><p>Drive simulated events; product behavior remains deterministic.</p><div class="fixture-control-grid">${control("job.started", "Start job", state.job.state !== "QUEUED")}${control("job.completed", "Complete job", state.job.state !== "RUNNING")}${control("job.outcome-unknown", "Lose finality", !state.job.jobId || ["COMPLETED", "FAILED", "CANCELLED"].includes(state.job.state))}${control("job.cancellation-confirmed", "Confirm stop", state.job.attemptState !== "CANCEL_REQUESTED")}${control("consent.revoked", "Revoke consent", state.consentState === "REVOKED")}${outcomeCheckField}</div></section>`;
}

function unquoteYamlScalar(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && ((trimmed.startsWith("\"") && trimmed.endsWith("\"")) || (trimmed.startsWith("'") && trimmed.endsWith("'")))) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function yamlTopLevelScalar(source: string, key: string): string {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start < 0) return "";
  const initial = unquoteYamlScalar(lines[start]!.slice(key.length + 1));
  const fragments = initial ? [initial] : [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() && !/^\s/u.test(line)) break;
    if (!line.trim()) continue;
    const value = line.trim();
    if (/^(?:[A-Za-z][\w-]*:|-\s)/u.test(value)) break;
    fragments.push(value);
  }
  return fragments.join(" ").trim();
}

function yamlTopLevelList(source: string, key: string): string[] {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (start < 0) return [];
  const initial = lines[start]!.slice(key.length + 1).trim();
  if (initial.startsWith("[") && initial.endsWith("]")) {
    return initial.slice(1, -1).split(",").map(unquoteYamlScalar).filter(Boolean);
  }
  const values: string[] = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() && !/^\s/u.test(line) && !line.startsWith("- ")) break;
    const match = line.match(/^\s*-\s+(.+)$/u);
    if (match && !match[1]!.includes(":")) values.push(unquoteYamlScalar(match[1]!));
  }
  return values;
}

function yamlActionLabels(source: string): ReadonlyMap<string, string> {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.startsWith("actions:"));
  if (start < 0) return new Map();
  const labels = new Map<string, string>();
  let actionId = "";
  let label = "";
  const saveCurrent = () => { if (actionId && label) labels.set(actionId, label); };
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() && !/^\s/u.test(line) && !line.startsWith("- ")) {
      saveCurrent();
      break;
    }
    const idMatch = line.match(/^-\s+id:\s*(.+)$/u);
    if (idMatch) {
      saveCurrent();
      actionId = unquoteYamlScalar(idMatch[1]!);
      label = "";
      continue;
    }
    const labelMatch = line.match(/^ {2}label:\s*(.+)$/u);
    if (labelMatch && actionId) label = unquoteYamlScalar(labelMatch[1]!);
  }
  saveCurrent();
  return labels;
}

function yamlNestedTextFields(source: string, parentKey: string, allowedFields: readonly string[]): Readonly<Record<string, string>> {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.startsWith(`${parentKey}:`));
  if (start < 0) return {};
  const fields: Record<string, string[]> = {};
  let activeField: string | null = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() && !/^\s/u.test(line)) break;
    if (!line.trim()) continue;
    const fieldMatch = line.match(/^ {2}([A-Za-z][\w-]*):\s*(.*)$/u);
    if (fieldMatch) {
      activeField = allowedFields.includes(fieldMatch[1]!) ? fieldMatch[1]! : null;
      if (activeField) fields[activeField] = fieldMatch[2] ? [unquoteYamlScalar(fieldMatch[2])] : [];
      continue;
    }
    if (activeField && /^ {4}\S/u.test(line)) fields[activeField]!.push(line.trim());
  }
  return Object.fromEntries(Object.entries(fields).map(([key, fragments]) => [key, fragments.join(" ").trim()]));
}

function yamlChannelDispositions(source: string): readonly { channel: string; disposition: string }[] {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line.startsWith("channelDispositions:"));
  if (start < 0) return [];
  const entries: { channel: string; disposition: string }[] = [];
  let current: { channel: string; disposition: string } | null = null;
  for (let index = start + 1; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (line.trim() && !/^\s/u.test(line) && !line.startsWith("- ")) break;
    const channelMatch = line.match(/^\s*-\s+channelRef:\s*(.+)$/u);
    if (channelMatch) {
      if (current) entries.push(current);
      current = { channel: channelMatch[1]!, disposition: "" };
      continue;
    }
    const dispositionMatch = line.match(/^\s+disposition:\s*(.+)$/u);
    if (dispositionMatch && current) current.disposition = unquoteYamlScalar(dispositionMatch[1]!);
  }
  if (current) entries.push(current);
  return entries;
}

function renderScreenContractPreview(artifact: SpecificationArtifact, source: string): string {
  if (!artifact.path.includes("/screen-contracts/") || !/schemaVersion:\s*media\.screen-contract\.v[12]/u.test(source)) return "";
  const screenId = yamlTopLevelScalar(source, "screenId");
  const anatomy = yamlTopLevelList(source, "anatomy");
  if (!screenId || anatomy.length === 0) return "";
  const screenName = artifact.title || readableLabel(screenId.split(".").at(-1)?.replaceAll("-", " ") ?? screenId);
  const purpose = yamlTopLevelScalar(source, "purpose");
  const intentRef = yamlTopLevelScalar(source, "intentRef");
  const context = yamlNestedTextFields(source, "contextGoalNowNext", ["context", "goal", "now", "next"]);
  const states = yamlTopLevelList(source, "states");
  const actions = yamlTopLevelList(source, "actions");
  const components = yamlTopLevelList(source, "componentRefs");
  const responsive = yamlTopLevelScalar(source, "responsive");
  const accessibility = yamlTopLevelScalar(source, "accessibility");
  const channels = yamlChannelDispositions(source);
  const anatomyCards = anatomy.map((part, index) => `<li class="view-anatomy-card"><span>${String(index + 1).padStart(2, "0")}</span><strong>${escapeHtml(readableLabel(part.replaceAll("-", " ")))}</strong></li>`).join("");
  const stateChips = states.map((item) => `<li>${escapeHtml(readableLabel(item.replaceAll("-", " ")))}</li>`).join("");
  const actionRows = actions.map((action) => `<li><code>${escapeHtml(action)}</code><span>Not connected</span></li>`).join("");
  const componentChips = components.map((item) => `<li>${escapeHtml(readableLabel(item.split(".").at(-1)?.replaceAll("-", " ") ?? item))}</li>`).join("");
  const channelRows = channels.map(({ channel, disposition }) => `<li><strong>${escapeHtml(channelDisplayName(channel))}</strong><span>${escapeHtml(readableLabel(disposition.replaceAll("-", " ")))}</span></li>`).join("");
  const contextCards = (["context", "goal", "now", "next"] as const).filter((key) => context[key]).map((key) => `<div class="view-context-item"><span>${escapeHtml(readableLabel(key))}</span><p>${escapeHtml(context[key]!)}</p></div>`).join("");
  return `<section class="view-contract-preview" aria-labelledby="view-contract-preview-title" data-screen-id="${escapeHtml(screenId)}">
    <div class="view-preview-banner"><span class="view-preview-icon" aria-hidden="true">PDP-3</span><div><strong>Read-only view contract preview</strong><p>This proposal preview shows declared content and hierarchy. Its actions are not connected to product behavior.</p></div><span class="view-preview-state">Proposal</span></div>
    <div class="view-preview-open-product"><span>This source record remains a proposal and does not create a Product route.</span><button type="button" class="button button-outline button-small" data-artifact="${escapeHtml(artifact.path)}" data-mode="specification">Keep proposal in Specification <span aria-hidden="true">→</span></button></div>
    <header class="view-preview-heading"><div><div class="eyebrow">${escapeHtml(screenId)}</div><h3 id="view-contract-preview-title">${escapeHtml(screenName)}</h3><p>${escapeHtml(readableProposalPurpose(purpose, "The contract does not declare a short purpose statement."))}</p></div><span class="view-intent-ref">${escapeHtml(intentRef || "Intent binding pending")}</span></header>
    ${contextCards ? `<section class="view-context-grid" aria-label="Declared context, goal, now, and next">${contextCards}</section>` : ""}
    <section class="view-anatomy-section" aria-label="Declared view anatomy"><div class="view-preview-section-title"><h4>View structure</h4><span>${anatomy.length} regions</span></div><ol class="view-anatomy-grid">${anatomyCards}</ol></section>
    <div class="view-contract-columns">
      <section class="view-contract-panel"><div class="view-preview-section-title"><h4>Declared states</h4><span>${states.length}</span></div>${stateChips ? `<ul class="view-state-chips">${stateChips}</ul>` : `<p class="view-empty-note">No view states are listed in this contract.</p>`}</section>
      <section class="view-contract-panel"><div class="view-preview-section-title"><h4>Actions</h4><span>${actions.length} · not executable</span></div>${actionRows ? `<ul class="view-action-list">${actionRows}</ul>` : `<p class="view-empty-note">No actions are listed in this contract.</p>`}</section>
    </div>
    <div class="view-contract-columns view-contract-secondary">
      <section class="view-contract-panel"><div class="view-preview-section-title"><h4>Channel disposition</h4><span>${channels.length}</span></div>${channelRows ? `<ul class="view-channel-list">${channelRows}</ul>` : `<p class="view-empty-note">Channel bindings are not listed in this contract.</p>`}</section>
      <section class="view-contract-panel"><div class="view-preview-section-title"><h4>Design guidance</h4></div><dl class="view-design-guidance">${responsive ? `<div><dt>Responsive</dt><dd>${escapeHtml(responsive)}</dd></div>` : ""}${accessibility ? `<div><dt>Accessibility</dt><dd>${escapeHtml(accessibility)}</dd></div>` : ""}</dl></section>
    </div>
  </section>`;
}

function filteredSpecificationArtifacts(artifacts: readonly SpecificationArtifact[]): readonly SpecificationArtifact[] {
  const query = artifactFilter.trim().toLocaleLowerCase();
  if (!query) return artifacts;
  return artifacts.filter((artifact) => `${artifact.title} ${artifact.path}`.toLocaleLowerCase().includes(query));
}

function renderSpecificationArtifactLinks(artifacts: readonly SpecificationArtifact[]): string {
  if (artifacts.length === 0) return `<p class="artifact-filter-empty">No records match this search.</p>`;
  return artifacts.map((artifact) => `<button type="button" class="artifact-link ${artifact.path === selectedArtifact.path ? "is-current" : ""}" data-artifact="${escapeHtml(artifact.path)}"><span class="file-glyph" aria-hidden="true">${artifact.path.endsWith(".md") ? "M" : "Y"}</span><span><strong>${escapeHtml(artifact.title)}</strong><small>${escapeHtml(artifact.path.split("/").at(-1))}</small></span></button>`).join("");
}

function renderTraceMetadata(artifact: SpecificationArtifact, sourceManifest: string): string {
  const metadata = traceMetadataForArtifact(artifact, sourceManifest);
  const list = (values: readonly string[]): string => values.map((value) => `<li><code>${escapeHtml(value)}</code></li>`).join("");
  return `<section class="trace-metadata" aria-labelledby="trace-metadata-title"><div class="trace-section-heading"><h3 id="trace-metadata-title">Projection trace</h3><span>Source-linked</span></div>
    <dl class="trace-metadata-grid">
      <div><dt>Stable Explorer ID</dt><dd><code>${escapeHtml(metadata.stableId)}</code></dd></div>
      <div><dt>Canonical artifact ID</dt><dd><code>${escapeHtml(metadata.canonicalArtifactId)}</code></dd></div>
      <div><dt>Owning phase</dt><dd>${escapeHtml(artifact.phase)} · ${escapeHtml(metadata.authorityClass)}</dd></div>
      <div><dt>Canonical location</dt><dd><code>${escapeHtml(metadata.canonicalLocation)}</code></dd></div>
      <div><dt>Semantic fingerprint</dt><dd>${escapeHtml(metadata.semanticFingerprint)}</dd></div>
      <div><dt>Currentness</dt><dd>${escapeHtml(metadata.currentness)}</dd></div>
      <div><dt>Verification status</dt><dd>${escapeHtml(metadata.verificationStatus)}</dd></div>
    </dl>
    <div class="trace-relations"><div><span>Dependencies</span><ul>${list(metadata.dependencies)}</ul></div><div><span>Dependents</span><ul>${list(metadata.dependents)}</ul></div></div>
    <p class="trace-honesty-note">The Explorer exposes the canonical path and declared relation authority. It does not generate semantic fingerprints, currentness, acceptance, or Lifecycle receipts.</p>
  </section>`;
}

function specificationSurface(): string {
  const phaseArtifacts = specificationArtifacts.filter((artifact) => artifact.phase === selectedPhase);
  const visibleArtifacts = filteredSpecificationArtifacts(phaseArtifacts);
  const activeArtifact = phaseArtifacts.find((artifact) => artifact.path === selectedArtifact.path) ?? phaseArtifacts[0]!;
  selectedArtifact = activeArtifact;
  ensureSpecificationContentLoaded(activeArtifact);
  if (sourceManifestArtifact) ensureSpecificationContentLoaded(sourceManifestArtifact);
  const sourceContent = specificationContents.get(activeArtifact.path);
  const sourceManifestContent = sourceManifestArtifact ? specificationContents.get(sourceManifestArtifact.path) ?? "" : "";
  const content = sourceContent ?? specificationErrors.get(activeArtifact.path) ?? "Loading source file…";
  const invalidLegacyRoute = location.hash.startsWith("#product/view/") && !legacyRouteArtifactFromLocation();
  const phaseCoverage = phaseIds.map((phase) => {
    const count = specificationArtifacts.filter((artifact) => artifact.phase === phase).length;
    return `<button type="button" class="phase-coverage-card ${phase === selectedPhase ? "is-current" : ""}" data-phase="${escapeHtml(phase)}" aria-label="Inspect ${escapeHtml(phaseSummary[phase].title)} records"><span>${escapeHtml(phase)}</span><strong>${count}</strong><small>${escapeHtml(phaseSummary[phase].title)}</small></button>`;
  }).join("");
  return `<div class="specification-workspace ${highContrast ? "contrast-on" : ""}">
    <aside class="spec-sidebar"><div class="eyebrow">SOURCE OF MEANING</div><h1>Specification</h1><p>Inspect the source records behind this experience.</p>
      <div class="phase-selector" role="radiogroup" aria-label="Select an experience phase" aria-orientation="${phaseSelectorOrientation()}">${phaseIds.map((phase) => `<button id="${phaseTabId(phase)}" type="button" role="radio" aria-checked="${phase === selectedPhase}" tabindex="${phase === selectedPhase ? 0 : -1}" class="phase-tab ${phase === selectedPhase ? "is-current" : ""}" data-phase="${phase}"><span>${phase}</span><strong>${escapeHtml(phaseSummary[phase].title)}</strong></button>`).join("")}</div>
      <label class="artifact-filter-label" for="artifact-filter">Find a record</label><input id="artifact-filter" class="artifact-filter" type="search" value="${escapeHtml(artifactFilter)}" placeholder="Search titles and filenames" autocomplete="off" />
      <div class="spec-artifacts-heading"><span>AUTHORITY FILES</span><span id="artifact-count">${visibleArtifacts.length} of ${phaseArtifacts.length}</span></div>
      <nav class="artifact-list" aria-label="Phase artifacts">${renderSpecificationArtifactLinks(visibleArtifacts)}</nav>
    </aside>
    <main class="spec-document" id="main-content"><header class="spec-doc-header"><div><div class="eyebrow">${selectedPhase} · ${escapeHtml(phaseSummary[selectedPhase].title.toUpperCase())}</div><h2>${escapeHtml(activeArtifact.title)}</h2><p>${escapeHtml(activeArtifact.path)}</p></div><span class="proposal-chip"><span></span> ${escapeHtml(reviewStatusForArtifact(activeArtifact))}</span></header>
      ${location.hash.startsWith("#product/view/") ? `<aside class="legacy-proposal-route-note" role="note"><strong>${invalidLegacyRoute ? "Proposal route not found" : "Legacy Product URL opened as Specification"}</strong><p>${invalidLegacyRoute ? "This URL does not match an indexed source record. No Product screen is mounted." : "Screen contracts are read-only proposal previews in Specification. No Product route or implementation is implied."}</p></aside>` : ""}
      <section class="phase-coverage" aria-label="Product Definition coverage">${phaseCoverage}</section>
      <div class="spec-context"><div class="spec-context-icon">${selectedPhase}</div><div><strong>${escapeHtml(phaseSummary[selectedPhase].summary)}</strong><span>Read-only content bundled from the repository’s current authority file.</span></div></div>
      ${renderScreenContractPreview(activeArtifact, sourceContent ?? "")}
      <pre class="spec-source"><code>${escapeHtml(content)}</code></pre>
    </main>
    <aside class="spec-inspector"><div class="eyebrow">TRACE CONTEXT</div><h2>${escapeHtml(activeArtifact.title)}</h2><div class="trace-card"><span>Authority path</span><code>${escapeHtml(activeArtifact.path)}</code></div><div class="trace-card"><span>Product identity</span><code>ghatana.product/media</code></div><div class="trace-card"><span>Tools stage or scope</span><code>${escapeHtml(({ "PDP-0": "establish-product-truth", "PDP-1": "establish-domain-data", "PDP-2": "establish-design-interface-system", "PDP-3": "specify-complete-product-experience", EXPLORER: "project-and-verify-experience", CROSS_PHASE: "shared governance; not a PDP phase" } as Partial<Record<ExperiencePhase, string>>)[selectedPhase] ?? "projection scope")}</code></div><div class="trace-card"><span>Record status</span><strong>${escapeHtml(reviewStatusForArtifact(activeArtifact))}</strong></div>${renderTraceMetadata(activeArtifact, sourceManifestContent)}<div class="trace-links"><h3>Related views</h3><button type="button" class="text-button" data-mode="verify">Open verification workspace →</button><button type="button" class="text-button" data-mode="explore">Inspect live scenario →</button></div></aside>
  </div>`;
}

function verificationSurface(): string {
  const sourceArtifacts = specificationArtifacts.filter((artifact) =>
    artifact.path.includes("verification-matrix") || artifact.path.includes("scenario-fixtures") ||
    artifact.path.endsWith("/tools-binding.yaml") || artifact.path.endsWith("/acceptance.yaml") ||
    artifact.path.endsWith("/mandatory-surface-closure-matrix.yaml") || artifact.path.endsWith("/source-manifest.yaml"));
  const links = sourceArtifacts.length ? sourceArtifacts.map((artifact) => `<button type="button" class="artifact-link" data-artifact="${escapeHtml(artifact.path)}" data-mode="specification"><span class="file-glyph" aria-hidden="true">${artifact.path.endsWith(".md") ? "M" : "Y"}</span><span><strong>${escapeHtml(artifact.title)}</strong><small>${escapeHtml(artifact.phase)} · ${escapeHtml(reviewStatusForArtifact(artifact))} · ${escapeHtml(artifact.path)}</small></span></button>`).join("") : `<p class="artifact-filter-empty">No verification-source records are present in the current index.</p>`;
  return `<main class="verify-workspace" id="main-content" tabindex="-1"><header class="verify-header"><div><div class="eyebrow">VERIFICATION SOURCES & EVIDENCE AVAILABILITY</div><h1>Verify experience</h1><p>Results are shown only when a durable run report is available from indexed sources.</p></div><span class="proposal-chip"><span></span> LOCAL PROJECTION</span></header>
    <section class="verify-section"><div class="verify-section-heading"><div><h2>Run-result availability</h2><p>No task-local command output is persisted here as current evidence.</p></div><span class="section-count">NOT SUPPLIED</span></div><div class="pending-list"><article class="pending-card"><span class="pending-status neutral">NOT AVAILABLE</span><div><h3>No durable run report is indexed</h3><p>Verification result, timestamp, command provenance, and artifact reference have not been supplied to this view. Consult the indexed source records below; their presence does not mean a check passed.</p></div></article><article class="pending-card"><span class="pending-status neutral">NOT SUPPLIED</span><div><h3>Lifecycle currentness and owner acceptance</h3><p>No native receipt or owner acceptance is asserted by this local projection.</p></div></article></div></section>
    <section class="verify-section"><div class="verify-section-heading"><div><h2>Indexed verification sources</h2><p>Open the canonical source record; source presence alone is not a run result.</p></div><span class="section-count">${sourceArtifacts.length} records</span></div><div class="semantic-card-grid">${links}</div></section>
  </main>`;
}

interface IndexedInterfaceRow {
  readonly id: string;
  readonly status: string;
  readonly path: string;
  readonly fields: string;
  readonly contractPath: string | null;
}

function indexedOperationContractPath(registry: SpecificationArtifact, values: Map<string, string>): string | null {
  const contractFile = values.get("contractFile")?.replace(/^['"]|['"]$/gu, "");
  if (!contractFile || contractFile.startsWith("/") || contractFile.includes("\\") || contractFile.split("/").some((part) => part === ".." || part === ".")) return null;
  const family = registry.path.endsWith("/api/api-registry.yaml")
    ? "api/operations/"
    : registry.path.endsWith("/grpc/service-registry.yaml") ? "grpc/operations/" : null;
  if (!family || !contractFile.startsWith("operations/") || !/^[A-Za-z0-9._-]+\.ya?ml$/u.test(contractFile.slice("operations/".length))) return null;
  const candidate = `${registry.path.slice(0, registry.path.lastIndexOf("/") + 1)}${contractFile}`;
  const expectedPrefix = `.product-experience/pdp-3-product-experience/${family}`;
  return candidate.startsWith(expectedPrefix) && specificationArtifacts.some((artifact) => artifact.path === candidate)
    ? candidate
    : null;
}

/** Read simple list-item scalars from an already indexed registry source only. */
function indexedInterfaceRows(artifact: SpecificationArtifact, source: string): IndexedInterfaceRow[] {
  const collectionNames = ["operations", "rpcs", "methods", "commands", "events", "tools"];
  const lines = source.split(/\r?\n/u);
  const records: { collection: string; values: Map<string, string> }[] = [];
  let collection = "";
  let record: { collection: string; values: Map<string, string> } | null = null;
  let recordIndent = -1;
  for (const line of lines) {
    const section = line.match(/^(\s*)([A-Za-z][\w-]*):\s*$/u);
    if (section && section[1]!.length <= 2) {
      if (record) records.push(record);
      record = null;
      recordIndent = -1;
      collection = collectionNames.includes(section[2]!) ? section[2]! : "";
      continue;
    }
    if (!collection) continue;
    const item = line.match(/^(\s*)-\s+([A-Za-z][\w-]*):\s*(.*)$/u);
    if (item) {
      if (record) records.push(record);
      recordIndent = item[1]!.length;
      record = { collection, values: new Map([[item[2]!, item[3]!.trim()]]) };
      continue;
    }
    if (!record) continue;
    const field = line.match(/^(\s*)([A-Za-z][\w-]*):\s*(.*)$/u);
    if (field && field[1]!.length === recordIndent + 2 && field[3]!.trim()) {
      record.values.set(field[2]!, field[3]!.trim());
    } else if (line.trim() && !/^\s/u.test(line) && record) {
      records.push(record);
      record = null;
      recordIndent = -1;
      collection = "";
    }
  }
  if (record) records.push(record);

  const value = (values: Map<string, string>, ...keys: string[]): string => {
    for (const key of keys) {
      const found = values.get(key);
      if (found !== undefined && found !== "" && found !== "null") return found;
    }
    return "Not recorded in indexed source";
  };
  const fieldRows: readonly [string, ...string[]][] = [
    ["Consumer intent", "consumerIntent", "intent", "purpose"],
    ["Canonical operation", "canonicalOperation", "canonicalOperationRef", "logicalOperationRef"],
    ["Per-operation contract reference", "contractFile"],
    ["Request", "request", "requestSchema", "inputSchema"],
    ["Response", "response", "responseSchema", "resultSchema", "responseStatuses"],
    ["Examples", "examples", "example", "exampleRefs"],
    ["Errors", "errors", "errorCases", "safeFailure"],
    ["Authority", "authority", "authorityAndDelegation", "semanticAuthority", "authorityDisposition"],
    ["Idempotency", "idempotency"],
    ["Cancellation", "cancellation"],
    ["Retry", "retry"],
    ["Operation version", "version", "apiVersion"],
    ["Registry schema version", "schemaVersion"],
    ["Resulting state/event", "resultingState", "resultingEvent", "stateEffects", "events"],
    ["Deterministic scenario", "deterministicScenario", "scenario", "scenarioRef"],
  ];
  return records.map(({ collection: recordCollection, values }) => {
    const id = value(values, "id", "operationId", "eventName", "canonicalCommand", "method");
    const bindingStatus = value(values, "experienceBinding", "bindingStatus", "contractStatus", "status");
    const details = fieldRows.map(([label, ...keys]) => `${label}: ${value(values, ...keys)}`).join(" · ");
    return { id, status: bindingStatus, path: artifact.path, fields: `${recordCollection} · ${details}`, contractPath: indexedOperationContractPath(artifact, values) };
  }).filter((row) => row.id !== "Not recorded in indexed source");
}

function semanticModeSurface(): string {
  type SemanticMode = Exclude<ExplorerMode, "product" | "explore" | "specification" | "verify" | "tools-review">;
  type ModeDefinition = { readonly title: string; readonly summary: string; readonly predicate: (artifact: SpecificationArtifact) => boolean; readonly groups: readonly { readonly label: string; readonly predicate: (artifact: SpecificationArtifact) => boolean }[] };
  const has = (artifact: SpecificationArtifact, ...terms: string[]): boolean => terms.some((term) => artifact.path.toLocaleLowerCase().includes(term));
  const phase = (value: ExperiencePhase) => (artifact: SpecificationArtifact): boolean => artifact.phase === value;
  const definitions: Readonly<Record<SemanticMode, ModeDefinition>> = {
    overview: { title: "Overview", summary: "An indexed map of the product-definition sources and local Explorer evidence. Counts describe indexed records only, not semantic completeness.", predicate: (a) => ["PRODUCT-TRUTH.md", "DOMAIN-MODEL.md", "DESIGN-LANGUAGE.md", "screen-registry.yaml", "journey-registry.yaml", "view-projections.yaml", "tools-binding.yaml"].some((name) => a.path.endsWith(name)), groups: [{ label: "Definition and projection entry points", predicate: () => true }] },
    truth: { title: "Truth", summary: "Product requirements, actors, outcomes, capabilities, policy, and lifecycle proposals from indexed PDP-0 sources.", predicate: phase("PDP-0"), groups: [{ label: "Intent and requirements", predicate: (a) => has(a, "goal", "requirement", "content-intent", "glossary", "constitution") }, { label: "Actors, capabilities, and policy", predicate: (a) => has(a, "actor", "capabilit", "policy", "qualification", "responsibilit") }, { label: "Other PDP-0 sources", predicate: () => true }] },
    domain: { title: "Domain", summary: "PDP-1 object, relationship, operation, state, event, evidence, provenance, and authority sources; proposals remain qualified until accepted.", predicate: phase("PDP-1"), groups: [{ label: "Objects and relationships", predicate: (a) => has(a, "domain-objects", "value-objects", "relationships", "domain-model") }, { label: "Operations, states, and events", predicate: (a) => has(a, "operations", "states", "transitions", "events") }, { label: "Evidence, provenance, and authority", predicate: (a) => has(a, "evidence", "provenance", "authority", "privacy") }, { label: "Versioning, offline, decisions, and other PDP-1 sources", predicate: () => true }] },
    "design-system": { title: "Design System", summary: "Indexed PDP-2 composition, design language, accessibility, state grammar, reusable patterns, layouts, and interface conventions.", predicate: phase("PDP-2"), groups: [{ label: "GUI language and composition", predicate: (a) => has(a, "/gui/", "design-language", "component-contract", "semantic-state", "responsive", "accessibility") }, { label: "Protocol and interaction conventions", predicate: (a) => has(a, "/api/", "events/conventions", "localization", "animation") }, { label: "Other indexed PDP-2 sources", predicate: () => true }] },
    experience: { title: "Experience", summary: "PDP-3 screen, action, surface, and journey proposals with explicit acceptance and binding gaps.", predicate: (a) => a.phase === "PDP-3" && has(a, "screen", "journey", "surface", "action-registry", "simulation-semantics"), groups: [{ label: "Screen and surface proposals", predicate: (a) => has(a, "screen", "surface", "action-registry") }, { label: "Journey and recovery proposals", predicate: (a) => has(a, "journey", "simulation-semantics") }, { label: "Other indexed experience sources", predicate: () => true }] },
    interfaces: { title: "Interfaces", summary: "Indexed HTTP, gRPC, SDK, CLI, event, Agent Tool, and service registries. Only fields present in these sources are shown; other operation semantics remain unresolved.", predicate: (a) => a.phase === "PDP-3" && has(a, "api-registry", "grpc/service-registry", "sdk/operation-registry", "cli/command-registry", "events/event-registry", "agent-tools/tool-registry", "services/service-registry"), groups: [{ label: "Interface registries", predicate: () => true }] },
    journeys: { title: "Journeys", summary: "Journey catalogs and indexed journey contracts. Step bindings and outcomes are proposals unless the source explicitly resolves them.", predicate: (a) => has(a, "journey"), groups: [{ label: "Journey sources", predicate: () => true }] },
    "states-data": { title: "States / Data", summary: "State and data authority sources, plus indexed fixture references. Empty or unresolved bindings are shown as gaps, not complete models.", predicate: (a) => has(a, "states", "transitions", "domain-objects", "value-objects", "relationships", "schema-bindings", "scenario-fixtures", "fixture"), groups: [{ label: "Canonical state and data sources", predicate: (a) => a.phase === "PDP-1" }, { label: "Fixture and presentation projections", predicate: () => true }] },
    traceability: { title: "Traceability", summary: "Source-manifest IDs and declared crosswalk/registry relationships. This local view does not generate owner fingerprints or bidirectional closure.", predicate: (a) => has(a, "source-manifest", "crosswalk", "traceability", "registry", "mapping"), groups: [{ label: "Declared source and crosswalk records", predicate: () => true }] },
    dependencies: { title: "Dependencies", summary: "Indexed ownership, dependency, authority, provenance, and interoperability records. Missing edges are not inferred.", predicate: (a) => has(a, "dependenc", "authority", "provenance", "interoperability", "compatibility"), groups: [{ label: "Declared boundary and dependency sources", predicate: () => true }] },
  };
  const definition = definitions[mode as SemanticMode];
  const candidates = specificationArtifacts.filter(definition.predicate);
  const interfaceRows = mode === "interfaces" ? candidates.flatMap((artifact) => {
    const source = specificationContents.get(artifact.path);
    if (!source) { ensureSpecificationContentLoaded(artifact); return []; }
    return indexedInterfaceRows(artifact, source);
  }) : [];
  const assignedRecords = new Set<SpecificationArtifact>();
  const groupMarkup = definition.groups.map((group) => {
    const records = candidates.filter((artifact) => !assignedRecords.has(artifact) && group.predicate(artifact));
    for (const artifact of records) assignedRecords.add(artifact);
    if (!records.length) return "";
    const cards = records.map((artifact) => `<button type="button" class="artifact-link" data-artifact="${escapeHtml(artifact.path)}" data-mode="specification"><span class="file-glyph" aria-hidden="true">${artifact.path.endsWith(".md") ? "M" : "Y"}</span><span><strong>${escapeHtml(artifact.title)}</strong><small>${escapeHtml(artifact.phase)} · ${escapeHtml(reviewStatusForArtifact(artifact))} · ${escapeHtml(artifact.path)}</small></span></button>`).join("");
    return `<section class="verify-section"><div class="verify-section-heading"><div><h2>${escapeHtml(group.label)}</h2><p>${records.length} indexed source ${records.length === 1 ? "record" : "records"}</p></div><span class="section-count">INDEXED</span></div><div class="semantic-card-grid">${cards}</div></section>`;
  }).join("");
  const interfaceMarkup = mode === "interfaces" ? `<section class="verify-section"><div class="verify-section-heading"><div><h2>Indexed interface registry entries</h2><p>${interfaceRows.length} registry entries; direct-scalar extraction is partial and is not a complete interface projection.</p></div><span class="section-count">REGISTRY VIEW ONLY</span></div>${interfaceRows.length ? `<div class="pending-list">${interfaceRows.map((row) => `<article class="pending-card"><span class="pending-status ${row.contractPath ? "caution" : "neutral"}">${row.contractPath ? "REGISTRY SUMMARY · CONTRACT LINKED" : "REGISTRY VIEW ONLY"}</span><div><h3>${escapeHtml(row.id)}</h3><p>${escapeHtml(row.status)}</p><details><summary>Partial registry scalar observations (not a full contract)</summary><p>${escapeHtml(row.fields)}</p></details>${row.contractPath ? `<button type="button" class="text-button" data-artifact="${escapeHtml(row.contractPath)}" data-mode="specification">Open matching indexed operation contract →</button>` : `<button type="button" class="text-button" data-artifact="${escapeHtml(row.path)}" data-mode="specification">Open owning indexed registry · registry view only →</button>`}</div></article>`).join("")}</div>` : `<p class="artifact-filter-empty">Loading indexed interface registries, or no operation entries are present in them.</p>`}<p class="trace-honesty-note">HTTP/gRPC rows link to the matching per-operation artifact only when the registry’s contractFile resolves to that exact indexed artifact; otherwise its exact contractFile value remains visible in the partial registry record. SDK, CLI, event, and Agent Tool rows without a per-operation contract remain registry-only. Missing semantics are not inferred.</p></section>` : "";
  const countSummary = mode === "overview" ? `<div class="phase-status-grid">${(["PDP-0", "PDP-1", "PDP-2", "PDP-3", "EXPLORER"] as ExperiencePhase[]).map((p) => `<article class="phase-status-card"><div class="phase-status-heading"><span>${escapeHtml(p)}</span><strong>INDEXED</strong></div><h3>${specificationArtifacts.filter((a) => a.phase === p).length} source records</h3><p>Generated index count only; not a completeness or acceptance measure.</p></article>`).join("")}</div>` : "";
  const empty = candidates.length ? "" : `<p class="artifact-filter-empty">No matching indexed records are available. This view does not substitute unindexed or inferred content.</p>`;
  return `<main class="semantic-workspace" id="main-content" tabindex="-1"><header class="verify-header"><div><div class="eyebrow">SOURCE-LINKED SEMANTIC PROJECTION</div><h1>${escapeHtml(definition.title)}</h1><p>${escapeHtml(definition.summary)}</p></div><span class="proposal-chip"><span></span> INDEXED · LOCAL ONLY</span></header>${countSummary}<section class="semantic-summary"><strong>${candidates.length} indexed source records</strong><span>Cards open their canonical source record. Proposal status, unresolved bindings, and local verification scope remain visible; semantic fingerprints, Lifecycle currentness, and owner acceptance are not generated here.</span></section>${groupMarkup}${interfaceMarkup}${empty}</main>`;
}

function runToolsConsumerReview(): void {
  const run = ++toolsConsumerRun;
  toolsConsumerResult = null;
  toolsConsumerError = null;
  render();
  void exerciseMediaToolsConsumer().then((result) => {
    if (run !== toolsConsumerRun || mode !== "tools-review") return;
    toolsConsumerResult = result;
    render();
  }).catch((error: unknown) => {
    if (run !== toolsConsumerRun || mode !== "tools-review") return;
    toolsConsumerError = error instanceof Error ? error.message : String(error);
    render();
  });
}

function toolsReviewSurface(): string {
  const result = toolsConsumerResult;
  const detail = (label: string, value: unknown): string => `<div class="trace-card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value ?? "Not reported")}</strong></div>`;
  return `<main class="semantic-workspace" id="main-content" tabindex="-1"><header class="verify-header"><div><div class="eyebrow">PUBLIC EXPLORER PACKAGE CONSUMER</div><h1>Media package review</h1><p>Loads the Media package binding and its actual indexed authorities, then renders, inspects, and dispatches through the public headless Explorer API. Scenario state is still a deterministic fixture projection.</p></div><span class="proposal-chip"><span></span> PROPOSAL · LOCAL</span></header><section class="semantic-summary"><strong>Source authorities loaded</strong><span>Repository authority files are read directly. Their presence does not prove resolved semantics, admission, owner acceptance, or Lifecycle currentness.</span></section>${toolsConsumerError ? `<section class="verify-section" role="alert"><h2>Package load failed</h2><p>${escapeHtml(toolsConsumerError)}</p></section>` : !result ? `<p class="artifact-filter-empty" role="status">Loading Media source authorities and public package consumer…</p>` : `<section class="verify-section" aria-labelledby="tools-proof-heading"><div class="verify-section-heading"><div><h2 id="tools-proof-heading">Explorer render, inspection, and dispatch</h2><p>Public @ghatana/product-dev-explorer API with the Media package adapter.</p></div><span class="section-count">${result.dispatchProducedResult ? "DISPATCHED" : "NO RESULT"}</span></div><div class="phase-status-grid">${detail("Active package", result.activePackageId)}${detail("Package authority", result.authorityStatus)}${detail("Package source", "Media adapter · proposal scope")}${detail("Loaded authority files", result.authorities.length)}${detail("Initial render", result.initialRenderKind)}${detail("Initial state", result.initialStateRef)}${detail("Dispatch finality", result.dispatchFinalityKind)}${detail("Updated render", result.updatedRenderKind)}${detail("Updated state", result.updatedStateRef)}${detail("Lifecycle currentness", "Absent")}${detail("Owner acceptance", "None")}</div><h3>Available actions after dispatch</h3><p>${result.updatedAvailableActions.length ? result.updatedAvailableActions.map(escapeHtml).join(" · ") : "None reported"}</p><h3>Known blockers</h3><ul>${result.blockers.map((blocker) => `<li>${escapeHtml(blocker)}</li>`).join("")}</ul><h3>Media authority source records</h3><div class="pending-list">${result.authorities.map(({ path, content }) => `<details class="pending-card"><summary><code>${escapeHtml(path)}</code></summary><pre>${escapeHtml(content)}</pre></details>`).join("")}</div><h3>Traceability</h3><pre>${escapeHtml(JSON.stringify(result.traceProjection, null, 2))}</pre><h3>Explorer diagnostics</h3><pre>${escapeHtml(JSON.stringify(result.diagnostics, null, 2))}</pre></section>`}</main>`;
}

function mainContent(): string {
  switch (mode) {
    case "product": return productSurface();
    case "explore": return exploreSurface();
    case "specification": return specificationSurface();
    case "verify": return verificationSurface();
    case "tools-review": return toolsReviewSurface();
    default: return semanticModeSurface();
  }
}

function render(): void {
  const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusAddress = focusAddressFor(focusedElement);
  const retainedPresentation = mode === "product" ? root!.querySelector<HTMLElement>("#shared-presentation-mount") : null;
  const retainedToolsPresentation = mode === "tools-review" ? root!.querySelector<HTMLElement>("#tools-product-renderer-mount") : null;
  retainedPresentation?.remove();
  retainedToolsPresentation?.remove();
  if (mode !== "product" && presentationRoot) {
    presentationRoot.unmount();
    presentationRoot = null;
  }
  if (mode !== "tools-review" && toolsPresentationRoot) {
    toolsPresentationRoot.unmount();
    toolsPresentationRoot = null;
  }
  const content = mode === "product"
    ? mainContent()
    : `${explorerHeader()}<div id="explorer-panel" role="tabpanel" aria-labelledby="mode-${mode}" tabindex="0">${mainContent()}</div>`;
  root!.innerHTML = `${content}<div class="global-announcer" role="status" aria-live="polite">${escapeHtml(transientAnnouncement)}</div>`;
  if (mode === "tools-review") {
    root!.querySelector<HTMLElement>("#main-content")?.insertAdjacentHTML("beforeend", `<section class="verify-section" aria-labelledby="tools-product-renderer-title"><div class="verify-section-heading"><div><h2 id="tools-product-renderer-title">Tools-hosted Product viewport</h2><p>The deterministic Tools consumer and Product viewport share the Media-owned public renderer. Current scenario facts remain a fixture projection.</p></div><span class="section-count">CANDIDATE · NOT ADMITTED</span></div><div id="tools-product-renderer-mount"></div></section>`);
    const placeholder = root!.querySelector<HTMLElement>("#tools-product-renderer-mount");
    if (placeholder) {
      if (retainedToolsPresentation) placeholder.replaceWith(retainedToolsPresentation);
      const mount = retainedToolsPresentation ?? placeholder;
      toolsPresentationRoot ??= createReactRoot(mount);
      toolsPresentationRoot.render(createElement(ProductReview, { state, view: productView, onAction: applyAction }));
    }
  }
  if (mode === "product") {
    const placeholder = root!.querySelector<HTMLElement>("#shared-presentation-mount");
    if (placeholder) {
      if (retainedPresentation) placeholder.replaceWith(retainedPresentation);
      const mount = retainedPresentation ?? root!.querySelector<HTMLElement>("#shared-presentation-mount");
      if (mount) {
        presentationRoot ??= createReactRoot(mount);
        presentationRoot.render(createElement(ProductReview, { state, view: productView, onAction: applyAction }));
      }
    }
  }
  restoreFocus(focusAddress);
  root!.dataset.mode = mode;
  document.title = mode === "product"
    ? `Media · ${activeProductViewTitle()}`
    : `Media Experience Explorer · ${readableLabel(mode)}`;
}

function runCommand(command: string): void {
  const parsed = parseMediaCommand(state, command);
  if (parsed.kind === "help") {
    cliHistory = [...cliHistory, { command, output: parsed.text, exitCode: 0 }];
    render();
    return;
  }
  if (parsed.kind === "error") {
    const format = requestedMediaCliFormat(command);
    const output = format === "human" ? parsed.message : formatMediaCliError(parsed.message, format).trimEnd();
    cliHistory = [...cliHistory, { command, output, exitCode: 2 }];
    render();
    return;
  }
  const result = reduceMediaExperience(state, parsed.action);
  state = result.state;
  lastResult = result;
  transientAnnouncement = result.message;
  const projection = projectExperience(state);
  const uploadStatus = projection.artifactIntake?.status ?? null;
  const verification = projection.artifactVerification;
  const firstUseStatus = projection.firstUse?.creationStatus ?? null;
  const workflowState = verification?.status ?? uploadStatus ?? firstUseStatus;
  const status = workflowState ?? projection.job?.state ?? "NOT_APPLICABLE";
  const jobId = verification?.jobId ?? projection.job?.jobId ?? null;
  const uploadId = projection.artifactIntake?.uploadId ?? verification?.uploadId ?? null;
  const report = {
    schemaVersion: "media.cli-result.v1",
    simulation: true,
    scenarioId: state.scenarioId,
    workflow: projection.workflow,
    commandId: parsed.commandId,
    actionId: parsed.action.type,
    applied: result.applied,
    reasonCode: result.reasonCode ?? null,
    effectIds: result.effectIds,
    message: result.message,
    jobId,
    uploadId,
    workflowState,
    state: status,
    finality: verification?.finality ?? (uploadStatus === "OUTCOME_UNKNOWN" || firstUseStatus === "OUTCOME_UNKNOWN" ? "UNKNOWN"
      : uploadStatus ? uploadStatus === "INTERRUPTED" || uploadStatus === "RECEIVING" || uploadStatus === "VERIFYING" ? "PENDING" : "CONFIRMED"
        : firstUseStatus ? firstUseStatus === "CREATED" ? "CONFIRMED" : "NOT_APPLICABLE"
          : projection.job?.finality ?? "NOT_APPLICABLE"),
    verificationStage: verification?.stage ?? null,
    sourceVersion: projection.source?.artifactVersion ?? null,
    resultVersion: projection.artifactIntake?.artifactVersion ?? projection.firstUse?.projectVersion ?? projection.transcript?.versionId ?? projection.captionDraft?.versionId ?? null,
    nextAction: projection.safeActionIds[0] ?? null,
    projection,
  };
  const output = parsed.format === "json"
    ? JSON.stringify(report, null, 2)
    : parsed.format === "jsonl"
      ? JSON.stringify({ recordType: "result", ...report })
      : formatMediaCliHumanResult(report);
  cliHistory = [...cliHistory, { command, output, exitCode: result.applied ? 0 : 2 }];
  render();
}

function runCliScreen(): string {
  const verificationJobId = state.workflow === "artifact-verification" ? state.artifactVerification.jobId : null;
  const uploadId = state.workflow === "artifact-intake" ? state.artifactIntake.uploadId : null;
  const commandPlaceholder = uploadId
    ? `ghatana-media upload inspect --upload ${uploadId}`
    : `ghatana-media job status --job ${verificationJobId ?? state.job.jobId ?? "<job-id>"}`;
  const historyOutput = cliHistory.length
    ? cliHistory.map((row) => `<div class="terminal-entry"><div class="terminal-command-line"><span class="terminal-prompt">$</span> ${escapeHtml(row.command)}</div><pre class="terminal-response ${row.exitCode ? "has-error" : ""}">${escapeHtml(row.output)}<span class="exit-code">[exit ${row.exitCode}]</span></pre></div>`).join("")
    : `<p class="terminal-empty">This fixture has no command output yet. Enter a registered ghatana-media command below.</p>`;
  return `<section class="cli-surface" id="cli-projection" data-preview-width="${viewportWidth}" aria-labelledby="cli-projection-title"><div class="cli-intro"><div><div class="eyebrow">APPLICATION CHANNEL</div><h2 id="cli-projection-title">Media CLI</h2><p>Enter a registered command. The projection uses the same fixture state and reducer as the web view.</p></div><span class="cli-contract-badge">SIMULATION · NO REMOTE CALLS</span></div><div class="cli-terminal"><div class="terminal-window-bar"><span class="terminal-light red"></span><span class="terminal-light yellow"></span><span class="terminal-light green"></span><span class="terminal-title">ghatana-media</span><button class="terminal-clear" type="button" data-clear-cli>Clear</button></div><div class="terminal-output" aria-live="polite">${historyOutput}</div><form id="command-form" class="command-form"><label class="terminal-prompt" for="command-input">$</label><input id="command-input" type="text" autocomplete="off" spellcheck="false" placeholder="${escapeHtml(commandPlaceholder)}" aria-label="Enter a Media CLI command" /><button type="submit" class="button button-primary button-small">Submit command</button></form></div><div class="cli-help-row"><button type="button" class="text-button" data-cli-help>Show command help</button><span>Stable reason codes and finality are preserved in the shared projection.</span></div><details class="cli-state-details"><summary>Current state JSON</summary><pre>${escapeHtml(JSON.stringify(latestProjection(), null, 2))}</pre></details></section>`;
}

function terminalProjection(): string {
  if (mode !== "explore") return "";
  return runCliScreen();
}

function updateMode(nextMode: ExplorerMode, restoreTabFocus = false): void {
  if (mode === nextMode) return;
  history.pushState({ explorerMode: nextMode }, "", `#${nextMode}`);
  mode = nextMode;
  selectedProductContract = null;
  transientAnnouncement = "";
  render();
  if (nextMode === "tools-review") runToolsConsumerReview();
  if (restoreTabFocus) root!.querySelector<HTMLButtonElement>(`#mode-${nextMode}`)?.focus();
  else if (nextMode === "product") root!.querySelector<HTMLElement>("#main-content")?.focus();
}

window.addEventListener("popstate", () => {
  mode = modeFromLocation() ?? "explore";
  selectedProductContract = productContractFromLocation() ?? null;
  const routeArtifact = legacyRouteArtifactFromLocation();
  if (routeArtifact) {
    selectedPhase = routeArtifact.phase;
    selectedArtifact = routeArtifact;
  }
  transientAnnouncement = "";
  render();
  if (mode === "tools-review") runToolsConsumerReview();
  if (mode !== "product") root!.querySelector<HTMLButtonElement>(`#mode-${mode}`)?.focus();
});

root.addEventListener("click", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLElement)) return;
  const productHomeLink = target.closest<HTMLAnchorElement>("a[data-product-home]");
  if (productHomeLink) {
    event.preventDefault();
    history.pushState({ explorerMode: "product" }, "", "#product");
    mode = "product";
    selectedProductContract = null;
    transientAnnouncement = "";
    render();
    root!.querySelector<HTMLElement>("#main-content")?.focus();
    return;
  }
  const productProjectionButton = target.closest<HTMLButtonElement>("button[data-open-product-screen]");
  if (productProjectionButton) {
    const artifact = screenContractArtifacts.find(({ path }) => path === productProjectionButton.dataset.openProductScreen);
    if (!artifact) return;
    selectedProductContract = artifact;
    selectedArtifact = artifact;
    selectedPhase = artifact.phase;
    history.pushState({ explorerMode: "specification", productContractPath: artifact.path }, "", "#specification");
    mode = "specification";
    transientAnnouncement = "";
    render();
    root!.querySelector<HTMLElement>("#main-content")?.focus();
    return;
  }
  const modeButton = target.closest<HTMLButtonElement>("button[data-mode]:not([data-artifact])");
  if (modeButton) {
    updateMode(modeButton.dataset.mode as ExplorerMode, modeButton.getAttribute("role") === "tab");
    return;
  }
  const homeLink = target.closest<HTMLAnchorElement>("a[data-mode]");
  if (homeLink) { event.preventDefault(); updateMode(homeLink.dataset.mode as ExplorerMode, true); return; }
  const workflowButton = target.closest<HTMLElement>("[data-workflow-view]");
  if (workflowButton) {
    const workflowView = workflowButton.dataset.workflowView;
    if (workflowView === "setup" || workflowView === "projects" || workflowView === "project" || workflowView === "source" || workflowView === "transcript" || workflowView === "captions" || workflowView === "versions" || workflowView === "browse" || workflowView === "import" || workflowView === "artifact" || workflowView === "review-activity" || workflowView === "job-status") {
      const stoppedWatching = state.workflow === "transcription" && productView === "job-status" && workflowView === "transcript";
      productView = workflowView;
      if (stoppedWatching) transientAnnouncement = "You stopped watching this job. The job continues until its owner reports a final state.";
      if (state.workflow === "transcription" && workflowView === "source" && !currentSource().selected && latestProjection().safeActionIds.includes("media.action.choose-source")) {
        applyAction({ type: "media.action.choose-source" });
      } else {
        render();
      }
    }
    return;
  }
  const actionButton = target.closest<HTMLElement>("[data-action]");
  if (actionButton) {
    if (actionButton.hasAttribute("disabled")) return;
    const actionId = actionButton.dataset.action;
    switch (actionId) {
      case "create-project": applyAction({ type: "media.action.create-project" }); break;
      case "inspect-project-creation": applyAction({ type: "media.action.inspect-project-creation" }); break;
      case "choose-source": applyAction({ type: "media.action.choose-source" }); break;
      case "request-transcription": applyAction({ type: "media.action.request-transcription", languageTag: root!.querySelector<HTMLSelectElement>("#transcription-language")?.value ?? "en-US" }); break;
      case "inspect-source": applyAction({ type: "media.action.inspect-source" }); break;
      case "inspect-artifact": applyAction({ type: "media.action.inspect-artifact" }); break;
      case "resume-artifact-upload": applyAction({ type: "media.action.resume-artifact-upload" }); break;
      case "inspect-provenance": applyAction({ type: "media.action.inspect-provenance" }); break;
      case "review-transcript": applyAction({ type: "media.action.review-transcript" }); break;
      case "view-job-status":
        productView = "job-status";
        applyAction({ type: "media.action.view-job-status" });
        break;
      case "check-job-outcome":
        productView = "job-status";
        applyAction({ type: "media.action.check-job-outcome" });
        break;
      case "request-cancellation": applyAction({ type: "media.action.request-cancellation" }); break;
      case "save-caption-version": {
        const purpose = root!.querySelector<HTMLInputElement>("#caption-version-purpose")?.value.trim() ?? "";
        if (purpose) {
          versionPurpose = "";
          applyAction({ type: "media.action.save-caption-version", purpose });
        }
        break;
      }
      case "compare-caption-versions": {
        const versions = state.captionHistory;
        const left = versions.at(-2);
        const right = versions.at(-1);
        if (left && right) {
          productView = "versions";
          applyAction({ type: "media.action.compare-caption-versions", leftVersionId: left.versionId, rightVersionId: right.versionId });
        }
        break;
      }
      default: break;
    }
    return;
  }
  const seekButton = target.closest<HTMLElement>("[data-seek]");
  if (seekButton) {
    selectedSegmentId = seekButton.dataset.segment ?? selectedSegmentId;
    applyAction({ type: "media.action.seek-source", timeTick: Number(seekButton.dataset.seek) });
    return;
  }
  const correctButton = target.closest<HTMLElement>("[data-correct]");
  if (correctButton) {
    const segmentId = correctButton.dataset.correct ?? "";
    const text = root!.querySelector<HTMLTextAreaElement>(`[data-caption-text="${CSS.escape(segmentId)}"]`)?.value ?? "";
    applyAction({ type: "media.action.correct-caption", segmentId, text });
    return;
  }
  const alignButton = target.closest<HTMLElement>("[data-align]");
  if (alignButton) {
    const segmentId = alignButton.dataset.align ?? "";
    const startTick = Number(root!.querySelector<HTMLInputElement>(`[data-start-tick="${CSS.escape(segmentId)}"]`)?.value);
    const endTick = Number(root!.querySelector<HTMLInputElement>(`[data-end-tick="${CSS.escape(segmentId)}"]`)?.value);
    applyAction({ type: "media.action.align-caption-timing", segmentId, startTick, endTick });
    return;
  }
  const eventButton = target.closest<HTMLElement>("[data-event]");
  if (eventButton) {
    const eventId = eventButton.dataset.event;
    if (eventId === "job.outcome-check-completed") {
      const outcome = root!.querySelector<HTMLSelectElement>("#checked-job-outcome")?.value;
      const outcomeCheckEvent = { type: eventId, outcome };
      if (isSimulationEvent(outcomeCheckEvent)) applyEvent(outcomeCheckEvent as SimulationEvent);
    } else if (eventId && isSimulationEvent({ type: eventId })) {
      applyEvent({ type: eventId } as SimulationEvent);
    }
    return;
  }
  const conflictButton = target.closest<HTMLElement>("[data-resolve-conflict]");
  if (conflictButton) {
    if (latestProjection().safeActionIds.includes("media.action.resolve-caption-conflict")) {
      applyAction({ type: "media.action.resolve-caption-conflict", resolution: conflictButton.dataset.resolveConflict as "keep-local" | "use-latest" });
    }
    return;
  }
  const phaseButton = target.closest<HTMLButtonElement>("button[data-phase]");
  if (phaseButton) {
    const phase = phaseButton.dataset.phase as ExperiencePhase;
    if (!phaseIds.includes(phase)) return;
    selectedPhase = phase;
    selectedArtifact = specificationArtifacts.find((artifact) => artifact.phase === phase)!;
    render();
    root!.querySelector<HTMLButtonElement>(`#${phaseTabId(phase)}`)?.focus();
    return;
  }
  const artifactButton = target.closest<HTMLElement>("[data-artifact]");
  if (artifactButton) {
    const artifact = specificationArtifacts.find((candidate) => candidate.path === artifactButton.dataset.artifact);
    if (!artifact) return;
    selectedArtifact = artifact;
    selectedPhase = artifact.phase;
    const requestedMode = artifactButton.dataset.mode as ExplorerMode | undefined;
    if (requestedMode && requestedMode !== mode) updateMode(requestedMode);
    else render();
    return;
  }
  if (target.closest("[data-reset]")) { state = createFixtureState("media.scenario.transcript-ready"); lastResult = null; cliHistory = []; versionPurpose = ""; productView = "transcript"; transientAnnouncement = "Scenario reset to transcript ready."; render(); return; }
  if (target.closest("[data-toggle-details]")) { detailsVisible = !detailsVisible; transientAnnouncement = detailsVisible ? "Source and job information shown." : "Source and job information hidden."; render(); return; }
  if (target.closest("[data-cli-help]")) { runCommand("help"); return; }
  if (target.closest("[data-clear-cli]")) { cliHistory = []; render(); return; }
});

root.addEventListener("change", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLInputElement || target instanceof HTMLSelectElement)) return;
  if (target.id === "scenario-picker") {
    const scenarioId = target.value as ScenarioId;
    state = createFixtureState(scenarioId);
    if (state.workflow === "first-use") channel = "web";
    selectedSegmentId = state.captionDraft.segments[0]?.segmentId ?? null;
    lastResult = null;
    cliHistory = [];
    versionPurpose = "";
    productView = state.workflow === "first-use"
      ? state.firstUse.creationStatus === "OUTCOME_UNKNOWN" || state.firstUse.creationStatus === "CREATED" ? "project" : state.firstUse.identityResolved ? "projects" : "setup"
      : state.workflow === "artifact-intake"
        ? state.artifactIntake?.status === "INTERRUPTED" || state.artifactIntake?.status === "OUTCOME_UNKNOWN" ? "import" : "artifact"
        : state.workflow === "artifact-verification"
          ? "job-status"
          : "transcript";
    transientAnnouncement = `Loaded ${scenarioId.replace("media.scenario.", "")} scenario.`;
    render();
  } else if (target.id === "channel-picker") {
    channel = target.value as ExplorerChannel;
    render();
  } else if (target.id === "viewport-picker") {
    viewportWidth = Number(target.value);
    render();
  } else if (target.dataset.setting === "contrast") {
    highContrast = target instanceof HTMLInputElement && target.checked;
    render();
  } else if (target.dataset.setting === "motion") {
    reducedMotion = target instanceof HTMLInputElement && target.checked;
    render();
  } else if (target.id === "source-position") {
    const tick = Number(target.value);
    if (latestProjection().safeActionIds.includes("media.action.seek-source")) applyAction({ type: "media.action.seek-source", timeTick: tick });
  }
});

root.addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement && target.id === "artifact-filter") {
    artifactFilter = target.value;
    const phaseArtifacts = specificationArtifacts.filter((artifact) => artifact.phase === selectedPhase);
    const visibleArtifacts = filteredSpecificationArtifacts(phaseArtifacts);
    const artifactList = root!.querySelector<HTMLElement>(".artifact-list");
    const artifactCount = root!.querySelector<HTMLElement>("#artifact-count");
    if (artifactList) artifactList.innerHTML = renderSpecificationArtifactLinks(visibleArtifacts);
    if (artifactCount) artifactCount.textContent = `${visibleArtifacts.length} of ${phaseArtifacts.length}`;
  } else if (target instanceof HTMLInputElement && target.id === "source-position") {
    const tick = Number(target.value);
    const time = root!.querySelector<HTMLElement>(".time-readout");
    if (time) time.innerHTML = `${formatTimestamp(tick)} <span>/</span> 00:14.0`;
    root!.querySelectorAll<HTMLElement>(".wave-bar").forEach((bar, index) => {
      bar.classList.toggle("is-playhead", index * currentSource().durationTicks / 86 <= tick);
    });
  } else if (target instanceof HTMLInputElement && target.id === "caption-version-purpose") {
    versionPurpose = target.value;
    const button = root!.querySelector<HTMLButtonElement>('[data-action="save-caption-version"]');
    if (button) button.disabled = !versionPurpose.trim() || !latestProjection().safeActionIds.includes("media.action.save-caption-version");
  } else if (target instanceof HTMLTextAreaElement && target.dataset.captionText) {
    const counter = target.closest(".segment-main")?.querySelector(".character-count");
    if (counter) counter.textContent = `${target.value.length} / 500`;
  }
});

root.addEventListener("submit", (event) => {
  const target = event.target;
  if (!(target instanceof HTMLFormElement)) return;
  if (target.id === "command-form") {
    event.preventDefault();
    const input = target.querySelector<HTMLInputElement>("#command-input");
    if (input) runCommand(input.value);
  }
});

compactPhaseSelector.addEventListener("change", (event) => {
  root!.querySelector<HTMLElement>(".phase-selector")?.setAttribute("aria-orientation", event.matches ? "horizontal" : "vertical");
});

root.addEventListener("keydown", (event) => {
  if (mode === "product") return;
  const focusedTab = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>("button[role=tab][data-mode]") : null;
  if (focusedTab && ["ArrowRight", "ArrowLeft", "Home", "End"].includes(event.key)) {
    const currentIndex = supportedModes.findIndex((item) => item.id === focusedTab.dataset.mode);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? supportedModes.length - 1 : (currentIndex + (event.key === "ArrowRight" ? 1 : supportedModes.length - 1)) % supportedModes.length;
    event.preventDefault();
    updateMode(supportedModes[nextIndex]!.id, true);
    return;
  }
  const focusedPhase = event.target instanceof HTMLElement ? event.target.closest<HTMLButtonElement>("button[role=radio][data-phase]") : null;
  if (focusedPhase && ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"].includes(event.key)) {
    const currentIndex = phaseIds.indexOf(focusedPhase.dataset.phase as ExperiencePhase);
    const nextIndex = event.key === "Home" ? 0 : event.key === "End" ? phaseIds.length - 1
      : (currentIndex + (["ArrowRight", "ArrowDown"].includes(event.key) ? 1 : phaseIds.length - 1)) % phaseIds.length;
    event.preventDefault();
    const nextPhase = phaseIds[nextIndex]!;
    selectedPhase = nextPhase;
    selectedArtifact = specificationArtifacts.find((artifact) => artifact.phase === nextPhase)!;
    render();
    root!.querySelector<HTMLButtonElement>(`#${phaseTabId(nextPhase)}`)?.focus();
    return;
  }
  if (event.target instanceof HTMLInputElement || event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLSelectElement) return;
  if (event.altKey || event.ctrlKey || event.metaKey) return;
  const requestedMode = supportedModes.find((item) => item.shortcut === event.key);
  if (requestedMode) { event.preventDefault(); updateMode(requestedMode.id, true); }
});

render();
if (mode === "tools-review") runToolsConsumerReview();
