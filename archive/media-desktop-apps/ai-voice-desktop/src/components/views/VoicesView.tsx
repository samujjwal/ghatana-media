/**
 * AI Voice Production Studio - Voices View
 * 
 * @doc.type component
 * @doc.purpose Voice model management and selection
 * @doc.layer product
 * @doc.pattern Component
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useProject } from '../../context/ProjectContext';
import type { VoiceModel } from '../../types';
import { createLogger, invokeWithLog } from '../../utils/logger';

const logger = createLogger('VoicesView');

function formatVoiceQuality(voice: VoiceModel): string {
  if (typeof voice.quality !== 'number') {
    return 'pending analysis';
  }

  return `${Math.round(voice.quality * 100)}%`;
}

interface VoicesViewProps {
  onOpenTraining?: () => void;
}

export const VoicesView: React.FC<VoicesViewProps> = ({ onOpenTraining }) => {
  const { state, setVoiceModel, setError } = useProject();
  const [voices, setVoices] = useState<VoiceModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [testText, setTestText] = useState('Hello, this is a test of my AI voice.');

  useEffect(() => {
    loadVoices();
  }, []);

  const loadVoices = async () => {
    try {
      setLoading(true);
      logger.info('LoadVoices:request');
      const models = await invokeWithLog<VoiceModel[]>(logger, 'ai_voice_list_models');
      setVoices(models);
      logger.info('LoadVoices:success', { count: models.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load voices';
      logger.error('LoadVoices:error', { message }, err);
      setError(message);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectVoice = useCallback((voice: VoiceModel) => {
    setVoiceModel(voice);
  }, [setVoiceModel]);

  const handleTestVoice = useCallback(async (voice: VoiceModel) => {
    try {
      logger.info('TestVoice:request', { modelId: voice.id });
      await invokeWithLog<void>(logger, 'ai_voice_test_model', {
        model_id: voice.id,
        text: testText,
      });
      logger.info('TestVoice:success', { modelId: voice.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to test voice';
      logger.error('TestVoice:error', { message, modelId: voice.id }, err);
      setError(message);
    }
  }, [testText, setError]);

  const handleDeleteVoice = useCallback(async (voice: VoiceModel) => {
    if (!confirm(`Delete voice "${voice.name}"?`)) return;

    try {
      logger.info('DeleteVoice:request', { modelId: voice.id, name: voice.name });
      await invokeWithLog<void>(logger, 'ai_voice_delete_model', { model_id: voice.id });
      await loadVoices();
      logger.info('DeleteVoice:success', { modelId: voice.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to delete voice';
      logger.error('DeleteVoice:error', { message, modelId: voice.id }, err);
      setError(message);
    }
  }, [setError]);

  if (loading) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="animate-spin w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full" />
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-auto p-6">
      <div className="max-w-4xl mx-auto">
        <div className="flex items-center justify-between mb-6">
          <div>
            <h2 className="text-2xl font-bold text-white">Voice Models</h2>
            <p className="text-sm text-gray-400 mt-1">
              Manage and preview voice models, set your default voice, and train new models from recorded or uploaded samples.
            </p>
          </div>
          <button
            onClick={() => onOpenTraining?.()}
            className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 transition-all"
          >
            Train New Voice
          </button>
        </div>

        {/* Test input */}
        <div className="bg-gray-800 rounded-lg p-4 mb-6">
          <label className="block text-sm font-medium text-gray-300 mb-2">
            Preview text (used when you click Test)
          </label>
          <textarea
            value={testText}
            onChange={(e) => setTestText(e.target.value)}
            className="w-full px-3 py-2 bg-gray-700 border border-gray-600 rounded-lg text-white placeholder-gray-400 focus:outline-none focus:ring-2 focus:ring-blue-500"
            rows={2}
            placeholder="Type a short sentence to generate an audio preview for any model."
          />
        </div>

        {/* Voice grid */}
        {voices.length === 0 ? (
          <div className="text-center py-12">
            <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-gray-800 flex items-center justify-center">
              <svg className="w-8 h-8 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
              </svg>
            </div>
            <h3 className="text-lg font-medium text-white mb-2">No Voice Models</h3>
            <p className="text-gray-400">Train your first voice model to get started</p>
          </div>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {voices.map((voice) => (
              <div
                key={voice.id}
                className={`bg-gray-800 rounded-lg p-4 border-2 transition-all cursor-pointer ${state.project?.voiceModel?.id === voice.id
                    ? 'border-blue-500'
                    : 'border-transparent hover:border-gray-600'
                  }`}
                onClick={() => handleSelectVoice(voice)}
              >
                <div className="flex items-start justify-between mb-3">
                  <div>
                    <h3 className="font-medium text-white">{voice.name}</h3>
                    <p className="text-sm text-gray-400">
                      {voice.trainingSamples} samples • Quality: {formatVoiceQuality(voice)}
                    </p>
                  </div>
                  {voice.isDefault && (
                    <span className="px-2 py-0.5 text-xs rounded bg-blue-600 text-white">
                      Default
                    </span>
                  )}
                </div>

                <div className="flex gap-2">
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleTestVoice(voice);
                    }}
                    className="flex-1 px-3 py-1.5 text-sm rounded bg-gray-700 text-white hover:bg-gray-600 transition-all"
                  >
                    Test
                  </button>
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      handleDeleteVoice(voice);
                    }}
                    className="px-3 py-1.5 text-sm rounded bg-red-600/20 text-red-400 hover:bg-red-600/30 transition-all"
                  >
                    Delete
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};
