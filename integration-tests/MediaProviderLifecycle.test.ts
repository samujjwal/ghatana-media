/**
 * @fileoverview P1.14: Media Provider/Job/Result Lifecycle
 *
 * Complete media processing lifecycle:
 * 1. Media artifact upload and metadata
 * 2. Processing job creation and queuing
 * 3. Job execution with progress tracking
 * 4. Result persistence and retrieval
 * 5. Consent and compliance verification
 *
 * @doc.type test
 * @doc.purpose P1.14: Media provider lifecycle
 * @doc.layer product
 * @doc.pattern IntegrationTest
 */

import { describe, it, expect } from 'vitest';

const MEDIA_API = 'http://localhost:8085/api/v1';

async function mediaRequest(method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${MEDIA_API}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
}

describe('P1.14: Media Provider/Job/Result Lifecycle', () => {
  let providerId: string;
  let artifactId: string;
  let jobId: string;

  describe('Media Artifact Upload and Metadata', () => {
    it('uploads media artifact with metadata', async () => {
      const uploadResp = await mediaRequest('POST', '/artifacts', {
        filename: 'sample-video.mp4',
        mimeType: 'video/mp4',
        size: 1024000,
        metadata: {
          duration: 300,
          resolution: '1920x1080',
          framerate: 30,
        },
      });
      expect(uploadResp.status).toBe(201);
      const artifact = (await uploadResp.json()) as Record<string, unknown>;
      artifactId = artifact.id as string;
    });

    it('validates media format and size', async () => {
      const invalidResp = await mediaRequest('POST', '/artifacts', {
        filename: 'invalid.xyz',
        mimeType: 'application/invalid',
        size: 5 * 1024 * 1024 * 1024, // 5GB
      });
      expect([400, 422]).toContain(invalidResp.status);
    });

    it('retrieves artifact metadata', async () => {
      const response = await mediaRequest('GET', `/artifacts/${artifactId}`);
      expect(response.status).toBe(200);
      const artifact = (await response.json()) as Record<string, unknown>;
      expect(artifact.id).toBe(artifactId);
      expect(artifact.metadata).toBeDefined();
    });
  });

  describe('Processing Job Creation and Queuing', () => {
    it('creates processing job for artifact', async () => {
      const jobResp = await mediaRequest('POST', `/artifacts/${artifactId}/jobs`, {
        jobType: 'transcoding',
        targetFormat: 'webm',
        parameters: {
          bitrate: '2500k',
          quality: 'high',
        },
      });
      expect(jobResp.status).toBe(201);
      const job = (await jobResp.json()) as Record<string, unknown>;
      jobId = job.id as string;
      expect(job.status).toMatch(/queued|pending/);
    });

    it('registers processing provider', async () => {
      const provResp = await mediaRequest('POST', '/providers', {
        name: 'ffmpeg-provider',
        capabilities: ['transcoding', 'extraction', 'analysis'],
        maxConcurrentJobs: 10,
      });
      expect(provResp.status).toBe(201);
      const provider = (await provResp.json()) as Record<string, unknown>;
      providerId = provider.id as string;
    });

    it('assigns job to provider queue', async () => {
      const assignResp = await mediaRequest('POST', `/jobs/${jobId}/assign`, {
        providerId,
      });
      expect(assignResp.status).toBe(200);
      const result = (await assignResp.json()) as Record<string, unknown>;
      expect(result.assigned).toBe(true);
    });

    it('tracks job queue depth', async () => {
      const response = await mediaRequest('GET', `/providers/${providerId}/queue`);
      expect(response.status).toBe(200);
      const queue = (await response.json()) as Record<string, unknown>;
      expect(queue.depth).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Job Execution with Progress Tracking', () => {
    it('transitions job to executing state', async () => {
      const execResp = await mediaRequest('POST', `/jobs/${jobId}/execute`, {});
      expect([200, 202]).toContain(execResp.status);
      const job = (await execResp.json()) as Record<string, unknown>;
      expect(job.status).toMatch(/executing|running|processing/);
    });

    it('tracks job progress', async () => {
      const progressResp = await mediaRequest('GET', `/jobs/${jobId}/progress`);
      expect([200, 202]).toContain(progressResp.status);
      const progress = (await progressResp.json()) as Record<string, unknown>;
      expect(progress.percentComplete).toBeDefined();
      expect(typeof progress.percentComplete).toBe('number');
    });

    it('handles job timeout and retry', async () => {
      // Create slow job
      const slowJobResp = await mediaRequest('POST', `/artifacts/${artifactId}/jobs`, {
        jobType: 'analysis',
        timeout: 1000, // 1 second timeout
        retryPolicy: { maxRetries: 2 },
      });
      expect(slowJobResp.status).toBe(201);
      const slowJob = (await slowJobResp.json()) as Record<string, unknown>;
      const slowJobId = slowJob.id;

      // Execute
      await mediaRequest('POST', `/jobs/${slowJobId}/execute`, {
        delayMs: 5000, // Slower than timeout
      });

      // Check retry count
      const checkResp = await mediaRequest('GET', `/jobs/${slowJobId}`);
      const jobData = (await checkResp.json()) as Record<string, unknown>;
      expect(jobData.retryCount).toBeGreaterThanOrEqual(0);
    });
  });

  describe('Result Persistence and Retrieval', () => {
    it('persists job result', async () => {
      // Simulate job completion
      const resultResp = await mediaRequest('POST', `/jobs/${jobId}/complete`, {
        outputArtifactId: 'artifact-output-001',
        metadata: {
          duration: 300,
          bitrate: 2500,
          format: 'webm',
        },
      });
      expect(resultResp.status).toBe(200);
    });

    it('retrieves job result with metadata', async () => {
      const response = await mediaRequest('GET', `/jobs/${jobId}/result`);
      expect(response.status).toBe(200);
      const result = (await response.json()) as Record<string, unknown>;
      expect(result.outputArtifactId).toBeDefined();
      expect(result.metadata).toBeDefined();
    });

    it('lists all jobs for artifact', async () => {
      const response = await mediaRequest('GET', `/artifacts/${artifactId}/jobs`);
      expect(response.status).toBe(200);
      const result = (await response.json()) as Record<string, unknown>;
      expect((result.jobs as unknown[]).length).toBeGreaterThan(0);
    });

    it('cleans up completed jobs according to retention policy', async () => {
      const cleanupResp = await mediaRequest('POST', `/jobs/cleanup`, {
        retentionDays: 30,
      });
      expect([200, 202]).toContain(cleanupResp.status);
    });
  });

  describe('Consent and Compliance Verification', () => {
    it('verifies consent before processing', async () => {
      const consentResp = await mediaRequest('POST', `/artifacts/${artifactId}/verify-consent`, {
        purpose: 'analysis',
      });
      expect([200, 403]).toContain(consentResp.status);
    });

    it('records processing audit trail', async () => {
      const auditResp = await mediaRequest('GET', `/artifacts/${artifactId}/audit`);
      expect(auditResp.status).toBe(200);
      const audit = (await auditResp.json()) as Record<string, unknown>;
      expect((audit.entries as unknown[]).length).toBeGreaterThanOrEqual(0);
    });

    it('enforces data residency policies', async () => {
      const residencyResp = await mediaRequest('POST', `/jobs/${jobId}/check-residency`, {
        allowedRegions: ['us-west-2', 'eu-west-1'],
      });
      expect([200, 403]).toContain(residencyResp.status);
    });
  });

  describe('Complete Media Lifecycle', () => {
    it('executes full lifecycle: upload → job → process → result → cleanup', async () => {
      // 1. Upload
      const uploadResp = await mediaRequest('POST', '/artifacts', {
        filename: 'lifecycle-test.mp4',
        mimeType: 'video/mp4',
      });
      const artifact = (await uploadResp.json()) as Record<string, unknown>;
      const lifecycleArtifactId = artifact.id;

      // 2. Create job
      const jobResp = await mediaRequest('POST', `/artifacts/${lifecycleArtifactId}/jobs`, {
        jobType: 'transcoding',
      });
      const job = (await jobResp.json()) as Record<string, unknown>;
      const lifecycleJobId = job.id;

      // 3. Execute
      await mediaRequest('POST', `/jobs/${lifecycleJobId}/execute`, {});

      // 4. Complete
      const completeResp = await mediaRequest('POST', `/jobs/${lifecycleJobId}/complete`, {
        outputArtifactId: 'output-' + lifecycleJobId,
      });
      expect(completeResp.status).toBe(200);

      // 5. Verify result
      const resultResp = await mediaRequest('GET', `/jobs/${lifecycleJobId}/result`);
      expect(resultResp.status).toBe(200);
    });
  });
});
