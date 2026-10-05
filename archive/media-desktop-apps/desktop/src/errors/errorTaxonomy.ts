/**
 * Error taxonomy and structured error types for the audio-video desktop app (AV-011.1).
 *
 * @doc.type module
 * @doc.purpose Structured error taxonomy with recovery suggestions
 * @doc.layer application
 * @doc.pattern ErrorHandling
 */

/** High-level categories of errors in the audio-video application. */
export type ErrorCategory =
  | 'network'
  | 'audio-hardware'
  | 'video-hardware'
  | 'model-loading'
  | 'inference'
  | 'permission'
  | 'validation'
  | 'unknown';

/** User-facing severity levels. */
export type ErrorSeverity = 'info' | 'warning' | 'error' | 'critical';

/** A structured application error with recovery guidance. */
export interface AppError {
  /** Machine-readable error code */
  readonly code: string;
  /** Error category */
  readonly category: ErrorCategory;
  /** Severity level */
  readonly severity: ErrorSeverity;
  /** User-facing error message (safe to display) */
  readonly message: string;
  /** One or more recovery suggestions */
  readonly suggestions: readonly string[];
  /** Optional link to documentation */
  readonly docsUrl?: string;
  /** Whether this error is recoverable without app restart */
  readonly isRecoverable: boolean;
  /** Underlying error detail for logging (not shown to users) */
  readonly internalDetail?: string;
}

/** Well-known error codes for the audio-video application. */
export const ErrorCodes = {
  // Network
  GRPC_UNAVAILABLE:     'AV-NET-001',
  GRPC_TIMEOUT:         'AV-NET-002',
  // Audio hardware
  MIC_PERMISSION_DENIED: 'AV-AUD-001',
  MIC_NOT_FOUND:         'AV-AUD-002',
  AUDIO_FORMAT_UNSUPPORTED: 'AV-AUD-003',
  // Video hardware
  CAMERA_PERMISSION_DENIED: 'AV-VID-001',
  CAMERA_NOT_FOUND:          'AV-VID-002',
  // Model
  MODEL_NOT_LOADED:     'AV-MDL-001',
  MODEL_LOAD_FAILED:    'AV-MDL-002',
  // Inference
  INFERENCE_FAILED:     'AV-INF-001',
  INFERENCE_TIMEOUT:    'AV-INF-002',
  // Validation
  INVALID_INPUT:        'AV-VAL-001',
} as const;

export type ErrorCode = (typeof ErrorCodes)[keyof typeof ErrorCodes];

