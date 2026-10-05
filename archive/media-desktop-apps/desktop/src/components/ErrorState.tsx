/**
 * Error state UI component with recovery suggestions (AV-011.3).
 *
 * @doc.type component
 * @doc.purpose Error display with actionable recovery suggestions
 * @doc.layer application
 * @doc.pattern ErrorState
 */

import React, { useCallback } from 'react';
import type { AppError } from '../errors/errorTaxonomy';

interface ErrorStateProps {
  /** The structured error to display */
  error: AppError;
  /** Called when the user clicks "Try again" */
  onRetry?: () => void;
  /** Called when the user reports the error */
  onReport?: (error: AppError) => void;
  /** Additional CSS classes */
  className?: string;
}

/** Maps severity to visual styles */
const severityStyles: Record<AppError['severity'], string> = {
  info:     'border-blue-200   bg-blue-50   text-blue-800   dark:border-blue-800 dark:bg-blue-900/30 dark:text-blue-200',
  warning:  'border-yellow-200 bg-yellow-50 text-yellow-800 dark:border-yellow-800 dark:bg-yellow-900/30 dark:text-yellow-200',
  error:    'border-red-200    bg-red-50    text-red-800    dark:border-red-800 dark:bg-red-900/30 dark:text-red-200',
  critical: 'border-red-400    bg-red-100   text-red-900    dark:border-red-600 dark:bg-red-900/50 dark:text-red-100',
};

const severityIcons: Record<AppError['severity'], string> = {
  info:     'ℹ️',
  warning:  '⚠️',
  error:    '❌',
  critical: '🚨',
};

/**
 * A fully accessible error state component that displays the user-facing error
 * message, actionable recovery suggestions, and optional retry / report actions.
 */
const ErrorState: React.FC<ErrorStateProps> = ({
  error,
  onRetry,
  onReport,
  className = '',
}) => {
  const handleReport = useCallback(() => {
    onReport?.(error);
  }, [onReport, error]);

  return (
    <div
      role="alert"
      aria-live="assertive"
      aria-atomic="true"
      className={`rounded-lg border p-4 ${severityStyles[error.severity]} ${className}`}
    >
      {/* Header */}
      <div className="flex items-start gap-3">
        <span className="text-xl flex-shrink-0" aria-hidden="true">
          {severityIcons[error.severity]}
        </span>
        <div className="flex-1 min-w-0">
          <p className="font-semibold text-sm mb-1">{error.message}</p>
          <p className="text-xs opacity-75">Error code: {error.code}</p>
        </div>
      </div>

      {/* Recovery suggestions */}
      {error.suggestions.length > 0 && (
        <div className="mt-3 ml-9">
          <p className="text-xs font-medium uppercase tracking-wide opacity-75 mb-1.5">
            How to resolve
          </p>
          <ol className="space-y-1.5 list-decimal list-inside">
            {error.suggestions.map((suggestion, idx) => (
              <li key={idx} className="text-sm">
                {suggestion}
              </li>
            ))}
          </ol>
        </div>
      )}

      {/* Action row */}
      <div className="mt-4 ml-9 flex items-center gap-3 flex-wrap">
        {error.isRecoverable && onRetry && (
          <button
            type="button"
            className="px-3 py-1.5 text-xs font-medium rounded-md bg-white dark:bg-gray-700
                       border border-current opacity-80 hover:opacity-100 focus:outline-none
                       focus:ring-2 focus:ring-current transition-opacity"
            onClick={onRetry}
            aria-label="Retry the failed operation"
          >
            Try again
          </button>
        )}

        {error.docsUrl && (
          <a
            href={error.docsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="text-xs underline hover:no-underline focus:outline-none
                       focus:ring-2 focus:ring-current rounded opacity-80 hover:opacity-100"
          >
            View documentation ↗
          </a>
        )}

        {onReport && (
          <button
            type="button"
            className="text-xs underline hover:no-underline focus:outline-none
                       focus:ring-2 focus:ring-current rounded opacity-70 hover:opacity-100"
            onClick={handleReport}
            aria-label="Report this error to the support team"
          >
            Report this issue
          </button>
        )}
      </div>
    </div>
  );
};

export default ErrorState;

