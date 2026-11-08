
export type DemoSourceTruth =
  | { readonly kind: "simulation" }
  | { readonly kind: "curated"; readonly curationRef: string }
  | {
      readonly kind: "live";
      /** Exact observed output identity and immutable source version. */
      readonly outputRef?: string;
      readonly outputVersion?: string;
      /** Owner-readback evidence reference is required before saying "Live output". */
      readonly readbackEvidenceRef?: string;
    };

export type DemoOriginCapability = "read-asset" | "read-caption";

export interface DemoOriginPermission {
  readonly origin: string;
  readonly capabilities: readonly DemoOriginCapability[];
}

export interface DemoCue {
  readonly id: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly text: string;
}

export interface DemoScene {
  readonly id: string;
  readonly label: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly asset: {
    readonly url: string;
    readonly version: string;
    /** Asset must be authored against the bundle's exact source revision. */
    readonly sourceRevision: string;
  };
  readonly captions: {
    readonly language: string;
    /** Captions are valid only for this immutable asset version. */
    readonly assetVersion: string;
    /** Optional source locator for captions; it never triggers a fetch by itself. */
    readonly sourceUrl?: string;
    readonly cues: readonly DemoCue[];
  };
  readonly branches: readonly {
    readonly id: string;
    readonly label: string;
    readonly targetSceneId: string;
  }[];
}

export interface InteractiveDemoManifest {
  readonly id: string;
  readonly revision: string;
  readonly sourceRevision: string;
  /** Expected embedding origin; no ambient or wildcard origin is accepted. */
  readonly hostOrigin: string;
  /** Produced by the owning bundle verifier; this UI does not verify signatures itself. */
  readonly integrity:
    | { readonly status: "verified"; readonly sha256: string; readonly verificationRef: string }
    | { readonly status: "unverified" };
  readonly sourceTruth: DemoSourceTruth;
  readonly originPermissions: readonly DemoOriginPermission[];
  readonly initialSceneId: string;
  readonly scenes: readonly DemoScene[];
}

/**
 * Read-only host assertion produced after the trusted host has verified the
 * exact bundle bytes, source evidence, permissions, and its actual origin.
 */
export interface DemoHostAttestation {
  readonly manifestId: string;
  readonly revision: string;
  readonly sha256: string;
  readonly actualEmbeddingOrigin: string;
  readonly sourceTruth: DemoSourceTruth;
  readonly originPermissions: readonly DemoOriginPermission[];
}

/**
 * Injected synchronous snapshot port. Implementations must be read-only and
 * side-effect-free, return actual host context, and return undefined unless
 * their trusted verification has completed.
 */
export interface DemoHostVerificationPort {
  attest(manifest: InteractiveDemoManifest): DemoHostAttestation | undefined;
}

export type DemoPlayerStatus = "READY" | "POLICY_DENIED" | "UNAVAILABLE" | "FINISHED";

export type DemoPlayerFailure =
  | "HOST_ORIGIN_MISMATCH"
  | "INVALID_ORIGIN"
  | "UNAUTHORIZED_ASSET_ORIGIN"
  | "UNAUTHORIZED_CAPTION_ORIGIN"
  | "BUNDLE_INTEGRITY_UNVERIFIED"
  | "LIVE_OUTPUT_EVIDENCE_MISSING"
  | "CURATED_EVIDENCE_MISSING"
  | "STALE_ASSET_REVISION"
  | "STALE_CAPTION_ASSET_VERSION"
  | "INVALID_BUNDLE"
  | "PLAYBACK_LIMIT_REACHED"
  | "TRUST_VERIFIER_UNAVAILABLE"
  | "TRUST_ATTESTATION_MISMATCH"
  | "MEDIA_PLAYBACK_FAILED";

export interface DemoBranchVisit {
  readonly fromSceneId: string;
  readonly choiceId: string;
  readonly toSceneId: string;
}

