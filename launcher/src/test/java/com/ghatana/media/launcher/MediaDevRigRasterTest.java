package com.ghatana.media.launcher;

import com.ghatana.media.production.spatial.SpatialRigEngine.Quaternion;
import com.ghatana.media.production.spatial.SpatialRigEngine.Vec3;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/** The software rasterizer against analytic projections, z-buffer occlusion and bit-exact determinism. */
class MediaDevRigRasterTest {
    private static final int W = 320;
    private static final int H = 240;
    private static final double FOV = Math.toRadians(45);
    private static final double FOCAL = H / (2 * Math.tan(FOV / 2));
    private static final int BG = 0x101828;

    private static MediaDevRigRaster raster(Vec3 position, Vec3 target, MediaDevRigRaster.Floor floor) {
        Quaternion orientation = MediaDevRigSpec.lookAt(position, target);
        return new MediaDevRigRaster(new MediaDevRigRaster.Camera(position, orientation, FOV, 0.1, 50, W, H), BG, floor);
    }

    private static int pixel(byte[] rgb, int x, int y) {
        int i = (y * W + x) * 3;
        return ((rgb[i] & 0xff) << 16) | ((rgb[i + 1] & 0xff) << 8) | (rgb[i + 2] & 0xff);
    }

    @Test
    void capsuleSilhouetteMatchesTheAnalyticSphereProjection() {
        MediaDevRigRaster raster = raster(new Vec3(0, 0, 3), new Vec3(0, 0, 0), null);
        byte[] frame = raster.render(List.of(new MediaDevRigRaster.Capsule(new Vec3(-0.5, 0, 0), new Vec3(0.5, 0, 0), 0.1,
                0xFF8040)), null);
        int row = H / 2;
        int left = -1;
        int right = -1;
        for (int x = 0; x < W; x++) {
            if (pixel(frame, x, row) != BG) {
                if (left < 0) left = x;
                right = x;
            }
        }
        double dist = Math.sqrt(0.25 + 9);
        double expectedRight = W / 2.0 + FOCAL * Math.tan(Math.atan2(0.5, 3) + Math.asin(0.1 / dist));
        double expectedLeft = W / 2.0 - FOCAL * Math.tan(Math.atan2(0.5, 3) + Math.asin(0.1 / dist));
        assertThat((double) right + 1).isBetween(expectedRight - 1.0, expectedRight + 1.0);
        assertThat((double) left).isBetween(expectedLeft - 1.0, expectedLeft + 1.0);
        // body height: silhouette half-height at the centre is f * r / depth (depth 3 - 0.1 front surface is irrelevant to the
        // tangent: the cylinder's silhouette tangent distance is sqrt(d^2 - r^2))
        int top = -1;
        int bottom = -1;
        for (int y = 0; y < H; y++) {
            if (pixel(frame, W / 2, y) != BG) {
                if (top < 0) top = y;
                bottom = y;
            }
        }
        double half = FOCAL * Math.tan(Math.asin(0.1 / 3.0));
        assertThat((double) (bottom + 1 - top)).isBetween(2 * half - 1.5, 2 * half + 1.5);
    }

