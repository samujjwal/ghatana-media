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

/** Action facts projected by a host. The host port performs the requested action. */
export interface MediaScreenAction {
  readonly id: string;
  readonly label: string;
  readonly enabled: boolean;
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

function bindAction(action: MediaScreenAction, port: MediaActionPort): MediaTaskAction {
  return {
    id: action.id,
    label: action.label,
    disabled: !action.enabled,
    disabledReason: action.disabledReason,
    destructive: action.destructive,
    onAction: () => { void port.invoke(action.id); },
  };
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
  const byId = new Map(actions.map((action) => [action.id, action]));
  const boundActions = actions.map((action) => bindAction(action, actionPort));
  const safeActions = nextSafeActionIds.flatMap((id) => {
    const action = byId.get(id);
    return action ? [bindAction(action, actionPort)] : [];
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
      {children}
    </MediaTaskFlow>
  </div>;
}
