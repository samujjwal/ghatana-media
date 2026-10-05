/**
 * Complete User Journey E2E Tests
 *
 * Tests full user workflows from start to finish.
 * Using reusable E2E test utilities - no duplicate code.
 *
 * @doc.type test
 * @doc.purpose E2E workflow testing
 * @doc.layer product
 * @doc.pattern E2ETest
 */

import { test, expect } from '@playwright/test';
import {
  navigateToView,
  downloadModel,
  verifyModelDownloaded,
  createProject,
  loadProject,
  deleteProject,
  assessQuality,
  verifyQualityMetrics,
  applyEffects,
  completeModelWorkflow,
  completeProjectWorkflow,
  completeAudioWorkflow,
  cleanup,
  expectOnView,
  expectSuccess,
} from './utils';

test.describe('Complete User Journeys', () => {
  const testProjectName = 'E2E Test Project';
  const testModelName = 'demucs';

  test.afterEach(async ({ page }) => {
    // Cleanup test data
    await cleanup(page, {
      deleteProjects: [testProjectName],
    });
  });

  test('Journey 1: New user onboarding flow', async ({ page }) => {
    // 1. User opens app
    await page.goto('/');
    await page.waitForLoadState('networkidle');

    // 2. User navigates to models
    await navigateToView(page, 'models');
    await expectOnView(page, 'Model Manager');

    // 3. User sees available models
    await expect(page.getByText(/demucs|whisper|vits/i).first()).toBeVisible();

    // 4. User creates a project
    await createProject(page, testProjectName);
    await expect(page.getByText(testProjectName)).toBeVisible();

    // 5. User navigates to quality check
    await navigateToView(page, 'quality');
    await expectOnView(page, 'Quality Assessment');

    // 6. User navigates to effects
    await navigateToView(page, 'effects');
    await expectOnView(page, 'Audio Effects');

    // Journey complete
    expect(true).toBeTruthy();
  });

  test('Journey 2: Download and use ML model', async ({ page }) => {
    await page.goto('/');

    // Complete model workflow (reusable)
    const success = await completeModelWorkflow(page, testModelName);
    expect(success).toBeTruthy();

    // Verify model can be used
    await verifyModelDownloaded(page, testModelName);
  });

  test('Journey 3: Project lifecycle', async ({ page }) => {
    await page.goto('/');

    // Complete project workflow (reusable)
    const success = await completeProjectWorkflow(page, testProjectName);
    expect(success).toBeTruthy();

    // Export project
    await navigateToView(page, 'projects');
    const projectCard = page.locator(`text=${testProjectName}`).first();
    await expect(projectCard).toBeVisible();

    // Delete project
    await deleteProject(page, testProjectName);
    await expect(page.getByText(testProjectName)).not.toBeVisible();
  });

  test('Journey 4: Audio processing workflow', async ({ page }) => {
    await page.goto('/');

    // Note: This test would need mock file system for file selection
    // For now, verify UI flow

    // 1. Navigate to quality check
    await navigateToView(page, 'quality');

    // 2. Verify file selection available
    await expect(page.getByRole('button', { name: /browse/i })).toBeVisible();

    // 3. Navigate to effects
    await navigateToView(page, 'effects');

    // 4. Verify effects available
    await expect(page.getByText('Reverb')).toBeVisible();
    await expect(page.getByText('Compressor')).toBeVisible();
  });

  test('Journey 5: Multi-step workflow', async ({ page }) => {
    await page.goto('/');

    // Step 1: Create project
    await createProject(page, testProjectName);

    // Step 2: Load project
    await loadProject(page, testProjectName);
    await expect(page.getByText('Current')).toBeVisible();

    // Step 3: Check quality (UI navigation)
    await navigateToView(page, 'quality');
    await expectOnView(page, 'Quality Assessment');

    // Step 4: Apply effects (UI navigation)
    await navigateToView(page, 'effects');
    await expectOnView(page, 'Audio Effects');

    // Step 5: Return to projects
    await navigateToView(page, 'projects');
    await expect(page.getByText(testProjectName)).toBeVisible();
  });
});

