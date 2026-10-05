/**
 * @doc.type test
 * @doc.purpose Tests for standardized error handling
 * @doc.layer platform
 */
package com.ghatana.media.error;

import com.ghatana.core.exception.*;

import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;

import java.net.ConnectException;
import java.net.SocketTimeoutException;

/**
 * Tests for CONS-006: Exception hierarchy consistency and AV-004: Error handling standardization
 */
class ErrorHandlerTest {

    @Test
    @DisplayName("Should classify timeout exceptions as retryable")
    void testTimeoutRetryable() { 
        assertTrue(ErrorHandler.isRetryable(new SocketTimeoutException("Connection timed out")));
        assertTrue(ErrorHandler.isRetryable(new java.util.concurrent.TimeoutException("Operation timeout")));
    }

    @Test
    @DisplayName("Should classify connect exceptions as retryable")
    void testConnectRetryable() { 
        assertTrue(ErrorHandler.isRetryable(new ConnectException("Connection refused")));
    }

    @Test
    @DisplayName("Should classify validation exceptions as non-retryable")
    void testValidationNonRetryable() { 
        assertFalse(ErrorHandler.isRetryable(new ValidationException("Invalid input")));
    }

    @Test
    @DisplayName("Should classify security exceptions as non-retryable")
    void testSecurityNonRetryable() { 
        assertFalse(ErrorHandler.isRetryable(new UnauthorizedException("Access denied")));
    }

    @Test
    @DisplayName("Should get correct error category")
    void testErrorCategories() { 
        assertEquals("VALIDATION", ErrorHandler.getErrorCategory(new ValidationException("Invalid")));
        assertEquals("NOT_FOUND", ErrorHandler.getErrorCategory(new ResourceNotFoundException("Not found")));
        assertEquals("SECURITY", ErrorHandler.getErrorCategory(new UnauthorizedException("Denied")));
        assertEquals("TIMEOUT", ErrorHandler.getErrorCategory(new SocketTimeoutException("Timeout")));
        assertEquals("NETWORK", ErrorHandler.getErrorCategory(new ConnectException("Failed")));
        assertEquals("UNKNOWN", ErrorHandler.getErrorCategory(new RuntimeException("Unknown")));
    }

    @Test
    @DisplayName("Should translate exceptions to platform standards")
    void testExceptionTranslation() { 
        // IllegalArgumentException -> ValidationException
        BaseException translated = ErrorHandler.translate( 
            new IllegalArgumentException("Bad argument"), "test context"
        );
        assertInstanceOf(ValidationException.class, translated); 
        assertTrue(translated.getMessage().contains("test context"));

        // SocketTimeoutException -> TimeoutException
        translated = ErrorHandler.translate( 
            new SocketTimeoutException("Connection timeout"), "network call"
        );
        assertInstanceOf(TimeoutException.class, translated); 

        // ConnectException -> ServiceUnavailableException
        translated = ErrorHandler.translate( 
            new ConnectException("Connection refused"), "service call"
        );
        assertInstanceOf(ServiceUnavailableException.class, translated); 
    }

    @Test
    @DisplayName("Should pass through BaseException without translation")
    void testBaseExceptionPassthrough() { 
        ValidationException original = new ValidationException("Original");
        BaseException translated = ErrorHandler.translate(original, "context"); 
        assertSame(original, translated); 
    }

    @Test
    @DisplayName("Should execute operation with handling")
    void testExecuteWithHandling() { 
        // Success case
        String result = ErrorHandler.executeWithHandling(() -> "success", "operation"); 
        assertEquals("success", result); 

        // Failure case
        BaseException exception = assertThrows(BaseException.class, () -> { 
            ErrorHandler.executeWithHandling(() -> { 
                throw new IllegalArgumentException("Bad input");
            }, "test operation");
        });
        assertInstanceOf(ValidationException.class, exception); 
    }

    @Test
    @DisplayName("Should execute with fallback on failure")
    void testExecuteWithFallback() { 
        String result = ErrorHandler.executeWithFallback( 
            () -> { throw new RuntimeException("Primary failed"); },
            () -> "fallback result", 
            "primary operation"
        );
        assertEquals("fallback result", result); 

        // Success case - fallback not used
        result = ErrorHandler.executeWithFallback( 
            () -> "primary result", 
            () -> "fallback result", 
            "primary operation"
        );
        assertEquals("primary result", result); 
    }

    @Test
    @DisplayName("Should wrap checked exceptions as runtime")
    void testWrapAsRuntime() { 
        Exception checked = new Exception("Checked exception");
        RuntimeException runtime = ErrorHandler.wrapAsRuntime(checked); 
        assertEquals(checked.getMessage(), runtime.getMessage()); 
        assertSame(checked, runtime.getCause()); 

        // Already runtime - should return same
        RuntimeException alreadyRuntime = new IllegalArgumentException("Already runtime");
        RuntimeException result = ErrorHandler.wrapAsRuntime(alreadyRuntime); 
        assertSame(alreadyRuntime, result); 
    }

    @Test
    @DisplayName("Should provide user-friendly messages")
    void testUserMessages() { 
        assertTrue(ErrorHandler.getUserMessage(new ValidationException("Invalid"))
            .contains("Invalid input"));
        assertTrue(ErrorHandler.getUserMessage(new ResourceNotFoundException("Not found"))
            .contains("Resource not found"));
        assertTrue(ErrorHandler.getUserMessage(new TimeoutException("Timeout"))
            .contains("timed out"));
        assertTrue(ErrorHandler.getUserMessage(new ServiceUnavailableException("Down"))
            .contains("temporarily unavailable"));
        assertTrue(ErrorHandler.getUserMessage(new UnauthorizedException("Denied"))
            .contains("Access denied"));
    }

    @Test
    @DisplayName("Should determine correct severity levels")
    void testSeverityLevels() { 
        assertEquals(ErrorHandler.Severity.CRITICAL, 
            ErrorHandler.getSeverity(new InternalException("Critical")));
        assertEquals(ErrorHandler.Severity.HIGH, 
            ErrorHandler.getSeverity(new ServiceUnavailableException("Down")));
        assertEquals(ErrorHandler.Severity.MEDIUM, 
            ErrorHandler.getSeverity(new TimeoutException("Timeout")));
        assertEquals(ErrorHandler.Severity.LOW, 
            ErrorHandler.getSeverity(new ValidationException("Invalid")));
        assertEquals(ErrorHandler.Severity.LOW, 
            ErrorHandler.getSeverity(new ResourceNotFoundException("Not found")));
    }

    @Test
    @DisplayName("Should check nested causes for retryable")
    void testNestedCauseRetryable() { 
        // Wrap a retryable exception
        Exception wrapped = new RuntimeException("Wrapper", 
            new SocketTimeoutException("Inner timeout"));
        assertTrue(ErrorHandler.isRetryable(wrapped)); 

        // Deeply nested
        Exception deep = new RuntimeException("Level 1", 
            new RuntimeException("Level 2", 
                new ConnectException("Level 3")));
        assertTrue(ErrorHandler.isRetryable(deep)); 
    }
}
