/**
 * Context-sensitive help component (AV-010.4).
 *
 * @doc.type component
 * @doc.purpose Context-aware help tooltips and documentation links
 * @doc.layer application
 * @doc.pattern ContextHelp
 */

import React, { useCallback, useRef, useState } from 'react';

export interface HelpContent {
  /** Short help text shown in the tooltip */
  summary: string;
  /** Optional link to full documentation */
  docsUrl?: string;
  /** Optional list of quick tips */
  tips?: string[];
}

interface ContextHelpProps {
  /** Help content for this context */
  content: HelpContent;
  /** Accessible label for the help button */
  ariaLabel?: string;
  /** Additional CSS classes for the container */
  className?: string;
}

/**
 * A help icon button that shows context-sensitive documentation when clicked.
 * Supports keyboard navigation and ARIA attributes for full accessibility.
 */
const ContextHelp: React.FC<ContextHelpProps> = ({
  content,
  ariaLabel = 'Show help',
  className = '',
}) => {
  const [visible, setVisible] = useState<boolean>(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const toggle = useCallback(() => setVisible((prev) => !prev), []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Escape') {
        setVisible(false);
        buttonRef.current?.focus();
      }
    },
    []
  );

  return (
    <div className={`context-help relative inline-block ${className}`} onKeyDown={handleKeyDown}>
      <button
        ref={buttonRef}
        type="button"
        aria-label={ariaLabel}
        aria-expanded={visible}
        aria-haspopup="dialog"
        className="w-5 h-5 rounded-full bg-blue-100 dark:bg-blue-900 text-blue-600
                   dark:text-blue-300 text-xs font-bold flex items-center justify-center
                   hover:bg-blue-200 dark:hover:bg-blue-800 focus:outline-none
                   focus:ring-2 focus:ring-blue-500 transition-colors"
        onClick={toggle}
      >
        ?
      </button>

      {visible && (
        <div
          ref={panelRef}
          role="dialog"
          aria-label="Help"
          aria-modal="false"
          className="absolute z-50 left-8 top-0 w-72 rounded-lg shadow-xl
                     bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700
                     p-4 text-sm"
        >
          <div className="flex items-start justify-between mb-2">
            <span className="font-medium text-gray-900 dark:text-white">Help</span>
            <button
              type="button"
              aria-label="Close help"
              className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200
                         focus:outline-none focus:ring-2 focus:ring-gray-400 rounded"
              onClick={toggle}
            >
              ✕
            </button>
          </div>

          <p className="text-gray-600 dark:text-gray-300 mb-3">{content.summary}</p>

          {content.tips && content.tips.length > 0 && (
            <div className="mb-3">
              <p className="font-medium text-gray-700 dark:text-gray-200 mb-1 text-xs uppercase tracking-wide">
                Tips
              </p>
              <ul className="space-y-1">
                {content.tips.map((tip, idx) => (
                  <li key={idx} className="flex items-start gap-2 text-gray-600 dark:text-gray-300">
                    <span className="text-blue-500 mt-0.5">•</span>
                    {tip}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {content.docsUrl && (
            <a
              href={content.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex items-center gap-1 text-blue-600 dark:text-blue-400
                         hover:underline focus:outline-none focus:ring-2 focus:ring-blue-500 rounded text-xs"
            >
              Full documentation ↗
            </a>
          )}
        </div>
      )}
    </div>
  );
};

export default ContextHelp;

