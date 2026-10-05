/**
 * @doc.type class
 * @doc.purpose Standardized error handling utilities for cross-platform consistency
 * @doc.layer platform
 * @doc.pattern Utility, ErrorHandling
 */
package com.ghatana.media.error;

import com.ghatana.core.exception.*;

import java.util.logging.Level;
import java.util.logging.Logger;
import java.util.function.Supplier;

/**
 * Standardized error handling utilities for audio-video operations.
 *
 * <p>Provides consistent error handling patterns across Java and TypeScript:
 * <ul>
 *   <li>Error classification (retryable vs non-retryable)</li>
 *   <li>Exception translation to platform standard exceptions</li>
 *   <li>Logging with consistent format</li>
 *   <li>Recovery action dispatch</li>
 * </ul></p>
 *
 * <p>Aligns with TypeScript ErrorHandler in platform/typescript/api/src/errors.ts</p>
 *
 * @since 2026-03-27
 * @see com.ghatana.core.exception.BaseException
 */
public final class ErrorHandler {

    private static final Logger LOG = Logger.getLogger(ErrorHandler.class.getName());

    private ErrorHandler() {} // Utility class

    /**
     * Classifies an exception as retryable or non-retryable.
     *
     * <p>Retryable errors:
     * <ul>
     *   <li>Network timeouts</li>
     *   <li>Temporary service unavailability</li>
     *   <li>Resource exhaustion (may resolve)</li>
     * </ul></p>
     *
     * <p>Non-retryable errors:
     * <ul>
     *   <li>Validation errors</li>
     *   <li>Invalid configuration</li>
     *   <li>Permission denied</li>
     *   <li>Resource not found</li>
     * </ul></p>
     *
     * @param throwable the exception to classify
     * @return true if the error might succeed on retry
     */
    public static boolean isRetryable(Throwable throwable) {
        if (throwable == null) {
            return false;
        }

        // BaseException has explicit retryable flag
        if (throwable instanceof BaseException) {
            return ((BaseException) throwable).isRetryable();
        }

        // Timeout and transient errors
        String message = throwable.getMessage();
        if (message != null) {
            String lowerMsg = message.toLowerCase();
            if (lowerMsg.contains("timeout") ||
                lowerMsg.contains("timed out") ||
                lowerMsg.contains("temporarily unavailable") ||
                lowerMsg.contains("try again") ||
                lowerMsg.contains("resource exhausted") ||
                lowerMsg.contains("too many requests") ||
                lowerMsg.contains("rate limit")) {
                return true;
            }
        }

        // Network-related exceptions
        if (throwable instanceof java.net.SocketTimeoutException ||
            throwable instanceof java.net.ConnectException ||
            throwable instanceof java.io.IOException) {
            return true;
        }

        // Caused by retryable
        Throwable cause = throwable.getCause();
        if (cause != null && !cause.equals(throwable)) {
            return isRetryable(cause);
        }

        return false;
    }

    /**
     * Gets the error category for metrics and monitoring.
     *
     * @param throwable the exception
     * @return category string (VALIDATION, NETWORK, TIMEOUT, RESOURCE, UNKNOWN)
     */
    public static String getErrorCategory(Throwable throwable) {
        if (throwable instanceof ValidationException) {
            return "VALIDATION";
        }
        if (throwable instanceof ResourceNotFoundException) {
            return "NOT_FOUND";
        }
        if (throwable instanceof SecurityException ||
            throwable instanceof UnauthorizedException) {
            return "SECURITY";
        }
        if (throwable instanceof java.net.SocketTimeoutException) {
            return "TIMEOUT";
        }
        if (throwable instanceof java.net.ConnectException ||
            throwable instanceof java.io.IOException) {
            return "NETWORK";
        }
        if (throwable instanceof ResourceExhaustedException) {
            return "RESOURCE";
        }
        if (throwable instanceof ConfigurationException) {
            return "CONFIGURATION";
        }
        return "UNKNOWN";
    }

