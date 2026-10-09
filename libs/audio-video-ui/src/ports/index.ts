import type React from "react";
import type {
  MediaTaskCurrentProjection,
  MediaTaskOperationObservation,
  MediaTaskStepId,
} from "../components/MediaTaskFlow";

/**
 * Read-only authoritative product projection supplied by a production or
 * review adapter. Business completion is observed here, never inferred from
 * an action dispatch result.
 */
export interface MediaDataPort {
  readonly currentProjection: MediaTaskCurrentProjection;
  readonly operationObservation?: MediaTaskOperationObservation;
  readonly actionReconciliations?: readonly MediaActionReconciliation[];
}

/** Capability supplied by the host; the presentation never decides eligibility. */
export type MediaActionDispatchResult =
  | { readonly status: "intent-accepted" }
  | { readonly status: "local-applied" }
  | { readonly status: "request-started"; readonly requestId: string }
  | { readonly status: "request-acknowledged"; readonly requestId: string }
  | { readonly status: "denied"; readonly reason: string }
  | { readonly status: "unavailable"; readonly reason: string }
  | { readonly status: "failed"; readonly reason: string };

/**
 * Dispatch acknowledgement only. It does not report business completion;
 * consumers must observe canonical completion through MediaDataPort.
 */
export interface MediaActionPort {
  invoke(
    actionId: string,
    payload?: Readonly<Record<string, string | number | boolean | null>>,
    context?: MediaActionDispatchContext,
  ): Promise<MediaActionDispatchResult>;
}

/** Exact owner-scoped subjects carried into a consequential action request. */
export interface MediaActionDispatchContext {
  readonly subjectRefs: readonly string[];
}

/** Fresh owner reconciliation that can release an uncertain same-action retry lock. */
export interface MediaActionReconciliation {
  readonly actionId: string;
  /** Owner record revision; must change when its exact outcome changes. */
  readonly reconciliationRevision: string;
  /** Null only when the caller never received a durable request identity. */
  readonly requestId: string | null;
  readonly requestCanonical: string;
  readonly subjectRefs: readonly string[];
  readonly disposition: "pending" | "effect-resolved" | "retry-authorized" | "unknown";
}

/** Stable exact request identity used by the host reconciliation projection. */
export function canonicalMediaActionRequest(
  actionId: string,
  payload?: Readonly<Record<string, string | number | boolean | null>>,
  context: MediaActionDispatchContext = { subjectRefs: [] },
): string {
  if (!actionId.trim()) throw new TypeError("Action identity must be a non-empty string.");
  if (!Array.isArray(context.subjectRefs) || context.subjectRefs.some((ref) => typeof ref !== "string" || !ref.trim())) {
    throw new TypeError("Action subjects must be non-empty exact references.");
  }
  if (payload !== undefined && (payload === null || typeof payload !== "object" || Array.isArray(payload))) {
    throw new TypeError("Action payload must be a flat object.");
  }
  for (const [key, value] of Object.entries(payload ?? {})) {
    if (!key.trim() || !(value === null || typeof value === "string" || typeof value === "boolean" || (typeof value === "number" && Number.isFinite(value)))) {
      throw new TypeError("Action payload fields must have non-empty names and finite scalar values.");
    }
  }
  const canonicalize = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(canonicalize);
    if (value !== null && typeof value === "object") {
      // JSON request identity must be stable across host locales/runtimes.
      // Relational string comparison uses deterministic UTF-16 code-unit order;
      // locale collation is intentionally excluded from this protocol.
      return Object.fromEntries(Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0).map(([key, child]) => [key, canonicalize(child)]));
    }
    return value;
  };
  return JSON.stringify(canonicalize({ actionId, payload: payload ?? null, subjectRefs: context.subjectRefs }));
}

/** Host router boundary for workflow step selection and product navigation. */
export interface MediaNavigationPort {
  selectStep?(stepId: MediaTaskStepId): void;
  navigate?(destinationId: string): void;
}

/** Ambient host context that may affect text and layout, not domain meaning. */
export interface MediaContextPort {
  readonly locale: string;
  readonly direction?: "ltr" | "rtl";
  readonly reducedMotion?: boolean;
}

/** Host supplied body content for a projected workflow screen. */
export type MediaScreenBody = React.ReactNode;
