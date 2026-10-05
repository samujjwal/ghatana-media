/**
 * @doc.type component
 * @doc.purpose Settings panel with grouped, prioritized settings and progressive disclosure (AV-010.3)
 * @doc.layer application
 * @doc.pattern Settings, ProgressiveDisclosure
 */

import React, { useCallback, useState } from 'react';
import { Card, Button, Input } from '@audio-video/ui';
import ProgressiveDisclosure from './ProgressiveDisclosure';

interface AppSettings {
  theme: 'light' | 'dark' | 'auto';
  language: string;
  fontSize: 'small' | 'medium' | 'large';
  enableGPU: boolean;
  maxConcurrentRequests: number;
  cacheSize: number;
  sttEndpoint: string;
  ttsEndpoint: string;
  aiVoiceEndpoint: string;
}

const DEFAULT_SETTINGS: AppSettings = {
  theme: 'auto',
  language: 'en-US',
  fontSize: 'medium',
  enableGPU: false,
  maxConcurrentRequests: 5,
  cacheSize: 1024,
  sttEndpoint: 'http://localhost:50051',
  ttsEndpoint: 'http://localhost:50052',
  aiVoiceEndpoint: 'http://localhost:50053',
};

const SettingsPanel: React.FC = () => {
  const [settings, setSettings] = useState<AppSettings>(DEFAULT_SETTINGS);
  const [saveMessage, setSaveMessage] = useState<string | null>(null);

  const updateSetting = useCallback(
    <K extends keyof AppSettings>(key: K, value: AppSettings[K]): void => {
      setSettings((prev) => ({ ...prev, [key]: value }));
    },
    [],
  );

  const handleSave = useCallback((): void => {
    setSaveMessage('Settings saved locally. Service endpoint persistence is not wired yet.');
    setTimeout(() => setSaveMessage(null), 4000);
  }, []);

  return (
    <div className="space-y-6" data-testid="settings-panel">
      <Card title="Settings" subtitle="Configure application preferences">
        <div className="space-y-6">
          {saveMessage && (
            <div
              role="status"
              aria-live="polite"
              className="rounded-md border border-green-200 bg-green-50 px-3 py-2 text-sm text-green-700"
            >
              {saveMessage}
            </div>
          )}

          {/* ── Priority 1: Appearance ────────────────────────────────── */}
          <section aria-labelledby="settings-appearance-heading">
            <h3
              id="settings-appearance-heading"
              className="text-base font-semibold text-gray-900 dark:text-white mb-3"
            >
              Appearance
            </h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div className="space-y-2">
                <label
                  htmlFor="settings-theme"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Theme
                </label>
                <select
                  id="settings-theme"
                  data-testid="settings-theme"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm
                             focus:outline-none focus:ring-2 focus:ring-blue-500
                             dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  value={settings.theme}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    updateSetting('theme', e.target.value as AppSettings['theme'])
                  }
                >
                  <option value="light">Light</option>
                  <option value="dark">Dark</option>
                  <option value="auto">Auto (follow system)</option>
                </select>
              </div>

              <div className="space-y-2">
                <label
                  htmlFor="settings-language"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                >
                  Language
                </label>
                <select
                  id="settings-language"
                  data-testid="settings-language"
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm
                             focus:outline-none focus:ring-2 focus:ring-blue-500
                             dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  value={settings.language}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    updateSetting('language', e.target.value)
                  }
                >
                  <option value="en-US">English (US)</option>
                  <option value="es-ES">Spanish</option>
                  <option value="fr-FR">French</option>
                  <option value="de-DE">German</option>
                </select>
              </div>
            </div>
          </section>

          <hr className="border-gray-100 dark:border-gray-700" />

          {/* ── Priority 2: Performance (advanced — hidden by default) ─── */}
          <section aria-labelledby="settings-perf-heading">
            <ProgressiveDisclosure
              summary={
                <h3
                  id="settings-perf-heading"
                  className="text-base font-semibold text-gray-900 dark:text-white"
                >
                  Performance
                </h3>
              }
              toggleLabel="Show performance options"
              ariaLabel="Performance settings"
            >
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                <div className="space-y-2">
                  <label
                    htmlFor="settings-max-requests"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    Max Concurrent Requests
                  </label>
                  <Input
                    type="number"
                    value={settings.maxConcurrentRequests.toString()}
                    onChange={(value: string) =>
                      updateSetting('maxConcurrentRequests', parseInt(value, 10) || 5)
                    }
                  />
                </div>

                <div className="space-y-2">
                  <label
                    htmlFor="settings-cache-size"
                    className="block text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    Cache Size (MB)
                  </label>
                  <Input
                    type="number"
                    value={settings.cacheSize.toString()}
                    onChange={(value: string) =>
                      updateSetting('cacheSize', parseInt(value, 10) || 1024)
                    }
                  />
                </div>

                <div className="flex items-center gap-2 col-span-full">
                  <input
                    id="settings-gpu"
                    type="checkbox"
                    checked={settings.enableGPU}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      updateSetting('enableGPU', e.target.checked)
                    }
                    className="h-4 w-4 rounded border-gray-300 text-blue-600 focus:ring-blue-500"
                  />
                  <label
                    htmlFor="settings-gpu"
                    className="text-sm font-medium text-gray-700 dark:text-gray-300"
                  >
                    Enable GPU acceleration (requires restart)
                  </label>
                </div>
              </div>
            </ProgressiveDisclosure>
          </section>

          <hr className="border-gray-100 dark:border-gray-700" />

          {/* ── Priority 3: Service Endpoints (advanced — hidden by default) */}
          <section aria-labelledby="settings-endpoints-heading">
            <ProgressiveDisclosure
              summary={
                <h3
                  id="settings-endpoints-heading"
                  className="text-base font-semibold text-gray-900 dark:text-white"
                >
                  Service Endpoints
                </h3>
              }
              toggleLabel="Show service endpoint options"
              ariaLabel="Service endpoint settings"
            >
              <div className="space-y-3 pt-2">
                <Input
                  label="STT Service"
                  placeholder="http://localhost:50051"
                  value={settings.sttEndpoint}
                  onChange={(value: string) => updateSetting('sttEndpoint', value)}
                />
                <Input
                  label="TTS Service"
                  placeholder="http://localhost:50052"
                  value={settings.ttsEndpoint}
                  onChange={(value: string) => updateSetting('ttsEndpoint', value)}
                />
                <Input
                  label="AI Voice Service"
                  placeholder="http://localhost:50053"
                  value={settings.aiVoiceEndpoint}
                  onChange={(value: string) => updateSetting('aiVoiceEndpoint', value)}
                />
              </div>
            </ProgressiveDisclosure>
          </section>

          {/* Save button */}
          <div className="flex justify-end pt-2">
            <Button
              data-testid="settings-save"
              onClick={handleSave}
            >
              Save Settings
            </Button>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default SettingsPanel;
