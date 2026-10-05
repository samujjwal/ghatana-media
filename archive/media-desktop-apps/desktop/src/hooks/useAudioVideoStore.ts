/**
 * @doc.type hook
 * @doc.purpose Jotai atoms for audio-video application state with Tauri config store integration
 * @doc.layer application
 * @doc.pattern state management
 */

import { atom, useAtom, useAtomValue, useSetAtom } from 'jotai';
import type { AudioVideoSettings, ServiceType } from '@audio-video/types';

interface AudioVideoStore {
  // Settings
  settings: AudioVideoSettings;
  updateSettings: (settings: Partial<AudioVideoSettings>) => void;
  
  // UI State
  activeService: ServiceType;
  setActiveService: (service: ServiceType) => void;
  
  // Processing state
  isProcessing: boolean;
  setIsProcessing: (processing: boolean) => void;
  
  // Error state
  error: string | null;
  setError: (error: string | null) => void;
}

/**
 * Load service endpoint from environment variable or use default
 * Environment variables: AV_STT_ENDPOINT, AV_TTS_ENDPOINT, AV_AI_VOICE_ENDPOINT, AV_VISION_ENDPOINT, AV_MULTIMODAL_ENDPOINT
 */
function getServiceEndpoint(serviceName: string, defaultPort: number): string {
  const envVarName = `AV_${serviceName.toUpperCase().replace('-', '_')}_ENDPOINT`;
  if (typeof window !== 'undefined' && window.__TAURI__) {
    // In Tauri environment, try to read from environment or config
    return (import.meta.env as Record<string, string | undefined>)[`VITE_${envVarName}`] || `http://localhost:${defaultPort}`;
  }
  // Fallback for web/dev environment
  return (import.meta.env as any)[`VITE_${envVarName}`] || `http://localhost:${defaultPort}`;
}

const defaultSettings: AudioVideoSettings = {
  services: {
    stt: {
      enabled: true,
      endpoint: getServiceEndpoint('stt', 50051),
      timeout: 30000,
      retries: 3,
      customSettings: {}
    },
    tts: {
      enabled: true,
      endpoint: getServiceEndpoint('tts', 50052),
      timeout: 30000,
      retries: 3,
      customSettings: {}
    },
    'ai-voice': {
      enabled: true,
      endpoint: getServiceEndpoint('ai-voice', 50053),
      timeout: 30000,
      retries: 3,
      customSettings: {}
    },
    vision: {
      enabled: true,
      endpoint: getServiceEndpoint('vision', 50054),
      timeout: 30000,
      retries: 3,
      customSettings: {}
    },
    multimodal: {
      enabled: true,
      endpoint: getServiceEndpoint('multimodal', 50055),
      timeout: 60000,
      retries: 3,
      customSettings: {}
    }
  },
  ui: {
    theme: 'auto',
    language: 'en-US',
    fontSize: 'medium',
    layout: 'comfortable',
    animations: true,
    notifications: true
  },
  performance: {
    enableGPU: false,
    maxConcurrentRequests: 5,
    cacheSize: 1024,
    enableCompression: true,
    bufferSize: 8192
  },
  accessibility: {
    highContrast: false,
    reduceMotion: false,
    screenReader: false,
    keyboardNavigation: true,
    fontSize: 16,
    colorBlindMode: 'none'
  }
};

// ── Atoms ────────────────────────────────────────────────────────────────

export const settingsAtom = atom<AudioVideoSettings>(defaultSettings);
export const activeServiceAtom = atom<ServiceType>('stt');
export const isProcessingAtom = atom(false);
export const errorAtom = atom<string | null>(null);

export const updateSettingsAtom = atom(
  null,
  (get, set, newSettings: Partial<AudioVideoSettings>) => {
    set(settingsAtom, { ...get(settingsAtom), ...newSettings });
  }
);

// ── Composite hook (drop-in replacement for the old useAudioVideoStore) ───────
export function useAudioVideoStore() {
  const [settings, setSettings] = useAtom(settingsAtom);
  const [activeService, setActiveService] = useAtom(activeServiceAtom);
  const [isProcessing, setIsProcessing] = useAtom(isProcessingAtom);
  const [error, setError] = useAtom(errorAtom);

  const updateSettings = (newSettings: Partial<AudioVideoSettings>) => {
    setSettings((prev) => ({ ...prev, ...newSettings }));
  };

  return { settings, updateSettings, activeService, setActiveService, isProcessing, setIsProcessing, error, setError };
}