export interface DemoPlayerState {
  readonly status: DemoPlayerStatus;
  readonly failure?: DemoPlayerFailure;
  readonly activeSceneId: string;
  readonly positionMs: number;
  readonly playing: boolean;
  /** Route contains only scenes reached by explicit authored choices. */
  readonly route: readonly string[];
  readonly branches: readonly DemoBranchVisit[];
  /** Reducer input history makes replay deterministic and inspectable. */
  readonly history: readonly DemoPlayerAction[];
  readonly announcement: string;
  /** Source classification is exposed only after the host attestation matches. */
  readonly sourceTruth?: DemoSourceTruth;
  /** Binds reducer state to the exact verified bundle and host-context snapshot. */
  readonly trustBinding?: string;
}

export type DemoPlayerAction =
  | { readonly type: "play" }
  | { readonly type: "pause" }
  | { readonly type: "progress"; readonly positionMs: number }
  | { readonly type: "ended" }
  | { readonly type: "playback-failed" }
  | { readonly type: "seek"; readonly positionMs: number }
  | { readonly type: "choose-branch"; readonly branchId: string }
  | { readonly type: "finish" };

/** Select captions using deterministic half-open cue intervals [start, end). */
export function demoCaptionAt(scene: DemoScene, positionMs: number): string {
  if (!Number.isSafeInteger(positionMs) || positionMs < 0) return "";
  return scene.captions.cues
    .filter((cue) => positionMs >= cue.startMs && positionMs < cue.endMs)
    .map((cue) => cue.text)
    .join(" ");
}

const EMPTY_STATE: DemoPlayerState = {
  status: "UNAVAILABLE",
  activeSceneId: "",
  positionMs: 0,
  playing: false,
  route: [],
  branches: [],
  history: [],
  announcement: "Interactive demonstration unavailable.",
};

const MAX_RECORDED_ACTIONS = 10_000;
const MAX_BRANCH_VISITS = 256;

function exactOrigin(value: string): string | undefined {
  try {
    const parsed = new URL(value);
    if (
      (parsed.protocol !== "https:" && parsed.protocol !== "http:") || parsed.origin === "null" ||
      parsed.username.length > 0 || parsed.password.length > 0
    ) {
      return undefined;
    }
    return parsed.origin;
  } catch {
    return undefined;
  }
}

function hasPermission(
  manifest: InteractiveDemoManifest,
  origin: string,
  capability: DemoOriginCapability,
): boolean {
  if (origin === exactOrigin(manifest.hostOrigin)) return true;
  return manifest.originPermissions.some(
    (permission) => permission && typeof permission.origin === "string" &&
      exactOrigin(permission.origin) === origin && Array.isArray(permission.capabilities) &&
      permission.capabilities.includes(capability),
  );
}

function sourceTruthKey(sourceTruth: DemoSourceTruth): string {
  switch (sourceTruth.kind) {
    case "simulation":
      return "simulation";
    case "curated":
      return JSON.stringify(["curated", sourceTruth.curationRef]);
    case "live":
      return JSON.stringify(["live", sourceTruth.outputRef, sourceTruth.outputVersion, sourceTruth.readbackEvidenceRef]);
    default:
      return "invalid";
  }
}

function permissionKey(permissions: readonly DemoOriginPermission[]): string {
  return JSON.stringify(permissions
    .map((permission) => [permission.origin, [...permission.capabilities].sort()])
    .sort(([leftOrigin], [rightOrigin]) => String(leftOrigin).localeCompare(String(rightOrigin))));
}

function trustBinding(manifest: InteractiveDemoManifest, attestation: DemoHostAttestation): string {
  return JSON.stringify([
    manifest.id,
    manifest.revision,
    attestation.sha256.toLowerCase(),
    attestation.actualEmbeddingOrigin,
    sourceTruthKey(attestation.sourceTruth),
    permissionKey(attestation.originPermissions),
  ]);
}

