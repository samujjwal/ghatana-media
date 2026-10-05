/**
 * Progressive disclosure component for simplified onboarding (AV-010.1).
 *
 * @doc.type component
 * @doc.purpose Progressive disclosure of advanced features to reduce cognitive load
 * @doc.layer application
 * @doc.pattern ProgressiveDisclosure
 */

import React, { useCallback, useState } from 'react';

interface ProgressiveDisclosureProps {
  /** Summary content always visible */
  summary: React.ReactNode;
  /** Detailed content shown on expansion */
  children: React.ReactNode;
  /** Label for the expand/collapse toggle */
  toggleLabel?: string;
  /** Default expanded state */
  defaultExpanded?: boolean;
  /** Accessible description of this disclosure section */
  ariaLabel?: string;
}

/**
 * A disclosure widget that hides advanced or optional content behind a toggle.
 * Helps reduce cognitive load during onboarding while keeping power features
 * accessible to experienced users.
 */
const ProgressiveDisclosure: React.FC<ProgressiveDisclosureProps> = ({
  summary,
  children,
  toggleLabel = 'Show advanced options',
  defaultExpanded = false,
  ariaLabel,
}) => {
  const [expanded, setExpanded] = useState<boolean>(defaultExpanded);

  const toggle = useCallback(() => setExpanded((prev) => !prev), []);

  return (
    <div className="progressive-disclosure" aria-label={ariaLabel}>
      <div className="disclosure-summary">{summary}</div>

      <button
        type="button"
        className="disclosure-toggle text-sm font-medium text-blue-600 hover:text-blue-800
                   dark:text-blue-400 dark:hover:text-blue-200 mt-2 flex items-center gap-1
                   focus:outline-none focus:ring-2 focus:ring-blue-500 rounded"
        aria-expanded={expanded}
        aria-controls="disclosure-content"
        onClick={toggle}
      >
        <span
          className={`transition-transform duration-200 ${expanded ? 'rotate-90' : ''}`}
          aria-hidden="true"
        >
          ▶
        </span>
        {expanded ? toggleLabel.replace('Show', 'Hide') : toggleLabel}
      </button>

      <div
        id="disclosure-content"
        role="region"
        hidden={!expanded}
        className={`mt-3 transition-all duration-200 ${
          expanded ? 'opacity-100' : 'opacity-0 pointer-events-none'
        }`}
      >
        {children}
      </div>
    </div>
  );
};

export default ProgressiveDisclosure;

