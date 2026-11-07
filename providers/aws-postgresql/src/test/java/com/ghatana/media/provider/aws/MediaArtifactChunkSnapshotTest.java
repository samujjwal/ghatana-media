package com.ghatana.media.provider.aws;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class MediaArtifactChunkSnapshotTest {
    @Test
    void chunkSnapshotDoesNotRetainCallerOwnedMutableBytes() {
        byte[] callerBytes = new byte[] {1, 2, 3};
        byte[] expectedSnapshot = callerBytes.clone();

        byte[] snapshot = S3PostgresqlMediaArtifactStore.snapshotChunk(callerBytes);
        callerBytes[0] = 9;

        assertThat(snapshot)
                .isNotSameAs(callerBytes)
                .containsExactly(expectedSnapshot);
    }
}
