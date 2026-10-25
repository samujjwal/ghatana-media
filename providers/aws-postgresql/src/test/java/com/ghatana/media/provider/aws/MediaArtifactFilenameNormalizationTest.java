package com.ghatana.media.provider.aws;

import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class MediaArtifactFilenameNormalizationTest {
    @Test
    void rejectsUnixAndWindowsDirectoryComponentsOnAnyHost() {
        for (String input : new String[] {
                "../../private/clip.mp4", "C:\\private\\clip.mp4", "..\\..\\private/clip.mp4",
                "folder/clip.mp4", "folder\\clip.mp4", "C:clip.mp4", ".", ".."}) {
            assertThatThrownBy(() -> S3PostgresqlMediaArtifactStore.safeFileName(input))
                    .as("reject path-like filename %s", input)
                    .isInstanceOf(IllegalArgumentException.class)
                    .hasMessage("fileName must be a plain file name without path components");
        }
    }

    @Test
    void replacesLineBreaksInTheStoredLeafName() {
        assertThat(S3PostgresqlMediaArtifactStore.safeFileName("clip\r\nfinal.mp4"))
                .isEqualTo("clip__final.mp4");
        assertThat(S3PostgresqlMediaArtifactStore.safeFileName("  clip.mp4  "))
                .isEqualTo("clip.mp4");
    }

    @Test
    void rejectsNamesWithoutAUsableLeaf() {
        assertThatThrownBy(() -> S3PostgresqlMediaArtifactStore.safeFileName("///"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("fileName must be a plain file name without path components");
        assertThatThrownBy(() -> S3PostgresqlMediaArtifactStore.safeFileName("  "))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("fileName is required");
        assertThatThrownBy(() -> S3PostgresqlMediaArtifactStore.safeFileName("cli\0p.mp4"))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("fileName must be a plain file name without path components");
    }
}
