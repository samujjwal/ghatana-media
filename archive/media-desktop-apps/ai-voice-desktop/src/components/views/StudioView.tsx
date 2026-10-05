/**
 * AI Voice Production Studio - Studio View
 * 
 * @doc.type component
 * @doc.purpose Main studio workspace with waveform, stems, and phrase editor
 * @doc.layer product
 * @doc.pattern Component
 */

import React, { useCallback, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { useProject } from '../../context/ProjectContext';
import { createLogger, invokeWithLog } from '../../utils/logger';
import { WaveformDisplay } from '../audio/WaveformDisplay';
import { StemTrack } from '../audio/StemTrack';
import { PhraseEditor } from '../audio/PhraseEditor';

const logger = createLogger('StudioView');

export const StudioView: React.FC = () => {
  const { state, setStems, setPhrases, setError } = useProject();
  const [separating, setSeparating] = useState(false);
  const [separationProgress, setSeparationProgress] = useState(0);
  const [separationWarning, setSeparationWarning] = useState<string | null>(null);

  const anySoloActive = Boolean(
    state.project?.stems &&
      (state.project.stems.vocals.solo ||
        state.project.stems.drums.solo ||
        state.project.stems.bass.solo ||
        state.project.stems.other.solo)
  );

  const updateStem = useCallback(
    (key: 'vocals' | 'drums' | 'bass' | 'other', updates: { volume?: number; muted?: boolean; solo?: boolean }) => {
      if (!state.project?.stems) return;
      const current = state.project.stems;
      setStems({
        ...current,
        [key]: {
          ...current[key],
          ...updates,
        },
      });
    },
    [state.project?.stems, setStems]
  );

  const handleSeparate = useCallback(async () => {
    if (!state.project?.audioFile) return;

    setSeparating(true);
    setSeparationProgress(0);

    try {
      const resolveDuration = async (): Promise<number | undefined> => {
        const fromFile = state.project?.audioFile?.duration ?? 0;
        const fromPlayback = state.playback.duration ?? 0;
        const bestKnown = Math.max(fromFile, fromPlayback);
        if (Number.isFinite(bestKnown) && bestKnown > 0) return bestKnown;

        const path = state.project?.audioFile?.path;
        if (!path) return undefined;

        const src = convertFileSrc(path);
        return await new Promise((resolve) => {
          const audio = new Audio();
          const cleanup = () => {
            audio.removeEventListener('loadedmetadata', onLoaded);
            audio.removeEventListener('error', onError);
          };
          const onLoaded = () => {
            const d = audio.duration;
            cleanup();
            resolve(Number.isFinite(d) && d > 0 ? d : undefined);
          };
          const onError = () => {
            cleanup();
            resolve(undefined);
          };
          audio.addEventListener('loadedmetadata', onLoaded);
          audio.addEventListener('error', onError);
          audio.src = src;
          audio.preload = 'metadata';
          audio.load();
        });
      };

      const audioDuration = await resolveDuration();
      logger.info('SeparateStems:request', {
        path: state.project.audioFile.path,
        audioDuration,
        audioFileDuration: state.project.audioFile.duration,
        playbackDuration: state.playback.duration,
      });
      const stems = await invokeWithLog<{
        vocals: { path: string; duration: number };
        drums: { path: string; duration: number };
        bass: { path: string; duration: number };
        other: { path: string; duration: number };
      }>(logger, 'ai_voice_separate_stems', {
        audio_path: state.project.audioFile.path,
        audio_duration: audioDuration,
      });

      setSeparationWarning(null);

      setStems({
        id: crypto.randomUUID(),
        vocals: {
          id: crypto.randomUUID(),
          name: 'Vocals',
          path: stems.vocals.path,
          duration: stems.vocals.duration,
          volume: 1.0,
          muted: false,
          solo: false,
        },
        drums: {
          id: crypto.randomUUID(),
          name: 'Drums',
          path: stems.drums.path,
          duration: stems.drums.duration,
          volume: 1.0,
          muted: false,
          solo: false,
        },
        bass: {
          id: crypto.randomUUID(),
          name: 'Bass',
          path: stems.bass.path,
          duration: stems.bass.duration,
          volume: 1.0,
          muted: false,
          solo: false,
        },
        other: {
          id: crypto.randomUUID(),
          name: 'Other',
          path: stems.other.path,
          duration: stems.other.duration,
          volume: 1.0,
          muted: false,
          solo: false,
        },
      });

      setSeparationProgress(100);
      setError(null);
      logger.info('SeparateStems:success');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Separation failed';
      logger.error('SeparateStems:error', { message }, err);
      setError(message);
    } finally {
      setSeparating(false);
    }
  }, [state.project?.audioFile, setStems, setError]);

  const handleDetectPhrases = useCallback(async () => {
    if (!state.project?.stems?.vocals) return;

    try {
      logger.info('DetectPhrases:request', { vocalPath: state.project.stems.vocals.path });
      const phrases = await invokeWithLog<Array<{
        startTime: number;
        endTime: number;
        pitchContour: number[];
      }>>(logger, 'ai_voice_detect_phrases', {
        vocal_path: state.project.stems.vocals.path,
      });

      setPhrases(
        phrases.map((p) => ({
          id: crypto.randomUUID(),
          startTime: p.startTime,
          endTime: p.endTime,
          pitchContour: p.pitchContour,
          label: 'other' as const,
          takes: [],
        }))
      );

      setError(null);
      logger.info('DetectPhrases:success', { count: phrases.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Phrase detection failed';
      logger.error('DetectPhrases:error', { message }, err);
      setError(message);
    }
  }, [state.project?.stems?.vocals, setPhrases, setError]);

  if (!state.project) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="w-24 h-24 mx-auto mb-6 rounded-full bg-gray-800 flex items-center justify-center">
            <svg className="w-12 h-12 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 19V6l12-3v13M9 19c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zm12-3c0 1.105-1.343 2-3 2s-3-.895-3-2 1.343-2 3-2 3 .895 3 2zM9 10l12-3" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-white mb-2">No Project Open</h2>
          <p className="text-gray-400 mb-6">Create a new project or open an audio file to get started</p>
        </div>
      </div>
    );
  }

  if (!state.project.audioFile) {
    return (
      <div className="flex-1 flex items-center justify-center">
        <div className="text-center">
          <div className="w-24 h-24 mx-auto mb-6 rounded-full bg-gray-800 flex items-center justify-center">
            <svg className="w-12 h-12 text-gray-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M15 13l-3-3m0 0l-3 3m3-3v12" />
            </svg>
          </div>
          <h2 className="text-xl font-semibold text-white mb-2">Import Audio</h2>
          <p className="text-gray-400 mb-6">Open an audio file to begin</p>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 flex flex-col p-4 gap-4">
      <div className="bg-gray-800 rounded-lg p-4">
        <h3 className="text-sm font-medium text-gray-300 mb-3">Quick guide</h3>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3 text-sm text-gray-300">
          <div className="bg-gray-700/50 rounded-lg p-3">
            <div className="font-medium text-white mb-1">1) Open audio</div>
            <div className="text-gray-300">Use <span className="text-white">Open Audio</span> or <span className="text-white">Examples</span> in the top bar.</div>
          </div>
          <div className="bg-gray-700/50 rounded-lg p-3">
            <div className="font-medium text-white mb-1">2) Split into stems</div>
            <div className="text-gray-300">Creates 4 tracks: <span className="text-white">Vocals</span>, <span className="text-white">Drums</span>, <span className="text-white">Bass</span>, and <span className="text-white">Other</span> (everything else).</div>
          </div>
          <div className="bg-gray-700/50 rounded-lg p-3">
            <div className="font-medium text-white mb-1">3) Detect phrases</div>
            <div className="text-gray-300">Finds vocal “chunks” (like lines) so you can edit/convert one part at a time.</div>
          </div>
          <div className="bg-gray-700/50 rounded-lg p-3">
            <div className="font-medium text-white mb-1">4) Convert or record takes</div>
            <div className="text-gray-300">Select a phrase and use <span className="text-white">Convert with AI Voice</span> or <span className="text-white">Record Take</span>.</div>
          </div>
        </div>
        <div className="mt-3 text-xs text-gray-400">
          Tip: <span className="text-gray-200">Solo</span> lets you listen to just one stem. <span className="text-gray-200">Mute</span> hides a stem.
        </div>
      </div>

      {/* Main waveform */}
      <div className="bg-gray-800 rounded-lg p-4">
        <div className="flex items-center justify-between mb-4">
          <h3 className="text-sm font-medium text-gray-300">Original Track</h3>
          <div className="flex gap-2">
            <button
              onClick={handleSeparate}
              disabled={separating || !!state.project.stems}
              className="px-3 py-1.5 text-sm rounded-lg bg-purple-600 text-white hover:bg-purple-700 disabled:opacity-50 transition-all"
              title={
                state.project.stems
                  ? 'Already split into stems'
                  : 'Splits your song into 4 parts so you can work on vocals separately'
              }
            >
              {separating ? `Splitting... ${separationProgress}%` : 'Split into stems'}
            </button>
          </div>
        </div>
        <WaveformDisplay
          audioFile={state.project.audioFile}
          currentTime={state.playback.currentTime}
          duration={state.playback.duration}
        />
      </div>

      {/* Stems */}
      {state.project.stems && (
        <div className="bg-gray-800 rounded-lg p-4">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-sm font-medium text-gray-300">Stems</h3>
            <button
              onClick={handleDetectPhrases}
              disabled={!!state.project.phrases?.length}
              className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 transition-all"
              title={
                state.project.phrases?.length
                  ? 'Phrases already detected'
                  : 'Finds vocal segments so you can convert or record line-by-line'
              }
            >
              Find vocal phrases
            </button>
          </div>
          {separationWarning && (
            <div className="mb-3 rounded-lg border border-yellow-700/60 bg-yellow-950/30 px-3 py-2 text-sm text-yellow-200">
              {separationWarning}
            </div>
          )}
          <div className="space-y-2">
            <StemTrack
              stem={state.project.stems.vocals}
              color="blue"
              anySoloActive={anySoloActive}
              onVolumeChange={(volume) => updateStem('vocals', { volume })}
              onMuteToggle={() => updateStem('vocals', { muted: !state.project!.stems!.vocals.muted })}
              onSoloToggle={() => updateStem('vocals', { solo: !state.project!.stems!.vocals.solo })}
            />
            <StemTrack
              stem={state.project.stems.drums}
              color="green"
              anySoloActive={anySoloActive}
              onVolumeChange={(volume) => updateStem('drums', { volume })}
              onMuteToggle={() => updateStem('drums', { muted: !state.project!.stems!.drums.muted })}
              onSoloToggle={() => updateStem('drums', { solo: !state.project!.stems!.drums.solo })}
            />
            <StemTrack
              stem={state.project.stems.bass}
              color="yellow"
              anySoloActive={anySoloActive}
              onVolumeChange={(volume) => updateStem('bass', { volume })}
              onMuteToggle={() => updateStem('bass', { muted: !state.project!.stems!.bass.muted })}
              onSoloToggle={() => updateStem('bass', { solo: !state.project!.stems!.bass.solo })}
            />
            <StemTrack
              stem={state.project.stems.other}
              color="purple"
              anySoloActive={anySoloActive}
              onVolumeChange={(volume) => updateStem('other', { volume })}
              onMuteToggle={() => updateStem('other', { muted: !state.project!.stems!.other.muted })}
              onSoloToggle={() => updateStem('other', { solo: !state.project!.stems!.other.solo })}
            />
          </div>
        </div>
      )}

      {/* Phrase editor */}
      {state.project.phrases && state.project.phrases.length > 0 && (
        <div className="flex-1 bg-gray-800 rounded-lg p-4 min-h-0">
          <h3 className="text-sm font-medium text-gray-300 mb-4">Phrases</h3>
          <PhraseEditor phrases={state.project.phrases} />
        </div>
      )}
    </div>
  );
};
