/**
 * AI Voice - Master Channel
 * 
 * @doc.type component
 * @doc.purpose Master output channel with volume control
 * @doc.layer product
 * @doc.pattern Component
 */

import React from 'react';

interface MasterChannelProps {
  volume: number;
  onVolumeChange: (volume: number) => void;
}

export const MasterChannel: React.FC<MasterChannelProps> = ({
  volume,
  onVolumeChange,
}) => {
  return (
    <div className="flex-shrink-0 w-24 bg-gray-800 rounded-lg p-3 flex flex-col items-center border-l-2 border-gray-700 ml-2">
      {/* Spacer for alignment */}
      <div className="h-14 mb-3" />

      {/* Fader */}
      <div className="flex-1 flex flex-col items-center mb-3">
        <div className="h-40 w-4 bg-gray-700 rounded-full relative">
          <div
            className="absolute bottom-0 w-full rounded-full bg-white transition-all"
            style={{ height: `${(volume / 1.5) * 100}%` }}
          />
          <input
            type="range"
            min="0"
            max="1.5"
            step="0.01"
            value={volume}
            onChange={(e) => onVolumeChange(parseFloat(e.target.value))}
            className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
          />
        </div>
        <div className="text-xs text-gray-400 mt-2">
          {volume === 0 ? '-∞' : `${Math.round((volume - 1) * 100)}%`}
        </div>
      </div>

      {/* Label */}
      <div className="text-sm font-bold text-white">MASTER</div>
    </div>
  );
};
