/**
 * AI Voice Production Studio - Mixer View
 * 
 * @doc.type component
 * @doc.purpose Professional mixing interface
 * @doc.layer product
 * @doc.pattern Component
 */

import React, { useCallback, useMemo } from 'react';
import { useProject } from '../../context/ProjectContext';

export const MixerView: React.FC = () => {
  const { state, setMixer, setStems } = useProject();

  const colorClass = useMemo(
    () => ({
      blue: 'bg-blue-500',
      green: 'bg-green-500',
      yellow: 'bg-yellow-500',
      purple: 'bg-purple-500',
    }),
    []
  );

  const handleMasterVolumeChange = useCallback((value: number) => {
    setMixer({ masterVolume: value });
  }, [setMixer]);

  const updateStem = useCallback(
    (stemKey: 'vocals' | 'drums' | 'bass' | 'other', updates: { muted?: boolean; solo?: boolean; volume?: number }) => {
      const stems = state.project?.stems;
      if (!stems) return;
      setStems({
        ...stems,
        [stemKey]: {
          ...stems[stemKey],
          ...updates,
        },
      });
    },
    [setStems, state.project?.stems]
  );

  if (!state.project?.stems) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-800 flex items-center justify-center">
            <svg className="w-8 h-8 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6V4m0 2a2 2 0 100 4m0-4a2 2 0 110 4m-6 8a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4m6 6v10m6-2a2 2 0 100-4m0 4a2 2 0 110-4m0 4v2m0-6V4" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-white mb-2">No Stems Available</h3>
          <p className="text-gray-400">Separate your audio into stems first</p>
        </div>
      </div>
    );
  }

  const stems = [
    { key: 'vocals', name: 'Vocals', color: 'blue', data: state.project.stems.vocals },
    { key: 'drums', name: 'Drums', color: 'green', data: state.project.stems.drums },
    { key: 'bass', name: 'Bass', color: 'yellow', data: state.project.stems.bass },
    { key: 'other', name: 'Other', color: 'purple', data: state.project.stems.other },
  ];

  return (
    <div className="flex-1 flex flex-col p-6 overflow-hidden">
      <h2 className="text-2xl font-bold text-white mb-6">Mixer</h2>

      <div className="flex-1 flex gap-4 overflow-x-auto pb-4">
        {/* Stem channels */}
        {stems.map((stem) => (
          <div
            key={stem.key}
            className="flex-shrink-0 w-24 bg-gray-800 rounded-lg p-4 flex flex-col items-center"
          >
            {/* Mute/Solo */}
            <div className="flex gap-1 mb-4">
              <button
                onClick={() => updateStem(stem.key as any, { muted: !stem.data.muted })}
                className={`px-2 py-1 text-xs rounded ${
                  stem.data.muted ? 'bg-red-600 text-white' : 'bg-gray-700 text-gray-400'
                }`}
              >
                M
              </button>
              <button
                onClick={() => updateStem(stem.key as any, { solo: !stem.data.solo })}
                className={`px-2 py-1 text-xs rounded ${
                  stem.data.solo ? 'bg-yellow-600 text-white' : 'bg-gray-700 text-gray-400'
                }`}
              >
                S
              </button>
            </div>

            {/* Fader */}
            <div className="flex-1 flex flex-col items-center">
              <div className="h-48 w-2 bg-gray-700 rounded-full relative">
                <div
                  className={`absolute bottom-0 w-full rounded-full ${
                    colorClass[stem.color as keyof typeof colorClass] || 'bg-blue-500'
                  }`}
                  style={{ height: `${stem.data.volume * 100}%` }}
                />
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={stem.data.volume}
                  onChange={(e) => updateStem(stem.key as any, { volume: parseFloat(e.target.value) })}
                  className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                  style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
                />
              </div>
              <span className="text-xs text-gray-400 mt-2">
                {Math.round(stem.data.volume * 100)}%
              </span>
            </div>

            {/* Label */}
            <span className="text-sm font-medium text-white mt-4">{stem.name}</span>
          </div>
        ))}

        {/* Master channel */}
        <div className="flex-shrink-0 w-24 bg-gray-800 rounded-lg p-4 flex flex-col items-center border-l-2 border-gray-700 ml-4 pl-8">
          <div className="flex gap-1 mb-4 invisible">
            <button className="px-2 py-1 text-xs rounded bg-gray-700">M</button>
            <button className="px-2 py-1 text-xs rounded bg-gray-700">S</button>
          </div>

          <div className="flex-1 flex flex-col items-center">
            <div className="h-48 w-2 bg-gray-700 rounded-full relative">
              <div
                className="absolute bottom-0 w-full rounded-full bg-white"
                style={{ height: `${state.mixer.masterVolume * 100}%` }}
              />
              <input
                type="range"
                min="0"
                max="1"
                step="0.01"
                value={state.mixer.masterVolume}
                onChange={(e) => handleMasterVolumeChange(parseFloat(e.target.value))}
                className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
                style={{ writingMode: 'vertical-lr', direction: 'rtl' }}
              />
            </div>
            <span className="text-xs text-gray-400 mt-2">
              {Math.round(state.mixer.masterVolume * 100)}%
            </span>
          </div>

          <span className="text-sm font-medium text-white mt-4">Master</span>
        </div>
      </div>
    </div>
  );
};
