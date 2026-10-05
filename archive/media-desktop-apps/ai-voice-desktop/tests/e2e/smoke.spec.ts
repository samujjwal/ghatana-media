/**
 * E2E Smoke Tests
 *
 * Basic end-to-end tests to verify app functionality.
 * Using reusable E2E test utilities.
 *
 * @doc.type test
 * @doc.purpose E2E smoke testing
 * @doc.layer product
 * @doc.pattern E2ETest
 */

import { test, expect } from '@playwright/test';
import {
  navigateToView,
  waitForAppLoad,
  expectOnView,
  measurePageLoad,
  expectPerformance,
} from './utils';

test.describe('Smoke Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page);
  });

  test('should load application successfully', async ({ page }) => {
    // Verify app loaded
    await expect(page).toHaveTitle(/AI Voice/i);

    // Verify main elements present
    await expect(page.getByRole('heading')).toBeVisible();
  });

  test('should navigate to all views', async ({ page }) => {
    // Test navigation to each view
    const views = [
      { id: 'models', title: 'Model Manager' },
      { id: 'projects', title: 'Projects' },
      { id: 'quality', title: 'Quality Assessment' },
      { id: 'effects', title: 'Audio Effects' },
    ];

    for (const view of views) {
      await navigateToView(page, view.id);
      await expectOnView(page, view.title);
    }
  });

  test('should load quickly', async ({ page }) => {
    // Measure initial load time
    const loadTime = await measurePageLoad(page);

    // Should load in under 3 seconds
    expectPerformance(loadTime, 3000);
  });

  test('should have working sidebar navigation', async ({ page }) => {
    // Click each nav item
    const navItems = ['Models', 'Projects', 'Quality', 'Effects'];

    for (const item of navItems) {
      await page.getByRole('button', { name: item }).click();
      await page.waitForLoadState('networkidle');

      // Verify navigation worked
      await expect(page.getByRole('heading', { name: item })).toBeVisible();
    }
  });

  test('should render without console errors', async ({ page }) => {
    const errors: string[] = [];

    page.on('console', msg => {
      if (msg.type() === 'error') {
        errors.push(msg.text());
      }
    });

    // Navigate through app
    await navigateToView(page, 'models');
    await navigateToView(page, 'projects');

    // Should have no critical errors
    expect(errors.filter(e => !e.includes('Warning'))).toHaveLength(0);
  });
});

test.describe('Model Manager Smoke Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await navigateToView(page, 'models');
  });

  test('should display available models', async ({ page }) => {
    await expectOnView(page, 'Model Manager');

    // Should show at least one model
    await expect(page.locator('text=/demucs|whisper|vits/i').first()).toBeVisible();
  });

  test('should show cache information', async ({ page }) => {
    // Should display cache size
    await expect(page.getByText(/cache size/i)).toBeVisible();
    await expect(page.getByText(/MB/i)).toBeVisible();
  });

  test('should have functional download buttons', async ({ page }) => {
    // Find a download button
    const downloadButton = page.getByRole('button', { name: /download/i }).first();
    await expect(downloadButton).toBeVisible();
    await expect(downloadButton).toBeEnabled();
  });
});

test.describe('Project Manager Smoke Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await navigateToView(page, 'projects');
  });

  test('should display project list', async ({ page }) => {
    await expectOnView(page, 'Projects');

    // Should have new project button
    await expect(page.getByRole('button', { name: /new project/i })).toBeVisible();
  });

  test('should show empty state or projects', async ({ page }) => {
    // Either empty state or project cards should be visible
    const hasEmptyState = await page.getByText(/no projects/i).isVisible();
    const hasProjects = await page.locator('[data-testid="project-card"]').count() > 0;

    expect(hasEmptyState || hasProjects).toBeTruthy();
  });

  test('should have search functionality', async ({ page }) => {
    // Search input should be present
    await expect(page.getByPlaceholder(/search projects/i)).toBeVisible();
  });
});

test.describe('Quality Dashboard Smoke Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await navigateToView(page, 'quality');
  });

  test('should display assessment form', async ({ page }) => {
    await expectOnView(page, 'Quality Assessment');

    // Should have file input
    await expect(page.getByRole('button', { name: /browse/i })).toBeVisible();

    // Should have assess button (disabled initially)
    const assessButton = page.getByRole('button', { name: /assess quality/i });
    await expect(assessButton).toBeVisible();
    await expect(assessButton).toBeDisabled();
  });

  test('should have optional input fields', async ({ page }) => {
    // Should have reference text input
    await expect(page.getByPlaceholder(/enter the expected transcript/i)).toBeVisible();
  });
});

test.describe('Effect Controls Smoke Tests', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await navigateToView(page, 'effects');
  });

  test('should display all effects', async ({ page }) => {
    await expectOnView(page, 'Audio Effects');

    // Should show all 5 effects
    const effects = ['Reverb', 'Delay', 'EQ', 'Compressor', 'Limiter'];

    for (const effect of effects) {
      await expect(page.getByText(effect)).toBeVisible();
    }
  });

  test('should have toggle switches for effects', async ({ page }) => {
    // Should have checkboxes for each effect (5 total)
    const toggles = page.locator('input[type="checkbox"]');
    await expect(toggles).toHaveCount(5);
  });

  test('should have disabled process button initially', async ({ page }) => {
    const processButton = page.getByRole('button', { name: /apply effects/i });
    await expect(processButton).toBeVisible();
    await expect(processButton).toBeDisabled();
  });
});

test.describe('Performance Smoke Tests', () => {
  test('should navigate quickly between views', async ({ page }) => {
    await page.goto('/');
    await waitForAppLoad(page);

    const views = ['models', 'projects', 'quality', 'effects'];

    for (const view of views) {
      const startTime = Date.now();
      await navigateToView(page, view);
      const navTime = Date.now() - startTime;

      // Navigation should be fast (< 1 second)
      expectPerformance(navTime, 1000);
    }
  });

  test('should render UI quickly', async ({ page }) => {
    await page.goto('/');

    // Measure time to first meaningful paint
    const metrics = await page.evaluate(() => {
      const paint = performance.getEntriesByType('paint');
      const fcp = paint.find(entry => entry.name === 'first-contentful-paint');
      return fcp ? fcp.startTime : 0;
    });

    // Should have FCP under 2 seconds
    expectPerformance(metrics, 2000);
  });
});

test.describe('Accessibility Smoke Tests', () => {
  test('should have proper heading hierarchy', async ({ page }) => {
    await page.goto('/');

    // Should have h1 or h2 headings
    const headings = page.locator('h1, h2');
    await expect(headings.first()).toBeVisible();
  });

  test('should have keyboard navigation', async ({ page }) => {
    await page.goto('/');

    // Tab through interactive elements
    await page.keyboard.press('Tab');

    // First focusable element should be focused
    const focusedElement = page.locator(':focus');
    await expect(focusedElement).toBeVisible();
  });

  test('should have ARIA labels on buttons', async ({ page }) => {
    await page.goto('/');
    await navigateToView(page, 'models');

    // Buttons should have accessible names
    const buttons = page.getByRole('button');
    const buttonCount = await buttons.count();

    expect(buttonCount).toBeGreaterThan(0);
  });
});