function isValidPermissionList(value: unknown): value is readonly DemoOriginPermission[] {
  if (!Array.isArray(value)) return false;
  const seenOrigins = new Set<string>();
  for (const permission of value as readonly unknown[]) {
    if (!permission || typeof permission !== "object") return false;
    const candidate = permission as DemoOriginPermission;
    if (
      typeof candidate.origin !== "string" || exactOrigin(candidate.origin) !== candidate.origin ||
      seenOrigins.has(candidate.origin) || !Array.isArray(candidate.capabilities)
    ) return false;
    seenOrigins.add(candidate.origin);

    const seenCapabilities = new Set<unknown>();
    for (const capability of candidate.capabilities as readonly unknown[]) {
      if (
        (capability !== "read-asset" && capability !== "read-caption") ||
        seenCapabilities.has(capability)
      ) return false;
      seenCapabilities.add(capability);
    }
  }
  return true;
}

function isExactEvidenceRef(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value === value.trim();
}

function validLiveEvidence(sourceTruth: DemoSourceTruth): boolean {
  return sourceTruth.kind !== "live" ||
    (isExactEvidenceRef(sourceTruth.outputRef) &&
      isExactEvidenceRef(sourceTruth.outputVersion) &&
      isExactEvidenceRef(sourceTruth.readbackEvidenceRef));
}

function validCurationEvidence(sourceTruth: DemoSourceTruth): boolean {
  return sourceTruth.kind !== "curated" ||
    isExactEvidenceRef(sourceTruth.curationRef);
}

export function demoSourceTruthLabel(sourceTruth: DemoSourceTruth): string {
  switch (sourceTruth.kind) {
    case "simulation":
      return "Simulated demonstration";
    case "curated":
      return validCurationEvidence(sourceTruth) ? "Curated demonstration" : "Curated demonstration unverified";
    case "live":
      return validLiveEvidence(sourceTruth) ? "Live output" : "Live output unverified";
    default:
      return "Unverified demonstration";
  }
}

