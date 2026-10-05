/**
 * AI Voice Production Studio - Phrase Editor
 * 
 * @doc.type component
 * @doc.purpose Phrase-by-phrase editing interface
 * @doc.layer product
 * @doc.pattern Component
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import { clsx } from 'clsx';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { Phrase, PhraseLabel } from '../../types';
import { useProject } from '../../context/ProjectContext';
import { createLogger, invokeWithLog } from '../../utils/logger';

const logger = createLogger('PhraseEditor');

interface PhraseEditorProps {
  phrases: Phrase[];
}

const labelColors: Record<PhraseLabel, string> = {
  verse: 'bg-blue-500',
  chorus: 'bg-purple-500',
  bridge: 'bg-green-500',
  intro: 'bg-yellow-500',
  outro: 'bg-orange-500',
  other: 'bg-gray-500',
};

export const PhraseEditor: React.FC<PhraseEditorProps> = ({ phrases }) => {
  const { state, updatePhrase, setError } = useProject();
  const [selectedPhraseId, setSelectedPhraseId] = useState<string | null>(null);
  const [converting, setConverting] = useState(false);
  const [recording, setRecording] = useState(false);
  const [recordingPhraseId, setRecordingPhraseId] = useState<string | null>(null);
  const [playingTakeId, setPlayingTakeId] = useState<string | null>(null);
  const takeAudioRef = useRef<HTMLAudioElement | null>(null);

  const selectedPhrase = phrases.find((p) => p.id === selectedPhraseId);

  useEffect(() => {
    if (!takeAudioRef.current) {
      takeAudioRef.current = new Audio();
    }

    const audio = takeAudioRef.current;
    if (!audio) return;

    const onEnded = () => setPlayingTakeId(null);
    const onError = () => setPlayingTakeId(null);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, []);

  const handleConvertPhrase = useCallback(async (phrase: Phrase) => {
    if (!state.project?.voiceModel) {
      setError('Please select a voice model first');
      return;
    }

    setConverting(true);
    try {
      const result = await invokeWithLog<{ path: string; duration: number }>(logger, 'ai_voice_convert_phrase', {
        phrase_id: phrase.id,
        voice_model_id: state.project.voiceModel.id,
        start_time: phrase.startTime,
        end_time: phrase.endTime,
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
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Conversion failed');
    } finally {
      setConverting(false);
    }
  }, [state.project?.voiceModel, updatePhrase, setError]);

  const handleLabelChange = useCallback((phraseId: string, label: PhraseLabel) => {
    updatePhrase(phraseId, { label });
  }, [updatePhrase]);

  const handleToggleRecording = useCallback(async () => {
    if (!selectedPhrase) return;

    if (recording) {
      try {
        const result = await invokeWithLog<{ path: string; duration: number }>(logger, 'ai_voice_stop_recording');
        updatePhrase(selectedPhrase.id, {
          takes: [
            ...(selectedPhrase.takes || []),
            {
              id: crypto.randomUUID(),
              phraseId: selectedPhrase.id,
              path: result.path,
              duration: result.duration,
              recordedAt: new Date().toISOString(),
            },
          ],
        });
        setError(null);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to stop recording');
      } finally {
        setRecording(false);
        setRecordingPhraseId(null);
      }
      return;
    }

    try {
      await invokeWithLog<void>(logger, 'ai_voice_start_recording');
      setRecording(true);
      setRecordingPhraseId(selectedPhrase.id);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to start recording');
      setRecording(false);
      setRecordingPhraseId(null);
    }
  }, [recording, selectedPhrase, setError, updatePhrase]);

  const handlePlayTake = useCallback(
    async (takeId: string, path: string) => {
      if (!takeAudioRef.current) {
        takeAudioRef.current = new Audio();
      }

      const audio = takeAudioRef.current;
      if (!audio) return;

      if (playingTakeId === takeId) {
        audio.pause();
        setPlayingTakeId(null);
        return;
      }

      try {
        const src = convertFileSrc(path);
        audio.src = src;
        audio.preload = 'auto';
        audio.currentTime = 0;
        audio.load();
        await audio.play();
        setPlayingTakeId(takeId);
      } catch (err) {
        setPlayingTakeId(null);
        setError(err instanceof Error ? err.message : 'Failed to play take');
      }
    },
    [playingTakeId, setError]
  );

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    const ms = Math.floor((seconds % 1) * 100);
    return `${mins}:${secs.toString().padStart(2, '0')}.${ms.toString().padStart(2, '0')}`;
  };

  return (
    <div className="flex h-full gap-4">
      {/* Phrase list */}
      <div className="w-64 flex-shrink-0 overflow-y-auto space-y-2">
        {phrases.map((phrase, index) => (
          <div
            key={phrase.id}
            onClick={() => setSelectedPhraseId(phrase.id)}
            className={clsx(
              'p-3 rounded-lg cursor-pointer transition-all',
              selectedPhraseId === phrase.id
                ? 'bg-blue-600'
                : 'bg-gray-700 hover:bg-gray-600'
            )}
          >
            <div className="flex items-center justify-between mb-1">
              <span className="text-sm font-medium text-white">
                Phrase {index + 1}
              </span>
              <span className={clsx('px-2 py-0.5 text-xs rounded', labelColors[phrase.label || 'other'])}>
                {phrase.label || 'other'}
              </span>
            </div>
            <div className="text-xs text-gray-400">
              {formatTime(phrase.startTime)} - {formatTime(phrase.endTime)}
            </div>
            {phrase.takes && phrase.takes.length > 0 && (
              <div className="text-xs text-green-400 mt-1">
                {phrase.takes.length} take{phrase.takes.length > 1 ? 's' : ''}
              </div>
            )}
          </div>
        ))}
      </div>

      {/* Phrase detail */}
      <div className="flex-1 bg-gray-700/50 rounded-lg p-4">
        {selectedPhrase ? (
          <>
            <div className="flex items-center justify-between mb-4">
              <h4 className="text-lg font-medium text-white">
                Phrase {phrases.findIndex((p) => p.id === selectedPhrase.id) + 1}
              </h4>
              <select
                value={selectedPhrase.label || 'other'}
                onChange={(e) => handleLabelChange(selectedPhrase.id, e.target.value as PhraseLabel)}
                className="px-3 py-1.5 bg-gray-600 border border-gray-500 rounded-lg text-white text-sm"
              >
                <option value="verse">Verse</option>
                <option value="chorus">Chorus</option>
                <option value="bridge">Bridge</option>
                <option value="intro">Intro</option>
                <option value="outro">Outro</option>
                <option value="other">Other</option>
              </select>
            </div>

            {/* Pitch contour visualization */}
            <div className="h-24 bg-gray-800 rounded-lg mb-4 flex items-end p-2">
              {selectedPhrase.pitchContour?.map((pitch, i) => (
                <div
                  key={i}
                  className="flex-1 bg-blue-500 mx-px rounded-t"
                  style={{ height: `${Math.min(100, (pitch / 500) * 100)}%` }}
                />
              )) || (
                <div className="w-full h-full flex items-center justify-center text-gray-500 text-sm">
                  No pitch data
                </div>
              )}
            </div>

            {/* Actions */}
            <div className="flex gap-2 mb-4">
              <button
                onClick={() => handleConvertPhrase(selectedPhrase)}
                disabled={converting || !state.project?.voiceModel}
                className="px-4 py-2 rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-all"
                title={!state.project?.voiceModel ? 'Select a voice model first' : 'Create an AI-converted take for this phrase'}
              >
                {converting ? 'Converting...' : 'Convert with AI Voice'}
              </button>
              <button
                onClick={handleToggleRecording}
                className={clsx(
                  'px-4 py-2 rounded-lg text-white transition-all',
                  recording && recordingPhraseId === selectedPhrase.id
                    ? 'bg-red-600 hover:bg-red-500'
                    : 'bg-gray-600 hover:bg-gray-500'
                )}
                title={
                  recording && recordingPhraseId === selectedPhrase.id
                    ? 'Stop recording and save as a take'
                    : 'Record a new take with your microphone'
                }
              >
                {recording && recordingPhraseId === selectedPhrase.id ? 'Stop Recording' : 'Record Take'}
              </button>
            </div>

            {/* Takes */}
            {selectedPhrase.takes && selectedPhrase.takes.length > 0 && (
              <div>
                <h5 className="text-sm font-medium text-gray-300 mb-2">Takes</h5>
                <div className="space-y-2">
                  {selectedPhrase.takes.map((take, i) => (
                    <div
                      key={take.id}
                      className={clsx(
                        'flex items-center justify-between p-2 rounded-lg',
                        selectedPhrase.selectedTakeId === take.id
                          ? 'bg-green-600/20 border border-green-600'
                          : 'bg-gray-600'
                      )}
                    >
                      <span className="text-sm text-white">Take {i + 1}</span>
                      <div className="flex gap-2">
                        <button
                          onClick={() => handlePlayTake(take.id, take.path)}
                          className={clsx(
                            'px-2 py-1 text-xs rounded text-white transition-all',
                            playingTakeId === take.id ? 'bg-blue-600 hover:bg-blue-500' : 'bg-gray-500 hover:bg-gray-400'
                          )}
                          title={playingTakeId === take.id ? 'Stop preview' : 'Preview this take'}
                        >
                          {playingTakeId === take.id ? 'Stop' : 'Play'}
                        </button>
                        <button
                          onClick={() => updatePhrase(selectedPhrase.id, { selectedTakeId: take.id })}
                          className="px-2 py-1 text-xs rounded bg-green-600 text-white hover:bg-green-500"
                          title="Use this take for the final output"
                        >
                          Use
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </>
        ) : (
          <div className="h-full flex items-center justify-center text-gray-500">
            Select a phrase to edit
          </div>
        )}
      </div>
    </div>
  );
};
