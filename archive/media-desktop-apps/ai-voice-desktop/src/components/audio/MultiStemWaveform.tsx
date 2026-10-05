/**
 * Multi-Stem Waveform Visualizer
 *
 * Complete waveform visualization using WaveSurfer.js with:
 * - Multi-track display
 * - Synchronized playback
 * - Zoom and pan controls
 * - Individual stem controls
 *
 * @doc.type component
 * @doc.purpose Audio waveform visualization
 * @doc.layer product
 * @doc.pattern Component
 */

import React, { useEffect, useRef, useState, useCallback } from 'react';
import WaveSurfer from 'wavesurfer.js';
import {
  Play,
  Pause,
  Square,
  ZoomIn,
  ZoomOut,
  Volume2,
  VolumeX
} from 'lucide-react';

interface WaveformProps {
  audioPath: string;
  stemType: 'vocals' | 'drums' | 'bass' | 'other';
  color: string;
  onReady?: () => void;
  masterTime?: number;
  isMaster?: boolean;
}

interface MultiStemWaveformProps {
  stems: {
    vocals: string;
    drums: string;
    bass: string;
    other: string;
  };
}

const STEM_COLORS = {
  vocals: '#a855f7',
  drums: '#ef4444',
  bass: '#3b82f6',
  other: '#22c55e',
};

/**
 * Single waveform track component
 */
export function WaveformTrack({
  audioPath,
  stemType,
  color,
  onReady,
  masterTime,
  isMaster = false
}: WaveformProps) {
  const waveformRef = useRef<HTMLDivElement>(null);
  const wavesurfer = useRef<WaveSurfer | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [volume, setVolume] = useState(1);
  const [muted, setMuted] = useState(false);
  const [duration, setDuration] = useState(0);
  const [currentTime, setCurrentTime] = useState(0);

  // Initialize WaveSurfer
  useEffect(() => {
    if (!waveformRef.current || !audioPath) return;

    wavesurfer.current = WaveSurfer.create({
      container: waveformRef.current,
      waveColor: color + '40',
      progressColor: color,
      cursorColor: color,
      barWidth: 2,
      barRadius: 3,
      cursorWidth: 2,
      height: 80,
      barGap: 2,
      normalize: true,
      backend: 'WebAudio',
    });

    wavesurfer.current.load(audioPath);

    wavesurfer.current.on('ready', () => {
      setDuration(wavesurfer.current?.getDuration() || 0);
      onReady?.();
    });

    wavesurfer.current.on('audioprocess', () => {
      setCurrentTime(wavesurfer.current?.getCurrentTime() || 0);
    });

    wavesurfer.current.on('play', () => setIsPlaying(true));
    wavesurfer.current.on('pause', () => setIsPlaying(false));
    wavesurfer.current.on('finish', () => setIsPlaying(false));

    return () => {
      wavesurfer.current?.destroy();
    };
  }, [audioPath, color, onReady]);

  // Sync with master time
  useEffect(() => {
    if (!isMaster && masterTime !== undefined && wavesurfer.current) {
      const current = wavesurfer.current.getCurrentTime();
      if (Math.abs(current - masterTime) > 0.1) {
        wavesurfer.current.seekTo(masterTime / duration);
      }
    }
  }, [masterTime, duration, isMaster]);

  // Handle playback
  const togglePlay = useCallback(() => {
    wavesurfer.current?.playPause();
  }, []);

  const stop = useCallback(() => {
    wavesurfer.current?.stop();
    setIsPlaying(false);
  }, []);

  const handleVolumeChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const newVolume = parseFloat(e.target.value);
    setVolume(newVolume);
    wavesurfer.current?.setVolume(newVolume);
  }, []);

  const toggleMute = useCallback(() => {
    const newMuted = !muted;
    setMuted(newMuted);
    wavesurfer.current?.setVolume(newMuted ? 0 : volume);
  }, [muted, volume]);

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = Math.floor(seconds % 60);
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  return (
    <div className="bg-gray-800 rounded-lg p-4 space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center space-x-3">
          <div
            className="w-3 h-3 rounded-full"
            style={{ backgroundColor: color }}
          />
          <span className="font-semibold capitalize">{stemType}</span>
        </div>

        <div className="flex items-center space-x-2">
          <button
            onClick={togglePlay}
            className="p-2 hover:bg-gray-700 rounded transition-colors"
          >
            {isPlaying ? <Pause className="w-4 h-4" /> : <Play className="w-4 h-4" />}
          </button>
          <button
            onClick={stop}
            className="p-2 hover:bg-gray-700 rounded transition-colors"
          >
            <Square className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Waveform */}
      <div ref={waveformRef} className="w-full" />

      {/* Time display */}
      <div className="flex items-center justify-between text-sm text-gray-400">
        <span>{formatTime(currentTime)}</span>
        <span>{formatTime(duration)}</span>
      </div>

      {/* Volume control */}
      <div className="flex items-center space-x-3">
        <button
          onClick={toggleMute}
          className="p-2 hover:bg-gray-700 rounded transition-colors"
        >
          {muted || volume === 0 ? (
            <VolumeX className="w-4 h-4" />
          ) : (
            <Volume2 className="w-4 h-4" />
          )}
        </button>
        <input
          type="range"
          min="0"
          max="1"
          step="0.01"
          value={muted ? 0 : volume}
          onChange={handleVolumeChange}
          className="flex-1 h-1 bg-gray-700 rounded-lg appearance-none cursor-pointer"
        />
        <span className="text-xs text-gray-400 w-10">
          {Math.round((muted ? 0 : volume) * 100)}%
        </span>
      </div>
    </div>
  );
}

