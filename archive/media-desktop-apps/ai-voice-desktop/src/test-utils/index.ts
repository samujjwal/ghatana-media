/**
 * Test Utilities for AI Voice Desktop App
 *
 * Reusable test helpers and setup following the "reuse first" principle.
 * Adapted from existing test utilities in the codebase.
 *
 * @doc.type utility
 * @doc.purpose Testing utilities and helpers
 * @doc.layer product
 * @doc.pattern TestUtility
 */

import {
  render as testingLibraryRender,
  screen as testingLibraryScreen,
  waitFor as testingLibraryWaitFor,
  fireEvent as testingLibraryFireEvent,
} from '@testing-library/react';
import { vi } from 'vitest';
import type { RenderOptions, RenderResult } from '@testing-library/react';
import type { ReactElement } from 'react';

const render = testingLibraryRender;
const screen = testingLibraryScreen;
const waitFor = testingLibraryWaitFor;
const fireEvent = testingLibraryFireEvent;

type TauriTestMocks = {
  invoke: ReturnType<typeof vi.fn>;
  open: ReturnType<typeof vi.fn>;
  save: ReturnType<typeof vi.fn>;
};

const tauriMocks =
  (globalThis as typeof globalThis & { __aiVoiceTauriMocks?: TauriTestMocks })
    .__aiVoiceTauriMocks ??
  {
    invoke: vi.fn(),
    open: vi.fn(),
    save: vi.fn(),
  };

// ============================================================================
// Tauri Mock Utilities
// ============================================================================

/**
 * Creates a mock for Tauri's invoke function
 * Reusable across all component tests
 */
export function createTauriInvokeMock() {
  tauriMocks.invoke.mockReset();
  return tauriMocks.invoke;
}

/**
 * Creates a mock for Tauri's dialog functions
 * Reusable for file selection tests
 */
export function createTauriDialogMocks() {
  tauriMocks.open.mockReset();
  tauriMocks.save.mockReset();
  return { mockOpen: tauriMocks.open, mockSave: tauriMocks.save };
}

// ============================================================================
// Mock Data Builders (Reusable Test Data)
// ============================================================================

/**
 * Creates mock project data
 * Follows builder pattern for reusability
 */
export function createMockProject(overrides?: Partial<{
  id: string;
  name: string;
  created: string;
  modified: string;
  track_count: number;
}>) {
  return {
    id: 'test-project-1',
    name: 'Test Project',
    created: new Date().toISOString(),
    modified: new Date().toISOString(),
    track_count: 3,
    ...overrides,
  };
}

/**
 * Creates mock audio quality metrics
 */
export function createMockQualityMetrics(overrides?: Partial<{
  mean_opinion_score: number;
  word_error_rate: number | null;
  speaker_similarity_score: number | null;
  signal_to_noise_ratio_db: number;
}>) {
  return {
    mean_opinion_score: 4.2,
    word_error_rate: 0.05,
    speaker_similarity_score: 0.85,
    signal_to_noise_ratio_db: 25.5,
    perceptual_evaluation_score: null,
    short_time_intelligibility: null,
    ...overrides,
  };
}

/**
 * Creates mock model list
 */
export function createMockModelList() {
  return [
    'demucs-htdemucs',
    'demucs-htdemucs_ft',
    'whisper-base',
    'vits-base',
    'rvc-base',
    'mosnet',
    'ecapa-tdnn',
  ];
}

// ============================================================================
// Test Helpers (Reusable Actions)
// ============================================================================

/**
 * Waits for loading to complete
 * Reusable across all async tests
 */
export async function waitForLoadingToComplete() {
  await waitFor(() => {
    expect(screen.queryByRole('status')).not.toBeInTheDocument();
  }, { timeout: 3000 });
}

/**
 * Finds and clicks a button by text
 * Reusable user interaction helper
 */
export async function clickButton(buttonText: string | RegExp) {
  const button = await screen.findByRole('button', { name: buttonText });
  await waitFor(() => {
    expect(button).not.toBeDisabled();
  });
  fireEvent.click(button);
  return button;
}

/**
 * Types into an input field
 * Reusable input helper
 */
export async function typeIntoInput(placeholderText: string | RegExp, value: string) {
  const input = await screen.findByPlaceholderText(placeholderText);
  fireEvent.change(input, { target: { value } });
  return input;
}

/**
 * Waits for text to appear
 * Reusable assertion helper
 */
export async function waitForText(text: string | RegExp) {
  return await screen.findByText(text);
}

