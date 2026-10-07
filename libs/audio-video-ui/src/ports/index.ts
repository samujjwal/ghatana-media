import type React from "react";
import type {
  MediaTaskCurrentProjection,
  MediaTaskOperationObservation,
  MediaTaskStepId,
} from "../components/MediaTaskFlow";

/** Read-only product projection supplied by a production or review adapter. */
export interface MediaDataPort {
  readonly currentProjection: MediaTaskCurrentProjection;
  readonly operationObservation?: MediaTaskOperationObservation;
}

/** Capability supplied by the host; the presentation never decides eligibility. */
export interface MediaActionPort {
  invoke(actionId: string, payload?: Readonly<Record<string, string | number | boolean | null>>): void | Promise<void>;
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
