/**
 * Quality Dashboard Component
 *
 * Displays audio quality metrics:
 * - MOS (Mean Opinion Score)
 * - WER (Word Error Rate)
 * - Speaker Similarity
 * - SNR (Signal-to-Noise Ratio)
 */

import React, { useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { createLogger, invokeWithLog } from '../../utils/logger';

const logger = createLogger('QualityDashboard');

interface QualityMetrics {
  mean_opinion_score: number;
  word_error_rate?: number | null;
  speaker_similarity_score?: number | null;
  signal_to_noise_ratio_db: number;
  perceptual_evaluation_score?: number | null;
  short_time_intelligibility?: number | null;
}

export const QualityDashboard: React.FC = () => {
  const [metrics, setMetrics] = useState<QualityMetrics | null>(null);
  const [loading, setLoading] = useState(false);
  const [audioPath, setAudioPath] = useState<string>('');
  const [referenceText, setReferenceText] = useState<string>('');
  const [referenceAudioPath, setReferenceAudioPath] = useState<string>('');

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

  const handleSelectReferenceAudio = async () => {
    const selected = await open({
      filters: [{
        name: 'Audio',
        extensions: ['wav', 'mp3', 'flac', 'm4a']
      }]
    });

    if (selected && typeof selected === 'string') {
      setReferenceAudioPath(selected);
    }
  };

  const handleAssess = async () => {
    if (!audioPath) {
      alert('Please select an audio file');
      return;
    }

    setLoading(true);
    try {
      logger.info('AssessQuality:request', { audioPath, hasReferenceText: Boolean(referenceText), hasReferenceAudio: Boolean(referenceAudioPath) });
      const result = await invokeWithLog<QualityMetrics>(logger, 'analyze_audio_quality', {
        audioFilePath: audioPath,
        referenceTranscript: referenceText || null,
        referenceAudioFilePath: referenceAudioPath || null,
      });

      setMetrics(result);
      logger.info('AssessQuality:success', {
        mosScore: result.mean_opinion_score,
        snr: result.signal_to_noise_ratio_db,
      });
    } catch (error) {
      logger.error('AssessQuality:error', { audioPath }, error);
      alert('Failed to assess quality');
    } finally {
      setLoading(false);
    }
  };

  const getMOSColor = (score: number): string => {
    if (score >= 4.0) return 'text-green-600';
    if (score >= 3.0) return 'text-yellow-600';
    return 'text-red-600';
  };

  const getMOSLabel = (score: number): string => {
    if (score >= 4.0) return 'Excellent';
    if (score >= 3.5) return 'Good';
    if (score >= 3.0) return 'Fair';
    if (score >= 2.0) return 'Poor';
    return 'Bad';
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
          Quality Assessment
        </h2>
        <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
          Analyze audio quality metrics
        </p>
      </div>

      {/* Input Section */}
      <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200
                    dark:border-gray-700 p-6 space-y-4">
        <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
          Input
        </h3>

        {/* Audio File */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Audio File *
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
              aria-label="Browse audio file"
              onClick={handleSelectAudio}
              className="px-4 py-2 text-sm font-medium text-white bg-purple-600
                       hover:bg-purple-700 rounded-lg transition-colors"
            >
              Browse
            </button>
          </div>
        </div>

        {/* Reference Text (Optional) */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Reference Text (Optional - for WER)
          </label>
          <textarea
            value={referenceText}
            onChange={(e) => setReferenceText(e.target.value)}
            placeholder="Enter the expected transcript..."
            rows={3}
            className="w-full px-4 py-2 border border-gray-300 dark:border-gray-600
                     rounded-lg bg-white dark:bg-gray-800 text-gray-900 dark:text-white
                     focus:ring-2 focus:ring-purple-600 focus:border-transparent"
          />
        </div>

        {/* Reference Audio (Optional) */}
        <div>
          <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-2">
            Reference Audio (Optional - for Speaker Similarity)
          </label>
          <div className="flex gap-2">
            <input
              type="text"
              value={referenceAudioPath}
              readOnly
              placeholder="Select reference audio..."
              className="flex-1 px-4 py-2 border border-gray-300 dark:border-gray-600
                       rounded-lg bg-gray-50 dark:bg-gray-900 text-gray-900 dark:text-white"
            />
            <button
              aria-label="Browse reference audio"
              onClick={handleSelectReferenceAudio}
              className="px-4 py-2 text-sm font-medium text-gray-700 dark:text-gray-300
                       border border-gray-300 dark:border-gray-600 rounded-lg
                       hover:bg-gray-50 dark:hover:bg-gray-700 transition-colors"
            >
              Browse
            </button>
          </div>
        </div>

        {/* Assess Button */}
        <button
          onClick={handleAssess}
          disabled={!audioPath || loading}
          className="w-full px-6 py-3 text-sm font-medium text-white bg-purple-600
                   hover:bg-purple-700 rounded-lg disabled:opacity-50
                   disabled:cursor-not-allowed transition-colors"
        >
          {loading ? 'Assessing...' : 'Assess Quality'}
        </button>
      </div>

      {/* Results Section */}
      {loading && (
        <div className="flex items-center justify-center py-12" role="status" aria-label="Assessing audio quality">
          <div className="text-center">
            <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600 mx-auto mb-4"></div>
            <p className="text-sm text-gray-600 dark:text-gray-400">
              Analyzing audio quality...
            </p>
          </div>
        </div>
      )}

      {metrics && !loading && (
        <div className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200
                      dark:border-gray-700 p-6">
          <h3 className="text-lg font-semibold text-gray-900 dark:text-white mb-6">
            Quality Metrics
          </h3>

          <div className="grid gap-6 md:grid-cols-2">
            {/* MOS Score */}
            <div className="p-6 bg-gray-50 dark:bg-gray-900 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                  MOS Score
                </span>
                <span className={`text-xs font-medium ${getMOSColor(metrics.mos_score)}`}>
                  {getMOSLabel(metrics.mean_opinion_score)}
                </span>
              </div>
              <div className={`text-3xl font-bold ${getMOSColor(metrics.mean_opinion_score)}`}>
                {metrics.mean_opinion_score.toFixed(2)}
                <span className="text-lg text-gray-500 dark:text-gray-400"> / 5.0</span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                Mean Opinion Score (subjective quality)
              </p>
            </div>

            {/* SNR */}
            <div className="p-6 bg-gray-50 dark:bg-gray-900 rounded-lg">
              <div className="flex items-center justify-between mb-2">
                <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                  SNR
                </span>
              </div>
              <div className="text-3xl font-bold text-blue-600">
                {metrics.signal_to_noise_ratio_db.toFixed(1)}
                <span className="text-lg text-gray-500 dark:text-gray-400"> dB</span>
              </div>
              <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                Signal-to-Noise Ratio
              </p>
            </div>

            {/* WER */}
            {metrics.word_error_rate !== undefined && metrics.word_error_rate !== null && (
              <div className="p-6 bg-gray-50 dark:bg-gray-900 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                    WER
                  </span>
                </div>
                <div className="text-3xl font-bold text-orange-600">
                  {(metrics.word_error_rate * 100).toFixed(1)}
                  <span className="text-lg text-gray-500 dark:text-gray-400"> %</span>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  Word Error Rate (lower is better)
                </p>
              </div>
            )}

            {/* Speaker Similarity */}
            {metrics.speaker_similarity_score !== undefined && metrics.speaker_similarity_score !== null && (
              <div className="p-6 bg-gray-50 dark:bg-gray-900 rounded-lg">
                <div className="flex items-center justify-between mb-2">
                  <span className="text-sm font-medium text-gray-600 dark:text-gray-400">
                    Speaker Similarity
                  </span>
                </div>
                <div className="text-3xl font-bold text-purple-600">
                  {(metrics.speaker_similarity_score * 100).toFixed(0)}
                  <span className="text-lg text-gray-500 dark:text-gray-400"> %</span>
                </div>
                <p className="text-xs text-gray-500 dark:text-gray-400 mt-2">
                  Voice similarity (higher is better)
                </p>
              </div>
            )}
          </div>

          {/* Overall Assessment */}
          <div className="mt-6 p-4 bg-purple-50 dark:bg-purple-900/20 rounded-lg">
            <h4 className="text-sm font-semibold text-purple-900 dark:text-purple-100 mb-2">
              Overall Assessment
            </h4>
            <p className="text-sm text-purple-800 dark:text-purple-200">
              {metrics.mean_opinion_score >= 4.0
                ? 'Excellent audio quality. Ready for production use.'
                : metrics.mean_opinion_score >= 3.0
                ? 'Good audio quality. Minor improvements possible.'
                : 'Audio quality could be improved. Consider noise reduction or re-recording.'}
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
