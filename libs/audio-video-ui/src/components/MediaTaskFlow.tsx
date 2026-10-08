/**
 * Host-neutral workflow presentation. Eligibility, finality, progress knowledge,
 * and safe actions are supplied by the host/domain projection.
 *
 * @doc.type component
 * @doc.purpose Present a Media workflow projection and its observed operation
 * @doc.layer shared
 * @doc.pattern TaskFlow
 */
import React from "react";
import { Badge, Button } from "../foundations";

/** Host-defined step IDs keep the composition independent of one workflow vocabulary. */
export type MediaTaskStepId = string;
export type MediaTaskStepState = "available" | "current" | "complete" | "blocked";

export interface MediaTaskStep {
  readonly id: MediaTaskStepId;
  readonly title: string;
  readonly description: string;
  readonly state: MediaTaskStepState;
  /** Host/domain-projected navigation eligibility; step state does not imply it. */
  readonly selectable?: boolean;
  readonly blockedReason?: string;
}

export interface MediaTaskAction {
  readonly id: string;
  readonly label: string;
  readonly onAction: () => void;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
  readonly destructive?: boolean;
}

/** Opaque state token supplied by the operation owner; this layer does not adjudicate the vocabulary. */
export type MediaTaskOperationState = string;

/** A measured value and whether the host considers its meaning determinate. */
export type MediaTaskProgress =
  | { readonly kind: "determinate"; readonly value: number; readonly label?: string }
  | { readonly kind: "indeterminate"; readonly label?: string }
  | { readonly kind: "none" }
  | { readonly kind: "unknown"; readonly label?: string };

export interface MediaTaskOperationObservation {
  readonly state: MediaTaskOperationState;
  readonly progress: MediaTaskProgress;
  readonly message?: string;
  readonly correlationId?: string;
  readonly finality?: string;
}

/** Host/domain-owned screen projection; it carries displayable facts only. */
export interface MediaTaskCurrentProjection {
  readonly title: string;
  readonly description: string;
  readonly steps: readonly MediaTaskStep[];
  readonly currentStepId: MediaTaskStepId;
  readonly summary?: React.ReactNode;
}

/** Legacy input retained for existing consumers while they migrate. */
export interface MediaTaskOperation {
  readonly state: MediaTaskOperationState;
  readonly progress?: number;
  readonly progressKind?: "determinate" | "indeterminate" | "none" | "unknown";
  readonly message?: string;
  readonly correlationId?: string;
  /** @deprecated Supply actions through availableActions/nextSafeActions. */
  readonly cancellable?: boolean;
  /** @deprecated Supply actions through availableActions/nextSafeActions. */
  readonly retryable?: boolean;
  /** @deprecated Supply actions through availableActions/nextSafeActions. */
  readonly onCancel?: () => void;
  /** @deprecated Supply actions through availableActions/nextSafeActions. */
  readonly onRetry?: () => void;
}

export interface MediaTaskFlowProps {
  /** Legacy scalar props. Prefer currentProjection. */
  readonly title?: string;
  readonly description?: string;
  readonly steps?: readonly MediaTaskStep[];
  readonly currentStepId?: MediaTaskStepId;
  readonly summary?: React.ReactNode;
  readonly currentProjection?: MediaTaskCurrentProjection;
  readonly onStepSelect?: (stepId: MediaTaskStepId) => void;
  /** Actions the host says are available in this projection. */
  readonly availableActions?: readonly MediaTaskAction[];
  /** Host/domain-selected safe next actions, shown in the next-action area. */
  readonly nextSafeActions?: readonly MediaTaskAction[];
  /** The latest observed remote operation; no business state is inferred here. */
  readonly operationObservation?: MediaTaskOperationObservation;
  /** Compatibility inputs. */
  readonly primaryAction?: MediaTaskAction;
  readonly secondaryActions?: readonly MediaTaskAction[];
  readonly operation?: MediaTaskOperation;
  readonly children: React.ReactNode;
  readonly className?: string;
}

const stateTone = {
  available: "neutral",
  current: "info",
  complete: "success",
  blocked: "warning",
} as const;

function legacyObservation(operation?: MediaTaskOperation): MediaTaskOperationObservation | undefined {
  if (!operation) return undefined;
  const kind = operation.progressKind ?? "determinate";
  const progress: MediaTaskProgress = kind === "determinate"
    ? { kind, value: operation.progress ?? 0 }
    : kind === "none" ? { kind } : { kind };
  return {
    state: operation.state,
    progress,
    message: operation.message,
    correlationId: operation.correlationId,
  };
}

