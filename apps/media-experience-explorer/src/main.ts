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
import { specificationArtifacts, type ExperiencePhase, type SpecificationArtifact } from "./specification.js";

type ExplorerMode = "product" | "explore" | "specification" | "verify";
type ExplorerChannel = "web" | "cli";
type ProductView = "setup" | "projects" | "project" | "source" | "transcript" | "captions" | "versions" | "browse" | "import" | "artifact" | "review-activity" | "job-status";

const root = document.querySelector<HTMLDivElement>("#app");
if (!root) throw new Error("Explorer application root is missing.");

const phaseSummary: Readonly<Record<ExperiencePhase, { readonly label: string; readonly title: string; readonly summary: string }>> = {
  P0: { label: "Phase 0", title: "Product Truth", summary: "Intent, capabilities, authority, and lifecycle meaning" },
  P1: { label: "Phase 1", title: "Design Language", summary: "Reusable states, interaction, accessibility, and content rules" },
  P2: { label: "Phase 2", title: "Product Experience", summary: "Views, journeys, actions, channels, and recovery" },
  P3: { label: "Phase 3", title: "Experience Explorer", summary: "Deterministic simulation, inspection, and verification" },
  "Cross-phase": { label: "Cross-phase", title: "Authority and acceptance", summary: "Shared ownership, decisions, gaps, and traceability across all phases" },
};

function reviewStatusForArtifact(artifact: SpecificationArtifact): string {
  if (artifact.path.endsWith("/PRODUCT-TRUTH.md")) return "Boundary slice accepted · full phase pending";
  switch (artifact.phase) {
    case "P0": return "Proposal · independent P0-010 review pending";
    case "P1": return "Proposal · P0-010 prerequisite pending";
    case "P2": {
      if (artifact.path.includes("/journey-contracts/")) {
        return artifact.path.endsWith("/transcribe-and-correct-captions.yaml")
          ? "Selected lane proposal · full P2-008 acceptance pending"
          : "Journey proposal · action/state/channel bindings and owner review pending";
      }
      if (artifact.path.includes("/screen-contracts/")) {
        return "View proposal · action/state bindings and owner review pending";
      }
      if (artifact.path.includes("/lanes/")) return "Selected lane · full P2-008 acceptance pending";
      if (artifact.path.endsWith("/journey-registry.yaml")) return "Coverage registry · full P2-008 acceptance pending";
      return "Phase 2 proposal · P2-008 acceptance pending";
    }
    case "P3": return "Local implementation · Tools binding and review pending";
    case "Cross-phase": return "Governance record · current owner and acceptance status";
  }
}

const supportedModes: readonly { readonly id: ExplorerMode; readonly label: string; readonly shortcut: string }[] = [
  { id: "product", label: "Product", shortcut: "1" },
  { id: "explore", label: "Explore", shortcut: "2" },
  { id: "specification", label: "Specification", shortcut: "3" },
  { id: "verify", label: "Verify", shortcut: "4" },
];
// Artifact verification specializes the shared job-status view, so it is not a separate Product screen route.
const screenContractArtifacts = specificationArtifacts.filter((artifact) =>
  artifact.path.includes("/screen-contracts/") && !artifact.path.endsWith("/artifact-verification-job-family.yaml"));
const actionRegistryArtifact = specificationArtifacts.find((artifact) =>
  artifact.path.endsWith("/phase-2-product-experience/action-registry.yaml"));
