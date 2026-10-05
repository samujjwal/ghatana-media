/**
 * Error reporting service for capturing and dispatching error telemetry (AV-011.4).
 *
 * @doc.type module
 * @doc.purpose Error reporting and telemetry collection for observable error flows
 * @doc.layer application
 * @doc.pattern Service, Observability
 */

import type { AppError } from './errorTaxonomy';

/** A single error report record. */
export interface ErrorReport {
  readonly reportId: string;
  readonly timestamp: string;
  readonly error: AppError;
  readonly context: ErrorReportContext;
  readonly userAgent: string;
}

/** Contextual metadata attached to an error report. */
export interface ErrorReportContext {
  readonly component?: string;
  readonly operation?: string;
  readonly correlationId?: string;
  readonly additionalData?: Readonly<Record<string, unknown>>;
}

/** Configuration for the error reporting service. */
export interface ErrorReportingConfig {
  /** Whether to log errors to the console */
  readonly logToConsole: boolean;
  /** Callback invoked for each new report (e.g., to send to a backend) */
  readonly onReport?: (report: ErrorReport) => void | Promise<void>;
  /** Maximum number of reports to retain in memory */
  readonly maxReports: number;
}

/**
 * Lightweight client-side error reporting service.
 *
 * Stores error reports in memory and invokes registered callbacks so that
 * errors surface in logs, monitoring dashboards, and support workflows.
 */
export class ErrorReportingService {
  private readonly config: ErrorReportingConfig;
  private readonly reports: ErrorReport[] = [];
  private reportCounter = 0;

  constructor(config: Partial<ErrorReportingConfig> = {}) {
    this.config = {
      logToConsole: config.logToConsole ?? true,
      onReport:     config.onReport,
      maxReports:   config.maxReports ?? 100,
    };
  }

  /**
   * Reports an application error with contextual metadata.
   *
   * @param error   - structured error to report
   * @param context - contextual metadata (component, operation, correlationId, etc.)
   * @returns the generated error report
   */
  report(error: AppError, context: ErrorReportContext = {}): ErrorReport {
    const reportId = `err-${Date.now()}-${++this.reportCounter}`;
    const report: ErrorReport = {
      reportId,
      timestamp: new Date().toISOString(),
      error,
      context,
      userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : 'server',
    };

    // Evict oldest if at capacity
    if (this.reports.length >= this.config.maxReports) {
      this.reports.shift();
    }
    this.reports.push(report);

    if (this.config.logToConsole) {
      const logFn = error.severity === 'critical' || error.severity === 'error'
          ? console.error
          : console.warn;
      logFn(
        `[ErrorReporting] ${report.reportId} ${error.severity.toUpperCase()} [${error.code}]`,
        error.message,
        error.internalDetail ?? '',
      );
    }

    if (this.config.onReport) {
      void Promise.resolve(this.config.onReport(report));
    }

    return report;
  }

  /** Returns all retained error reports. */
  getAllReports(): readonly ErrorReport[] {
    return this.reports;
  }

  /** Returns the most recent N reports. */
  getRecentReports(n: number): readonly ErrorReport[] {
    return this.reports.slice(-Math.max(0, n));
  }

  /** Clears all retained reports. */
  clearReports(): void {
    this.reports.length = 0;
  }

  /** Returns the total number of reports retained. */
  get reportCount(): number {
    return this.reports.length;
  }
}

/** Default shared error reporting service instance. */
export const defaultErrorReporter = new ErrorReportingService({
  logToConsole: true,
  maxReports: 200,
});


