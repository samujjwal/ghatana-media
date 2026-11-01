package com.ghatana.media.service;

import com.ghatana.media.common.pool.EnginePool;
import com.ghatana.media.stt.api.SttEngine;
import com.ghatana.media.tts.api.TtsEngine;
import java.time.Duration;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.Mockito.mock;

class AudioVideoServiceRegistryLeaseTest {
    @AfterEach void resetRegistry() { AudioVideoServiceRegistry.reset(); }

    @Test
    void registryExposesProtectedSttAndTtsLeases() throws Exception {
        var config = EnginePool.PoolConfig.defaults().minSize(0).maxSize(1)
                .borrowTimeout(Duration.ofSeconds(1));
        var sttPool = new EnginePool<>(() -> mock(SttEngine.class), engine -> true, engine -> null, config);
        var ttsPool = new EnginePool<>(() -> mock(TtsEngine.class), engine -> true, engine -> null, config);
        var registry = AudioVideoServiceRegistry.getInstance();
        registry.registerSttPool("stt", sttPool);
        registry.registerTtsPool("tts", ttsPool);
        try (var stt = registry.borrowSttEngineLease("stt"); var tts = registry.borrowTtsEngineLease("tts")) {
            assertThat(stt.engine()).isNotNull();
            assertThat(tts.engine()).isNotNull();
            assertThatThrownBy(() -> registry.returnSttEngine("stt", stt.engine()))
                    .isInstanceOf(IllegalStateException.class);
            assertThatThrownBy(() -> registry.returnTtsEngine("tts", tts.engine()))
                    .isInstanceOf(IllegalStateException.class);
        }
        assertThat(sttPool.getStats().inUse).isZero();
        assertThat(ttsPool.getStats().inUse).isZero();
    }
}
