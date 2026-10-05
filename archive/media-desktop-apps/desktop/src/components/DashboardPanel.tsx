/**
 * @doc.type component
 * @doc.purpose Dashboard panel showing overview of all services with memory pressure monitoring
 * @doc.layer application
 * @doc.pattern dashboard component
 */

import React from 'react';
import { Card } from '@audio-video/ui';
import { useMemoryPressure, MemoryPressureLevel, MemoryInfo } from '@audio-video/ui/hooks';

const DashboardPanel: React.FC = () => {
  const [memoryNotice, setMemoryNotice] = React.useState<string | null>(null);

  const { memoryInfo, isSupported } = useMemoryPressure({
    onPressureChange: (level: MemoryPressureLevel, info: MemoryInfo) => {
      setMemoryNotice(`Memory pressure ${level}: ${(info.utilisation * 100).toFixed(1)}% utilised.`);
    },
    onCritical: (info: MemoryInfo) => {
      setMemoryNotice(`Critical memory pressure detected at ${(info.utilisation * 100).toFixed(1)}%. Consider clearing caches.`);
    },
  });

  const getMemoryColor = (level: MemoryPressureLevel): string => {
    switch (level) {
      case 'normal': return 'text-green-600';
      case 'moderate': return 'text-yellow-600';
      case 'critical': return 'text-red-600';
      default: return 'text-gray-600';
    }
  };

  const formatBytes = (bytes: number) => {
    if (bytes === 0) return 'N/A';
    const mb = bytes / (1024 * 1024);
    return `${mb.toFixed(0)} MB`;
  };

  return (
    <div className="space-y-6">
      {memoryNotice && (
        <div className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
          {memoryNotice}
        </div>
      )}
      {isSupported && memoryInfo.level !== 'normal' && (
        <div className={`p-4 rounded-lg border ${
          memoryInfo.level === 'critical' 
            ? 'bg-red-50 border-red-200' 
            : 'bg-yellow-50 border-yellow-200'
        }`}>
          <div className="flex items-center gap-2">
            <span className={`font-medium ${getMemoryColor(memoryInfo.level)}`}>
              {memoryInfo.level === 'critical' ? '⚠️ Critical Memory Usage' : '⚡ Moderate Memory Pressure'}
            </span>
            <span className="text-sm text-gray-600">
              ({(memoryInfo.utilisation * 100).toFixed(1)}% - {formatBytes(memoryInfo.usedJSHeapSize)} used)
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        <Card title="Speech to Text" subtitle="Real-time transcription">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Status</span>
              <span className="text-sm font-medium text-green-600">Healthy</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Requests Today</span>
              <span className="text-sm font-medium">1,234</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Avg Response Time</span>
              <span className="text-sm font-medium">245ms</span>
            </div>
          </div>
        </Card>

        <Card title="Text to Speech" subtitle="Voice synthesis">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Status</span>
              <span className="text-sm font-medium text-green-600">Healthy</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Requests Today</span>
              <span className="text-sm font-medium">892</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Avg Response Time</span>
              <span className="text-sm font-medium">520ms</span>
            </div>
          </div>
        </Card>

        <Card title="AI Voice" subtitle="Voice enhancement">
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Status</span>
              <span className="text-sm font-medium text-green-600">Healthy</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Requests Today</span>
              <span className="text-sm font-medium">456</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-gray-500">Avg Response Time</span>
              <span className="text-sm font-medium">180ms</span>
            </div>
          </div>
        </Card>
      </div>

      <Card title="System Overview" subtitle="Overall system health and performance">
        <div className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">5</div>
              <div className="text-sm text-gray-500">Active Services</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">99.8%</div>
              <div className="text-sm text-gray-500">Uptime</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-purple-600">2,582</div>
              <div className="text-sm text-gray-500">Total Requests</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-orange-600">342ms</div>
              <div className="text-sm text-gray-500">Avg Response</div>
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default DashboardPanel;