    /**
     * Translates a low-level exception to a platform-standard exception.
     *
     * @param throwable the original exception
     * @param context context description for the error message
     * @return standardized platform exception
     */
    public static BaseException translate(Throwable throwable, String context) {
        if (throwable instanceof BaseException) {
            return (BaseException) throwable;
        }

        String message = context + ": " + (throwable.getMessage() != null ? throwable.getMessage() : "Unknown error");

        if (throwable instanceof IllegalArgumentException) {
            return new ValidationException(message, throwable, java.util.Map.of());
        }
        if (throwable instanceof java.net.SocketTimeoutException) {
            return new TimeoutException(message, throwable);
        }
        if (throwable instanceof java.net.ConnectException) {
            return new ServiceUnavailableException(message, throwable);
        }
        if (throwable instanceof InterruptedException) {
            return new CancellationException("Operation interrupted: " + context, throwable);
        }
        if (throwable instanceof java.io.IOException) {
            return new ServiceUnavailableException(message, throwable);
        }
        if (throwable instanceof IllegalStateException) {
            return new ConflictException(message, throwable);
        }

        // Default to internal error
        return new InternalException(message, throwable);
    }

    /**
     * Logs an exception with appropriate level and context.
     *
     * @param logger the logger to use
     * @param level the log level
     * @param message the message
     * @param throwable the exception
     */
    public static void logException(Logger logger, Level level, String message, Throwable throwable) {
        if (logger == null) {
            logger = LOG;
        }

        String category = getErrorCategory(throwable);
        String retryable = isRetryable(throwable) ? "[RETRYABLE]" : "[NON-RETRYABLE]";
        String fullMessage = String.format("[%s] %s %s", category, retryable, message);

        logger.log(level, fullMessage, throwable);
    }

    /**
     * Executes an operation with standardized error handling.
     *
     * @param operation the operation to execute
     * @param errorContext context for error messages
     * @param <T> return type
     * @return operation result
     * @throws BaseException standardized exception on failure
     */
    public static <T> T executeWithHandling(Supplier<T> operation, String errorContext) {
        try {
            return operation.get();
        } catch (Exception e) {
            BaseException translated = translate(e, errorContext);
            logException(LOG, Level.WARNING, errorContext + " failed", translated);
            throw translated;
        }
    }

    /**
     * Executes an operation with fallback on failure.
     *
     * @param operation the primary operation
     * @param fallback the fallback operation
     * @param errorContext context for error messages
     * @param <T> return type
     * @return operation result or fallback result
     */
    public static <T> T executeWithFallback(Supplier<T> operation, Supplier<T> fallback, String errorContext) {
        try {
            return operation.get();
        } catch (Exception e) {
            logException(LOG, Level.INFO, errorContext + " failed, using fallback", e);
            return fallback.get();
        }
    }

    /**
     * Wraps an exception in a RuntimeException if needed.
     *
     * @param throwable the exception
     * @return runtime exception
     */
    public static RuntimeException wrapAsRuntime(Throwable throwable) {
        if (throwable instanceof RuntimeException) {
            return (RuntimeException) throwable;
        }
        return new RuntimeException(throwable.getMessage(), throwable);
    }

    /**
     * Gets a user-friendly error message.
     *
     * @param throwable the exception
     * @return user-friendly message
     */
    public static String getUserMessage(Throwable throwable) {
        if (throwable instanceof ValidationException) {
            return "Invalid input: " + throwable.getMessage();
        }
        if (throwable instanceof ResourceNotFoundException) {
            return "Resource not found: " + throwable.getMessage();
        }
        if (throwable instanceof TimeoutException) {
            return "Operation timed out. Please try again.";
        }
        if (throwable instanceof ServiceUnavailableException) {
            return "Service temporarily unavailable. Please try again later.";
        }
        if (throwable instanceof UnauthorizedException) {
            return "Access denied. Please check your permissions.";
        }
        if (throwable instanceof ConfigurationException) {
            return "Configuration error. Please contact support.";
        }
        return "An error occurred. Please try again or contact support.";
    }

    /**
     * Error severity levels for monitoring.
     */
    public enum Severity {
        CRITICAL,   // System-wide impact, immediate attention needed
        HIGH,       // Significant impact, urgent attention needed
        MEDIUM,     // Localized impact, should be addressed
        LOW,        // Minor impact, can be addressed in regular cycle
        INFO        // Informational only
    }

    /**
     * Gets the severity level for an exception.
     *
     * @param throwable the exception
     * @return severity level
     */
    public static Severity getSeverity(Throwable throwable) {
        if (throwable instanceof InternalException) {
            return Severity.CRITICAL;
        }
        if (throwable instanceof ServiceUnavailableException) {
            return Severity.HIGH;
        }
        if (throwable instanceof TimeoutException) {
            return Severity.MEDIUM;
        }
        if (throwable instanceof ValidationException) {
            return Severity.LOW;
        }
        if (throwable instanceof ResourceNotFoundException) {
            return Severity.LOW;
        }
        return Severity.MEDIUM;
    }
}
