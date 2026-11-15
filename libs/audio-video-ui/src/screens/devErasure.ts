/**
 * DEV_ONLY erasure and legal hold: strict parsing of the host responses and the pure helpers the erasure panel uses.
 *
 * Every view carries identifiers, kinds, counts and SHA-256 digests only. The parsers refuse a response that is not
 * DEV_ONLY, whose counts disagree with its items, or whose receipt claims content was disclosed.
 */

export interface DevErasureHostResponse { readonly status: number; readonly body: unknown }

export interface DevErasureRequest {
  readonly erasureId: string;
  readonly artifactId: string;
  readonly confirm: true;
  readonly expectedArtifactCount: number;
}

export interface DevErasureHoldRequest { readonly requestId: string; readonly artifactId: string; readonly reason: string }

export interface DevErasurePort {
  plan(artifactId: string): Promise<DevErasureHostResponse>;
  erase(request: DevErasureRequest): Promise<DevErasureHostResponse>;
  receipt(erasureId: string): Promise<DevErasureHostResponse>;
  placeHold(request: DevErasureHoldRequest): Promise<DevErasureHostResponse>;
  releaseHold(holdId: string, reason: string): Promise<DevErasureHostResponse>;
}

/** Typed host failure. `status` 0 means no response was observed (the outcome of a mutation is then unknown). */
export class DevErasureHostError extends Error {
  constructor(readonly code: string, readonly status: number, message: string, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "DevErasureHostError";
  }
}

export interface ErasureTreeNodeView {
  readonly artifactId: string;
  readonly kind: string;
  readonly contentType: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly derivedFrom: readonly string[];
}

export interface LegalHoldView {
  readonly holdId: string;
  readonly rootArtifactId: string;
  readonly state: "ACTIVE" | "RELEASED";
  readonly reason: string;
  readonly placedBy: string;
  readonly placedIdentityAssurance: string;
  readonly placedAt: string;
  readonly releasedBy: string | null;
  readonly releaseReason: string | null;
  readonly releasedAt: string | null;
  readonly replayed: boolean;
}

export interface ErasurePlanView {
  readonly rootArtifactId: string;
  readonly artifacts: readonly ErasureTreeNodeView[];
  readonly dependentRecords: Readonly<Record<string, number>>;
  readonly blockingHolds: readonly LegalHoldView[];
  readonly erasable: boolean;
}

export interface ErasureReceiptItemView { readonly kind: string; readonly count: number; readonly digests: readonly string[] }

export interface ErasureReceiptView {
  readonly erasureId: string;
  readonly rootArtifactId: string;
  readonly phase: "DB_ERASED" | "OBJECTS_ERASED" | "COMPLETED";
  readonly complete: boolean;
  readonly requestedBy: string;
  readonly requestedAt: string;
  readonly completedAt: string | null;
  readonly items: readonly ErasureReceiptItemView[];
  readonly totalRemoved: number;
}

const bad = (message: string): never => { throw new DevErasureHostError("INVALID_RESPONSE", 200, message); };
const record = (value: unknown, what: string): Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : bad(`${what} is not an object.`);
const text = (value: unknown, what: string, max = 2048): string =>
  typeof value === "string" && value.length <= max ? value : bad(`${what} is not a bounded string.`);
const optionalText = (value: unknown, what: string): string | null => value === null || value === undefined ? null : text(value, what);
const count = (value: unknown, what: string): number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : bad(`${what} is not a non-negative integer.`);
const list = (value: unknown, what: string, max = 2000): readonly unknown[] =>
  Array.isArray(value) && value.length <= max ? value : bad(`${what} is not a bounded array.`);
const digest = (value: unknown, what: string): string =>
  typeof value === "string" && /^[0-9a-f]{64}$/u.test(value) ? value : bad(`${what} is not a SHA-256 digest.`);

export function parseLegalHoldView(body: unknown): LegalHoldView {
  const root = record(body, "hold");
  if (root.scope !== "DEV_ONLY") bad("hold is not DEV_ONLY.");
  const state = text(root.state, "hold state", 16);
  if (state !== "ACTIVE" && state !== "RELEASED") bad("hold state is not recognised.");
  const hold: LegalHoldView = {
    holdId: text(root.holdId, "hold id", 128), rootArtifactId: text(root.rootArtifactId, "hold root", 255), state: state as "ACTIVE" | "RELEASED",
    reason: text(root.reason, "hold reason", 1000), placedBy: text(root.placedBy, "placing principal", 255),
    placedIdentityAssurance: text(root.placedIdentityAssurance, "placing assurance", 32), placedAt: text(root.placedAt, "placed at", 64),
    releasedBy: optionalText(root.releasedBy, "releasing principal"), releaseReason: optionalText(root.releaseReason, "release reason"),
    releasedAt: optionalText(root.releasedAt, "released at"), replayed: root.replayed === true,
  };
  if ((hold.state === "RELEASED") !== (hold.releasedBy !== null && hold.releaseReason !== null && hold.releasedAt !== null)) {
    bad("a released hold must name who released it, why and when.");
  }
  return hold;
}

