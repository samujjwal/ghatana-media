package com.ghatana.audio.video.vision.video;

import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;

import java.io.IOException;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** Local daemon-side source-root preflight checks; no external broker identity is needed. */
class MediaOciBrokerSourceRootTest {
    @Test
    void sourceRootMustBePinnedToWorkerIdentityAndSharedMode(@TempDir Path temp) throws Exception {
        Path sourceRoot = Files.createDirectory(temp.resolve("sources"));
        long uid = ((Number) Files.getAttribute(sourceRoot, "unix:uid")).longValue();
        long gid = ((Number) Files.getAttribute(sourceRoot, "unix:gid")).longValue();
        Files.setAttribute(sourceRoot, "unix:mode", 02750);

        assertThat(MediaOciBrokerDaemon.validateSharedSourceRoot(sourceRoot, uid, gid))
                .isEqualTo(sourceRoot.toRealPath());
        assertThatThrownBy(() -> MediaOciBrokerDaemon.validateSharedSourceRoot(sourceRoot, uid + 1, gid))
                .isInstanceOf(IOException.class).hasMessageContaining("worker-owned");
        assertThatThrownBy(() -> MediaOciBrokerDaemon.validateSharedSourceRoot(sourceRoot, uid, gid + 1))
                .isInstanceOf(IOException.class).hasMessageContaining("worker-owned");

        Files.setAttribute(sourceRoot, "unix:mode", 0770);
        assertThatThrownBy(() -> MediaOciBrokerDaemon.validateSharedSourceRoot(sourceRoot, uid, gid))
                .isInstanceOf(IOException.class).hasMessageContaining("mode 02750");

        Path alias = temp.resolve("source-alias");
        Files.createSymbolicLink(alias, sourceRoot);
        assertThatThrownBy(() -> MediaOciBrokerDaemon.validateSharedSourceRoot(alias, uid, gid))
                .isInstanceOf(IOException.class).hasMessageContaining("real worker-owned directory");
    }
}
