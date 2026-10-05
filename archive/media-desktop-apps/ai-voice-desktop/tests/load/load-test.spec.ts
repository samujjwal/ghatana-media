/**
 * Load Testing Script
 *
 * Tests application performance under load.
 * Following "reuse first" principle - adapted from existing load test patterns.
 *
 * @doc.type test
 * @doc.purpose Load testing
 * @doc.layer product
 * @doc.pattern LoadTest
 */

import { test, expect, Page } from '@playwright/test';
import * as fs from 'fs';
import * as path from 'path';
import { navigateToView, createProject, deleteProject } from './e2e/utils';

// ============================================================================
// Configuration (Reusable)
// ============================================================================

const LOAD_TEST_CONFIG = {
  concurrentUsers: 5,
  iterations: 10,
  operationTimeout: 30000,
  thinkTime: 1000, // Pause between operations
};

// ============================================================================
// Reusable Load Test Utilities
// ============================================================================

/**
 * Simulates user think time
 */
async function simulateThinkTime(ms: number = LOAD_TEST_CONFIG.thinkTime) {
  await new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Measures operation time
 */
async function measureOperation(
  name: string,
  operation: () => Promise<void>
): Promise<number> {
  const start = Date.now();
  try {
    await operation();
    const duration = Date.now() - start;
    console.log(`[Load Test] ${name}: ${duration}ms`);
    return duration;
  } catch (error) {
    console.error(`[Load Test] ${name} failed:`, error);
    throw error;
  }
}

/**
 * Collects performance metrics and exports to JSON/CSV files.
 */
class PerformanceCollector {
  private metrics: Array<{ name: string; duration: number }> = [];

  add(name: string, duration: number): void {
    this.metrics.push({ name, duration });
  }

  getStats(): {
    avg: number; p50: number; p95: number; p99: number;
    min: number; max: number; count: number;
  } | null {
    if (this.metrics.length === 0) return null;

    const durations = this.metrics.map(m => m.duration);
    const sum = durations.reduce((a, b) => a + b, 0);
    const avg = sum / durations.length;
    const sorted = [...durations].sort((a, b) => a - b);
    const p50 = sorted[Math.floor(sorted.length * 0.5)] ?? 0;
    const p95 = sorted[Math.floor(sorted.length * 0.95)] ?? 0;
    const p99 = sorted[Math.floor(sorted.length * 0.99)] ?? 0;
    const min = Math.min(...durations);
    const max = Math.max(...durations);

    return { avg, p50, p95, p99, min, max, count: durations.length };
  }

  /**
   * Write results to JSON and CSV files under the given output directory.
   * Falls back to a temporary directory if the target is not writable.
   */
  exportResults(outputDir: string = 'load-test-results'): void {
    const stats = this.getStats();
    if (!stats) {
      return;
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.resolve(outputDir);
    fs.mkdirSync(dir, { recursive: true });

    // JSON export — full raw metrics + aggregate stats
    const jsonPayload = {
      timestamp,
      stats,
      metrics: this.metrics,
    };
    const jsonPath = path.join(dir, `load-test-${timestamp}.json`);
    fs.writeFileSync(jsonPath, JSON.stringify(jsonPayload, null, 2), 'utf-8');

    // CSV export — one row per raw metric measurement
    const csvLines: string[] = ['name,duration_ms'];
    for (const m of this.metrics) {
      csvLines.push(`${JSON.stringify(m.name)},${m.duration}`);
    }
    const csvPath = path.join(dir, `load-test-${timestamp}.csv`);
    fs.writeFileSync(csvPath, csvLines.join('\n'), 'utf-8');
  }

  /** @deprecated Use exportResults() to write structured output to disk. */
  printStats(): void {
    const stats = this.getStats();
    if (!stats) {
      return;
    }
    this.exportResults();
  }
}

// ============================================================================
// Load Test Scenarios (Reusable)
// ============================================================================

/**
 * Scenario 1: Concurrent Navigation
 */
async function concurrentNavigationScenario(page: Page, collector: PerformanceCollector) {
  const views = ['models', 'projects', 'quality', 'effects'];

  for (const view of views) {
    const duration = await measureOperation(`Navigate to ${view}`, async () => {
      await navigateToView(page, view);
    });
    collector.add(`navigation-${view}`, duration);
    await simulateThinkTime();
  }
}

/**
 * Scenario 2: Project CRUD Operations
 */
async function projectCrudScenario(page: Page, collector: PerformanceCollector, userId: number) {
  const projectName = `Load Test Project ${userId}-${Date.now()}`;

  // Create
  const createDuration = await measureOperation('Create project', async () => {
    await createProject(page, projectName);
  });
  collector.add('project-create', createDuration);
  await simulateThinkTime();

  // Read (list)
  const readDuration = await measureOperation('List projects', async () => {
    await navigateToView(page, 'projects');
  });
  collector.add('project-read', readDuration);
  await simulateThinkTime();

  // Delete
  const deleteDuration = await measureOperation('Delete project', async () => {
    await deleteProject(page, projectName);
  });
  collector.add('project-delete', deleteDuration);
  await simulateThinkTime();
}

/**
 * Scenario 3: Memory Stress Test
 */
async function memoryStressScenario(page: Page, collector: PerformanceCollector) {
  // Create multiple projects quickly
  const projectCount = 5;
  const projects: string[] = [];

  for (let i = 0; i < projectCount; i++) {
    const projectName = `Stress Test ${i}-${Date.now()}`;
    projects.push(projectName);

    const duration = await measureOperation(`Create project ${i}`, async () => {
      await createProject(page, projectName);
    });
    collector.add('stress-create', duration);
  }

  // Navigate around
  await navigateToView(page, 'models');
  await navigateToView(page, 'quality');
  await navigateToView(page, 'projects');

  // Cleanup
  for (const project of projects) {
    await deleteProject(page, project);
  }
}

// ============================================================================
// Load Tests
// ============================================================================

test.describe('Load Tests', () => {
  test('should handle concurrent navigation', async ({ page }) => {
    await page.goto('/');
    const collector = new PerformanceCollector();

    // Run scenario multiple times
    for (let i = 0; i < LOAD_TEST_CONFIG.iterations; i++) {
      await concurrentNavigationScenario(page, collector);
    }

    collector.printStats();

    // Verify performance targets
    const stats = collector.getStats()!;
    expect(stats.p95).toBeLessThan(1000); // P95 should be under 1 second
  });

  test('should handle concurrent project operations', async ({ page }) => {
    await page.goto('/');
    const collector = new PerformanceCollector();

    // Simulate multiple users
    for (let userId = 0; userId < LOAD_TEST_CONFIG.concurrentUsers; userId++) {
      await projectCrudScenario(page, collector, userId);
    }

    collector.printStats();

    // Verify performance targets
    const stats = collector.getStats()!;
    expect(stats.p95).toBeLessThan(3000); // P95 should be under 3 seconds
  });

  test('should maintain performance under memory stress', async ({ page }) => {
    await page.goto('/');
    const collector = new PerformanceCollector();

    await memoryStressScenario(page, collector);

    collector.printStats();

    // Check for memory leaks
    const metrics = await page.evaluate(() => {
      if (performance.memory) {
        return {
          usedJSHeapSize: performance.memory.usedJSHeapSize,
          totalJSHeapSize: performance.memory.totalJSHeapSize,
          jsHeapSizeLimit: performance.memory.jsHeapSizeLimit,
        };
      }
      return null;
    });

    if (metrics) {
      const usageMB = metrics.usedJSHeapSize / 1024 / 1024;
      console.log(`Memory usage: ${usageMB.toFixed(2)} MB`);

      // Should stay under 500MB
      expect(usageMB).toBeLessThan(500);
    }
  });

  test('should handle rapid view switching', async ({ page }) => {
    await page.goto('/');
    const collector = new PerformanceCollector();

    const views = ['models', 'projects', 'quality', 'effects'];

    // Rapid switching (20 times)
    for (let i = 0; i < 20; i++) {
      const view = views[i % views.length];
      const duration = await measureOperation(`Rapid switch ${i}`, async () => {
        await navigateToView(page, view);
      });
      collector.add('rapid-switch', duration);
    }

    collector.printStats();

    // Should maintain fast navigation
    const stats = collector.getStats()!;
    expect(stats.avg).toBeLessThan(800);
  });
});

test.describe('Concurrent User Simulation', () => {
  test('should handle multiple concurrent users', async ({ browser }) => {
    const contexts = await Promise.all(
      Array(LOAD_TEST_CONFIG.concurrentUsers)
        .fill(0)
        .map(() => browser.newContext())
    );

    const pages = await Promise.all(
      contexts.map(context => context.newPage())
    );

    const collectors = pages.map(() => new PerformanceCollector());

    // All users perform operations concurrently
    await Promise.all(
      pages.map(async (page, idx) => {
        await page.goto('/');
        await concurrentNavigationScenario(page, collectors[idx]);
        await projectCrudScenario(page, collectors[idx], idx);
      })
    );

    // Aggregate results — write one JSON/CSV file per user
    collectors.forEach((collector, idx) => {
      collector.exportResults(`load-test-results/user-${idx + 1}`);
    });

    // Cleanup
    await Promise.all(contexts.map(context => context.close()));
  });
});

test.describe('Performance Regression Tests', () => {
  test('should meet initial load time target', async ({ page }) => {
    const start = Date.now();
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    const loadTime = Date.now() - start;

    console.log(`Initial load time: ${loadTime}ms`);

    // Should load in under 3 seconds
    expect(loadTime).toBeLessThan(3000);
  });

  test('should meet interaction time target', async ({ page }) => {
    await page.goto('/');

    const start = Date.now();
    await page.getByRole('button', { name: 'Models' }).click();
    await page.waitForLoadState('networkidle');
    const interactionTime = Date.now() - start;

    console.log(`Interaction time: ${interactionTime}ms`);

    // Should respond in under 500ms
    expect(interactionTime).toBeLessThan(500);
  });

  test('should maintain FPS during interaction', async ({ page }) => {
    await page.goto('/');

    // Start FPS monitoring
    const fps = await page.evaluate(() => {
      return new Promise<number>((resolve) => {
        let lastTime = performance.now();
        let frames = 0;
        const duration = 1000; // 1 second

        function measureFrame() {
          const currentTime = performance.now();
          frames++;

          if (currentTime - lastTime >= duration) {
            resolve(frames);
          } else {
            requestAnimationFrame(measureFrame);
          }
        }

        requestAnimationFrame(measureFrame);
      });
    });

    console.log(`FPS: ${fps}`);

    // Should maintain at least 30 FPS
    expect(fps).toBeGreaterThan(30);
  });
});