export function parseErasurePlanView(body: unknown, expected: { readonly rootArtifactId?: string } = {}): ErasurePlanView {
  const root = record(body, "plan");
  if (root.scope !== "DEV_ONLY") bad("plan is not DEV_ONLY.");
  const rootArtifactId = text(root.rootArtifactId, "root artifact", 255);
  if (expected.rootArtifactId !== undefined && expected.rootArtifactId !== rootArtifactId) bad("the plan is for another artifact.");
  const artifacts = list(root.artifacts, "artifacts").map((raw): ErasureTreeNodeView => {
    const node = record(raw, "tree node");
    return {
      artifactId: text(node.artifactId, "artifact id", 255), kind: text(node.kind, "kind", 64), contentType: text(node.contentType, "content type", 255),
      sha256: digest(node.sha256, "artifact digest"), sizeBytes: count(node.sizeBytes, "size"),
      derivedFrom: list(node.derivedFrom, "derivedFrom").map((id) => text(id, "parent id", 255)),
    };
  });
  if (!artifacts.some((node) => node.artifactId === rootArtifactId)) bad("the plan does not contain its own root.");
  if (count(root.artifactCount, "artifact count") !== artifacts.length) bad("the artifact count disagrees with the tree.");
  const dependentRecords: Record<string, number> = {};
  for (const [kind, value] of Object.entries(record(root.dependentRecords, "dependent records"))) dependentRecords[text(kind, "record kind", 64)] = count(value, "record count");
  const blockingHolds = list(root.blockingHolds, "blocking holds", 100).map(parseLegalHoldView);
  const erasable = root.erasable === true;
  if (erasable !== (blockingHolds.length === 0)) bad("erasable disagrees with the blocking holds.");
  return { rootArtifactId, artifacts, dependentRecords, blockingHolds, erasable };
}

export function parseErasureReceiptView(body: unknown, expected: { readonly erasureId?: string } = {}): ErasureReceiptView {
  const root = record(body, "receipt");
  if (root.scope !== "DEV_ONLY") bad("receipt is not DEV_ONLY.");
  if (root.contentDisclosed !== "none") bad("a receipt must state that no content was disclosed.");
  const erasureId = text(root.erasureId, "erasure id", 128);
  if (expected.erasureId !== undefined && expected.erasureId !== erasureId) bad("the receipt is for another erasure.");
  const phase = text(root.phase, "phase", 16);
  if (phase !== "DB_ERASED" && phase !== "OBJECTS_ERASED" && phase !== "COMPLETED") bad("phase is not recognised.");
  const items = list(root.items, "items", 200).map((raw): ErasureReceiptItemView => {
    const item = record(raw, "receipt item");
    return { kind: text(item.kind, "kind", 64), count: count(item.count, "count"), digests: list(item.digests, "digests").map((d) => digest(d, "removed object digest")) };
  });
  const totalRemoved = count(root.totalRemoved, "total removed");
  if (items.reduce((sum, item) => sum + item.count, 0) !== totalRemoved) bad("the total disagrees with the items.");
  return {
    erasureId, rootArtifactId: text(root.rootArtifactId, "root artifact", 255), phase: phase as ErasureReceiptView["phase"],
    complete: root.complete === true && phase === "COMPLETED", requestedBy: text(root.requestedBy, "requesting principal", 255),
    requestedAt: text(root.requestedAt, "requested at", 64), completedAt: optionalText(root.completedAt, "completed at"), items, totalRemoved,
  };
}

/** Tree rows with an indentation depth (the shortest derivation path from the root), in a stable depth-first order. */
export function treeRows(plan: ErasurePlanView): readonly { readonly node: ErasureTreeNodeView; readonly depth: number }[] {
  const byParent = new Map<string, ErasureTreeNodeView[]>();
  for (const node of plan.artifacts) for (const parent of node.derivedFrom) byParent.set(parent, [...(byParent.get(parent) ?? []), node]);
  const rows: { node: ErasureTreeNodeView; depth: number }[] = [];
  const seen = new Set<string>();
  const visit = (node: ErasureTreeNodeView, depth: number): void => {
    if (seen.has(node.artifactId)) return;
    seen.add(node.artifactId);
    rows.push({ node, depth });
    for (const child of byParent.get(node.artifactId) ?? []) visit(child, depth + 1);
  };
  const root = plan.artifacts.find((node) => node.artifactId === plan.rootArtifactId);
  if (root) visit(root, 0);
  for (const node of plan.artifacts) visit(node, 1);
  return rows;
}

export interface DevErasureFailure { readonly tone: "unknown" | "denied" | "held" | "gone" | "refused"; readonly code: string; readonly text: string }

/** Plain-language outcome of a typed host failure. A mutation with no observed response is OUTCOME_UNKNOWN. */
export function describeErasureFailure(error: DevErasureHostError): DevErasureFailure {
  const { code, status } = error;
  if (status === 0 || code === "OUTCOME_UNKNOWN") {
    return { tone: "unknown", code, text: "The outcome is unknown. Nothing is shown as erased; retrying uses the same erasure identity and resumes safely." };
  }
  if (code === "LEGAL_HOLD_ACTIVE") {
    return { tone: "held", code, text: "A legal hold covers part of this tree, so nothing was erased. Release the hold first." };
  }
  if (code === "IDENTITY_ASSURANCE_REQUIRED") {
    return { tone: "denied", code, text: "This profile requires an identity-provider verified principal for holds and erasure. Nothing was changed." };
  }
  if (code === "ARTIFACT_ERASED") {
    return { tone: "gone", code, text: "This artifact was already erased. Its content is no longer available and cannot be restored." };
  }
  if (code === "ARTIFACT_NOT_FOUND" || code === "HOLD_NOT_FOUND" || code === "ERASURE_NOT_FOUND" || status === 404) {
    return { tone: "denied", code, text: "Not found in your tenant and owner scope. Only the owner can see, hold or erase this artifact." };
  }
  if (code === "ERASURE_TREE_CHANGED") {
    return { tone: "refused", code, text: "The tree changed after you reviewed it. Nothing was erased; review the new tree before confirming." };
  }
  if (status === 403) return { tone: "denied", code, text: "You do not have permission for this action. Nothing was changed." };
  return { tone: "refused", code, text: error.message || "The request was refused. Nothing was changed." };
}
