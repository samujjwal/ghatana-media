/**
 * @doc.type component
 * @doc.purpose Speech-to-Text panel component with real audio recording
 * @doc.layer application
 * @doc.pattern service panel
 */

import React from 'react';
import { Card, Button, Input } from '@audio-video/ui';
import { AudioVideoClient, defaultConfigs } from '@audio-video/client';
import type { STTRequest } from '@audio-video/types';

// Create singleton client instance
const client = new AudioVideoClient(defaultConfigs);

// Audio recording types
interface AudioRecorderState {
  mediaRecorder: MediaRecorder | null;
  audioContext: AudioContext | null;
  analyser: AnalyserNode | null;
  stream: MediaStream | null;
  audioChunks: Blob[];
}

const STTPanel: React.FC = () => {
  const [isRecording, setIsRecording] = React.useState(false);
  const [transcription, setTranscription] = React.useState('');
  const [isProcessing, setIsProcessing] = React.useState(false);
  const [error, setError] = React.useState<string | null>(null);
  const [language, setLanguage] = React.useState('en-US');
  const [model, setModel] = React.useState('whisper-tiny');
  const [visualizerData, setVisualizerData] = React.useState<number[]>([]);
  const [sttMode, setSttMode] = React.useState<'grpc' | 'llm-fallback' | 'nop'>('llm-fallback');
  
  const recorderRef = React.useRef<AudioRecorderState>({
    mediaRecorder: null,
    audioContext: null,
    analyser: null,
    stream: null,
    audioChunks: []
  });
  const animationFrameRef = React.useRef<number | null>(null);

  // Cleanup on unmount
  React.useEffect(() => {
    return () => {
      stopRecording();
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, []);

  const updateVisualizer = () => {
    const { analyser } = recorderRef.current;
    if (!analyser || !isRecording) return;

    const dataArray = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(dataArray);
    
    // Sample 5 frequency bands for visualization
    const bands = 5;
    const samples: number[] = [];
    const step = Math.floor(dataArray.length / bands);
    
    for (let i = 0; i < bands; i++) {
      const idx = i * step;
      const value = dataArray[idx] / 255; // Normalize to 0-1
      samples.push(value);
    }
    
    setVisualizerData(samples);
    animationFrameRef.current = requestAnimationFrame(updateVisualizer);
  };

  const startRecording = async () => {
    setError(null);
    setTranscription('');
    
    try {
      // Request microphone access
      const stream = await navigator.mediaDevices.getUserMedia({ 
        audio: {
          sampleRate: 16000,
          channelCount: 1,
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        } 
      });
      
      // Create audio context for visualization
      const audioContext = new AudioContext({ sampleRate: 16000 });
      const source = audioContext.createMediaStreamSource(stream);
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      
      // Create MediaRecorder with WAV-compatible options
      const mediaRecorder = new MediaRecorder(stream, {
        mimeType: MediaRecorder.isTypeSupported('audio/webm') 
          ? 'audio/webm' 
          : 'audio/mp4',
        audioBitsPerSecond: 128000
      });
      
      recorderRef.current = {
        mediaRecorder,
        audioContext,
        analyser,
        stream,
        audioChunks: []
      };
      
      // Handle data available
      mediaRecorder.ondataavailable = (event) => {
        if (event.data.size > 0) {
          recorderRef.current.audioChunks.push(event.data);
        }
      };
      
      // Handle recording stop
      mediaRecorder.onstop = async () => {
        await processRecording();
      };
      
      // Handle errors
      mediaRecorder.onerror = (event) => {
        setError('Recording error: ' + (event as ErrorEvent).message);
        stopRecording();
      };
      
      // Start recording
      mediaRecorder.start(100); // Collect data every 100ms for smoother visualization
      setIsRecording(true);
      
      // Start visualizer
      updateVisualizer();
      
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setError('Failed to start recording: ' + errorMsg);
      console.error('Recording error:', err);
    }
  };

  const stopRecording = () => {
    const { mediaRecorder, stream, audioContext } = recorderRef.current;
    
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    
    // Stop all tracks
    if (stream) {
      stream.getTracks().forEach(track => track.stop());
    }
    
    // Close audio context
    if (audioContext && audioContext.state !== 'closed') {
      audioContext.close();
    }
    
    if (animationFrameRef.current) {
      cancelAnimationFrame(animationFrameRef.current);
    }
    
    setIsRecording(false);
    setVisualizerData([]);
  };

  const blobToWav = async (audioBlob: Blob): Promise<ArrayBuffer> => {
    // Convert webm/mp4 to raw PCM then to WAV
    const audioContext = new AudioContext({ sampleRate: 16000 });
    
    try {
      const arrayBuffer = await audioBlob.arrayBuffer();
      const audioBuffer = await audioContext.decodeAudioData(arrayBuffer);
      
      // Convert to mono, 16kHz, 16-bit PCM
      const sampleRate = 16000;
      const numberOfChannels = 1;
      const numberOfSamples = audioBuffer.length;
      const blockAlign = numberOfChannels * 2; // 16-bit = 2 bytes
      const byteRate = sampleRate * blockAlign;
      const dataSize = numberOfSamples * blockAlign;
      
      // Create WAV header
      const buffer = new ArrayBuffer(44 + dataSize);
      const view = new DataView(buffer);
      
      // "RIFF" chunk descriptor
      writeString(view, 0, 'RIFF');
      view.setUint32(4, 36 + dataSize, true);
      writeString(view, 8, 'WAVE');
      
      // "fmt " sub-chunk
      writeString(view, 12, 'fmt ');
      view.setUint32(16, 16, true); // Subchunk1Size
      view.setUint16(20, 1, true); // AudioFormat (PCM)
      view.setUint16(22, numberOfChannels, true);
      view.setUint32(24, sampleRate, true);
      view.setUint32(28, byteRate, true);
      view.setUint16(32, blockAlign, true);
      view.setUint16(34, 16, true); // Bits per sample
      
      // "data" sub-chunk
      writeString(view, 36, 'data');
      view.setUint32(40, dataSize, true);
      
      // Write PCM data
      const channelData = audioBuffer.getChannelData(0); // Mono
      let offset = 44;
      for (let i = 0; i < numberOfSamples; i++) {
        // Convert float32 [-1, 1] to int16 [-32768, 32767]
        const sample = Math.max(-1, Math.min(1, channelData[i]));
        const int16 = sample < 0 ? sample * 0x8000 : sample * 0x7FFF;
        view.setInt16(offset, int16, true);
        offset += 2;
      }
      
      return buffer;
    } finally {
      await audioContext.close();
    }
  };

  const writeString = (view: DataView, offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  const processRecording = async () => {
    const { audioChunks } = recorderRef.current;
    
    if (audioChunks.length === 0) {
      setError('No audio recorded');
      return;
    }
    
    setIsProcessing(true);
    
    try {
      // Combine chunks
      const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
      
      // Convert to WAV format for STT service
      const wavBuffer = await blobToWav(audioBlob);
      const audioBytes = new Uint8Array(wavBuffer);
      
      // Call STT service
      const request: STTRequest = {
        audio: {
          data: wavBuffer,
          sampleRate: 16000,
          channels: 1,
          bitsPerSample: 16,
          durationMs: 0, // Will be calculated by server
          format: 'wav'
        },
        language,
        model,
        options: {
          enableTimestamps: false,
          enablePunctuation: true
        }
      };
      
      const response = await client.transcribe(request);
      
      if (response.success && response.data) {
        setTranscription(response.data.text);
      } else {
        setError(response.error?.message || 'Transcription returned empty result');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setError('Transcription failed: ' + errorMsg);
      console.error('Transcription error:', err);
    } finally {
      setIsProcessing(false);
      recorderRef.current.audioChunks = [];
    }
  };

  const handleToggleRecording = () => {
    if (isRecording) {
      stopRecording();
    } else {
      startRecording();
    }
  };

  return (
    <div className="space-y-6">
      <Card title="Speech to Text" subtitle="Convert speech to text using AI">
        <div className="space-y-6">
          {/* STT Mode Badge */}
          {sttMode === 'llm-fallback' && (
            <div className="flex items-center space-x-2 p-3 bg-yellow-50 border border-yellow-200 rounded-lg">
              <span className="px-2 py-1 bg-yellow-200 text-yellow-800 text-xs font-medium rounded">
                LLM Fallback Mode
              </span>
              <span className="text-sm text-yellow-800">
                Using AI-based transcription (not a real acoustic model). Accuracy may be limited.
              </span>
            </div>
          )}
          {/* Recording Controls */}
          <div className="flex flex-col items-center space-y-4">
            <div className="audio-visualizer h-16 flex items-end justify-center space-x-1 bg-gray-100 rounded-lg px-4 py-2">
              {isRecording && visualizerData.length > 0 ? (
                visualizerData.map((value, idx) => (
                  <div
                    key={idx}
                    className="w-3 bg-blue-500 rounded-t transition-all duration-75"
                    style={{ height: `${Math.max(8, value * 60)}px` }}
                  />
                ))
              ) : isRecording ? (
                <div className="flex space-x-1">
                  <div className="w-2 h-8 bg-blue-500 animate-pulse rounded" />
                  <div className="w-2 h-12 bg-blue-500 animate-pulse rounded" style={{ animationDelay: '0.1s' }} />
                  <div className="w-2 h-6 bg-blue-500 animate-pulse rounded" style={{ animationDelay: '0.2s' }} />
                  <div className="w-2 h-10 bg-blue-500 animate-pulse rounded" style={{ animationDelay: '0.3s' }} />
                  <div className="w-2 h-8 bg-blue-500 animate-pulse rounded" style={{ animationDelay: '0.4s' }} />
                </div>
              ) : (
                <span className="text-gray-500 text-sm">Click to start recording</span>
              )}
            </div>
            
            <Button
              onClick={handleToggleRecording}
              variant={isRecording ? 'secondary' : 'primary'}
              disabled={isProcessing}
            >
              {isProcessing ? (
                'Processing...'
              ) : isRecording ? (
                'Stop Recording'
              ) : (
                'Start Recording'
              )}
            </Button>
            
            {error && (
              <p className="text-sm text-red-600">{error}</p>
            )}
          </div>

          {/* Transcription Result */}
          {transcription && (
            <div className="space-y-2">
              <h3 className="text-lg font-medium text-gray-900 dark:text-white">Transcription</h3>
              <div className="text-display p-4 bg-gray-50 rounded-lg text-gray-800">
                {transcription}
              </div>
            </div>
          )}

          {/* Settings */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-white">Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Language"
                placeholder="e.g., en-US"
                value={language}
                onChange={(e) => setLanguage(e.target.value)}
              />
              <Input
                label="Model"
                placeholder="e.g., whisper-tiny"
                value={model}
                onChange={(e) => setModel(e.target.value)}
              />
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default STTPanel;
