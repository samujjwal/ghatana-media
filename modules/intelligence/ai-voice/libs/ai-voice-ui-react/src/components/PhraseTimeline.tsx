/**
 * Accessible timeline view of detected phrases.
 *
 * Phrase selection and playback seeking are separate controls so the composite
 * does not place interactive phrase buttons inside a slider role.
 *
 * @doc.type component
 * @doc.purpose Phrase timeline selection and seek interaction
 * @doc.layer product
 * @doc.pattern CompositeWidget
 */
import React, { useCallback, useId } from "react";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";
import type { Phrase, PhraseLabel } from "../types";

export interface PhraseTimelineProps {
  readonly phrases: readonly Phrase[];
  readonly duration: number;
  readonly currentTime?: number;
  readonly selectedPhraseId?: string;
  readonly onPhraseClick?: (phrase: Phrase) => void;
  readonly onSeek?: (time: number) => void;
  readonly height?: number;
  readonly ariaLabel?: string;
  readonly className?: string;
}

const labelStyles: Record<PhraseLabel, string> = {
  verse: "bg-blue-600 text-white",
  chorus: "bg-purple-600 text-white",
  bridge: "bg-green-700 text-white",
  intro: "bg-yellow-400 text-gray-950",
  outro: "bg-orange-600 text-white",
  other: "bg-gray-600 text-white",
};

const labels: readonly PhraseLabel[] = [
  "intro",
  "verse",
  "chorus",
  "bridge",
  "outro",
  "other",
];

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value));
}

function formatTime(seconds: number): string {
  const safe = Math.max(0, Number.isFinite(seconds) ? seconds : 0);
  const minutes = Math.floor(safe / 60);
  const remaining = Math.floor(safe % 60);
  return `${minutes}:${remaining.toString().padStart(2, "0")}`;
}

export const PhraseTimeline: React.FC<PhraseTimelineProps> = ({
  phrases,
  duration,
  currentTime = 0,
  selectedPhraseId,
  onPhraseClick,
  onSeek,
  height = 84,
  ariaLabel = "Detected phrase timeline",
  className,
}) => {
  const descriptionId = useId();
  const seekId = useId();
  const safeDuration = Math.max(0, duration);
  const safeCurrentTime = clamp(currentTime, 0, safeDuration || 0);

  const seek = useCallback(
    (time: number): void => {
      if (safeDuration <= 0) return;
      onSeek?.(clamp(time, 0, safeDuration));
    },
    [onSeek, safeDuration],
  );

  const handleTimelineClick = useCallback(
    (event: React.MouseEvent<HTMLDivElement>): void => {
      if (!onSeek || safeDuration <= 0) return;
      const rect = event.currentTarget.getBoundingClientRect();
      if (rect.width <= 0) return;
      seek(((event.clientX - rect.left) / rect.width) * safeDuration);
    },
    [onSeek, safeDuration, seek],
  );

  return (
    <section
      className={twMerge("space-y-3", className)}
      aria-label={ariaLabel}
      aria-describedby={descriptionId}
    >
      <p id={descriptionId} className="sr-only">
        Tab to individual phrases and press Enter or Space to select them. Use
        the playback-position slider to seek with the keyboard.
      </p>
      <div
        className={clsx(
          "relative overflow-hidden rounded-lg border border-gray-700 bg-gray-900",
          onSeek && "cursor-pointer",
        )}
        style={{ minHeight: Math.max(64, height) }}
        onClick={handleTimelineClick}
        role="group"
        aria-label={`${ariaLabel} phrases`}
      >
        <ol className="absolute inset-x-0 top-2 bottom-5 m-0 list-none p-0">
          {phrases.map((phrase) => {
            const start = clamp(phrase.startTime, 0, safeDuration);
            const end = clamp(phrase.endTime, start, safeDuration);
            const left = safeDuration > 0 ? (start / safeDuration) * 100 : 0;
            const width =
              safeDuration > 0 ? ((end - start) / safeDuration) * 100 : 0;
            const selected = phrase.id === selectedPhraseId;
            const label = phrase.label ?? "other";
            const takeCount = phrase.takes?.length ?? 0;
            const accessibleLabel = `${label} from ${formatTime(start)} to ${formatTime(end)}${phrase.text ? `, ${phrase.text}` : ""}${takeCount ? `, ${takeCount} takes` : ""}`;
            return (
              <li
                key={phrase.id}
                className="absolute top-0 bottom-0"
                style={{
                  left: `${left}%`,
                  width: `${Math.max(width, 0.5)}%`,
                }}
              >
                <button
                  type="button"
                  onClick={(event) => {
                    event.stopPropagation();
                    onPhraseClick?.(phrase);
                  }}
                  disabled={!onPhraseClick}
                  aria-label={accessibleLabel}
                  aria-pressed={selected}
                  className={clsx(
                    "h-full w-full min-w-1 overflow-hidden rounded border-2 px-1 text-left text-[10px] font-medium transition",
                    labelStyles[label],
                    selected
                      ? "border-white ring-2 ring-white ring-offset-1 ring-offset-gray-900"
                      : "border-transparent opacity-80 hover:opacity-100 focus:opacity-100",
                    takeCount > 0 && "border-b-green-300",
                    !onPhraseClick && "cursor-default",
                  )}
                  title={accessibleLabel}
                >
                  <span className="truncate" aria-hidden="true">
                    {label}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>

        {safeDuration > 0 && (
          <div
            className="pointer-events-none absolute inset-y-0 w-0.5 bg-white shadow"
            style={{ left: `${(safeCurrentTime / safeDuration) * 100}%` }}
            aria-hidden="true"
          />
        )}

        <div
          className="absolute inset-x-0 bottom-0 flex h-5 justify-between px-2 text-xs text-gray-400"
          aria-hidden="true"
        >
          <span>0:00</span>
          <span>{formatTime(safeDuration)}</span>
        </div>
      </div>

      {onSeek && safeDuration > 0 && (
        <label htmlFor={seekId} className="grid gap-1 text-xs text-gray-400">
          <span className="flex justify-between gap-3">
            <span>Playback position</span>
            <output htmlFor={seekId}>
              {formatTime(safeCurrentTime)} / {formatTime(safeDuration)}
            </output>
          </span>
          <input
            id={seekId}
            type="range"
            min={0}
            max={safeDuration}
            step={Math.max(0.05, safeDuration / 1_000)}
            value={safeCurrentTime}
            onChange={(event) => seek(Number.parseFloat(event.target.value))}
            className="min-h-11 w-full cursor-pointer accent-blue-500"
            aria-valuetext={`${formatTime(safeCurrentTime)} of ${formatTime(safeDuration)}`}
          />
        </label>
      )}

      <ul
        className="flex flex-wrap gap-3 text-xs text-gray-400"
        aria-label="Phrase labels"
      >
        {labels.map((label) => (
          <li key={label} className="flex items-center gap-1.5 capitalize">
            <span
              className={clsx("h-3 w-3 rounded-sm", labelStyles[label])}
              aria-hidden="true"
            />
            {label}
          </li>
        ))}
      </ul>
    </section>
  );
};
