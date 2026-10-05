/**
 * Tests for ProgressiveDisclosure component (AV-010.1).
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ProgressiveDisclosure from '../ProgressiveDisclosure';

describe('ProgressiveDisclosure', () => {
  it('renders the summary content', () => {
    render(
      <ProgressiveDisclosure summary={<span>Basic summary</span>}>
        <p>Advanced content</p>
      </ProgressiveDisclosure>,
    );
    expect(screen.getByText('Basic summary')).toBeTruthy();
  });

  it('hides content by default', () => {
    render(
      <ProgressiveDisclosure summary={<span>S</span>}>
        <p>Hidden content</p>
      </ProgressiveDisclosure>,
    );
    const region = screen.getByRole('region', { hidden: true });
    expect(region).toHaveAttribute('hidden');
  });

  it('shows content when expanded by default', () => {
    render(
      <ProgressiveDisclosure summary={<span>S</span>} defaultExpanded>
        <p>Visible content</p>
      </ProgressiveDisclosure>,
    );
    const region = screen.getByRole('region');
    expect(region).not.toHaveAttribute('hidden');
  });

  it('toggles content on button click', () => {
    render(
      <ProgressiveDisclosure summary={<span>S</span>}>
        <p>Content</p>
      </ProgressiveDisclosure>,
    );
    const button = screen.getByRole('button');
    expect(button).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'true');

    fireEvent.click(button);
    expect(button).toHaveAttribute('aria-expanded', 'false');
  });

  it('uses custom toggleLabel', () => {
    render(
      <ProgressiveDisclosure summary={<span>S</span>} toggleLabel="Show more details">
        <p>C</p>
      </ProgressiveDisclosure>,
    );
    expect(screen.getByText('Show more details')).toBeTruthy();
  });
});

