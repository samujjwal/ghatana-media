/**
 * Model Manager UI Component
 *
 * Provides interface for:
 * - Downloading ML models
 * - Viewing downloaded models
 * - Managing cache
 * - Progress tracking
 */

import React, { useState, useEffect } from 'react';
import { createLogger, invokeWithLog } from '../../utils/logger';

const logger = createLogger('ModelManager');

interface ModelInfo {
  id: string;
  name: string;
  version: string;
  size_mb: number;
  description: string;
  downloaded: boolean;
}

export const ModelManager: React.FC = () => {
  const [models, setModels] = useState<ModelInfo[]>([]);
  const [downloading, setDownloading] = useState<Map<string, number>>(new Map());
  const [cacheSize, setCacheSize] = useState<number>(0);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    loadModels();
  }, []);

  const loadModels = async () => {
    try {
      setLoading(true);
      logger.info('LoadModels:request');
      const available = await invokeWithLog<string[]>(logger, 'list_available_models');
      const downloaded = await invokeWithLog<string[]>(logger, 'list_downloaded_models');
      const size = await invokeWithLog<number>(logger, 'get_model_cache_size');

      const modelInfos: ModelInfo[] = available.map(id => ({
        id,
        name: id,
        version: 'v4',
        size_mb: getModelSize(id),
        description: getModelDescription(id),
        downloaded: downloaded.includes(id),
      }));

      setModels(modelInfos);
      setCacheSize(typeof size === 'number' && Number.isFinite(size) ? size : 0);
      logger.info('LoadModels:success', { available: available.length, downloaded: downloaded.length, cacheSize: size });
    } catch (error) {
      logger.error('LoadModels:error', {}, error);
    } finally {
      setLoading(false);
    }
  };

  const handleDownload = async (modelId: string) => {
    try {
      logger.info('DownloadModel:request', { modelId });
      setDownloading(prev => new Map(prev).set(modelId, 0));

      logger.info('DownloadModel:invoke', { command: 'download_model', model_id: modelId });
      await invokeWithLog<void>(logger, 'download_model', { model_id: modelId });

      setDownloading(prev => {
        const next = new Map(prev);
        next.delete(modelId);
        return next;
      });

      await loadModels();
      logger.info('DownloadModel:success', { modelId });
    } catch (error) {
      logger.error('DownloadModel:error', { modelId }, error);
      setDownloading(prev => {
        const next = new Map(prev);
        next.delete(modelId);
        return next;
      });
    }
  };

  const handleDelete = async (modelId: string) => {
    if (!confirm(`Delete model ${modelId}?`)) return;

    try {
      logger.info('DeleteModel:request', { modelId });
      logger.info('DeleteModel:invoke', { command: 'delete_model', model_id: modelId });
      await invokeWithLog<void>(logger, 'delete_model', { model_id: modelId });
      await loadModels();
      logger.info('DeleteModel:success', { modelId });
    } catch (error) {
      logger.error('DeleteModel:error', { modelId }, error);
    }
  };

  const handleClearCache = async () => {
    if (!confirm('Clear all cached models? This cannot be undone.')) return;

    try {
      logger.info('ClearCache:request');
      await invokeWithLog<void>(logger, 'clear_model_cache');
      await loadModels();
      logger.info('ClearCache:success');
    } catch (error) {
      logger.error('ClearCache:error', {}, error);
    }
  };

  const getModelSize = (id: string): number => {
    if (id.includes('demucs')) return 2400;
    if (id.includes('whisper')) return 140;
    if (id.includes('vits')) return 500;
    if (id.includes('rvc')) return 200;
    return 50;
  };

  const getModelDescription = (id: string): string => {
    if (id.includes('htdemucs')) return 'Stem separation (vocals, drums, bass, other)';
    if (id.includes('whisper')) return 'Speech recognition for WER calculation';
    if (id.includes('vits')) return 'Voice training base model';
    if (id.includes('rvc')) return 'Voice conversion model';
    if (id.includes('mosnet')) return 'Quality prediction (MOS)';
    if (id.includes('ecapa')) return 'Speaker verification';
    return 'ML model';
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64" role="status" aria-label="Loading models">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-purple-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex justify-between items-center">
        <div>
          <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
            Model Manager
          </h2>
          <p className="text-sm text-gray-500 dark:text-gray-400 mt-1">
            Download and manage ML models
          </p>
        </div>

        <div className="flex items-center gap-4">
          <div className="text-sm text-gray-600 dark:text-gray-400">
            Cache: {cacheSize.toFixed(1)} MB
          </div>
          <button
            onClick={handleClearCache}
            className="px-4 py-2 text-sm font-medium text-red-600 hover:text-red-700
                     border border-red-300 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
          >
            Clear Cache
          </button>
        </div>
      </div>

      {/* Models List */}
      <div className="grid gap-4">
        {models.map(model => {
          const modelId = model.id;
          const progress = downloading.get(modelId);
          const isDownloading = progress !== undefined;

          return (
            <div
              key={modelId}
              className="bg-white dark:bg-gray-800 rounded-lg border border-gray-200
                       dark:border-gray-700 p-6 hover:shadow-md transition-shadow"
            >
              <div className="flex items-start justify-between">
                <div className="flex-1">
                  <h3 className="text-lg font-semibold text-gray-900 dark:text-white">
                    {model.name}
                  </h3>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">
                    {model.description}
                  </p>
                  <div className="flex items-center gap-4 mt-3 text-sm text-gray-500">
                    <span>Version: {model.version}</span>
                    <span>•</span>
                    <span>Size: {model.size_mb.toFixed(0)} MB</span>
                  </div>

                  {isDownloading && (
                    <div className="mt-4">
                      <div className="flex items-center justify-between text-sm mb-2">
                        <span className="text-gray-600 dark:text-gray-400">
                          Downloading...
                        </span>
                        <span className="text-purple-600 font-medium">
                          {progress.toFixed(0)}%
                        </span>
                      </div>
                      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                        <div
                          className="bg-purple-600 h-2 rounded-full transition-all duration-300"
                          style={{ width: `${progress}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>

                <div className="ml-6">
                  {model.downloaded ? (
                    <div className="flex flex-col gap-2">
                      <div className="flex items-center gap-2 text-green-600 text-sm font-medium">
                        <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 20 20">
                          <path fillRule="evenodd" d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z" clipRule="evenodd" />
                        </svg>
                        Downloaded
                      </div>
                      <button
                        onClick={() => handleDelete(modelId)}
                        className="px-4 py-2 text-sm font-medium text-red-600 hover:text-red-700
                                 border border-red-300 rounded-lg hover:bg-red-50 dark:hover:bg-red-900/20"
                      >
                        Delete
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => handleDownload(modelId)}
                      disabled={isDownloading}
                      className="px-6 py-2 text-sm font-medium text-white bg-purple-600
                               hover:bg-purple-700 rounded-lg disabled:opacity-50
                               disabled:cursor-not-allowed transition-colors"
                    >
                      {isDownloading ? 'Downloading...' : 'Download'}
                    </button>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