function validateManifest(
  manifest: InteractiveDemoManifest,
  attestation: DemoHostAttestation,
): DemoPlayerFailure | undefined {
  if (
    !manifest || typeof manifest !== "object" ||
    typeof manifest.hostOrigin !== "string" || typeof manifest.id !== "string" ||
    typeof manifest.revision !== "string" || typeof manifest.sourceRevision !== "string" ||
    !Array.isArray(manifest.scenes) || !Array.isArray(manifest.originPermissions)
  ) return "INVALID_BUNDLE";
  if (manifest.scenes.some((scene) => !scene || typeof scene !== "object" || typeof scene.id !== "string")) {
    return "INVALID_BUNDLE";
  }
  if (!isValidPermissionList(manifest.originPermissions)) return "INVALID_BUNDLE";
  if (
    !attestation || typeof attestation !== "object" ||
    attestation.manifestId !== manifest.id || attestation.revision !== manifest.revision ||
    typeof attestation.sha256 !== "string" || typeof attestation.actualEmbeddingOrigin !== "string" ||
    !attestation.sourceTruth || typeof attestation.sourceTruth !== "object" ||
    !["simulation", "curated", "live"].includes(attestation.sourceTruth.kind) ||
    !isValidPermissionList(attestation.originPermissions)
  ) return "TRUST_ATTESTATION_MISMATCH";
  if (
    !manifest.integrity || manifest.integrity.status !== "verified"
  ) return "BUNDLE_INTEGRITY_UNVERIFIED";
  if (
    !manifest.sourceTruth || typeof manifest.sourceTruth !== "object" ||
    !["simulation", "curated", "live"].includes(manifest.sourceTruth.kind)
  ) return "INVALID_BUNDLE";
  if (
    typeof manifest.integrity.sha256 !== "string" || !/^([a-f0-9]{64})$/i.test(manifest.integrity.sha256) ||
    !isExactEvidenceRef(manifest.integrity.verificationRef) ||
    attestation.sha256.toLowerCase() !== manifest.integrity.sha256.toLowerCase()
  ) return "TRUST_ATTESTATION_MISMATCH";
  if (
    sourceTruthKey(manifest.sourceTruth) !== sourceTruthKey(attestation.sourceTruth) ||
    permissionKey(manifest.originPermissions) !== permissionKey(attestation.originPermissions)
  ) return "TRUST_ATTESTATION_MISMATCH";

  const actualOrigin = exactOrigin(attestation.actualEmbeddingOrigin);
  const hostOrigin = exactOrigin(manifest.hostOrigin);
  if (!actualOrigin || !hostOrigin) return "INVALID_ORIGIN";
  if (actualOrigin !== attestation.actualEmbeddingOrigin || hostOrigin !== manifest.hostOrigin) return "INVALID_ORIGIN";
  if (actualOrigin !== hostOrigin) return "HOST_ORIGIN_MISMATCH";
  if (!validLiveEvidence(manifest.sourceTruth)) return "LIVE_OUTPUT_EVIDENCE_MISSING";
  if (!validCurationEvidence(manifest.sourceTruth)) return "CURATED_EVIDENCE_MISSING";
  if (!manifest.id || !manifest.revision || !manifest.sourceRevision || manifest.scenes.length === 0) {
    return "INVALID_BUNDLE";
  }

  const sceneIds = new Set(manifest.scenes.map((scene) => scene.id));
  if (sceneIds.size !== manifest.scenes.length || !sceneIds.has(manifest.initialSceneId)) return "INVALID_BUNDLE";
  const scenesById = new Map(manifest.scenes.map((scene) => [scene.id, scene]));

  for (const scene of manifest.scenes) {
    if (
      !scene || typeof scene !== "object" || typeof scene.id !== "string" ||
      typeof scene.label !== "string" || !scene.asset || typeof scene.asset !== "object" ||
      typeof scene.asset.url !== "string" || typeof scene.asset.version !== "string" ||
      typeof scene.asset.sourceRevision !== "string" || !scene.captions ||
      typeof scene.captions !== "object" || typeof scene.captions.language !== "string" ||
      typeof scene.captions.assetVersion !== "string" || !Array.isArray(scene.captions.cues) ||
      !Array.isArray(scene.branches) ||
      !scene.id || !scene.label || !Number.isSafeInteger(scene.startMs) || !Number.isSafeInteger(scene.endMs) ||
      scene.startMs < 0 || scene.endMs <= scene.startMs || scene.asset.version.length === 0
    ) return "INVALID_BUNDLE";

    if (scene.asset.sourceRevision !== manifest.sourceRevision) return "STALE_ASSET_REVISION";
    if (scene.captions.assetVersion !== scene.asset.version) return "STALE_CAPTION_ASSET_VERSION";

    let assetOrigin: string | undefined;
    try {
      assetOrigin = exactOrigin(new URL(scene.asset.url, hostOrigin).href);
    } catch {
      return "INVALID_BUNDLE";
    }
    if (!assetOrigin || !hasPermission(manifest, assetOrigin, "read-asset")) {
      return "UNAUTHORIZED_ASSET_ORIGIN";
    }
    if (scene.captions.sourceUrl !== undefined) {
      if (typeof scene.captions.sourceUrl !== "string") return "INVALID_BUNDLE";
      let captionOrigin: string | undefined;
      try {
        captionOrigin = exactOrigin(new URL(scene.captions.sourceUrl, hostOrigin).href);
      } catch {
        return "INVALID_BUNDLE";
      }
      if (!captionOrigin || !hasPermission(manifest, captionOrigin, "read-caption")) {
        return "UNAUTHORIZED_CAPTION_ORIGIN";
      }
    }
    const cueIds = new Set<string>();
    for (const cue of scene.captions.cues) {
      if (
        !cue || typeof cue.id !== "string" || typeof cue.text !== "string" ||
        !cue.id || !cue.text || !Number.isSafeInteger(cue.startMs) || !Number.isSafeInteger(cue.endMs) ||
        cue.startMs < scene.startMs || cue.endMs > scene.endMs || cue.endMs <= cue.startMs ||
        cueIds.has(cue.id)
      ) return "INVALID_BUNDLE";
      cueIds.add(cue.id);
    }
    const branchIds = new Set<string>();
    for (const branch of scene.branches) {
      if (
        !branch || typeof branch.id !== "string" || typeof branch.label !== "string" ||
        typeof branch.targetSceneId !== "string" || !branch.id || !branch.label ||
        !sceneIds.has(branch.targetSceneId) || branchIds.has(branch.id)
      ) return "INVALID_BUNDLE";
      branchIds.add(branch.id);
    }
  }

  // A syntactically valid branch is not useful if no local choice from the
  // initial scene can ever reach it. Keep the authored keyboard graph rooted
  // at the entry scene so disconnected branches cannot be presented as usable.
  const reachableSceneIds = new Set<string>([manifest.initialSceneId]);
  const pendingSceneIds = [manifest.initialSceneId];
  while (pendingSceneIds.length > 0) {
    const sceneId = pendingSceneIds.pop()!;
    const scene = scenesById.get(sceneId)!;
    for (const branch of scene.branches) {
      if (!reachableSceneIds.has(branch.targetSceneId)) {
        reachableSceneIds.add(branch.targetSceneId);
        pendingSceneIds.push(branch.targetSceneId);
      }
    }
  }
  if (reachableSceneIds.size !== sceneIds.size) return "INVALID_BUNDLE";
  return undefined;
}

