import React from 'react';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import AIVoicePanel from '../AIVoicePanel';
import MultimodalPanel from '../MultimodalPanel';
import VisionPanel from '../VisionPanel';

describe('mock service panels', () => {
  it('shows explicit unavailable state for AI Voice', () => {
    render(<AIVoicePanel />);

    expect(screen.getByText('Unavailable in this build')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'AI Voice Unavailable In This Build' })).toBeDisabled();
    expect(screen.queryByText(/^Enhanced:/)).toBeNull();
  });

  it('shows explicit unavailable state for Multimodal processing', () => {
    render(<MultimodalPanel />);

    expect(screen.getByText('Unavailable in this build')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Multimodal Processing Unavailable In This Build' })).toBeDisabled();
    expect(screen.queryByText(/processing completed successfully/i)).toBeNull();
  });

  it('shows explicit unavailable state for Vision analysis', () => {
    render(<VisionPanel />);

    expect(screen.getByText('Unavailable in this build')).toBeTruthy();
    expect(screen.queryByText('Detections')).toBeNull();
  });
});