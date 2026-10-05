/**
 * @doc.type test
 * @doc.purpose Tests for CircuitBreaker-protected STT Engine
 * @doc.layer platform
 */
package com.ghatana.media.resilience;

import com.ghatana.media.common.*;
import com.ghatana.media.stt.api.*;
import com.ghatana.resilience.CircuitBreaker;

import io.activej.eventloop.Eventloop;

import org.junit.jupiter.api.*;
import static org.junit.jupiter.api.Assertions.*;
import static org.mockito.Mockito.*;

import java.time.Duration;
import java.util.List;
import java.util.Locale;
import java.util.concurrent.*;

/**
 * Tests for AV-003: Circuit Breaker integration with STT Engine
 */
class CircuitBreakerSttEngineTest {

    private SttEngine mockDelegate;
    private Eventloop eventloop;
    private CircuitBreakerSttEngine protectedEngine;
    private ExecutorService executor;

    @BeforeEach
    void setUp() { 
        mockDelegate = mock(SttEngine.class); 
        eventloop = Eventloop.create(); 
        executor = Executors.newSingleThreadExecutor(); 

        // Start eventloop in background
        executor.submit(() -> eventloop.run()); 

        // Create circuit breaker with sensitive settings for testing
        CircuitBreaker circuitBreaker = CircuitBreaker.builder("test-stt-circuit")
            .failureThreshold(3) 
            .successThreshold(1) 
            .resetTimeout(Duration.ofMillis(100)) 
            .maxBackoff(Duration.ofMillis(500)) 
            .backoffMultiplier(1.0) 
            .build(); 

        protectedEngine = new CircuitBreakerSttEngine(mockDelegate, eventloop, circuitBreaker); 
    }

    @AfterEach
    void tearDown() { 
        eventloop.breakEventloop(); 
        executor.shutdown(); 
        protectedEngine.close(); 
    }

    @Test
    @DisplayName("Should allow normal transcription when circuit is closed")
    void testNormalTranscription() { 
        // Given
        AudioData audio = createTestAudio(); 
        TranscriptionOptions options = TranscriptionOptions.defaults(); 
        TranscriptionResult expectedResult = createTestResult("Hello world");

        when(mockDelegate.transcribe(audio, options)).thenReturn(expectedResult); 
        when(mockDelegate.getActiveModel()).thenReturn(new ModelInfo("test-model", "Test", "1.0", new Locale[]{Locale.ENGLISH}, 1000L, false)); 

        // When
        TranscriptionResult result = protectedEngine.transcribe(audio, options); 

        // Then
        assertEquals(expectedResult, result); 
        assertEquals(CircuitBreaker.State.CLOSED, protectedEngine.getCircuitBreakerState()); 
        verify(mockDelegate).transcribe(audio, options); 
    }

    @Test
    @DisplayName("Should count failures and open circuit after threshold")
    void testCircuitOpensAfterFailures() { 
        // Given
        AudioData audio = createTestAudio(); 
        TranscriptionOptions options = TranscriptionOptions.defaults(); 

        when(mockDelegate.transcribe(any(), any())) 
            .thenThrow(new InferenceError("Test failure", new RuntimeException("fail"), false));
        when(mockDelegate.getActiveModel()).thenReturn(new ModelInfo("test-model", "Test", "1.0", new Locale[]{Locale.ENGLISH}, 1000L, false)); 

        // When - trigger 3 failures
        for (int i = 0; i < 3; i++) { 
            try {
                protectedEngine.transcribe(audio, options); 
            } catch (Exception e) { 
                // Expected
            }
        }

        // Then - circuit should be open
        assertEquals(CircuitBreaker.State.OPEN, protectedEngine.getCircuitBreakerState()); 

        // Additional call should return degraded result, not call delegate
        TranscriptionResult result = protectedEngine.transcribe(audio, options); 
        assertEquals("", result.text()); // Degraded result has empty text 
        verify(mockDelegate, times(3)).transcribe(any(), any()); // Only 3 calls, not 4 
    }