    @Test
    void zBufferHidesGeometryBehindTheFloorAndShowsGeometryInFront() {
        MediaDevRigRaster.Floor floor = new MediaDevRigRaster.Floor(0.0, 3.0, 6, 0x808080, 0x404040, null);
        MediaDevRigRaster raster = raster(new Vec3(0, 2, 3), new Vec3(0, 0, 0), floor);
        byte[] bare = raster.render(List.of(), null);
        Vec3 centre = new Vec3(0, 0.3, 0);
        byte[] above = raster.render(List.of(new MediaDevRigRaster.Capsule(centre, new Vec3(0.2, 0.3, 0), 0.1, 0xFF0000)), null);
        byte[] below = raster.render(List.of(new MediaDevRigRaster.Capsule(new Vec3(0, -0.6, 0), new Vec3(0.2, -0.6, 0), 0.1,
                0xFF0000)), null);
        assertThat(below).as("a capsule fully below the floor plane is occluded by the floor").isEqualTo(bare);
        assertThat(above).isNotEqualTo(bare);
        // the floor itself: both tile colours appear, shaded by ambient + diffuse * (n . L) with n = +Y
        java.util.Set<Integer> colours = new java.util.HashSet<>();
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) colours.add(pixel(bare, x, y));
        assertThat(colours).contains(BG);
        double shade = MediaDevRigRaster.AMBIENT + MediaDevRigRaster.DIFFUSE * (0.8 / Math.sqrt(0.16 + 0.64 + 0.36));
        int light = (int) Math.round(0x80 * shade);
        int dark = (int) Math.round(0x40 * shade);
        assertThat(colours).contains((light << 16) | (light << 8) | light, (dark << 16) | (dark << 8) | dark);
    }

    @Test
    void floorTrianglesAreClippedAtTheNearPlaneInsteadOfDisappearing() {
        // camera inside the floor extent, floor tiles straddle the near plane
        MediaDevRigRaster.Floor floor = new MediaDevRigRaster.Floor(-1.0, 4.0, 8, 0x808080, 0x404040, null);
        MediaDevRigRaster raster = raster(new Vec3(0, 0, 0), new Vec3(0, -0.3, -3), floor);
        byte[] frame = raster.render(List.of(), null);
        int floorPixels = 0;
        for (int y = 0; y < H; y++) for (int x = 0; x < W; x++) if (pixel(frame, x, y) != BG) floorPixels++;
        assertThat(floorPixels).isGreaterThan(W * H / 4);
    }

    @Test
    void markerDiscIsCentredOnItsExactProjectedPositionAndIsNeverOccluded() {
        MediaDevRigRaster raster = raster(new Vec3(0, 0, 3), new Vec3(0, 0, 0), null);
        double mx = 150.37;
        double my = 101.81;
        byte[] frame = raster.render(List.of(new MediaDevRigRaster.Capsule(new Vec3(-1, 0.4, 0.5), new Vec3(1, 0.4, 0.5), 0.5,
                0x00FF00)), new MediaDevRigRaster.Marker(mx, my, 6.5, 0xFF00FF));
        double sx = 0;
        double sy = 0;
        int n = 0;
        for (int y = 0; y < H; y++) {
            for (int x = 0; x < W; x++) {
                if (pixel(frame, x, y) == 0xFF00FF) { sx += x + 0.5; sy += y + 0.5; n++; }
            }
        }
        assertThat(n).isBetween((int) (Math.PI * 6.5 * 6.5 * 0.95), (int) (Math.PI * 6.5 * 6.5 * 1.05));
        assertThat(sx / n).isEqualTo(mx, org.assertj.core.data.Offset.offset(0.1));
        assertThat(sy / n).isEqualTo(my, org.assertj.core.data.Offset.offset(0.1));
    }

    @Test
    void renderingIsBitExactAcrossRepeatedRuns() {
        MediaDevRigRaster.Floor floor = new MediaDevRigRaster.Floor(-0.5, 3.0, 8, 0x909090, 0x303030, null);
        List<MediaDevRigRaster.Capsule> capsules = List.of(
                new MediaDevRigRaster.Capsule(new Vec3(0, 0, 0), new Vec3(0.6, 0.2, 0.1), 0.05, 0x4080FF),
                new MediaDevRigRaster.Capsule(new Vec3(0.6, 0.2, 0.1), new Vec3(1.0, 0.7, 0.3), 0.04, 0xFFC040));
        byte[] first = raster(new Vec3(0.4, 1.0, 3), new Vec3(0.3, 0.2, 0), floor).render(capsules, null);
        byte[] second = raster(new Vec3(0.4, 1.0, 3), new Vec3(0.3, 0.2, 0), floor).render(capsules, null);
        assertThat(second).isEqualTo(first);
    }
}
