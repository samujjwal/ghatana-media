/**
 * Accessible individual stem track with mute, solo, waveform, volume, and pan.
 *
 * @doc.type component
 * @doc.purpose Stem track display and mixer controls
 * @doc.layer product
 * @doc.pattern Component
 */
import { Button } from "@ghatana/design-system";
import React, { useId } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Stem, StemType } from "../types";
import { Waveform } from "./Waveform";
import { useSemanticColors } from "./useSemanticColors";

export interface StemTrackProps {
  readonly stem: Stem;
  readonly position?: number;
  readonly onSeek?: (position: number) => void;
  readonly onVolumeChange?: (volume: number) => void;
  readonly onPanChange?: (pan: number) => void;
  readonly onMuteToggle?: () => void;
  readonly onSoloToggle?: () => void;
  readonly disabled?: boolean;
  readonly className?: string;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

export const StemTrack: React.FC<StemTrackProps> = ({
  stem,
  position = 0,
  onSeek,
  onVolumeChange,
  onPanChange,
  onMuteToggle,
  onSoloToggle,
  disabled = false,
  className,
}) => {
  const colors = useSemanticColors();
  const controlsId = useId();
  const displayName = stem.name || stem.type;
  const color = colors.action;
  const volume = clamp(stem.volume, 0, 1);
  const pan = clamp(stem.pan, -1, 1);

  return (
    <section
      aria-labelledby={`${controlsId}-title`}
      className={twMerge(
        clsx(
          "rounded-lg border p-3",
          disabled && "opacity-60",
        ),
        className,
      )}
      style={{ borderColor: colors.border, backgroundColor: colors.surface, color: colors.content }}
    >
      <div className="grid items-center gap-3 lg:grid-cols-[minmax(8rem,12rem)_1fr_minmax(14rem,18rem)]">
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex shrink-0 gap-2" role="group" aria-label={`${displayName} channel state`}>
            <Button
              variant={stem.muted ? "solid" : "soft"}
              tone={stem.muted ? "danger" : "neutral"}
              size="sm"
              onClick={onMuteToggle}
              disabled={disabled || !onMuteToggle}
              aria-pressed={stem.muted}
              aria-label={`${stem.muted ? "Unmute" : "Mute"} ${displayName}`}
              title={`${stem.muted ? "Unmute" : "Mute"} ${displayName}`}
            >
              Mute
            </Button>
            <Button
              variant={stem.solo ? "solid" : "soft"}
              tone={stem.solo ? "warning" : "neutral"}
              size="sm"
              onClick={onSoloToggle}
              disabled={disabled || !onSoloToggle}
              aria-pressed={stem.solo}
              aria-label={`${stem.solo ? "Disable solo for" : "Solo"} ${displayName}`}
              title={`${stem.solo ? "Disable solo for" : "Solo"} ${displayName}`}
            >
              Solo
            </Button>
          </div>
          <h3
            id={`${controlsId}-title`}
            className="min-w-0 truncate text-sm font-medium capitalize"
          >
            {displayName}
          </h3>
        </div>

        <div className="min-w-0">
          {stem.waveformData?.length ? (
            <Waveform
              data={stem.waveformData}
              position={position}
              duration={stem.duration}
              color={stem.muted ? colors.contentDisabled : color}
              progressColor={stem.muted ? colors.contentDisabled : colors.focus}
              height={44}
              onSeek={onSeek}
              ariaLabel={`${displayName} waveform`}
            />
          ) : (
            <div
              className="flex min-h-11 items-center justify-center rounded border border-dashed text-xs"
              role="img"
              aria-label={`${displayName} waveform is not available`}
              style={{ borderColor: colors.border, color: colors.contentSecondary }}
            >
              Waveform unavailable
            </div>
          )}
        </div>

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1 xl:grid-cols-2">
          <label className="grid gap-1 text-xs" style={{ color: colors.contentSecondary }}>
            <span className="flex justify-between gap-2">
              <span>Volume</span>
              <output htmlFor={`${controlsId}-volume`}>
                {Math.round(volume * 100)}%
              </output>
            </span>
            <input
              id={`${controlsId}-volume`}
              type="range"
              min="0"
              max="1"
              step="0.01"
              value={volume}
              onChange={(event) =>
                onVolumeChange?.(Number.parseFloat(event.target.value))
              }
              disabled={disabled || !onVolumeChange}
              className="min-h-11 w-full cursor-pointer"
              style={{ accentColor: colors.focus }}
              aria-valuetext={`${Math.round(volume * 100)} percent`}
            />
          </label>

          <label className="grid gap-1 text-xs" style={{ color: colors.contentSecondary }}>
            <span className="flex justify-between gap-2">
              <span>Pan</span>
              <output htmlFor={`${controlsId}-pan`}>
                {pan === 0
                  ? "Center"
                  : pan < 0
                    ? `${Math.round(Math.abs(pan) * 100)}% left`
                    : `${Math.round(pan * 100)}% right`}
              </output>
            </span>
            <input
              id={`${controlsId}-pan`}
              type="range"
              min="-1"
              max="1"
              step="0.01"
              value={pan}
              onChange={(event) =>
                onPanChange?.(Number.parseFloat(event.target.value))
              }
              disabled={disabled || !onPanChange}
              className="min-h-11 w-full cursor-pointer"
              style={{ accentColor: colors.focus }}
              aria-valuetext={
                pan === 0
                  ? "center"
                  : pan < 0
                    ? `${Math.round(Math.abs(pan) * 100)} percent left`
                    : `${Math.round(pan * 100)} percent right`
              }
            />
          </label>
        </div>
      </div>
    </section>
  );
};