    @Test
    @DisplayName("Should return degraded result when circuit is open")
    void testDegradedResultWhenOpen() throws Exception { 
        // Given - manually create engine with open circuit
        CircuitBreaker openCircuitBreaker = CircuitBreaker.builder("open-test-circuit")
            .failureThreshold(1) 
            .successThreshold(1) 
            .resetTimeout(Duration.ofHours(1)) // Long timeout to keep it open 
            .build(); 

        // Force circuit open by triggering failure
        when(mockDelegate.transcribe(any(), any())) 
            .thenThrow(new InferenceError("Test failure", new RuntimeException("fail"), false));
        when(mockDelegate.getActiveModel()).thenReturn(new ModelInfo("test-model", "Test", "1.0", new Locale[]{Locale.ENGLISH}, 1000L, false)); 

        CircuitBreakerSttEngine engineWithOpenCircuit = new CircuitBreakerSttEngine( 
            mockDelegate, eventloop, openCircuitBreaker
        );

        // Trigger failure to open circuit
        try {
            engineWithOpenCircuit.transcribe(createTestAudio(), TranscriptionOptions.defaults()); 
        } catch (Exception e) { 
            // Expected
        }

        // Verify circuit is open
        assertEquals(CircuitBreaker.State.OPEN, engineWithOpenCircuit.getCircuitBreakerState()); 

        // When - call while circuit is open
        TranscriptionResult result = engineWithOpenCircuit.transcribe( 
            createTestAudio(), 
            TranscriptionOptions.builder().language(Locale.ENGLISH).build() 
        );

        // Then - should return degraded result
        assertNotNull(result); 
        assertEquals("", result.text()); 
        assertEquals(0.0, result.confidence()); 
        assertTrue(result.words().isEmpty()); 
    }

    @Test
    @DisplayName("Should include circuit breaker metrics in engine metrics")
    void testCircuitBreakerMetrics() { 
        // Given
        EngineMetrics delegateMetrics = new EngineMetrics(100, 5, 50, 2, 0); 
        when(mockDelegate.getMetrics()).thenReturn(delegateMetrics); 

        // When
        EngineMetrics metrics = protectedEngine.getMetrics(); 

        // Then
        assertEquals(100, metrics.requestCount()); 
        // Errors should include both delegate errors and circuit breaker failures
        assertTrue(metrics.errorCount() >= 5); 
    }

    @Test
    @DisplayName("Should include circuit breaker state in engine status")
    void testCircuitBreakerStateInStatus() { 
        // Given
        EngineStatus delegateStatus = new EngineStatus( 
            EngineStatus.State.READY, "test-model", "1.0", 1000L, null
        );
        when(mockDelegate.getStatus()).thenReturn(delegateStatus); 
        when(mockDelegate.getActiveModel()).thenReturn(new ModelInfo("test-model", "Test", "1.0", new Locale[]{Locale.ENGLISH}, 1000L, false)); 

        // When
        EngineStatus status = protectedEngine.getStatus(); 

        // Then
        assertNotNull(status.state().name()); 
        assertTrue(status.errorMessage().contains("CLOSED"));
    }

    @Test
    @DisplayName("Should show ERROR state in status when circuit is open")
    void testErrorStateWhenCircuitOpen() throws Exception { 
        // Given - create engine with quickly opening circuit
        CircuitBreaker sensitiveBreaker = CircuitBreaker.builder("sensitive-circuit")
            .failureThreshold(1) 
            .resetTimeout(Duration.ofHours(1)) 
            .build(); 

        CircuitBreakerSttEngine engine = new CircuitBreakerSttEngine(mockDelegate, eventloop, sensitiveBreaker); 

        EngineStatus delegateStatus = new EngineStatus( 
            EngineStatus.State.READY, "test-model", "1.0", 1000L, null
        );
        when(mockDelegate.getStatus()).thenReturn(delegateStatus); 
        when(mockDelegate.getActiveModel()).thenReturn(new ModelInfo("test-model", "Test", "1.0", new Locale[]{Locale.ENGLISH}, 1000L, false)); 
        when(mockDelegate.transcribe(any(), any())) 
            .thenThrow(new InferenceError("Fail", new RuntimeException(), false)); 

        // Trigger failure
        try {
            engine.transcribe(createTestAudio(), TranscriptionOptions.defaults()); 
        } catch (Exception e) { 
            // Expected
        }

        // When
        EngineStatus status = engine.getStatus(); 

        // Then
        assertEquals(EngineStatus.State.ERROR, status.state()); 
        assertTrue(status.errorMessage().contains("OPEN"));
    }

