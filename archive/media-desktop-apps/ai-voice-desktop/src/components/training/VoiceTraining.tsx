/**
 * Voice Training Component
 *
 * Complete UI for voice model training:
 * - Dataset upload and validation
 * - Training configuration
 * - Real-time progress monitoring
 * - Quality metrics visualization
 * - Model management
 *
 * @doc.type component
 * @doc.purpose Voice training UI
 * @doc.layer product
 * @doc.pattern Component
 */

import React, { useState, useCallback, useEffect } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { createLogger, invokeWithLog } from '../../utils/logger';
import {
  Upload,
  Play,
  Square,
  CheckCircle,
  AlertCircle,
  TrendingUp,
  Settings,
  Save,
  Folder,
  BarChart
} from 'lucide-react';

interface DatasetStats {
  total_samples: number;
  total_duration: number;
  sample_rate: number;
  avg_duration: number;
  speakers: number;
}

interface TrainingProgress {
  epoch: number;
  total_epochs: number;
  loss: number;
  learning_rate: number;
  time_elapsed: number;
  time_remaining: number;
  current_phase: string;
  message: string;
}

interface TrainingConfig {
  model_name: string;
  dataset_path: string;
  output_dir: string;
  batch_size: number;
  epochs: number;
  learning_rate: number;
  save_every: number;
}

const logger = createLogger('VoiceTraining');

