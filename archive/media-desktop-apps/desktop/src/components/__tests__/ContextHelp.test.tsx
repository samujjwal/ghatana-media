/**
 * Tests for ContextHelp component (AV-010.4).
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import ContextHelp, { HelpContent } from '../ContextHelp';

const helpContent: HelpContent = {
  summary: 'This is a helpful explanation.',
  tips: ['Use the right format', 'Check your input'],
  docsUrl: '/docs/feature',
};

describe('ContextHelp', () => {
  it('renders the help button', () => {
    render(<ContextHelp content={helpContent} />);
    expect(screen.getByRole('button', { name: 'Show help' })).toBeTruthy();
  });

  it('is closed by default (panel not shown)', () => {
    render(<ContextHelp content={helpContent} />);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('shows panel when button is clicked', () => {
    render(<ContextHelp content={helpContent} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show help' }));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText(helpContent.summary)).toBeTruthy();
  });

  it('shows all tips when panel is open', () => {
    render(<ContextHelp content={helpContent} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show help' }));
    helpContent.tips?.forEach((tip) => {
      expect(screen.getByText(tip)).toBeTruthy();
    });
  });

  it('shows documentation link when docsUrl is present', () => {
    render(<ContextHelp content={helpContent} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show help' }));
    const link = screen.getByRole('link', { name: /Full documentation/i });
    expect(link).toHaveAttribute('href', '/docs/feature');
  });

  it('closes panel when close button is clicked', () => {
    render(<ContextHelp content={helpContent} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show help' }));
    expect(screen.getByRole('dialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Close help' }));
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('uses custom ariaLabel for the trigger button', () => {
    render(<ContextHelp content={helpContent} ariaLabel="Help for STT settings" />);
    expect(screen.getByRole('button', { name: 'Help for STT settings' })).toBeTruthy();
  });

  it('does not show tips section when no tips are provided', () => {
    render(<ContextHelp content={{ summary: 'Simple help.' }} />);
    fireEvent.click(screen.getByRole('button', { name: 'Show help' }));
    expect(screen.queryByText('Tips')).toBeNull();
  });
});