    @Test
    @DisplayName("Should expose detailed circuit breaker metrics")
    void testDetailedCircuitBreakerMetrics() { 
        // When
        CircuitBreakerSttEngine.CircuitBreakerMetrics metrics = protectedEngine.getCircuitBreakerMetrics(); 

        // Then
        assertNotNull(metrics); 
        assertEquals("CLOSED", metrics.state()); 
        assertTrue(metrics.totalCalls() >= 0); 
    }

    @Test
    @DisplayName("Should allow manual circuit breaker reset")
    void testManualReset() throws Exception { 
        // Given - open the circuit
        CircuitBreaker breaker = CircuitBreaker.builder("reset-test-circuit")
            .failureThreshold(1) 
            .resetTimeout(Duration.ofHours(1)) 
            .build(); 

        CircuitBreakerSttEngine engine = new CircuitBreakerSttEngine(mockDelegate, eventloop, breaker); 
        when(mockDelegate.getActiveModel()).thenReturn(new ModelInfo("test-model", "Test", "1.0", new Locale[]{Locale.ENGLISH}, 1000L, false)); 
        when(mockDelegate.transcribe(any(), any())) 
            .thenThrow(new InferenceError("Fail", new RuntimeException(), false)); 

        // Open circuit
        try {
            engine.transcribe(createTestAudio(), TranscriptionOptions.defaults()); 
        } catch (Exception e) { 
            // Expected
        }

        assertEquals(CircuitBreaker.State.OPEN, engine.getCircuitBreakerState()); 

        // When - reset circuit
        engine.resetCircuitBreaker(); 

        // Then
        assertEquals(CircuitBreaker.State.CLOSED, engine.getCircuitBreakerState()); 
    }

    @Test
    @DisplayName("Should provide degraded streaming session when circuit open")
    void testDegradedStreamingSession() throws Exception { 
        // Given - circuit is open
        CircuitBreaker breaker = CircuitBreaker.builder("streaming-test-circuit")
            .failureThreshold(1) 
            .resetTimeout(Duration.ofHours(1)) 
            .build(); 

        CircuitBreakerSttEngine engine = new CircuitBreakerSttEngine(mockDelegate, eventloop, breaker); 
        when(mockDelegate.getActiveModel()).thenReturn(new ModelInfo("test-model", "Test", "1.0", new Locale[]{Locale.ENGLISH}, 1000L, false)); 
        when(mockDelegate.createStreamingSession(any())) 
            .thenThrow(new RuntimeException("Session creation failed"));

        // Open circuit
        try {
            engine.createStreamingSession(null); 
        } catch (Exception e) { 
            // Expected
        }

        // When - create session with open circuit
        StreamingSession session = engine.createStreamingSession(null); 

        // Then - should get degraded session
        assertNotNull(session); 
        assertTrue(session.isActive()); 

        // Feed audio should not throw
        session.feedAudio(new AudioChunk(new byte[100], 0, false, 16000)); 

        session.close(); 
    }

    @Test
    @DisplayName("Should delegate non-protected methods directly")
    void testDirectDelegation() { 
        // Given
        List<ModelInfo> models = List.of(new ModelInfo("m1", "Model 1", "1.0", new Locale[]{Locale.ENGLISH}, 1000L, false)); 
        when(mockDelegate.getAvailableModels()).thenReturn(models); 
        when(mockDelegate.listProfiles()).thenReturn(List.of("profile1"));

        // When & Then - these should delegate directly
        assertEquals(models, protectedEngine.getAvailableModels()); 
        assertEquals(List.of("profile1"), protectedEngine.listProfiles());

        verify(mockDelegate).getAvailableModels(); 
        verify(mockDelegate).listProfiles(); 
    }

    // Helper methods
    private AudioData createTestAudio() { 
        return new AudioData(new byte[16000], 16000, 1, 16); 
    }

    private TranscriptionResult createTestResult(String text) { 
        return new TranscriptionResult( 
            text, 0.95, List.of(), List.of(), 
            Duration.ofMillis(100), "en", "test-model" 
        );
    }
}
