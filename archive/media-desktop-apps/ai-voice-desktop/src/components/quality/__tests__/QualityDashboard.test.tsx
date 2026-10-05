/**
 * QualityDashboard Component Tests
 *
 * Tests audio quality assessment functionality using reusable test utilities.
 * Follows "reuse first, no duplicate" principle.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { QualityDashboard } from '../QualityDashboard';
import {
  createTauriInvokeMock,
  createTauriDialogMocks,
  setupQualityDashboardMocks,
  createMockQualityMetrics,
  waitForLoadingToComplete,
  clickButton,
  typeIntoInput,
  waitForText,
  mockAlert,
  cleanupMocks,
  cleanupAllMocks,
  screen,
  waitFor,
  fireEvent,
} from '../../../test-utils';

// Reuse shared mock setup
const mockInvoke = createTauriInvokeMock();
const { mockOpen } = createTauriDialogMocks();

describe('QualityDashboard', () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    mockOpen.mockClear();
  });

  afterEach(() => {
    cleanupAllMocks();
  });

  describe('Initial Render', () => {
    it('should display header and form', () => {
      render(<QualityDashboard />);

      expect(screen.getByText('Quality Assessment')).toBeInTheDocument();
      expect(screen.getByText(/analyze audio quality/i)).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /browse audio file/i })).toBeInTheDocument();
    });

    it('should have disabled assess button initially', () => {
      render(<QualityDashboard />);

      const assessButton = screen.getByRole('button', { name: /assess quality/i });
      expect(assessButton).toBeDisabled();
    });

    it('should display input fields', () => {
      render(<QualityDashboard />);

      expect(screen.getByPlaceholderText(/select audio file/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/enter the expected transcript/i)).toBeInTheDocument();
      expect(screen.getByPlaceholderText(/select reference audio/i)).toBeInTheDocument();
    });
  });

  describe('File Selection', () => {
    it('should handle audio file selection', async () => {
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      render(<QualityDashboard />);

      await clickButton(/browse audio file/i);

      await waitFor(() => {
        expect(mockOpen).toHaveBeenCalledWith(expect.objectContaining({
          filters: expect.arrayContaining([
            expect.objectContaining({
              name: 'Audio',
              extensions: expect.arrayContaining(['wav', 'mp3', 'flac', 'm4a'])
            })
          ])
        }));
      });
    });

    it('should enable assess button after file selection', async () => {
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      render(<QualityDashboard />);

      // Initially disabled
      const assessButton = screen.getByRole('button', { name: /assess quality/i });
      expect(assessButton).toBeDisabled();

      // Select file
      await clickButton(/browse audio file/i);

      // Should be enabled
      await waitFor(() => {
        expect(assessButton).not.toBeDisabled();
      });
    });

    it('should handle reference audio selection', async () => {
      mockOpen.mockResolvedValue('/path/to/reference.wav');

      render(<QualityDashboard />);

      fireEvent.click(screen.getByRole('button', { name: /browse reference audio/i }));

      await waitFor(() => {
        expect(mockOpen).toHaveBeenCalled();
      });
    });

    it('should handle cancelled file selection', async () => {
      mockOpen.mockResolvedValue(null);

      render(<QualityDashboard />);

      await clickButton(/browse audio file/i);

      const assessButton = screen.getByRole('button', { name: /assess quality/i });
      expect(assessButton).toBeDisabled();
    });
  });

  describe('Quality Assessment', () => {
    it('should perform quality assessment', async () => {
      const mockMetrics = createMockQualityMetrics();
      setupQualityDashboardMocks(mockInvoke, mockMetrics);
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      render(<QualityDashboard />);

      // Select file
      await clickButton(/browse audio file/i);

      // Click assess
      await waitFor(() => {
        expect(screen.getByRole('button', { name: /assess quality/i })).not.toBeDisabled();
      });

      await clickButton(/assess quality/i);

      // Verify assessment was called
      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('analyze_audio_quality', expect.any(Object));
      });
    });

    it('should show loading state during assessment', async () => {
      setupQualityDashboardMocks(mockInvoke);
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      mockInvoke.mockImplementation(() =>
        new Promise(resolve => setTimeout(() => resolve(createMockQualityMetrics()), 100))
      );

      render(<QualityDashboard />);

      await clickButton(/browse audio file/i);
      await clickButton(/assess quality/i);

      // Should show loading
      expect(screen.getByText(/assessing/i)).toBeInTheDocument();

      // Wait for completion
      await waitFor(() => {
        expect(screen.queryByText(/assessing/i)).not.toBeInTheDocument();
      }, { timeout: 3000 });
    });

    it('should display metrics after assessment', async () => {
      const mockMetrics = createMockQualityMetrics({
        mean_opinion_score: 4.5,
        signal_to_noise_ratio_db: 30.0,
      });
      setupQualityDashboardMocks(mockInvoke, mockMetrics);
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      render(<QualityDashboard />);

      await clickButton(/browse audio file/i);
      await clickButton(/assess quality/i);

      // Wait for metrics to display
      await waitFor(() => {
        expect(screen.getByText('4.50')).toBeInTheDocument(); // MOS score
        expect(screen.getByText('30.0')).toBeInTheDocument(); // SNR
      });
    });

    it('should display MOS label correctly', async () => {
      const mockMetrics = createMockQualityMetrics({
        mean_opinion_score: 4.5,
      });
      setupQualityDashboardMocks(mockInvoke, mockMetrics);
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      render(<QualityDashboard />);

      await clickButton(/browse audio file/i);
      await clickButton(/assess quality/i);

      await waitFor(() => {
        expect(screen.getByText('Excellent')).toBeInTheDocument();
      });
    });

    it('should include reference text if provided', async () => {
      setupQualityDashboardMocks(mockInvoke);
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      render(<QualityDashboard />);

      await clickButton(/browse audio file/i);

      // Type reference text
      const textArea = screen.getByPlaceholderText(/enter the expected transcript/i);
      fireEvent.change(textArea, { target: { value: 'Test transcript' } });

      await clickButton(/assess quality/i);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('analyze_audio_quality',
          expect.objectContaining({
            referenceTranscript: 'Test transcript',
          })
        );
      });
    });
  });

  describe('Optional Metrics', () => {
    it('should display WER when available', async () => {
      const mockMetrics = createMockQualityMetrics({
        word_error_rate: 0.05,
      });
      setupQualityDashboardMocks(mockInvoke, mockMetrics);
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      render(<QualityDashboard />);

      await clickButton(/browse audio file/i);
      await clickButton(/assess quality/i);

      await waitFor(() => {
        expect(screen.getByText(/word error rate/i)).toBeInTheDocument();
        expect(screen.getByText('5.0')).toBeInTheDocument(); // 0.05 * 100
      });
    });

    it('should display speaker similarity when available', async () => {
      const mockMetrics = createMockQualityMetrics({
        speaker_similarity_score: 0.85,
      });
      setupQualityDashboardMocks(mockInvoke, mockMetrics);
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      render(<QualityDashboard />);

      await clickButton(/browse audio file/i);
      await clickButton(/assess quality/i);

      await waitFor(() => {
        expect(screen.getAllByText(/speaker similarity/i).length).toBeGreaterThan(0);
        expect(screen.getByText('85')).toBeInTheDocument(); // 0.85 * 100
      });
    });

    it('should not display WER if not available', async () => {
      const mockMetrics = createMockQualityMetrics({
        word_error_rate: null,
      });
      setupQualityDashboardMocks(mockInvoke, mockMetrics);
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      render(<QualityDashboard />);

      await clickButton(/browse audio file/i);
      await clickButton(/assess quality/i);

      await waitFor(() => {
        expect(screen.getByText('4.20')).toBeInTheDocument(); // MOS displayed
      });

      expect(screen.queryByText(/word error rate/i)).not.toBeInTheDocument();
    });
  });

  describe('Overall Assessment', () => {
    it('should show excellent assessment for high MOS', async () => {
      const mockMetrics = createMockQualityMetrics({
        mean_opinion_score: 4.5,
      });
      setupQualityDashboardMocks(mockInvoke, mockMetrics);
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      render(<QualityDashboard />);

      await clickButton(/browse audio file/i);
      await clickButton(/assess quality/i);

      await waitFor(() => {
        expect(screen.getByText(/excellent audio quality/i)).toBeInTheDocument();
        expect(screen.getByText(/ready for production/i)).toBeInTheDocument();
      });
    });

    it('should show good assessment for medium MOS', async () => {
      const mockMetrics = createMockQualityMetrics({
        mean_opinion_score: 3.5,
      });
      setupQualityDashboardMocks(mockInvoke, mockMetrics);
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      render(<QualityDashboard />);

      await clickButton(/browse audio file/i);
      await clickButton(/assess quality/i);

      await waitFor(() => {
        expect(screen.getByText(/good audio quality/i)).toBeInTheDocument();
      });
    });

    it('should show poor assessment for low MOS', async () => {
      const mockMetrics = createMockQualityMetrics({
        mean_opinion_score: 2.5,
      });
      setupQualityDashboardMocks(mockInvoke, mockMetrics);
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      render(<QualityDashboard />);

      await clickButton(/browse audio file/i);
      await clickButton(/assess quality/i);

      await waitFor(() => {
        expect(screen.getByText(/could be improved/i)).toBeInTheDocument();
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle assessment errors gracefully', async () => {
      const alertSpy = mockAlert();
      mockOpen.mockResolvedValue('/path/to/audio.wav');
      mockInvoke.mockRejectedValue(new Error('Assessment failed'));

      render(<QualityDashboard />);

      await clickButton(/browse audio file/i);
      await clickButton(/assess quality/i);

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith('Failed to assess quality');
      });

      cleanupMocks(alertSpy);
    });

    it('should handle missing audio file', async () => {
      const alertSpy = mockAlert();

      render(<QualityDashboard />);

      // Try to assess without selecting file (button should be disabled)
      const assessButton = screen.getByRole('button', { name: /assess quality/i });
      expect(assessButton).toBeDisabled();

      cleanupMocks(alertSpy);
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels', () => {
      render(<QualityDashboard />);

      expect(screen.getByRole('heading', { level: 2 })).toHaveAccessibleName();
      expect(screen.getByRole('button', { name: /assess quality/i })).toBeInTheDocument();
    });

    it('should be keyboard navigable', () => {
      render(<QualityDashboard />);

      const buttons = screen.getAllByRole('button');
      buttons.forEach(button => {
        expect(button).toHaveProperty('tabIndex');
      });
    });
  });
});