function productContractPathFromLocation(): string | undefined {
  const match = location.hash.match(/^#product\/view\/(.+)$/u);
  if (!match) return undefined;
  try { return decodeURIComponent(match[1]!); } catch { return undefined; }
}
function productContractFromLocation(): SpecificationArtifact | undefined {
  const path = productContractPathFromLocation();
  return path ? screenContractArtifacts.find((artifact) => artifact.path === path) : undefined;
}
const modeFromLocation = (): ExplorerMode | undefined => {
  if (location.hash === "#product" || location.hash.startsWith("#product/view/")) return "product";
  return supportedModes.find(({ id }) => location.hash === `#${id}`)?.id;
};

const phaseIds: readonly ExperiencePhase[] = ["P0", "P1", "P2", "P3", "Cross-phase"];
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
let selectedPhase: ExperiencePhase = "P0";
let selectedArtifact = specificationArtifacts[0]!;
let artifactFilter = "";
let selectedSegmentId = state.captionDraft.segments[0]?.segmentId ?? null;
let viewportWidth = 1536;
let highContrast = false;
let reducedMotion = false;
let cliHistory: { command: string; output: string; exitCode: number }[] = [];
let lastResult: TransitionResult | null = null;
let versionPurpose = "";
let detailsVisible = true;
let showVerificationCommands = false;
let transientAnnouncement = "";
const specificationContents = new Map<string, string>();
const specificationErrors = new Map<string, string>();
const specificationLoads = new Set<string>();
const focusPreservingDataAttributes = [
  "data-action", "data-align", "data-artifact", "data-clear-cli", "data-cli-help", "data-event",
  "data-mode", "data-open-product-screen", "data-phase", "data-reset", "data-resolve-conflict",
  "data-run-local-checks", "data-seek-to", "data-setting", "data-toggle-details", "data-workflow-view",
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

function renderProductNavigation(): string {
  if (state.workflow === "first-use") {
    const items: readonly { view: ProductView; label: string; number: string }[] = [
      { view: "setup", label: "Set up access", number: "01" },
      { view: "projects", label: "Find projects", number: "02" },
      { view: "project", label: "Work in a project", number: "03" },
    ];
    return `<aside class="product-sidebar" aria-label="First-use workflow">
      <div class="project-picker"><span class="project-icon" aria-hidden="true">W</span><span><strong>Workspace context</strong><small>${!state.firstUse.identityResolved ? "Identity required" : state.firstUse.workspaceAccess === "DENIED" ? "Access denied" : "Authorized fixture"}</small></span></div>
      <div class="sidebar-label">FIRST USE</div>
      <ol class="workflow-list">${items.map((item) => `
        <li class="workflow-item ${item.view === productView ? "is-current" : ""}">
          <button type="button" data-workflow-view="${item.view}" aria-current="${item.view === productView ? "step" : "false"}">
            <span class="workflow-number">${item.number}</span><span>${item.label}</span>
          </button>
        </li>`).join("")}</ol>
      <div class="sidebar-spacer"></div>
      <div class="sidebar-footer"><span class="fixture-avatar" aria-hidden="true">S</span><span><strong>Synthetic first-use state</strong><small>No sign-in or project service is connected</small></span></div>
    </aside>`;
  }
  if (state.workflow === "artifact-intake") {
    const items: readonly { view: ProductView; label: string; number: string }[] = [
      { view: "browse", label: "Browse media", number: "01" },
      { view: "import", label: "Import media", number: "02" },
      { view: "artifact", label: "Inspect media", number: "03" },
    ];
    return `<aside class="product-sidebar" aria-label="Artifact intake workflow">
      <div class="project-picker"><span class="project-icon" aria-hidden="true">W</span><span><strong>Current workspace</strong><small>Synthetic project context</small></span></div>
      <div class="sidebar-label">ARTIFACT INTAKE</div>
      <ol class="workflow-list">${items.map((item) => `
        <li class="workflow-item ${item.view === productView ? "is-current" : ""}">
          <button type="button" data-workflow-view="${item.view}" aria-current="${item.view === productView ? "step" : "false"}">
            <span class="workflow-number">${item.number}</span><span>${item.label}</span>
          </button>
        </li>`).join("")}</ol>
      <div class="sidebar-spacer"></div>
      <div class="sidebar-footer"><span class="fixture-avatar" aria-hidden="true">S</span><span><strong>Metadata-only fixture</strong><small>No file bytes or runtime transfer</small></span></div>
    </aside>`;
  }
  if (state.workflow === "artifact-verification") {
    return `<aside class="product-sidebar" aria-label="Artifact verification workflow">
      <div class="project-picker"><span class="project-icon" aria-hidden="true">V</span><span><strong>Artifact verification</strong><small>Owner-issued job fixture</small></span></div>
      <div class="sidebar-label">JOB RECOVERY</div>
      <ol class="workflow-list">
        <li class="workflow-item ${productView === "review-activity" ? "is-current" : ""}"><button type="button" data-workflow-view="review-activity" aria-current="${productView === "review-activity" ? "step" : "false"}"><span class="workflow-number">01</span><span>Review activity</span></button></li>
        <li class="workflow-item ${productView === "job-status" ? "is-current" : ""}"><button type="button" data-workflow-view="job-status" aria-current="${productView === "job-status" ? "step" : "false"}"><span class="workflow-number">02</span><span>View job status</span></button></li>
      </ol>
      <div class="sidebar-spacer"></div>
      <div class="sidebar-footer"><span class="fixture-avatar" aria-hidden="true">S</span><span><strong>Synthetic job state</strong><small>No artifact service connected</small></span></div>
    </aside>`;
  }
  const items: readonly { view: ProductView; label: string; number: string }[] = [
    { view: "source", label: "Select a source", number: "01" },
    { view: "transcript", label: "Review a transcript", number: "02" },
    ...(state.job.jobId ? [{ view: "job-status" as const, label: "View job status", number: "03" }] : []),
    { view: "captions", label: "Correct captions", number: state.job.jobId ? "04" : "03" },
    { view: "versions", label: "Compare caption versions", number: state.job.jobId ? "05" : "04" },
  ];
  return `<aside class="product-sidebar" aria-label="Transcription workflow">
    <div class="project-picker">
      <span class="project-icon" aria-hidden="true">P</span>
      <span><strong>Oral histories</strong><small>Interview project</small></span>
      <span class="chevron" aria-hidden="true">⌄</span>
    </div>
    <div class="sidebar-label">WORKFLOW</div>
    <ol class="workflow-list">${items.map((item, index) => `
      <li class="workflow-item ${item.view === productView ? "is-current" : ""} ${item.view === "source" && currentSource().selected ? "is-complete" : ""}">
        <button type="button" data-workflow-view="${item.view}" aria-current="${item.view === productView ? "step" : "false"}">
          <span class="workflow-number">${item.view === "source" && currentSource().selected ? "✓" : item.number}</span>
          <span>${item.label}</span>
        </button>
      </li>`).join("")}</ol>
    <div class="sidebar-spacer"></div>
    <div class="sidebar-footer">
      <span class="fixture-avatar" aria-hidden="true">S</span>
      <span><strong>Synthetic source</strong><small>Fixture · ${escapeHtml(state.scenarioId.replace("media.scenario.", ""))}</small></span>
    </div>
  </aside>`;
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

function sourceCard(): string {
  return `<section class="source-card" aria-labelledby="source-title">
    <div class="source-card-top"><div class="source-wave-icon" aria-hidden="true"><svg viewBox="0 0 40 40"><path d="M4 21h3l3-8 4 16 4-22 4 25 4-18 4 12 3-5h3" /></svg></div>
      <div class="source-copy"><div class="source-name-row"><h2 id="source-title">${escapeHtml(currentSource().displayName)}</h2>${statusPill(currentSource().lifecycle)}</div>
        <p>Audio recording <span class="dot-separator">·</span> ${escapeHtml(currentSource().artifactVersion)} <span class="dot-separator">·</span> 14 sec</p></div>
      <button class="icon-button quiet" type="button" aria-label="Review source metadata" data-action="inspect-source">•••</button>
    </div>
    <div class="source-trust-row"><span class="trust-tag source-tag"><span class="trust-icon">S</span> Original source</span><span class="trust-separator"></span><span class="trust-detail">Source remains unchanged</span><button class="text-button" type="button" data-action="inspect-provenance" ${latestProjection().safeActionIds.includes("media.action.inspect-provenance") ? "" : "disabled"}>View provenance</button></div>
  </section>`;
}

function syntheticWaveform(): string {
  const bars = Array.from({ length: 86 }, (_, index) => {
    const envelope = Math.sin(Math.PI * (index + 5) / 94) * 0.64 + 0.16;
    const texture = Math.abs(Math.sin(index * 2.73) * Math.cos(index * 0.41));
    const height = Math.round(9 + envelope * texture * 37 + (index % 7 === 0 ? 6 : 0));
    const amplitude = height < 23 ? "short" : height < 39 ? "medium" : "tall";
    const selected = index * currentSource().durationTicks / 86 <= state.playbackPositionTick;
    return `<span class="wave-bar is-${amplitude} ${selected ? "is-playhead" : ""}" aria-hidden="true"></span>`;
  }).join("");
  return `<div class="waveform" role="img" aria-label="Synthetic waveform preview. No audio media is included in this fixture."><div class="wave-bars">${bars}</div><div class="wave-markers"><span>00:00</span><span>00:04</span><span>00:08</span><span>00:12</span><span>00:14</span></div></div>`;
}

function playbackCard(): string {
  const seekAvailable = latestProjection().safeActionIds.includes("media.action.seek-source");
  return `<section class="playback-card" aria-label="Source timing">
    <div class="playback-topline"><div class="playback-state"><span class="play-indicator" aria-hidden="true">Ⅱ</span><div><strong>Source time</strong><small>Playback is unavailable in this fixture</small></div></div>
      <span class="time-readout">${formatTimestamp(state.playbackPositionTick)} <span>/</span> 00:14.0</span></div>
    ${syntheticWaveform()}
    <label class="sr-only" for="source-position">Move through source time</label>
    <input id="source-position" class="source-seek" type="range" min="0" max="${currentSource().durationTicks}" step="100" value="${state.playbackPositionTick}" ${seekAvailable ? "" : "disabled"} aria-describedby="source-time-help" />
    <div class="playback-bottomline"><span id="source-time-help" class="source-time-help">Use the slider or segment time to inspect an exact source-clock position.</span><span class="clock-basis">${escapeHtml(currentSource().clockId)} · ${currentSource().ticksPerSecond.toLocaleString()} ticks/sec</span></div>
  </section>`;
}

function jobSummary(): string {
  const job = state.job;
  const title = job.state === "COMPLETED" ? "Transcript ready to review" : job.state === "OUTCOME_UNKNOWN" ? "Request outcome not confirmed" : job.state === "NOT_SUBMITTED" ? "Ready to transcribe" : readableLabel(job.state);
  const detail = job.state === "OUTCOME_UNKNOWN"
    ? "The request may have started. Check the job outcome before submitting another request."
    : job.state === "COMPLETED"
      ? "The result is linked to the original recording and ready for review."
      : job.state === "NOT_SUBMITTED"
        ? "Choose the language and start a request when consent and source checks are ready."
        : `Current job state is ${readableLabel(job.state)}. Its finality remains visible while work is in progress.`;
  return `<div class="job-summary ${job.state === "OUTCOME_UNKNOWN" ? "is-caution" : ""}">
    <span class="job-status-mark" aria-hidden="true">${job.state === "COMPLETED" ? "✓" : job.state === "OUTCOME_UNKNOWN" ? "!" : job.state === "NOT_SUBMITTED" ? "↗" : "•••"}</span>
    <div class="job-summary-copy"><strong>${escapeHtml(title)}</strong><span>${escapeHtml(detail)}</span>${job.jobId ? `<small>Job ${escapeHtml(job.jobId)} <span>·</span> ${escapeHtml(readableLabel(job.finality))} finality</small>` : ""}</div>
    ${job.jobId && latestProjection().safeActionIds.includes("media.action.view-job-status") ? `<button class="button button-outline button-compact" type="button" data-action="view-job-status">View job status</button>` : ""}
    ${job.state === "OUTCOME_UNKNOWN" ? `<button class="button button-primary button-compact" type="button" data-action="check-job-outcome">Check job outcome</button>` : ""}
  </div>`;
}

function transcriptionJobSurface(): string {
  const job = state.job;
  if (!job.jobId) {
    return `<section class="editor-panel artifact-verification-panel"><div class="empty-transcript"><span class="empty-icon" aria-hidden="true">◷</span><div><strong>No transcription job to view</strong><p>Submit a transcription request before opening job status.</p></div><button class="button button-outline" type="button" data-workflow-view="transcript">Return to transcript</button></div></section>`;
  }

  const safeActions = latestProjection().safeActionIds;
  const cancellationPending = job.attemptState === "CANCEL_REQUESTED";
  const statusCopy: Readonly<Record<typeof job.state, string>> = {
    NOT_SUBMITTED: "No job has been submitted.",
    QUEUED: "This fixture reports an accepted job waiting to start.",
    RUNNING: "This fixture reports active work. It does not report measured progress.",
    OUTCOME_UNKNOWN: "The request may have started, but its outcome is not confirmed. Keep this job identity and check it before starting another request.",
    RECONCILING: "The existing job is being checked. No new transcription request was submitted.",
    COMPLETED: "The fixture reports confirmed completion. Any transcript remains a separate reviewable result.",
    PARTIALLY_SUCCEEDED: "The fixture reports partial success. Available results and remaining work are not detailed here.",
    FAILED: "The fixture reports a confirmed failure. Retry eligibility is not defined by this slice.",
    CANCELLED: "The fixture reports confirmed cancellation. This state is distinct from stopping observation.",
  };
  const nextStep = cancellationPending
    ? "Cancellation was requested. The job remains in progress until its owner confirms a final state."
    : job.state === "OUTCOME_UNKNOWN" || job.state === "RECONCILING"
      ? "Continue with this same job identity. Do not submit a replacement while the outcome is uncertain."
      : job.state === "QUEUED" || job.state === "RUNNING"
        ? "Keep observing this job, or request cancellation if the current authority allows it."
        : "Return to transcript review when a source-linked transcript is available.";

  return `<section class="editor-panel artifact-verification-panel transcription-job-panel" aria-labelledby="transcription-job-heading">
    <div class="section-heading"><div><div class="eyebrow">EXISTING TRANSCRIPTION JOB</div><h2 id="transcription-job-heading">${escapeHtml(readableLabel(job.state))}</h2><p>${escapeHtml(statusCopy[job.state])}</p></div>${statusPill(job.state)}</div>
    <dl class="artifact-summary-grid">
      <div><dt>Job identity</dt><dd><code>${escapeHtml(job.jobId)}</code></dd></div>
      <div><dt>Source version</dt><dd><code>${escapeHtml(currentSource().artifactVersion)}</code></dd></div>
      <div><dt>Execution attempt state</dt><dd>${escapeHtml(job.attemptState ? readableLabel(job.attemptState) : "Not recorded")}</dd></div>
      <div><dt>Finality</dt><dd>${escapeHtml(readableLabel(job.finality))}</dd></div>
      <div><dt>Progress</dt><dd>Not measured</dd></div>
      <div><dt>Current stage</dt><dd>Not reported</dd></div>
    </dl>
    <div class="artifact-next-action"><strong>Safe next step</strong><p>${escapeHtml(nextStep)}</p>
      <div class="job-status-actions">
        <button class="button button-outline" type="button" data-workflow-view="transcript">Stop watching</button>
        ${!cancellationPending && safeActions.includes("media.action.request-cancellation") ? `<button class="button button-outline" type="button" data-action="request-cancellation">Request to stop this job</button>` : ""}
        ${safeActions.includes("media.action.check-job-outcome") ? `<button class="button button-primary" type="button" data-action="check-job-outcome">Check job outcome</button>` : ""}
      </div>
    </div>
    ${cancellationPending ? `<p class="artifact-fixture-note" role="status">Cancellation is requested. The job may still be running until its owner confirms it stopped.</p>` : ""}
    <p class="artifact-fixture-note" role="note">Fixture-only status: no live subscription, measured progress, attempt identifier, request key, or output list is connected. Stop watching changes only this view. Retry is unavailable in this slice.</p>
  </section>`;
}

function transcriptSegments(): string {
  const segments = state.transcript.segments;
  if (segments.length === 0) {
    return `<div class="empty-transcript"><span class="empty-icon" aria-hidden="true">Aa</span><div><strong>No transcript yet</strong><p>Start a transcription request to create source-linked recognized text.</p></div><button class="button button-primary" type="button" data-action="request-transcription">Start transcription</button></div>`;
  }
  return `<div class="segment-list">${segments.map((segment) => {
    const active = segment.segmentId === selectedSegmentId;
    const captionSegment = state.captionDraft.segments.find((item) => item.segmentId === segment.segmentId) ?? segment;
    const start = segment.startTick === null ? "Needs alignment" : formatTimestamp(segment.startTick);
    const end = segment.endTick === null ? "—" : formatTimestamp(segment.endTick);
    return `<article class="segment-card ${active ? "is-active" : ""}" data-segment-card="${escapeHtml(segment.segmentId)}">
      <div class="segment-time"><button class="time-link" type="button" data-seek="${segment.startTick ?? 0}" data-segment="${escapeHtml(segment.segmentId)}" aria-label="Move source position to ${escapeHtml(start)}" ${latestProjection().safeActionIds.includes("media.action.seek-source") ? "" : "disabled"}>${escapeHtml(start)}</button><span aria-hidden="true">—</span><span>${escapeHtml(end)}</span></div>
      <div class="segment-main"><div class="segment-meta"><span class="speaker-label">${escapeHtml(segment.speakerLabel ?? "Speaker not labeled")}</span>${statusPill(segment.origin === "RECOGNIZED" ? "RECOGNIZED" : "USER_EDITED", "")}</div>
        <p class="recognized-text">${escapeHtml(segment.text)}</p>
        <div class="caption-edit"><label for="caption-${escapeHtml(segment.segmentId)}">Caption text <span class="origin-inline">${segment.origin === "RECOGNIZED" ? "Recognized · review required" : "Edited draft"}</span></label>
          <textarea id="caption-${escapeHtml(segment.segmentId)}" data-caption-text="${escapeHtml(segment.segmentId)}" rows="2" maxlength="500" aria-label="Caption text for ${escapeHtml(segment.segmentId)}" ${productView === "captions" && latestProjection().safeActionIds.includes("media.action.correct-caption") ? "" : "disabled"}>${escapeHtml(captionSegment.text)}</textarea>
          <div class="segment-edit-actions"><span class="character-count">${captionSegment.text.length} / 500</span><button class="text-button" type="button" data-correct="${escapeHtml(segment.segmentId)}" ${productView === "captions" && latestProjection().safeActionIds.includes("media.action.correct-caption") ? "" : "disabled"}>Update draft</button></div>
        </div>
      <div class="timing-row"><label>Start <input type="number" min="0" max="${currentSource().durationTicks}" step="100" value="${segment.startTick ?? ""}" data-start-tick="${escapeHtml(segment.segmentId)}" aria-label="Start tick for ${escapeHtml(segment.segmentId)}" ${productView === "captions" && latestProjection().safeActionIds.includes("media.action.align-caption-timing") ? "" : "disabled"} /></label><span class="timing-divider">→</span><label>End <input type="number" min="0" max="${currentSource().durationTicks}" step="100" value="${segment.endTick ?? ""}" data-end-tick="${escapeHtml(segment.segmentId)}" aria-label="End tick for ${escapeHtml(segment.segmentId)}" ${productView === "captions" && latestProjection().safeActionIds.includes("media.action.align-caption-timing") ? "" : "disabled"} /></label><span class="timing-source">${escapeHtml(currentSource().clockId)}</span><button class="text-button" type="button" data-align="${escapeHtml(segment.segmentId)}" ${productView === "captions" && latestProjection().safeActionIds.includes("media.action.align-caption-timing") ? "" : "disabled"}>Update timing</button></div>
      </div>
    </article>`;
  }).join("")}</div>`;
}

function editorMain(): string {
  const aligned = state.captionDraft.timingDisposition === "ALIGNED";
  const saveAllowed = latestProjection().safeActionIds.includes("media.action.save-caption-version");
  return `<section class="editor-panel" aria-labelledby="transcript-heading">
    <div class="section-heading"><div><div class="eyebrow">SOURCE-LINKED TEXT</div><h2 id="transcript-heading">Correct captions</h2><p>Correct recognized text and align it to source time before saving a new version.</p></div>
      <div class="section-heading-actions">${state.transcript.languageTag ? `<span class="language-chip">${escapeHtml(state.transcript.languageTag.toUpperCase())}</span>` : ""}<button class="icon-button quiet" type="button" aria-label="Inspect transcript provenance" data-action="inspect-provenance">↗</button></div></div>
    ${jobSummary()}
    ${state.captionDraft.hasConflict ? `<div class="conflict-banner" role="group" aria-label="Caption version conflict"><div><strong>Newer caption version detected</strong><span>Compare both versions before resolving the local draft.</span></div><button class="button button-outline button-compact" type="button" data-action="compare-caption-versions" ${latestProjection().safeActionIds.includes("media.action.compare-caption-versions") ? "" : "disabled"}>Compare versions</button><button class="button button-quiet button-compact" type="button" data-resolve-conflict="keep-local" ${latestProjection().safeActionIds.includes("media.action.resolve-caption-conflict") ? "" : "disabled"}>Keep my edits</button><button class="button button-quiet button-compact" type="button" data-resolve-conflict="use-latest" ${latestProjection().safeActionIds.includes("media.action.resolve-caption-conflict") ? "" : "disabled"}>Use latest</button></div>` : ""}
    ${playbackCard()}
    <div class="segments-header"><div><h3>Transcript segments</h3><span class="muted-text">${state.transcript.segments.length} segments <span>·</span> ${aligned ? "Timing aligned" : "Timing needs review"}</span></div><span class="origin-key"><i class="legend-recognized"></i> Machine recognized <i class="legend-edited"></i> Your edits</span></div>
    ${transcriptSegments()}
    <div class="save-bar"><div class="save-status"><span class="save-status-icon ${aligned ? "is-ready" : ""}">${aligned ? "✓" : "!"}</span><div><strong>${aligned ? "Ready to save a new caption version" : "Timing review required"}</strong><small>${aligned ? "The source recording stays unchanged." : "Align every segment on the source clock before saving."}</small></div></div><div class="save-actions"><label class="version-purpose" for="caption-version-purpose">Version purpose<input id="caption-version-purpose" type="text" maxlength="240" value="${escapeHtml(versionPurpose)}" placeholder="What changed and why?" ${saveAllowed ? "" : "disabled"} /></label><button class="button button-quiet" type="button" data-workflow-view="versions">View versions</button><button class="button button-primary" type="button" data-action="save-caption-version" ${saveAllowed && versionPurpose.trim() ? "" : "disabled"}>Save caption version</button></div></div>
  </section>`;
}

function detailSidebar(): string {
  if (!detailsVisible) return `<aside class="details-sidebar details-hidden"><button class="button button-outline full-width" type="button" data-toggle-details>View source and job information</button></aside>`;
  const job = state.job;
  return `<aside class="details-sidebar" aria-label="Source and job information">
    <div class="details-header"><h2>Source and job information</h2><button class="text-button" type="button" data-toggle-details>Hide source and job information</button></div>
    <section class="detail-section"><div class="detail-heading"><span>Source recording</span><button type="button" class="text-button" data-action="inspect-source">Inspect</button></div><div class="detail-title"><span class="audio-file-icon" aria-hidden="true">♫</span><div><strong>${escapeHtml(currentSource().displayName)}</strong><small>${escapeHtml(currentSource().artifactVersion)}</small></div></div>
      <dl class="detail-list"><div><dt>Media kind</dt><dd>Audio</dd></div><div><dt>Integrity</dt><dd>${statusPill(currentSource().lifecycle)}</dd></div><div><dt>Consent</dt><dd>${statusPill(state.consentState)}</dd></div><div><dt>Source clock</dt><dd>${currentSource().ticksPerSecond.toLocaleString()} Hz</dd></div></dl>
    </section>
    <section class="detail-section job-detail"><div class="detail-heading"><span>Transcription request</span><span class="detail-live">SYNTHETIC FIXTURE</span></div><div class="detail-title"><span class="job-icon" aria-hidden="true">◷</span><div><strong>${escapeHtml(job.jobId ?? "No job submitted")}</strong><small>${escapeHtml(job.state === "NOT_SUBMITTED" ? "Ready when you are" : readableLabel(job.state))}</small></div></div>
      <dl class="detail-list"><div><dt>Finality</dt><dd>${escapeHtml(readableLabel(job.finality))}</dd></div><div><dt>Consent</dt><dd>${escapeHtml(readableLabel(state.consentState))}</dd></div><div><dt>Transcript</dt><dd>${escapeHtml(state.transcript.versionId ?? "Not available")}</dd></div><div><dt>Caption draft</dt><dd>${escapeHtml(state.captionDraft.versionId ?? "Not created")}</dd></div></dl>
      ${job.state === "RUNNING" || job.state === "QUEUED" ? `<button class="button button-outline full-width" type="button" data-action="request-cancellation">Request to stop this job</button>` : ""}
      ${job.state === "OUTCOME_UNKNOWN" ? `<button class="button button-primary full-width" type="button" data-action="check-job-outcome">Check job outcome</button>` : ""}
    </section>
    <section class="trust-card"><div class="trust-card-icon" aria-hidden="true">✓</div><div><strong>Source protected</strong><p>Caption edits create a new version. They never overwrite the original recording.</p><button class="text-button" type="button" data-action="inspect-provenance">Review provenance <span aria-hidden="true">→</span></button></div></section>
    <section class="version-list"><div class="detail-heading"><span>Saved caption versions</span><span class="count-pill">${state.registeredCaptionVersions.length}</span></div>${state.registeredCaptionVersions.length ? state.registeredCaptionVersions.map((version, index) => `<div class="version-row"><span class="version-mark">V${index + 1}</span><span><strong>${escapeHtml(version)}</strong><small>${escapeHtml(state.captionHistory[index]?.purpose ?? "Caption review")} · based on ${escapeHtml(state.captionHistory[index]?.sourceArtifactVersion ?? currentSource().artifactVersion)}</small></span><span class="version-check" aria-hidden="true">✓</span></div>`).join("") : `<p class="empty-note">No caption version saved yet.</p>`}</section>
  </aside>`;
}

function artifactVerificationSurface(isPreview: boolean): string {
  const verification = state.workflow === "artifact-verification" ? state.artifactVerification : null;
  if (!verification) return "";
  const actions = latestProjection().safeActionIds;
  const evidence = verification.evidence.length
    ? `<ul class="verification-evidence-list">${verification.evidence.map((entry) => `<li><code>${escapeHtml(entry)}</code></li>`).join("")}</ul>`
    : `<p class="muted-text">No confirming verification evidence is available in this fixture.</p>`;
  const nextStep = verification.status === "OUTCOME_UNKNOWN"
    ? "Keep the same job and upload identities until owner evidence classifies the result."
    : verification.status === "RUNNING"
      ? "View this same job for an updated verification stage and finality."
      : "Use only the verification evidence recorded for this exact job identity.";
  const progress = verification.progressPercent === null ? "Unavailable" : `${verification.progressPercent}%`;
  const isActivityView = productView === "review-activity";
  const pageTitle = isActivityView ? productViewTitles["review-activity"] : productViewTitles["job-status"];
  const pageSubtitle = isActivityView
    ? "Review the current fixture job and open its exact status before taking another action."
    : "View the owner-issued job status and its related upload as separate identities.";
  const activitySummary = verification.status === "OUTCOME_UNKNOWN"
    ? "Needs a status check"
    : verification.status === "RUNNING"
      ? "In progress"
      : "Completed";
  const activityContent = `<section class="editor-panel artifact-activity-panel" aria-labelledby="activity-list-heading">
      <div class="section-heading"><div><div class="eyebrow">CURRENT WORKFLOW</div><h2 id="activity-list-heading">Artifact verification</h2><p>This fixture contains one owner-issued job. It does not represent a complete activity feed.</p></div>${statusPill(verification.status)}</div>
      <article class="activity-job-card ${verification.status === "OUTCOME_UNKNOWN" ? "is-caution" : ""}" aria-labelledby="activity-job-title">
        <div class="activity-job-mark" aria-hidden="true">${verification.status === "OUTCOME_UNKNOWN" ? "!" : verification.status === "RUNNING" ? "…" : "✓"}</div>
        <div class="activity-job-copy"><h3 id="activity-job-title">${escapeHtml(activitySummary)}</h3><span>Artifact verification · ${escapeHtml(readableLabel(verification.stage))}</span><small>Job <code>${escapeHtml(verification.jobId)}</code></small><small>Related upload <code>${escapeHtml(verification.uploadId)}</code></small></div>
        <div class="activity-job-action">${actions.includes("media.action.view-job-status") ? `<button class="button button-outline" type="button" data-action="view-job-status">View job status</button>` : `<span class="muted-text">The fixture does not grant access to job information.</span>`}</div>
      </article>
      <p class="artifact-fixture-note" role="note">Synthetic activity only. No event time, production job list, or artifact-service evidence is available in this fixture.</p>
    </section>`;
  const jobContent = `<section class="editor-panel artifact-verification-panel"><div class="section-heading"><div><div class="eyebrow">SYNTHETIC VERIFICATION JOB</div><h2>${escapeHtml(readableLabel(verification.status))}</h2><p>This fixture does not call an artifact service or inspect file bytes.</p></div>${statusPill(verification.status)}</div>
        <dl class="artifact-summary-grid"><div><dt>Job identity</dt><dd><code>${escapeHtml(verification.jobId)}</code></dd></div><div><dt>Related upload identity</dt><dd><code>${escapeHtml(verification.uploadId)}</code></dd></div><div><dt>Verification stage</dt><dd>${escapeHtml(readableLabel(verification.stage))}</dd></div><div><dt>Progress</dt><dd>${escapeHtml(progress)}</dd></div><div><dt>Finality</dt><dd>${escapeHtml(readableLabel(verification.finality))}</dd></div></dl>
        <div class="artifact-next-action"><strong>Safe next step</strong><p>${escapeHtml(nextStep)}</p>${actions.includes("media.action.view-job-status") ? `<button class="button button-outline" type="button" data-action="view-job-status">View job status</button>` : ""}${actions.includes("media.action.check-job-outcome") ? `<button class="button button-primary" type="button" data-action="check-job-outcome">Check job outcome</button>` : ""}</div>
        <div class="verification-evidence"><h3>Recorded evidence</h3>${evidence}</div>
      </section>
      <p class="artifact-fixture-note" role="note">Synthetic evidence only. The owner-issued verification contract is not connected, so these states do not establish artifact availability.</p>`;
  return `<div class="product-app ${highContrast ? "contrast-on" : ""} ${reducedMotion ? "motion-reduced" : ""}" data-viewport="${viewportWidth}">
    <header class="product-topbar"><div class="product-brand"><span class="product-mark" aria-hidden="true">M</span><span>Media</span><span class="brand-divider"></span><span class="product-breadcrumb">Workspace <span aria-hidden="true">/</span> ${isActivityView ? "Activity" : "Media library"} <span aria-hidden="true">/</span> ${isActivityView ? "Review activity" : "Verification job"}</span></div></header>
    <div class="product-workspace">${renderProductNavigation()}<main class="product-main" id="${isPreview ? "product-preview-main" : "main-content"}" ${isPreview ? "" : "tabindex=\"-1\""}>
      <div class="page-title-row"><div><div class="breadcrumb-line"><span>Workspace</span><span aria-hidden="true">/</span><span>${isActivityView ? "Activity" : "Media library"}</span><span aria-hidden="true">/</span><span>${isActivityView ? "Current job" : "Verification job"}</span></div><h1>${pageTitle}</h1><p>${pageSubtitle}</p></div></div>
      ${isActivityView ? activityContent : jobContent}
      <div class="toast-region" aria-hidden="true">${transientAnnouncement ? escapeHtml(transientAnnouncement) : ""}</div>
    </main></div>
  </div>`;
}

function artifactIntakeSurface(isPreview: boolean): string {
  const intake = state.artifactIntake!;
  const safeActions = latestProjection().safeActionIds;
  const page = productView === "browse" ? {
    title: productViewTitles.browse,
    subtitle: "Review artifact versions that are available in this synthetic workspace.",
  } : productView === "import" ? {
    title: productViewTitles.import,
    subtitle: "Inspect one stable transfer identity and its recorded recovery state.",
  } : {
    title: productViewTitles.artifact,
    subtitle: "Inspect the exact version and keep integrity separate from policy disposition.",
  };
  const status = statusPill(intake.status);
  const integrity = statusPill(intake.integrity);
  const fixtureNote = `<p class="artifact-fixture-note" role="note">Synthetic metadata fixture. No file bytes are included or transferred, and no production format limit is implied.</p>`;
  let content: string;

  if (productView === "browse") {
    content = intake.status === "AVAILABLE" && intake.artifactVersion
      ? `<section class="editor-panel artifact-intake-panel"><div class="section-heading"><div><div class="eyebrow">AVAILABLE ARTIFACT VERSION</div><h2>${escapeHtml(intake.sourceName)}</h2><p>One immutable version is available in this scenario.</p></div>${status}</div><dl class="artifact-summary-grid"><div><dt>Artifact version</dt><dd>${escapeHtml(intake.artifactVersion)}</dd></div><div><dt>Integrity</dt><dd>${integrity}</dd></div><div><dt>Declared size</dt><dd>${intake.declaredByteSize?.toLocaleString() ?? "Unknown"} bytes</dd></div></dl><button class="button button-primary" type="button" data-workflow-view="artifact">Inspect artifact version</button>${fixtureNote}</section>`
      : `<section class="editor-panel artifact-intake-panel"><div class="empty-transcript"><span class="empty-icon" aria-hidden="true">M</span><div><strong>No available artifact in this fixture</strong><p>${intake.status === "ACCESS_REVOKED" ? "Current access does not permit viewing this artifact metadata." : "The current transfer has not produced an available artifact version."}</p></div><button class="button button-outline" type="button" data-workflow-view="import">Review import status</button></div>${fixtureNote}</section>`;
  } else if (productView === "import") {
    const canResume = safeActions.includes("media.action.resume-artifact-upload");
    content = `<section class="editor-panel artifact-intake-panel"><div class="section-heading"><div><div class="eyebrow">ONE STABLE UPLOAD IDENTITY</div><h2>${escapeHtml(intake.sourceName)}</h2><p>The upload identifier remains separate from any Media processing job.</p></div>${status}</div>
      <dl class="artifact-summary-grid"><div><dt>Upload identity</dt><dd><code>${escapeHtml(intake.uploadId)}</code></dd></div><div><dt>Transfer progress</dt><dd>${intake.acknowledgedPartCount} of ${intake.expectedPartCount ?? "unknown"} fixture-confirmed parts</dd></div><div><dt>Integrity state</dt><dd>${integrity}</dd></div><div><dt>Artifact version</dt><dd>${escapeHtml(intake.artifactVersion ?? "Not available")}</dd></div></dl>
      <div class="artifact-next-action"><strong>${intake.status === "INTERRUPTED" ? "Resume the same upload" : intake.status === "OUTCOME_UNKNOWN" ? "Inspect this upload before retrying" : "Use the recorded transfer disposition"}</strong><p>${intake.status === "OUTCOME_UNKNOWN" ? "The result is not confirmed. A new upload is unavailable until this same identity is inspected." : "The progress above belongs to the synthetic fixture; the browser has not sent bytes."}</p>
      ${canResume ? `<button class="button button-primary" type="button" data-action="resume-artifact-upload">Resume this fixture upload</button>` : safeActions.includes("media.action.inspect-artifact") ? `<button class="button button-outline" type="button" data-action="inspect-artifact">Inspect current upload</button>` : `<span class="muted-text">No transfer action is available under the current fixture authority.</span>`}</div>${fixtureNote}</section>`;
  } else {
    const identityLabel = intake.artifactVersion ? "Immutable artifact version" : "Upload identity";
    const identityValue = intake.artifactVersion ?? intake.uploadId;
    content = `<section class="editor-panel artifact-intake-panel"><div class="section-heading"><div><div class="eyebrow">INTEGRITY AND POLICY ARE SEPARATE</div><h2>${escapeHtml(intake.sourceName)}</h2><p>Availability follows the recorded integrity and policy outcome for this scenario.</p></div>${status}</div>
      <dl class="artifact-summary-grid"><div><dt>${identityLabel}</dt><dd><code>${escapeHtml(identityValue)}</code></dd></div><div><dt>Integrity disposition</dt><dd>${integrity}</dd></div><div><dt>Declared size</dt><dd>${intake.declaredByteSize?.toLocaleString() ?? "Unknown"} bytes</dd></div><div><dt>Artifact availability</dt><dd>${intake.status === "AVAILABLE" ? "Available" : "Not available"}</dd></div></dl>
      <div class="artifact-next-action"><strong>${intake.status === "AVAILABLE" ? "Verified artifact version" : intake.status === "QUARANTINED" ? "Review required" : intake.status === "REJECTED" ? "Artifact rejected" : intake.status === "ACCESS_REVOKED" ? "Access revoked" : "Transfer status needs inspection"}</strong><p>${intake.status === "AVAILABLE" ? "This fixture records size, part integrity, digest, format, and required policy checks as satisfied." : intake.status === "QUARANTINED" ? "The artifact remains unavailable while an authorized review disposition is pending." : intake.status === "REJECTED" ? "The artifact was not promoted to an available version." : intake.status === "ACCESS_REVOKED" ? "Current access hides the artifact metadata and disables further transfer actions." : "No verified artifact version is available from this transfer."}</p>
      ${safeActions.includes("media.action.inspect-artifact") ? `<button class="button button-outline" type="button" data-action="inspect-artifact">Inspect recorded disposition</button>` : ""}</div>${fixtureNote}</section>`;
  }

  const view = `<div class="product-app ${highContrast ? "contrast-on" : ""} ${reducedMotion ? "motion-reduced" : ""}" data-viewport="${viewportWidth}">
    <header class="product-topbar"><div class="product-brand"><span class="product-mark" aria-hidden="true">M</span><span>Media</span><span class="brand-divider"></span><span class="product-breadcrumb">Workspace <span aria-hidden="true">/</span> ${escapeHtml(page.title)}</span></div></header>
    <div class="product-workspace">${renderProductNavigation()}<main class="product-main" id="${isPreview ? "product-preview-main" : "main-content"}" ${isPreview ? "" : "tabindex=\"-1\""}>
      <div class="page-title-row"><div><div class="breadcrumb-line"><span>Workspace</span><span aria-hidden="true">/</span><span>Media library</span><span aria-hidden="true">/</span><span>${escapeHtml(page.title)}</span></div><h1>${page.title}</h1><p>${page.subtitle}</p></div></div>
      ${content}<div class="toast-region" aria-hidden="true">${transientAnnouncement ? escapeHtml(transientAnnouncement) : ""}</div>
    </main></div>
  </div>`;
  return view;
}

function firstUseSurface(isPreview: boolean): string {
  const firstUse = state.workflow === "first-use" ? state.firstUse : null;
  if (!firstUse) return "";
  const safeActions = latestProjection().safeActionIds;
  const canCreate = safeActions.includes("media.action.create-project");
  const hasProtectedContext = firstUse.identityResolved && firstUse.workspaceAccess === "ALLOWED";
  const title = productViewTitles[productView];
  const subtitle = !firstUse.identityResolved
    ? "Resolve identity and workspace authority before showing protected projects."
    : firstUse.workspaceAccess === "DENIED"
      ? "Workspace access is required before project data can be shown."
      : firstUse.creationStatus === "OUTCOME_UNKNOWN"
        ? "Check the existing create request before considering another project."
        : firstUse.creationStatus === "CREATED"
          ? "An empty project is ready; processing intent is a separate decision."
          : "Create an empty project without choosing a source or starting processing.";
  let content: string;
  if (!firstUse.identityResolved) {
    content = `<section class="editor-panel first-use-panel"><div class="section-heading"><div><div class="eyebrow">IDENTITY HANDOFF REQUIRED</div><h2>Sign in to continue</h2><p>Protected workspace and project data remain hidden until the admitted identity contract resolves.</p></div>${statusPill("PENDING")}</div><div class="artifact-next-action"><strong>Authentication is not connected in this preview</strong><p>This synthetic fixture cannot sign in, resolve a principal, or contact the Shared identity service. Return destination: ${escapeHtml(firstUse.returnDestination)}.</p></div></section>`;
  } else if (firstUse.workspaceAccess === "DENIED") {
    content = `<section class="editor-panel first-use-panel"><div class="section-heading"><div><div class="eyebrow">WORKSPACE ACCESS</div><h2>Workspace unavailable</h2><p>Project data stays hidden while current workspace access is denied.</p></div>${statusPill("DENIED")}</div><div class="artifact-next-action"><strong>Request approved workspace access</strong><p>The access request route is not bound in this preview. Return destination is preserved as ${escapeHtml(firstUse.returnDestination)}.</p></div></section>`;
  } else if (firstUse.creationStatus === "OUTCOME_UNKNOWN") {
    content = `<section class="editor-panel first-use-panel"><div class="section-heading"><div><div class="eyebrow">EXISTING CREATE REQUEST</div><h2>Project outcome not confirmed</h2><p>The same request identity must be inspected before another create action.</p></div>${statusPill("OUTCOME_UNKNOWN")}</div><dl class="artifact-summary-grid"><div><dt>Workspace</dt><dd>${escapeHtml(firstUse.workspaceId ?? "Unavailable")}</dd></div><div><dt>Create request</dt><dd><code>${escapeHtml(firstUse.createRequestId ?? "Unavailable")}</code></dd></div></dl><div class="artifact-next-action"><strong>No retry is available</strong><p>No authoritative project lookup is connected, so this fixture keeps the outcome unknown.</p><button class="button button-outline" type="button" data-action="inspect-project-creation" ${safeActions.includes("media.action.inspect-project-creation") ? "" : "disabled"}>Inspect existing request</button></div></section>`;
  } else if (firstUse.creationStatus === "CREATED") {
    content = `<section class="editor-panel first-use-panel"><div class="section-heading"><div><div class="eyebrow">EMPTY PROJECT CREATED</div><h2>${escapeHtml(firstUse.intentDisposition === "UNAVAILABLE" ? "Project is ready; intent unavailable" : "Your project is ready")}</h2><p>The project has a stable identity and version. No source or processing job was created.</p></div>${statusPill("CREATED")}</div><dl class="artifact-summary-grid"><div><dt>Workspace</dt><dd><code>${escapeHtml(firstUse.workspaceId ?? "Unavailable")}</code></dd></div><div><dt>Project</dt><dd><code>${escapeHtml(firstUse.projectId ?? "Unavailable")}</code></dd></div><div><dt>Project version</dt><dd><code>${escapeHtml(firstUse.projectVersion ?? "Unavailable")}</code></dd></div><div><dt>Create request</dt><dd><code>${escapeHtml(firstUse.createRequestId ?? "Unavailable")}</code></dd></div></dl><div class="artifact-next-action"><strong>${firstUse.intentDisposition === "UNAVAILABLE" ? "The requested intent is unavailable here" : "Choose a safe next step"}</strong><p>${firstUse.intentDisposition === "UNAVAILABLE" ? "The empty project remains available. No processing intent was submitted; return to the project and choose only an admitted alternative." : "Project creation is complete. Selecting a processing intent belongs to its own journey."}</p></div></section>`;
  } else {
    content = `<section class="editor-panel first-use-panel"><div class="section-heading"><div><div class="eyebrow">AUTHORIZED FIRST USE</div><h2>No projects yet</h2><p>Create an empty project in the selected workspace. A source and processing intent are not required.</p></div>${statusPill("ALLOWED")}</div><dl class="artifact-summary-grid"><div><dt>Workspace</dt><dd>${escapeHtml(firstUse.workspaceId ?? "Unavailable")}</dd></div><div><dt>Project creation</dt><dd>${escapeHtml(firstUse.projectCreateAuthority === "ALLOWED" ? "Authorized" : "Not authorized")}</dd></div></dl><div class="artifact-next-action"><strong>Start with an empty project</strong><p>Creation runs only in the local synthetic fixture; no project service or Media processing runtime is called.</p><button class="button button-primary" type="button" data-action="create-project" ${canCreate ? "" : "disabled"}>Create empty project</button></div></section>`;
  }
  const note = `<p class="first-use-fixture-note" role="note">Synthetic first-use fixture. It does not authenticate a user, access a real workspace, or create a production project.</p>`;
  return `<div class="product-app ${highContrast ? "contrast-on" : ""} ${reducedMotion ? "motion-reduced" : ""}" data-viewport="${viewportWidth}">
    <header class="product-topbar"><div class="product-brand"><span class="product-mark" aria-hidden="true">M</span><span>Media</span><span class="brand-divider"></span><span class="product-breadcrumb">Workspace <span aria-hidden="true">/</span> ${escapeHtml(title)}</span></div></header>
    <div class="product-workspace">${renderProductNavigation()}<main class="product-main" id="${isPreview ? "product-preview-main" : "main-content"}" ${isPreview ? "" : "tabindex=\"-1\""}>
      <div class="page-title-row"><div><div class="breadcrumb-line"><span>Workspace</span><span aria-hidden="true">/</span><span>Projects</span><span aria-hidden="true">/</span><span>${escapeHtml(title)}</span></div><h1>${escapeHtml(title)}</h1><p>${escapeHtml(subtitle)}</p></div></div>
      ${content}${note}<div class="toast-region" aria-hidden="true">${transientAnnouncement ? escapeHtml(transientAnnouncement) : ""}</div>
    </main></div>
  </div>`;
}

function productSurface(isPreview = false): string {
  if (state.workflow === "first-use") return firstUseSurface(isPreview);
  if (state.workflow === "artifact-intake") return artifactIntakeSurface(isPreview);
  if (state.workflow === "artifact-verification") return artifactVerificationSurface(isPreview);
  const jobUncertain = state.job.state === "OUTCOME_UNKNOWN";
  const viewSubtitles: Readonly<Record<ProductView, string>> = {
    setup: "Resolve identity and workspace access before protected data is shown.",
    projects: "Review authorized projects in the current workspace.",
    project: "Inspect the exact project identity and version.",
    source: "Confirm the exact recording, rights, and source clock before processing.",
    transcript: "Review the source-linked text and check the transcription status.",
    captions: "Correct text and align each segment on the source recording clock.",
    versions: "Compare saved revisions while preserving their source lineage.",
    browse: "Review available Media artifacts.",
    import: "Inspect an authorized source transfer.",
    artifact: "Inspect an exact artifact version and its integrity state.",
    "review-activity": "Review the current fixture job and open its exact status before taking another action.",
    "job-status": "View the existing job status, its source version, and safe next action.",
  };
  const view = { title: activeProductViewTitle(), subtitle: viewSubtitles[productView] };
  const safeActions = latestProjection().safeActionIds;
  const canRequestTranscription = safeActions.includes("media.action.request-transcription");
  const primaryWorkflowAction = state.job.state === "OUTCOME_UNKNOWN"
    ? productView === "source" ? `<button class="button button-primary" type="button" data-action="check-job-outcome">Check job outcome</button>` : ""
    : canRequestTranscription
      ? `<div class="request-action-group"><label class="language-choice" for="transcription-language">Language<select id="transcription-language"><option value="en-US" ${state.transcript.languageTag === "en-US" || state.transcript.languageTag === "en" ? "selected" : ""}>English (US)</option><option value="es-ES" ${state.transcript.languageTag === "es" || state.transcript.languageTag === "es-ES" ? "selected" : ""}>Español</option><option value="fr-FR" ${state.transcript.languageTag === "fr" || state.transcript.languageTag === "fr-FR" ? "selected" : ""}>Français</option><option value="hi-IN" ${state.transcript.languageTag === "hi" || state.transcript.languageTag === "hi-IN" ? "selected" : ""}>हिन्दी</option></select></label><button class="button button-primary" type="button" data-action="request-transcription">New transcription</button></div>`
      : productView === "source" && state.job.jobId && safeActions.includes("media.action.view-job-status")
        ? `<button class="button button-outline" type="button" data-action="view-job-status">View job status</button>`
        : productView === "transcript" && state.job.jobId
          ? ""
        : safeActions.includes("media.action.choose-source")
          ? `<button class="button button-outline" type="button" data-workflow-view="source">Choose a source first</button>`
          : `<button class="button button-primary" type="button" disabled>Transcription unavailable</button>`;
  const viewContent = productView === "source"
    ? `<div class="source-review-grid">${sourceCard()}${playbackCard()}<section class="source-review-detail"><div><span class="eyebrow">SOURCE AUTHORITY</span><h2>Review recording metadata</h2></div><dl class="detail-list"><div><dt>Version</dt><dd>${escapeHtml(currentSource().artifactVersion)}</dd></div><div><dt>Lifecycle</dt><dd>${statusPill(currentSource().lifecycle)}</dd></div><div><dt>Rights and consent</dt><dd>${statusPill(state.consentState)}</dd></div><div><dt>Clock</dt><dd>${escapeHtml(currentSource().clockId)} · ${currentSource().ticksPerSecond.toLocaleString()} ticks/sec</dd></div></dl><button class="button button-primary" type="button" data-action="choose-source" ${latestProjection().safeActionIds.includes("media.action.choose-source") ? "" : "disabled"}>${currentSource().selected ? "Recording selected" : "Choose this recording"}</button><p>Choosing records this exact source version. It does not start processing.</p></section></div>`
    : productView === "job-status"
      ? transcriptionJobSurface()
    : productView === "versions"
      ? `<section class="editor-panel version-review-panel"><div class="section-heading"><div><div class="eyebrow">IMMUTABLE DERIVED VERSIONS</div><h2>Saved caption versions</h2><p>Every registered version remains linked to its parent caption and exact source recording.</p></div></div>${state.captionHistory.length ? `<div class="version-review-list">${state.captionHistory.map((version, index) => `<article class="version-review-card"><div class="version-mark">V${index + 1}</div><div><strong>${escapeHtml(version.versionId)}</strong><p>Source ${escapeHtml(version.sourceArtifactVersion)} · parent ${escapeHtml(version.parentVersionId)}</p><small>${version.segments.length} segments</small></div></article>`).join("")}</div>${state.captionHistory.length > 1 ? `<button class="button button-outline" type="button" data-action="compare-caption-versions" ${latestProjection().safeActionIds.includes("media.action.compare-caption-versions") ? "" : "disabled"}>Compare the latest versions</button><div class="comparison-result" role="status">${escapeHtml(lastResult?.message ?? "Compare the latest two caption versions.")}</div>` : `<div class="artifact-next-action"><strong>Save one more version to compare</strong><p>Correct and save another caption version. The existing version remains unchanged.</p><button class="button button-outline" type="button" data-workflow-view="captions">Correct captions</button></div>`}` : `<div class="empty-transcript"><span class="empty-icon" aria-hidden="true">V</span><div><strong>No caption versions saved</strong><p>Save an aligned caption draft to create an immutable version with source lineage.</p></div><button class="button button-primary" type="button" data-workflow-view="captions">Correct captions</button></div>`}</section>`
      : productView === "captions"
        ? `<div class="work-columns"><div class="editor-column">${editorMain()}</div>${detailSidebar()}</div>`
        : `<section class="editor-panel transcript-review-panel"><div class="section-heading"><div><div class="eyebrow">SOURCE-LINKED TRANSCRIPT</div><h2>Recognized speech</h2><p>Recognition is a draft for review. Timing and uncertainty remain visible.</p></div>${state.transcript.languageTag ? `<span class="language-chip">${escapeHtml(state.transcript.languageTag.toUpperCase())}</span>` : ""}</div>${jobSummary()}${playbackCard()}${transcriptReadOnly()}</section>`;
  return `<div class="product-app ${highContrast ? "contrast-on" : ""} ${reducedMotion ? "motion-reduced" : ""}" data-viewport="${viewportWidth}">
    <header class="product-topbar"><div class="product-brand"><span class="product-mark" aria-hidden="true">M</span><span>Media</span><span class="brand-divider"></span><span class="product-breadcrumb">Oral histories <span aria-hidden="true">/</span> ${activeProductViewTitle()}</span></div></header>
    <div class="product-workspace">${renderProductNavigation()}<main class="product-main" id="${isPreview ? "product-preview-main" : "main-content"}" ${isPreview ? "" : "tabindex=\"-1\""}>
      <div class="page-title-row"><div><div class="breadcrumb-line"><span>Projects</span><span aria-hidden="true">/</span><span>Oral histories</span><span aria-hidden="true">/</span><span>Audio</span></div><h1>${view.title}</h1><p>${view.subtitle}</p></div>${productView === "transcript" || productView === "source" ? `<div class="page-title-actions">${primaryWorkflowAction}</div>` : ""}</div>
      ${viewContent}
      <div class="toast-region" aria-hidden="true">${transientAnnouncement ? escapeHtml(transientAnnouncement) : ""}</div>
    </main></div>
  </div>`;
}

function transcriptReadOnly(): string {
  if (!state.transcript.segments.length) return `<div class="empty-transcript"><span class="empty-icon" aria-hidden="true">Aa</span><div><strong>No transcript yet</strong><p>Start a transcription request to create source-linked recognized text.</p></div><button class="button button-primary" type="button" data-action="request-transcription" ${latestProjection().safeActionIds.includes("media.action.request-transcription") ? "" : "disabled"}>Start transcription</button></div>`;
  return `<div class="segment-list">${state.transcript.segments.map((segment) => `<article class="segment-card"><div class="segment-time"><button class="time-link" type="button" data-seek="${segment.startTick ?? 0}" data-segment="${escapeHtml(segment.segmentId)}" aria-label="Move source position to ${escapeHtml(segment.startTick === null ? "unknown time" : formatTimestamp(segment.startTick))}" ${latestProjection().safeActionIds.includes("media.action.seek-source") ? "" : "disabled"}>${segment.startTick === null ? "Needs alignment" : formatTimestamp(segment.startTick)}</button><span aria-hidden="true">—</span><span>${segment.endTick === null ? "—" : formatTimestamp(segment.endTick)}</span></div><div class="segment-main"><div class="segment-meta"><span class="speaker-label">${escapeHtml(segment.speakerLabel ?? "Speaker not labeled")}</span>${statusPill("RECOGNIZED")}</div><p class="recognized-text">${escapeHtml(segment.text)}</p><small class="muted-text">Recognition origin · not yet approved as captions</small></div></article>`).join("")}</div>`;
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
      ${channel === "web" ? productSurface(true) : terminalProjection()}
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
  if (!artifact.path.includes("/screen-contracts/") || !source.includes("schemaVersion: media.screen-contract.v1")) return "";
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
    <div class="view-preview-banner"><span class="view-preview-icon" aria-hidden="true">P2</span><div><strong>Read-only view contract preview</strong><p>This proposal preview shows declared content and hierarchy. Its actions are not connected to product behavior.</p></div><span class="view-preview-state">Proposal</span></div>
    <div class="view-preview-open-product"><span>Explore this declared view in the Product shell.</span><button type="button" class="button button-outline button-small" data-open-product-screen="${escapeHtml(artifact.path)}">Open Product projection <span aria-hidden="true">→</span></button></div>
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

function renderProductContractProjection(artifact: SpecificationArtifact, source: string, actionRegistrySource: string): string {
  if (!source.includes("schemaVersion: media.screen-contract.v1")) {
    return `<main class="product-contract-main" id="main-content" tabindex="-1"><a class="product-back-link" href="#product" data-product-home>← Media workspace</a><section class="product-contract-empty"><h1>View proposal unavailable</h1><p>This record does not define a Product view contract.</p><a class="button button-outline" href="#product" data-product-home>Return to Media</a></section></main>`;
  }
  const screenId = yamlTopLevelScalar(source, "screenId");
  const anatomy = yamlTopLevelList(source, "anatomy");
  if (!screenId || anatomy.length === 0) {
    return `<main class="product-contract-main" id="main-content" tabindex="-1"><a class="product-back-link" href="#product" data-product-home>← Media workspace</a><section class="product-contract-empty"><h1>View structure is incomplete</h1><p>This proposal is missing a screen identity or view regions.</p></section></main>`;
  }
  const screenName = artifact.title || readableLabel(screenId.split(".").at(-1)?.replaceAll("-", " ") ?? screenId);
  const purpose = yamlTopLevelScalar(source, "purpose");
  const readablePurpose = readableProposalPurpose(purpose, "Purpose is not specified in this proposal.");
  const context = yamlNestedTextFields(source, "contextGoalNowNext", ["context", "goal", "now", "next"]);
  const states = yamlTopLevelList(source, "states");
  const actions = yamlTopLevelList(source, "actions");
  const components = yamlTopLevelList(source, "componentRefs");
  const responsive = yamlTopLevelScalar(source, "responsive");
  const accessibility = yamlTopLevelScalar(source, "accessibility");
  const channels = yamlChannelDispositions(source);
  const actionLabels = yamlActionLabels(actionRegistrySource);
  const anatomyCards = anatomy.map((part) => `<article class="product-region-card"><span class="product-region-icon" aria-hidden="true">${escapeHtml(readableLabel(part.replaceAll("-", " ")).slice(0, 1))}</span><div><strong>${escapeHtml(readableLabel(part.replaceAll("-", " ")))}</strong><span>Declared view region</span></div></article>`).join("");
  const stateChips = states.map((item) => `<li>${escapeHtml(readableLabel(item.replaceAll("-", " ")))}</li>`).join("");
  const actionRows = actions.map((action, index) => {
    const label = actionLabels.get(action) ?? sentenceCase((action.replace(/^media\.action\./u, "").split(".").at(-1) ?? action).replaceAll("-", " "));
    return `<li class="product-proposal-action"><button type="button" disabled aria-describedby="proposal-action-note-${index}">${escapeHtml(label)}</button><code>${escapeHtml(action)}</code><small id="proposal-action-note-${index}">Not connected in this fixture</small></li>`;
  }).join("");
  const contextCards = (["context", "goal", "now", "next"] as const).filter((key) => context[key]).map((key) => `<article class="product-context-card"><span>${escapeHtml(readableLabel(key))}</span><p>${escapeHtml(context[key]!)}</p></article>`).join("");
  const detailRows = [
    ...channels.map(({ channel: channelRef, disposition }) => `<div><dt>${escapeHtml(channelDisplayName(channelRef))}</dt><dd>${escapeHtml(readableLabel(disposition.replaceAll("-", " ")))}</dd></div>`),
    ...(components.length ? [`<div><dt>Related components</dt><dd>${components.map((component) => escapeHtml(readableLabel(component.split(".").at(-1)?.replaceAll("-", " ") ?? component))).join(", ")}</dd></div>`] : []),
    ...(responsive ? [`<div><dt>Responsive guidance</dt><dd>${escapeHtml(responsive)}</dd></div>`] : []),
    ...(accessibility ? [`<div><dt>Accessibility guidance</dt><dd>${escapeHtml(accessibility)}</dd></div>`] : []),
  ].join("");
  return `<main class="product-contract-main" id="main-content" tabindex="-1">
    <a class="product-back-link" href="#product" data-product-home>← Media workspace</a>
    <div class="product-contract-heading"><div><div class="product-contract-breadcrumb">Workspace <span aria-hidden="true">/</span> ${escapeHtml(screenName)}</div><h1>${escapeHtml(screenName)}</h1><p>${escapeHtml(readablePurpose)}</p></div><span class="product-contract-status">PROPOSAL</span></div>
    <aside class="product-contract-notice" role="note"><span aria-hidden="true">i</span><div><strong>Proposal view · simulated structure</strong><p>This route projects the declared view contract. It does not represent connected product data or behavior.</p></div></aside>
    ${contextCards ? `<section class="product-context-grid" aria-label="Context, goal, now, and next step">${contextCards}</section>` : ""}
    <section class="product-contract-section" aria-labelledby="product-view-structure"><div class="product-contract-section-heading"><div><h2 id="product-view-structure">View structure</h2><p>Regions declared for this view</p></div><span>${anatomy.length} regions</span></div><div class="product-region-grid">${anatomyCards}</div></section>
    <div class="product-contract-columns">
      <section class="product-contract-section" aria-labelledby="product-view-states"><div class="product-contract-section-heading"><div><h2 id="product-view-states">View states</h2><p>States described by this proposal</p></div><span>${states.length}</span></div>${stateChips ? `<ul class="product-view-state-list">${stateChips}</ul>` : `<p class="product-proposal-empty">No view states are listed.</p>`}</section>
      <section class="product-contract-section" aria-labelledby="product-view-actions"><div class="product-contract-section-heading"><div><h2 id="product-view-actions">Available actions</h2><p>Actions declared for this view</p></div><span>${actions.length}</span></div>${actionRows ? `<ul class="product-proposal-action-list">${actionRows}</ul>` : `<p class="product-proposal-empty">No actions are listed.</p>`}</section>
    </div>
    ${detailRows ? `<details class="product-contract-details"><summary>View guidance and channel support</summary><dl>${detailRows}</dl></details>` : ""}
  </main>`;
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

function specificationSurface(): string {
  const phaseArtifacts = specificationArtifacts.filter((artifact) => artifact.phase === selectedPhase);
  const visibleArtifacts = filteredSpecificationArtifacts(phaseArtifacts);
  const activeArtifact = phaseArtifacts.find((artifact) => artifact.path === selectedArtifact.path) ?? phaseArtifacts[0]!;
  selectedArtifact = activeArtifact;
  ensureSpecificationContentLoaded(activeArtifact);
  const sourceContent = specificationContents.get(activeArtifact.path);
  const content = sourceContent ?? specificationErrors.get(activeArtifact.path) ?? "Loading source file…";
  return `<div class="specification-workspace ${highContrast ? "contrast-on" : ""}">
    <aside class="spec-sidebar"><div class="eyebrow">SOURCE OF MEANING</div><h1>Specification</h1><p>Inspect the source records behind this experience.</p>
      <div class="phase-selector" role="radiogroup" aria-label="Select an experience phase" aria-orientation="${phaseSelectorOrientation()}">${phaseIds.map((phase) => `<button id="${phaseTabId(phase)}" type="button" role="radio" aria-checked="${phase === selectedPhase}" tabindex="${phase === selectedPhase ? 0 : -1}" class="phase-tab ${phase === selectedPhase ? "is-current" : ""}" data-phase="${phase}"><span>${phase}</span><strong>${escapeHtml(phaseSummary[phase].title)}</strong></button>`).join("")}</div>
      <label class="artifact-filter-label" for="artifact-filter">Find a record</label><input id="artifact-filter" class="artifact-filter" type="search" value="${escapeHtml(artifactFilter)}" placeholder="Search titles and filenames" autocomplete="off" />
      <div class="spec-artifacts-heading"><span>AUTHORITY FILES</span><span id="artifact-count">${visibleArtifacts.length} of ${phaseArtifacts.length}</span></div>
      <nav class="artifact-list" aria-label="Phase artifacts">${renderSpecificationArtifactLinks(visibleArtifacts)}</nav>
    </aside>
    <main class="spec-document" id="main-content"><header class="spec-doc-header"><div><div class="eyebrow">${selectedPhase} · ${escapeHtml(phaseSummary[selectedPhase].title.toUpperCase())}</div><h2>${escapeHtml(activeArtifact.title)}</h2><p>${escapeHtml(activeArtifact.path)}</p></div><span class="proposal-chip"><span></span> ${escapeHtml(reviewStatusForArtifact(activeArtifact))}</span></header>
      <div class="spec-context"><div class="spec-context-icon">${selectedPhase}</div><div><strong>${escapeHtml(phaseSummary[selectedPhase].summary)}</strong><span>Read-only content bundled from the repository’s current authority file.</span></div></div>
      ${renderScreenContractPreview(activeArtifact, sourceContent ?? "")}
      <pre class="spec-source"><code>${escapeHtml(content)}</code></pre>
    </main>
    <aside class="spec-inspector"><div class="eyebrow">TRACE CONTEXT</div><h2>${escapeHtml(activeArtifact.title)}</h2><div class="trace-card"><span>Authority path</span><code>${escapeHtml(activeArtifact.path)}</code></div><div class="trace-card"><span>Product identity</span><code>ghatana.product/media</code></div><div class="trace-card"><span>Tools stage or scope</span><code>${escapeHtml(({ P0: "establish-product-definition", P1: "establish-experience-language", P2: "specify-executable-experience", P3: "materialize-implementation", "Cross-phase": "shared governance; not a phase" } as const)[selectedPhase])}</code></div><div class="trace-card"><span>Record status</span><strong>${escapeHtml(reviewStatusForArtifact(activeArtifact))}</strong></div><div class="trace-links"><h3>Related views</h3><button type="button" class="text-button" data-mode="verify">Open verification workspace →</button><button type="button" class="text-button" data-mode="explore">Inspect live scenario →</button></div></aside>
  </div>`;
}

function verificationSurface(): string {
  const phaseStates = [
    { id: "P0", title: "Product Truth", status: "Boundary accepted · definition review open", detail: "P0-001 boundary is accepted. Operation-specific proposals cover 17 of 462 capability leaves; 445 leaves, remaining product definition, and independent P0-010 review are open." },
    { id: "P1", title: "Design Language", status: "17 component families · intent refs proposed", detail: "All 17 required component families are indexed across 28 proposals. Component action intents now resolve to shared Phase 2 action references. Capability authority, component interactions, state mappings, Shared token bindings, and accessibility, localization, keyboard, and responsive owner review remain open." },
    { id: "P2", title: "Product Experience", status: "41 views · action refs proposed · 28 journeys", detail: "All 41 baseline views have proposal contracts, and six selected-lane specializations are indexed. Authored action intents across baseline and lane views now resolve to intent-based proposal references. Detailed action effects, capability authority, component interactions, state transitions, copy/channel bindings, journey completeness, and owner review remain open." },
    { id: "P3", title: "Experience Explorer", status: "Local slices + 47 proposal routes · host pending", detail: "J-01 synthetic first-use, J-02 metadata-only artifact intake and verification-job commands, J-20 transcription-job status viewing, cancellation, and outcome checking, and the selected J-03 audio lane execute locally. All 47 screen contracts also expose source-derived Product routes with actions disabled. Stateful realization of remaining views, the generic Tools host, and independent review remain open." },
  ];
  const passed = [
    { label: "Reducer and lifecycle", detail: "Deterministic first-use, caption, project-request, artifact-transfer and verification states, and transcription-job finality.", count: "10 simulation checks", icon: "✓" },
    { label: "Fixture runner CLI", detail: "JSON, JSONL, upload status, help, fixture validation, and malformed input behavior.", count: "6 CLI checks", icon: "✓" },
    { label: "Canonical command CLI", detail: "Registered upload, transcription, caption, and job status, outcome-checking, and cancellation commands with stable identities, formats, and exit status.", count: "15 CLI checks", icon: "✓" },
    { label: "TypeScript and browser build", detail: `Strict TypeScript checks pass for the simulation package and browser client; all ${specificationArtifacts.length} specification records are bundled.`, count: "PASS · Vite 7.3.1", icon: "✓" },
  ];
  const pending = [
    { label: "Tools phase verification", detail: "An explicit repo-root:pnpm binding resolves the shared-root materials and the canonical planner selects readiness, rollup, and scan. Evidence Generator authority is unavailable, so these materials remain unverified.", status: "EVIDENCE AUTHORITY OPEN", tone: "caution" },
    { label: "Browser host binding", detail: "This browser client renders Media-specific projections. Published Tools host integration remains open.", status: "OPEN", tone: "neutral" },
    { label: "All baseline views and journeys", detail: "All 41 baseline view proposals and six selected-lane specializations have source-derived Product routes; proposal actions remain disabled. Full action semantics, state/scenario/channel bindings, journey behavior, owner review, and acceptance remain open.", status: "OPEN", tone: "neutral" },
    { label: "Visual and accessibility review", detail: "Local screenshots have been inspected; full accessibility evidence and independent human review are not recorded.", status: "REVIEW REQUIRED", tone: "caution" },
  ];
  return `<div class="verify-workspace" id="main-content"><header class="verify-header"><div><div class="eyebrow">EVIDENCE & COVERAGE</div><h1>Verify experience</h1><p>Separate model checks from phase acceptance and browser review.</p></div><button type="button" class="button button-outline" data-mode="specification">Review source records</button></header>
    <div class="verify-summary"><div class="verify-summary-icon">✓</div><div><strong>Local simulation checks pass</strong><span>These checks cover J-01 synthetic first-use, J-02 metadata-only artifact intake and verification-job CLI, J-20 transcription-job recovery, and the selected J-03 audio transcript and caption workflow. They do not accept Phases 0–3.</span></div><button type="button" class="text-button" data-run-local-checks aria-expanded="${showVerificationCommands}">${showVerificationCommands ? "Hide verification commands" : "Show verification commands"} <span aria-hidden="true">→</span></button></div>
    <section class="verify-section phase-status-section"><div class="verify-section-heading"><div><h2>Phase status</h2><p>Local work, owner review, and acceptance are separate states.</p></div><span class="section-count">4 phases</span></div><div class="phase-status-grid">${phaseStates.map((phase) => `<article class="phase-status-card"><div class="phase-status-heading"><span>${phase.id}</span><strong>${escapeHtml(phase.status)}</strong></div><h3>${escapeHtml(phase.title)}</h3><p>${escapeHtml(phase.detail)}</p></article>`).join("")}</div></section>
    ${showVerificationCommands ? `<pre class="verify-local-commands"><code>pnpm dlx --package typescript@6.0.3 tsc --noEmit -p apps/media-experience-explorer/tsconfig.json
pnpm dlx --package typescript@6.0.3 tsc --noEmit -p libs/media-experience-simulation/tsconfig.json
node libs/media-experience-simulation/bin/ghatana-media.mjs --help
node --test libs/media-experience-simulation/tests/*.test.mjs
pnpm dlx vite@7.3.1 build --config apps/media-experience-explorer/vite.config.mjs</code></pre>` : ""}
    <section class="verify-section"><div class="verify-section-heading"><div><h2>Verified local behavior</h2><p>Evidence recorded for the deterministic simulation package.</p></div><span class="section-count">${passed.length} checks</span></div><div class="check-grid">${passed.map((check) => `<article class="check-card"><span class="check-icon">${check.icon}</span><div><h3>${check.label}</h3><p>${check.detail}</p><small>${check.count}</small></div><span class="check-state">PASS</span></article>`).join("")}</div></section>
    <section class="verify-section"><div class="verify-section-heading"><div><h2>Open phase evidence</h2><p>Structural catalog checks do not prove semantic completeness or acceptance.</p></div><span class="section-count">${pending.length} open</span></div><div class="pending-list">${pending.map((item) => `<article class="pending-card"><span class="pending-status ${item.tone}">${escapeHtml(item.status)}</span><div><h3>${item.label}</h3><p>${item.detail}</p></div></article>`).join("")}</div></section>
    <div class="verify-command"><div><span class="terminal-small-icon">›_</span><span><strong>Verify phase evidence with ghatana-tools</strong><small>Run from the Tools repository, pass both repository roots, and bind the shared-root build unit explicitly.</small></span></div><code>node tools/product-development/cli/dist/bin/product-dev.js workspace verify --root &lt;media-root&gt; --root &lt;tools-root&gt; --subject samujjwal/ghatana-media:media --material &lt;path&gt; --stage &lt;stage&gt; --claim &lt;classification&gt; --build-unit repo-root:pnpm</code></div>
  </div>`;
}

function mainContent(): string {
  switch (mode) {
    case "product": {
      if (location.hash.startsWith("#product/view/") && !selectedProductContract) {
        return `<div class="product-app product-contract-app"><header class="product-topbar"><a class="product-brand" href="#product" data-product-home><span class="product-mark" aria-hidden="true">M</span><span>Media</span></a></header><main class="product-contract-main" id="main-content" tabindex="-1"><a class="product-back-link" href="#product" data-product-home>← Media workspace</a><section class="product-contract-empty"><h1>View proposal not found</h1><p>This Product route does not match a registered screen contract.</p><a class="button button-outline" href="#product" data-product-home>Return to Media</a></section></main></div>`;
      }
      if (!selectedProductContract) {
        return productSurface();
      }
      ensureSpecificationContentLoaded(selectedProductContract);
      if (actionRegistryArtifact) ensureSpecificationContentLoaded(actionRegistryArtifact);
      const source = specificationContents.get(selectedProductContract.path);
      const actionRegistrySource = actionRegistryArtifact ? specificationContents.get(actionRegistryArtifact.path) : "";
      const failure = specificationErrors.get(selectedProductContract.path);
      const actionRegistryPending = actionRegistryArtifact && actionRegistrySource === undefined && !specificationErrors.has(actionRegistryArtifact.path);
      const content = source === undefined || actionRegistryPending
        ? `<main class="product-contract-main" id="main-content" tabindex="-1"><p class="product-proposal-empty">${escapeHtml(failure ?? "Loading view proposal…")}</p></main>`
        : renderProductContractProjection(selectedProductContract, source, actionRegistrySource ?? "");
      return `<div class="product-app product-contract-app ${highContrast ? "contrast-on" : ""} ${reducedMotion ? "motion-reduced" : ""}"><header class="product-topbar"><a class="product-brand" href="#product" data-product-home><span class="product-mark" aria-hidden="true">M</span><span>Media</span><span class="brand-divider"></span><span class="product-breadcrumb">${escapeHtml(selectedProductContract.title)}</span></a><span class="product-contract-topbar-note">Synthetic proposal</span></header>${content}</div>`;
    }
    case "explore": return exploreSurface();
    case "specification": return specificationSurface();
    case "verify": return verificationSurface();
  }
}

function render(): void {
  const focusedElement = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  const focusAddress = focusAddressFor(focusedElement);
  const content = mode === "product"
    ? mainContent()
    : `${explorerHeader()}<div id="explorer-panel" role="tabpanel" aria-labelledby="mode-${mode}" tabindex="0">${mainContent()}</div>`;
  root!.innerHTML = `${content}<div class="global-announcer" role="status" aria-live="polite">${escapeHtml(transientAnnouncement)}</div>`;
  restoreFocus(focusAddress);
  root!.dataset.mode = mode;
  document.title = mode === "product"
    ? selectedProductContract ? `Media · ${selectedProductContract.title}`
      : location.hash.startsWith("#product/view/") ? "Media · View proposal not found"
        : `Media · ${activeProductViewTitle()}`
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
  if (restoreTabFocus) root!.querySelector<HTMLButtonElement>(`#mode-${nextMode}`)?.focus();
  else if (nextMode === "product") root!.querySelector<HTMLElement>("#main-content")?.focus();
}

window.addEventListener("popstate", () => {
  mode = modeFromLocation() ?? "explore";
  selectedProductContract = productContractFromLocation() ?? null;
  if (selectedProductContract) {
    selectedPhase = selectedProductContract.phase;
    selectedArtifact = selectedProductContract;
  }
  transientAnnouncement = "";
  render();
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
    history.pushState({ explorerMode: "product", productContractPath: artifact.path }, "", `#product/view/${encodeURIComponent(artifact.path)}`);
    mode = "product";
    transientAnnouncement = "";
    render();
    root!.querySelector<HTMLElement>("#main-content")?.focus();
    return;
  }
  const modeButton = target.closest<HTMLButtonElement>("button[data-mode]");
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
  const phaseButton = target.closest<HTMLButtonElement>("button[role=radio][data-phase]");
  if (phaseButton) {
    const phase = phaseButton.dataset.phase as ExperiencePhase;
    selectedPhase = phase;
    selectedArtifact = specificationArtifacts.find((artifact) => artifact.phase === phase)!;
    render();
    root!.querySelector<HTMLButtonElement>(`#${phaseTabId(phase)}`)?.focus();
    return;
  }
  const artifactButton = target.closest<HTMLElement>("[data-artifact]");
  if (artifactButton) { selectedArtifact = specificationArtifacts.find((artifact) => artifact.path === artifactButton.dataset.artifact)!; render(); return; }
  if (target.closest("[data-reset]")) { state = createFixtureState("media.scenario.transcript-ready"); lastResult = null; cliHistory = []; versionPurpose = ""; productView = "transcript"; transientAnnouncement = "Scenario reset to transcript ready."; render(); return; }
  if (target.closest("[data-toggle-details]")) { detailsVisible = !detailsVisible; transientAnnouncement = detailsVisible ? "Source and job information shown." : "Source and job information hidden."; render(); return; }
  if (target.closest("[data-cli-help]")) { runCommand("help"); return; }
  if (target.closest("[data-clear-cli]")) { cliHistory = []; render(); return; }
  if (target.closest("[data-run-local-checks]")) { showVerificationCommands = !showVerificationCommands; render(); }
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
