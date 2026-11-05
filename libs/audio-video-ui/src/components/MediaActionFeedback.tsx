import React from "react";
import type { MediaActionDispatchResult } from "../ports";

export type MediaActionFeedbackState =
  | "pending"
  | "intent-accepted"
  | "local-applied"
  | "request-started"
  | "request-acknowledged"
  | "denied"
  | "unavailable"
  | "failed"
  | "unknown";

export interface MediaActionFeedbackValue {
  readonly state: MediaActionFeedbackState;
  readonly message: string;
}

export function mediaActionFeedbackForResult(result: MediaActionDispatchResult): MediaActionFeedbackValue {
  switch (result.status) {
    case "intent-accepted":
      return { state: result.status, message: "The action intent was accepted. This does not confirm a domain effect." };
    case "local-applied":
      return { state: result.status, message: "The source-defined local selection or draft change was applied; no remote effect is implied." };
    case "request-started":
      return { state: result.status, message: `Request started (${result.requestId}). Completion remains unobserved.` };
    case "request-acknowledged":
      return { state: result.status, message: `Request acknowledged (${result.requestId}). Completion remains unobserved.` };
    case "denied":
    case "unavailable":
    case "failed":
      return { state: result.status, message: `Action ${result.status}: ${result.reason}` };
  }
}

export function MediaActionFeedback({ value }: { readonly value: MediaActionFeedbackValue }): React.ReactElement {
  return <p
    role="status"
    aria-live="polite"
    aria-atomic="true"
    aria-busy={value.state === "pending" ? "true" : undefined}
    data-state={value.state}
  >{value.message}</p>;
}
