/**
 * @doc.type component
 * @doc.purpose Multimodal panel component
 * @doc.layer application
 * @doc.pattern service panel
 */

import React from 'react';
import { Card, Button } from '@audio-video/ui';

const MULTIMODAL_STATUS_MESSAGE =
  'Multimodal analysis remains disabled until the desktop app is connected to a real orchestration backend.';

const MultimodalPanel: React.FC = () => {
  return (
    <div className="space-y-6">
      <Card title="Multimodal Processing" subtitle="Combine multiple modalities for comprehensive analysis">
        <div className="space-y-6">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-100">
            <p className="font-medium">Unavailable in this build</p>
            <p className="mt-1">{MULTIMODAL_STATUS_MESSAGE}</p>
          </div>

          {/* Input Areas */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-white">Audio Input</h3>
              <div className="audio-visualizer">
                <span className="text-gray-500">Upload audio file</span>
              </div>
            </div>
            
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-white">Video Input</h3>
              <div className="audio-visualizer">
                <span className="text-gray-500">Upload video file</span>
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-white">Text Input</h3>
            <textarea
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              rows={4}
              placeholder="Enter text for multimodal analysis..."
            />
          </div>

          {/* Process Button */}
          <Button
            disabled
            className="w-full"
          >
            Multimodal Processing Unavailable In This Build
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default MultimodalPanel;
