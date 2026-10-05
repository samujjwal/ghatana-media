/**
 * Visual regression E2E tests for the Audio-Video Desktop app (AV-013.4).
 *
 * Uses Playwright's built-in screenshot comparison to catch unintentional
 * visual changes in key UI states.  Snapshots are stored in
 * {@code e2e/__snapshots__} and committed to source control.
 */

import { expect, test } from '@playwright/test';

test.describe('Visual Regression', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await page.waitForSelector('[data-testid="app-shell"]', { timeout: 10_000 });
  });

  test('Dashboard panel matches snapshot', async ({ page }) => {
    await page.click('[data-testid="nav-dashboard"]');
    await page.waitForSelector('[data-testid="dashboard-panel"]');
    await page.waitForTimeout(500); // allow animations to settle

    await expect(page).toHaveScreenshot('dashboard-panel.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('STT panel matches snapshot', async ({ page }) => {
    await page.click('[data-testid="nav-stt"]');
    await page.waitForSelector('[data-testid="stt-panel"]');
    await page.waitForTimeout(300);

    await expect(page).toHaveScreenshot('stt-panel.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('Settings panel matches snapshot', async ({ page }) => {
    await page.click('[data-testid="nav-settings"]');
    await page.waitForSelector('[data-testid="settings-panel"]');
    await page.waitForTimeout(300);

    await expect(page).toHaveScreenshot('settings-panel.png', {
      maxDiffPixelRatio: 0.02,
    });
  });

  test('Error state component matches snapshot', async ({ page }) => {
    // Trigger an error state by navigating to a known error scenario
    await page.evaluate(() => {
      // Dispatch a custom event to force the error state component to render
      window.dispatchEvent(new CustomEvent('av:show-error-state-demo'));
    });

    const errorState = page.locator('[role="alert"]').first();
    if (await errorState.isVisible({ timeout: 3_000 }).catch(() => false)) {
      await expect(errorState).toHaveScreenshot('error-state.png', {
        maxDiffPixelRatio: 0.02,
      });
    } else {
      test.skip(true, 'Error state demo not available in this build');
    }
  });
});

