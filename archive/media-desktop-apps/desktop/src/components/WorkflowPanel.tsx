/**
 * @doc.type component
 * @doc.purpose Workflow panel for cross-service orchestration
 * @doc.layer application
 * @doc.pattern workflow component
 */

import React, { useState } from 'react';
import { Card, Button, Loading, Status } from '@audio-video/ui';
import { useWorkflow } from '../hooks/useWorkflow';

const WorkflowPanel: React.FC = () => {
  const [selectedWorkflow, setSelectedWorkflow] = useState<'speech-to-speech' | 'translate-and-speak' | 'analyze-content' | 'multimodal'>('speech-to-speech');
  const [textInput, setTextInput] = useState('');
  const [targetLanguage, setTargetLanguage] = useState('es-ES');
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [imageFile, setImageFile] = useState<File | null>(null);
  const [validationMessage, setValidationMessage] = useState<string | null>(null);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  
  const { isRunning, currentExecution, workflows, reset } = useWorkflow({
    onProgress: (step, total, message) => {
      setValidationMessage(null);
      setStatusMessage(`Step ${step}/${total}: ${message}`);
    },
    onComplete: (result) => {
      setStatusMessage(`Workflow completed: ${result.workflowId}`);
    },
    onError: (error) => {
      setValidationMessage(error);
    }
  });

  const handleFileUpload = (event: React.ChangeEvent<HTMLInputElement>, type: 'audio' | 'image') => {
    const file = event.target.files?.[0];
    if (type === 'audio') {
      setAudioFile(file ?? null);
    } else {
      setImageFile(file ?? null);
    }
  };

  const executeWorkflow = async () => {
    try {
      setValidationMessage(null);
      switch (selectedWorkflow) {
        case 'speech-to-speech':
          if (!audioFile) {
            setValidationMessage('Select an audio file before starting speech-to-speech.');
            return;
          }
          const audioData = await audioFile.arrayBuffer();
          await workflows.speechToSpeech({
            data: audioData,
            sampleRate: 44100,
            channels: 1,
            bitsPerSample: 16,
            durationMs: 0,
            format: 'wav'
          });
          break;

        case 'translate-and-speak':
          if (!textInput.trim()) {
            setValidationMessage('Enter text before starting translation.');
            return;
          }
          await workflows.translateAndSpeak(textInput, targetLanguage);
          break;

        case 'analyze-content':
          if (!imageFile) {
            setValidationMessage('Select an image file before content analysis.');
            return;
          }
          const imageData = await imageFile.arrayBuffer();
          await workflows.analyzeContent(imageData);
          break;

        case 'multimodal':
          const multimodalInput: any = {};
          if (audioFile) {
            multimodalInput.audio = {
              data: await audioFile.arrayBuffer(),
              sampleRate: 44100,
              channels: 1,
              bitsPerSample: 16,
              durationMs: 0,
              format: 'wav'
            };
          }
          if (imageFile) {
            multimodalInput.image = await imageFile.arrayBuffer();
          }
          if (textInput.trim()) {
            multimodalInput.text = textInput;
          }
          await workflows.processMultimodal(multimodalInput);
          break;
      }
    } catch (error) {
      setValidationMessage(error instanceof Error ? error.message : 'Workflow execution failed.');
    }
  };

  const workflowConfigs = {
    'speech-to-speech': {
      title: 'Speech to Speech',
      description: 'Transcribe audio, enhance with AI, and synthesize back to speech',
      inputs: ['audio'],
      steps: ['STT: Transcribe', 'AI Voice: Enhance', 'TTS: Synthesize']
    },
    'translate-and-speak': {
      title: 'Translate and Speak',
      description: 'Translate text to target language and synthesize speech',
      inputs: ['text'],
      steps: ['AI Voice: Translate', 'TTS: Synthesize']
    },
    'analyze-content': {
      title: 'Analyze Content',
      description: 'Analyze image and generate summary',
      inputs: ['image'],
      steps: ['Vision: Analyze', 'AI Voice: Summarize']
    },
    'multimodal': {
      title: 'Multimodal Processing',
      description: 'Combine multiple inputs for comprehensive analysis',
      inputs: ['audio', 'image', 'text'],
      steps: ['Multimodal: Process All']
    }
  };

  const currentConfig = workflowConfigs[selectedWorkflow];

  return (
    <div className="space-y-6">
      <Card title="Workflow Orchestration" subtitle="Combine multiple services for powerful workflows">
        <div className="space-y-6">
          {validationMessage && (
            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
              {validationMessage}
            </div>
          )}
          {statusMessage && !validationMessage && (
            <div className="rounded-md border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-700">
              {statusMessage}
            </div>
          )}
          {/* Workflow Selection */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-white">Select Workflow</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {Object.entries(workflowConfigs).map(([key, config]) => (
                <div
                  key={key}
                  className={`p-4 border rounded-lg cursor-pointer transition-colors ${
                    selectedWorkflow === key
                      ? 'border-blue-500 bg-blue-50 dark:bg-blue-900/20'
                      : 'border-gray-300 hover:border-gray-400'
                  }`}
                  onClick={() => setSelectedWorkflow(key as any)}
                >
                  <h4 className="font-medium text-gray-900 dark:text-white">{config.title}</h4>
                  <p className="text-sm text-gray-600 dark:text-gray-400 mt-1">{config.description}</p>
                  <div className="mt-2 flex flex-wrap gap-1">
                    {config.steps.map((step, index) => (
                      <span key={index} className="text-xs bg-gray-100 dark:bg-gray-700 px-2 py-1 rounded">
                        {step}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Input Configuration */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-white">Configure Inputs</h3>
            
            {/* Audio Input */}
            {currentConfig.inputs.includes('audio') && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Audio File
                </label>
                <input
                  type="file"
                  accept="audio/*"
                  onChange={(e) => handleFileUpload(e, 'audio')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
                {audioFile && (
                  <p className="text-sm text-gray-500">Selected: {audioFile.name}</p>
                )}
              </div>
            )}

            {/* Text Input */}
            {currentConfig.inputs.includes('text') && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Text Input
                </label>
                <textarea
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  rows={4}
                  placeholder="Enter text for processing..."
                  value={textInput}
                  onChange={(e) => setTextInput(e.target.value)}
                />
              </div>
            )}

            {/* Image Input */}
            {currentConfig.inputs.includes('image') && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Image File
                </label>
                <input
                  type="file"
                  accept="image/*"
                  onChange={(e) => handleFileUpload(e, 'image')}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                />
                {imageFile && (
                  <p className="text-sm text-gray-500">Selected: {imageFile.name}</p>
                )}
              </div>
            )}

            {/* Language Selection for Translation */}
            {selectedWorkflow === 'translate-and-speak' && (
              <div className="space-y-2">
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
                  Target Language
                </label>
                <select
                  className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
                  value={targetLanguage}
                  onChange={(e) => setTargetLanguage(e.target.value)}
                >
                  <option value="es-ES">Spanish</option>
                  <option value="fr-FR">French</option>
                  <option value="de-DE">German</option>
                  <option value="it-IT">Italian</option>
                  <option value="pt-PT">Portuguese</option>
                  <option value="zh-CN">Chinese</option>
                  <option value="ja-JP">Japanese</option>
                </select>
              </div>
            )}
          </div>

          {/* Execute Button */}
          <div className="flex space-x-4">
            <Button
              onClick={executeWorkflow}
              disabled={isRunning}
              className="flex-1"
            >
              {isRunning ? (
                <Loading size="sm" text="Executing Workflow..." />
              ) : (
                'Execute Workflow'
              )}
            </Button>
            
            {currentExecution && (
              <Button
                onClick={reset}
                variant="secondary"
              >
                Reset
              </Button>
            )}
          </div>

          {/* Progress Display */}
          {isRunning && (
            <div className="space-y-2">
              <h3 className="text-lg font-medium text-gray-900 dark:text-white">Progress</h3>
              <div className="space-y-2">
                {currentConfig.steps.map((step, index) => (
                  <div key={index} className="flex items-center space-x-2">
                    <Status
                      status="loading"
                      text={step}
                      size="sm"
                    />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Results Display */}
          {currentExecution && currentExecution.status === 'completed' && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-white">Results</h3>
              <div className="bg-green-50 dark:bg-green-900/20 border border-green-200 dark:border-green-800 rounded-lg p-4">
                <Status
                  status="success"
                  text="Workflow completed successfully"
                  size="sm"
                />
                <div className="mt-4 space-y-2">
                  {Object.entries(currentExecution.results).map(([key, value]) => (
                    <div key={key} className="text-sm">
                      <span className="font-medium capitalize">{key}:</span>
                      <span className="ml-2 text-gray-600 dark:text-gray-400">
                        {typeof value === 'object' ? JSON.stringify(value, null, 2) : String(value)}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}

          {/* Error Display */}
          {currentExecution && currentExecution.status === 'failed' && (
            <div className="space-y-4">
              <h3 className="text-lg font-medium text-gray-900 dark:text-white">Error</h3>
              <div className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-4">
                <Status
                  status="error"
                  text="Workflow failed"
                  size="sm"
                />
                <p className="mt-2 text-sm text-red-800 dark:text-red-200">
                  {currentExecution.error}
                </p>
              </div>
            </div>
          )}
        </div>
      </Card>
    </div>
  );
};

export default WorkflowPanel;
