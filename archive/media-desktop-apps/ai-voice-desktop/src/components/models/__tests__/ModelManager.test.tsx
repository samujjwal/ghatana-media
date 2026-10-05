/**
 * ModelManager Component Tests
 *
 * Tests ML model management functionality:
 * - Model listing
 * - Model downloading
 * - Progress tracking
 * - Cache management
 * - Error handling
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { ModelManager } from '../ModelManager';
import {
  createTauriInvokeMock,
  setupModelManagerMocks,
  createMockModelList,
  waitForLoadingToComplete,
  clickButton,
  mockConfirm,
  mockAlert,
  cleanupMocks,
  cleanupAllMocks,
  screen,
  waitFor,
  fireEvent,
} from '../../../test-utils';

// Reuse shared mock setup
const mockInvoke = createTauriInvokeMock();

describe('ModelManager', () => {
  beforeEach(() => {
    mockInvoke.mockClear();
  });

  afterEach(() => {
    cleanupAllMocks();
  });

  describe('Initial Render', () => {
    it('should render loading state initially', () => {
      mockInvoke.mockImplementation(() => new Promise(() => {})); // Never resolves

      render(<ModelManager />);

      expect(screen.getByRole('status', { name: /loading/i })).toBeInTheDocument();
    });

    it('should display header with title and description', async () => {
      mockInvoke.mockResolvedValue([]);

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByText('Model Manager')).toBeInTheDocument();
        expect(screen.getByText(/download and manage ml models/i)).toBeInTheDocument();
      });
    });

    it('should display cache size', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_available_models') return Promise.resolve(['model-1', 'model-2']);
        if (cmd === 'list_downloaded_models') return Promise.resolve(['model-1']);
        if (cmd === 'get_model_cache_size') return Promise.resolve(2400.5);
        return Promise.resolve([]);
      });

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByText(/2400\.5 MB/i)).toBeInTheDocument();
      });
    });
  });

  describe('Model Listing', () => {
    it('should display available models', async () => {
      // Reuse standard model manager mock setup
      setupModelManagerMocks(mockInvoke, {
        availableModels: ['demucs-htdemucs', 'whisper-base', 'vits-base'],
      });

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByText(/htdemucs/i)).toBeInTheDocument();
        expect(screen.getByText(/whisper/i)).toBeInTheDocument();
        expect(screen.getByText(/vits/i)).toBeInTheDocument();
      });
    });

    it('should show downloaded status for downloaded models', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_available_models') return Promise.resolve(['model-demucs']);
        if (cmd === 'list_downloaded_models') return Promise.resolve(['model-demucs']);
        if (cmd === 'get_model_cache_size') return Promise.resolve(2400);
        return Promise.resolve([]);
      });

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByText('Downloaded')).toBeInTheDocument();
        expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
      });
    });

    it('should show download button for non-downloaded models', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_available_models') return Promise.resolve(['model-demucs']);
        if (cmd === 'list_downloaded_models') return Promise.resolve([]);
        if (cmd === 'get_model_cache_size') return Promise.resolve(0);
        return Promise.resolve([]);
      });

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument();
      });
    });
  });

  describe('Model Download', () => {
    it('should handle model download', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_available_models') return Promise.resolve(['model-test']);
        if (cmd === 'list_downloaded_models') return Promise.resolve([]);
        if (cmd === 'get_model_cache_size') return Promise.resolve(0);
        if (cmd === 'download_model') return Promise.resolve();
        return Promise.resolve([]);
      });

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('download_model', expect.any(Object));
      });
    });

    it('should show download progress', async () => {
      let resolveDownload: (() => void) | undefined;
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_available_models') return Promise.resolve(['model-test']);
        if (cmd === 'list_downloaded_models') return Promise.resolve([]);
        if (cmd === 'get_model_cache_size') return Promise.resolve(0);
        if (cmd === 'download_model') {
          return new Promise((resolve) => {
            resolveDownload = () => resolve(undefined);
          });
        }
        return Promise.resolve([]);
      });

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      await waitFor(() => {
        expect(screen.getAllByText(/downloading/i).length).toBeGreaterThan(0);
      });

      resolveDownload?.();
    });

    it('should disable download button while downloading', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_available_models') return Promise.resolve(['model-test']);
        if (cmd === 'list_downloaded_models') return Promise.resolve([]);
        if (cmd === 'get_model_cache_size') return Promise.resolve(0);
        if (cmd === 'download_model') {
          return new Promise((resolve) => setTimeout(resolve, 100));
        }
        return Promise.resolve([]);
      });

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument();
      });

      const downloadButton = screen.getByRole('button', { name: /download/i });
      fireEvent.click(downloadButton);

      await waitFor(() => {
        expect(downloadButton).toBeDisabled();
      });
    });

    it('should handle download errors', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_available_models') return Promise.resolve(['model-test']);
        if (cmd === 'list_downloaded_models') return Promise.resolve([]);
        if (cmd === 'get_model_cache_size') return Promise.resolve(0);
        if (cmd === 'download_model') return Promise.reject(new Error('Network error'));
        return Promise.resolve([]);
      });

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /download/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /download/i }));

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalledWith(
          expect.stringContaining('[ai-voice][ModelManager] DownloadModel:error'),
          expect.objectContaining({
            error: expect.objectContaining({ message: 'Network error' }),
            modelId: 'model-test',
          })
        );
      });

      consoleError.mockRestore();
    });
  });

  describe('Model Deletion', () => {
    it('should handle model deletion with confirmation', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_available_models') return Promise.resolve(['model-test']);
        if (cmd === 'list_downloaded_models') return Promise.resolve(['model-test']);
        if (cmd === 'get_model_cache_size') return Promise.resolve(100);
        if (cmd === 'delete_model') return Promise.resolve();
        return Promise.resolve([]);
      });

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /delete/i }));

      expect(confirmSpy).toHaveBeenCalled();

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('delete_model', expect.any(Object));
      });

      confirmSpy.mockRestore();
    });

    it('should not delete if user cancels confirmation', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_available_models') return Promise.resolve(['model-test']);
        if (cmd === 'list_downloaded_models') return Promise.resolve(['model-test']);
        if (cmd === 'get_model_cache_size') return Promise.resolve(100);
        return Promise.resolve([]);
      });

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /delete/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /delete/i }));

      expect(confirmSpy).toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalledWith('delete_model', expect.any(Object));

      confirmSpy.mockRestore();
    });
  });

  describe('Cache Management', () => {
    it('should handle cache clearing with confirmation', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_available_models') return Promise.resolve(['model-test']);
        if (cmd === 'list_downloaded_models') return Promise.resolve(['model-test']);
        if (cmd === 'get_model_cache_size') return Promise.resolve(2400);
        if (cmd === 'clear_model_cache') return Promise.resolve();
        return Promise.resolve([]);
      });

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /clear cache/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /clear cache/i }));

      expect(confirmSpy).toHaveBeenCalled();

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('clear_model_cache');
      });

      confirmSpy.mockRestore();
    });

    it('should not clear cache if user cancels', async () => {
      const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);

      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_available_models') return Promise.resolve(['model-test']);
        if (cmd === 'list_downloaded_models') return Promise.resolve(['model-test']);
        if (cmd === 'get_model_cache_size') return Promise.resolve(2400);
        return Promise.resolve([]);
      });

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByRole('button', { name: /clear cache/i })).toBeInTheDocument();
      });

      fireEvent.click(screen.getByRole('button', { name: /clear cache/i }));

      expect(confirmSpy).toHaveBeenCalled();
      expect(mockInvoke).not.toHaveBeenCalledWith('clear_model_cache');

      confirmSpy.mockRestore();
    });

    it('should update cache size after operations', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_available_models') return Promise.resolve(['model-test']);
        if (cmd === 'list_downloaded_models') return Promise.resolve([]);
        if (cmd === 'get_model_cache_size') return Promise.resolve(0);
        if (cmd === 'download_model') {
          // After download, cache size increases
          mockInvoke.mockImplementation((cmd: string) => {
            if (cmd === 'get_model_cache_size') return Promise.resolve(2400);
            return Promise.resolve([]);
          });
          return Promise.resolve();
        }
        return Promise.resolve([]);
      });

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByText(/Cache:\s*0\.0\s*MB/i)).toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle API errors gracefully', async () => {
      const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

      mockInvoke.mockRejectedValue(new Error('API Error'));

      render(<ModelManager />);

      await waitFor(() => {
        expect(consoleError).toHaveBeenCalled();
      });

      consoleError.mockRestore();
    });

    it('should show loading state on error and retry', async () => {
      mockInvoke
        .mockRejectedValueOnce(new Error('Network error'))
        .mockResolvedValue([]);

      const { rerender } = render(<ModelManager />);

      await waitFor(() => {
        expect(screen.queryByRole('status')).not.toBeInTheDocument();
      });

      rerender(<ModelManager key="retry" />);

      await waitFor(() => {
        expect(mockInvoke.mock.calls.length).toBeGreaterThanOrEqual(4);
      });
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_available_models') return Promise.resolve(['model-test']);
        if (cmd === 'list_downloaded_models') return Promise.resolve([]);
        if (cmd === 'get_model_cache_size') return Promise.resolve(0);
        return Promise.resolve([]);
      });

      render(<ModelManager />);

      await waitFor(() => {
        expect(screen.getByRole('heading', { level: 2 })).toHaveAccessibleName();
      });
    });

    it('should be keyboard navigable', async () => {
      mockInvoke.mockImplementation((cmd: string) => {
        if (cmd === 'list_available_models') return Promise.resolve(['model-test']);
        if (cmd === 'list_downloaded_models') return Promise.resolve([]);
        if (cmd === 'get_model_cache_size') return Promise.resolve(0);
        return Promise.resolve([]);
      });

      render(<ModelManager />);

      await waitFor(() => {
        const downloadButton = screen.getByRole('button', { name: /download/i });
        expect(downloadButton).toHaveFocus;
      });
    });
  });
});
