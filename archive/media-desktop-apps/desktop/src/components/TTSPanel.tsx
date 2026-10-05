/**
 * @doc.type component
 * @doc.purpose Text-to-Speech panel component with audio playback
 * @doc.layer application
 * @doc.pattern service panel
 */

import React from 'react';
import { Card, Button, Input, Loading } from '@audio-video/ui';
import { AudioVideoClient, defaultConfigs } from '@audio-video/client';
import type { TTSRequest, TTSResult } from '@audio-video/types';

// Create singleton client instance
const client = new AudioVideoClient(defaultConfigs);

const TTSPanel: React.FC = () => {
  const [text, setText] = React.useState('');
  const [isProcessing, setIsProcessing] = React.useState(false);
  const [audioUrl, setAudioUrl] = React.useState<string | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const [voice, setVoice] = React.useState('default-en');
  const [sampleRate, setSampleRate] = React.useState('22050');
  const [isPlaying, setIsPlaying] = React.useState(false);
  
  const audioRef = React.useRef<HTMLAudioElement | null>(null);

  // Cleanup audio URL on unmount
  React.useEffect(() => {
    return () => {
      if (audioUrl) {
        URL.revokeObjectURL(audioUrl);
      }
    };
  }, [audioUrl]);

  const handleSynthesize = async () => {
    if (!text.trim()) return;
    
    setIsProcessing(true);
    setError(null);
    
    // Revoke previous audio URL
    if (audioUrl) {
      URL.revokeObjectURL(audioUrl);
      setAudioUrl(null);
    }
    
    try {
      const request: TTSRequest = {
        text: text.trim(),
        voiceId: voice,
        options: {
          sampleRate: parseInt(sampleRate, 10),
          format: 'wav',
          speed: 1.0,
          pitch: 1.0,
          volume: 1.0
        }
      };
      
      const response = await client.synthesize(request);
      
      if (response.success && response.data) {
        const ttsResult = response.data as TTSResult;
        // Convert audio data to WAV blob
        const wavBlob = audioBytesToWavBlob(
          new Uint8Array(ttsResult.audio.data),
          ttsResult.audio.sampleRate,
          ttsResult.audio.channels
        );
        
        const url = URL.createObjectURL(wavBlob);
        setAudioUrl(url);
      } else {
        setError(response.error?.message || 'No audio data received from TTS service');
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : 'Unknown error';
      setError('Synthesis failed: ' + errorMsg);
      console.error('TTS error:', err);
    } finally {
      setIsProcessing(false);
    }
  };

  const audioBytesToWavBlob = (
    audioBytes: Uint8Array, 
    sampleRate: number, 
    channels: number
  ): Blob => {
    // Check if already has WAV header (first 4 bytes are "RIFF")
    const hasWavHeader = 
      audioBytes.length > 4 && 
      audioBytes[0] === 0x52 && // 'R'
      audioBytes[1] === 0x49 && // 'I'
      audioBytes[2] === 0x46 && // 'F'
      audioBytes[3] === 0x46;   // 'F'
    
    if (hasWavHeader) {
      // Already WAV format - cast to unknown to bypass strict type checking
      return new Blob([audioBytes as unknown as BlobPart], { type: 'audio/wav' });
    }
    
    // Assume raw PCM 16-bit data, add WAV header
    const bitsPerSample = 16;
    const blockAlign = channels * (bitsPerSample / 8);
    const byteRate = sampleRate * blockAlign;
    const dataSize = audioBytes.length;
    
    const buffer = new ArrayBuffer(44 + dataSize);
    const view = new DataView(buffer);
    
    // RIFF chunk
    writeString(view, 0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeString(view, 8, 'WAVE');
    
    // fmt chunk
    writeString(view, 12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true); // PCM
    view.setUint16(22, channels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, byteRate, true);
    view.setUint16(32, blockAlign, true);
    view.setUint16(34, bitsPerSample, true);
    
    // data chunk
    writeString(view, 36, 'data');
    view.setUint32(40, dataSize, true);
    
    // Copy PCM data
    const pcmData = new Uint8Array(buffer, 44, dataSize);
    pcmData.set(audioBytes);
    
    return new Blob([buffer], { type: 'audio/wav' });
  };

  const writeString = (view: DataView, offset: number, string: string) => {
    for (let i = 0; i < string.length; i++) {
      view.setUint8(offset + i, string.charCodeAt(i));
    }
  };

  const handlePlayPause = () => {
    if (!audioRef.current || !audioUrl) return;
    
    if (isPlaying) {
      audioRef.current.pause();
    } else {
      audioRef.current.play().catch(err => {
        console.error('Playback error:', err);
        setError('Failed to play audio: ' + err.message);
      });
    }
  };

  const handleDownload = () => {
    if (!audioUrl) return;
    
    const link = document.createElement('a');
    link.href = audioUrl;
    link.download = `tts-${Date.now()}.wav`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
  };

  return (
    <div className="space-y-6">
      <Card title="Text to Speech" subtitle="Convert text to natural speech">
        <div className="space-y-6">
          {/* Error Display */}
          {error && (
            <div className="p-3 bg-red-50 border border-red-200 rounded-md">
              <p className="text-sm text-red-600">{error}</p>
            </div>
          )}

          {/* Text Input */}
          <div className="space-y-2">
            <label className="block text-sm font-medium text-gray-700 dark:text-gray-300">
              Text to Synthesize
            </label>
            <textarea
              className="w-full px-3 py-2 border border-gray-300 rounded-md shadow-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-blue-500 dark:bg-gray-700 dark:border-gray-600 dark:text-white"
              rows={6}
              placeholder="Enter text to convert to speech..."
              value={text}
              onChange={(e) => setText(e.target.value)}
            />
          </div>

          {/* Synthesis Button */}
          <Button
            onClick={handleSynthesize}
            disabled={!text.trim() || isProcessing}
            className="w-full"
          >
            {isProcessing ? (
              <Loading size="sm" text="Generating audio..." />
            ) : (
              'Generate Speech'
            )}
          </Button>

          {/* Audio Player */}
          {audioUrl && (
            <div className="space-y-3">
              <h3 className="text-lg font-medium text-gray-900 dark:text-white">Generated Audio</h3>
              
              {/* Hidden audio element */}
              <audio
                ref={audioRef}
                src={audioUrl}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onEnded={() => setIsPlaying(false)}
                className="hidden"
              />
              
              {/* Custom controls */}
              <div className="flex items-center space-x-3 bg-gray-100 rounded-lg p-3">
                <button
                  onClick={handlePlayPause}
                  className="flex items-center justify-center w-12 h-12 bg-blue-600 hover:bg-blue-700 text-white rounded-full transition-colors"
                  aria-label={isPlaying ? 'Pause' : 'Play'}
                >
                  {isPlaying ? (
                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
                    </svg>
                  ) : (
                    <svg className="w-6 h-6" fill="currentColor" viewBox="0 0 24 24">
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  )}
                </button>
                
                <span className="text-sm text-gray-600 flex-1">
                  {isPlaying ? 'Playing...' : 'Ready to play'}
                </span>
                
                <button
                  onClick={handleDownload}
                  className="px-3 py-1.5 text-sm bg-gray-200 hover:bg-gray-300 text-gray-700 rounded-md transition-colors"
                >
                  Download
                </button>
              </div>
            </div>
          )}

          {/* Settings */}
          <div className="space-y-4">
            <h3 className="text-lg font-medium text-gray-900 dark:text-white">Settings</h3>
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <Input
                label="Voice"
                placeholder="e.g., default-en"
                value={voice}
                onChange={setVoice}
              />
              <Input
                label="Sample Rate"
                placeholder="e.g., 22050"
                value={sampleRate}
                onChange={setSampleRate}
              />
            </div>
          </div>
        </div>
      </Card>
    </div>
  );
};

export default TTSPanel;
