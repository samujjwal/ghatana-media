/**
 * Accessible voice-model training progress.
 *
 * @doc.type component
 * @doc.purpose Training status, progress, cancellation, and terminal outcomes
 * @doc.layer product
 * @doc.pattern StatusComponent
 */
import { Button } from "@ghatana/design-system";
import React, { useMemo } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { TrainingStatus } from "../types";
import { useSemanticColors } from "./useSemanticColors";

export interface TrainingProgressProps {
  readonly status: TrainingStatus;
  readonly progress: number;
  readonly modelName?: string;
  readonly error?: string;
  readonly onCancel?: () => void;
  readonly cancelDisabled?: boolean;
  readonly className?: string;
}

const statusLabels: Record<TrainingStatus, string> = {
  pending: "Preparing training",
  preprocessing: "Preprocessing samples",
  extracting: "Extracting features",
  training: "Training voice model",
  completed: "Training complete",
  failed: "Training failed",
};

const STEPS = [
  "preprocessing",
  "extracting",
  "training",
  "completed",
] as const satisfies readonly TrainingStatus[];

export const TrainingProgress: React.FC<TrainingProgressProps> = ({
  status,
  progress,
  modelName,
  error,
  onCancel,
  cancelDisabled = false,
  className,
}) => {
  const colors = useSemanticColors();
  const statusColors: Record<TrainingStatus, string> = {
    pending: colors.contentDisabled,
    preprocessing: colors.info,
    extracting: colors.info,
    training: colors.action,
    completed: colors.success,
    failed: colors.error,
  };
  const boundedProgress = Math.max(0, Math.min(100, progress));
  const active = status !== "completed" && status !== "failed";
  const currentStepIndex = STEPS.indexOf(status as (typeof STEPS)[number]);
  const announcement = useMemo(() => {
    if (status === "failed") return error ? `Training failed. ${error}` : "Training failed.";
    if (status === "completed") return "Voice model training completed successfully.";
    return `${statusLabels[status]}, ${Math.round(boundedProgress)} percent complete.`;
  }, [boundedProgress, error, status]);

  return (
    <section
      className={twMerge(
        clsx(
          "rounded-lg border p-4",
        ),
        className,
      )}
      style={{ borderColor: colors.border, backgroundColor: colors.surface, color: colors.content }}
      aria-labelledby="voice-training-title"
      aria-describedby="voice-training-status"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 id="voice-training-title" className="text-lg font-medium">
            {modelName ? `Training ${modelName}` : "Training voice model"}
          </h3>
          <p id="voice-training-status" className="text-sm" style={{ color: colors.contentSecondary }}>
            {statusLabels[status]}
          </p>
        </div>
        {active && onCancel && (
          <Button
            type="button"
            variant="soft"
            tone="danger"
            size="sm"
            onClick={onCancel}
            disabled={cancelDisabled}
            aria-describedby="voice-training-cancel-note"
          >
            Cancel training
          </Button>
        )}
      </div>

      {active && onCancel && (
        <p id="voice-training-cancel-note" className="sr-only">
          Cancelling stops the current training job. Existing source samples are
          retained according to their configured retention policy.
        </p>
      )}

      <div className="mb-3">
        <div className="mb-1 flex justify-between gap-3 text-sm" style={{ color: colors.contentSecondary }}>
          <span>{statusLabels[status]}</span>
          <span>{Math.round(boundedProgress)}%</span>
        </div>
        <div
          className="h-2 overflow-hidden rounded-full"
          role="progressbar"
          aria-label="Voice-model training progress"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(boundedProgress)}
          aria-valuetext={`${statusLabels[status]}, ${Math.round(boundedProgress)} percent`}
          style={{ backgroundColor: colors.surfaceElevated }}
        >
          <div
            className={clsx("h-full transition-[width] duration-300 motion-reduce:transition-none", active && "animate-pulse motion-reduce:animate-none")}
            style={{ width: `${boundedProgress}%`, backgroundColor: statusColors[status] }}
          />
        </div>
      </div>

      <ol className="mt-5 grid grid-cols-4 gap-2" aria-label="Training stages">
        {STEPS.map((step, index) => {
          const complete =
            status === "completed" ||
            (currentStepIndex >= 0 && index < currentStepIndex);
          const current = step === status;
          return (
            <li key={step} className="flex min-w-0 flex-col items-center text-center">
              <span
                className="flex h-8 w-8 items-center justify-center rounded-full text-sm font-medium"
                aria-hidden="true"
                style={{
                  backgroundColor: complete
                    ? colors.success
                    : current
                      ? colors.action
                      : colors.surfaceElevated,
                  color: complete
                    ? colors.successOn
                    : current
                      ? colors.actionOn
                      : colors.contentSecondary,
                }}
              >
                {complete ? "✓" : index + 1}
              </span>
              <span
                className="mt-1 truncate text-xs capitalize"
                aria-current={current ? "step" : undefined}
                style={{ color: colors.contentSecondary }}
              >
                {step === "completed" ? "Done" : step}
              </span>
              <span className="sr-only">
                {complete ? "completed" : current ? "current" : "not started"}
              </span>
            </li>
          );
        })}
      </ol>

      {error && (
        <div
          className="mt-4 rounded-lg border p-3"
          role="alert"
          style={{ borderColor: colors.error, backgroundColor: colors.errorSubtle, color: colors.errorOn }}
        >
          <p className="text-sm">{error}</p>
        </div>
      )}

      {status === "completed" && (
        <div
          className="mt-4 rounded-lg border p-3"
          role="status"
          style={{ borderColor: colors.success, backgroundColor: colors.successSubtle, color: colors.successOn }}
        >
          <p className="text-sm">
            Voice model trained successfully. Review quality and consent evidence
            before using it for conversion.
          </p>
        </div>
      )}

      <p className="sr-only" aria-live="polite" aria-atomic="true">
        {announcement}
      </p>
    </section>
  );
};