function failedState(failure: DemoPlayerFailure): DemoPlayerState {
  const policy = failure.startsWith("UNAUTHORIZED_") || failure === "HOST_ORIGIN_MISMATCH" || failure === "INVALID_ORIGIN";
  return {
    ...EMPTY_STATE,
    status: policy ? "POLICY_DENIED" : "UNAVAILABLE",
    failure,
    announcement: `Interactive demonstration ${policy ? "denied" : "unavailable"}: ${failure.replaceAll("_", " ").toLowerCase()}.`,
  };
}

function unavailableFrom(state: DemoPlayerState, failure: DemoPlayerFailure): DemoPlayerState {
  return {
    ...state,
    status: "UNAVAILABLE",
    failure,
    playing: false,
    announcement: `Interactive demonstration unavailable: ${failure.replaceAll("_", " ").toLowerCase()}.`,
  };
}

function requestAttestation(
  manifest: InteractiveDemoManifest,
  verificationPort?: DemoHostVerificationPort,
): DemoHostAttestation | DemoPlayerFailure {
  if (!verificationPort || typeof verificationPort.attest !== "function") return "TRUST_VERIFIER_UNAVAILABLE";
  try {
    const attestation = verificationPort.attest(manifest);
    if (!attestation) return "TRUST_VERIFIER_UNAVAILABLE";
    return validateManifest(manifest, attestation) ?? attestation;
  } catch {
    return "TRUST_VERIFIER_UNAVAILABLE";
  }
}

export function createDemoPlayerState(
  manifest: InteractiveDemoManifest,
  verificationPort?: DemoHostVerificationPort,
): DemoPlayerState {
  const verification = requestAttestation(manifest, verificationPort);
  if (typeof verification === "string") return failedState(verification);
  const scene = manifest.scenes.find((item) => item.id === manifest.initialSceneId)!;
  return {
    status: "READY",
    activeSceneId: scene.id,
    positionMs: scene.startMs,
    playing: false,
    route: [scene.id],
    branches: [],
    history: [],
    announcement: `${demoSourceTruthLabel(verification.sourceTruth)} ready. ${scene.label}.`,
    sourceTruth: verification.sourceTruth,
    trustBinding: trustBinding(manifest, verification),
  };
}

