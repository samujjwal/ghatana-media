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
  const positionAvailable = Number.isFinite(position);
  const normalizedPosition = positionAvailable ? clamp(position) : 0;
  const normalizedHeight = Number.isFinite(height) ? Math.max(24, height) : 80;
  const canSeek = Boolean(onSeek && positionAvailable);
  const dataAvailable = useMemo(() => data.every(Number.isFinite), [data]);

  const normalizedData = useMemo(() => {
    if (!dataAvailable || data.length === 0) return [];
    const maximum = data.reduce(
      (current, value) => Math.max(current, Math.abs(value)),
      0,
    );
    return maximum > 0 ? data.map((value) => value / maximum) : [...data];
  }, [data, dataAvailable]);

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

    if (!dataAvailable || normalizedData.length === 0) return;
    const sampleWidth = width / normalizedData.length;
    const centerY = normalizedHeight / 2;
    const progressX = normalizedPosition * width;

    if (variant === "bars") {
      normalizedData.forEach((value, index) => {
        const x = index * sampleWidth;
        const barHeight = Math.max(1, Math.abs(value) * normalizedHeight * 0.8);
        context.fillStyle = positionAvailable && x < progressX ? effectiveProgressColor : effectiveColor;
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
      if (positionAvailable && normalizedPosition > 0) {
        context.save();
        context.beginPath();
        context.rect(0, 0, progressX, normalizedHeight);
        context.clip();
        context.strokeStyle = effectiveProgressColor;
        context.stroke();
        context.restore();
      }
    }

    if (positionAvailable) {
      context.fillStyle = effectivePlayheadColor;
      context.fillRect(Math.max(0, progressX - 1), 0, 2, normalizedHeight);
    }
  }, [
    dataAvailable,
    effectiveBackgroundColor,
    effectiveColor,
    effectivePlayheadColor,
    normalizedData,
    normalizedHeight,
    normalizedPosition,
    positionAvailable,
    effectiveProgressColor,
    variant,
    width,
  ]);

  const seek = useCallback(
    (nextPosition: number): void => {
      if (Number.isFinite(nextPosition)) onSeek?.(clamp(nextPosition));
    },
    [onSeek],
  );

  const handleClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (!canSeek || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      if (rect.width <= 0) return;
      seek((event.clientX - rect.left) / rect.width);
    },
    [canSeek, seek],
  );

  const handleKeyDown = useCallback(
    (event: React.KeyboardEvent<HTMLDivElement>): void => {
      if (!canSeek) return;
      let next: number | undefined;
      if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
        if (!Number.isFinite(seekStep)) return;
        next = normalizedPosition - seekStep;
      } else if (event.key === "ArrowRight" || event.key === "ArrowUp") {
        if (!Number.isFinite(seekStep)) return;
        next = normalizedPosition + seekStep;
      } else if (event.key === "PageDown") {
        if (!Number.isFinite(seekStep)) return;
        next = normalizedPosition - seekStep * 10;
      } else if (event.key === "PageUp") {
        if (!Number.isFinite(seekStep)) return;
        next = normalizedPosition + seekStep * 10;
      } else if (event.key === "Home") {
        next = 0;
      } else if (event.key === "End") {
        next = 1;
      }
      if (next === undefined || !Number.isFinite(next)) return;
      event.preventDefault();
      seek(next);
    },
    [canSeek, normalizedPosition, seek, seekStep],
  );

  const valueText = !positionAvailable
    ? "unavailable"
    : typeof duration === "number" && Number.isFinite(duration) && duration > 0
      ? `${formatTime(normalizedPosition * duration)} of ${formatTime(duration)}`
      : `${Math.round(normalizedPosition * 100)} percent`;
  const unavailableMessage = !positionAvailable && !dataAvailable
    ? "Waveform and playback position unavailable"
    : !positionAvailable
      ? "Playback position unavailable"
      : !dataAvailable
        ? "Waveform unavailable"
        : data.length === 0
          ? "No waveform data"
          : undefined;
  const waveformStateLabel = !dataAvailable
    ? "waveform unavailable"
    : data.length === 0
      ? "no waveform data"
      : undefined;
  const imageLabel = waveformStateLabel
    ? `${ariaLabel}, ${waveformStateLabel}, playback position ${valueText}`
    : `${ariaLabel}, playback position ${valueText}`;
  const sliderLabel = waveformStateLabel ? `${ariaLabel}, ${waveformStateLabel}` : ariaLabel;

  return (
    <div
      ref={containerRef}
      className={twMerge(
        clsx(
          "relative w-full overflow-hidden rounded-lg",
          canSeek && "cursor-pointer focus-visible:outline-none focus-visible:ring-2",
        ),
        className,
      )}
      style={{ minHeight: normalizedHeight, "--tw-ring-color": colors.focus } as React.CSSProperties}
      onClick={handleClick}
      onKeyDown={handleKeyDown}
      {...(canSeek
        ? {
            role: "slider",
            tabIndex: 0,
            "aria-label": sliderLabel,
            "aria-valuemin": 0,
            "aria-valuemax": 100,
            "aria-valuenow": Math.round(normalizedPosition * 100),
            "aria-valuetext": valueText,
            "aria-orientation": "horizontal" as const,
          }
        : {
            role: "img",
            "aria-label": imageLabel,
          })}
    >
      <canvas ref={canvasRef} className="block w-full" aria-hidden="true" />
      {unavailableMessage && (
        <span className="absolute inset-0 flex items-center justify-center text-xs" style={{ color: colors.contentSecondary }}>
          {unavailableMessage}
        </span>
      )}
    </div>
  );
};
