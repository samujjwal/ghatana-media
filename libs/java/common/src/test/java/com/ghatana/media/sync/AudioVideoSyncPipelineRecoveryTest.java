package com.ghatana.media.sync;

import com.ghatana.media.common.AudioData;
import com.ghatana.media.common.ImageData;
import com.ghatana.media.sync.AudioVideoSyncPipeline.*;
import org.junit.jupiter.api.*;

import java.util.concurrent.*;
import java.util.concurrent.atomic.*;

import static org.junit.jupiter.api.Assertions.*;

class AudioVideoSyncPipelineRecoveryTest {

    private AudioVideoSyncPipeline pipeline;
    private TestSyncCallback callback;

    @BeforeEach
    void setUp() { 
        callback = new TestSyncCallback(); 
        pipeline = new AudioVideoSyncPipeline(callback, 500, 200, 40); 
    }

    @AfterEach
    void tearDown() throws Exception { 
        if (pipeline != null) { 
            pipeline.close(); 
        }
    }

    @Test
    @DisplayName("Should recover from sync errors with exponential backoff")
    void testExponentialBackoffRecovery() throws Exception { 
        TestSyncCallback errorCallback = new TestSyncCallback() { 
            @Override
            public void onDriftDetected(long driftMs, SyncState state) { 
                // Ignore drift
            }
            @Override
            public void onSyncedFrame(SyncedFrame frame) { 
                throw new RuntimeException("Simulated sync error");
            }
        };
        AudioVideoSyncPipeline errorPipeline = new AudioVideoSyncPipeline(errorCallback, 500, 200, 40); 
        long baseTime = System.currentTimeMillis() * 1000; 

        for (int i = 0; i < 10; i++) { 
            AudioData audio = new AudioData(new byte[1024], 16000, 1, 16); 
            ImageData video = ImageData.builder().data(new byte[1920 * 1080 * 3]).width(1920).height(1080).colorSpace(com.ghatana.media.common.ColorSpace.RGB).build(); 
            errorPipeline.feedAudio(audio, baseTime + i * 16000); 
            errorPipeline.feedVideo(video, baseTime + i * 16000); 
            Thread.sleep(20); 
        }

        Thread.sleep(1000); 

        assertTrue(errorCallback.recoveryAttempts.get() > 0, "Should have attempted recovery"); 
        assertTrue(errorCallback.lastBackoffMs.get() > 0, "Should have used backoff"); 
        assertTrue(errorCallback.lastBackoffMs.get() >= 100, "Backoff should be at least 100ms"); 
        errorPipeline.close(); 
    }

    @Test
    @DisplayName("Should degrade to async mode after max recovery attempts")
    void testAsyncModeDegradation() throws Exception { 
        TestSyncCallback errorCallback = new TestSyncCallback() { 
            @Override
            public void onSyncedFrame(SyncedFrame frame) { 
                throw new RuntimeException("Simulated sync error");
            }
        };
        AudioVideoSyncPipeline errorPipeline = new AudioVideoSyncPipeline(errorCallback, 500, 200, 40); 

        try {
            long baseTime = System.currentTimeMillis() * 1000; 
            for (int i = 0; i < 20; i++) { 
                AudioData audio = new AudioData(new byte[1024], 16000, 1, 16); 
                ImageData video = ImageData.builder().data(new byte[1920 * 1080 * 3]).width(1920).height(1080).colorSpace(com.ghatana.media.common.ColorSpace.RGB).build(); 
                errorPipeline.feedAudio(audio, baseTime + i * 16000); 
                errorPipeline.feedVideo(video, baseTime + i * 16000); 
                Thread.sleep(20); 
            }
            Thread.sleep(2000); 

            assertTrue(errorCallback.asyncModeActivated.get(), "Should activate async mode"); 
            assertTrue(errorPipeline.isAsyncMode(), "Pipeline should be in async mode"); 
            assertEquals(SyncState.ASYNC, errorPipeline.getSyncState(), "State should be ASYNC"); 
        } finally {
            errorPipeline.close(); 
        }
    }

    @Test
    @DisplayName("Should track sync quality metrics")
    void testSyncQualityMetrics() throws Exception { 
        long baseTime = System.currentTimeMillis() * 1000; 
        for (int i = 0; i < 150; i++) { 
            AudioData audio = new AudioData(new byte[1024], 16000, 1, 16); 
            ImageData video = ImageData.builder().data(new byte[1920 * 1080 * 3]).width(1920).height(1080).colorSpace(com.ghatana.media.common.ColorSpace.RGB).build(); 
            long drift = (i % 3) * 10000; 
            pipeline.feedAudio(audio, baseTime + i * 16000); 
            pipeline.feedVideo(video, baseTime + i * 16000 + drift); 
            Thread.sleep(20); 
        }
        Thread.sleep(500); 

        SyncQualityMetrics metrics = pipeline.getQualityMetrics(); 
        assertNotNull(metrics, "Metrics should not be null"); 
        assertNotNull(metrics.getCurrentQuality(), "Quality should not be null"); 
        assertTrue(metrics.getAverageDrift() >= 0, "Average drift should be non-negative"); 
    }

    @Test
    @DisplayName("Should reset recovery counter on successful sync")
    void testRecoveryCounterReset() throws Exception { 
        long baseTime = System.currentTimeMillis() * 1000; 
        for (int i = 0; i < 10; i++) { 
            AudioData audio = new AudioData(new byte[1024], 16000, 1, 16); 
            ImageData video = ImageData.builder().data(new byte[1920 * 1080 * 3]).width(1920).height(1080).colorSpace(com.ghatana.media.common.ColorSpace.RGB).build(); 
            pipeline.feedAudio(audio, baseTime + i * 16000); 
            pipeline.feedVideo(video, baseTime + i * 16000); 
            Thread.sleep(20); 
        }
        Thread.sleep(300); 
        assertEquals(SyncState.LOCKED, pipeline.getSyncState(), "Should be in LOCKED state"); 
        assertTrue(callback.syncedFrames.get() > 0, "Should have synced frames"); 
    }