export function VoiceTraining() {
  // State
  const [step, setStep] = useState<'upload' | 'config' | 'training' | 'complete'>('upload');
  const [datasetPath, setDatasetPath] = useState<string | null>(null);
  const [datasetStats, setDatasetStats] = useState<DatasetStats | null>(null);
  const [config, setConfig] = useState<TrainingConfig>({
    model_name: 'rvc-v2',
    dataset_path: '',
    output_dir: '',
    batch_size: 16,
    epochs: 100,
    learning_rate: 0.0001,
    save_every: 10,
  });
  const [training, setTraining] = useState(false);
  const [progress, setProgress] = useState<TrainingProgress | null>(null);
  const [lossHistory, setLossHistory] = useState<Array<{ epoch: number; loss: number }>>([]);
  const [error, setError] = useState<string | null>(null);

  // Select dataset folder
  const handleSelectDataset = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (selected && typeof selected === 'string') {
        setDatasetPath(selected);
        setError(null);

        // Validate dataset
        logger.info('ValidateDataset:request', { datasetPath: selected });
        const validation = await invokeWithLog<any>(logger, 'ai_voice_validate_dataset', {
          datasetPath: selected,
        });

        if (validation.success) {
          setDatasetStats(validation.stats);
          setConfig(prev => ({ ...prev, dataset_path: selected }));
          logger.info('ValidateDataset:success', { stats: validation.stats });
        } else {
          setError(validation.error);
          logger.error('ValidateDataset:failed', { message: validation.error });
        }
      }
    } catch (err: any) {
      logger.error('ValidateDataset:error', {}, err);
      setError(err.message || 'Failed to select dataset');
    }
  }, []);

  // Select output folder
  const handleSelectOutput = useCallback(async () => {
    try {
      const selected = await open({
        directory: true,
        multiple: false,
      });

      if (selected && typeof selected === 'string') {
        setConfig(prev => ({ ...prev, output_dir: selected }));
        logger.info('SelectOutputDir:success', { outputDir: selected });
      }
    } catch (err) {
      logger.error('SelectOutputDir:error', {}, err);
    }
  }, []);

  // Start training
  const handleStartTraining = useCallback(async () => {
    if (!config.dataset_path || !config.output_dir) {
      setError('Please select dataset and output directory');
      return;
    }

    setTraining(true);
    setError(null);
    setLossHistory([]);
    setStep('training');

    try {
      // Start training (would use invoke in real implementation)
      logger.info('StartTraining:request', { config: { ...config, dataset_path: config.dataset_path, output_dir: config.output_dir } });
      await invokeWithLog<void>(logger, 'ai_voice_start_training', { config });
      logger.info('StartTraining:success');

      // Poll for progress
      const interval = setInterval(async () => {
        try {
          const prog = await invokeWithLog<TrainingProgress>(logger, 'ai_voice_get_training_progress');
          setProgress(prog);
          setLossHistory(prev => appendLossPoint(prev, prog));

          if (prog.epoch >= prog.total_epochs) {
            clearInterval(interval);
            setTraining(false);
            setStep('complete');
          }
        } catch (err) {
          logger.error('TrainingProgress:error', {}, err);
        }
      }, 1000);

    } catch (err: any) {
      logger.error('StartTraining:error', {}, err);
      setError(err.message || 'Training failed');
      setTraining(false);
    }
  }, [config]);

  // Stop training
  const handleStopTraining = useCallback(async () => {
    try {
      logger.info('StopTraining:request');
      await invokeWithLog<void>(logger, 'ai_voice_stop_training');
      setTraining(false);
      logger.info('StopTraining:success');
    } catch (err) {
      logger.error('StopTraining:error', {}, err);
    }
  }, []);

  // Format time
  const formatTime = (seconds: number) => {
    const hours = Math.floor(seconds / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);
    return hours > 0
      ? `${hours}h ${mins}m ${secs}s`
      : `${mins}m ${secs}s`;
  };

  return (
    <div className="flex flex-col h-full p-6 space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold">Voice Training</h2>
        <p className="text-gray-400 mt-1">
          Train a custom voice model from your dataset
        </p>
      </div>

      {/* Step indicator */}
      <div className="flex items-center space-x-4">
        {['upload', 'config', 'training', 'complete'].map((s, i) => (
          <div key={s} className="flex items-center">
            <div
              className={`
                w-8 h-8 rounded-full flex items-center justify-center text-sm font-semibold
                ${step === s
                  ? 'bg-purple-600 text-white'
                  : i < ['upload', 'config', 'training', 'complete'].indexOf(step)
                  ? 'bg-green-600 text-white'
                  : 'bg-gray-700 text-gray-400'
                }
              `}
            >
              {i < ['upload', 'config', 'training', 'complete'].indexOf(step) ? (
                <CheckCircle className="w-5 h-5" />
              ) : (
                i + 1
              )}
            </div>
            {i < 3 && (
              <div className="w-12 h-0.5 bg-gray-700 mx-2" />
            )}
          </div>
        ))}
      </div>

      {/* Content */}
      {step === 'upload' && (
        <div className="space-y-6">
          <div
            onClick={handleSelectDataset}
            className="border-2 border-dashed border-gray-700 hover:border-gray-600 rounded-lg p-12 text-center cursor-pointer transition-colors"
          >
            <Upload className="w-16 h-16 mx-auto mb-4 text-gray-400" />
            <h3 className="text-xl font-semibold mb-2">
              {datasetPath ? 'Dataset Selected' : 'Select Training Dataset'}
            </h3>
            <p className="text-gray-400 text-sm mb-4">
              {datasetPath || 'Click to browse for a folder containing audio files'}
            </p>

            {datasetStats && (
              <div className="mt-6 grid grid-cols-2 md:grid-cols-4 gap-4 text-left max-w-2xl mx-auto">
                <div className="bg-gray-800 rounded p-3">
                  <div className="text-gray-400 text-xs">Samples</div>
                  <div className="text-lg font-semibold">{datasetStats.total_samples}</div>
                </div>
                <div className="bg-gray-800 rounded p-3">
                  <div className="text-gray-400 text-xs">Duration</div>
                  <div className="text-lg font-semibold">{Math.round(datasetStats.total_duration)}s</div>
                </div>
                <div className="bg-gray-800 rounded p-3">
                  <div className="text-gray-400 text-xs">Avg Length</div>
                  <div className="text-lg font-semibold">{datasetStats.avg_duration.toFixed(1)}s</div>
                </div>
                <div className="bg-gray-800 rounded p-3">
                  <div className="text-gray-400 text-xs">Sample Rate</div>
                  <div className="text-lg font-semibold">{datasetStats.sample_rate} Hz</div>
                </div>
              </div>
            )}
          </div>

          {error && (
            <div className="bg-red-900/20 border border-red-500 rounded-lg p-4 flex items-start space-x-3">
              <AlertCircle className="w-5 h-5 text-red-500 flex-shrink-0 mt-0.5" />
              <div>
                <h3 className="font-semibold text-red-500">Validation Failed</h3>
                <p className="text-sm text-red-400 mt-1">{error}</p>
              </div>
            </div>
          )}

          {datasetStats && !error && (
            <button
              onClick={() => setStep('config')}
              className="w-full py-3 bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold transition-colors"
            >
              Continue to Configuration
            </button>
          )}
        </div>
      )}

      {step === 'config' && (
        <div className="space-y-6">
          <div className="bg-gray-800 rounded-lg p-6 space-y-4">
            <h3 className="text-lg font-semibold flex items-center">
              <Settings className="w-5 h-5 mr-2" />
              Training Configuration
            </h3>

            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium mb-2">Model Architecture</label>
                <select
                  value={config.model_name}
                  onChange={(e) => setConfig(prev => ({ ...prev, model_name: e.target.value }))}
                  className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
                >
                  <option value="rvc-v2">RVC v2 (Recommended)</option>
                  <option value="vits">VITS</option>
                  <option value="so-vits-svc">SO-VITS-SVC</option>
                </select>
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Epochs</label>
                <input
                  type="number"
                  value={config.epochs}
                  onChange={(e) => setConfig(prev => ({ ...prev, epochs: parseInt(e.target.value) }))}
                  className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
                  min="10"
                  max="1000"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Batch Size</label>
                <input
                  type="number"
                  value={config.batch_size}
                  onChange={(e) => setConfig(prev => ({ ...prev, batch_size: parseInt(e.target.value) }))}
                  className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
                  min="1"
                  max="64"
                />
              </div>

              <div>
                <label className="block text-sm font-medium mb-2">Learning Rate</label>
                <input
                  type="number"
                  value={config.learning_rate}
                  onChange={(e) => setConfig(prev => ({ ...prev, learning_rate: parseFloat(e.target.value) }))}
                  className="w-full bg-gray-700 border border-gray-600 rounded px-3 py-2"
                  min="0.00001"
                  max="0.01"
                  step="0.00001"
                />
              </div>

              <div className="md:col-span-2">
                <label className="block text-sm font-medium mb-2">Output Directory</label>
                <div className="flex space-x-2">
                  <input
                    type="text"
                    value={config.output_dir}
                    readOnly
                    placeholder="Click to select..."
                    className="flex-1 bg-gray-700 border border-gray-600 rounded px-3 py-2"
                  />
                  <button
                    onClick={handleSelectOutput}
                    className="px-4 py-2 bg-gray-700 hover:bg-gray-600 rounded transition-colors"
                  >
                    <Folder className="w-5 h-5" />
                  </button>
                </div>
              </div>
            </div>
          </div>

          <div className="flex space-x-4">
            <button
              onClick={() => setStep('upload')}
              className="flex-1 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg font-semibold transition-colors"
            >
              Back
            </button>
            <button
              onClick={handleStartTraining}
              disabled={!config.output_dir}
              className="flex-1 py-3 bg-purple-600 hover:bg-purple-700 disabled:bg-gray-700 disabled:cursor-not-allowed rounded-lg font-semibold transition-colors"
            >
              Start Training
            </button>
          </div>
        </div>
      )}

      {step === 'training' && progress && (
        <div className="space-y-6">
          <div className="bg-gray-800 rounded-lg p-6 space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="text-lg font-semibold">Training in Progress</h3>
              <div className="flex items-center space-x-2">
                <button
                  onClick={handleStopTraining}
                  className="px-4 py-2 bg-red-600 hover:bg-red-700 rounded transition-colors text-sm font-medium"
                >
                  <Square className="w-4 h-4 inline mr-1" />
                  Stop
                </button>
              </div>
            </div>

            {/* Progress */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm text-gray-400">
                  Epoch {progress.epoch} / {progress.total_epochs}
                </span>
                <span className="text-sm font-semibold">
                  {((progress.epoch / progress.total_epochs) * 100).toFixed(0)}%
                </span>
              </div>
              <div className="h-2 bg-gray-700 rounded-full overflow-hidden">
                <div
                  className="h-full bg-purple-600 transition-all duration-300"
                  style={{ width: `${(progress.epoch / progress.total_epochs) * 100}%` }}
                />
              </div>
            </div>

            {/* Metrics */}
            <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
              <div className="bg-gray-900 rounded p-3">
                <div className="text-gray-400 text-xs">Loss</div>
                <div className="text-lg font-semibold">{progress.loss.toFixed(4)}</div>
              </div>
              <div className="bg-gray-900 rounded p-3">
                <div className="text-gray-400 text-xs">Learning Rate</div>
                <div className="text-lg font-semibold">{progress.learning_rate.toFixed(6)}</div>
              </div>
              <div className="bg-gray-900 rounded p-3">
                <div className="text-gray-400 text-xs">Elapsed</div>
                <div className="text-lg font-semibold">{formatTime(progress.time_elapsed)}</div>
              </div>
              <div className="bg-gray-900 rounded p-3">
                <div className="text-gray-400 text-xs">Remaining</div>
                <div className="text-lg font-semibold">{formatTime(progress.time_remaining)}</div>
              </div>
            </div>

            {/* Current phase */}
            <div className="bg-gray-900 rounded p-4">
              <div className="text-sm text-gray-400 mb-1">Current Phase</div>
              <div className="font-medium capitalize">{progress.current_phase}</div>
              <div className="text-sm text-gray-400 mt-1">{progress.message}</div>
            </div>
          </div>

          <div className="bg-gray-800 rounded-lg p-6">
            <h4 className="font-semibold mb-4 flex items-center">
              <BarChart className="w-5 h-5 mr-2" />
              Training Loss
            </h4>
            <div className="h-48 bg-gray-900 rounded p-4">
              {lossHistory.length > 1 ? (
                <svg className="w-full h-full" viewBox="0 0 320 140" role="img" aria-label="Training loss trend">
                  <g stroke="#374151" strokeWidth="1">
                    {[0, 1, 2, 3].map(line => (
                      <line
                        key={line}
                        x1="0"
                        x2="320"
                        y1={line * 35}
                        y2={line * 35}
                      />
                    ))}
                  </g>
                  <polyline
                    fill="none"
                    stroke="#a855f7"
                    strokeWidth="3"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    points={lossChartPoints(lossHistory)}
                  />
                </svg>
              ) : (
                <div className="h-full flex items-center justify-center">
                  <TrendingUp className="w-12 h-12 text-gray-600" />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {step === 'complete' && (
        <div className="text-center py-12">
          <CheckCircle className="w-16 h-16 mx-auto mb-4 text-green-500" />
          <h3 className="text-2xl font-bold mb-2">Training Complete!</h3>
          <p className="text-gray-400 mb-6">
            Your voice model has been trained successfully
          </p>
          <div className="flex justify-center space-x-4">
            <button
              onClick={() => setStep('upload')}
              className="px-6 py-3 bg-gray-700 hover:bg-gray-600 rounded-lg font-semibold transition-colors"
            >
              Train Another Model
            </button>
            <button
              className="px-6 py-3 bg-purple-600 hover:bg-purple-700 rounded-lg font-semibold transition-colors"
            >
              Test Model
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

function appendLossPoint(
  history: Array<{ epoch: number; loss: number }>,
  progress: TrainingProgress
): Array<{ epoch: number; loss: number }> {
  const point = { epoch: progress.epoch, loss: progress.loss };
  const withoutDuplicate = history.filter(item => item.epoch !== point.epoch);
  return [...withoutDuplicate, point].slice(-120);
}

function lossChartPoints(history: Array<{ epoch: number; loss: number }>): string {
  const losses = history.map(point => point.loss);
  const min = Math.min(...losses);
  const max = Math.max(...losses);
  const span = Math.max(0.000001, max - min);
  const lastIndex = Math.max(1, history.length - 1);

  return history
    .map((point, index) => {
      const x = (index / lastIndex) * 320;
      const y = 130 - ((point.loss - min) / span) * 120;
      return `${x.toFixed(1)},${y.toFixed(1)}`;
    })
    .join(' ');
}
