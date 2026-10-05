/**
 * AI Voice - Sample Recorder
 * 
 * @doc.type component
 * @doc.purpose Record training samples with guided prompts
 * @doc.layer product
 * @doc.pattern Component
 */

import React, { useState, useCallback } from 'react';
import { clsx } from 'clsx';

const TRAINING_PROMPTS = [
  "The quick brown fox jumps over the lazy dog.",
  "She sells seashells by the seashore.",
  "Peter Piper picked a peck of pickled peppers.",
  "How much wood would a woodchuck chuck?",
  "A proper copper coffee pot.",
  "Red lorry, yellow lorry.",
  "The rain in Spain stays mainly in the plain.",
  "Betty Botter bought some butter.",
];

interface SampleRecorderProps {
  onRecordingComplete: (path: string, duration: number, text: string) => void;
  onStartRecording: () => Promise<void>;
  onStopRecording: () => Promise<{ path: string; duration: number }>;
}

export const SampleRecorder: React.FC<SampleRecorderProps> = ({
  onRecordingComplete,
  onStartRecording,
  onStopRecording,
}) => {
  const [currentPromptIndex, setCurrentPromptIndex] = useState(0);
  const [isRecording, setIsRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const currentPrompt = TRAINING_PROMPTS[currentPromptIndex];

  const handleStartRecording = useCallback(async () => {
    setError(null);
    try {
      await onStartRecording();
      setIsRecording(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start recording');
    }
  }, [onStartRecording]);

  const handleStopRecording = useCallback(async () => {
    try {
      const result = await onStopRecording();
      setIsRecording(false);
      onRecordingComplete(result.path, result.duration, currentPrompt);
      
      // Move to next prompt
      if (currentPromptIndex < TRAINING_PROMPTS.length - 1) {
        setCurrentPromptIndex(prev => prev + 1);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop recording');
      setIsRecording(false);
    }
  }, [onStopRecording, onRecordingComplete, currentPrompt, currentPromptIndex]);

  const handleSkipPrompt = useCallback(() => {
    if (currentPromptIndex < TRAINING_PROMPTS.length - 1) {
      setCurrentPromptIndex(prev => prev + 1);
    }
  }, [currentPromptIndex]);

  return (
    <div className="bg-gray-800 rounded-lg p-6">
      <h3 className="text-lg font-medium text-white mb-4">
        Record Sample ({currentPromptIndex + 1}/{TRAINING_PROMPTS.length})
      </h3>

      {error && (
        <div className="bg-red-600/20 border border-red-600 rounded-lg p-3 mb-4">
          <p className="text-sm text-red-400">{error}</p>
        </div>
      )}

      {/* Prompt display */}
      <div className="bg-gray-900 rounded-lg p-6 mb-6">
        <p className="text-xl text-white text-center leading-relaxed">
          "{currentPrompt}"
        </p>
      </div>

      {/* Recording controls */}
      <div className="flex flex-col items-center gap-4">
        <button
          onMouseDown={handleStartRecording}
          onMouseUp={handleStopRecording}
          onMouseLeave={() => isRecording && handleStopRecording()}
          onTouchStart={handleStartRecording}
          onTouchEnd={handleStopRecording}
          className={clsx(
            'w-20 h-20 rounded-full flex items-center justify-center transition-all',
            isRecording
              ? 'bg-red-600 animate-pulse scale-110'
              : 'bg-blue-600 hover:bg-blue-700 hover:scale-105'
          )}
        >
          <svg className="w-10 h-10 text-white" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
            <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
          </svg>
        </button>

        <p className="text-sm text-gray-400">
          {isRecording ? 'Recording... Release to stop' : 'Hold to record'}
        </p>

        <button
          onClick={handleSkipPrompt}
          disabled={currentPromptIndex >= TRAINING_PROMPTS.length - 1}
          className="text-sm text-gray-400 hover:text-white disabled:opacity-50"
        >
          Skip this prompt
        </button>
      </div>

      {/* Progress */}
      <div className="mt-6">
        <div className="flex justify-between text-xs text-gray-500 mb-1">
          <span>Progress</span>
          <span>{currentPromptIndex}/{TRAINING_PROMPTS.length}</span>
        </div>
        <div className="h-1 bg-gray-700 rounded-full overflow-hidden">
          <div
            className="h-full bg-blue-500 transition-all"
            style={{ width: `${(currentPromptIndex / TRAINING_PROMPTS.length) * 100}%` }}
          />
        </div>
      </div>
    </div>
  );
};
