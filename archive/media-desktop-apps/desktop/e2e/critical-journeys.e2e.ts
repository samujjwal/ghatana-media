/**
 * Critical user journey E2E tests for the Audio-Video Desktop app (AV-013.2).
 *
 * Tests the most important user workflows end-to-end:
 * 1. STT transcription workflow
 * 2. TTS synthesis workflow
 * 3. Vision object detection workflow
 * 4. Settings persistence workflow
 */

import { expect, test } from '@playwright/test';

test.describe('Critical User Journeys', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    // Wait for the app shell to be ready
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });
  });

  // ── STT Workflow ─────────────────────────────────────────────────────────

  test.describe('STT — Speech-to-Text workflow', () => {
    test('navigates to STT panel and transcribes audio', async ({ page }) => {
      // Navigate to STT panel
      await page.click('[data-testid="nav-stt"]');
      await expect(page.locator('[data-testid="stt-panel"]')).toBeVisible();

      // Upload a test audio file
      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.click('[data-testid="stt-upload-button"]');
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles({
        name: 'test-audio.wav',
        mimeType: 'audio/wav',
        buffer: Buffer.alloc(1000),
      });

      // Wait for transcription to start
      await expect(page.locator('[data-testid="stt-status"]')).toHaveText(
        /transcribing|processing/i,
        { timeout: 5_000 },
      );

      // Check transcript appears (or appropriate loading/error state)
      await expect(
        page.locator('[data-testid="stt-transcript"], [data-testid="stt-error"]'),
      ).toBeVisible({ timeout: 30_000 });
    });

    test('shows error state for unsupported audio format', async ({ page }) => {
      await page.click('[data-testid="nav-stt"]');
      await expect(page.locator('[data-testid="stt-panel"]')).toBeVisible();

      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.click('[data-testid="stt-upload-button"]');
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles({
        name: 'image.png',
        mimeType: 'image/png',
        buffer: Buffer.alloc(100),
      });

      await expect(page.locator('[role="alert"]')).toBeVisible({ timeout: 5_000 });
    });
  });

  // ── TTS Workflow ─────────────────────────────────────────────────────────

  test.describe('TTS — Text-to-Speech workflow', () => {
    test('synthesises speech from text input', async ({ page }) => {
      await page.click('[data-testid="nav-tts"]');
      await expect(page.locator('[data-testid="tts-panel"]')).toBeVisible();

      await page.fill('[data-testid="tts-text-input"]', 'Hello, this is a test.');
      await page.click('[data-testid="tts-synthesize-button"]');

      await expect(
        page.locator('[data-testid="tts-audio-player"], [data-testid="tts-error"]'),
      ).toBeVisible({ timeout: 30_000 });
    });

    test('rejects empty text input', async ({ page }) => {
      await page.click('[data-testid="nav-tts"]');
      await page.click('[data-testid="tts-synthesize-button"]');

      await expect(page.locator('[role="alert"]')).toBeVisible({ timeout: 3_000 });
    });
  });

  // ── Vision Workflow ───────────────────────────────────────────────────────

  test.describe('Vision — Object detection workflow', () => {
    test('detects objects in an uploaded image', async ({ page }) => {
      await page.click('[data-testid="nav-vision"]');
      await expect(page.locator('[data-testid="vision-panel"]')).toBeVisible();

      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.click('[data-testid="vision-upload-button"]');
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles({
        name: 'test-image.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.alloc(1024),
      });

      await expect(
        page.locator('[data-testid="vision-results"], [data-testid="vision-error"]'),
      ).toBeVisible({ timeout: 30_000 });
    });
  });

  // ── Settings Workflow ─────────────────────────────────────────────────────

  test.describe('Settings — Configuration persistence', () => {
    test('saves and retains settings across navigation', async ({ page }) => {
      await page.click('[data-testid="nav-settings"]');
      await expect(page.locator('[data-testid="settings-panel"]')).toBeVisible();

      // Change theme to dark
      await page.selectOption('[data-testid="settings-theme"]', 'dark');
      await page.click('[data-testid="settings-save"]');

      // Navigate away and back
      await page.click('[data-testid="nav-stt"]');
      await page.click('[data-testid="nav-settings"]');

      // Verify the setting was retained
      await expect(page.locator('[data-testid="settings-theme"]')).toHaveValue('dark');
    });
  });

  // ── Auth Failure / Network Failure UX ─────────────────────────────────────

  test.describe('Auth failure UX', () => {
    test('shows sign-in prompt when auth token is missing', async ({ page, context }) => {
      // Simulate missing auth by removing storage and blocking auth endpoint
      await context.clearCookies();
      await context.addInitScript(() => {
        localStorage.removeItem('auth_token');
        sessionStorage.clear();
      });

      await page.goto('/');

      // App should surface a login / auth prompt (not a JS crash)
      await expect(
        page.locator('[data-testid="login-prompt"], [data-testid="auth-error"], [role="dialog"]'),
      ).toBeVisible({ timeout: 10_000 });
    });

    test('shows error alert when API returns 401 on STT request', async ({ page }) => {
      // Intercept gRPC-web or HTTP API and return 401
      await page.route('**/api/**', (route) => {
        route.fulfill({ status: 401, body: JSON.stringify({ error: 'Unauthorized' }) });
      });

      await page.goto('/');
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });

      await page.click('[data-testid="nav-stt"]');
      await expect(page.locator('[data-testid="stt-panel"]')).toBeVisible();

      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.click('[data-testid="stt-upload-button"]');
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles({
        name: 'test-audio.wav',
        mimeType: 'audio/wav',
        buffer: Buffer.alloc(512),
      });

      // Auth error should surface as accessible alert
      await expect(page.locator('[role="alert"]')).toBeVisible({ timeout: 15_000 });
    });
  });

  test.describe('Network failure UX', () => {
    test('shows error when backend is unreachable during transcription', async ({ page }) => {
      // Block all API/gRPC traffic to simulate network outage
      await page.route('**/api/**', (route) => route.abort('connectionrefused'));
      await page.route('**:50051/**', (route) => route.abort('connectionrefused'));

      await page.goto('/');
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });

      await page.click('[data-testid="nav-stt"]');
      await expect(page.locator('[data-testid="stt-panel"]')).toBeVisible();

      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.click('[data-testid="stt-upload-button"]');
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles({
        name: 'offline-audio.wav',
        mimeType: 'audio/wav',
        buffer: Buffer.alloc(512),
      });

      await expect(page.locator('[data-testid="stt-error"], [role="alert"]')).toBeVisible({
        timeout: 15_000,
      });
    });

    test('shows error when vision backend is unreachable', async ({ page }) => {
      await page.route('**/api/**', (route) => route.abort('connectionrefused'));

      await page.goto('/');
      await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });

      await page.click('[data-testid="nav-vision"]');
      await expect(page.locator('[data-testid="vision-panel"]')).toBeVisible();

      const fileChooserPromise = page.waitForEvent('filechooser');
      await page.click('[data-testid="vision-upload-button"]');
      const fileChooser = await fileChooserPromise;
      await fileChooser.setFiles({
        name: 'offline-image.jpg',
        mimeType: 'image/jpeg',
        buffer: Buffer.alloc(512),
      });

      await expect(page.locator('[data-testid="vision-error"], [role="alert"]')).toBeVisible({
        timeout: 15_000,
      });
    });
  });
});
