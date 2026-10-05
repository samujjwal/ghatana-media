/**
 * AI Voice - Phrase Card
 * 
 * @doc.type component
 * @doc.purpose Individual phrase display with conversion controls
 * @doc.layer product
 * @doc.pattern Component
 */

import React from 'react';
import { clsx } from 'clsx';
import type { Phrase, PhraseLabel } from '../../types';

const labelColors: Record<PhraseLabel, string> = {
  verse: 'bg-blue-500',
  chorus: 'bg-purple-500',
  bridge: 'bg-green-500',
  intro: 'bg-yellow-500',
  outro: 'bg-orange-500',
  other: 'bg-gray-500',
};

interface PhraseCardProps {
  phrase: Phrase;
  index: number;
  isSelected: boolean;
  isConverting: boolean;
  onSelect: () => void;
  onConvert: () => void;
  onPlay: () => void;
  onSelectTake: (takeId: string) => void;
}

export const PhraseCard: React.FC<PhraseCardProps> = ({
  phrase,
  index,
  isSelected,
  isConverting,
  onSelect,
  onConvert,
  onPlay,
  onSelectTake,
}) => {
  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  const duration = phrase.endTime - phrase.startTime;
  const hasTakes = phrase.takes && phrase.takes.length > 0;

  return (
    <div
      onClick={onSelect}
      className={clsx(
        'bg-gray-700 rounded-lg p-4 cursor-pointer transition-all',
        isSelected ? 'ring-2 ring-blue-500' : 'hover:bg-gray-650'
      )}
    >
      {/* Header */}
      <div className="flex items-center justify-between mb-3">
        <div className="flex items-center gap-2">
          <span className="text-white font-medium">Phrase {index + 1}</span>
          <span className={clsx('px-2 py-0.5 text-xs rounded', labelColors[phrase.label || 'other'])}>
            {phrase.label || 'other'}
          </span>
        </div>
        <span className="text-sm text-gray-400">
          {duration.toFixed(2)}s
        </span>
      </div>

      {/* Time range */}
      <div className="text-xs text-gray-500 mb-3">
        {formatTime(phrase.startTime)} - {formatTime(phrase.endTime)}
      </div>

      {/* Pitch visualization */}
      {phrase.pitchContour && phrase.pitchContour.length > 0 && (
        <div className="h-8 bg-gray-800 rounded mb-3 flex items-end px-1">
          {phrase.pitchContour.slice(0, 30).map((pitch, i) => (
            <div
              key={i}
              className="flex-1 bg-blue-500 mx-px rounded-t"
              style={{ height: `${Math.min(100, (pitch / 500) * 100)}%` }}
            />
          ))}
        </div>
      )}

      {/* Actions */}
      <div className="flex gap-2">
        <button
          onClick={(e) => { e.stopPropagation(); onPlay(); }}
          className="flex-1 px-3 py-1.5 text-sm rounded bg-gray-600 text-white hover:bg-gray-500"
        >
          Play
        </button>
        <button
          onClick={(e) => { e.stopPropagation(); onConvert(); }}
          disabled={isConverting}
          className="flex-1 px-3 py-1.5 text-sm rounded bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          {isConverting ? 'Converting...' : 'Convert'}
        </button>
      </div>

      {/* Takes */}
      {hasTakes && (
        <div className="mt-3 pt-3 border-t border-gray-600">
          <div className="text-xs text-gray-400 mb-2">
            {phrase.takes!.length} take{phrase.takes!.length > 1 ? 's' : ''}
          </div>
          <div className="flex gap-1 flex-wrap">
            {phrase.takes!.map((take, i) => (
              <button
                key={take.id}
                onClick={(e) => { e.stopPropagation(); onSelectTake(take.id); }}
                className={clsx(
                  'px-2 py-1 text-xs rounded',
                  phrase.selectedTakeId === take.id
                    ? 'bg-green-600 text-white'
                    : 'bg-gray-600 text-gray-300 hover:bg-gray-500'
                )}
              >
                Take {i + 1}
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
};
