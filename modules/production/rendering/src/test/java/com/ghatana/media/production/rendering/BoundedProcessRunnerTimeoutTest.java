package com.ghatana.media.production.rendering;

import static org.assertj.core.api.Assertions.assertThat;

import java.nio.file.Path;
import java.time.Duration;
import java.util.List;
import java.util.Map;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

class BoundedProcessRunnerTimeoutTest {
    @TempDir Path temp;

    @Test
    void acceptsPositiveTimeoutLongerThanNanosecondRangeWithoutLeakingStartedChild() throws Exception {
        var result = BoundedProcessRunner.run(List.of("/bin/sleep", "0.2"), temp, Map.of(),
                Duration.ofSeconds(Long.MAX_VALUE), 0, 0, BoundedProcessRunner.CancellationToken.NEVER, null, 0);

        assertThat(result.end()).isEqualTo(BoundedProcessRunner.End.EXITED);
        assertThat(result.exitCode()).isZero();
    }

    @Test
    void enforcesShortTimeoutForLongRunningChild() throws Exception {
        var result = BoundedProcessRunner.run(List.of("/bin/sleep", "2"), temp, Map.of(),
                Duration.ofMillis(50), 0, 0, BoundedProcessRunner.CancellationToken.NEVER, null, 0);

        assertThat(result.end()).isEqualTo(BoundedProcessRunner.End.TIMED_OUT);
    }
}