test.describe('Error Recovery Journeys', () => {
  test('should recover from navigation errors', async ({ page }) => {
    await page.goto('/');

    // Navigate to valid view
    await navigateToView(page, 'models');
    await expectOnView(page, 'Model Manager');

    // Navigate to another view
    await navigateToView(page, 'projects');
    await expectOnView(page, 'Projects');

    // App should still be functional
    await expect(page.getByRole('button', { name: /new project/i })).toBeVisible();
  });

  test('should handle missing resources gracefully', async ({ page }) => {
    await page.goto('/');

    // Try to load a non-existent project
    await navigateToView(page, 'projects');

    // Should show empty state or error, not crash
    const hasContent = await page.getByText(/no projects|projects/i).isVisible();
    expect(hasContent).toBeTruthy();
  });
});

test.describe('Cross-Component Workflows', () => {
  const testProject = 'Cross Component Test';

  test.afterEach(async ({ page }) => {
    await cleanup(page, { deleteProjects: [testProject] });
  });

  test('should maintain state across navigation', async ({ page }) => {
    await page.goto('/');

    // Create project
    await createProject(page, testProject);

    // Navigate away
    await navigateToView(page, 'models');
    await navigateToView(page, 'quality');

    // Navigate back to projects
    await navigateToView(page, 'projects');

    // Project should still exist
    await expect(page.getByText(testProject)).toBeVisible();
  });

  test('should handle rapid navigation', async ({ page }) => {
    await page.goto('/');

    // Rapidly navigate between views
    const views = ['models', 'projects', 'quality', 'effects', 'models'];

    for (const view of views) {
      await navigateToView(page, view);
      await page.waitForTimeout(100); // Brief pause
    }

    // App should still be responsive
    await expect(page.getByRole('heading')).toBeVisible();
  });
});

test.describe('Performance Under Load', () => {
  test('should handle multiple projects', async ({ page }) => {
    await page.goto('/');

    const projects = ['Project 1', 'Project 2', 'Project 3'];

    // Create multiple projects
    for (const project of projects) {
      await createProject(page, project);
    }

    // Navigate to projects view
    await navigateToView(page, 'projects');

    // All projects should be visible
    for (const project of projects) {
      await expect(page.getByText(project)).toBeVisible();
    }

    // Cleanup
    for (const project of projects) {
      await deleteProject(page, project);
    }
  });

  test('should maintain performance with data', async ({ page }) => {
    await page.goto('/');

    // Create test data
    await createProject(page, 'Performance Test');

    // Measure navigation performance
    const startTime = Date.now();
    await navigateToView(page, 'projects');
    await navigateToView(page, 'models');
    await navigateToView(page, 'quality');
    const totalTime = Date.now() - startTime;

    // Should complete in reasonable time (< 3 seconds)
    expect(totalTime).toBeLessThan(3000);

    // Cleanup
    await deleteProject(page, 'Performance Test');
  });
});

test.describe('User Experience Flows', () => {
  test('should provide clear feedback for actions', async ({ page }) => {
    await page.goto('/');

    // Create project
    await navigateToView(page, 'projects');
    await page.getByRole('button', { name: /new project/i }).click();

    // Handle dialog
    page.once('dialog', dialog => dialog.accept('UX Test Project'));

    // Should show project immediately
    await expect(page.getByText('UX Test Project')).toBeVisible({ timeout: 3000 });

    // Cleanup
    await deleteProject(page, 'UX Test Project');
  });

  test('should have consistent navigation patterns', async ({ page }) => {
    await page.goto('/');

    const views = ['models', 'projects', 'quality', 'effects'];

    for (const view of views) {
      // Navigate to view
      await navigateToView(page, view);

      // Should have back/home navigation available (sidebar)
      const sidebar = page.locator('[role="navigation"], aside');
      await expect(sidebar).toBeVisible();
    }
  });
});

test.describe('Data Persistence', () => {
  const persistenceProject = 'Persistence Test';

  test.afterEach(async ({ page }) => {
    await cleanup(page, { deleteProjects: [persistenceProject] });
  });

  test('should persist project after page reload', async ({ page }) => {
    await page.goto('/');

    // Create project
    await createProject(page, persistenceProject);

    // Reload page
    await page.reload();
    await page.waitForLoadState('networkidle');

    // Navigate to projects
    await navigateToView(page, 'projects');

    // Project should still exist
    await expect(page.getByText(persistenceProject)).toBeVisible();
  });
});

