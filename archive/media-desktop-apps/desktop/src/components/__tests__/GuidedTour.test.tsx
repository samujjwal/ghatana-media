/**
 * Tests for GuidedTour component (AV-010.2).
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import GuidedTour, { TourStep } from '../GuidedTour';

const steps: TourStep[] = [
  { title: 'Welcome', description: 'Welcome to the app.' },
  { title: 'Step 2', description: 'This is step 2.', action: 'Click the STT button' },
  { title: 'Done', description: 'You are ready!' },
];

describe('GuidedTour', () => {
  it('renders nothing when isVisible is false', () => {
    const onComplete = vi.fn();
    render(<GuidedTour steps={steps} onComplete={onComplete} isVisible={false} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('renders the first step when isVisible is true', () => {
    render(<GuidedTour steps={steps} onComplete={vi.fn()} isVisible />);
    expect(screen.getByText('Welcome')).toBeTruthy();
    expect(screen.getByText('Step 1 of 3')).toBeTruthy();
  });

  it('advances to the next step on Next click', () => {
    render(<GuidedTour steps={steps} onComplete={vi.fn()} isVisible />);
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Step 2')).toBeTruthy();
    expect(screen.getByText('Step 2 of 3')).toBeTruthy();
  });

  it('shows Back button on steps after the first', () => {
    render(<GuidedTour steps={steps} onComplete={vi.fn()} isVisible />);
    expect(screen.queryByText('Back')).toBeNull();
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText('Back')).toBeTruthy();
  });

  it('calls onComplete when Finish is clicked on last step', () => {
    const onComplete = vi.fn();
    render(<GuidedTour steps={steps} onComplete={onComplete} isVisible />);
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Next'));
    fireEvent.click(screen.getByText('Finish'));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('calls onComplete when Skip tour is clicked', () => {
    const onComplete = vi.fn();
    render(<GuidedTour steps={steps} onComplete={onComplete} isVisible />);
    fireEvent.click(screen.getByText('Skip tour'));
    expect(onComplete).toHaveBeenCalledTimes(1);
  });

  it('displays action hint when provided', () => {
    render(<GuidedTour steps={steps} onComplete={vi.fn()} isVisible />);
    fireEvent.click(screen.getByText('Next'));
    expect(screen.getByText(/Click the STT button/)).toBeTruthy();
  });

  it('calls onStepChange with correct index and step on navigation', () => {
    const onStepChange = vi.fn();
    render(<GuidedTour steps={steps} onComplete={vi.fn()} isVisible onStepChange={onStepChange} />);
    fireEvent.click(screen.getByText('Next'));
    expect(onStepChange).toHaveBeenCalledWith(1, steps[1]);
  });
});

