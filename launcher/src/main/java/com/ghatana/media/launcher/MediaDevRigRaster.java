package com.ghatana.media.launcher;

import com.ghatana.media.production.spatial.SpatialRigEngine.Quaternion;
import com.ghatana.media.production.spatial.SpatialRigEngine.Vec3;

import java.util.ArrayList;
import java.util.List;

/**
 * Deterministic CPU software rasterizer for the DEV_ONLY rig render: a perspective pinhole camera (looking along its
 * local -Z, +Y up, right-handed, metres), a z-buffer, flat-shaded textured floor triangles (near-plane clipped,
 * perspective-correct depth and texture coordinates) and analytically ray-cast capsules (one per bone) shaded with
 * one fixed directional light. The end effector is drawn last as a flat disc overlay centred on its exact projected
 * position (it is a measurement marker, not scene geometry, so it is never occluded by the arm). Pixels are sampled
 * at their centres, there is no antialiasing, no GPU and no external renderer; the same inputs always give the same
 * bytes (all arithmetic is IEEE double with {@link StrictMath} transcendentals).
 *
 * <p>Depth is the distance along the camera's forward axis (what a z-buffer stores), identical for the triangle and
 * the ray-cast paths so they occlude one another correctly.</p>
 */
final class MediaDevRigRaster {
    static final double AMBIENT = 0.35;
    static final double DIFFUSE = 0.65;
    private static final Vec3 LIGHT = new Vec3(0.4, 0.8, 0.6).normalized();

    record Capsule(Vec3 a, Vec3 b, double radius, int rgb) { }

    /** Disc overlay in pixel coordinates (pixel-centre coordinates: pixel i covers [i, i + 1)). */
    record Marker(double x, double y, double radiusPixels, int rgb) { }

    record Texture(int width, int height, int[] argb) { }

    record Floor(double y, double halfExtent, int tiles, int rgbA, int rgbB, Texture texture) { }

    record Camera(Vec3 position, Quaternion orientation, double verticalFovRadians, double near, double far,
                  int width, int height) { }

    private final Camera camera;
    private final Vec3 right;
    private final Vec3 up;
    private final Vec3 forward;
    private final double focal;
    private final int width;
    private final int height;
    private final int backgroundRgb;
    private final Floor floor;

    MediaDevRigRaster(Camera camera, int backgroundRgb, Floor floor) {
        this.camera = camera;
        this.width = camera.width();
        this.height = camera.height();
        this.backgroundRgb = backgroundRgb;
        this.floor = floor;
        this.right = camera.orientation().rotate(new Vec3(1, 0, 0));
        this.up = camera.orientation().rotate(new Vec3(0, 1, 0));
        this.forward = camera.orientation().rotate(new Vec3(0, 0, -1));
        this.focal = height / (2.0 * StrictMath.tan(camera.verticalFovRadians() / 2.0));
    }

    /** Renders one frame to tightly packed RGB24 (row 0 is the top row). */
    byte[] render(List<Capsule> capsules, Marker marker) {
        double[] depth = new double[width * height];
        java.util.Arrays.fill(depth, Double.POSITIVE_INFINITY);
        byte[] rgb = new byte[width * height * 3];
        for (int i = 0; i < width * height; i++) put(rgb, i, backgroundRgb);
        if (floor != null) drawFloor(rgb, depth);
        for (Capsule capsule : capsules) drawCapsule(rgb, depth, capsule);
        if (marker != null) drawMarker(rgb, marker);
        return rgb;
    }

    // ------------------------------------------------------------------ capsules (ray cast)