function appendHistory(state: DemoPlayerState, action: DemoPlayerAction, patch: Partial<DemoPlayerState>): DemoPlayerState {
  if (state.history.length >= MAX_RECORDED_ACTIONS) return unavailableFrom(state, "PLAYBACK_LIMIT_REACHED");
  return { ...state, ...patch, history: [...state.history, action] };
}

export function reduceDemoPlayerState(
  manifest: InteractiveDemoManifest,
  state: DemoPlayerState,
  action: DemoPlayerAction,
  verificationPort?: DemoHostVerificationPort,
): DemoPlayerState {
  if (state.status !== "READY") return state;
  if (!action || typeof action !== "object" ||
    !["play", "pause", "progress", "ended", "playback-failed", "seek", "choose-branch", "finish"].includes((action as { type?: string }).type ?? "")) {
    return state;
  }
  const verification = requestAttestation(manifest, verificationPort);
  if (typeof verification === "string") return failedState(verification);
  if (
    !state.sourceTruth || sourceTruthKey(state.sourceTruth) !== sourceTruthKey(verification.sourceTruth) ||
    state.trustBinding !== trustBinding(manifest, verification)
  ) {
    return failedState("TRUST_ATTESTATION_MISMATCH");
  }
  const activeIndex = state.route.lastIndexOf(state.activeSceneId);
  const scene = manifest.scenes.find((item) => item.id === state.activeSceneId);
  if (!scene || activeIndex < 0) return failedState("INVALID_BUNDLE");

  switch (action.type) {
    case "play":
      // Scene completion requires an explicit branch choice or replay. A
      // native media element at its authored end cannot meaningfully resume.
      if (state.positionMs >= scene.endMs) return state;
      return appendHistory(state, action, { playing: true, announcement: `Playing ${scene.label}.` });
    case "pause":
      return appendHistory(state, action, { playing: false, announcement: `Paused ${scene.label}.` });
    case "progress": {
      if (
        !state.playing || !Number.isSafeInteger(action.positionMs) ||
        action.positionMs < state.positionMs || action.positionMs < scene.startMs || action.positionMs > scene.endMs
      ) return state;
      const atEnd = action.positionMs === scene.endMs;
      return appendHistory(state, action, {
        positionMs: action.positionMs,
        playing: atEnd ? false : state.playing,
        announcement: atEnd ? `Finished ${scene.label}. Choose a path or replay.` : `Playing ${scene.label}.`,
      });
    }
    case "ended":
      if (!state.playing) return state;
      return appendHistory(state, action, {
        positionMs: scene.endMs,
        playing: false,
        announcement: `Finished ${scene.label}. Choose a path or replay.`,
      });
    case "playback-failed":
      return appendHistory(state, action, {
        status: "UNAVAILABLE",
        failure: "MEDIA_PLAYBACK_FAILED",
        playing: false,
        announcement: "Interactive demonstration unavailable: media playback failed.",
      });
    case "seek": {
      if (!Number.isSafeInteger(action.positionMs) || action.positionMs < 0) {
        return state;
      }
      const reachable = state.route
        .map((sceneId, index) => ({ scene: manifest.scenes.find((item) => item.id === sceneId), index }))
        .filter((entry): entry is { scene: DemoScene; index: number } => Boolean(entry.scene))
        .filter(({ scene: candidate }) => action.positionMs >= candidate.startMs && action.positionMs <= candidate.endMs);
      const target = reachable.at(-1);
      if (!target) {
        return state;
      }
      const route = state.route.slice(0, target.index + 1);
      const branches = state.branches.slice(0, Math.max(0, route.length - 1));
      return appendHistory(state, action, {
        activeSceneId: target.scene.id,
        positionMs: action.positionMs,
        route,
        branches,
        playing: false,
        announcement: `Seeked to ${target.scene.label}, ${Math.round(action.positionMs)} milliseconds.`,
      });
    }
    case "choose-branch": {
      const branch = scene.branches.find((item) => item.id === action.branchId);
      if (!branch) return state;
      if (state.route.length >= MAX_BRANCH_VISITS) return unavailableFrom(state, "PLAYBACK_LIMIT_REACHED");
      const route = [...state.route.slice(0, activeIndex + 1), branch.targetSceneId];
      const branches = [
        ...state.branches.slice(0, activeIndex),
        { fromSceneId: scene.id, choiceId: branch.id, toSceneId: branch.targetSceneId },
      ];
      const target = manifest.scenes.find((item) => item.id === branch.targetSceneId)!;
      return appendHistory(state, action, {
        activeSceneId: target.id,
        positionMs: target.startMs,
        route,
        branches,
        playing: false,
        announcement: `Showing ${target.label}.`,
      });
    }
    case "finish":
      return appendHistory(state, action, {
        status: "FINISHED",
        playing: false,
        announcement: "Demonstration finished.",
      });
    default:
      return state;
  }
}

