import {
  ProductionSpecSchema,
  type ProductionSpec,
} from "@audio-video/types/production";

/**
 * SK-06: typed local dry-run / plan-compile for declarative production.
 *
 * Compiles a PDP-1 production spec into a deterministic ordered plan over
 * existing immutable source revisions. This module performs no dispatch: a
 * compiled plan is a value — the plan fingerprint is stable for identical
 * inputs, so "no effect on the same inputs" is checkable by callers.
 *
 * Source resolution is a trusted seam: every scene/output reference must
 * resolve to an existing immutable revision; a protected or unresolved
 * capture source rejects the compile. Browser/user actions are never
 * dispatched — headless capture steps are plan markers only.
 */

/** How a capture source resolves through the trusted revision seam. */
export type CaptureSourceEligibility =
  /** Existing immutable revision usable for headless capture planning. */
  | "LOCAL_ADMITTED"
  /** Requires external admission (device rights, live capture consent). */
  | "PROTECTED"
  /** No existing revision — the plan cannot reference it. */
  | "UNRESOLVED";

export interface ResolvedSource {
  readonly sourceRef: string;
  readonly immutableRevision: string;
  readonly eligibility: CaptureSourceEligibility;
}

/** Trusted resolver; caller-provided revision strings are never an input. */
export interface CaptureSourceResolver {
  resolve(sourceRef: string): ResolvedSource | null;
}

export type ProductionStepKind =
  | "validate-spec"
  | "capture-source"
  | "compose-timeline"
  | "render-outputs";

export interface ProductionPlanStep {
  readonly stepId: string;
  readonly kind: ProductionStepKind;
  readonly dependsOn: readonly string[];
  readonly versionRefs: readonly string[];
  /** Only ever "plan" — a compiled step is a value, not an effect. */
  readonly effect: "none";
}

export interface CompiledProductionPlan {
  readonly schemaVersion: "media.production-plan.v1";
  readonly projectRevision: string;
  readonly originClass: ProductionSpec["originClass"];
  readonly steps: readonly ProductionPlanStep[];
  readonly resolvedSources: readonly ResolvedSource[];
  /** SHA-256 over the canonical plan projection — stable for identical inputs. */
  readonly planFingerprint: string;
  /** Always true for this compiler: compiling a plan never dispatches work. */
  readonly dryRunOnly: true;
}

/** Thrown when a source is protected or unresolved — compile fails closed. */
export class ProductionPlanError extends Error {
  public constructor(
    public readonly code:
      | "INVALID_PRODUCTION_SPEC"
      | "CAPTURE_SOURCE_PROTECTED"
      | "CAPTURE_SOURCE_UNRESOLVED"
      | "REVISION_MISMATCH",
    message: string,
  ) {
    super(message);
    this.name = "ProductionPlanError";
  }
}

function canonicalJson(value: unknown): string {
  const visit = (item: unknown): unknown => {
    if (Array.isArray(item)) return item.map(visit);
    if (item && typeof item === "object") {
      return Object.fromEntries(Object.entries(item as Record<string, unknown>)
        .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
        .map(([key, nested]) => [key, visit(nested)]));
    }
    return item;
  };
  return JSON.stringify(visit(value));
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Compiles a production spec into a deterministic, effect-free plan.
 *
 * Determinism contract: identical spec + resolver outputs yield an identical
 * plan and fingerprint. A PROTECTED capture source rejects with
 * CAPTURE_SOURCE_PROTECTED; an unresolved ref with
 * CAPTURE_SOURCE_UNRESOLVED. The plan binds exactly one canonical project
 * revision — the spec's own revisionId.
 */
export async function compileProductionPlan(
  specInput: unknown,
  resolver: CaptureSourceResolver,
): Promise<CompiledProductionPlan> {
  const parsed = ProductionSpecSchema.safeParse(specInput);
  if (!parsed.success) {
    throw new ProductionPlanError(
      "INVALID_PRODUCTION_SPEC",
      `production spec does not match media.declarative.value.production-spec.v1: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    );
  }
  const spec = parsed.data;

  // Every referenced source must resolve to an existing immutable revision.
  const sourceRefs = [...spec.sceneRefs, spec.timelineRef, spec.rightsRef,
    ...spec.outputProfileRefs, spec.purposeRef];
  const resolved: ResolvedSource[] = [];
  for (const ref of sourceRefs) {
    const source = resolver.resolve(ref);
    if (source === null || source.eligibility === "UNRESOLVED") {
      throw new ProductionPlanError(
        "CAPTURE_SOURCE_UNRESOLVED",
        `source ref has no existing immutable revision: ${ref}`);
    }
    if (source.eligibility === "PROTECTED") {
      throw new ProductionPlanError(
        "CAPTURE_SOURCE_PROTECTED",
        `capture source requires external admission and cannot enter a headless plan: ${ref}`);
    }
    resolved.push(source);
  }

  // Deterministic ordered plan: validate → capture per scene → compose → render.
  const steps: ProductionPlanStep[] = [
    {
      stepId: "validate-spec",
      kind: "validate-spec",
      dependsOn: [],
      versionRefs: [spec.revisionId],
      effect: "none",
    },
    ...spec.sceneRefs.map((sceneRef, index) => ({
      stepId: `capture-source-${index}`,
      kind: "capture-source" as const,
      dependsOn: ["validate-spec"],
      versionRefs: [sceneRef],
      effect: "none" as const,
    })),
    {
      stepId: "compose-timeline",
      kind: "compose-timeline",
      dependsOn: spec.sceneRefs.map((_, index) => `capture-source-${index}`),
      versionRefs: [spec.timelineRef],
      effect: "none",
    },
    {
      stepId: "render-outputs",
      kind: "render-outputs",
      dependsOn: ["compose-timeline"],
      versionRefs: [...spec.outputProfileRefs],
      effect: "none",
    },
  ];

  const projection = {
    schemaVersion: "media.production-plan.v1" as const,
    projectRevision: spec.revisionId,
    originClass: spec.originClass,
    purposeRef: spec.purposeRef,
    rightsRef: spec.rightsRef,
    steps,
    resolvedSources: resolved.map((s) => ({
      sourceRef: s.sourceRef,
      immutableRevision: s.immutableRevision,
      eligibility: s.eligibility,
    })),
  };
  return {
    schemaVersion: "media.production-plan.v1",
    projectRevision: spec.revisionId,
    originClass: spec.originClass,
    steps,
    resolvedSources: resolved,
    planFingerprint: `sha256:${await sha256Hex(canonicalJson(projection))}`,
    dryRunOnly: true,
  };
}
