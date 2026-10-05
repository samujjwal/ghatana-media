/**
 * @doc.type component
 * @doc.purpose AI Voice panel component
 * @doc.layer application
 * @doc.pattern service panel
 */

import React from 'react';
import { Card, Button } from '@audio-video/ui';

const AI_VOICE_STATUS_MESSAGE =
  'This panel is intentionally disabled until the desktop client is wired to a real AI Voice backend.';

const AIVoicePanel: React.FC = () => {
  const [inputText, setInputText] = React.useState('');
  const [task, setTask] = React.useState('enhance');

  return (
    <div className="space-y-6">
      <Card title="AI Voice" subtitle="Enhance and transform voice content">
        <div className="space-y-6">
          <div className="rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900 dark:border-amber-800 dark:bg-amber-900/30 dark:text-amber-100">
            <p className="font-medium">Unavailable in this build</p>
            <p className="mt-1">{AI_VOICE_STATUS_MESSAGE}</p>
          </div>

          {/* Task Selection */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Task
            </label>
            <select
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              value={task}
              onChange={(e) => setTask(e.target.value)}
            >
              <option value="enhance">Enhance</option>
              <option value="translate">Translate</option>
              <option value="summarize">Summarize</option>
              <option value="style">Style Transfer</option>
            </select>
          </div>

          {/* Text Input */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Input Text
            </label>
            <textarea
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              rows={4}
              placeholder="Enter text to process..."
              value={inputText}
              onChange={(e) => setInputText(e.target.value)}
            />
          </div>

          {/* Process Button */}
          <Button
            disabled
            className="w-full"
          >
            AI Voice Unavailable In This Build
          </Button>
        </div>
      </Card>
    </div>
  );
};

export default AIVoicePanel;
