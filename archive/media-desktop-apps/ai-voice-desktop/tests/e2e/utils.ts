/**
 * E2E Test Utilities
 *
 * Reusable helpers for end-to-end testing with Playwright.
 * Following "reuse first" principle.
 *
 * @doc.type utility
 * @doc.purpose E2E testing helpers
 * @doc.layer product
 * @doc.pattern TestUtility
 */

import { Page, expect } from '@playwright/test';

// ============================================================================
// Navigation Helpers (Reusable)
// ============================================================================

/**
 * Navigates to a specific view in the app
 * Reusable across all E2E tests
 */
export async function navigateToView(page: Page, viewName: string) {
  const viewMap: Record<string, string> = {
    'studio': 'Studio',
    'models': 'Models',
    'projects': 'Projects',
    'quality': 'Quality',
    'effects': 'Effects',
    'voices': 'Voices',
    'training': 'Training',
    'mixer': 'Mixer',
    'settings': 'Settings',
  };

  const buttonText = viewMap[viewName] || viewName;
  await page.getByRole('button', { name: buttonText }).click();
  await page.waitForLoadState('networkidle');
}

/**
 * Waits for app to be fully loaded
 */
export async function waitForAppLoad(page: Page) {
  await page.waitForSelector('[data-testid="app-loaded"]', { timeout: 10000 });
  await page.waitForLoadState('networkidle');
}

// ============================================================================
// Model Manager E2E Helpers (Reusable)
// ============================================================================

/**
 * Downloads a model via UI
 */
export async function downloadModel(page: Page, modelName: string) {
  await navigateToView(page, 'models');

  // Find the model card
  const modelCard = page.locator(`text=${modelName}`).first();
  await expect(modelCard).toBeVisible();

  // Click download button
  await modelCard.locator('..').getByRole('button', { name: /download/i }).click();

  // Wait for download to complete
  await expect(page.getByText(/downloaded/i)).toBeVisible({ timeout: 60000 });
}

/**
 * Verifies model is downloaded
 */
export async function verifyModelDownloaded(page: Page, modelName: string) {
  await navigateToView(page, 'models');

  const modelCard = page.locator(`text=${modelName}`).first();
  await expect(modelCard).toBeVisible();

  // Should show "Downloaded" badge
  await expect(modelCard.locator('..').getByText('Downloaded')).toBeVisible();
}

/**
 * Deletes a model via UI
 */
export async function deleteModel(page: Page, modelName: string) {
  await navigateToView(page, 'models');

  const modelCard = page.locator(`text=${modelName}`).first();
  await modelCard.locator('..').getByRole('button', { name: /delete/i }).click();

  // Confirm deletion
  page.once('dialog', dialog => dialog.accept());

  // Wait for deletion to complete
  await page.waitForTimeout(1000);
}

// ============================================================================
// Project Manager E2E Helpers (Reusable)
// ============================================================================

/**
 * Creates a new project via UI
 */
export async function createProject(page: Page, projectName: string) {
  await navigateToView(page, 'projects');

  await page.getByRole('button', { name: /new project/i }).click();

  // Handle prompt
  page.once('dialog', dialog => dialog.accept(projectName));

  // Wait for project to be created
  await expect(page.getByText(projectName)).toBeVisible({ timeout: 5000 });
}

/**
 * Loads a project via UI
 */
export async function loadProject(page: Page, projectName: string) {
  await navigateToView(page, 'projects');

  await page.getByText(projectName).click();

  // Verify project is loaded (Current badge)
  await expect(page.getByText('Current')).toBeVisible();
}

/**
 * Exports a project via UI
 */
export async function exportProject(page: Page, projectName: string, exportPath: string) {
  await navigateToView(page, 'projects');

  const projectCard = page.locator(`text=${projectName}`).first();
  await projectCard.locator('..').getByRole('button', { name: /export/i }).click();

  // Handle file save dialog (mocked in test)
  await page.waitForTimeout(500);
}

/**
 * Deletes a project via UI
 */
export async function deleteProject(page: Page, projectName: string) {
  await navigateToView(page, 'projects');

  const projectCard = page.locator(`text=${projectName}`).first();
  await projectCard.locator('..').getByRole('button', { name: /delete/i }).click();

  // Confirm deletion
  page.once('dialog', dialog => dialog.accept());

  // Wait for deletion
  await expect(page.getByText(projectName)).not.toBeVisible({ timeout: 5000 });
}

// ============================================================================
// Quality Assessment E2E Helpers (Reusable)
// ============================================================================

/**
 * Performs quality assessment via UI
 */
