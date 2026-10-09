import React from "react";
import {
  MediaTaskFlow,
  type MediaTaskAction,
  type MediaTaskCurrentProjection,
  type MediaTaskOperationObservation,
  type MediaTaskStepId,
} from "../components/MediaTaskFlow";
import type {
  MediaActionPort,
  MediaContextPort,
  MediaDataPort,
  MediaNavigationPort,
  MediaScreenBody,
} from "../ports";
import type { MediaComponentValue } from "../components/MediaComponentFamilies";

/** Action facts projected by a host. The host port performs the requested action. */
export interface MediaScreenAction {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
  /** Host-projected parameters for this exact action intent; never synthesized by the renderer. */
  readonly payload?: Readonly<Record<string, string | number | boolean | null>>;
  /** Exact owner-scoped versions/subjects needed to reconcile an uncertain request. */
  readonly subjectRefs?: readonly string[];
  /** Explicit Media adapter from a source-defined selection value to the action request. */
  readonly payloadForSelection?: (value: MediaComponentValue) => Readonly<Record<string, string | number | boolean | null>>;
  readonly disabledReason?: string;
  readonly destructive?: boolean;
}

export interface MediaTaskScreenProps {
  readonly data: MediaDataPort;
  readonly actions?: readonly MediaScreenAction[];
  readonly nextSafeActionIds?: readonly string[];
  readonly actionPort: MediaActionPort;
  readonly navigationPort?: MediaNavigationPort;
  readonly context: MediaContextPort;
  readonly children: MediaScreenBody;
  readonly className?: string;
}

/**
 * Product-owned, host-neutral workflow screen mount. The host supplies the
 * authoritative projection, action availability, operation observation, and
 * body; this composition only binds those facts to the shared presentation.
 */
export function MediaTaskScreen({
  data, actions = [], nextSafeActionIds = [], actionPort, navigationPort,
  context, children, className,
}: MediaTaskScreenProps): React.ReactElement {
  const [pendingActionId, setPendingActionId] = React.useState<string | undefined>();
  const [actionStatus, setActionStatus] = React.useState<string | undefined>();
  const byId = new Map(actions.map((action) => [action.id, action]));
  const bind = (action: MediaScreenAction): MediaTaskAction => ({
    id: action.id,
    label: action.label,
    disabled: !action.enabled || pendingActionId !== undefined,
    disabledReason: action.disabledReason,
    destructive: action.destructive,
    onAction: () => {
      if (!action.enabled || pendingActionId !== undefined) return;
      setPendingActionId(action.id);
      setActionStatus("Request submitted; completion remains unknown until a fresh owner projection arrives.");
      void (async () => {
        try {
          const result = action.payloadForSelection
            ? { status: "unavailable" as const, reason: "This action requires an exact selected-value adapter." }
            : action.payload === undefined
              ? await actionPort.invoke(action.id, undefined, { subjectRefs: action.subjectRefs ?? [] })
              : await actionPort.invoke(action.id, action.payload, { subjectRefs: action.subjectRefs ?? [] });
          setActionStatus(result.status === "failed" || result.status === "denied" || result.status === "unavailable"
            ? `${result.status}: ${result.reason}`
            : result.status === "local-applied"
              ? "The source-defined local selection or draft change was applied; no remote effect is implied."
            : result.status === "intent-accepted"
              ? "The action intent was accepted; no domain effect is confirmed."
              : `Request acknowledged (${result.requestId}); completion remains unobserved.`);
        } catch (error) {
          setActionStatus(`Request outcome is unknown: ${error instanceof Error ? error.message : "request failure"}. Reconcile before retrying.`);
        } finally {
          setPendingActionId(undefined);
        }
      })();
    },
  });
  const boundActions = actions.map(bind);
  const safeActions = nextSafeActionIds.flatMap((id) => {
    const action = byId.get(id);
    return action ? [bind(action)] : [];
  });

  const onSelectStep = navigationPort?.selectStep;
  return <div dir={context.direction} lang={context.locale}>
    <MediaTaskFlow
      currentProjection={data.currentProjection}
      availableActions={boundActions}
      nextSafeActions={safeActions}
      operationObservation={data.operationObservation}
      onStepSelect={onSelectStep}
      className={className}
    >
      <>{children}{actionStatus && <p role="status" aria-live="polite">{actionStatus}</p>}</>
    </MediaTaskFlow>
  </div>;
}