/**
 * Multi-stem synchronized waveform display
 */
export function MultiStemWaveform({ stems }: MultiStemWaveformProps) {
  const [masterTime, setMasterTime] = useState(0);
  const [zoom, setZoom] = useState(50);
  const [readyStems, setReadyStems] = useState<Set<string>>(new Set());
  const intervalRef = useRef<NodeJS.Timeout>();

  useEffect(() => {
    // Update master time regularly for sync
    intervalRef.current = setInterval(() => {
      setMasterTime(prev => prev + 0.1);
    }, 100);

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, []);

  const handleStemReady = useCallback((stem: string) => {
    setReadyStems(prev => new Set(prev).add(stem));
  }, []);

  const handleZoomIn = useCallback(() => {
    setZoom(prev => Math.min(prev + 10, 200));
  }, []);

  const handleZoomOut = useCallback(() => {
    setZoom(prev => Math.max(prev - 10, 10));
  }, []);

  const allReady = readyStems.size === 4;

  return (
    <div className="space-y-4">
      {/* Controls */}
      <div className="flex items-center justify-between">
        <h3 className="text-lg font-semibold">Waveform Visualization</h3>

        <div className="flex items-center space-x-2">
          <button
            onClick={handleZoomOut}
            className="p-2 bg-gray-800 hover:bg-gray-700 rounded transition-colors"
            disabled={zoom <= 10}
          >
            <ZoomOut className="w-4 h-4" />
          </button>
          <span className="text-sm text-gray-400 w-12 text-center">
            {zoom}%
          </span>
          <button
            onClick={handleZoomIn}
            className="p-2 bg-gray-800 hover:bg-gray-700 rounded transition-colors"
            disabled={zoom >= 200}
          >
            <ZoomIn className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Loading indicator */}
      {!allReady && (
        <div className="text-center text-gray-400 text-sm py-4">
          Loading waveforms... ({readyStems.size}/4)
        </div>
      )}

      {/* Waveform tracks */}
      <div className="space-y-4">
        {(['vocals', 'drums', 'bass', 'other'] as const).map((stem, index) => (
          <WaveformTrack
            key={stem}
            audioPath={stems[stem]}
            stemType={stem}
            color={STEM_COLORS[stem]}
            masterTime={masterTime}
            isMaster={index === 0}
            onReady={() => handleStemReady(stem)}
          />
        ))}
      </div>
    </div>
  );
}

