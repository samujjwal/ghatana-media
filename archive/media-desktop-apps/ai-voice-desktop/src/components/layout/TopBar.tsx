/**
 * AI Voice Production Studio - Top Bar
 * 
 * @doc.type component
 * @doc.purpose Application top bar with project info and actions
 * @doc.layer product
 * @doc.pattern Component
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { open } from '@tauri-apps/plugin-dialog';
import { useProject } from '../../context/ProjectContext';
import { createLogger, invokeWithLog } from '../../utils/logger';

const logger = createLogger('TopBar');

function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

export const TopBar: React.FC = () => {
  const { state, createProject, setAudioFile, setError, setPlayback, setRuntimeMode } = useProject();
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error' | 'info'; message: string } | null>(null);
  const [examplePickerOpen, setExamplePickerOpen] = useState(false);
  const [exampleChoices, setExampleChoices] = useState<
    Array<{
      path: string;
      name: string;
      duration: number;
      sampleRate: number;
      channels: number;
      format: string;
    }>
  >([]);

  const showNotice = useCallback((type: 'success' | 'error' | 'info', message: string) => {
    setNotice({ type, message });
    window.setTimeout(() => {
      setNotice((current) => (current?.message === message ? null : current));
    }, 3500);
  }, []);

  const audioFilePath = state.project?.audioFile?.path;
  const audioFileName = state.project?.audioFile?.name;
  const audioSrc = useMemo(() => {
    if (!audioFilePath) return null;
    return convertFileSrc(audioFilePath);
  }, [audioFilePath]);

  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }

    const audio = audioRef.current;
    if (!audioSrc) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      setPlayback({ isPlaying: false, currentTime: 0, duration: 0 });
      return;
    }

    audio.src = audioSrc;
    audio.preload = 'metadata';
    audio.load();

    const onLoadedMetadata = () => {
      if (Number.isFinite(audio.duration)) {
        setPlayback({ duration: audio.duration });

        const currentAudio = state.project?.audioFile;
        if (
          currentAudio &&
          Number.isFinite(audio.duration) &&
          audio.duration > 0 &&
          Math.abs((currentAudio.duration ?? 0) - audio.duration) > 0.05
        ) {
          setAudioFile({
            ...currentAudio,
            duration: audio.duration,
          });
        }
      }
    };
    const onTimeUpdate = () => {
      setPlayback({ currentTime: audio.currentTime });
    };
    const onEnded = () => {
      setPlayback({ isPlaying: false });
    };
    const onCanPlay = () => {
      logger.info('Playback:canplay', {
        src: audio.currentSrc,
        readyState: audio.readyState,
      });
    };
    const onError = () => {
      const mediaError = audio.error;
      logger.error(
        'Playback:audio:error',
        {
          src: audio.currentSrc,
          code: mediaError?.code,
          message: mediaError?.message,
          readyState: audio.readyState,
          networkState: audio.networkState,
        },
        mediaError ?? undefined
      );
    };

    audio.addEventListener('loadedmetadata', onLoadedMetadata);
    audio.addEventListener('timeupdate', onTimeUpdate);
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('canplay', onCanPlay);
    audio.addEventListener('error', onError);

    return () => {
      audio.removeEventListener('loadedmetadata', onLoadedMetadata);
      audio.removeEventListener('timeupdate', onTimeUpdate);
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('canplay', onCanPlay);
      audio.removeEventListener('error', onError);
    };
  }, [audioSrc, setAudioFile, setPlayback, state.project?.audioFile]);

  useEffect(() => {
    if (state.error) {
      logger.error('Error', { message: state.error });
      showNotice('error', state.error);
    }
  }, [state.error, showNotice]);

  const handleNewProject = useCallback(() => {
    const name = `Project ${new Date().toLocaleDateString()}`;
    logger.info('NewProject:request', { name });
    createProject(name);
    setPlayback({ isPlaying: false, currentTime: 0, duration: 0 });
    setRuntimeMode({
      mode: 'degraded',
      reason: 'Open a real project input and verify dependencies before treating this session as production-capable.',
      exportAllowed: false,
    });
    setError(null);
    showNotice('success', 'Created new project');
    logger.info('NewProject:success', { name });
  }, [createProject, setError, setPlayback, setRuntimeMode, showNotice]);

  const handleOpenFile = useCallback(async () => {
    try {
      logger.info('OpenAudio:dialog:request');
      const selected = await open({
        multiple: false,
        filters: [
          {
            name: 'Audio',
            extensions: ['mp3', 'wav', 'flac', 'ogg', 'm4a'],
          },
        ],
      });

      logger.info('OpenAudio:dialog:result', { selected });

      if (selected && typeof selected === 'string') {
        if (!state.project) {
          const baseName = selected.split('/').pop() || 'Project';
          logger.info('OpenAudio:autoCreateProject', { name: baseName });
          createProject(baseName);
        }

        logger.info('OpenAudio:invoke:ai_voice_load_audio:request', { path: selected });
        const metadata = await invokeWithLog<{
          path: string;
          name: string;
          duration: number;
          sampleRate: number;
          channels: number;
          format: string;
        }>(logger, 'ai_voice_load_audio', { path: selected });

        logger.info('OpenAudio:invoke:ai_voice_load_audio:success', { metadata });

        setAudioFile({
          id: crypto.randomUUID(),
          ...metadata,
        });

        setRuntimeMode({
          mode: 'production',
          reason: 'Working with operator-provided audio input. Export remains enabled unless later runtime checks downgrade the session.',
          exportAllowed: true,
        });
        setError(null);
        setPlayback({ isPlaying: false, currentTime: 0, duration: metadata.duration });
        showNotice('success', 'Audio loaded');
        logger.info('OpenAudio:success', { name: metadata.name, duration: metadata.duration });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to open file';
      logger.error('OpenAudio:error', { message }, err);
      setError(message);
      showNotice('error', message);
    }
  }, [createProject, setAudioFile, setError, setPlayback, setRuntimeMode, showNotice, state.project]);

  const handleLoadExampleAudio = useCallback(async () => {
    try {
      logger.info('ExampleAudio:request');

      const examples = await invokeWithLog<
        Array<{
          path: string;
          name: string;
          duration: number;
          sampleRate: number;
          channels: number;
          format: string;
        }>
      >(logger, 'ai_voice_generate_example_audio', { count: 8 });

      if (!examples.length) {
        showNotice('info', 'No example audio available');
        logger.info('ExampleAudio:empty');
        return;
      }

      setExampleChoices(examples);
      setExamplePickerOpen(true);
      logger.info('ExampleAudio:picker:open', { count: examples.length });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to load example audio';
      logger.error('ExampleAudio:error', { message }, err);
      setError(message);
      showNotice('error', message);
    }
  }, [createProject, setAudioFile, setError, setPlayback, showNotice, state.project]);

  const handleCloseExamplePicker = useCallback(() => {
    setExamplePickerOpen(false);
    setExampleChoices([]);
    logger.info('ExampleAudio:picker:cancelled');
  }, []);

  const handleSelectExample = useCallback(
    (chosen: { path: string; name: string; duration: number; sampleRate: number; channels: number; format: string }) => {
      try {
        setExamplePickerOpen(false);

        if (!state.project) {
          const baseName = chosen.name || 'Example';
          logger.info('ExampleAudio:autoCreateProject', { name: baseName });
          createProject(baseName);
        }

        setAudioFile({
          id: crypto.randomUUID(),
          ...chosen,
        });

        setRuntimeMode({
          mode: 'demo',
          reason: 'Example audio is loaded. Treat generated outputs as demo-only and keep export blocked.',
          exportAllowed: false,
        });
        setError(null);
        setPlayback({ isPlaying: false, currentTime: 0, duration: chosen.duration });
        showNotice('success', `Loaded example: ${chosen.name}`);
        logger.info('ExampleAudio:success', { name: chosen.name, path: chosen.path });
      } finally {
        setExampleChoices([]);
      }
    },
    [createProject, setAudioFile, setError, setPlayback, setRuntimeMode, showNotice, state.project]
  );

  const handleExport = useCallback(async () => {
    try {
      if (!state.project) {
        logger.info('ExportProject:blocked', { reason: 'no_project' });
        showNotice('info', 'Create a project before exporting');
        return;
      }

      if (!state.runtimeMode.exportAllowed) {
        logger.info('ExportProject:blocked', { reason: state.runtimeMode.mode, detail: state.runtimeMode.reason });
        showNotice('info', `Export blocked in ${state.runtimeMode.mode} mode`);
        return;
      }

      logger.info('ExportProject:invoke:ai_voice_export_project:request', { projectId: state.project.id });
      await invokeWithLog<void>(logger, 'ai_voice_export_project', {
        project_id: state.project?.id,
      });

      logger.info('ExportProject:invoke:ai_voice_export_project:success', { projectId: state.project.id });

      showNotice('success', 'Export started');
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Failed to export';
      logger.error('ExportProject:error', { message }, err);
      setError(message);
      showNotice('error', message);
    }
  }, [state.project, state.runtimeMode.exportAllowed, state.runtimeMode.mode, state.runtimeMode.reason, setError, showNotice]);

  const handleTogglePlay = useCallback(() => {
    if (!audioSrc) {
      const message = 'Open an audio file to play';
      logger.info('Playback:toggle:blocked', { reason: 'no_audio_loaded' });
      setError(message);
      showNotice('info', message);
      return;
    }

    if (!audioRef.current) {
      audioRef.current = new Audio();
    }

    const audio = audioRef.current;
    if (!audio) {
      const message = 'Audio preview not initialized';
      logger.info('Playback:toggle:blocked', { reason: 'no_audio_element' });
      setError(message);
      showNotice('error', message);
      return;
    }

    if (!audio.currentSrc || audio.src !== audioSrc) {
      audio.src = audioSrc;
      audio.preload = 'metadata';
      audio.load();
      logger.info('Playback:source:set', { src: audioSrc });
    }

    if (state.playback.isPlaying) {
      logger.info('Playback:pause:request', { currentTime: audio.currentTime });
      audio.pause();
      setPlayback({ isPlaying: false });
      logger.info('Playback:pause:success', { currentTime: audio.currentTime });
      return;
    }

    logger.info('Playback:play:request', { currentTime: audio.currentTime });
    void audio.play().then(
      () => {
        setPlayback({ isPlaying: true });
        logger.info('Playback:play:success', { currentTime: audio.currentTime });
      },
      (err) => {
        const message = err instanceof Error ? err.message : 'Failed to play audio';
        logger.error(
          'Playback:play:error',
          {
            message,
            src: audio.currentSrc,
            readyState: audio.readyState,
            networkState: audio.networkState,
          },
          err
        );
        setError(message);
        showNotice('error', message);
        setPlayback({ isPlaying: false });
      }
    );
  }, [audioSrc, setError, setPlayback, showNotice, state.playback.isPlaying]);

  const handleRewind = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audioSrc) {
      logger.info('Playback:rewind:blocked', { reason: 'no_audio_loaded' });
      showNotice('info', 'Open an audio file to seek');
      return;
    }
    const nextTime = Math.max(0, audio.currentTime - 5);
    logger.info('Playback:rewind:request', { from: audio.currentTime, to: nextTime });
    audio.currentTime = nextTime;
    setPlayback({ currentTime: nextTime });
    logger.info('Playback:rewind:success', { currentTime: nextTime });
  }, [audioSrc, setPlayback, showNotice]);

  const handleForward = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || !audioSrc) {
      logger.info('Playback:forward:blocked', { reason: 'no_audio_loaded' });
      showNotice('info', 'Open an audio file to seek');
      return;
    }
    const duration = Number.isFinite(audio.duration) ? audio.duration : Number.POSITIVE_INFINITY;
    const nextTime = Math.min(duration, audio.currentTime + 5);
    logger.info('Playback:forward:request', { from: audio.currentTime, to: nextTime });
    audio.currentTime = nextTime;
    setPlayback({ currentTime: nextTime });
    logger.info('Playback:forward:success', { currentTime: nextTime });
  }, [audioSrc, setPlayback, showNotice]);

  return (
    <header className="relative z-20 h-14 bg-gray-900 border-b border-gray-800 flex items-center justify-between px-4">
      <div className="flex items-center gap-4">
        <h1 className="text-lg font-semibold text-white">
          {state.project?.name || 'AI Voice Studio'}
        </h1>
        <span
          className={
            state.runtimeMode.mode === 'production'
              ? 'inline-flex items-center rounded-full bg-emerald-900/60 px-2 py-1 text-xs font-medium text-emerald-300'
              : state.runtimeMode.mode === 'demo'
                ? 'inline-flex items-center rounded-full bg-blue-900/60 px-2 py-1 text-xs font-medium text-blue-300'
                : 'inline-flex items-center rounded-full bg-amber-900/60 px-2 py-1 text-xs font-medium text-amber-300'
          }
          title={state.runtimeMode.reason}
        >
          {state.runtimeMode.mode.toUpperCase()}
        </span>
        {state.project?.audioFile && (
          <span className="text-sm text-gray-400">
            {state.project.audioFile.name}
          </span>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handleRewind}
          disabled={!audioSrc}
          className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-all"
          title={audioSrc ? 'Rewind 5 seconds' : 'Open an audio file to enable playback controls'}
          aria-label="Rewind 5 seconds"
        >
          <svg width="20" height="20" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0019 16V8a1 1 0 00-1.6-.8l-5.333 4zM4.066 11.2a1 1 0 000 1.6l5.334 4A1 1 0 0011 16V8a1 1 0 00-1.6-.8l-5.334 4z" />
          </svg>
        </button>
        <button
          onClick={handleTogglePlay}
          disabled={!audioSrc}
          className="p-3 rounded-full bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-blue-600 transition-all"
          title={
            !audioSrc
              ? 'Open an audio file to enable playback controls'
              : state.playback.isPlaying
                ? 'Pause preview'
                : 'Play preview'
          }
          aria-label={state.playback.isPlaying ? 'Pause preview' : 'Play preview'}
        >
          {state.playback.isPlaying ? (
            <svg width="20" height="20" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 9v6m4-6v6m7-3a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
          ) : (
            <svg width="20" height="20" className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
        <button
          onClick={handleForward}
          disabled={!audioSrc}
          className="p-2 rounded-lg text-gray-400 hover:text-white hover:bg-gray-800 disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent transition-all"
          title={audioSrc ? 'Forward 5 seconds' : 'Open an audio file to enable playback controls'}
          aria-label="Forward 5 seconds"
        >
          <svg width="20" height="20" className="w-5 h-5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.933 12.8a1 1 0 000-1.6L6.6 7.2A1 1 0 005 8v8a1 1 0 001.6.8l5.333-4zM19.933 12.8a1 1 0 000-1.6l-5.333-4A1 1 0 0013 8v8a1 1 0 001.6.8l5.333-4z" />
          </svg>
        </button>

        <span
          className="ml-2 text-xs text-gray-400 tabular-nums"
          title={audioFileName ? `Previewing: ${audioFileName}` : 'No audio loaded'}
        >
          {formatTime(state.playback.currentTime)} / {formatTime(state.playback.duration)}
        </span>
      </div>

      <div className="flex items-center gap-2">
        <button
          onClick={handleNewProject}
          className="px-3 py-1.5 text-sm rounded-lg text-gray-300 hover:text-white hover:bg-gray-800 transition-all"
          title="Create a new project"
        >
          New Project
        </button>
        <button
          onClick={handleOpenFile}
          className="px-3 py-1.5 text-sm rounded-lg text-gray-300 hover:text-white hover:bg-gray-800 transition-all"
          title="Open an audio file"
        >
          Open Audio
        </button>
        <button
          onClick={handleLoadExampleAudio}
          className="px-3 py-1.5 text-sm rounded-lg text-gray-300 hover:text-white hover:bg-gray-800 transition-all"
          title="Generate and load example audio"
        >
          Examples
        </button>
        <button
          onClick={handleExport}
          disabled={!state.project || !state.runtimeMode.exportAllowed}
          className="px-3 py-1.5 text-sm rounded-lg bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-all"
          title={
            !state.project
              ? 'Create a project before exporting'
              : state.runtimeMode.exportAllowed
                ? 'Export current project'
                : `Export is blocked in ${state.runtimeMode.mode} mode`
          }
        >
          Export
        </button>

        {notice && (
          <div
            className={
              notice.type === 'success'
                ? 'ml-3 text-xs text-green-300'
                : notice.type === 'error'
                  ? 'ml-3 text-xs text-red-300'
                  : 'ml-3 text-xs text-gray-300'
            }
            title={notice.message}
          >
            {notice.message}
          </div>
        )}
      </div>

      {examplePickerOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60">
          <div className="w-full max-w-lg rounded-xl bg-gray-900 border border-gray-800 shadow-xl">
            <div className="flex items-center justify-between px-4 py-3 border-b border-gray-800">
              <div className="text-sm font-semibold text-white">Choose an example audio</div>
              <button
                onClick={handleCloseExamplePicker}
                className="px-2 py-1 text-sm rounded-lg text-gray-300 hover:text-white hover:bg-gray-800 transition-all"
              >
                Close
              </button>
            </div>
            <div className="max-h-[60vh] overflow-auto p-2">
              {exampleChoices.map((e) => (
                <button
                  key={e.path}
                  onClick={() => handleSelectExample(e)}
                  className="w-full text-left px-3 py-2 rounded-lg hover:bg-gray-800 transition-all"
                >
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-white">{e.name}</div>
                    <div className="text-xs text-gray-400 tabular-nums">{formatTime(e.duration)}</div>
                  </div>
                  <div className="mt-1 text-xs text-gray-500 truncate">{e.path}</div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}
    </header>
  );
};
