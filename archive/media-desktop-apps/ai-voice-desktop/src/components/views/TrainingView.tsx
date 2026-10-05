/**
 * AI Voice Production Studio - Training View
 * 
 * @doc.type component
 * @doc.purpose Voice model training interface
 * @doc.layer product
 * @doc.pattern Component
 */

import React, { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import type { TrainingSample, TrainingSession, TrainingStatus } from '../../types';

const TRAINING_PHRASES = [
  "The quick brown fox jumps over the lazy dog.",
  "She sells seashells by the seashore.",
  "Peter Piper picked a peck of pickled peppers.",
  "How much wood would a woodchuck chuck if a woodchuck could chuck wood?",
  "A proper copper coffee pot.",
  "Red lorry, yellow lorry, red lorry, yellow lorry.",
  "The rain in Spain stays mainly in the plain.",
  "Betty Botter bought some butter.",
];

export const TrainingView: React.FC = () => {
  const [modelName, setModelName] = useState('');
  const [samples, setSamples] = useState<TrainingSample[]>([]);
  const [recording, setRecording] = useState(false);
  const [currentPhraseIndex, setCurrentPhraseIndex] = useState(0);
  const [session, setSession] = useState<TrainingSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [playingSampleId, setPlayingSampleId] = useState<string | null>(null);

  const handleAddSamples = useCallback(async () => {
    try {
      const selected = await open({
        multiple: true,
        filters: [
          { name: 'Audio', extensions: ['wav', 'mp3', 'flac'] },
        ],
      });

      if (selected && Array.isArray(selected)) {
        const newSamples = await Promise.all(
          selected.map(async (path) => {
            const info = await invoke<{ duration: number }>('ai_voice_get_audio_info', { path });
            return {
              id: crypto.randomUUID(),
              path,
              duration: info.duration,
              quality: 1.0,
            };
          })
        );
        setSamples((prev) => [...prev, ...newSamples]);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to add samples');
    }
  }, []);

  const handleStartRecording = useCallback(async () => {
    try {
      setRecording(true);
      await invoke('ai_voice_start_recording');
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start recording');
      setRecording(false);
    }
  }, []);

  const handleStopRecording = useCallback(async () => {
    try {
      const result = await invoke<{ path: string; duration: number }>('ai_voice_stop_recording');
      const newSample: TrainingSample = {
        id: crypto.randomUUID(),
        path: result.path,
        duration: result.duration,
        text: TRAINING_PHRASES[currentPhraseIndex],
        quality: 1.0,
      };
      setSamples((prev) => [newSample, ...prev]);
      setCurrentPhraseIndex((prev) => Math.min(prev + 1, TRAINING_PHRASES.length - 1));
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop recording');
    } finally {
      setRecording(false);
    }
  }, [currentPhraseIndex]);

  const handleRemoveSample = useCallback((id: string) => {
    setSamples((prev) => prev.filter((s) => s.id !== id));
  }, []);

  const handlePlaySample = useCallback(async (sample: TrainingSample) => {
    try {
      await invoke('ai_voice_stop_audio');
      await invoke('ai_voice_play_audio', { path: sample.path });
      setPlayingSampleId(sample.id);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to play sample');
    }
  }, []);

  const handleStopSample = useCallback(async () => {
    try {
      await invoke('ai_voice_stop_audio');
      setPlayingSampleId(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to stop playback');
    }
  }, []);

  const handleStartTraining = useCallback(async () => {
    if (!modelName.trim() || samples.length < 3) {
      setError('Please provide a model name and at least 3 samples');
      return;
    }

    try {
      const sessionId = await invoke<string>('ai_voice_start_training', {
        modelName,
        samplePaths: samples.map((s) => s.path),
      });

      setSession({
        id: sessionId,
        modelName,
        samples,
        status: 'preprocessing',
        progress: 0,
      });

      // Poll for progress
      const pollProgress = async () => {
        const status = await invoke<{
          status: TrainingStatus;
          progress: number;
          error?: string;
        }>('ai_voice_training_status', { sessionId });

        setSession((prev) =>
          prev
            ? {
              ...prev,
              status: status.status,
              progress: status.progress,
              error: status.error,
            }
            : null
        );

        if (status.status !== 'completed' && status.status !== 'failed') {
          setTimeout(pollProgress, 1000);
        }
      };

      pollProgress();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start training');
    }
  }, [modelName, samples]);

  const getStatusLabel = (status: TrainingStatus) => {
    switch (status) {
      case 'preprocessing':
        return 'Preprocessing samples...';
      case 'extracting':
        return 'Extracting features...';
      case 'training':
        return 'Training model...';
      case 'completed':
        return 'Training complete!';
      case 'failed':
        return 'Training failed';
      default:
        return 'Pending';
    }
  };

  return (
    <div className="flex-1 min-h-0 overflow-auto p-6">
      <div className="max-w-3xl mx-auto">
        <div className="mb-6">
          <h2 className="text-2xl font-bold text-white">Train Voice Model</h2>
          <p className="text-sm text-gray-400 mt-1">
            Create a new custom voice by recording or uploading a few short samples, then start training to generate a reusable voice model.
          </p>
        </div>

        {error && (
          <div className="bg-red-600/20 border border-red-600 rounded-lg p-4 mb-6">
            <p className="text-red-400">{error}</p>
            <button
              onClick={() => setError(null)}
              className="text-sm text-red-300 underline mt-2"
            >
              Dismiss
            </button>
          </div>
        )}

        {session ? (
          <div className="bg-gray-800 rounded-lg p-6">
            <h3 className="text-lg font-medium text-white mb-4">
              Training: {session.modelName}
            </h3>
            <div className="mb-4">
              <div className="flex justify-between text-sm text-gray-400 mb-2">
                <span>{getStatusLabel(session.status)}</span>
                <span>{Math.round(session.progress)}%</span>
              </div>
              <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className={`h-full transition-all ${session.status === 'failed' ? 'bg-red-500' : 'bg-blue-500'
                    }`}
                  style={{ width: `${session.progress}%` }}
                />
              </div>
            </div>
            {session.status === 'completed' && (
              <button
                onClick={() => {
                  setSession(null);
                  setSamples([]);
                  setModelName('');
                }}
                className="px-4 py-2 rounded-lg bg-green-600 text-white hover:bg-green-700 transition-all"
              >
                Done
              </button>
            )}
            {session.error && (
              <p className="text-red-400 mt-4">{session.error}</p>
            )}
          </div>
        ) : (
          <>
            {/* Model name */}
            <div className="bg-gray-800 rounded-lg p-4 mb-6">
              <label className="block text-sm font-medium text-gray-300 mb-2">
                Model Name
              </label>
              <input
                type="text"
                value={modelName}
                onChange={(e) => setModelName(e.target.value)}
                className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
                placeholder="My Voice"
              />
            </div>

            {/* Recording interface */}
            <div className="bg-gray-800 rounded-lg p-4 mb-6">
              <h3 className="text-sm font-medium text-gray-300 mb-4">
                Record Samples ({samples.length}/8 minimum 3)
              </h3>

              <p className="text-sm text-gray-400 mb-4">
                Tip: The first time you record, macOS will ask for microphone permission.
              </p>

              <div className="bg-gray-900 rounded-lg p-4 mb-4">
                <p className="text-lg text-white text-center mb-4">
                  "{TRAINING_PHRASES[currentPhraseIndex]}"
                </p>
                <div className="flex justify-center">
                  <button
                    onMouseDown={handleStartRecording}
                    onMouseUp={handleStopRecording}
                    onMouseLeave={() => recording && handleStopRecording()}
                    className={`w-16 h-16 rounded-full flex items-center justify-center transition-all ${recording
                      ? 'bg-red-600 animate-pulse'
                      : 'bg-blue-600 hover:bg-blue-700'
                      }`}
                  >
                    <svg className="w-8 h-8 text-white" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M12 14c1.66 0 3-1.34 3-3V5c0-1.66-1.34-3-3-3S9 3.34 9 5v6c0 1.66 1.34 3 3 3z" />
                      <path d="M17 11c0 2.76-2.24 5-5 5s-5-2.24-5-5H5c0 3.53 2.61 6.43 6 6.92V21h2v-3.08c3.39-.49 6-3.39 6-6.92h-2z" />
                    </svg>
                  </button>
                </div>
                <p className="text-sm text-gray-400 text-center mt-4">
                  {recording ? 'Recording... Release to stop' : 'Hold to record'}
                </p>
              </div>

              <button
                onClick={handleAddSamples}
                className="w-full px-4 py-2 rounded-lg border border-gray-600 text-gray-300 hover:bg-gray-700 transition-all"
              >
                Or Upload Audio Files
              </button>
            </div>

            {/* Sample list */}
            {samples.length > 0 && (
              <div className="bg-gray-800 rounded-lg p-4 mb-6">
                <h3 className="text-sm font-medium text-gray-300 mb-4">
                  Samples ({samples.length})
                </h3>
                <p className="text-xs text-gray-400 mb-3">
                  Play previews the raw sample audio you recorded/uploaded. The AI-generated voice becomes available after training completes.
                </p>
                <div className="space-y-2">
                  {samples.map((sample, i) => (
                    <div
                      key={sample.id}
                      className="flex items-center justify-between bg-gray-700 rounded-lg px-3 py-2"
                    >
                      <div>
                        <span className="text-white">Sample {i + 1}</span>
                        <span className="text-sm text-gray-400 ml-2">
                          {sample.duration.toFixed(1)}s
                        </span>
                        <span className="text-xs text-gray-400 ml-2">
                          {sample.path.split('/').pop()}
                        </span>
                      </div>
                      <div className="flex items-center gap-2">
                        {playingSampleId === sample.id ? (
                          <button
                            onClick={handleStopSample}
                            className="px-3 py-1.5 text-sm rounded bg-gray-600 text-white hover:bg-gray-500 transition-all"
                          >
                            Stop
                          </button>
                        ) : (
                          <button
                            onClick={() => handlePlaySample(sample)}
                            className="px-3 py-1.5 text-sm rounded bg-gray-600 text-white hover:bg-gray-500 transition-all"
                          >
                            Play
                          </button>
                        )}
                        <button
                          onClick={() => handleRemoveSample(sample.id)}
                          className="text-red-400 hover:text-red-300"
                        >
                          Remove
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Start training */}
            <button
              onClick={handleStartTraining}
              disabled={!modelName.trim() || samples.length < 3}
              className="w-full px-4 py-3 rounded-lg bg-blue-600 text-white font-medium hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
            >
              Start Training
            </button>

            <p className="text-xs text-gray-400 mt-3">
              This will begin training a new voice model using your samples. Once training completes, the new model will appear on the Voice Models page.
            </p>
          </>
        )}
      </div>
    </div>
  );
};
