/**
 * AI Voice Production Studio - Stem Track
 * 
 * @doc.type component
 * @doc.purpose Individual stem track display
 * @doc.layer product
 * @doc.pattern Component
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { clsx } from 'clsx';
import { convertFileSrc } from '@tauri-apps/api/core';
import type { Stem } from '../../types';
import { createLogger } from '../../utils/logger';

const logger = createLogger('StemTrack');

interface StemTrackProps {
  stem: Stem;
  color: 'blue' | 'green' | 'yellow' | 'purple';
  anySoloActive?: boolean;
  onVolumeChange?: (volume: number) => void;
  onMuteToggle?: () => void;
  onSoloToggle?: () => void;
}

const colorClasses = {
  blue: 'bg-blue-500',
  green: 'bg-green-500',
  yellow: 'bg-yellow-500',
  purple: 'bg-purple-500',
};

export const StemTrack: React.FC<StemTrackProps> = ({
  stem,
  color,
  anySoloActive,
  onVolumeChange,
  onMuteToggle,
  onSoloToggle,
}) => {
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const [isPreviewing, setIsPreviewing] = useState(false);

  const effectivelyMuted = Boolean(stem.muted || (anySoloActive && !stem.solo));

  const stemSrc = useMemo(() => {
    if (!stem.path) return null;
    return convertFileSrc(stem.path);
  }, [stem.path]);

  useEffect(() => {
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }

    const audio = audioRef.current;
    if (!audio) return;

    const onEnded = () => setIsPreviewing(false);
    const onError = () => {
      const mediaError = audio.error;
      logger.error(
        'StemPreview:error',
        {
          stemPath: stem.path,
          src: audio.currentSrc,
          code: mediaError?.code,
          message: mediaError?.message,
          readyState: audio.readyState,
          networkState: audio.networkState,
        },
        mediaError ?? undefined
      );
      setIsPreviewing(false);
    };
    audio.addEventListener('ended', onEnded);
    audio.addEventListener('error', onError);
    return () => {
      audio.removeEventListener('ended', onEnded);
      audio.removeEventListener('error', onError);
    };
  }, [stem.path]);

  const handleTogglePreview = useCallback(() => {
    if (!stemSrc) return;
    if (!audioRef.current) {
      audioRef.current = new Audio();
    }

    const audio = audioRef.current;
    if (!audio) return;

    if (isPreviewing) {
      audio.pause();
      setIsPreviewing(false);
      return;
    }

    audio.src = stemSrc;
    audio.preload = 'auto';
    audio.volume = Math.max(0, Math.min(1, effectivelyMuted ? 0 : stem.volume));
    audio.currentTime = 0;
    audio.load();
    logger.info('StemPreview:play:request', {
      stemPath: stem.path,
      src: stemSrc,
      volume: audio.volume,
    });
    void audio.play().then(
      () => {
        setIsPreviewing(true);
        logger.info('StemPreview:play:success', { stemPath: stem.path });
      },
      (err) => {
        const message = err instanceof Error ? err.message : 'Failed to play stem';
        logger.error(
          'StemPreview:play:error',
          {
            message,
            stemPath: stem.path,
            src: audio.currentSrc,
            readyState: audio.readyState,
            networkState: audio.networkState,
          },
          err
        );
        setIsPreviewing(false);
      }
    );
  }, [effectivelyMuted, isPreviewing, stem.volume, stemSrc]);

  return (
    <div className={clsx('flex items-center gap-3 bg-gray-700/50 rounded-lg p-2', effectivelyMuted && 'opacity-70')}>
      {/* Controls */}
      <div className="flex items-center gap-1">
        <button
          onClick={onMuteToggle}
          className={clsx(
            'w-6 h-6 rounded text-xs font-bold transition-all',
            stem.muted
              ? 'bg-red-600 text-white'
              : 'bg-gray-600 text-gray-400 hover:bg-gray-500'
          )}
          title="Mute (hide this stem from playback)"
        >
          M
        </button>
        <button
          onClick={onSoloToggle}
          className={clsx(
            'w-6 h-6 rounded text-xs font-bold transition-all',
            stem.solo
              ? 'bg-yellow-600 text-white'
              : 'bg-gray-600 text-gray-400 hover:bg-gray-500'
          )}
          title="Solo (listen to only this stem)"
        >
          S
        </button>
      </div>

      {/* Name */}
      <span className="w-16 text-sm font-medium text-white truncate">
        {stem.name}
      </span>

      {/* Waveform preview */}
      <div className="flex-1 h-8 bg-gray-800 rounded overflow-hidden">
        <div className="h-full flex items-center justify-center">
          {stem.waveformData ? (
            <div className="flex items-center gap-px h-full w-full px-1">
              {stem.waveformData.slice(0, 100).map((v, i) => (
                <div
                  key={i}
                  className={clsx('w-1 rounded-sm', colorClasses[color])}
                  style={{
                    height: `${Math.max(10, v * 100)}%`,
                    opacity: stem.muted ? 0.3 : 1,
                  }}
                />
              ))}
            </div>
          ) : (
            <div className={clsx('h-1 w-full', colorClasses[color])} style={{ opacity: 0.5 }} />
          )}
        </div>
      </div>

      {/* Volume */}
      <div className="flex items-center gap-2 w-32">
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={stem.volume}
          onChange={(e) => onVolumeChange?.(parseFloat(e.target.value))}
          className="flex-1 h-1 bg-gray-600 rounded-lg appearance-none cursor-pointer"
          title="Volume"
        />
        <span className="w-8 text-xs text-gray-400 text-right">
          {Math.round(stem.volume * 100)}%
        </span>
      </div>

      <button
        onClick={handleTogglePreview}
        disabled={!stemSrc || effectivelyMuted}
        className={clsx(
          'px-2 py-1 text-xs rounded text-white transition-all',
          isPreviewing ? 'bg-blue-600 hover:bg-blue-500' : 'bg-gray-600 hover:bg-gray-500',
          (!stemSrc || effectivelyMuted) && 'opacity-50 cursor-not-allowed hover:bg-gray-600'
        )}
        title={
          !stemSrc
            ? 'Stem audio not available'
            : effectivelyMuted
              ? anySoloActive && !stem.solo
                ? 'Muted because another stem is soloed'
                : 'Muted'
              : 'Preview this stem'
        }
      >
        {isPreviewing ? 'Stop' : 'Play'}
      </button>
    </div>
  );
};
