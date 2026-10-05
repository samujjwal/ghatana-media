/**
 * Guided tour component for new user onboarding (AV-010.2).
 *
 * @doc.type component
 * @doc.purpose Interactive step-by-step onboarding tour for new users
 * @doc.layer application
 * @doc.pattern GuidedTour
 */

import React, { useCallback, useState } from 'react';

export interface TourStep {
  /** Step title */
  title: string;
  /** Descriptive content for this step */
  description: string;
  /** Optional target element selector for highlighting */
  targetSelector?: string;
  /** Optional action to take on this step */
  action?: string;
}

interface GuidedTourProps {
  /** Ordered list of tour steps */
  steps: TourStep[];
  /** Called when the tour is dismissed or completed */
  onComplete: () => void;
  /** Called when a specific step is reached */
  onStepChange?: (stepIndex: number, step: TourStep) => void;
  /** Whether the tour is currently visible */
  isVisible: boolean;
}

/**
 * A multi-step guided tour that walks new users through the key features of
 * the Audio-Video application.  Renders a floating card with step progress,
 * navigation controls, and keyboard support.
 */
const GuidedTour: React.FC<GuidedTourProps> = ({
  steps,
  onComplete,
  onStepChange,
  isVisible,
}) => {
  const [currentStep, setCurrentStep] = useState<number>(0);

  const handleNext = useCallback(() => {
    if (currentStep < steps.length - 1) {
      const next = currentStep + 1;
      setCurrentStep(next);
      onStepChange?.(next, steps[next]!);
    } else {
      onComplete();
    }
  }, [currentStep, steps, onComplete, onStepChange]);

  const handlePrevious = useCallback(() => {
    if (currentStep > 0) {
      const prev = currentStep - 1;
      setCurrentStep(prev);
      onStepChange?.(prev, steps[prev]!);
    }
  }, [currentStep, steps, onStepChange]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter') handleNext();
      if (e.key === 'ArrowLeft') handlePrevious();
      if (e.key === 'Escape') onComplete();
    },
    [handleNext, handlePrevious, onComplete]
  );

  if (!isVisible || steps.length === 0) return null;

  const step = steps[currentStep];
  if (!step) return null;

  const isLast = currentStep === steps.length - 1;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`Guided tour step ${currentStep + 1} of ${steps.length}: ${step.title}`}
      className="guided-tour fixed bottom-8 right-8 z-50 w-80 rounded-xl shadow-2xl
                 bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-700 p-5"
      onKeyDown={handleKeyDown}
      tabIndex={-1}
    >
      {/* Progress indicator */}
      <div className="flex gap-1 mb-3" aria-hidden="true">
        {steps.map((_, idx) => (
          <div
            key={idx}
            className={`h-1 flex-1 rounded-full ${
              idx <= currentStep
                ? 'bg-blue-500'
                : 'bg-gray-200 dark:bg-gray-600'
            }`}
          />
        ))}
      </div>

      <p className="text-xs font-medium text-blue-500 uppercase tracking-wide mb-1">
        Step {currentStep + 1} of {steps.length}
      </p>

      <h2 className="text-base font-semibold text-gray-900 dark:text-white mb-2">
        {step.title}
      </h2>

      <p className="text-sm text-gray-600 dark:text-gray-300 mb-4">
        {step.description}
      </p>

      {step.action && (
        <div className="rounded-md bg-blue-50 dark:bg-blue-900/30 px-3 py-2 mb-4">
          <p className="text-xs text-blue-700 dark:text-blue-300">
            💡 <strong>Try it:</strong> {step.action}
          </p>
        </div>
      )}

      <div className="flex items-center justify-between">
        <button
          type="button"
          className="text-sm text-gray-500 hover:text-gray-700 dark:hover:text-gray-200
                     focus:outline-none focus:ring-2 focus:ring-gray-400 rounded"
          onClick={onComplete}
          aria-label="Dismiss guided tour"
        >
          Skip tour
        </button>

        <div className="flex gap-2">
          {currentStep > 0 && (
            <button
              type="button"
              className="px-3 py-1.5 text-sm font-medium rounded-md border border-gray-300
                         text-gray-700 hover:bg-gray-50 dark:border-gray-600 dark:text-gray-200
                         dark:hover:bg-gray-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
              onClick={handlePrevious}
              aria-label="Previous tour step"
            >
              Back
            </button>
          )}
          <button
            type="button"
            className="px-3 py-1.5 text-sm font-medium rounded-md bg-blue-600 text-white
                       hover:bg-blue-700 focus:outline-none focus:ring-2 focus:ring-blue-500"
            onClick={handleNext}
            aria-label={isLast ? 'Finish tour' : 'Next tour step'}
          >
            {isLast ? 'Finish' : 'Next'}
          </button>
        </div>
      </div>
    </div>
  );
};

export default GuidedTour;

