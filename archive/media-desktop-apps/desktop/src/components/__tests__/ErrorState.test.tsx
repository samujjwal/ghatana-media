/**
 * Tests for ErrorState component (AV-011.3).
 */

import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import ErrorState from '../ErrorState';
import { resolveError, ErrorCodes } from '../../errors/errorTaxonomy';

describe('ErrorState', () => {
  const grpcError = resolveError(ErrorCodes.GRPC_UNAVAILABLE);

  it('renders the error message', () => {
    render(<ErrorState error={grpcError} />);
    expect(screen.getByText(grpcError.message)).toBeTruthy();
  });

  it('renders the error code', () => {
    render(<ErrorState error={grpcError} />);
    expect(screen.getByText(`Error code: ${grpcError.code}`)).toBeTruthy();
  });

  it('renders all recovery suggestions', () => {
    render(<ErrorState error={grpcError} />);
    grpcError.suggestions.forEach((s) => {
      expect(screen.getByText(s)).toBeTruthy();
    });
  });

  it('shows "Try again" button when onRetry is provided and error is recoverable', () => {
    const onRetry = vi.fn();
    render(<ErrorState error={grpcError} onRetry={onRetry} />);
    const retryBtn = screen.getByRole('button', { name: /retry the failed operation/i });
    expect(retryBtn).toBeTruthy();
    fireEvent.click(retryBtn);
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('does not show "Try again" when error is not recoverable', () => {
    const modelLoadFail = resolveError(ErrorCodes.MODEL_LOAD_FAILED);
    render(<ErrorState error={modelLoadFail} onRetry={vi.fn()} />);
    expect(screen.queryByRole('button', { name: /try again/i })).toBeNull();
  });

  it('shows documentation link when docsUrl is present', () => {
    render(<ErrorState error={grpcError} />);
    expect(screen.getByText(/View documentation/i)).toBeTruthy();
  });

  it('shows "Report this issue" button when onReport is provided', () => {
    const onReport = vi.fn();
    render(<ErrorState error={grpcError} onReport={onReport} />);
    const reportBtn = screen.getByRole('button', { name: /report/i });
    fireEvent.click(reportBtn);
    expect(onReport).toHaveBeenCalledWith(grpcError);
  });

  it('has role="alert" for accessibility', () => {
    render(<ErrorState error={grpcError} />);
    expect(screen.getByRole('alert')).toBeTruthy();
  });
});