// ============================================================================
// Mock Setup Helpers (Reusable Configurations)
// ============================================================================

/**
 * Sets up standard invoke mock responses
 * Reusable for model manager tests
 */
export function setupModelManagerMocks(mockInvoke: any, options?: {
  availableModels?: string[];
  downloadedModels?: string[];
  cacheSize?: number;
}) {
  const availableModels = options?.availableModels || createMockModelList();
  const downloadedModels = options?.downloadedModels || [];
  const cacheSize = options?.cacheSize || 0;

  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case 'list_available_models':
        return Promise.resolve(availableModels);
      case 'list_downloaded_models':
        return Promise.resolve(downloadedModels);
      case 'get_model_cache_size':
        return Promise.resolve(cacheSize);
      default:
        return Promise.resolve();
    }
  });
}

/**
 * Sets up standard invoke mock responses for project manager
 * Reusable for project tests
 */
export function setupProjectManagerMocks(mockInvoke: any, options?: {
  projects?: any[];
  storageDir?: string;
}) {
  const projects = options?.projects || [];
  const storageDir = options?.storageDir || '/test/storage';

  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case 'get_project_storage_directory':
        return Promise.resolve(storageDir);
      case 'list_audio_projects':
        return Promise.resolve(projects);
      case 'save_audio_project':
        return Promise.resolve('/test/path');
      case 'delete_audio_project':
        return Promise.resolve();
      case 'export_audio_project':
        return Promise.resolve('/test/export.wav');
      default:
        return Promise.resolve();
    }
  });
}

/**
 * Sets up standard invoke mock responses for quality dashboard
 * Reusable for quality tests
 */
export function setupQualityDashboardMocks(mockInvoke: any, metrics?: any) {
  const defaultMetrics = createMockQualityMetrics();

  mockInvoke.mockImplementation((cmd: string) => {
    switch (cmd) {
      case 'analyze_audio_quality':
        return Promise.resolve(metrics || defaultMetrics);
      default:
        return Promise.resolve();
    }
  });
}

// ============================================================================
// Assertion Helpers (Reusable Verifications)
// ============================================================================

/**
 * Verifies loading state
 */
export function expectLoadingState() {
  expect(screen.getByRole('status')).toBeInTheDocument();
}

/**
 * Verifies no loading state
 */
export function expectNoLoadingState() {
  expect(screen.queryByRole('status')).not.toBeInTheDocument();
}

/**
 * Verifies error message
 */
export async function expectErrorMessage(message: string | RegExp) {
  const error = await screen.findByText(message);
  expect(error).toBeInTheDocument();
}

/**
 * Verifies button is disabled
 */
export function expectButtonDisabled(buttonText: string | RegExp) {
  const button = screen.getByRole('button', { name: buttonText });
  expect(button).toBeDisabled();
}

/**
 * Verifies button is enabled
 */
export function expectButtonEnabled(buttonText: string | RegExp) {
  const button = screen.getByRole('button', { name: buttonText });
  expect(button).not.toBeDisabled();
}

// ============================================================================
// Spy Helpers (Reusable Spies)
// ============================================================================

/**
 * Creates window.confirm spy with return value
 */
export function mockConfirm(returnValue: boolean = true) {
  return vi.spyOn(window, 'confirm').mockReturnValue(returnValue);
}

/**
 * Creates window.alert spy
 */
export function mockAlert() {
  return vi.spyOn(window, 'alert').mockImplementation(() => {});
}

/**
 * Creates window.prompt spy with return value
 */
export function mockPrompt(returnValue: string | null) {
  return vi.spyOn(window, 'prompt').mockReturnValue(returnValue);
}

/**
 * Creates console.error spy (useful for error testing)
 */
export function mockConsoleError() {
  return vi.spyOn(console, 'error').mockImplementation(() => {});
}

// ============================================================================
// Cleanup Helpers (Reusable Teardown)
// ============================================================================

/**
 * Standard cleanup for mocks
 * Reusable in afterEach blocks
 */
export function cleanupMocks(...mocks: any[]) {
  mocks.forEach(mock => {
    if (mock && typeof mock.mockClear === 'function') {
      mock.mockClear();
    }
    if (mock && typeof mock.mockRestore === 'function') {
      mock.mockRestore();
    }
  });
}

/**
 * Standard cleanup for all vi mocks
 */
export function cleanupAllMocks() {
  vi.clearAllMocks();
}

// ============================================================================
// Export all utilities
// ============================================================================

export { render, screen, waitFor, fireEvent };

// Re-export types for convenience
export type { RenderOptions, RenderResult };