export async function assessQuality(page: Page, audioPath: string, options?: {
  referenceText?: string;
  referenceAudio?: string;
}) {
  await navigateToView(page, 'quality');

  // Click browse button
  await page.getByRole('button', { name: /browse/i }).first().click();

  // File selection would be mocked in tests
  await page.waitForTimeout(500);

  // Add reference text if provided
  if (options?.referenceText) {
    await page.getByPlaceholder(/enter the expected transcript/i).fill(options.referenceText);
  }

  // Click assess button
  await page.getByRole('button', { name: /assess quality/i }).click();

  // Wait for assessment to complete
  await expect(page.getByText(/excellent|good|fair|poor/i)).toBeVisible({ timeout: 30000 });
}

/**
 * Verifies quality metrics are displayed
 */
export async function verifyQualityMetrics(page: Page) {
  await expect(page.getByText(/mean opinion score/i)).toBeVisible();
  await expect(page.getByText(/signal to noise ratio/i)).toBeVisible();
}

// ============================================================================
// Effects E2E Helpers (Reusable)
// ============================================================================

/**
 * Applies audio effects via UI
 */
export async function applyEffects(page: Page, audioPath: string, effects: string[]) {
  await navigateToView(page, 'effects');

  // Select audio file
  await page.getByRole('button', { name: /browse/i }).click();
  await page.waitForTimeout(500);

  // Enable effects
  for (const effect of effects) {
    const effectSection = page.locator(`text=${effect}`).first();
    const toggle = effectSection.locator('..').locator('input[type="checkbox"]');
    await toggle.check();
  }

  // Click apply button
  await page.getByRole('button', { name: /apply effects/i }).click();

  // Wait for processing
  await expect(page.getByText(/effects applied successfully/i)).toBeVisible({ timeout: 30000 });
}

// ============================================================================
// Assertion Helpers (Reusable)
// ============================================================================

/**
 * Verifies user is on specific view
 */
export async function expectOnView(page: Page, viewTitle: string) {
  await expect(page.getByRole('heading', { name: viewTitle })).toBeVisible();
}

/**
 * Verifies loading state
 */
export async function expectLoading(page: Page) {
  await expect(page.getByRole('status')).toBeVisible();
}

/**
 * Verifies no loading state
 */
export async function expectNotLoading(page: Page) {
  await expect(page.getByRole('status')).not.toBeVisible();
}

/**
 * Verifies error message
 */
export async function expectError(page: Page, message: string | RegExp) {
  await expect(page.getByText(message)).toBeVisible();
}

/**
 * Verifies success message
 */
export async function expectSuccess(page: Page, message: string | RegExp) {
  await expect(page.getByText(message)).toBeVisible();
}

// ============================================================================
// Workflow Helpers (Reusable Complete Flows)
// ============================================================================

/**
 * Complete workflow: Download model and use it
 */
export async function completeModelWorkflow(page: Page, modelName: string) {
  // Download model
  await downloadModel(page, modelName);

  // Verify downloaded
  await verifyModelDownloaded(page, modelName);

  return true;
}

/**
 * Complete workflow: Create project, modify, save
 */
export async function completeProjectWorkflow(page: Page, projectName: string) {
  // Create project
  await createProject(page, projectName);

  // Load project
  await loadProject(page, projectName);

  // Project is now active
  return true;
}

/**
 * Complete workflow: Load audio, assess quality, apply effects
 */
export async function completeAudioWorkflow(page: Page, audioPath: string) {
  // Assess quality
  await assessQuality(page, audioPath);
  await verifyQualityMetrics(page);

  // Apply effects
  await applyEffects(page, audioPath, ['Reverb', 'Limiter']);

  return true;
}

// ============================================================================
// Cleanup Helpers (Reusable)
// ============================================================================

/**
 * Cleans up test data
 */
export async function cleanup(page: Page, options?: {
  deleteProjects?: string[];
  deleteModels?: string[];
}) {
  // Delete projects
  if (options?.deleteProjects) {
    for (const project of options.deleteProjects) {
      try {
        await deleteProject(page, project);
      } catch (error) {
        // Ignore errors during cleanup
      }
    }
  }

  // Delete models
  if (options?.deleteModels) {
    for (const model of options.deleteModels) {
      try {
        await deleteModel(page, model);
      } catch (error) {
        // Ignore errors during cleanup
      }
    }
  }
}

// ============================================================================
// Performance Helpers (Reusable)
// ============================================================================

/**
 * Measures page load time
 */
export async function measurePageLoad(page: Page): Promise<number> {
  const startTime = Date.now();
  await page.waitForLoadState('networkidle');
  const endTime = Date.now();
  return endTime - startTime;
}

/**
 * Measures interaction time
 */
export async function measureInteraction(page: Page, action: () => Promise<void>): Promise<number> {
  const startTime = Date.now();
  await action();
  const endTime = Date.now();
  return endTime - startTime;
}

/**
 * Verifies performance target
 */
export async function expectPerformance(actualMs: number, targetMs: number) {
  expect(actualMs).toBeLessThan(targetMs);
}

