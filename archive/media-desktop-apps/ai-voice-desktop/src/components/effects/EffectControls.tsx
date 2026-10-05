/**
 * Effect Controls UI Component
 *
 * Provides interface for:
 * - Reverb controls
 * - Delay controls
 * - Parametric EQ (5-band)
 * - Compressor controls
 * - Limiter controls
 * - Effect chain management
 * - Preset system
 */

import React, { useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { createLogger, invokeWithLog } from '../../utils/logger';

const logger = createLogger('EffectControls');

interface ReverbConfig {
  room_size: number;
  damping: number;
  wet: number;
  dry: number;
}

interface DelayConfig {
  time: number;
  feedback: number;
  mix: number;
}

interface EQBand {
  freq: number;
  gain: number;
  q: number;
}

interface EQConfig {
  bands: EQBand[];
}

interface CompressorConfig {
  threshold: number;
  ratio: number;
  attack: number;
  release: number;
  makeup_gain: number;
}

interface LimiterConfig {
  threshold: number;
  ceiling: number;
  release: number;
}

interface EffectsConfig {
  reverb?: ReverbConfig;
  delay?: DelayConfig;
  eq?: EQConfig;
  compressor?: CompressorConfig;
  limiter?: LimiterConfig;
}

export const EffectControls: React.FC = () => {
  const [audioPath, setAudioPath] = useState('');
  const [processing, setProcessing] = useState(false);

  // Effect states
  const [reverbEnabled, setReverbEnabled] = useState(false);
  const [reverb, setReverb] = useState<ReverbConfig>({
    room_size: 0.5,
    damping: 0.5,
    wet: 0.3,
    dry: 0.7,
  });

  const [delayEnabled, setDelayEnabled] = useState(false);
  const [delay, setDelay] = useState<DelayConfig>({
    time: 0.5,
    feedback: 0.3,
    mix: 0.5,
  });

  const [eqEnabled, setEqEnabled] = useState(false);
  const [eq, setEq] = useState<EQConfig>({
    bands: [
      { freq: 80, gain: 0, q: 1.0 },
      { freq: 250, gain: 0, q: 1.0 },
      { freq: 1000, gain: 0, q: 1.0 },
      { freq: 4000, gain: 0, q: 1.0 },
      { freq: 12000, gain: 0, q: 1.0 },
    ],
  });

  const [compressorEnabled, setCompressorEnabled] = useState(false);
  const [compressor, setCompressor] = useState<CompressorConfig>({
    threshold: -20,
    ratio: 4.0,
    attack: 0.005,
    release: 0.1,
    makeup_gain: 0,
  });

  const [limiterEnabled, setLimiterEnabled] = useState(false);
  const [limiter, setLimiter] = useState<LimiterConfig>({
    threshold: -0.1,
    ceiling: 0.0,
    release: 0.01,
  });

  const handleSelectAudio = async () => {
    const selected = await open({
      filters: [{
        name: 'Audio',
        extensions: ['wav', 'mp3', 'flac', 'm4a']
      }]
    });

    if (selected && typeof selected === 'string') {
      setAudioPath(selected);
    }
  };

  const handleProcess = async () => {
    if (!audioPath) {
      alert('Please select an audio file');
      return;
    }

    const outputPath = await save({
      defaultPath: 'processed.wav',
      filters: [{
        name: 'Audio',
        extensions: ['wav']
      }]
    });

    if (!outputPath) return;

    setProcessing(true);
    try {
      const effectsConfig: EffectsConfig = {};

      if (reverbEnabled) effectsConfig.reverb = reverb;
      if (delayEnabled) effectsConfig.delay = delay;
      if (eqEnabled) effectsConfig.eq = eq;
      if (compressorEnabled) effectsConfig.compressor = compressor;
      if (limiterEnabled) effectsConfig.limiter = limiter;

      logger.info('ApplyEffects:request', { audioPath, outputPath });
      await invokeWithLog<void>(logger, 'process_audio_effects', {
        inputAudioPath: audioPath,
        outputAudioPath: outputPath,
        effectsConfiguration: effectsConfig,
        audioSampleRate: 44100,
      });

      logger.info('ApplyEffects:success', { outputPath });

      alert('Effects applied successfully!');
    } catch (error) {
      logger.error('ApplyEffects:error', { audioPath, outputPath }, error);
      alert('Failed to apply effects');
    } finally {
      setProcessing(false);
    }
  };

  const updateEQBand = (index: number, field: keyof EQBand, value: number) => {
    setEq(prev => ({
      ...prev,
      bands: prev.bands.map((band, i) =>
        i === index ? { ...band, [field]: value } : band
      ),
    }));
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
          Audio Effects
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Apply professional audio effects
        </p>
      </div>

      {/* Audio Input */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200
                    dark:border-gray-700 p-6">
        <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
          Input Audio File
        </label>
        <div className="flex gap-2">
          <input
            type="text"
            value={audioPath}
            readOnly
            placeholder="Select audio file..."
            className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600
                     rounded-lg bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white"
          />
          <button
            onClick={handleSelectAudio}
            className="px-4 py-2 text-sm font-medium text-white bg-purple-600
                     hover:bg-purple-700 rounded-lg transition-colors"
          >
            Browse
          </button>
        </div>
      </div>

      {/* Effects Stack */}
      <div className="space-y-4">
        {/* Reverb */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200
                      dark:border-gray-700 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Reverb
            </h3>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={reverbEnabled}
                onChange={(e) => setReverbEnabled(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4
                            peer-focus:ring-purple-300 dark:peer-focus:ring-purple-800 rounded-full
                            peer dark:bg-gray-700 peer-checked:after:translate-x-full
                            peer-checked:after:border-white after:content-[''] after:absolute
                            after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300
                            after:border after:rounded-full after:h-5 after:w-5 after:transition-all
                            dark:border-gray-600 peer-checked:bg-purple-600"></div>
            </label>
          </div>

          {reverbEnabled && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Room Size: {reverb.room_size.toFixed(2)}
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={reverb.room_size}
                  onChange={(e) => setReverb({ ...reverb, room_size: parseFloat(e.target.value) })}
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Damping: {reverb.damping.toFixed(2)}
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={reverb.damping}
                  onChange={(e) => setReverb({ ...reverb, damping: parseFloat(e.target.value) })}
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Wet: {reverb.wet.toFixed(2)}
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={reverb.wet}
                  onChange={(e) => setReverb({ ...reverb, wet: parseFloat(e.target.value) })}
                  className="w-full"
                />
              </div>
            </div>
          )}
        </div>

        {/* Delay */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200
                      dark:border-gray-700 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Delay
            </h3>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={delayEnabled}
                onChange={(e) => setDelayEnabled(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4
                            peer-focus:ring-purple-300 dark:peer-focus:ring-purple-800 rounded-full
                            peer dark:bg-gray-700 peer-checked:after:translate-x-full
                            peer-checked:after:border-white after:content-[''] after:absolute
                            after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300
                            after:border after:rounded-full after:h-5 after:w-5 after:transition-all
                            dark:border-gray-600 peer-checked:bg-purple-600"></div>
            </label>
          </div>

          {delayEnabled && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Time: {delay.time.toFixed(2)}s
                </label>
                <input
                  type="range"
                  min="0.01"
                  max="2"
                  step="0.01"
                  value={delay.time}
                  onChange={(e) => setDelay({ ...delay, time: parseFloat(e.target.value) })}
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Feedback: {delay.feedback.toFixed(2)}
                </label>
                <input
                  type="range"
                  min="0"
                  max="0.95"
                  step="0.01"
                  value={delay.feedback}
                  onChange={(e) => setDelay({ ...delay, feedback: parseFloat(e.target.value) })}
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Mix: {delay.mix.toFixed(2)}
                </label>
                <input
                  type="range"
                  min="0"
                  max="1"
                  step="0.01"
                  value={delay.mix}
                  onChange={(e) => setDelay({ ...delay, mix: parseFloat(e.target.value) })}
                  className="w-full"
                />
              </div>
            </div>
          )}
        </div>

        {/* EQ */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200
                      dark:border-gray-700 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              5-Band Parametric EQ
            </h3>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={eqEnabled}
                onChange={(e) => setEqEnabled(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4
                            peer-focus:ring-purple-300 dark:peer-focus:ring-purple-800 rounded-full
                            peer dark:bg-gray-700 peer-checked:after:translate-x-full
                            peer-checked:after:border-white after:content-[''] after:absolute
                            after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300
                            after:border after:rounded-full after:h-5 after:w-5 after:transition-all
                            dark:border-gray-600 peer-checked:bg-purple-600"></div>
            </label>
          </div>

          {eqEnabled && (
            <div className="space-y-6">
              {eq.bands.map((band, index) => (
                <div key={index} className="p-4 bg-gray-50 dark:bg-gray-900 rounded-lg">
                  <div className="text-sm font-medium text-gray-700 dark:text-gray-300 mb-3">
                    Band {index + 1}: {band.freq}Hz
                  </div>
                  <div className="space-y-3">
                    <div>
                      <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                        Gain: {band.gain.toFixed(1)} dB
                      </label>
                      <input
                        type="range"
                        min="-12"
                        max="12"
                        step="0.1"
                        value={band.gain}
                        onChange={(e) => updateEQBand(index, 'gain', parseFloat(e.target.value))}
                        className="w-full"
                      />
                    </div>
                    <div>
                      <label className="block text-xs text-gray-600 dark:text-gray-400 mb-1">
                        Q: {band.q.toFixed(1)}
                      </label>
                      <input
                        type="range"
                        min="0.1"
                        max="10"
                        step="0.1"
                        value={band.q}
                        onChange={(e) => updateEQBand(index, 'q', parseFloat(e.target.value))}
                        className="w-full"
                      />
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Compressor */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200
                      dark:border-gray-700 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Compressor
            </h3>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={compressorEnabled}
                onChange={(e) => setCompressorEnabled(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4
                            peer-focus:ring-purple-300 dark:peer-focus:ring-purple-800 rounded-full
                            peer dark:bg-gray-700 peer-checked:after:translate-x-full
                            peer-checked:after:border-white after:content-[''] after:absolute
                            after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300
                            after:border after:rounded-full after:h-5 after:w-5 after:transition-all
                            dark:border-gray-600 peer-checked:bg-purple-600"></div>
            </label>
          </div>

          {compressorEnabled && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Threshold: {compressor.threshold.toFixed(1)} dB
                </label>
                <input
                  type="range"
                  min="-60"
                  max="0"
                  step="0.1"
                  value={compressor.threshold}
                  onChange={(e) => setCompressor({ ...compressor, threshold: parseFloat(e.target.value) })}
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Ratio: {compressor.ratio.toFixed(1)}:1
                </label>
                <input
                  type="range"
                  min="1"
                  max="20"
                  step="0.1"
                  value={compressor.ratio}
                  onChange={(e) => setCompressor({ ...compressor, ratio: parseFloat(e.target.value) })}
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Makeup Gain: {compressor.makeup_gain.toFixed(1)} dB
                </label>
                <input
                  type="range"
                  min="0"
                  max="24"
                  step="0.1"
                  value={compressor.makeup_gain}
                  onChange={(e) => setCompressor({ ...compressor, makeup_gain: parseFloat(e.target.value) })}
                  className="w-full"
                />
              </div>
            </div>
          )}
        </div>

        {/* Limiter */}
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200
                      dark:border-gray-700 p-6">
          <div className="flex items-center justify-between mb-4">
            <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
              Limiter
            </h3>
            <label className="relative inline-flex items-center cursor-pointer">
              <input
                type="checkbox"
                checked={limiterEnabled}
                onChange={(e) => setLimiterEnabled(e.target.checked)}
                className="sr-only peer"
              />
              <div className="w-11 h-6 bg-gray-200 peer-focus:outline-none peer-focus:ring-4
                            peer-focus:ring-purple-300 dark:peer-focus:ring-purple-800 rounded-full
                            peer dark:bg-gray-700 peer-checked:after:translate-x-full
                            peer-checked:after:border-white after:content-[''] after:absolute
                            after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300
                            after:border after:rounded-full after:h-5 after:w-5 after:transition-all
                            dark:border-gray-600 peer-checked:bg-purple-600"></div>
            </label>
          </div>

          {limiterEnabled && (
            <div className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Threshold: {limiter.threshold.toFixed(1)} dB
                </label>
                <input
                  type="range"
                  min="-12"
                  max="0"
                  step="0.1"
                  value={limiter.threshold}
                  onChange={(e) => setLimiter({ ...limiter, threshold: parseFloat(e.target.value) })}
                  className="w-full"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
                  Ceiling: {limiter.ceiling.toFixed(1)} dB
                </label>
                <input
                  type="range"
                  min="-3"
                  max="0"
                  step="0.1"
                  value={limiter.ceiling}
                  onChange={(e) => setLimiter({ ...limiter, ceiling: parseFloat(e.target.value) })}
                  className="w-full"
                />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Process Button */}
      <button
        onClick={handleProcess}
        disabled={!audioPath || processing}
        className="w-full px-6 py-3 text-sm font-medium text-white bg-purple-600
                 hover:bg-purple-700 rounded-lg disabled:opacity-50
                 disabled:cursor-not-allowed transition-colors"
      >
        {processing ? 'Processing...' : 'Apply Effects'}
      </button>
    </div>
  );
};