export function MediaTaskFlow({
  title, description, steps, currentStepId, summary, currentProjection,
  onStepSelect, availableActions = [], nextSafeActions, operationObservation,
  primaryAction, secondaryActions = [], operation, children, className,
}: MediaTaskFlowProps): React.ReactElement {
  const projection = currentProjection ?? {
    title: title ?? "Media task",
    description: description ?? "",
    steps: steps ?? [],
    currentStepId: currentStepId ?? steps?.[0]?.id ?? "capture",
    summary,
  };
  const currentStep = projection.steps.find((step) => step.id === projection.currentStepId)
    ?? projection.steps[0];
  const observation = operationObservation ?? legacyObservation(operation);
  // Legacy operation callbacks are adapted as supplied actions only. The state
  // observation itself never decides eligibility, finality, or action safety.
  const legacyActions: MediaTaskAction[] = [
    ...(operation?.cancellable && operation.onCancel ? [{ id: "legacy-cancel", label: "Cancel operation", destructive: true, onAction: operation.onCancel }] : []),
    ...(operation?.retryable && operation.onRetry ? [{ id: "legacy-retry", label: "Retry operation", onAction: operation.onRetry }] : []),
  ];
  const primary = nextSafeActions?.[0] ?? primaryAction;
  const proposedActions = [
    ...availableActions,
    ...(nextSafeActions ? nextSafeActions.slice(primary ? 1 : 0) : secondaryActions),
    ...legacyActions,
  ];
  const actions = proposedActions.filter((action, index) =>
    action.id !== primary?.id && proposedActions.findIndex((candidate) => candidate.id === action.id) === index,
  );
  const progress = observation?.progress;
  const measured = progress?.kind === "determinate" && Number.isFinite(progress.value);
  const boundedProgress = measured ? Math.max(0, Math.min(100, progress.value)) : undefined;

  return (
    <main className={`media-task-flow ${className ?? ""}`} aria-labelledby="media-task-flow-title">
      <header >
        <h1 id="media-task-flow-title" >{projection.title}</h1>
        <p >{projection.description}</p>
      </header>

      <nav aria-label="Media workflow progress">
        <ol >
          {projection.steps.map((step, index) => {
            const selected = step.id === projection.currentStepId;
            const interactive = Boolean(onStepSelect) && step.selectable !== false;
            return <li key={step.id}>
              <button type="button" onClick={() => interactive && onStepSelect?.(step.id)} disabled={!interactive}
                aria-current={selected ? "step" : undefined}
                aria-describedby={step.blockedReason ? `media-step-${step.id}-reason` : undefined}
                >
                <span >
                  <span >{index + 1}</span>
                  <Badge tone={stateTone[step.state]} variant="soft">{step.state}</Badge>
                </span>
                <span >{step.title}</span>
                <span >{step.description}</span>
              </button>
              {step.blockedReason && <p id={`media-step-${step.id}-reason`} >{step.blockedReason}</p>}
            </li>;
          })}
        </ol>
      </nav>

      {observation && <section aria-labelledby="media-operation-title" >
        <div >
          <div>
            <h2 id="media-operation-title" >{observation.state.replaceAll("_", " ").toLowerCase()}</h2>
            <p >{observation.message ?? "Operation status was observed."}</p>
            {observation.finality && <p >{observation.finality}</p>}
            {observation.correlationId && <p >Correlation: {observation.correlationId}</p>}
          </div>
        </div>
        {progress?.kind === "determinate" && boundedProgress !== undefined && <>
          <progress max={100} value={boundedProgress} aria-label={progress.label ?? "Media operation progress"} />
          <p >{Math.round(boundedProgress)}%</p>
        </>}
        {progress?.kind === "indeterminate" && <div>
          <progress aria-busy="true" aria-label={progress.label ?? "Media operation progress"} />
          <p >Progress is ongoing; amount is not measured.</p>
        </div>}
        {progress?.kind === "none" && <p >No meaningful progress measurement is available.</p>}
        {progress?.kind === "unknown" && <p  role="status">{progress.label ?? "The remote outcome is unknown. Check the operation status before taking another action."}</p>}
      </section>}

      <div >
        <section aria-labelledby="media-current-task-title" >
          <header >
            <p >Current task</p>
            <h2 id="media-current-task-title" >{currentStep?.title ?? "Media task"}</h2>
            <p >{currentStep?.description}</p>
          </header>
          {children}
        </section>
        <aside  aria-label="Media workflow summary and actions">
          {projection.summary && <section ><h2 >Summary</h2><div >{projection.summary}</div></section>}
          {(primary || actions.length > 0) && <section >
            <h2 >Next action</h2>
            <div >
              {primary && <Button fullWidth onClick={primary.onAction} disabled={primary.disabled} aria-describedby={primary.disabledReason ? "media-primary-action-reason" : undefined}>{primary.label}</Button>}
              {primary?.disabledReason && <p id="media-primary-action-reason" >{primary.disabledReason}</p>}
              {actions.map((action) => <React.Fragment key={action.id}>
                <Button fullWidth variant="soft" tone={action.destructive ? "danger" : "neutral"} onClick={action.onAction} disabled={action.disabled}
                  aria-describedby={action.disabledReason ? `media-action-${action.id}-reason` : undefined}>{action.label}</Button>
                {action.disabledReason && <p id={`media-action-${action.id}-reason`} >{action.disabledReason}</p>}
              </React.Fragment>)}
            </div>
          </section>}
        </aside>
      </div>
    </main>
  );
}
