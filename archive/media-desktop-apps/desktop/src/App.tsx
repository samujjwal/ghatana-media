/**
 * @doc.type component
 * @doc.purpose Main application component for unified audio-video desktop app
 * @doc.layer application
 * @doc.pattern container component
 */

import React, { useState, useEffect } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { invoke } from '@tauri-apps/api/core';
import type { ServiceType, ServiceStatus, AudioVideoSettings } from '@audio-video/types';
import { Tabs, Card, Status, Loading } from '@audio-video/ui';
import STTPanel from './components/STTPanel';
import TTSPanel from './components/TTSPanel';
import AIVoicePanel from './components/AIVoicePanel';
import VisionPanel from './components/VisionPanel';
import MultimodalPanel from './components/MultimodalPanel';
import SettingsPanel from './components/SettingsPanel';
import DashboardPanel from './components/DashboardPanel';
import WorkflowPanel from './components/WorkflowPanel';
import AdvancedMonitoringDashboard from './components/AdvancedMonitoringDashboard';
import TestSuite from './components/TestSuite';
import { useAudioVideoStore } from './hooks/useAudioVideoStore';

type DesktopTabId = ServiceType | 'dashboard' | 'workflows' | 'monitoring' | 'tests' | 'settings';

/**
 * Main application component
 */
function App() {
  const [activeService, setActiveService] = useState<DesktopTabId>('dashboard');
  const [servicesStatus, setServicesStatus] = useState<Record<ServiceType, ServiceStatus>>({} as Record<ServiceType, ServiceStatus>);
  const [isLoading, setIsLoading] = useState(true);
  const { settings, updateSettings } = useAudioVideoStore();

  // Load initial services status
  useEffect(() => {
    const loadServicesStatus = async () => {
      try {
        const status = await invoke<Record<string, any>[]>('get_all_services_status');
        const statusMap = status.reduce((acc, service) => {
          acc[service.name.toLowerCase() as ServiceType] = service;
          return acc;
        }, {} as Record<ServiceType, ServiceStatus>);
        setServicesStatus(statusMap);
      } catch (error) {
        console.error('Failed to load services status:', error);
      } finally {
        setIsLoading(false);
      }
    };

    loadServicesStatus();
  }, []);

  // Periodic health checks
  useEffect(() => {
    const interval = setInterval(async () => {
      const services: ServiceType[] = ['stt', 'tts', 'ai-voice', 'vision', 'multimodal'];
      for (const service of services) {
        try {
          await invoke('check_service_health', { service });
        } catch (error) {
          console.error(`Health check failed for ${service}:`, error);
        }
      }
    }, 30000); // Check every 30 seconds

    return () => clearInterval(interval);
  }, []);

  const serviceTabs = [
    { id: 'dashboard' as const, label: 'Dashboard', content: <DashboardPanel /> },
    { id: 'stt' as const, label: 'Speech to Text', content: <STTPanel /> },
    { id: 'tts' as const, label: 'Text to Speech', content: <TTSPanel /> },
    { id: 'ai-voice' as const, label: 'AI Voice', content: <AIVoicePanel /> },
    { id: 'vision' as const, label: 'Computer Vision', content: <VisionPanel /> },
    { id: 'multimodal' as const, label: 'Multimodal', content: <MultimodalPanel /> },
    { id: 'workflows' as const, label: 'Workflows', content: <WorkflowPanel /> },
    { id: 'monitoring' as const, label: 'Monitoring', content: <AdvancedMonitoringDashboard /> },
    ...(import.meta.env.DEV ? [{ id: 'tests' as const, label: 'Tests', content: <TestSuite /> }] : []),
    { id: 'settings' as const, label: 'Settings', content: <SettingsPanel /> },
  ];

  if (isLoading) {
    return (
      <div className="audio-video-container flex items-center justify-center">
        <Loading size="lg" text="Loading Audio-Video Desktop..." />
      </div>
    );
  }

  return (
    <div className="audio-video-container">
      {/* Header */}
      <header className="bg-white dark:bg-gray-800 shadow-sm border-b border-gray-200 dark:border-gray-700">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="flex items-center justify-between h-16">
            <div className="flex items-center">
              <h1 className="text-xl font-bold text-gray-900 dark:text-white">
                Audio-Video Desktop
              </h1>
              <div className="ml-4 flex items-center space-x-2">
                {Object.entries(servicesStatus).map(([service, status]) => (
                  <Status
                    key={service}
                    status={status.status === 'healthy' ? 'success' : status.status === 'degraded' ? 'warning' : 'error'}
                    text={service.toUpperCase()}
                    size="sm"
                  />
                ))}
              </div>
            </div>
            <div className="flex items-center space-x-4">
              <span className="text-sm text-gray-500 dark:text-gray-400">
                Version 1.0.0
              </span>
            </div>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-8">
        <Card className="min-h-[600px]">
          <Tabs
            tabs={serviceTabs}
            activeTab={activeService}
            onChange={(tabId) => {
              setActiveService(tabId as DesktopTabId);
            }}
            variant="default"
          />
        </Card>
      </main>

      {/* Footer */}
      <footer className="bg-white dark:bg-gray-800 border-t border-gray-200 dark:border-gray-700 mt-auto">
        <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 py-4">
          <div className="flex items-center justify-between">
            <p className="text-sm text-gray-500 dark:text-gray-400">
              © 2026 Ghatana Audio-Video Desktop
            </p>
            <div className="flex items-center space-x-4">
              <a href="#" className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                Documentation
              </a>
              <a href="#" className="text-sm text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200">
                Support
              </a>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default App;
