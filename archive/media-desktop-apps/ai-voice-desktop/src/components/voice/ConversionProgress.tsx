/**
 * AI Voice - Conversion Progress
 * 
 * @doc.type component
 * @doc.purpose Batch conversion progress indicator
 * @doc.layer product
 * @doc.pattern Component
 */

import React from 'react';

interface ConversionProgressProps {
  isConverting: boolean;
  progress: number;
  currentPhrase: number;
  totalPhrases: number;
  onCancel: () => void;
}

export const ConversionProgress: React.FC<ConversionProgressProps> = ({
  isConverting,
  progress,
  currentPhrase,
  totalPhrases,
  onCancel,
}) => {
  if (!isConverting) return null;

  return (
    <div className="bg-blue-600/20 border border-blue-600 rounded-lg p-4">
      <div className="flex items-center justify-between mb-2">
        <span className="text-blue-400 font-medium">
          Converting phrases...
        </span>
        <button
          onClick={onCancel}
          className="text-sm text-blue-300 hover:text-white"
        >
          Cancel
        </button>
      </div>
      
      <div className="flex items-center gap-3">
        <div className="flex-1 h-2 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all duration-300"
            style={{ width: `${progress}%` }}
          />
        </div>
        <span className="text-sm text-gray-400">
          {currentPhrase}/{totalPhrases}
        </span>
      </div>
    </div>
  );
};
