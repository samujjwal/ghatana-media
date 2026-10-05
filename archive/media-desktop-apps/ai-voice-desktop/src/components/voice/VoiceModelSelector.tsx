/**
 * AI Voice - Voice Model Selector
 * 
 * @doc.type component
 * @doc.purpose Select active voice model for conversion
 * @doc.layer product
 * @doc.pattern Component
 */

import React from 'react';
import { clsx } from 'clsx';
import type { VoiceModel } from '../../types';

function formatVoiceQuality(model: VoiceModel): string {
  if (typeof model.quality !== 'number') {
    return 'Pending analysis';
  }

  return `${Math.round(model.quality * 100)}%`;
}

interface VoiceModelSelectorProps {
  models: VoiceModel[];
  selectedModelId: string | null;
  onSelect: (model: VoiceModel) => void;
  onManageModels: () => void;
}

export const VoiceModelSelector: React.FC<VoiceModelSelectorProps> = ({
  models,
  selectedModelId,
  onSelect,
  onManageModels,
}) => {
  return (
    <div className="bg-gray-800 rounded-lg p-4">
      <div className="flex items-center justify-between mb-3">
        <h3 className="text-sm font-medium text-gray-300">Voice Model</h3>
        <button
          onClick={onManageModels}
          className="text-xs text-blue-400 hover:text-blue-300"
        >
          Manage
        </button>
      </div>

      {models.length === 0 ? (
        <div className="text-center py-4">
          <p className="text-gray-400 text-sm mb-2">No voice models</p>
          <button
            onClick={onManageModels}
            className="text-sm text-blue-400 hover:text-blue-300"
          >
            Train a model
          </button>
        </div>
      ) : (
        <div className="space-y-2">
          {models.slice(0, 5).map((model) => (
            <button
              key={model.id}
              onClick={() => onSelect(model)}
              className={clsx(
                'w-full text-left px-3 py-2 rounded-lg transition-all',
                model.id === selectedModelId
                  ? 'bg-blue-600 text-white'
                  : 'bg-gray-700 text-gray-300 hover:bg-gray-600'
              )}
            >
              <div className="font-medium text-sm">{model.name}</div>
              <div className="text-xs opacity-70">
                Quality: {formatVoiceQuality(model)}
              </div>
            </button>
          ))}
          {models.length > 5 && (
            <button
              onClick={onManageModels}
              className="w-full text-center text-sm text-gray-400 hover:text-white py-1"
            >
              +{models.length - 5} more
            </button>
          )}
        </div>
      )}
    </div>
  );
};
