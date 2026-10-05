/**
 * @doc.type hook
 * @doc.purpose Cross-service workflow orchestration
 * @doc.layer application
 * @doc.pattern workflow orchestration
 */

import { useState, useCallback } from 'react';
import { invoke } from '@tauri-apps/api/core';
import type { 
  Workflow, 
  WorkflowExecution, 
  STTResult, 
  TTSResult, 
  AIVoiceResult,
  AudioData 
} from '@audio-video/types';
import { createAudioData } from '@audio-video/types';

interface UseWorkflowOptions {
  onProgress?: (step: number, total: number, message: string) => void;
  onComplete?: (result: WorkflowExecution) => void;
  onError?: (error: string) => void;
}

export const useWorkflow = (options: UseWorkflowOptions = {}) => {
  const [isRunning, setIsRunning] = useState(false);
  const [currentExecution, setCurrentExecution] = useState<WorkflowExecution | null>(null);

  const parseAiVoiceResult = useCallback((payload: string, originalText: string, task: string): AIVoiceResult => {
    const parsed = JSON.parse(payload) as {
      applied_task?: string;
      voice_used?: string;
      processing_time_ms?: number;
      duration_ms?: number;
      sample_rate?: number;
    };

    return {
      processedText: parsed.voice_used
        ? `${task} completed with ${parsed.voice_used}`
        : `${task} completed`,
      originalText,
      task: parsed.applied_task ?? task,
      processingTimeMs: parsed.processing_time_ms ?? 0,
      confidence: parsed.duration_ms && parsed.duration_ms > 0 ? 1 : 0.5,
    };
  }, []);

  const parseTtsResult = useCallback((audioBytes: number[], text: string): TTSResult => {
    const byteArray = Uint8Array.from(audioBytes);
    return {
      audio: createAudioData(byteArray.buffer.slice(byteArray.byteOffset, byteArray.byteOffset + byteArray.byteLength), {
        sampleRate: 22050,
        channels: 1,
        bitsPerSample: 16,
        format: 'wav',
      }),
      voiceUsed: 'default',
      processingTimeMs: 0,
      characters: text.length,
      durationMs: 0,
    };
  }, []);

  const parseJsonPayload = useCallback(<T,>(payload: string): T => JSON.parse(payload) as T, []);

  /**
   * Speech-to-Speech workflow: STT → AI Voice → TTS
   */
  const speechToSpeech = useCallback(async (audioData: AudioData) => {
    setIsRunning(true);
    const startTime = new Date();
    
    try {
      // Step 1: Transcribe audio
      options.onProgress?.(1, 3, 'Transcribing audio...');
      const transcript = await invoke<string>('stt_transcribe', {
        audioData: Array.from(new Uint8Array(audioData.data)),
        language: 'en-US'
      });
      const sttResult: STTResult = {
        text: transcript,
        confidence: transcript ? 1 : 0,
        processingTimeMs: 0,
        language: 'en-US',
        model: 'desktop-bridge',
      };

      // Step 2: Enhance text with AI Voice
      options.onProgress?.(2, 3, 'Enhancing transcription...');
      const aiPayload = await invoke<string>('ai_voice_process', {
        text: sttResult.text,
        task: 'enhance'
      });
      const aiResult = parseAiVoiceResult(aiPayload, sttResult.text, 'enhance');

      // Step 3: Synthesize enhanced text
      options.onProgress?.(3, 3, 'Generating speech...');
      const ttsPayload = await invoke<number[]>('tts_synthesize', {
        text: aiResult.processedText,
        voiceId: null
      });
      const ttsResult = parseTtsResult(ttsPayload, aiResult.processedText);

      const execution: WorkflowExecution = {
        workflowId: 'speech-to-speech',
        status: 'completed',
        startTime,
        endTime: new Date(),
        results: {
          transcription: sttResult,
          enhanced: aiResult,
          audio: ttsResult
        }
      };

      setCurrentExecution(execution);
      options.onComplete?.(execution);
      
      return execution;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      options.onError?.(errorMessage);
      
      const execution: WorkflowExecution = {
        workflowId: 'speech-to-speech',
        status: 'failed',
        startTime,
        endTime: new Date(),
        results: {},
        error: errorMessage
      };

      setCurrentExecution(execution);
      throw error;

    } finally {
      setIsRunning(false);
    }
  }, [options]);

  /**
   * Text Translation workflow: AI Voice (translate) → TTS
   */
  const translateAndSpeak = useCallback(async (text: string, targetLanguage: string) => {
    setIsRunning(true);
    const startTime = new Date();
    
    try {
      // Step 1: Translate text
      options.onProgress?.(1, 2, 'Translating text...');
      const aiPayload = await invoke<string>('ai_voice_process', {
        text,
        task: 'translate'
      });
      const aiResult = parseAiVoiceResult(aiPayload, text, 'translate');

      // Step 2: Synthesize translated text
      options.onProgress?.(2, 2, 'Generating speech...');
      const ttsPayload = await invoke<number[]>('tts_synthesize', {
        text: aiResult.processedText,
        voiceId: null
      });
      const ttsResult = parseTtsResult(ttsPayload, aiResult.processedText);

      const execution: WorkflowExecution = {
        workflowId: 'translate-and-speak',
        status: 'completed',
        startTime,
        endTime: new Date(),
        results: {
          translation: aiResult,
          audio: ttsResult
        }
      };

      setCurrentExecution(execution);
      options.onComplete?.(execution);
      
      return execution;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      options.onError?.(errorMessage);
      throw error;

    } finally {
      setIsRunning(false);
    }
  }, [options]);

  /**
   * Content Analysis workflow: Vision → AI Voice (summarize)
   */
  const analyzeContent = useCallback(async (imageData: ArrayBuffer) => {
    setIsRunning(true);
    const startTime = new Date();
    
    try {
      // Step 1: Analyze image
      options.onProgress?.(1, 2, 'Analyzing image...');
      const visionPayload = await invoke<string>('vision_process', {
        imageData: Array.from(new Uint8Array(imageData)),
        task: 'analyze'
      });
      const visionResult = parseJsonPayload<{ objects?: unknown[] }>(visionPayload);

      // Step 2: Generate summary
      options.onProgress?.(2, 2, 'Generating summary...');
      const aiPayload = await invoke<string>('ai_voice_process', {
        text: JSON.stringify(visionResult),
        task: 'summarize'
      });
      const aiResult = parseAiVoiceResult(aiPayload, JSON.stringify(visionResult), 'summarize');

      const execution: WorkflowExecution = {
        workflowId: 'analyze-content',
        status: 'completed',
        startTime,
        endTime: new Date(),
        results: {
          vision: visionResult,
          summary: aiResult
        }
      };

      setCurrentExecution(execution);
      options.onComplete?.(execution);
      
      return execution;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      options.onError?.(errorMessage);
      throw error;

    } finally {
      setIsRunning(false);
    }
  }, [options]);

  /**
   * Multimodal Processing workflow: Combined analysis
   */
  const processMultimodal = useCallback(async (input: {
    audio?: AudioData;
    image?: ArrayBuffer;
    text?: string;
  }) => {
    setIsRunning(true);
    const startTime = new Date();
    
    try {
      options.onProgress?.(1, 1, 'Processing multimodal data...');
      
      const request = {
        audioData: input.audio ? Array.from(new Uint8Array(input.audio.data)) : undefined,
        imageData: input.image ? Array.from(new Uint8Array(input.image)) : undefined,
        text: input.text,
        task: 'analyze'
      };

      const payload = await invoke<string>('multimodal_process', { request });
      const result = parseJsonPayload<Record<string, unknown>>(payload);

      const execution: WorkflowExecution = {
        workflowId: 'multimodal-process',
        status: 'completed',
        startTime,
        endTime: new Date(),
        results: { multimodal: result }
      };

      setCurrentExecution(execution);
      options.onComplete?.(execution);
      
      return execution;

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      options.onError?.(errorMessage);
      throw error;

    } finally {
      setIsRunning(false);
    }
  }, [options, parseAiVoiceResult, parseJsonPayload, parseTtsResult]);

  return {
    isRunning,
    currentExecution,
    workflows: {
      speechToSpeech,
      translateAndSpeak,
      analyzeContent,
      processMultimodal
    },
    reset: () => {
      setCurrentExecution(null);
      setIsRunning(false);
    }
  };
};
