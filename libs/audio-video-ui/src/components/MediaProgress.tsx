import React from "react";

export type MediaProgressTone = "neutral" | "info" | "primary" | "success" | "warning" | "error";

export interface MediaProgressProps {
  /** Omit value when the amount of completed work is not known. */
  readonly value?: number;
  readonly max?: number;
  readonly label: string;
  readonly valueText?: string;
  readonly tone?: MediaProgressTone;
  readonly className?: string;
}

/**
 * CSP-safe, native progress presentation shared by Media and AI Voice.
 * Visual treatment lives in @audio-video/ui/styles.css; this component emits
 * no inline styles and leaves operation meaning with the caller.
 */
export function MediaProgress({
  value,
  max = 100,
  label,
  valueText,
  tone = "primary",
  className,
}: MediaProgressProps): React.ReactElement {
  const safeMax = Number.isFinite(max) && max > 0 ? max : 100;
  const determinate = value !== undefined && Number.isFinite(value);
  const safeValue = determinate ? Math.min(safeMax, Math.max(0, value)) : undefined;
  const classes = ["media-progress", `media-progress--${tone}`, className].filter(Boolean).join(" ");

  return <progress
    className={classes}
    max={safeMax}
    value={safeValue}
    aria-label={label}
    aria-valuetext={determinate ? valueText : undefined}
    aria-busy={determinate ? undefined : "true"}
  />;
}
