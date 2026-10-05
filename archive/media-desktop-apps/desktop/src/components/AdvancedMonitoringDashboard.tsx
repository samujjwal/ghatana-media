/**
 * @doc.type component
 * @doc.purpose Advanced monitoring dashboard
 * @doc.layer application
 * @doc.pattern dashboard component
 */

import React, { useState, useEffect } from 'react';
import { Card, Status, Loading } from '@audio-video/ui';

interface ServiceMetrics {
  service: string;
  status: 'healthy' | 'degraded' | 'unhealthy';
  requestCount: number;
  errorRate: number;
  avgResponseTime: number;
  uptime: number;
  memoryUsage?: number;
  cpuUsage?: number;
}

interface SystemMetrics {
  totalRequests: number;
  totalErrors: number;
  avgResponseTime: number;
  systemUptime: number;
  activeConnections: number;
}

const AdvancedMonitoringDashboard: React.FC = () => {
  const [isLoading, setIsLoading] = useState(true);
  const [serviceMetrics, setServiceMetrics] = useState<ServiceMetrics[]>([]);
  const [systemMetrics, setSystemMetrics] = useState<SystemMetrics | null>(null);
  const [timeRange, setTimeRange] = useState<'1h' | '24h' | '7d' | '30d'>('24h');

  // Mock data loading
  useEffect(() => {
    const loadMetrics = async () => {
      setIsLoading(true);
      
      // Simulate API call
      await new Promise(resolve => setTimeout(resolve, 1000));
      
      // Mock service metrics
      const mockServiceMetrics: ServiceMetrics[] = [
        {
          service: 'STT',
          status: 'healthy',
          requestCount: 1234,
          errorRate: 0.02,
          avgResponseTime: 245,
          uptime: 99.9,
          memoryUsage: 512,
          cpuUsage: 45
        },
        {
          service: 'TTS',
          status: 'healthy',
          requestCount: 892,
          errorRate: 0.01,
          avgResponseTime: 520,
          uptime: 99.8,
          memoryUsage: 768,
          cpuUsage: 62
        },
        {
          service: 'AI Voice',
          status: 'degraded',
          requestCount: 456,
          errorRate: 0.08,
          avgResponseTime: 180,
          uptime: 99.5,
          memoryUsage: 1024,
          cpuUsage: 78
        },
        {
          service: 'Vision',
          status: 'healthy',
          requestCount: 234,
          errorRate: 0.03,
          avgResponseTime: 1200,
          uptime: 99.7,
          memoryUsage: 1536,
          cpuUsage: 85
        },
        {
          service: 'Multimodal',
          status: 'healthy',
          requestCount: 89,
          errorRate: 0.05,
          avgResponseTime: 2100,
          uptime: 99.6,
          memoryUsage: 2048,
          cpuUsage: 92
        }
      ];

      // Mock system metrics
      const mockSystemMetrics: SystemMetrics = {
        totalRequests: 2905,
        totalErrors: 47,
        avgResponseTime: 649,
        systemUptime: 99.7,
        activeConnections: 23
      };

      setServiceMetrics(mockServiceMetrics);
      setSystemMetrics(mockSystemMetrics);
      setIsLoading(false);
    };

    loadMetrics();
    
    // Set up periodic refresh
    const interval = setInterval(loadMetrics, 30000); // Refresh every 30 seconds
    return () => clearInterval(interval);
  }, [timeRange]);

  const getStatusColor = (status: string) => {
    switch (status) {
      case 'healthy': return 'text-green-600';
      case 'degraded': return 'text-yellow-600';
      case 'unhealthy': return 'text-red-600';
      default: return 'text-gray-600';
    }
  };

  const formatUptime = (uptime: number) => {
    return `${uptime.toFixed(1)}%`;
  };

  const formatResponseTime = (time: number) => {
    return `${time}ms`;
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loading size="lg" text="Loading metrics..." />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold text-gray-900 dark:text-white">
          Advanced Monitoring
        </h2>
        <select
          value={timeRange}
          onChange={(e) => setTimeRange(e.target.value as any)}
          className="px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
        >
          <option value="1h">Last Hour</option>
          <option value="24h">Last 24 Hours</option>
          <option value="7d">Last 7 Days</option>
          <option value="30d">Last 30 Days</option>
        </select>
      </div>

      {/* System Overview */}
      {systemMetrics && (
        <Card title="System Overview" subtitle="Overall system health and performance">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-4">
            <div className="text-center">
              <div className="text-2xl font-bold text-blue-600">
                {systemMetrics.totalRequests.toLocaleString()}
              </div>
              <div className="text-sm text-gray-500">Total Requests</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">
                {systemMetrics.totalErrors}
              </div>
              <div className="text-sm text-gray-500">Total Errors</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-purple-600">
                {formatResponseTime(systemMetrics.avgResponseTime)}
              </div>
              <div className="text-sm text-gray-500">Avg Response</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-orange-600">
                {formatUptime(systemMetrics.systemUptime)}
              </div>
              <div className="text-sm text-gray-500">System Uptime</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-indigo-600">
                {systemMetrics.activeConnections}
              </div>
              <div className="text-sm text-gray-500">Active Connections</div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-pink-600">
                {((systemMetrics.totalErrors / systemMetrics.totalRequests) * 100).toFixed(2)}%
              </div>
              <div className="text-sm text-gray-500">Error Rate</div>
            </div>
          </div>
        </Card>
      )}

      {/* Service Metrics */}
      <Card title="Service Metrics" subtitle="Individual service performance and health">
        <div className="space-y-4">
          {serviceMetrics.map((service) => (
            <div key={service.service} className="border border-gray-200 dark:border-gray-700 rounded-lg p-4">
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center space-x-3">
                  <h3 className="text-lg font-medium text-gray-900 dark:text-white">
                    {service.service}
                  </h3>
                  <Status
                    status={service.status === 'healthy' ? 'success' : service.status === 'degraded' ? 'warning' : 'error'}
                    text={service.status}
                    size="sm"
                  />
                </div>
                <div className={`text-sm font-medium ${getStatusColor(service.status)}`}>
                  {formatUptime(service.uptime)} uptime
                </div>
              </div>

              <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
                <div>
                  <div className="text-sm text-gray-500">Requests</div>
                  <div className="text-lg font-semibold text-gray-900 dark:text-white">
                    {service.requestCount.toLocaleString()}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Error Rate</div>
                  <div className="text-lg font-semibold text-gray-900 dark:text-white">
                    {(service.errorRate * 100).toFixed(2)}%
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Avg Response</div>
                  <div className="text-lg font-semibold text-gray-900 dark:text-white">
                    {formatResponseTime(service.avgResponseTime)}
                  </div>
                </div>
                <div>
                  <div className="text-sm text-gray-500">Memory</div>
                  <div className="text-lg font-semibold text-gray-900 dark:text-white">
                    {service.memoryUsage ? `${service.memoryUsage}MB` : 'N/A'}
                  </div>
                </div>
              </div>

              {/* Resource Usage Bars */}
              {(service.cpuUsage || service.memoryUsage) && (
                <div className="mt-4 space-y-2">
                  {service.cpuUsage && (
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-500">CPU Usage</span>
                        <span className="text-gray-900 dark:text-white">{service.cpuUsage}%</span>
                      </div>
                      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                        <div
                          className={`h-2 rounded-full ${
                            service.cpuUsage > 80 ? 'bg-red-500' :
                            service.cpuUsage > 60 ? 'bg-yellow-500' : 'bg-green-500'
                          }`}
                          style={{ width: `${service.cpuUsage}%` }}
                        />
                      </div>
                    </div>
                  )}
                  {service.memoryUsage && (
                    <div>
                      <div className="flex justify-between text-sm mb-1">
                        <span className="text-gray-500">Memory Usage</span>
                        <span className="text-gray-900 dark:text-white">{service.memoryUsage}MB</span>
                      </div>
                      <div className="w-full bg-gray-200 dark:bg-gray-700 rounded-full h-2">
                        <div
                          className={`h-2 rounded-full ${
                            service.memoryUsage > 1500 ? 'bg-red-500' :
                            service.memoryUsage > 1000 ? 'bg-yellow-500' : 'bg-green-500'
                          }`}
                          style={{ width: `${Math.min((service.memoryUsage / 2048) * 100, 100)}%` }}
                        />
                      </div>
                    </div>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      </Card>

      {/* Performance Trends */}
      <Card title="Performance Trends" subtitle="Historical performance data">
        <div className="space-y-4">
          <div className="h-64 flex items-center justify-center bg-gray-50 dark:bg-gray-700 rounded-lg">
            <p className="text-gray-500">Performance charts would be displayed here</p>
          </div>
        </div>
      </Card>

      {/* Alerts and Notifications */}
      <Card title="Recent Alerts" subtitle="System alerts and notifications">
        <div className="space-y-3">
          <div className="flex items-center space-x-3 p-3 bg-yellow-50 dark:bg-yellow-900/20 border border-yellow-200 dark:border-yellow-800 rounded-lg">
            <Status status="warning" text="Warning" size="sm" />
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                AI Voice service showing degraded performance
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                Error rate increased to 8% in the last hour
              </p>
            </div>
            <span className="text-xs text-gray-500">15 min ago</span>
          </div>
          
          <div className="flex items-center space-x-3 p-3 bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg">
            <Status status="success" text="Info" size="sm" />
            <div className="flex-1">
              <p className="text-sm font-medium text-gray-900 dark:text-white">
                All services completed health checks successfully
              </p>
              <p className="text-xs text-gray-500 dark:text-gray-400">
                System performance within normal parameters
              </p>
            </div>
            <span className="text-xs text-gray-500">1 hour ago</span>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default AdvancedMonitoringDashboard;
