/**
 * AI Voice - Training Config
 * 
 * @doc.type component
 * @doc.purpose Training configuration form
 * @doc.layer product
 * @doc.pattern Component
 */

import React from 'react';

interface TrainingConfigProps {
  modelName: string;
  epochs: number;
  onModelNameChange: (name: string) => void;
  onEpochsChange: (epochs: number) => void;
}

export const TrainingConfig: React.FC<TrainingConfigProps> = ({
  modelName,
  epochs,
  onModelNameChange,
  onEpochsChange,
}) => {
  return (
    <div className="bg-gray-800 rounded-lg p-4 space-y-4">
      <h3 className="text-lg font-medium text-white">Training Configuration</h3>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Model Name
        </label>
        <input
          type="text"
          value={modelName}
          onChange={(e) => onModelNameChange(e.target.value)}
          placeholder="My Voice"
          className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      <div>
        <label className="block text-sm font-medium text-gray-300 mb-2">
          Training Epochs
        </label>
        <div className="flex items-center gap-3">
          <input
            type="range"
            min="50"
            max="500"
            step="50"
            value={epochs}
            onChange={(e) => onEpochsChange(parseInt(e.target.value))}
            className="flex-1 h-2 bg-gray-700 rounded-lg appearance-none cursor-pointer"
          />
          <span className="w-12 text-right text-white">{epochs}</span>
        </div>
        <p className="text-xs text-gray-500 mt-1">
          More epochs = better quality but longer training time
        </p>
      </div>
    </div>
  );
};
