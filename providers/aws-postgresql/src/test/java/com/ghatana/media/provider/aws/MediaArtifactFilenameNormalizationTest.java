package com.ghatana.media.provider.aws;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaArtifactFilenameNormalizationTest {
    @Test
    void stripsUnixAndWindowsDirectoryComponentsOnAnyHost() {
        assertThat(S3PostgresqlMediaArtifactStore.safeFileName("../../private/clip.mp4"))
                .isEqualTo("clip.mp4");
        assertThat(S3PostgresqlMediaArtifactStore.safeFileName("C:\\private\\clip.mp4"))
                .isEqualTo("clip.mp4");
        assertThat(S3PostgresqlMediaArtifactStore.safeFileName("..\\..\\private/clip.mp4"))
                .isEqualTo("clip.mp4");
    }

    @Test
    void replacesLineBreaksInTheStoredLeafName() {
        assertThat(S3PostgresqlMediaArtifactStore.safeFileName("folder\\clip\r\n.mp4"))
                .isEqualTo("clip__.mp4");
    }

    @Test
    void rejectsNamesWithoutAUsableLeaf() {
        assertThatThrownBy(() -> S3PostgresqlMediaArtifactStore.safeFileName("///"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("fileName is invalid");
        assertThatThrownBy(() -> S3PostgresqlMediaArtifactStore.safeFileName("  "))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("fileName is invalid");
    }
}