    private void drawCapsule(byte[] rgb, double[] depth, Capsule capsule) {
        Vec3 a = capsule.a();
        Vec3 b = capsule.b();
        Vec3 mid = new Vec3((a.x() + b.x()) / 2, (a.y() + b.y()) / 2, (a.z() + b.z()) / 2);
        double bound = b.subtract(a).length() / 2 + capsule.radius();
        Vec3 rel = mid.subtract(camera.position());
        double xc = rel.dot(right);
        double yc = rel.dot(up);
        double zc = rel.dot(forward);
        int x0 = 0;
        int x1 = width - 1;
        int y0 = 0;
        int y1 = height - 1;
        if (zc - bound > camera.near()) {
            // conservative screen rectangle of the bounding sphere
            double nearZ = zc - bound;
            double farZ = zc + bound;
            double hi = xc + bound >= 0 ? (xc + bound) / nearZ : (xc + bound) / farZ;
            double lo = xc - bound <= 0 ? (xc - bound) / nearZ : (xc - bound) / farZ;
            x0 = Math.max(0, (int) Math.floor(width / 2.0 + focal * lo) - 1);
            x1 = Math.min(width - 1, (int) Math.ceil(width / 2.0 + focal * hi) + 1);
            double yHi = yc + bound >= 0 ? (yc + bound) / nearZ : (yc + bound) / farZ;
            double yLo = yc - bound <= 0 ? (yc - bound) / nearZ : (yc - bound) / farZ;
            y0 = Math.max(0, (int) Math.floor(height / 2.0 - focal * yHi) - 1);
            y1 = Math.min(height - 1, (int) Math.ceil(height / 2.0 - focal * yLo) + 1);
        } else if (zc + bound < camera.near()) {
            return;
        }
        Vec3 o = camera.position();
        Vec3 ba = b.subtract(a);
        Vec3 oa = o.subtract(a);
        double baba = ba.dot(ba);
        double baoa = ba.dot(oa);
        double oaoa = oa.dot(oa);
        double r2 = capsule.radius() * capsule.radius();
        Vec3 ob = o.subtract(b);
        for (int py = y0; py <= y1; py++) {
            double v = -(py + 0.5 - height / 2.0) / focal;
            for (int px = x0; px <= x1; px++) {
                double u = (px + 0.5 - width / 2.0) / focal;
                Vec3 d = new Vec3(forward.x() + right.x() * u + up.x() * v, forward.y() + right.y() * u + up.y() * v,
                        forward.z() + right.z() * u + up.z() * v);
                double dd = d.dot(d);
                double t = Double.POSITIVE_INFINITY;
                double bard = ba.dot(d);
                double rdoa = d.dot(oa);
                double qa = baba * dd - bard * bard;
                if (qa > 1e-12) {
                    double qb = baba * rdoa - baoa * bard;
                    double qc = baba * oaoa - baoa * baoa - r2 * baba;
                    double h = qb * qb - qa * qc;
                    if (h >= 0) {
                        double hit = (-qb - StrictMath.sqrt(h)) / qa;
                        double y = baoa + hit * bard;
                        if (hit > 0 && y > 0 && y < baba) t = hit;
                    }
                }
                t = Math.min(t, sphere(oa, d, dd, r2));
                t = Math.min(t, sphere(ob, d, dd, r2));
                if (!(t < Double.POSITIVE_INFINITY)) continue;
                // t is the depth along the forward axis because d . forward == 1
                if (t < camera.near() || t > camera.far()) continue;
                int index = py * width + px;
                if (t >= depth[index]) continue;
                depth[index] = t;
                Vec3 p = new Vec3(o.x() + d.x() * t, o.y() + d.y() * t, o.z() + d.z() * t);
                double along = Math.max(0, Math.min(1, p.subtract(a).dot(ba) / baba));
                Vec3 closest = new Vec3(a.x() + ba.x() * along, a.y() + ba.y() * along, a.z() + ba.z() * along);
                Vec3 normal = p.subtract(closest).scale(1.0 / capsule.radius());
                put(rgb, index, shade(capsule.rgb(), normal.dot(LIGHT)));
            }
        }
    }

    private static double sphere(Vec3 oc, Vec3 d, double dd, double r2) {
        double b = d.dot(oc);
        double c = oc.dot(oc) - r2;
        double h = b * b - dd * c;
        if (h < 0) return Double.POSITIVE_INFINITY;
        double t = (-b - StrictMath.sqrt(h)) / dd;
        return t > 0 ? t : Double.POSITIVE_INFINITY;
    }