export function replayDemoActions(
  manifest: InteractiveDemoManifest,
  verificationPort: DemoHostVerificationPort | undefined,
  actions: readonly DemoPlayerAction[],
): DemoPlayerState {
  const initial = createDemoPlayerState(manifest, verificationPort);
  // Replay input is an untrusted local action stream. Keep its work and the
  // state history under the same finite bound, and reject oversized streams
  // before replaying a prefix that could look like a successful partial run.
  if (initial.status !== "READY") return initial;
  if (!Array.isArray(actions)) return unavailableFrom(initial, "INVALID_BUNDLE");
  if (actions.length > MAX_RECORDED_ACTIONS) {
    return unavailableFrom(initial, "PLAYBACK_LIMIT_REACHED");
  }
  for (let index = 0; index < actions.length; index += 1) {
    if (!Object.hasOwn(actions, index)) return unavailableFrom(initial, "INVALID_BUNDLE");
  }
  return actions.reduce(
    (state, action) => reduceDemoPlayerState(manifest, state, action, verificationPort),
    initial,
  );
}

export function replayDemoBranchPath(
  manifest: InteractiveDemoManifest,
  verificationPort: DemoHostVerificationPort | undefined,
  branches: readonly DemoBranchVisit[],
): DemoPlayerState {
  const initial = createDemoPlayerState(manifest, verificationPort);
  if (initial.status !== "READY") return initial;
  if (!Array.isArray(branches)) return unavailableFrom(initial, "INVALID_BUNDLE");
  // The route bound includes its initial scene, so a replay can carry at most
  // MAX_BRANCH_VISITS - 1 branch choices. Check before mapping untrusted input.
  if (branches.length >= MAX_BRANCH_VISITS) {
    return unavailableFrom(initial, "PLAYBACK_LIMIT_REACHED");
  }
  let state = initial;
  for (let index = 0; index < branches.length; index += 1) {
    // The public replay helper can receive caller-owned data. Require each
    // visit to be a complete edge on the currently reached authored route;
    // reading only choiceId would silently accept forged or sparse paths.
    if (!(index in branches)) return unavailableFrom(initial, "INVALID_BUNDLE");
    const visit = branches[index] as DemoBranchVisit | undefined;
    if (
      !visit || typeof visit !== "object" ||
      typeof visit.fromSceneId !== "string" || typeof visit.choiceId !== "string" ||
      typeof visit.toSceneId !== "string"
    ) return unavailableFrom(initial, "INVALID_BUNDLE");
    const scene = manifest.scenes.find((item) => item.id === state.activeSceneId);
    const branch = scene?.branches.find((item) => item.id === visit.choiceId);
    if (
      !scene || visit.fromSceneId !== scene.id || !branch || branch.targetSceneId !== visit.toSceneId
    ) return unavailableFrom(initial, "INVALID_BUNDLE");
    state = reduceDemoPlayerState(manifest, state, { type: "choose-branch", branchId: visit.choiceId }, verificationPort);
    if (state.status !== "READY") return state;
  }
  return state;
}