/** Catalogue of all recoverable errors with their recovery suggestions. */
export const ErrorCatalogue: Readonly<Record<ErrorCode, AppError>> = {
  [ErrorCodes.GRPC_UNAVAILABLE]: {
    code: ErrorCodes.GRPC_UNAVAILABLE,
    category: 'network',
    severity: 'error',
    message: 'Cannot connect to the audio-video service.',
    suggestions: [
      'Ensure the service is running (check the system tray icon).',
      'Verify your network connection.',
      'Restart the service from the Settings panel.',
    ],
    docsUrl: '/docs/troubleshooting/service-connection',
    isRecoverable: true,
  },
  [ErrorCodes.GRPC_TIMEOUT]: {
    code: ErrorCodes.GRPC_TIMEOUT,
    category: 'network',
    severity: 'warning',
    message: 'The request took too long to complete.',
    suggestions: [
      'Reduce the audio clip length.',
      'Check that the service is not overloaded.',
    ],
    isRecoverable: true,
  },
  [ErrorCodes.MIC_PERMISSION_DENIED]: {
    code: ErrorCodes.MIC_PERMISSION_DENIED,
    category: 'permission',
    severity: 'error',
    message: 'Microphone access was denied.',
    suggestions: [
      'Open system settings and grant microphone permission to this app.',
      'Restart the application after granting permission.',
    ],
    docsUrl: '/docs/permissions/microphone',
    isRecoverable: true,
  },
  [ErrorCodes.MIC_NOT_FOUND]: {
    code: ErrorCodes.MIC_NOT_FOUND,
    category: 'audio-hardware',
    severity: 'error',
    message: 'No microphone was found.',
    suggestions: [
      'Connect a microphone and retry.',
      'Check that your audio input device is enabled in system settings.',
    ],
    isRecoverable: true,
  },
  [ErrorCodes.AUDIO_FORMAT_UNSUPPORTED]: {
    code: ErrorCodes.AUDIO_FORMAT_UNSUPPORTED,
    category: 'audio-hardware',
    severity: 'warning',
    message: 'The audio format is not supported.',
    suggestions: [
      'Use WAV or MP3 files at 16kHz or 44.1kHz.',
      'Convert your audio file using the built-in converter.',
    ],
    isRecoverable: true,
  },
  [ErrorCodes.CAMERA_PERMISSION_DENIED]: {
    code: ErrorCodes.CAMERA_PERMISSION_DENIED,
    category: 'permission',
    severity: 'error',
    message: 'Camera access was denied.',
    suggestions: [
      'Open system settings and grant camera permission to this app.',
    ],
    isRecoverable: true,
  },
  [ErrorCodes.CAMERA_NOT_FOUND]: {
    code: ErrorCodes.CAMERA_NOT_FOUND,
    category: 'video-hardware',
    severity: 'error',
    message: 'No camera was detected.',
    suggestions: [
      'Connect a USB or built-in camera and retry.',
    ],
    isRecoverable: true,
  },
  [ErrorCodes.MODEL_NOT_LOADED]: {
    code: ErrorCodes.MODEL_NOT_LOADED,
    category: 'model-loading',
    severity: 'error',
    message: 'The AI model has not been loaded yet.',
    suggestions: [
      'Go to Settings → Models and download the required model.',
      'Wait for the model download to complete before retrying.',
    ],
    docsUrl: '/docs/models/setup',
    isRecoverable: true,
  },
  [ErrorCodes.MODEL_LOAD_FAILED]: {
    code: ErrorCodes.MODEL_LOAD_FAILED,
    category: 'model-loading',
    severity: 'critical',
    message: 'Failed to load the AI model.',
    suggestions: [
      'Check available disk space (models require at least 2 GB).',
      'Delete and re-download the model from Settings → Models.',
    ],
    isRecoverable: false,
  },
  [ErrorCodes.INFERENCE_FAILED]: {
    code: ErrorCodes.INFERENCE_FAILED,
    category: 'inference',
    severity: 'error',
    message: 'AI processing failed.',
    suggestions: [
      'Try a shorter audio or video clip.',
      'Restart the service and retry.',
    ],
    isRecoverable: true,
  },
  [ErrorCodes.INFERENCE_TIMEOUT]: {
    code: ErrorCodes.INFERENCE_TIMEOUT,
    category: 'inference',
    severity: 'warning',
    message: 'AI processing took too long.',
    suggestions: [
      'Use a smaller input.',
      'Check that GPU acceleration is enabled in Settings.',
    ],
    isRecoverable: true,
  },
  [ErrorCodes.INVALID_INPUT]: {
    code: ErrorCodes.INVALID_INPUT,
    category: 'validation',
    severity: 'warning',
    message: 'The provided input is not valid.',
    suggestions: [
      'Check that the file format is supported.',
      'Ensure the input is not empty.',
    ],
    isRecoverable: true,
  },
} as const;

/**
 * Looks up the structured error for a known error code.
 * Falls back to a generic unknown error if the code is not in the catalogue.
 *
 * @param code - error code string
 * @param internalDetail - internal detail for logging (never shown to users)
 */
export function resolveError(code: string, internalDetail?: string): AppError {
  const known = ErrorCatalogue[code as ErrorCode];
  if (known) {
    return internalDetail ? { ...known, internalDetail } : known;
  }
  return {
    code: 'AV-UNK-000',
    category: 'unknown',
    severity: 'error',
    message: 'An unexpected error occurred.',
    suggestions: ['Try again.', 'Restart the application if the problem persists.'],
    isRecoverable: true,
    internalDetail,
  };
}