    // ------------------------------------------------------------------ floor (z-buffered triangles)

    private record Vertex(double x, double y, double z, double u, double v) { }

    private void drawFloor(byte[] rgb, double[] depth) {
        int n = floor.tiles();
        double step = 2 * floor.halfExtent() / n;
        for (int i = 0; i < n; i++) {
            for (int j = 0; j < n; j++) {
                double xa = -floor.halfExtent() + i * step;
                double za = -floor.halfExtent() + j * step;
                double xb = xa + step;
                double zb = za + step;
                double y = floor.y();
                Vertex v00 = new Vertex(xa, y, za, 0, 0);
                Vertex v10 = new Vertex(xb, y, za, 1, 0);
                Vertex v11 = new Vertex(xb, y, zb, 1, 1);
                Vertex v01 = new Vertex(xa, y, zb, 0, 1);
                boolean parity = ((i + j) & 1) == 0;
                triangle(rgb, depth, v00, v10, v11, parity);
                triangle(rgb, depth, v00, v11, v01, parity);
            }
        }
    }

    /** Screen-space vertex: pixel coordinates, 1/depth and u/depth, v/depth. */
    private record Screen(double sx, double sy, double invZ, double uOverZ, double vOverZ) { }

    private void triangle(byte[] rgb, double[] depth, Vertex p0, Vertex p1, Vertex p2, boolean parity) {
        // camera space: x right, y up, z = depth along forward
        List<double[]> polygon = new ArrayList<>(4);
        for (Vertex v : new Vertex[] {p0, p1, p2}) {
            Vec3 rel = new Vec3(v.x() - camera.position().x(), v.y() - camera.position().y(), v.z() - camera.position().z());
            polygon.add(new double[] {rel.dot(right), rel.dot(up), rel.dot(forward), v.u(), v.v()});
        }
        List<double[]> clipped = clipNear(polygon, camera.near());
        if (clipped.size() < 3) return;
        List<Screen> screen = new ArrayList<>(clipped.size());
        for (double[] c : clipped) {
            double inv = 1.0 / c[2];
            screen.add(new Screen(width / 2.0 + focal * c[0] * inv, height / 2.0 - focal * c[1] * inv, inv, c[3] * inv,
                    c[4] * inv));
        }
        double tint = parity ? 1.0 : 0.62;
        double shade = AMBIENT + DIFFUSE * Math.max(0, LIGHT.y()); // the floor normal is +Y
        for (int k = 1; k + 1 < screen.size(); k++) fill(rgb, depth, screen.get(0), screen.get(k), screen.get(k + 1), tint, shade);
    }

    private static List<double[]> clipNear(List<double[]> polygon, double near) {
        List<double[]> out = new ArrayList<>();
        for (int i = 0; i < polygon.size(); i++) {
            double[] current = polygon.get(i);
            double[] next = polygon.get((i + 1) % polygon.size());
            boolean currentIn = current[2] >= near;
            boolean nextIn = next[2] >= near;
            if (currentIn) out.add(current);
            if (currentIn != nextIn) {
                double t = (near - current[2]) / (next[2] - current[2]);
                double[] cut = new double[5];
                for (int c = 0; c < 5; c++) cut[c] = current[c] + (next[c] - current[c]) * t;
                cut[2] = near;
                out.add(cut);
            }
        }
        return out;
    }

