package com.ghatana.media.launcher;

import com.ghatana.media.production.spatial.SpatialRigEngine;

import javax.imageio.ImageIO;
import java.awt.image.BufferedImage;
import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.util.ArrayList;
import java.util.List;

/**
 * Pre-encode frames of a rig render spec, produced in-process by exactly the code the launcher uses (same parser,
 * same forward kinematics, same rasterizer). Tests use it to compare a launcher's stored video and manifest digests
 * with an independently run render (determinism across processes) and to measure PSNR against the pre-encode frames.
 */
public final class MediaDevRigFrames {
    private MediaDevRigFrames() { }

    /** RGB24 frames (row 0 first) and the frame-set digest; {@code floorTexturePng} is null without a textured floor. */
    public record Result(List<byte[]> rgb24Frames, String frameSetSha256) { }

    public static Result render(String tenantId, Object spec, byte[] floorTexturePng) throws IOException {
        MediaDevRigSpec.Parsed parsed = MediaDevRigSpec.parse(tenantId, spec);
        MediaDevRigRaster.Texture texture = null;
        if (floorTexturePng != null) {
            BufferedImage image = ImageIO.read(new ByteArrayInputStream(floorTexturePng));
            texture = new MediaDevRigRaster.Texture(image.getWidth(), image.getHeight(),
                    image.getRGB(0, 0, image.getWidth(), image.getHeight(), null, 0, image.getWidth()));
        }
        ByteArrayOutputStream sink = new ByteArrayOutputStream();
        String frameSet = MediaDevRigRuntime.rasterize(new SpatialRigEngine(), parsed.rig(tenantId, "in-process"), parsed,
                texture, sink, new ArrayList<>());
        byte[] all = sink.toByteArray();
        int frameBytes = parsed.width() * parsed.height() * 3;
        List<byte[]> frames = new ArrayList<>();
        for (int i = 0; i < parsed.frameCount(); i++) frames.add(java.util.Arrays.copyOfRange(all, i * frameBytes, (i + 1) * frameBytes));
        return new Result(List.copyOf(frames), frameSet);
    }
}
