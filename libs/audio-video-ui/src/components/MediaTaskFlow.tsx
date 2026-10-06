/**
 * Outcome-first media task flow.
 *
 * Presents one current task, one primary action, contextual secondary actions,
 * and progressively disclosed operation details. Product surfaces provide the
 * domain content while this component owns consistent navigation and status UX.
 *
 * @doc.type component
 * @doc.purpose Seven-stage media production workflow
 * @doc.layer shared
 * @doc.pattern TaskFlow
 */
import { Badge, Button } from "@ghatana/design-system";
import React from "react";

export type MediaTaskStepId =
  | "capture"
  | "inspect"
  | "process"
  | "review"
  | "refine"
  | "approve"
  | "export";

export type MediaTaskStepState =
  | "available"
  | "current"
  | "complete"
  | "blocked";

export interface MediaTaskStep {
  readonly id: MediaTaskStepId;
  readonly title: string;
  readonly description: string;
  readonly state: MediaTaskStepState;
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

export type MediaTaskOperationState =
  | "QUEUED"
  | "RUNNING"
  | "RETRY_PENDING"
  | "OUTCOME_UNKNOWN"
  | "RECONCILING"
  | "COMPLETED"
  | "FAILED"
  | "PARTIALLY_SUCCEEDED"
  | "CANCELLED";

/** Compatibility input only; callers must migrate to PDP-1 state names. */
export type LegacyMediaTaskOperationState = "CANCELLING" | "RETRYING";

export interface MediaTaskOperation {
  readonly state: MediaTaskOperationState;
  readonly progress: number;
  readonly message?: string;
  readonly correlationId?: string;
  readonly cancellable?: boolean;
  readonly retryable?: boolean;
  readonly onCancel?: () => void;
  readonly onRetry?: () => void;
}

export interface MediaTaskFlowProps {
  readonly title: string;
  readonly description: string;
  readonly steps: readonly MediaTaskStep[];
  readonly currentStepId: MediaTaskStepId;
  readonly onStepSelect?: (stepId: MediaTaskStepId) => void;
  readonly primaryAction?: MediaTaskAction;
  readonly secondaryActions?: readonly MediaTaskAction[];
  readonly operation?: MediaTaskOperation;
  readonly summary?: React.ReactNode;
  readonly children: React.ReactNode;
  readonly className?: string;
}

const stateTone = {
  available: "neutral",
  current: "info",
  complete: "success",
  blocked: "warning",
} as const;

function operationActive(operation: MediaTaskOperation | undefined): boolean {
  return Boolean(
    operation &&
      ["QUEUED", "RUNNING", "RETRY_PENDING", "OUTCOME_UNKNOWN", "RECONCILING"].includes(
        operation.state,
      ),
  );
}

export function MediaTaskFlow({
  title,
  description,
  steps,
  currentStepId,
  onStepSelect,
  primaryAction,
  secondaryActions = [],
  operation,
  summary,
  children,
  className,
}: MediaTaskFlowProps): React.ReactElement {
  const currentStep =
    steps.find((step) => step.id === currentStepId) ?? steps[0];
  const boundedProgress = Math.max(
    0,
    Math.min(100, operation?.progress ?? 0),
  );
  const active = operationActive(operation);
  const primaryDisabled =
    primaryAction?.disabled || active || currentStep?.state === "blocked";
  const primaryReason =
    currentStep?.blockedReason ?? primaryAction?.disabledReason;

  return (
    <main
      className={`mx-auto w-full max-w-7xl space-y-6 ${className ?? ""}`}
      aria-labelledby="media-task-flow-title"
    >
      <header className="space-y-2">
        <h1 id="media-task-flow-title" className="text-2xl font-semibold">
          {title}
        </h1>
        <p className="max-w-3xl text-sm text-gray-600 dark:text-gray-300">
          {description}
        </p>
      </header>

      <nav aria-label="Media workflow progress">
        <ol className="grid gap-2 sm:grid-cols-2 lg:grid-cols-7">
          {steps.map((step, index) => {
            const selected = step.id === currentStepId;
            const interactive =
              Boolean(onStepSelect) && step.state !== "blocked";
            return (
              <li key={step.id}>
                <button
                  type="button"
                  onClick={() => interactive && onStepSelect?.(step.id)}
                  disabled={!interactive}
                  aria-current={selected ? "step" : undefined}
                  aria-describedby={
                    step.blockedReason ? `media-step-${step.id}-reason` : undefined
                  }
                  className={`min-h-24 w-full rounded-lg border p-3 text-left transition ${
                    selected
                      ? "border-blue-500 bg-blue-50 dark:bg-blue-950/40"
                      : "border-gray-200 bg-white dark:border-gray-700 dark:bg-gray-900"
                  } ${interactive ? "hover:border-blue-400" : "cursor-default"}`}
                >
                  <span className="flex items-start justify-between gap-2">
                    <span className="text-xs font-medium text-gray-500">
                      {index + 1}
                    </span>
                    <Badge tone={stateTone[step.state]} variant="soft">
                      {step.state}
                    </Badge>
                  </span>
                  <span className="mt-2 block text-sm font-semibold">
                    {step.title}
                  </span>
                  <span className="mt-1 block text-xs text-gray-500 dark:text-gray-400">
                    {step.description}
                  </span>
                </button>
                {step.blockedReason && (
                  <p id={`media-step-${step.id}-reason`} className="sr-only">
                    {step.blockedReason}
                  </p>
                )}
              </li>
            );
          })}
        </ol>
      </nav>

      {operation && (
        <section
          aria-labelledby="media-operation-title"
          className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h2 id="media-operation-title" className="font-semibold">
                {operation.state.replaceAll("_", " ").toLowerCase()}
              </h2>
              <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
                {operation.message ?? "The media operation is being processed."}
              </p>
              {operation.correlationId && (
                <p className="mt-1 text-xs text-gray-500">
                  Correlation: {operation.correlationId}
                </p>
              )}
            </div>
            <div className="flex flex-wrap gap-2">
              {active && operation.cancellable && operation.onCancel && (
                <Button
                  variant="soft"
                  tone="danger"
                  size="sm"
                  onClick={operation.onCancel}
                >
                  Cancel operation
                </Button>
              )}
              {!active && operation.retryable && operation.onRetry && (
                <Button
                  variant="soft"
                  tone="accent"
                  size="sm"
                  onClick={operation.onRetry}
                >
                  Retry operation
                </Button>
              )}
            </div>
          </div>
          <div
            className="mt-3 h-2 overflow-hidden rounded-full bg-gray-200 dark:bg-gray-700"
            role="progressbar"
            aria-label="Media operation progress"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={Math.round(boundedProgress)}
          >
            <div
              className="h-full bg-blue-600 transition-[width] motion-reduce:transition-none"
              style={{ width: `${boundedProgress}%` }}
            />
          </div>
          <p className="mt-1 text-right text-xs text-gray-500">
            {Math.round(boundedProgress)}%
          </p>
        </section>
      )}

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_18rem]">
        <section
          aria-labelledby="media-current-task-title"
          className="min-w-0 rounded-xl border border-gray-200 bg-white p-5 dark:border-gray-700 dark:bg-gray-900"
        >
          <header className="mb-5">
            <p className="text-xs font-semibold uppercase tracking-wide text-blue-600">
              Current task
            </p>
            <h2 id="media-current-task-title" className="mt-1 text-xl font-semibold">
              {currentStep?.title ?? "Media task"}
            </h2>
            <p className="mt-1 text-sm text-gray-600 dark:text-gray-300">
              {currentStep?.description}
            </p>
          </header>
          {children}
        </section>

        <aside className="space-y-4" aria-label="Media workflow summary and actions">
          {summary && (
            <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
              <h2 className="font-semibold">Summary</h2>
              <div className="mt-3 text-sm text-gray-600 dark:text-gray-300">
                {summary}
              </div>
            </section>
          )}

          <section className="rounded-xl border border-gray-200 bg-white p-4 dark:border-gray-700 dark:bg-gray-900">
            <h2 className="font-semibold">Next action</h2>
            <div className="mt-3 grid gap-2">
              {primaryAction && (
                <Button
                  fullWidth
                  onClick={primaryAction.onAction}
                  disabled={primaryDisabled}
                  aria-describedby={primaryReason ? "media-primary-action-reason" : undefined}
                >
                  {primaryAction.label}
                </Button>
              )}
              {primaryReason && (
                <p
                  id="media-primary-action-reason"
                  className="text-xs text-amber-700 dark:text-amber-300"
                >
                  {primaryReason}
                </p>
              )}
              {secondaryActions.map((action) => (
                <React.Fragment key={action.id}>
                  <Button
                    fullWidth
                    variant="soft"
                    tone={action.destructive ? "danger" : "neutral"}
                    onClick={action.onAction}
                    disabled={action.disabled || active}
                    aria-describedby={
                      action.disabledReason
                        ? `media-action-${action.id}-reason`
                        : undefined
                    }
                  >
                    {action.label}
                  </Button>
                  {action.disabledReason && (
                    <p
                      id={`media-action-${action.id}-reason`}
                      className="text-xs text-gray-500"
                    >
                      {action.disabledReason}
                    </p>
                  )}
                </React.Fragment>
              ))}
            </div>
          </section>
        </aside>
      </div>
    </main>
  );
}
