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
}

/** Capability supplied by the host; the presentation never decides eligibility. */
export type MediaActionDispatchResult =
  | { readonly status: "intent-accepted" }
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
  invoke(actionId: string, payload?: Readonly<Record<string, string | number | boolean | null>>): Promise<MediaActionDispatchResult>;
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
