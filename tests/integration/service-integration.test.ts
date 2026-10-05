import { describe, it, expect, beforeAll, afterAll } from '@jest/globals';
import { spawn, ChildProcess } from 'child_process';
import * as grpc from '@grpc/grpc-js';
import * as protoLoader from '@grpc/proto-loader';
import * as path from 'path';
import * as fs from 'fs';

describe('Audio-Video Services Integration Tests', () => {
  let services: Map<string, ChildProcess> = new Map();
  const SERVICE_PORTS = {
    stt: 50051,
    tts: 50052,
    aiVoice: 50053,
    vision: 50054,
    multimodal: 50055,
  };

  beforeAll(async () => {
    // Start all services
    console.log('Starting all services...');
    await startAllServices();
    
    // Wait for services to be ready
    await waitForServicesReady();
  }, 60000);

  afterAll(async () => {
    // Stop all services
    console.log('Stopping all services...');
    await stopAllServices();
  });

  describe('STT Service Integration', () => {
    it('should transcribe audio file successfully', async () => {
      const client = await createSTTClient();
      const audioData = await loadTestAudio('test-audio.wav');
      
      const response = await new Promise((resolve, reject) => {
        client.Transcribe({
          audio_data: audioData,
          language: 'en',
          profile_id: '',
        }, (error: any, response: any) => {
          if (error) reject(error);
          else resolve(response);
        });
      });

      expect(response).toBeDefined();
      expect((response as any).text).toBeTruthy();
      expect((response as any).text.length).toBeGreaterThan(0);
    });

    it('should handle health check', async () => {
      const client = await createSTTClient();
      
      const response = await new Promise((resolve, reject) => {
        client.HealthCheck({}, (error: any, response: any) => {
          if (error) reject(error);
          else resolve(response);
        });
      });

      expect((response as any).healthy).toBe(true);
    });
  });

  describe('TTS Service Integration', () => {
    it('should synthesize text to audio successfully', async () => {
      const client = await createTTSClient();
      
      const response = await new Promise((resolve, reject) => {
        client.Synthesize({
          text: 'Hello, this is a test.',
          voice_id: '',
          profile_id: '',
          options: null,
        }, (error: any, response: any) => {
          if (error) reject(error);
          else resolve(response);
        });
      });

      expect(response).toBeDefined();
      expect((response as any).audio_data).toBeTruthy();
      expect((response as any).audio_data.length).toBeGreaterThan(0);
    });

    it('should handle health check', async () => {
      const client = await createTTSClient();
      
      const response = await new Promise((resolve, reject) => {
        client.HealthCheck({}, (error: any, response: any) => {
          if (error) reject(error);
          else resolve(response);
        });
      });

      expect((response as any).healthy).toBe(true);
    });
  });

  describe('Vision Service Integration', () => {
    it('should detect objects in image successfully', async () => {
      const client = await createVisionClient();
      const imageData = await loadTestImage('test-image.jpg');
      
      const response = await new Promise((resolve, reject) => {
        client.DetectObjects({
          image_data: imageData,
          target_classes: [],
          max_detections: 10,
          confidence_threshold: 0.5,
        }, (error: any, response: any) => {
          if (error) reject(error);
          else resolve(response);
        });
      });

      expect(response).toBeDefined();
      expect((response as any).detections).toBeDefined();
      expect(Array.isArray((response as any).detections)).toBe(true);
    });

    it('should analyze image content', async () => {
      const client = await createVisionClient();
      const imageData = await loadTestImage('test-image.jpg');
      
      const response = await new Promise((resolve, reject) => {
        client.AnalyzeImage({
          image_data: imageData,
          analysis_types: ['scene'],
        }, (error: any, response: any) => {
          if (error) reject(error);
          else resolve(response);
        });
      });

      expect(response).toBeDefined();
      expect((response as any).scene_description).toBeTruthy();
    });
  });

  describe('Multimodal Service Integration', () => {
    it('should process multimodal content successfully', async () => {
      const client = await createMultimodalClient();
      const audioData = await loadTestAudio('test-audio.wav');
      const imageData = await loadTestImage('test-image.jpg');
      
      const response = await new Promise((resolve, reject) => {
        client.ProcessMultimodal({
          audio_data: audioData,
          image_data: imageData,
          video_data: Buffer.from([]),
          text: 'Test context',
          analysis_types: ['combined'],
        }, (error: any, response: any) => {
          if (error) reject(error);
          else resolve(response);
        });
      });

      expect(response).toBeDefined();
      expect((response as any).combined_analysis).toBeTruthy();
      expect((response as any).audio_analysis).toBeDefined();
      expect((response as any).visual_analysis).toBeDefined();
    });
  });

  describe('End-to-End Workflow Tests', () => {
    it('should complete speech-to-speech workflow', async () => {
      // 1. Transcribe audio
      const sttClient = await createSTTClient();
      const audioData = await loadTestAudio('test-audio.wav');
      
      const transcription = await new Promise((resolve, reject) => {
        sttClient.Transcribe({
          audio_data: audioData,
          language: 'en',
          profile_id: '',
        }, (error: any, response: any) => {
          if (error) reject(error);
          else resolve(response);
        });
      });

      expect((transcription as any).text).toBeTruthy();

      // 2. Synthesize transcribed text
      const ttsClient = await createTTSClient();
      const synthesis = await new Promise((resolve, reject) => {
        ttsClient.Synthesize({
          text: (transcription as any).text,
          voice_id: '',
          profile_id: '',
          options: null,
        }, (error: any, response: any) => {
          if (error) reject(error);
          else resolve(response);
        });
      });

      expect((synthesis as any).audio_data).toBeTruthy();
      expect((synthesis as any).audio_data.length).toBeGreaterThan(0);
    });

    it('should complete image analysis and description workflow', async () => {
      // 1. Detect objects in image
      const visionClient = await createVisionClient();
      const imageData = await loadTestImage('test-image.jpg');
      
      const detections = await new Promise((resolve, reject) => {
        visionClient.DetectObjects({
          image_data: imageData,
          target_classes: [],
          max_detections: 10,
          confidence_threshold: 0.5,
        }, (error: any, response: any) => {
          if (error) reject(error);
          else resolve(response);
        });
      });

      expect((detections as any).detections).toBeDefined();

      // 2. Generate description
      const multimodalClient = await createMultimodalClient();
      const description = await new Promise((resolve, reject) => {
        multimodalClient.GenerateDescription({
          audio_data: Buffer.from([]),
          image_data: imageData,
          context: 'Describe what you see',
          style: 'detailed',
        }, (error: any, response: any) => {
          if (error) reject(error);
          else resolve(response);
        });
      });

      expect((description as any).description).toBeTruthy();
    });
  });

  // Helper functions
  async function startAllServices(): Promise<void> {
    const projectRoot = path.join(__dirname, '../..');
    
    // Start Java services
    const javaServices = ['stt', 'tts', 'vision', 'multimodal'];
    for (const service of javaServices) {
      const servicePath = getServicePath(service);
      const port = SERVICE_PORTS[service as keyof typeof SERVICE_PORTS];
      
      const process = spawn('java', ['-jar', servicePath], {
        env: { ...process.env, [`${service.toUpperCase()}_GRPC_PORT`]: port.toString() },
      });
      
      services.set(service, process);
    }
  }

  async function stopAllServices(): Promise<void> {
    for (const [name, process] of services) {
      process.kill();
    }
    services.clear();
  }

  async function waitForServicesReady(): Promise<void> {
    // Wait for all services to be ready
    await new Promise(resolve => setTimeout(resolve, 10000));
  }

  function getServicePath(service: string): string {
    const projectRoot = path.join(__dirname, '../..');
    const servicePaths: Record<string, string> = {
      stt: path.join(projectRoot, 'modules/speech/stt-service/build/libs/stt-service.jar'),
      tts: path.join(projectRoot, 'modules/speech/tts-service/build/libs/tts-service.jar'),
      vision: path.join(projectRoot, 'modules/vision/vision-service/build/libs/vision-service.jar'),
      multimodal: path.join(projectRoot, 'modules/intelligence/multimodal-service/build/libs/multimodal-service.jar'),
    };
    return servicePaths[service];
  }

  async function createSTTClient(): Promise<any> {
    const protoPath = path.join(__dirname, '../../modules/speech/stt-service/src/main/proto/stt_service.proto');
    const packageDefinition = protoLoader.loadSync(protoPath);
    const proto = grpc.loadPackageDefinition(packageDefinition) as any;
    
    return new proto.com.ghatana.audio.video.stt.grpc.SttService(
      `localhost:${SERVICE_PORTS.stt}`,
      grpc.credentials.createInsecure()
    );
  }

  async function createTTSClient(): Promise<any> {
    const protoPath = path.join(__dirname, '../../modules/speech/tts-service/src/main/proto/tts_service.proto');
    const packageDefinition = protoLoader.loadSync(protoPath);
    const proto = grpc.loadPackageDefinition(packageDefinition) as any;
    
    return new proto.com.ghatana.audio.video.tts.grpc.TtsService(
      `localhost:${SERVICE_PORTS.tts}`,
      grpc.credentials.createInsecure()
    );
  }

  async function createVisionClient(): Promise<any> {
    const protoPath = path.join(__dirname, '../../modules/vision/vision-service/src/main/proto/vision_service.proto');
    const packageDefinition = protoLoader.loadSync(protoPath);
    const proto = grpc.loadPackageDefinition(packageDefinition) as any;
    
    return new proto.com.ghatana.audio.video.vision.grpc.VisionService(
      `localhost:${SERVICE_PORTS.vision}`,
      grpc.credentials.createInsecure()
    );
  }

  async function createMultimodalClient(): Promise<any> {
    const protoPath = path.join(__dirname, '../../modules/intelligence/multimodal-service/src/main/proto/multimodal_service.proto');
    const packageDefinition = protoLoader.loadSync(protoPath);
    const proto = grpc.loadPackageDefinition(packageDefinition) as any;
    
    return new proto.com.ghatana.audio.video.multimodal.grpc.MultimodalService(
      `localhost:${SERVICE_PORTS.multimodal}`,
      grpc.credentials.createInsecure()
    );
  }

  async function loadTestAudio(filename: string): Promise<Buffer> {
    const testDataPath = path.join(__dirname, '../test-data/audio', filename);
    if (fs.existsSync(testDataPath)) {
      return fs.readFileSync(testDataPath);
    }
    // Return mock audio data if file doesn't exist
    return Buffer.from(new Array(1024).fill(0));
  }

  async function loadTestImage(filename: string): Promise<Buffer> {
    const testDataPath = path.join(__dirname, '../test-data/images', filename);
    if (fs.existsSync(testDataPath)) {
      return fs.readFileSync(testDataPath);
    }
    // Return mock image data if file doesn't exist
    return Buffer.from(new Array(1024).fill(0));
  }
});
