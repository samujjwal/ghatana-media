/**
 * AI Voice - Sample List
 * 
 * @doc.type component
 * @doc.purpose Display and manage training samples
 * @doc.layer product
 * @doc.pattern Component
 */

import React from 'react';
import type { TrainingSample } from '../../types';

interface SampleListProps {
  samples: TrainingSample[];
  onRemove: (id: string) => void;
  onPlay: (sample: TrainingSample) => void;
}

export const SampleList: React.FC<SampleListProps> = ({
  samples,
  onRemove,
  onPlay,
}) => {
  if (samples.length === 0) {
    return (
      <div className="text-center py-8 text-gray-400">
        <p>No samples recorded yet</p>
        <p className="text-sm mt-1">Record or upload audio samples to train your voice</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      {samples.map((sample, index) => (
        <div
          key={sample.id}
          className="flex items-center justify-between bg-gray-700 rounded-lg px-4 py-3"
        >
          <div className="flex items-center gap-3">
            <span className="w-8 h-8 rounded-full bg-gray-600 flex items-center justify-center text-sm text-white">
              {index + 1}
            </span>
            <div>
              <div className="text-white text-sm">
                {sample.text || `Sample ${index + 1}`}
              </div>
              <div className="text-xs text-gray-400">
                {sample.duration.toFixed(1)}s
              </div>
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => onPlay(sample)}
              className="p-2 rounded-lg bg-gray-600 text-white hover:bg-gray-500"
              title="Play"
            >
              <svg className="w-4 h-4" fill="currentColor" viewBox="0 0 24 24">
                <path d="M8 5v14l11-7z" />
              </svg>
            </button>
            <button
              onClick={() => onRemove(sample.id)}
              className="p-2 rounded-lg bg-red-600/20 text-red-400 hover:bg-red-600/30"
              title="Remove"
            >
              <svg className="w-4 h-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>
      ))}
    </div>
  );
};