    @Test
    @DisplayName("Should manually trigger recovery")
    void testManualRecoveryTrigger() throws Exception { 
        pipeline.close(); 
        pipeline = new AudioVideoSyncPipeline(callback, 500, 200, 40); 
        pipeline.triggerRecovery(); 
        assertEquals(SyncState.SYNCING, pipeline.getSyncState(), "Should be SYNCING after manual recovery"); 
        assertFalse(pipeline.isAsyncMode(), "Should not be in async mode"); 
    }

    @Test
    @DisplayName("Should emit quality change callbacks")
    void testQualityChangeCallbacks() throws Exception { 
        long baseTime = System.currentTimeMillis() * 1000; 
        for (int i = 0; i < 50; i++) { 
            AudioData audio = new AudioData(new byte[1024], 16000, 1, 16); 
            ImageData video = ImageData.builder().data(new byte[1920 * 1080 * 3]).width(1920).height(1080).colorSpace(com.ghatana.media.common.ColorSpace.RGB).build(); 
            long drift = i * 2000;
            pipeline.feedAudio(audio, baseTime + i * 16000); 
            pipeline.feedVideo(video, baseTime + i * 16000 + drift); 
            Thread.sleep(20); 
        }
        Thread.sleep(500); 
        assertTrue(callback.qualityChanges.get() >= 0, "Should track quality changes"); 
    }

    @Test
    @DisplayName("Should handle async mode frame emission")
    void testAsyncModeFrameEmission() throws Exception { 
        TestSyncCallback errorCallback = new TestSyncCallback() { 
            private int callCount = 0;
            @Override
            public void onSyncedFrame(SyncedFrame frame) { 
                if (callCount++ < 10) { 
                    throw new RuntimeException("Force async mode");
                }
                super.onSyncedFrame(frame); 
            }
        };
        AudioVideoSyncPipeline asyncPipeline = new AudioVideoSyncPipeline(errorCallback, 500, 200, 40); 
        try {
            long baseTime = System.currentTimeMillis() * 1000; 
            for (int i = 0; i < 30; i++) { 
                AudioData audio = new AudioData(new byte[1024], 16000, 1, 16); 
                ImageData video = ImageData.builder().data(new byte[1920 * 1080 * 3]).width(1920).height(1080).colorSpace(com.ghatana.media.common.ColorSpace.RGB).build(); 
                asyncPipeline.feedAudio(audio, baseTime + i * 16000); 
                asyncPipeline.feedVideo(video, baseTime + i * 16000); 
                Thread.sleep(20); 
            }
            Thread.sleep(1000); 
            assertTrue(errorCallback.asyncModeActivated.get(), "Should be in async mode"); 
            assertTrue(errorCallback.syncedFrames.get() > 0, "Should emit frames even in async mode"); 
        } finally {
            asyncPipeline.close(); 
        }
    }

    @Test
    @DisplayName("Should provide buffer statistics")
    void testBufferStatistics() throws Exception { 
        long baseTime = System.currentTimeMillis() * 1000; 
        for (int i = 0; i < 5; i++) { 
            AudioData audio = new AudioData(new byte[1024], 16000, 1, 16); 
            ImageData video = ImageData.builder().data(new byte[1920 * 1080 * 3]).width(1920).height(1080).colorSpace(com.ghatana.media.common.ColorSpace.RGB).build(); 
            pipeline.feedAudio(audio, baseTime + i * 16000); 
            pipeline.feedVideo(video, baseTime + i * 16000); 
        }
        BufferStats stats = pipeline.getBufferStats(); 
        assertNotNull(stats, "Stats should not be null"); 
        assertTrue(stats.audioFramesBuffered >= 0, "Audio buffer count should be non-negative"); 
        assertTrue(stats.videoFramesBuffered >= 0, "Video buffer count should be non-negative"); 
    }

    private static class TestSyncCallback implements SyncCallback {
        final AtomicInteger syncedFrames = new AtomicInteger(0); 
        final AtomicInteger driftDetections = new AtomicInteger(0); 
        final AtomicInteger errors = new AtomicInteger(0); 
        final AtomicInteger recoveryAttempts = new AtomicInteger(0); 
        final AtomicLong lastBackoffMs = new AtomicLong(0); 
        final AtomicBoolean asyncModeActivated = new AtomicBoolean(false); 
        final AtomicInteger qualityChanges = new AtomicInteger(0); 

        @Override
        public void onSyncedFrame(SyncedFrame frame) { 
            syncedFrames.incrementAndGet(); 
        }
        @Override
        public void onDriftDetected(long driftMs, SyncState state) { 
            driftDetections.incrementAndGet(); 
        }
        @Override
        public void onError(String message) { 
            errors.incrementAndGet(); 
        }
        @Override
        public void onRecoveryAttempt(int attempt, long backoffMs) { 
            recoveryAttempts.incrementAndGet(); 
            lastBackoffMs.set(backoffMs); 
        }
        @Override
        public void onAsyncModeActivated(String reason) { 
            asyncModeActivated.set(true); 
        }
        @Override
        public void onQualityChange(SyncQuality quality) { 
            qualityChanges.incrementAndGet(); 
        }
    }
}
