/**
 * AI Voice - Channel Strip
 * 
 * @doc.type component
 * @doc.purpose Individual mixer channel with fader and controls
 * @doc.layer product
 * @doc.pattern Component
 */

import React from 'react';
import { clsx } from 'clsx';

interface ChannelStripProps {
  name: string;
  color: string;
  volume: number;
  pan: number;
  muted: boolean;
  solo: boolean;
  onVolumeChange: (volume: number) => void;
  onPanChange: (pan: number) => void;
  onMuteToggle: () => void;
  onSoloToggle: () => void;
}

export const ChannelStrip: React.FC<ChannelStripProps> = ({
  name,
  color,
  volume,
  pan,
  muted,
  solo,
  onVolumeChange,
  onPanChange,
  onMuteToggle,
  onSoloToggle,
}) => {
  return (
    <div className="flex-shrink-0 w-20 bg-gray-800 rounded-lg p-3 flex flex-col items-center">
      {/* Mute/Solo buttons */}
      <div className="flex gap-1 mb-3">
        <button
          onClick={onMuteToggle}
          className={clsx(
            'w-7 h-7 rounded text-xs font-bold transition-all',
            muted ? 'bg-red-600 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
          )}
        >
          M
        </button>
        <button
          onClick={onSoloToggle}
          className={clsx(
            'w-7 h-7 rounded text-xs font-bold transition-all',
            solo ? 'bg-yellow-600 text-white' : 'bg-gray-700 text-gray-400 hover:bg-gray-600'
          )}
        >
          S
        </button>
      </div>

      {/* Pan knob */}
      <div className="mb-3 text-center">
        <div className="text-xs text-gray-500 mb-1">Pan</div>
        <input
          type="range"
          min="-1"
          max="1"
          step="0.1"
          value={pan}
          onChange={(e) => onPanChange(parseFloat(e.target.value))}
          className="w-14 h-1 bg-gray-700 rounded appearance-none cursor-pointer"
        />
        <div className="text-xs text-gray-400">
          {pan === 0 ? 'C' : pan < 0 ? `L${Math.abs(Math.round(pan * 100))}` : `R${Math.round(pan * 100)}`}
        </div>
      </div>

      {/* Fader */}
      <div className="flex-1 flex flex-col items-center mb-3">
        <div className="h-40 w-3 bg-gray-700 rounded-full relative">
          <div
            className="absolute bottom-0 w-full rounded-full transition-all"
            style={{ 
              height: `${volume * 100}%`,
              backgroundColor: muted ? '#6b7280' : color 
            }}
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

      {/* Channel name */}
      <div 
        className="text-sm font-medium text-white truncate w-full text-center px-1"
        style={{ color: muted ? '#9ca3af' : color }}
      >
        {name}
      </div>
    </div>
  );
};