    private void fill(byte[] rgb, double[] depth, Screen a, Screen b, Screen c, double tint, double shade) {
        double area = edge(a.sx(), a.sy(), b.sx(), b.sy(), c.sx(), c.sy());
        if (Math.abs(area) < 1e-12) return;
        int x0 = Math.max(0, (int) Math.floor(Math.min(a.sx(), Math.min(b.sx(), c.sx()))));
        int x1 = Math.min(width - 1, (int) Math.ceil(Math.max(a.sx(), Math.max(b.sx(), c.sx()))));
        int y0 = Math.max(0, (int) Math.floor(Math.min(a.sy(), Math.min(b.sy(), c.sy()))));
        int y1 = Math.min(height - 1, (int) Math.ceil(Math.max(a.sy(), Math.max(b.sy(), c.sy()))));
        for (int py = y0; py <= y1; py++) {
            for (int px = x0; px <= x1; px++) {
                double sx = px + 0.5;
                double sy = py + 0.5;
                double w0 = edge(b.sx(), b.sy(), c.sx(), c.sy(), sx, sy) / area;
                double w1 = edge(c.sx(), c.sy(), a.sx(), a.sy(), sx, sy) / area;
                double w2 = edge(a.sx(), a.sy(), b.sx(), b.sy(), sx, sy) / area;
                if (w0 < 0 || w1 < 0 || w2 < 0) continue;
                double invZ = w0 * a.invZ() + w1 * b.invZ() + w2 * c.invZ();
                double z = 1.0 / invZ;
                if (z < camera.near() || z > camera.far()) continue;
                int index = py * width + px;
                if (z >= depth[index]) continue;
                depth[index] = z;
                int base;
                if (floor.texture() != null) {
                    double u = (w0 * a.uOverZ() + w1 * b.uOverZ() + w2 * c.uOverZ()) / invZ;
                    double v = (w0 * a.vOverZ() + w1 * b.vOverZ() + w2 * c.vOverZ()) / invZ;
                    Texture t = floor.texture();
                    int tx = Math.max(0, Math.min(t.width() - 1, (int) Math.floor(u * t.width())));
                    int ty = Math.max(0, Math.min(t.height() - 1, (int) Math.floor(v * t.height())));
                    base = t.argb()[ty * t.width() + tx] & 0xffffff;
                } else {
                    base = tint == 1.0 ? floor.rgbA() : floor.rgbB();
                }
                put(rgb, index, scale(base, floor.texture() != null ? shade * tint : shade));
            }
        }
    }

    private static double edge(double ax, double ay, double bx, double by, double cx, double cy) {
        return (cx - ax) * (by - ay) - (cy - ay) * (bx - ax);
    }

    // ------------------------------------------------------------------ marker overlay and colour helpers

    private void drawMarker(byte[] rgb, Marker marker) {
        double r = marker.radiusPixels();
        int x0 = Math.max(0, (int) Math.floor(marker.x() - r) - 1);
        int x1 = Math.min(width - 1, (int) Math.ceil(marker.x() + r) + 1);
        int y0 = Math.max(0, (int) Math.floor(marker.y() - r) - 1);
        int y1 = Math.min(height - 1, (int) Math.ceil(marker.y() + r) + 1);
        for (int py = y0; py <= y1; py++) {
            for (int px = x0; px <= x1; px++) {
                double dx = px + 0.5 - marker.x();
                double dy = py + 0.5 - marker.y();
                if (dx * dx + dy * dy <= r * r) put(rgb, py * width + px, marker.rgb());
            }
        }
    }

    private static int shade(int rgb, double lambert) {
        return scale(rgb, AMBIENT + DIFFUSE * Math.max(0, lambert));
    }

    private static int scale(int rgb, double factor) {
        int r = clamp((int) Math.round(((rgb >> 16) & 0xff) * factor));
        int g = clamp((int) Math.round(((rgb >> 8) & 0xff) * factor));
        int b = clamp((int) Math.round((rgb & 0xff) * factor));
        return (r << 16) | (g << 8) | b;
    }

    private static int clamp(int value) {
        return Math.max(0, Math.min(255, value));
    }

    private static void put(byte[] rgb, int pixel, int color) {
        rgb[pixel * 3] = (byte) (color >> 16);
        rgb[pixel * 3 + 1] = (byte) (color >> 8);
        rgb[pixel * 3 + 2] = (byte) color;
    }
}
