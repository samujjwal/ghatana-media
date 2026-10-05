/**
 * Tests for errorTaxonomy and errorReporting (AV-011.1, AV-011.4).
 */

import { describe, expect, it, vi } from 'vitest';
import {
  ErrorCatalogue,
  ErrorCodes,
  resolveError,
} from '../errorTaxonomy';
import { ErrorReportingService } from '../errorReporting';

// ── errorTaxonomy ─────────────────────────────────────────────────────────────

describe('errorTaxonomy', () => {
  it('ErrorCatalogue contains all defined error codes', () => {
    const allCodes = Object.values(ErrorCodes);
    allCodes.forEach((code) => {
      expect(ErrorCatalogue[code]).toBeDefined();
    });
  });

  it('all catalogue entries have non-empty suggestions', () => {
    Object.values(ErrorCatalogue).forEach((entry) => {
      expect(entry.suggestions.length).toBeGreaterThan(0);
    });
  });

  it('resolveError returns known error for known code', () => {
    const error = resolveError(ErrorCodes.GRPC_UNAVAILABLE);
    expect(error.code).toBe(ErrorCodes.GRPC_UNAVAILABLE);
    expect(error.category).toBe('network');
    expect(error.isRecoverable).toBe(true);
  });

  it('resolveError returns generic unknown error for unknown code', () => {
    const error = resolveError('AV-COMPLETELY-UNKNOWN');
    expect(error.code).toBe('AV-UNK-000');
    expect(error.category).toBe('unknown');
  });

  it('resolveError attaches internalDetail when provided', () => {
    const error = resolveError(ErrorCodes.INFERENCE_FAILED, 'NullPointerException at line 42');
    expect(error.internalDetail).toBe('NullPointerException at line 42');
  });

  it('MODEL_LOAD_FAILED is not recoverable', () => {
    const error = resolveError(ErrorCodes.MODEL_LOAD_FAILED);
    expect(error.isRecoverable).toBe(false);
  });

  it('PERMISSION errors are categorized correctly', () => {
    expect(resolveError(ErrorCodes.MIC_PERMISSION_DENIED).category).toBe('permission');
    expect(resolveError(ErrorCodes.CAMERA_PERMISSION_DENIED).category).toBe('permission');
  });
});

// ── ErrorReportingService ─────────────────────────────────────────────────────

describe('ErrorReportingService', () => {
  it('report creates and stores a report', () => {
    const svc = new ErrorReportingService({ logToConsole: false, maxReports: 10 });
    const error = resolveError(ErrorCodes.GRPC_TIMEOUT);
    const report = svc.report(error, { component: 'STTPanel' });

    expect(report.reportId).toMatch(/^err-/);
    expect(report.error.code).toBe(ErrorCodes.GRPC_TIMEOUT);
    expect(report.context.component).toBe('STTPanel');
    expect(svc.reportCount).toBe(1);
  });

  it('invokes onReport callback', () => {
    const onReport = vi.fn();
    const svc = new ErrorReportingService({ logToConsole: false, onReport, maxReports: 10 });
    const error = resolveError(ErrorCodes.INVALID_INPUT);
    svc.report(error);

    expect(onReport).toHaveBeenCalledTimes(1);
    expect(onReport.mock.calls[0]![0].error.code).toBe(ErrorCodes.INVALID_INPUT);
  });

  it('evicts oldest report when maxReports is reached', () => {
    const svc = new ErrorReportingService({ logToConsole: false, maxReports: 3 });
    const error = resolveError(ErrorCodes.INFERENCE_FAILED);

    svc.report(error, { correlationId: 'r1' });
    svc.report(error, { correlationId: 'r2' });
    svc.report(error, { correlationId: 'r3' });
    const old = svc.getAllReports()[0];

    svc.report(error, { correlationId: 'r4' }); // should evict r1

    expect(svc.reportCount).toBe(3);
    expect(svc.getAllReports()[0]).not.toBe(old);
  });

  it('getRecentReports returns last N reports', () => {
    const svc = new ErrorReportingService({ logToConsole: false, maxReports: 20 });
    const error = resolveError(ErrorCodes.GRPC_UNAVAILABLE);
    for (let i = 0; i < 5; i++) {
      svc.report(error);
    }

    expect(svc.getRecentReports(3)).toHaveLength(3);
  });

  it('clearReports empties the report list', () => {
    const svc = new ErrorReportingService({ logToConsole: false, maxReports: 10 });
    svc.report(resolveError(ErrorCodes.GRPC_UNAVAILABLE));
    svc.clearReports();
    expect(svc.reportCount).toBe(0);
  });
});

