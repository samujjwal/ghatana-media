/**
 * EffectControls Component Tests
 *
 * Tests audio effects processing functionality using reusable test utilities.
 * Follows "reuse first, no duplicate" principle.
 */

import React from 'react';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { EffectControls } from '../EffectControls';
import {
  createTauriInvokeMock,
  createTauriDialogMocks,
  cleanupMocks,
  cleanupAllMocks,
  mockAlert,
  clickButton,
  screen,
  waitFor,
  fireEvent,
} from '../../../test-utils';

// Reuse shared mock setup
const mockInvoke = createTauriInvokeMock();
const { mockOpen, mockSave } = createTauriDialogMocks();

describe('EffectControls', () => {
  beforeEach(() => {
    mockInvoke.mockClear();
    mockOpen.mockClear();
    mockSave.mockClear();
  });

  afterEach(() => {
    cleanupAllMocks();
  });

  describe('Initial Render', () => {
    it('should display header and effects list', () => {
      render(<EffectControls />);

      expect(screen.getByText('Audio Effects')).toBeInTheDocument();
      expect(screen.getByText(/apply professional audio effects/i)).toBeInTheDocument();
    });

    it('should show all 5 effect categories', () => {
      render(<EffectControls />);

      expect(screen.getByText('Reverb')).toBeInTheDocument();
      expect(screen.getByText('Delay')).toBeInTheDocument();
      expect(screen.getByText(/5-band parametric eq/i)).toBeInTheDocument();
      expect(screen.getByText('Compressor')).toBeInTheDocument();
      expect(screen.getByText('Limiter')).toBeInTheDocument();
    });

    it('should have all effects disabled by default', () => {
      render(<EffectControls />);

      // Check that effect controls are not visible (effects are off)
      expect(screen.queryByText(/room size/i)).not.toBeInTheDocument();
      expect(screen.queryByText(/feedback/i)).not.toBeInTheDocument();
    });

    it('should have process button disabled initially', () => {
      render(<EffectControls />);

      const processButton = screen.getByRole('button', { name: /apply effects/i });
      expect(processButton).toBeDisabled();
    });
  });

  describe('File Selection', () => {
    it('should handle audio file selection', async () => {
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      render(<EffectControls />);

      await clickButton(/browse/i);

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

    it('should enable process button after file selection', async () => {
      mockOpen.mockResolvedValue('/path/to/audio.wav');

      render(<EffectControls />);

      await clickButton(/browse/i);

      const processButton = screen.getByRole('button', { name: /apply effects/i });
      await waitFor(() => {
        expect(processButton).not.toBeDisabled();
      });
    });
  });

  describe('Effect Toggles', () => {
    it('should toggle reverb on and show controls', async () => {
      render(<EffectControls />);

      // Find reverb toggle (checkbox inside label)
      const reverbSection = screen.getByText('Reverb').closest('div');
      const toggle = reverbSection?.querySelector('input[type="checkbox"]');

      expect(toggle).toBeTruthy();
      fireEvent.click(toggle!);

      // Controls should now be visible
      await waitFor(() => {
        expect(screen.getByText(/room size/i)).toBeInTheDocument();
        expect(screen.getByText(/damping/i)).toBeInTheDocument();
        expect(screen.getByText(/wet/i)).toBeInTheDocument();
      });
    });

    it('should toggle delay on and show controls', async () => {
      render(<EffectControls />);

      const delaySection = screen.getByText('Delay').closest('div');
      const toggle = delaySection?.querySelector('input[type="checkbox"]');

      fireEvent.click(toggle!);

      await waitFor(() => {
        expect(screen.getByText(/time/i)).toBeInTheDocument();
        expect(screen.getByText(/feedback/i)).toBeInTheDocument();
        expect(screen.getByText(/mix/i)).toBeInTheDocument();
      });
    });

    it('should toggle EQ on and show 5 bands', async () => {
      render(<EffectControls />);

      const eqSection = screen.getByText(/5-band parametric eq/i).closest('div');
      const toggle = eqSection?.querySelector('input[type="checkbox"]');

      fireEvent.click(toggle!);

      await waitFor(() => {
        expect(screen.getByText(/band 1/i)).toBeInTheDocument();
        expect(screen.getByText(/band 2/i)).toBeInTheDocument();
        expect(screen.getByText(/band 3/i)).toBeInTheDocument();
        expect(screen.getByText(/band 4/i)).toBeInTheDocument();
        expect(screen.getByText(/band 5/i)).toBeInTheDocument();
      });
    });

    it('should toggle compressor on and show controls', async () => {
      render(<EffectControls />);

      const compressorSection = screen.getByText('Compressor').closest('div');
      const toggle = compressorSection?.querySelector('input[type="checkbox"]');

      fireEvent.click(toggle!);

      await waitFor(() => {
        expect(screen.getByText(/threshold/i)).toBeInTheDocument();
        expect(screen.getByText(/ratio/i)).toBeInTheDocument();
        expect(screen.getByText(/makeup gain/i)).toBeInTheDocument();
      });
    });

    it('should toggle limiter on and show controls', async () => {
      render(<EffectControls />);

      const limiterSection = screen.getByText('Limiter').closest('div');
      const toggle = limiterSection?.querySelector('input[type="checkbox"]');

      fireEvent.click(toggle!);

      await waitFor(() => {
        expect(screen.getByText(/threshold/i)).toBeInTheDocument();
        expect(screen.getByText(/ceiling/i)).toBeInTheDocument();
      });
    });
  });

  describe('Parameter Updates', () => {
    it('should update reverb parameters', async () => {
      render(<EffectControls />);

      // Enable reverb
      const reverbSection = screen.getByText('Reverb').closest('div');
      const toggle = reverbSection?.querySelector('input[type="checkbox"]');
      fireEvent.click(toggle!);

      await waitFor(() => {
        const roomSizeSlider = screen.getByText(/room size/i).parentElement?.querySelector('input[type="range"]');
        expect(roomSizeSlider).toBeTruthy();

        // Change value
        fireEvent.change(roomSizeSlider!, { target: { value: '0.8' } });

        // Value should update
        expect(screen.getByText(/0\.80/)).toBeInTheDocument();
      });
    });

    it('should update delay parameters', async () => {
      render(<EffectControls />);

      const delaySection = screen.getByText('Delay').closest('div');
      const toggle = delaySection?.querySelector('input[type="checkbox"]');
      fireEvent.click(toggle!);

      await waitFor(() => {
        const timeSlider = screen.getByText(/time:/i).parentElement?.querySelector('input[type="range"]');
        fireEvent.change(timeSlider!, { target: { value: '1.5' } });

        expect(screen.getByText(/1\.50s/)).toBeInTheDocument();
      });
    });

    it('should update EQ band parameters', async () => {
      render(<EffectControls />);

      const eqSection = screen.getByText(/5-band parametric eq/i).closest('div');
      const toggle = eqSection?.querySelector('input[type="checkbox"]');
      fireEvent.click(toggle!);

      await waitFor(() => {
        // Find first band's gain slider
        const gainSliders = screen.getAllByText(/gain:/i);
        const firstGainSlider = gainSliders[0].parentElement?.querySelector('input[type="range"]');

        fireEvent.change(firstGainSlider!, { target: { value: '6' } });

        expect(screen.getByText(/6\.0 dB/)).toBeInTheDocument();
      });
    });
  });

  describe('Effect Processing', () => {
    it('should process audio with effects', async () => {
      mockOpen.mockResolvedValue('/path/to/input.wav');
      mockSave.mockResolvedValue('/path/to/output.wav');
      mockInvoke.mockResolvedValue('/path/to/output.wav');

      const alertSpy = mockAlert();

      render(<EffectControls />);

      // Select input file
      await clickButton(/browse/i);

      // Enable an effect
      const reverbSection = screen.getByText('Reverb').closest('div');
      const toggle = reverbSection?.querySelector('input[type="checkbox"]');
      fireEvent.click(toggle!);

      // Process
      await clickButton(/apply effects/i);

      await waitFor(() => {
        expect(mockSave).toHaveBeenCalled();
        expect(mockInvoke).toHaveBeenCalledWith('process_audio_effects', expect.any(Object));
        expect(alertSpy).toHaveBeenCalledWith('Effects applied successfully!');
      });

      cleanupMocks(alertSpy);
    });

    it('should show processing state', async () => {
      mockOpen.mockResolvedValue('/path/to/input.wav');
      mockSave.mockResolvedValue('/path/to/output.wav');
      let resolveProcess: ((value: string) => void) | undefined;
      mockInvoke.mockImplementation(() =>
        new Promise(resolve => {
          resolveProcess = resolve;
        })
      );

      render(<EffectControls />);

      await clickButton(/browse/i);
      await clickButton(/apply effects/i);

      await waitFor(() => {
        expect(screen.getByText(/processing/i)).toBeInTheDocument();
      });

      resolveProcess?.('/path/to/output.wav');

      await waitFor(() => {
        expect(screen.queryByText(/processing/i)).not.toBeInTheDocument();
      }, { timeout: 3000 });
    });

    it('should include enabled effects in config', async () => {
      mockOpen.mockResolvedValue('/path/to/input.wav');
      mockSave.mockResolvedValue('/path/to/output.wav');
      mockInvoke.mockResolvedValue('/path/to/output.wav');

      render(<EffectControls />);

      await clickButton(/browse/i);

      // Enable reverb and delay
      const reverbToggle = screen.getByText('Reverb').closest('div')?.querySelector('input[type="checkbox"]');
      const delayToggle = screen.getByText('Delay').closest('div')?.querySelector('input[type="checkbox"]');

      fireEvent.click(reverbToggle!);
      fireEvent.click(delayToggle!);

      await clickButton(/apply effects/i);

      await waitFor(() => {
        expect(mockInvoke).toHaveBeenCalledWith('process_audio_effects',
          expect.objectContaining({
            effectsConfiguration: expect.objectContaining({
              reverb: expect.any(Object),
              delay: expect.any(Object),
            })
          })
        );
      });
    });

    it('should not include disabled effects', async () => {
      mockOpen.mockResolvedValue('/path/to/input.wav');
      mockSave.mockResolvedValue('/path/to/output.wav');
      mockInvoke.mockResolvedValue('/path/to/output.wav');

      render(<EffectControls />);

      await clickButton(/browse/i);

      // Enable only reverb
      const reverbToggle = screen.getByText('Reverb').closest('div')?.querySelector('input[type="checkbox"]');
      fireEvent.click(reverbToggle!);

      await clickButton(/apply effects/i);

      await waitFor(() => {
        const callArgs = mockInvoke.mock.calls[0][1];
        expect(callArgs.effectsConfiguration.reverb).toBeDefined();
        expect(callArgs.effectsConfiguration.delay).toBeUndefined();
      });
    });
  });

  describe('Error Handling', () => {
    it('should handle processing errors', async () => {
      mockOpen.mockResolvedValue('/path/to/input.wav');
      mockSave.mockResolvedValue('/path/to/output.wav');
      mockInvoke.mockRejectedValue(new Error('Processing failed'));

      const alertSpy = mockAlert();

      render(<EffectControls />);

      await clickButton(/browse/i);
      await clickButton(/apply effects/i);

      await waitFor(() => {
        expect(alertSpy).toHaveBeenCalledWith('Failed to apply effects');
      });

      cleanupMocks(alertSpy);
    });

    it('should handle cancelled output selection', async () => {
      mockOpen.mockResolvedValue('/path/to/input.wav');
      mockSave.mockResolvedValue(null);

      render(<EffectControls />);

      await clickButton(/browse/i);
      await clickButton(/apply effects/i);

      // Should not call process
      expect(mockInvoke).not.toHaveBeenCalledWith('process_audio_effects', expect.any(Object));
    });

    it('should require audio file before processing', () => {
      render(<EffectControls />);

      const processButton = screen.getByRole('button', { name: /apply effects/i });
      expect(processButton).toBeDisabled();
    });
  });

  describe('Accessibility', () => {
    it('should have proper ARIA labels', () => {
      render(<EffectControls />);

      expect(screen.getByRole('heading', { level: 2 })).toHaveAccessibleName();
      expect(screen.getByRole('button', { name: /apply effects/i })).toBeInTheDocument();
    });

    it('should have accessible toggle switches', () => {
      render(<EffectControls />);

      const toggles = screen.getAllByRole('checkbox');
      expect(toggles.length).toBe(5); // 5 effects

      toggles.forEach(toggle => {
        expect(toggle).toHaveProperty('type', 'checkbox');
      });
    });

    it('should be keyboard navigable', () => {
      render(<EffectControls />);

      const interactiveElements = [
        ...screen.getAllByRole('checkbox'),
        ...screen.getAllByRole('button'),
      ];

      interactiveElements.forEach(element => {
        expect(element).toHaveProperty('tabIndex');
      });
    });
  });

  describe('Effect Presets', () => {
    it('should maintain parameter values when toggling', async () => {
      render(<EffectControls />);

      // Enable reverb
      const reverbToggle = screen.getByText('Reverb').closest('div')?.querySelector('input[type="checkbox"]');
      fireEvent.click(reverbToggle!);

      // Change room size
      await waitFor(() => {
        const roomSizeSlider = screen.getByText(/room size/i).parentElement?.querySelector('input[type="range"]');
        fireEvent.change(roomSizeSlider!, { target: { value: '0.9' } });
      });

      // Toggle off
      fireEvent.click(reverbToggle!);

      // Toggle back on
      fireEvent.click(reverbToggle!);

      // Value should be preserved
      await waitFor(() => {
        expect(screen.getByText(/0\.90/)).toBeInTheDocument();
      });
    });
  });
});
