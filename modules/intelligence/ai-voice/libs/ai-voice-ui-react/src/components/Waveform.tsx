/**
 * Accessible audio waveform visualization.
 *
 * @doc.type component
 * @doc.purpose Responsive waveform visualization and keyboard seek control
 * @doc.layer product
 * @doc.pattern Component
 */
import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import { useSemanticColors } from "./useSemanticColors";

export interface WaveformProps {
  /** Waveform samples. Values are normalized internally. */
  readonly data: readonly number[];
  /** Current playback position from 0 to 1. */
  readonly position?: number;
  /** Total duration in seconds, used for accessible value text. */
  readonly duration?: number;
  readonly color?: string;
  readonly progressColor?: string;
  readonly backgroundColor?: string;
  readonly playheadColor?: string;
  readonly height?: number;
  readonly variant?: "bars" | "line";
  readonly onSeek?: (position: number) => void;
  readonly seekStep?: number;
  readonly ariaLabel?: string;
  readonly className?: string;
}

function clamp(value: number, minimum = 0, maximum = 1): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function formatTime(seconds: number): string {
  const safeSeconds = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safeSeconds / 60);
  const remaining = Math.floor(safeSeconds % 60);
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

export const Waveform: React.FC<WaveformProps> = ({
  data,
  position = 0,
  duration,
  color,
  progressColor,
  backgroundColor,
  playheadColor,
  height = 80,
  variant = "bars",
  onSeek,
  seekStep = 0.01,
  ariaLabel = "Audio waveform",
  className,
}) => {
  const colors = useSemanticColors();
  const effectiveColor = color ?? colors.info;
  const effectiveProgressColor = progressColor ?? colors.action;
  const effectiveBackgroundColor = backgroundColor ?? colors.surface;
  const effectivePlayheadColor = playheadColor ?? colors.content;
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const normalizedPosition = clamp(position);
  const normalizedHeight = Math.max(24, height);

  const normalizedData = useMemo(() => {
    if (data.length === 0) return [];
    const maximum = data.reduce(
      (current, value) => Math.max(current, Math.abs(value)),
      0,
    );
    return maximum > 0 ? data.map((value) => value / maximum) : [...data];
  }, [data]);

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const measure = (): void => {
      setWidth(Math.max(0, container.getBoundingClientRect().width));
    };
    measure();
    if (typeof ResizeObserver === "undefined") {
      window.addEventListener("resize", measure);
      return () => window.removeEventListener("resize", measure);
    }
    const observer = new ResizeObserver(measure);
    observer.observe(container);
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || width <= 0) return;
    const context = canvas.getContext("2d");
    if (!context) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(normalizedHeight * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${normalizedHeight}px`;
    context.setTransform(dpr, 0, 0, dpr, 0, 0);
    context.clearRect(0, 0, width, normalizedHeight);
    context.fillStyle = effectiveBackgroundColor;
    context.fillRect(0, 0, width, normalizedHeight);

    if (normalizedData.length === 0) return;
    const sampleWidth = width / normalizedData.length;
    const centerY = normalizedHeight / 2;
    const progressX = normalizedPosition * width;

    if (variant === "bars") {
      normalizedData.forEach((value, index) => {
        const x = index * sampleWidth;
        const barHeight = Math.max(1, Math.abs(value) * normalizedHeight * 0.8);
        context.fillStyle = x < progressX ? effectiveProgressColor : effectiveColor;
        context.fillRect(
          x,
          centerY - barHeight / 2,
          Math.max(1, sampleWidth - 1),
          barHeight,
        );
      });
    } else {
      context.beginPath();
      context.strokeStyle = effectiveColor;
      context.lineWidth = 1;
      normalizedData.forEach((value, index) => {
        const x = index * sampleWidth;
        const y = centerY - value * normalizedHeight * 0.4;
        if (index === 0) context.moveTo(x, y);
        else context.lineTo(x, y);
      });
      context.stroke();
      if (normalizedPosition > 0) {
        context.save();
        context.beginPath();
        context.rect(0, 0, progressX, normalizedHeight);
        context.clip();
        context.strokeStyle = effectiveProgressColor;
        context.stroke();
        context.restore();
      }
    }

    context.fillStyle = effectivePlayheadColor;
    context.fillRect(Math.max(0, progressX - 1), 0, 2, normalizedHeight);
  }, [
    effectiveBackgroundColor,
    effectiveColor,
    effectivePlayheadColor,
    normalizedData,
    normalizedHeight,
    normalizedPosition,
    effectiveProgressColor,
    variant,
    width,
  ]);

  const seek = useCallback(
    (nextPosition: number): void => {
      onSeek?.(clamp(nextPosition));
    },
    [onSeek],
  );

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (!onSeek || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      seek((event.clientX - rect.left) / rect.width);
    },
    [onSeek, seek],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (!onSeek) return;
      let next: number | undefined;
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        next = normalizedPosition - seekStep;
      } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        next = normalizedPosition + seekStep;
      } else if (event.key === "PageDown") {
        next = normalizedPosition - seekStep * 10;
      } else if (event.key === "PageUp") {
        next = normalizedPosition + seekStep * 10;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = 1;
      }
      if (next === undefined) return;
      event.preventDefault();
      seek(next);
    },
    [normalizedPosition, onSeek, seek, seekStep],
  );

  const valueText = duration
    ? `${formatTime(normalizedPosition * duration)} of ${formatTime(duration)}`
    : `${Math.round(normalizedPosition * 100)} percent`;

  return (
    <div
      ref={containerRef}
      className={twMerge(
        clsx(
          "relative w-full overflow-hidden rounded-lg",
          onSeek && "cursor-pointer focus-visible:outline-none focus-visible:ring-2",
        ),
        className,
      )}
      style={{ minHeight: normalizedHeight, "--tw-ring-color": colors.focus } as React.CSSProperties}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      {...(onSeek
        ? {
            role: "slider",
            tabIndex: 0,
            "aria-label": ariaLabel,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": Math.round(normalizedPosition * 100),
            "aria-valuetext": valueText,
            "aria-orientation": "horizontal" as const,
          }
        : {
            role: "img",
            "aria-label": `${ariaLabel}, playback position ${valueText}`,
          })}
    >
      <canvas ref={canvasRef} className="block w-full" aria-hidden="true" />
      {normalizedData.length === 0 && (
        <span className="absolute inset-0 flex items-center justify-center text-xs" style={{ color: colors.contentSecondary }}>
          No waveform data
        </span>
      )}
    </div>
  );
};
