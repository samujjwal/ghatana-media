/**
 * AI Voice Production Studio - Voice Replacement View
 * 
 * @doc.type component
 * @doc.purpose Interactive voice replacement interface
 * @doc.layer product
 * @doc.pattern Component
 */

import React, { useEffect, useState, useCallback } from 'react';
import { useProject } from '../../context/ProjectContext';
import type { Phrase, VoiceModel } from '../../types';
import { createLogger, invokeWithLog } from '../../utils/logger';
import {
  ConversionSettings,
  ConversionSettingsData,
  defaultConversionSettings,
  PhraseList,
  VoiceModelSelector,
  ConversionProgress,
} from '../voice';

const logger = createLogger('VoiceReplacementView');

export const VoiceReplacementView: React.FC = () => {
  const { state, updatePhrase, setVoiceModel, setError } = useProject();
  const [settings, setSettings] = useState<ConversionSettingsData>(defaultConversionSettings);
  const [selectedPhraseId, setSelectedPhraseId] = useState<string | null>(null);
  const [convertingPhraseId, setConvertingPhraseId] = useState<string | null>(null);
  const [batchConverting, setBatchConverting] = useState(false);
  const [batchProgress, setBatchProgress] = useState(0);
  const [currentBatchPhrase, setCurrentBatchPhrase] = useState(0);
  const [models, setModels] = useState<VoiceModel[]>([]);

  useEffect(() => {
    const loadModels = async () => {
      try {
        logger.info('LoadModels:request');
        const result = await invokeWithLog<VoiceModel[]>(logger, 'ai_voice_list_models');
        setModels(result);
        logger.info('LoadModels:success', { count: result.length });
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Failed to load voice models';
        logger.error('LoadModels:error', { message }, err);
        setError(message);
      }
    };

    void loadModels();
  }, [setError]);

  const handleConvertPhrase = useCallback(async (phrase: Phrase) => {
    if (!state.project?.voiceModel) {
      setError('Please select a voice model first');
      return;
    }

    setConvertingPhraseId(phrase.id);
    try {
      logger.info('ConvertPhrase:request', { phraseId: phrase.id, modelId: state.project.voiceModel.id });
      const result = await invokeWithLog<{ path: string; duration: number }>(logger, 'ai_voice_convert_phrase', {
        phrase_id: phrase.id,
        voice_model_id: state.project.voiceModel.id,
        start_time: phrase.startTime,
        end_time: phrase.endTime,
        options: settings,
      });

      updatePhrase(phrase.id, {
        takes: [
          ...(phrase.takes || []),
          {
            id: crypto.randomUUID(),
            phraseId: phrase.id,
            path: result.path,
            duration: result.duration,
            recordedAt: new Date().toISOString(),
          },
        ],
      });

      setError(null);
      logger.info('ConvertPhrase:success', { phraseId: phrase.id });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Conversion failed';
      logger.error('ConvertPhrase:error', { message }, err);
      setError(message);
    } finally {
      setConvertingPhraseId(null);
    }
  }, [state.project?.voiceModel, settings, updatePhrase, setError]);

  const handleConvertAll = useCallback(async () => {
    const phrases = state.project?.phrases;
    if (!phrases?.length) return;

    setBatchConverting(true);
    setBatchProgress(0);
    setCurrentBatchPhrase(0);

    for (let i = 0; i < phrases.length; i++) {
      setCurrentBatchPhrase(i + 1);
      await handleConvertPhrase(phrases[i]);
      setBatchProgress(((i + 1) / phrases.length) * 100);
    }

    setBatchConverting(false);
  }, [state.project?.phrases, handleConvertPhrase]);

  const handleCancelBatch = useCallback(() => {
    setBatchConverting(false);
  }, []);

  const handlePlayPhrase = useCallback(async (phrase: Phrase) => {
    try {
      const path = phrase.selectedTakeId
        ? phrase.takes?.find(t => t.id === phrase.selectedTakeId)?.path
        : state.project?.stems?.vocals.path;
      
      if (path) {
        await invokeWithLog<void>(logger, 'ai_voice_play_audio', { path });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Playback failed';
      logger.error('PlayPhrase:error', { message }, err);
      setError(message);
    }
  }, [state.project?.stems?.vocals.path, setError]);

  const handleSelectTake = useCallback((phraseId: string, takeId: string) => {
    updatePhrase(phraseId, { selectedTakeId: takeId });
  }, [updatePhrase]);

  const handleSettingChange = useCallback((key: keyof ConversionSettingsData, value: number) => {
    setSettings(prev => ({ ...prev, [key]: value }));
  }, []);

  const handleResetSettings = useCallback(() => {
    setSettings(defaultConversionSettings);
  }, []);

  const handleSelectModel = useCallback((model: VoiceModel) => {
    setVoiceModel(model);
  }, [setVoiceModel]);

  // Check prerequisites
  if (!state.project?.stems) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <h3 className="text-lg font-medium text-white mb-2">No Stems Available</h3>
          <p className="text-gray-400">Separate your audio into stems first</p>
        </div>
      </div>
    );
  }

  const phrases = state.project?.phrases || [];

  return (
    <div className="flex-1 flex flex-col p-6 overflow-hidden">
      {/* Header */}
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-2xl font-bold text-white">Voice Replacement</h2>
        <button
          onClick={handleConvertAll}
          disabled={batchConverting || !phrases.length || !state.project?.voiceModel}
          className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
        >
          Convert All Phrases
        </button>
      </div>

      {/* Batch progress */}
      <ConversionProgress
        isConverting={batchConverting}
        progress={batchProgress}
        currentPhrase={currentBatchPhrase}
        totalPhrases={phrases.length}
        onCancel={handleCancelBatch}
      />

      {/* Main content */}
      <div className="flex gap-6 flex-1 overflow-hidden mt-4">
        {/* Left: Settings */}
        <div className="w-80 flex-shrink-0 space-y-4 overflow-y-auto">
          <VoiceModelSelector
            models={models}
            selectedModelId={state.project?.voiceModel?.id || null}
            onSelect={handleSelectModel}
            onManageModels={() => setError('Manage voice models in Library → Voices')}
          />
          <ConversionSettings
            settings={settings}
            onChange={handleSettingChange}
            onReset={handleResetSettings}
          />
        </div>

        {/* Right: Phrase list */}
        <PhraseList
          phrases={phrases}
          selectedPhraseId={selectedPhraseId}
          convertingPhraseId={convertingPhraseId}
          onSelectPhrase={setSelectedPhraseId}
          onConvertPhrase={handleConvertPhrase}
          onPlayPhrase={handlePlayPhrase}
          onSelectTake={handleSelectTake}
        />
      </div>
    </div>
  );
};
